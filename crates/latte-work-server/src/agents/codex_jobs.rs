//! Detached auxiliary process owners; observers may cancel but cannot abort cleanup.

use anyhow::{Context, Result, bail};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot, watch};

const EXECUTION_CAPACITY: usize = 2;
const TITLE_CAPACITY: usize = 8;
const RETRY_DELAY: Duration = Duration::from_millis(100);

type Work<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobScope(String);
impl JobScope {
    pub(crate) fn session(id: &str) -> Self {
        Self(id.to_owned())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JobKind {
    Title,
    Prediction,
}
#[derive(Clone, Debug)]
pub(crate) struct Inventory {
    pub(crate) scope: JobScope,
    pub(crate) kind: JobKind,
    pub(crate) cleanup_error: bool,
}
struct Record {
    inventory: Inventory,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct State {
    draining: bool,
    records: BTreeMap<uuid::Uuid, Record>,
}

pub(crate) struct Registry {
    execution: Arc<Semaphore>,
    titles: Arc<Semaphore>,
    state: Mutex<State>,
    changed: Notify,
    wait_timeout: Duration,
    execution_timeout: Duration,
}
pub(crate) fn registry() -> &'static Arc<Registry> {
    static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry::new(Duration::from_secs(150), Duration::from_secs(30)))
}
impl Registry {
    fn new(wait_timeout: Duration, execution_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            execution: Arc::new(Semaphore::new(EXECUTION_CAPACITY)),
            titles: Arc::new(Semaphore::new(TITLE_CAPACITY)),
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            wait_timeout,
            execution_timeout,
        })
    }
    fn mark_cleanup_error(&self, id: uuid::Uuid) {
        if let Some(record) = self
            .state
            .lock()
            .expect("auxiliary registry poisoned")
            .records
            .get_mut(&id)
        {
            record.inventory.cleanup_error = true;
        }
    }
    pub(crate) fn inventory(&self) -> Vec<Inventory> {
        self.state
            .lock()
            .expect("auxiliary registry poisoned")
            .records
            .values()
            .map(|record| record.inventory.clone())
            .collect()
    }
    pub(crate) fn scope_confirmed(&self, scope: &JobScope) -> bool {
        !self.inventory().iter().any(|record| &record.scope == scope)
    }
    fn cancel(&self, scope: Option<&JobScope>, kind: Option<JobKind>) {
        let state = self.state.lock().expect("auxiliary registry poisoned");
        for record in state.records.values().filter(|record| {
            scope.is_none_or(|scope| &record.inventory.scope == scope)
                && kind.is_none_or(|kind| record.inventory.kind == kind)
        }) {
            record.cancel.send_replace(true);
        }
    }
    pub(crate) fn cancel_scope(&self, scope: &JobScope) {
        self.cancel(Some(scope), None);
    }
    pub(crate) fn cancel_predictions(&self, id: &str) {
        self.cancel(Some(&JobScope::session(id)), Some(JobKind::Prediction));
    }
    pub(crate) fn cancel_titles(&self, id: &str) {
        self.cancel(Some(&JobScope::session(id)), Some(JobKind::Title));
    }
    pub(crate) fn begin_drain(&self) {
        let mut state = self.state.lock().expect("auxiliary registry poisoned");
        state.draining = true;
        for record in state.records.values() {
            record.cancel.send_replace(true);
        }
    }
    pub(crate) async fn wait_scope(&self, scope: &JobScope, budget: Duration) -> bool {
        self.wait_until(budget, || self.scope_confirmed(scope))
            .await
    }
    #[cfg(test)]
    pub(crate) async fn wait_predictions(&self, id: &str, budget: Duration) -> bool {
        let scope = JobScope::session(id);
        self.wait_until(budget, || {
            !self
                .inventory()
                .iter()
                .any(|record| record.scope == scope && record.kind == JobKind::Prediction)
        })
        .await
    }
    pub(crate) async fn wait_drained(&self, budget: Duration) -> bool {
        self.wait_until(budget, || self.inventory().is_empty())
            .await
    }
    async fn wait_until(&self, budget: Duration, confirmed: impl Fn() -> bool) -> bool {
        tokio::time::timeout(budget, async {
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if confirmed() {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }
    pub(crate) fn start<T: Send + 'static>(
        self: &Arc<Self>,
        scope: JobScope,
        kind: JobKind,
        work: impl for<'a> FnOnce(&'a mut ChildOwner) -> Work<'a, T> + Send + 'static,
    ) -> Result<JobHandle<T>> {
        // Register synchronously before returning the observer; close cannot miss a
        // helper whose observer task has not yet been polled.
        let mut state = self.state.lock().expect("auxiliary registry poisoned");
        if state.draining {
            bail!("辅助任务正在关闭");
        }
        let capacity = if kind == JobKind::Title {
            Some(
                self.titles
                    .clone()
                    .try_acquire_owned()
                    .context("自动命名队列已满")?,
            )
        } else {
            None
        };
        let execution = if kind == JobKind::Prediction {
            Some(
                self.execution
                    .clone()
                    .try_acquire_owned()
                    .context("辅助生成繁忙")?,
            )
        } else {
            None
        };
        let id = uuid::Uuid::new_v4();
        let (cancel, cancellation) = watch::channel(false);
        #[cfg(test)]
        let (confirmed, cleanup) = watch::channel(false);
        let (complete, result) = oneshot::channel();
        state.records.insert(
            id,
            Record {
                inventory: Inventory {
                    scope,
                    kind,
                    cleanup_error: false,
                },
                cancel: cancel.clone(),
            },
        );
        drop(state);
        let registry = self.clone();
        // The JoinHandle is deliberately not retained or exposed.
        drop(tokio::spawn(async move {
            registry
                .run(id, cancellation, complete, capacity, execution, work)
                .await;
            #[cfg(test)]
            confirmed.send_replace(true);
        }));
        Ok(JobHandle {
            cancel,
            #[cfg(test)]
            cleanup,
            result,
        })
    }
    #[allow(clippy::too_many_arguments)]
    async fn run<T: Send + 'static>(
        self: Arc<Self>,
        id: uuid::Uuid,
        mut cancel: watch::Receiver<bool>,
        complete: oneshot::Sender<Result<T>>,
        capacity: Option<OwnedSemaphorePermit>,
        mut execution: Option<OwnedSemaphorePermit>,
        work: impl for<'a> FnOnce(&'a mut ChildOwner) -> Work<'a, T> + Send + 'static,
    ) {
        let admission = if execution.is_none() {
            tokio::select! {
                biased;
                () = cancelled(&mut cancel) => Err(anyhow::anyhow!("辅助任务已取消")),
                permit = tokio::time::timeout(self.wait_timeout, self.execution.clone().acquire_owned()) => {
                    match permit { Ok(Ok(permit)) => { execution = Some(permit); Ok(()) }, Ok(Err(error)) => Err(error.into()), Err(_) => Err(anyhow::anyhow!("自动命名等待超时")) }
                }
            }
        } else {
            Ok(())
        };
        let mut owner = ChildOwner::default();
        let result = match admission {
            Err(error) => Err(error),
            Ok(()) => tokio::select! {
                biased;
                () = cancelled(&mut cancel) => Err(anyhow::anyhow!("辅助任务已取消")),
                result = tokio::time::timeout(self.execution_timeout, work(&mut owner)) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("辅助生成执行超时"))),
            },
        };
        // No inference timer or caller cancellation can destroy this epilogue.
        let cleanup_error = owner.cleanup(&self, id).await;
        let result = match (cleanup_error, result) {
            (Some(cleanup), Err(inference)) => Err(anyhow::anyhow!(
                "{inference:#}; 辅助进程清理曾失败: {cleanup:#}"
            )),
            (Some(error), Ok(_)) => Err(error.context("辅助进程清理曾失败")),
            (None, result) => result,
        };
        {
            // Admission uses this same lock: inventory retirement and permit
            // return must be atomic, or a replacement can momentarily exceed
            // the bounded live-owner inventory.
            let mut state = self.state.lock().expect("auxiliary registry poisoned");
            state.records.remove(&id);
            drop((execution, capacity));
        }
        self.changed.notify_waiters();
        if complete.send(result).is_err() { /* Observer cancellation is expected. */ }
    }
}
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    while !*cancel.borrow_and_update() {
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

pub(crate) struct JobHandle<T> {
    cancel: watch::Sender<bool>,
    #[cfg(test)]
    cleanup: watch::Receiver<bool>,
    result: oneshot::Receiver<Result<T>>,
}
impl<T> JobHandle<T> {
    pub(crate) fn request_cancel(&self) {
        self.cancel.send_replace(true);
    }
    #[cfg(test)]
    async fn wait_cleanup(&mut self, budget: Duration) -> bool {
        tokio::time::timeout(budget, async {
            while !*self.cleanup.borrow_and_update() {
                if self.cleanup.changed().await.is_err() {
                    return false;
                }
            }
            true
        })
        .await
        .unwrap_or(false)
    }
    pub(crate) async fn wait(mut self) -> Result<T> {
        (&mut self.result).await.context("辅助 owner 未确认完成")?
    }
}
impl<T> Drop for JobHandle<T> {
    fn drop(&mut self) {
        self.request_cancel();
    }
}

#[derive(Default)]
pub(crate) struct ChildOwner {
    child: Option<tokio::process::Child>,
    pid: Option<i32>,
    #[cfg(test)]
    test_gate: Option<Arc<ReapGate>>,
}
impl ChildOwner {
    pub(crate) fn spawn(
        &mut self,
        mut command: tokio::process::Command,
    ) -> Result<&mut tokio::process::Child> {
        if self.child.is_some() {
            bail!("辅助 owner 已持有子进程，拒绝覆盖");
        }
        // Store child before fallible PID/stdin/stdout setup.
        self.child = Some(command.kill_on_drop(true).process_group(0).spawn()?);
        self.pid = self
            .child
            .as_ref()
            .and_then(tokio::process::Child::id)
            .map(|pid| pid as i32);
        #[cfg(test)]
        if let Some(gate) = &self.test_gate {
            gate.started.notify_one();
        }
        self.child.as_mut().context("辅助进程缺失")
    }
    fn signal_group(&self) -> Result<()> {
        #[cfg(test)]
        if let Some(gate) = &self.test_gate {
            gate.kill_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if gate
                .kill_errors
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |n| n.checked_sub(1),
                )
                .is_ok()
            {
                bail!("injected kill failure");
            }
        }
        let pid = self.pid.context("辅助进程无 PID，无法确认进程组清理")?;
        match nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        ) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
            Err(error) => Err(anyhow::Error::from(error).context("辅助进程组终止失败")),
        }
    }
    async fn wait_direct(&mut self) -> Result<()> {
        #[cfg(test)]
        if let Some(gate) = &self.test_gate
            && gate
                .wait_errors
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |n| n.checked_sub(1),
                )
                .is_ok()
        {
            bail!("injected wait failure");
        }
        self.child
            .as_mut()
            .context("辅助直接子进程缺失")?
            .wait()
            .await
            .context("辅助直接子进程 wait 失败")?;
        Ok(())
    }
    async fn cleanup(&mut self, registry: &Registry, id: uuid::Uuid) -> Option<anyhow::Error> {
        self.child.as_ref()?;
        #[cfg(test)]
        if let Some(gate) = &self.test_gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        let (mut signalled, mut reaped) = (false, false);
        let (mut kill_error, mut wait_error) = (None, None);
        loop {
            if !signalled && !reaped {
                match self.signal_group() {
                    Ok(()) => signalled = true,
                    Err(error) => {
                        if kill_error.is_none() {
                            kill_error = Some(error);
                        }
                        registry.mark_cleanup_error(id);
                    }
                }
            }
            if !reaped {
                match self.wait_direct().await {
                    Ok(()) => reaped = true,
                    Err(error) => {
                        if wait_error.is_none() {
                            wait_error = Some(error);
                        }
                        registry.mark_cleanup_error(id);
                    }
                }
            }
            if signalled && reaped {
                break;
            }
            if reaped {
                // A reaped PID/PGID may already belong to someone else. No safe
                // reconciliation exists here: retain Unknown and both permits,
                // never signal that saved numeric identity again.
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(RETRY_DELAY).await;
        }
        #[cfg(test)]
        if let Some(gate) = &self.test_gate {
            gate.confirmed
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        match (kill_error, wait_error) {
            (Some(kill), Some(wait)) => Some(anyhow::anyhow!("{kill:#}; {wait:#}")),
            (Some(error), None) | (None, Some(error)) => Some(error),
            (None, None) => None,
        }
    }
}

#[cfg(test)]
pub(crate) struct ReapGate {
    pub(crate) started: Notify,
    pub(crate) entered: Notify,
    pub(crate) release: Notify,
    pub(crate) confirmed: std::sync::atomic::AtomicBool,
    kill_calls: std::sync::atomic::AtomicUsize,
    kill_errors: std::sync::atomic::AtomicUsize,
    wait_errors: std::sync::atomic::AtomicUsize,
}
#[cfg(test)]
impl ReapGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            started: Notify::new(),
            entered: Notify::new(),
            release: Notify::new(),
            confirmed: std::sync::atomic::AtomicBool::new(false),
            kill_calls: std::sync::atomic::AtomicUsize::new(0),
            kill_errors: std::sync::atomic::AtomicUsize::new(0),
            wait_errors: std::sync::atomic::AtomicUsize::new(0),
        })
    }
}
#[cfg(test)]
fn test_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args(["-c", "exec sleep 60"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

#[cfg(test)]
#[path = "codex_jobs_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) type TestJob = (JobHandle<()>, Arc<ReapGate>, oneshot::Receiver<u32>);

/// Test-only bridge to the real detached owner and production cleanup epilogue.
#[cfg(test)]
pub(crate) fn test_job(session_id: &str, kind: JobKind) -> Result<TestJob> {
    let gate = ReapGate::new();
    let owner_gate = gate.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let handle = registry().start(JobScope::session(session_id), kind, move |owner| {
        Box::pin(async move {
            owner.test_gate = Some(owner_gate);
            let child = owner.spawn(test_command())?;
            if pid_tx
                .send(child.id().context("test child PID missing")?)
                .is_err()
            {
                bail!("test PID observer dropped");
            }
            std::future::pending::<Result<()>>().await
        })
    })?;
    Ok((handle, gate, pid_rx))
}
