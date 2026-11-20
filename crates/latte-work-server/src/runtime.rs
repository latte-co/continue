//! One manager per host, many independently supervised agent processes.
use crate::{
    admission::Guard,
    agents::{self, Action, Input},
    providers::LaunchConfig,
    store::Store,
};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{EventKind, Response, Session, Status};
use nix::{
    errno::Errno,
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Child,
    sync::{mpsc, oneshot},
};
use tokio_util::codec::{FramedRead, LinesCodec};

mod transport;
use transport::Transport;

pub type Database = Arc<Mutex<Store>>;
pub type Runs = Arc<Mutex<HashMap<String, Run>>>;
const TURN_LIMIT: Duration = Duration::from_secs(24 * 3600);
const CLOSE_PENDING: &str = "原生会话的关闭状态待确认，请核对主机上的 Agent 和后台任务。";
const RECONFIGURE_BLOCKED: &str = "当前会话仍有后台任务或待确认状态，无法更换模型、Provider、权限或思考强度；请沿用当前配置发送，消息未发送";

#[derive(Debug)]
pub struct AdmissionUnknown;
impl std::fmt::Display for AdmissionUnknown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("会话接收结果待确认，请使用原请求 ID 核对；消息不会自动重发")
    }
}
impl std::error::Error for AdmissionUnknown {}

pub(crate) use crate::admission::SendNotAdmitted;

/// Only deterministic terminal rejection may combine attempt ownership and SQL absence.
pub(crate) fn reject_send(admission: &Guard, request_id: &str, message: String) -> anyhow::Error {
    admission.reject(request_id, message)
}
fn reject_turn<'a>(
    admission: impl Into<Option<&'a Guard>>,
    request_id: &str,
    message: String,
) -> anyhow::Error {
    match admission.into() {
        Some(admission) => reject_send(admission, request_id, message),
        // Queue dispatch paths already have durable identities and no Send attempt.
        None => anyhow::Error::msg(message),
    }
}

#[derive(Default)]
struct ForwardedInputs(HashMap<String, tokio::time::Instant>);
impl ForwardedInputs {
    fn insert(&mut self, id: String) {
        self.0.insert(id, tokio::time::Instant::now() + TURN_LIMIT);
    }
    fn remove(&mut self, id: &str) {
        self.0.remove(id);
    }
    fn clear(&mut self) {
        self.0.clear();
    }
    fn len(&self) -> usize {
        self.0.len()
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn deadline(&self) -> Option<tokio::time::Instant> {
        self.0.values().copied().min()
    }
}
#[derive(Default)]
pub struct TitleRefreshCache {
    reads: HashMap<String, (String, Instant)>,
}
impl TitleRefreshCache {
    const INTERVAL: Duration = Duration::from_secs(2);
    const LIMIT: usize = 2048;
    fn select(&mut self, mut sessions: Vec<Session>, now: Instant) -> Vec<Session> {
        // Refresh the least recently read identities first so a slow-polling list
        // with more than one batch cannot starve the rows after the first 16.
        sessions.sort_by_key(|session| {
            self.reads
                .get(&session.id)
                .filter(|(native, _)| Some(native) == session.native_id.as_ref())
                .map(|(_, at)| *at)
        });
        sessions
            .into_iter()
            .filter(|session| self.claim(session, now))
            .take(16)
            .collect()
    }
    fn claim(&mut self, session: &Session, now: Instant) -> bool {
        let Some(native_id) = &session.native_id else {
            return false;
        };
        if self.reads.get(&session.id).is_some_and(|(native, read)| {
            native == native_id && now.duration_since(*read) < Self::INTERVAL
        }) {
            return false;
        }
        if self.reads.len() >= Self::LIMIT {
            self.reads
                .retain(|_, (_, read)| now.duration_since(*read) < Self::INTERVAL);
            if self.reads.len() >= Self::LIMIT {
                return false;
            }
        }
        // Reserve before spawning I/O so concurrent clients share the debounce.
        self.reads
            .insert(session.id.clone(), (native_id.clone(), now));
        true
    }
}
#[derive(Clone)]
pub struct Run {
    pub control: mpsc::Sender<Control>,
    pub safe_to_close: Arc<AtomicBool>,
    pub session_open: Arc<AtomicBool>,
}
pub struct SendTurn {
    pub request_id: String,
    pub text: String,
    pub model: Option<String>,
    pub fingerprint: Option<String>,
    pub config: LaunchConfig,
}
pub(crate) struct Submission {
    pub turn: SendTurn,
    pub allow_queue: bool,
    pub admission: Guard,
}
pub enum QueueAction {
    Take {
        request_id: String,
        revision: u32,
    },
    Dispatch {
        interrupt: bool,
        request_id: String,
        revision: u32,
        config: Box<LaunchConfig>,
    },
    Reorder {
        expected: Vec<String>,
        order: Vec<String>,
    },
    Edit {
        request_id: String,
        revision: u32,
        text: Option<String>,
    },
    Clear,
    Resume {
        configs: HashMap<String, LaunchConfig>,
    },
}
pub enum Control {
    TitleContext {
        reply: oneshot::Sender<Option<LaunchConfig>>,
    },
    Queue {
        action: QueueAction,
        reply: oneshot::Sender<Result<Response, String>>,
    },
    SubagentHistory {
        task_id: String,
        permit: tokio::sync::OwnedSemaphorePermit,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    SubagentTranscript {
        task_id: String,
        permit: tokio::sync::OwnedSemaphorePermit,
        reply: oneshot::Sender<Result<Option<agents::ChildTranscript>, String>>,
    },
    RenameTitle {
        title: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Open {
        config: LaunchConfig,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Interrupt {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Send {
        turn: SendTurn,
        allow_queue: bool,
        admission: Guard,
        reply: oneshot::Sender<Result<Response>>,
    },
    Cancel {
        reply: Option<oneshot::Sender<Result<(), String>>>,
        only_if_idle: bool,
    },
    AnswerQuestion {
        id: String,
        answers: Option<Vec<latte_work_protocol::QuestionAnswer>>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Approval {
        id: String,
        allow: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
}
pub fn db<T>(database: &Database, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    {
        let mut guard = database.lock().map_err(|_| anyhow::anyhow!("存储锁异常"))?;
        f(&mut guard)
    }
}

/// Page the current managed actors without consulting limited navigation history.
pub fn project_agent_sessions(
    database: &Database,
    runs: &Runs,
    project_id: &str,
    after: Option<&str>,
) -> Result<Response> {
    db(database, |store| store.project(project_id))?;
    // Enumerate live actors, not the limited navigation history (which also
    // excludes side chats). Never hold the runs lock while reading the database.
    let mut ids: Vec<_> = runs
        .lock()
        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
        .iter()
        .filter(|(id, run)| {
            !run.control.is_closed() && after.is_none_or(|cursor| id.as_str() > cursor)
        })
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    db(database, |store| {
        let mut sessions = Vec::new();
        let mut bytes = 0;
        let mut next = None;
        for id in ids {
            let session = store.session(&id)?;
            if session.project_id != project_id {
                continue;
            }
            let size = serde_json::to_vec(&session)?.len();
            if size > 256 * 1024 {
                bail!("会话元数据超出读取上限");
            }
            if sessions.len() >= 64 || bytes + size > 256 * 1024 {
                next = sessions.last().map(|session: &Session| session.id.clone());
                break;
            }
            bytes += size;
            sessions.push(session);
        }
        Ok(Response::ProjectAgentSessions { sessions, next })
    })
}

/// Attach live process evidence to all session projections, never to the database.
pub fn project_session_state(runs: &Runs, response: &mut Response) -> Result<()> {
    let map = runs.lock().map_err(|_| anyhow::anyhow!("执行状态锁异常"))?;
    let project = |session: &mut Session| {
        let run = map.get(&session.id).filter(|run| !run.control.is_closed());
        session.agent_session_open =
            Some(run.is_some_and(|run| run.session_open.load(Ordering::SeqCst)));
        session.agent_session_busy = Some(
            run.is_some_and(|run| !run.safe_to_close.load(Ordering::SeqCst))
                || session.status.active(),
        );
    };
    match response {
        Response::Session { session }
        | Response::Events { session, .. }
        | Response::History { session, .. } => project(session),
        Response::Sessions { sessions }
        | Response::SideChatHistory { sessions, .. }
        | Response::ProjectAgentSessions { sessions, .. } => sessions.iter_mut().for_each(project),
        Response::RecentSessions { sessions, .. } => sessions
            .iter_mut()
            .for_each(|entry| project(&mut entry.session)),
        _ => {}
    }
    Ok(())
}

/// Legacy test callers reserve before any asynchronous submission work. The
/// connection path reserves earlier, immediately after decoding its Send.
#[cfg(test)]
pub async fn submit(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    turn: SendTurn,
    allow_queue: bool,
) -> Result<Response> {
    let admission = Guard::reserve(&database, &turn.request_id)?;
    submit_reserved(
        database,
        runs,
        binary,
        session,
        path,
        Submission {
            turn,
            allow_queue,
            admission,
        },
    )
    .await
}

/// The channel/actor owns the guard after transfer, even if the sender times out.
pub(crate) async fn submit_reserved(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    submission: Submission,
) -> Result<Response> {
    let Submission {
        turn,
        allow_queue,
        admission,
    } = submission;
    if !admission.matches(&database, &turn.request_id) {
        bail!("消息准入所有权不匹配，请使用原请求 ID 核对");
    }
    let control = control_for(database.clone(), runs, binary, session, path)?;
    let (reply, receive) = oneshot::channel();
    if let Err(error) = control.try_send(Control::Send {
        turn,
        allow_queue,
        admission,
        reply,
    }) {
        let Control::Send {
            turn, admission, ..
        } = error.into_inner()
        else {
            bail!("消息准入所有权缺失，请使用原请求 ID 核对");
        };
        return Err(reject_send(
            &admission,
            &turn.request_id,
            "会话正在停止或请求队列已满，请重试；消息不会自动重发".into(),
        ));
    }
    tokio::time::timeout(Duration::from_secs(10), receive)
        .await
        .map_err(|_| AdmissionUnknown)?
        .map_err(|_| AdmissionUnknown)?
}
pub async fn queue_action(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    action: QueueAction,
) -> Result<Response> {
    let control = control_for(database, runs, binary, session, path)?;
    let (reply, receive) = oneshot::channel();
    control
        .try_send(Control::Queue { action, reply })
        .context("会话请求过多，请核对队列后重试")?;
    tokio::time::timeout(Duration::from_secs(10), receive)
        .await
        .context("队列操作结果待确认，请刷新后核对")??
        .map_err(anyhow::Error::msg)
}
pub async fn rename_title(
    database: &Database,
    runs: &Runs,
    session: Session,
    path: String,
    title: String,
    config: LaunchConfig,
    open_code_binary: Option<String>,
) -> Result<Session> {
    Store::validate_session_title(&title)?;
    let control = runs
        .lock()
        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
        .get(&session.id)
        .map(|run| run.control.clone());
    if let Some(control) = control {
        let (reply, receive) = oneshot::channel();
        control
            .try_send(Control::RenameTitle { title, reply })
            .context("会话正在关闭或请求队列已满，标题未修改")?;
        tokio::time::timeout(Duration::from_secs(10), receive)
            .await
            .context("原生标题修改结果待确认，请核对后重试")??
            .map_err(anyhow::Error::msg)?;
        return db(database, |s| s.session(&session.id));
    }
    if let Some(id) = session.native_id.clone() {
        let fingerprint = config.fingerprint()?;
        if !db(database, |s| {
            s.native_rename_context_matches(&session.id, &id, fingerprint.as_deref())
        })? {
            bail!("无法确认原生会话的启动配置，标题未修改；请恢复原 Provider 和 ENV 配置后重试");
        }
        if let Some(binary) = open_code_binary {
            let current = db(database, |s| s.session(&session.id))?;
            if current.status.active()
                || runs
                    .lock()
                    .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
                    .contains_key(&session.id)
            {
                bail!("OpenCode 会话正在打开，请稍后修改标题");
            }
            let mut process = Process::launch(
                database,
                &binary,
                &current,
                &path,
                config,
                Arc::new(AtomicBool::new(false)),
                None,
            )
            .await?;
            let result = tokio::time::timeout(Duration::from_secs(8), async {
                let initial = process.adapter.advance(Input::Open)?;
                process.apply(initial, database, &session.id).await?;
                let (reply, receive) = oneshot::channel();
                let mut reply = Some(reply);
                loop {
                    let (line, sideband) = process
                        .next_message()
                        .await?
                        .context("Agent原生标题transport已退出")?;
                    let actions = process.adapter.advance(if sideband {
                        Input::Sideband(&line)
                    } else {
                        Input::Message(&line)
                    })?;
                    process.apply(actions, database, &session.id).await?;
                    if process.state.ready
                        && process.adapter.metadata_ready()
                        && let Some(reply) = reply.take()
                    {
                        let id = uuid::Uuid::new_v4().to_string();
                        let actions = process.adapter.advance(Input::RenameTitle {
                            id: &id,
                            title: &title,
                        })?;
                        process.rename_reply = Some(reply);
                        process.apply(actions, database, &session.id).await?;
                    }
                    if reply.is_none() && process.rename_reply.is_none() {
                        return receive.await?.map_err(anyhow::Error::msg);
                    }
                }
            })
            .await
            .context("OpenCode 原生标题修改结果待确认");
            process.close_confirmed(database, &session.id).await?;
            result??;
            return db(database, |s| s.session(&session.id));
        }
        let agent = session.agent.clone();
        let actual = tokio::task::spawn_blocking(move || {
            agents::rename_saved_session(
                &agent,
                std::path::Path::new(&path),
                &id,
                &title,
                &config.environment,
            )
        })
        .await??;
        return db(database, |s| {
            s.sync_native_title(&session.id, &actual, true)
        });
    }
    // No native session exists yet. Persist the requested initial title, and pass it
    // at native creation; never create a fake transcript or send a naming prompt.
    db(database, |s| s.rename_session(&session.id, &title))
}

struct TitleSource {
    session: Session,
    path: String,
    config: Option<LaunchConfig>,
    control: Option<mpsc::Sender<Control>>,
    fingerprint: Option<String>,
    allow_legacy_cli: bool,
}
async fn title_source(
    database: &Database,
    session: Session,
    path: String,
    control: Option<mpsc::Sender<Control>>,
) -> Result<Option<TitleSource>> {
    let config = if let Some(control) = &control {
        let (reply, receive) = oneshot::channel();
        if control.try_send(Control::TitleContext { reply }).is_err() {
            return Ok(None);
        }
        let Ok(Ok(Some(config))) = tokio::time::timeout(Duration::from_secs(3), receive).await
        else {
            return Ok(None);
        };
        Some(config)
    } else {
        None
    };
    let fingerprint = match &config {
        Some(config) => config.fingerprint()?,
        None => crate::providers::turn_fingerprint(Some(&latte_work_protocol::TurnProvider::Cli))?,
    };
    let allow_legacy_cli = config
        .as_ref()
        .is_none_or(|c| c.provider.is_none() && c.environment.is_empty());
    if !db(database, |s| {
        s.native_title_context_matches(&session.id, fingerprint.as_deref(), allow_legacy_cli)
    })? {
        return Ok(None);
    }
    Ok(Some(TitleSource {
        session,
        path,
        config,
        control,
        fingerprint,
        allow_legacy_cli,
    }))
}

pub async fn refresh_titles(
    database: &Database,
    runs: &Runs,
    cache: &Mutex<TitleRefreshCache>,
    response: &mut Response,
) -> Result<()> {
    let sessions: Vec<Session> = match response {
        Response::Session { session }
        | Response::Events { session, .. }
        | Response::History { session, .. } => vec![session.clone()],
        Response::Sessions { sessions } | Response::SideChatHistory { sessions, .. } => {
            sessions.clone()
        }
        Response::RecentSessions { sessions, .. } => {
            sessions.iter().map(|entry| entry.session.clone()).collect()
        }
        _ => return Ok(()),
    };
    let controls: HashMap<_, _> = runs
        .lock()
        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
        .iter()
        .map(|(id, run)| (id.clone(), run.control.clone()))
        .collect();
    let due: Vec<_> = {
        let mut cache = cache
            .lock()
            .map_err(|_| anyhow::anyhow!("标题刷新锁异常"))?;
        let now = Instant::now();
        cache.select(
            sessions
                .into_iter()
                .filter(|session| !controls.contains_key(&session.id) || !session.custom_title)
                .collect(),
            now,
        )
    };
    if due.is_empty() {
        return Ok(());
    }
    let candidates = db(database, |s| {
        due.into_iter()
            .map(|session| {
                s.project(&session.project_id)
                    .map(|project| (session, project.path))
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let sources = futures_util::future::join_all(candidates.into_iter().map(|(session, path)| {
        let control = controls.get(&session.id).cloned();
        title_source(database, session, path, control)
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    let titles = tokio::task::spawn_blocking(move || {
        sources
            .into_iter()
            .flatten()
            .filter_map(|source| {
                let mut title = agents::session_title(
                    &source.session.agent,
                    std::path::Path::new(&source.path),
                    source.session.native_id.as_deref()?,
                    &source
                        .config
                        .as_ref()
                        .map(|c| c.environment.clone())
                        .unwrap_or_default(),
                )
                .ok()
                .flatten()?;
                if let Some(config) = &source.config {
                    title.text = config.redact(&title.text);
                }
                Some((source, title))
            })
            .collect::<Vec<_>>()
    })
    .await?;
    let current = runs.lock().map_err(|_| anyhow::anyhow!("执行状态锁异常"))?;
    let fresh = db(database, |s| {
        let mut fresh = HashMap::new();
        for (source, title) in titles {
            let observed = source.session;
            let mut session = s.session(&observed.id)?;
            let same_owner = match (&source.control, current.get(&observed.id)) {
                (None, None) => true,
                (Some(control), Some(run)) => control.same_channel(&run.control),
                _ => false,
            };
            // Live native names are authoritative; an on-disk flush can lag a
            // rename acknowledgement. Only unnamed live sessions may adopt file
            // metadata (AI titles are not emitted as native name events).
            if same_owner
                && s.native_title_context_matches(
                    &session.id,
                    source.fingerprint.as_deref(),
                    source.allow_legacy_cli,
                )?
                && (!current.contains_key(&session.id) || !observed.custom_title)
                && session.native_id == observed.native_id
                && session.title == observed.title
                && session.custom_title == observed.custom_title
            {
                session = s.sync_native_title(&session.id, &title.text, title.custom)?;
            }
            fresh.insert(session.id.clone(), session);
        }
        Ok(fresh)
    })?;
    let update = |session: &mut Session| {
        if let Some(fresh) = fresh.get(&session.id) {
            session.title.clone_from(&fresh.title);
            session.custom_title = fresh.custom_title;
        }
    };
    match response {
        Response::Session { session }
        | Response::Events { session, .. }
        | Response::History { session, .. } => update(session),
        Response::Sessions { sessions } | Response::SideChatHistory { sessions, .. } => {
            for session in sessions {
                update(session);
            }
        }
        Response::RecentSessions { sessions, .. } => {
            for entry in sessions {
                update(&mut entry.session);
            }
        }
        _ => {}
    }
    Ok(())
}

fn control_for(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
) -> Result<mpsc::Sender<Control>> {
    if db(&database, |s| {
        if let Some(reason) = s.unconfirmed_agent_close(&session.id)? {
            bail!(reason);
        }
        if let Some((parent, _)) = s.side_parent(&session.id)?
            && s.session(&parent)?.archived
        {
            bail!("请先取消主会话归档，再继续侧边聊天");
        }
        Ok(s.session(&session.id)?.archived)
    })? {
        bail!("请先取消归档再打开 Agent 会话或发送消息");
    }
    let mut map = runs.lock().map_err(|_| anyhow::anyhow!("执行状态锁异常"))?;
    if let Some(run) = map.get(&session.id) {
        Ok(run.control.clone())
    } else {
        if map.len() >= 64 {
            bail!("保留中的 Agent 会话已达 64 个，请关闭不再使用的会话或退出 App 后重试");
        }
        let (tx, rx) = mpsc::channel(16);
        let safe_to_close = Arc::new(AtomicBool::new(false));
        let session_open = Arc::new(AtomicBool::new(false));
        map.insert(
            session.id.clone(),
            Run {
                control: tx.clone(),
                safe_to_close: safe_to_close.clone(),
                session_open: session_open.clone(),
            },
        );
        tokio::spawn(actor(
            database,
            runs.clone(),
            binary,
            session,
            path,
            rx,
            safe_to_close,
            session_open,
        ));
        Ok(tx)
    }
}
pub async fn open(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    config: LaunchConfig,
) -> Result<()> {
    let control = control_for(database, runs, binary, session, path)?;
    let (reply, receive) = oneshot::channel();
    control
        .try_send(Control::Open { config, reply })
        .context("会话请求队列已满或正在关闭，请重试")?;
    tokio::time::timeout(Duration::from_secs(20), receive)
        .await
        .context("打开 Agent 会话超时，请重试")??
        .map_err(anyhow::Error::msg)
}
/// The caller holds exclusive admission until close and archive both complete.
/// Never hide a session whose native close has failed or is still unconfirmed.
pub async fn archive(
    database: &Database,
    runs: &Runs,
    id: &str,
    archived: bool,
) -> Result<Session> {
    if archived {
        if db(database, |s| Ok(s.session(id)?.status.active()))? {
            bail!("请先停止任务，再归档会话");
        }
        let children = db(database, |s| s.side_chat_ids(id))?;
        for child in &children {
            if db(database, |s| Ok(s.session(child)?.status.active()))? {
                bail!("侧边聊天仍在执行，请等待完成或停止后再归档");
            }
        }
        for child in children {
            close(database, runs, &child, true).await?;
        }
        close(database, runs, id, false).await?;
    }
    db(database, |s| s.archive_session(id, archived))
}

/// Returns whether an actor acknowledged closure.
pub async fn close(database: &Database, runs: &Runs, id: &str, only_if_idle: bool) -> Result<bool> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    db(database, |s| {
        s.session(id)?;
        if let Some(reason) = s.unconfirmed_agent_close(id)? {
            bail!(reason);
        }
        Ok(())
    })?;
    let control = runs
        .lock()
        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
        .get(id)
        .map(|r| r.control.clone());
    let actor_closed = control.is_some();
    if let Some(control) = control {
        let (reply, receive) = oneshot::channel();
        tokio::time::timeout_at(deadline, async {
            control
                .send(Control::Cancel {
                    reply: Some(reply),
                    only_if_idle,
                })
                .await?;
            receive.await?.map_err(anyhow::Error::msg)
        })
        .await
        .context("关闭 Agent 会话超时")??;
    }
    let scope = agents::codex_jobs::JobScope::session(id);
    agents::codex_jobs::registry().cancel_scope(&scope);
    if !agents::codex_jobs::registry()
        .wait_scope(
            &scope,
            deadline.saturating_duration_since(tokio::time::Instant::now()),
        )
        .await
    {
        db(database, |store| {
            store.record_unconfirmed_agent_close(id, CLOSE_PENDING)
        })?;
        bail!(CLOSE_PENDING);
    }
    // A concurrent close may have recorded uncertainty and removed the actor
    // after the first lookup. A missing actor cannot clear that evidence.
    db(database, |s| {
        if let Some(reason) = s.unconfirmed_agent_close(id)? {
            bail!(reason);
        }
        Ok(())
    })?;
    Ok(actor_closed)
}
async fn write(input: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> Result<()> {
    if bytes.len() > latte_work_protocol::MAX_FRAME {
        bail!("Agent 输出请求超出限制");
    }
    tokio::time::timeout(Duration::from_secs(5), input.write_all(bytes)).await??;
    Ok(())
}
type Outcome = (Status, Option<String>);
#[derive(Default)]
struct TurnState {
    ready: bool,
    redactor: Option<crate::redaction::Redactor>,
    text_tails: HashMap<String, String>,
    pending: HashMap<
        String,
        (
            String,
            Value,
            Option<Vec<latte_work_protocol::UserQuestion>>,
        ),
    >,
}
impl TurnState {
    fn flush_text(&mut self, database: &Database, session_id: &str, channel: &str) -> Result<()> {
        // An unfinished prefix is never written in clear, including on an
        // explicit content boundary. It cannot be reconstructed after replay.
        if self.text_tails.remove(channel).is_some() {
            self.store_event(
                database,
                session_id,
                channel,
                EventKind::Text {
                    text: "[redacted]".into(),
                },
            )?;
        }
        Ok(())
    }
    fn store_event(
        &self,
        database: &Database,
        session_id: &str,
        channel: &str,
        event: EventKind,
    ) -> Result<()> {
        db(database, |s| {
            if channel.is_empty() {
                s.event(session_id, event).map(|_| ())
            } else {
                s.subagent_event(session_id, channel, event)
            }
        })
    }
    fn event(
        &mut self,
        database: &Database,
        session_id: &str,
        channel: &str,
        event: EventKind,
    ) -> Result<()> {
        if let EventKind::Text { text } = event {
            let mut pending = self.text_tails.remove(channel).unwrap_or_default();
            let mut text = self
                .redactor
                .as_ref()
                .expect("initialized")
                .fragment(&text, &mut pending);
            if !pending.is_empty() {
                // Keep at most one main stream and the adapter's bounded child
                // stream quota. Extra pending suffixes are masked immediately.
                if self.text_tails.len() < 513 {
                    self.text_tails.insert(channel.into(), pending);
                } else {
                    text.push_str("[redacted]");
                }
            }
            if !text.is_empty() {
                self.store_event(database, session_id, channel, EventKind::Text { text })?;
            }
        } else {
            if !matches!(event, EventKind::Progress { .. } | EventKind::Usage { .. }) {
                self.flush_text(database, session_id, channel)?;
            }
            let redactor = self.redactor.as_ref().expect("initialized");
            if channel.is_empty() {
                self.store_event(database, session_id, channel, redactor.event(event))?;
            } else {
                db(database, |s| {
                    s.redacted_subagent_event(session_id, channel, event, redactor)
                })?;
            }
        }
        Ok(())
    }
    async fn apply(
        &mut self,
        actions: Vec<Action>,
        input: &mut (impl AsyncWrite + Unpin),
        database: &Database,
        session_id: &str,
        config: &LaunchConfig,
    ) -> Result<Option<Outcome>> {
        self.redactor.get_or_insert_with(|| config.redactor());
        for action in actions {
            match action {
                Action::NativeName(title) => {
                    db(database, |s| {
                        s.sync_live_native_title(session_id, &config.redact(&title))
                    })?;
                }
                Action::GeneratedTitle {
                    native_session_id,
                    title,
                } => {
                    db(database, |s| {
                        if s.session(session_id)?.native_id.as_deref() == Some(&native_session_id) {
                            s.sync_native_title(session_id, &config.redact(&title), false)?;
                        }
                        Ok(())
                    })?;
                }
                Action::TitleRequested => {
                    db(database, |s| s.mark_title_requested(session_id))?;
                }
                Action::SpawnTurn(_) => bail!("未处理的Agent进程启动"),
                Action::TitleRenamed(_) => bail!("未处理的原生标题确认"),
                Action::ApprovalReply { .. } => bail!("未处理的原生审批确认"),
                Action::GenerateTitle { .. } => bail!("未处理的标题生成请求"),
                Action::SourceUsed { id, name } => {
                    db(database, |s| s.observe_tool(session_id, &id, &name))?
                }
                Action::Commands(_) => bail!("执行中的 Agent 返回了意外的命令目录"),
                Action::Write(bytes) => write(input, &bytes).await?,
                Action::SidebandWrite(_) => bail!("未处理的 Agent 辅助通道请求"),
                Action::MetadataWrite(bytes) => {
                    if let Err(error) = write(input, &bytes).await {
                        eprintln!(
                            "optional Agent metadata: {}",
                            config.redact(&error.to_string())
                        );
                    }
                }
                Action::Ready => self.ready = true,
                Action::Interrupted => {}
                Action::InputsConsumed(ids) => {
                    db(database, |s| s.consume_forwarded(session_id, &ids))?
                }
                Action::InputRejected {
                    request_id,
                    message,
                } => {
                    db(database, |s| {
                        s.reject_forwarded(session_id, &request_id, &config.redact(&message))
                    })?;
                }
                Action::TurnStarted => db(database, |s| {
                    if !s.session(session_id)?.status.active() {
                        s.state(session_id, Status::Running, None)?;
                    }
                    Ok(())
                })?,
                Action::InheritSideChatTitleCredentials { source, target } => db(database, |s| {
                    s.inherit_side_chat_title_credentials(session_id, &source, &target)
                })?,
                Action::NativeSession(id) => db(database, |s| {
                    let mut current = s.session(session_id)?;
                    s.remember_native_context(
                        session_id,
                        &id,
                        config.fingerprint()?.as_deref(),
                        &config.environment_fingerprint()?,
                    )?;
                    if let Some(provider) = &config.provider {
                        s.remember_title_credential(session_id, &id, &provider.credential)?;
                    }
                    current.native_id = Some(id);
                    s.save(&current)
                })?,
                Action::Event(event) => {
                    if let EventKind::Subagent { update } = &event
                        && update.status.is_some_and(|status| !status.active())
                        && let Some(channel) = &update.tool_use_id
                    {
                        self.flush_text(database, session_id, channel)?;
                    }
                    let terminal_child = match &event {
                        EventKind::Subagent { update }
                            if update.status.is_some_and(|status| !status.active()) =>
                        {
                            Some(update.id.clone())
                        }
                        _ => None,
                    };
                    self.event(database, session_id, "", event)?;
                    // Capture a completed child's full native output before this
                    // process/redaction context can be replaced by a later turn.
                    if let Some(native_id) = terminal_child
                        && db(database, |d| Ok(d.session(session_id)?.agent == "claude"))?
                        && let Ok(permit) = agents::child_read_permit()
                    {
                        let source = db(database, |d| {
                            let session = d.session(session_id)?;
                            let cwd = d.project(&session.project_id)?.path;
                            Ok((
                                d.native_subagent(session_id, &native_id)?,
                                session.native_id,
                                cwd,
                            ))
                        });
                        if let Ok((child, Some(parent), cwd)) = source {
                            let snapshot = agents::child_transcript(
                                std::path::PathBuf::from(&cwd),
                                parent.clone(),
                                child.native_id.clone(),
                                session_id.into(),
                                config.clone(),
                                permit,
                            )
                            .await;
                            match snapshot {
                                Ok(Some(snapshot)) if !snapshot.0.is_empty() => {
                                    db(database, |d| {
                                        d.cache_subagent_transcript(
                                            session_id, &child.id, &snapshot,
                                        )
                                    })?;
                                }
                                Err(error) => eprintln!(
                                    "child transcript capture: {}",
                                    config.redact(&error.to_string())
                                ),
                                _ => {}
                            }
                            // Index whole records while the owning redaction context
                            // is still available. The total capture budget is bounded;
                            // a visible history read resumes its persisted cursor.
                            let deadline = std::time::Instant::now() + Duration::from_secs(3);
                            while std::time::Instant::now() < deadline {
                                let Ok(permit) = agents::child_read_permit() else {
                                    break;
                                };
                                let result = async {
                                    let cursor = db(database, |d| {
                                        d.child_history_cursor(session_id, &child.id)
                                    })?;
                                    let page = agents::child_history(
                                        std::path::PathBuf::from(&cwd),
                                        parent.clone(),
                                        child.native_id.clone(),
                                        session_id.into(),
                                        config.clone(),
                                        cursor,
                                        permit,
                                    )
                                    .await?;
                                    if let Some(page) = page {
                                        db(database, |d| {
                                            d.cache_child_history(session_id, &child.id, &page)
                                        })?;
                                        return Ok(page.has_more);
                                    }
                                    Ok::<_, anyhow::Error>(false)
                                }
                                .await;
                                match result {
                                    Ok(true) => {}
                                    Ok(false) => break,
                                    Err(error) => {
                                        eprintln!(
                                            "child history capture: {}",
                                            config.redact(&error.to_string())
                                        );
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                Action::SubagentEvent { tool_use_id, event } => {
                    self.event(database, session_id, &tool_use_id, event)?;
                }
                Action::Question {
                    id,
                    tool_use_id,
                    input,
                    questions,
                } => {
                    self.flush_text(database, session_id, "")?;
                    if self.pending.len() >= 32 {
                        bail!("待处理交互数量超出限制");
                    }
                    let public_id = uuid::Uuid::new_v4().to_string();
                    self.pending
                        .insert(public_id.clone(), (id, input, Some(questions.clone())));
                    db(database, |s| {
                        s.event(
                            session_id,
                            config.redact_event(EventKind::Question {
                                request_id: public_id,
                                tool_use_id,
                                questions,
                            })?,
                        )?;
                        s.state(session_id, Status::Waiting, None)
                    })?;
                }
                Action::Approval {
                    id,
                    tool_use_id,
                    tool,
                    input: original,
                } => {
                    self.flush_text(database, session_id, "")?;
                    if self.pending.len() >= 32 {
                        bail!("待审批工具数量超出限制");
                    }
                    let public_id = uuid::Uuid::new_v4().to_string();
                    self.pending
                        .insert(public_id.clone(), (id, original.clone(), None));
                    db(database, |s| {
                        s.event(
                            session_id,
                            config.redact_event(EventKind::Approval {
                                request_id: public_id,
                                tool_use_id,
                                tool,
                                input: original,
                            })?,
                        )?;
                        s.state(session_id, Status::Waiting, None)
                    })?;
                }
                Action::Finished { failed, message } => {
                    self.flush_text(database, session_id, "")?;
                    return Ok(Some((
                        if failed {
                            Status::Failed
                        } else {
                            Status::Completed
                        },
                        message,
                    )));
                }
            }
        }
        Ok(None)
    }
}
pub(crate) struct Group {
    pub(crate) child: Child,
    pub(crate) pid: i32,
}
impl Drop for Group {
    fn drop(&mut self) {
        // A reaped child's numeric PGID is no longer a signalling authority.
        if self.child.id().is_some() {
            let _ = killpg(Pid::from_raw(self.pid), Signal::SIGKILL);
            let _ = self.child.start_kill();
        }
    }
}
type Output = FramedRead<tokio::process::ChildStdout, LinesCodec>;
fn native_output<R: tokio::io::AsyncRead>(reader: R) -> FramedRead<R, LinesCodec> {
    // Native CLIs choose their own record size (tool results and resumed history
    // can be large). Public response paging is a separate transport concern.
    FramedRead::new(reader, LinesCodec::new())
}
struct Process {
    /// A failed journal write leaves this handle managed for an explicit retry.
    close_blocked: bool,
    close_started: bool,
    adapter: Box<dyn agents::AgentAdapter>,
    binary: String,
    title_job: Option<tokio::task::JoinHandle<()>>,
    prediction_owner: String,
    prediction_turn: Option<crate::predictions::TurnContext>,
    prediction_job: Option<tokio::task::JoinHandle<()>>,
    rename_reply: Option<oneshot::Sender<Result<String, String>>>,
    approval_replies: HashMap<String, PendingApprovalReply>,
    transport: Option<Transport>,
    /// A native result is evidence, not completion, until PerTurn I/O is reaped.
    pending_result: Option<(bool, Option<String>)>,
    result_deadline: Option<tokio::time::Instant>,
    native_initialized: bool,
    state: TurnState,
    session_open: Arc<AtomicBool>,
    config: LaunchConfig,
    path: String,
    /// The native process's working directory. It follows a resumed session
    /// into its recorded directory while `path` stays at the project root.
    agent_cwd: String,
    turn_active: bool,
    active_request_id: Option<String>,
    /// The main turn can settle while a child still needs input.
    settled_turn: Option<Outcome>,
    /// Background work already alive when this turn started. Its writes may
    /// land inside this turn's diff window even after it completes, so the
    /// undo fence must survive until the turn is frozen.
    background_at_start: bool,
    stopping: bool,
    interrupt_sent: bool,
    interrupt_ack_pending: bool,
    stop_reply: Option<oneshot::Sender<Result<(), String>>>,
    init_deadline: tokio::time::Instant,
    turn_deadline: tokio::time::Instant,
    side_chat: bool,
}
struct PendingApprovalReply {
    reply: Option<oneshot::Sender<Result<(), String>>>,
    deadline: tokio::time::Instant,
    allow: bool,
}
struct AgentSideband {
    listener: agents::Sideband,
    stream: Option<FramedRead<tokio::net::UnixStream, LinesCodec>>,
}

impl AgentSideband {
    async fn read(&mut self) -> Result<String> {
        if self.stream.is_none() {
            let (stream, _) = self.listener.listener.accept().await?;
            self.stream = Some(FramedRead::new(
                stream,
                LinesCodec::new_with_max_length(1024 * 1024),
            ));
        }
        Ok(self
            .stream
            .as_mut()
            .expect("accepted")
            .next()
            .await
            .context("Agent 辅助通道意外退出；会话历史已保留，后台任务状态无法恢复")??)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.session_open.store(false, Ordering::SeqCst);
        crate::predictions::invalidate(&self.prediction_owner);
        agents::codex_jobs::registry().cancel_scope(&agents::codex_jobs::JobScope::session(
            &self.prediction_owner,
        ));
        // These tasks only observe results; resource owners remain registered
        // and hold their permits until direct-child cleanup is confirmed.
        if let Some(job) = self.prediction_job.take() {
            job.abort();
        }
        if let Some(job) = self.title_job.take() {
            job.abort();
        }
    }
}
impl Process {
    async fn next_message(&mut self) -> Result<Option<(String, bool)>> {
        let Some(transport) = &mut self.transport else {
            return std::future::pending().await;
        };
        tokio::select! {
            line = transport.output.next() => {
                match line {
                    Some(line) => Ok(Some((line?, false))),
                    None if self.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn => Ok(None),
                    None => bail!("Agent 进程意外退出；会话历史已保留，后台任务状态无法恢复"),
                }
            }
            line = async {
                match &mut transport.sideband {
                    Some(channel) => channel.read().await,
                    None => std::future::pending().await,
                }
            } => Ok(Some((line?, true)))
        }
    }
    fn initializing(&self) -> bool {
        match self.adapter.transport_lifetime() {
            agents::TransportLifetime::Persistent => !self.state.ready,
            agents::TransportLifetime::PerTurn => {
                self.transport.is_some() && !self.native_initialized
            }
        }
    }
    fn host_prepared(&self) -> bool {
        self.state.ready || self.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn
    }
    fn idle_for_close(&self) -> bool {
        !self.close_blocked
            && !self.turn_active
            && self.pending_result.is_none()
            && !self.interrupt_ack_pending
            && self.state.pending.is_empty()
            && self.adapter.can_reconfigure()
    }
    fn can_start_turn(&self) -> bool {
        !self.close_blocked
            && self.host_prepared()
            && self.pending_result.is_none()
            && (self.adapter.transport_lifetime() != agents::TransportLifetime::PerTurn
                || self.transport.is_none())
            && !self.turn_active
            && !self.stopping
            && !self.interrupt_ack_pending
            && self.state.pending.is_empty()
            && self.adapter.can_start_turn()
    }
    // Resume the native session where it now lives instead of only the
    // project directory, so a conversation that moved into a worktree keeps
    // working after its process was restarted. A failed lookup keeps the
    // project directory; the adapter's mismatch repair recovers from there.
    // The agent cwd only steers the native process: snapshots, undo and task
    // changes stay rooted at the project path so a turn's before and after
    // are always captured in the same directory.
    async fn launch(
        database: &Database,
        binary: &str,
        session: &Session,
        path: &str,
        config: LaunchConfig,
        session_open: Arc<AtomicBool>,
        request_id: Option<&str>,
    ) -> Result<Self> {
        // Gate the launch before any native helper runs: an unconfirmed
        // close must block the export probe exactly as it blocks the agent.
        db(database, |s| {
            if let Some(reason) = s.unconfirmed_agent_close(&session.id)? {
                bail!(reason);
            }
            Ok(())
        })?;
        let agent_cwd = match session.native_id.as_deref() {
            Some(id) => agents::resume_directory(
                &session.agent,
                binary,
                std::path::Path::new(path),
                id,
                &config,
            )
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| path.to_owned()),
            None => path.to_owned(),
        };
        Self::spawn(
            database,
            binary,
            session,
            path,
            &agent_cwd,
            config,
            session_open,
            request_id,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        database: &Database,
        binary: &str,
        session: &Session,
        path: &str,
        agent_cwd: &str,
        config: LaunchConfig,
        session_open: Arc<AtomicBool>,
        request_id: Option<&str>,
    ) -> Result<Self> {
        db(database, |s| {
            if let Some(reason) = s.unconfirmed_agent_close(&session.id)? {
                bail!(reason);
            }
            Ok(())
        })?;
        let mut adapter = agents::create(&session.agent)?;
        adapter.set_session_title(
            session.custom_title.then(|| session.title.clone()),
            session.native_id.is_some(),
            session.title_requested,
        );
        if let Some((parent, native)) = db(database, |s| s.side_parent(&session.id))? {
            let (owner, source) = session
                .native_id
                .as_ref()
                .map_or((&parent, &native), |id| (&session.id, id));
            db(database, |s| {
                s.verify_side_native_environment(owner, source, &config)
            })?;
            adapter.set_side_parent(native)?;
        }
        Self::prepare_adapter(
            database,
            binary,
            session,
            path,
            agent_cwd,
            config,
            session_open,
            request_id,
            adapter,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn prepare_adapter(
        database: &Database,
        binary: &str,
        session: &Session,
        path: &str,
        agent_cwd: &str,
        config: LaunchConfig,
        session_open: Arc<AtomicBool>,
        request_id: Option<&str>,
        mut adapter: Box<dyn agents::AgentAdapter>,
    ) -> Result<Self> {
        let side_chat = db(database, |s| Ok(s.side_parent(&session.id)?.is_some()))?;
        let prepared = adapter.command(binary, agent_cwd, session.native_id.as_deref(), &config)?;
        let transport = if adapter.transport_lifetime() == agents::TransportLifetime::Persistent {
            Some(Self::spawn_transport(
                database,
                &session.id,
                &session.agent,
                prepared,
                adapter.frame_limit(),
                &config,
                request_id,
                agents::TransportLifetime::Persistent,
                None,
            )?)
        } else {
            None
        };
        Ok(Self {
            close_blocked: false,
            close_started: false,
            adapter,
            binary: binary.into(),
            title_job: None,
            prediction_owner: session.id.clone(),
            prediction_turn: None,
            prediction_job: None,
            rename_reply: None,
            approval_replies: HashMap::new(),
            transport,
            pending_result: None,
            result_deadline: None,
            native_initialized: false,
            state: TurnState::default(),
            session_open,
            config,
            path: path.into(),
            agent_cwd: agent_cwd.into(),
            turn_active: false,
            active_request_id: None,
            settled_turn: None,
            background_at_start: false,
            stopping: false,
            interrupt_sent: false,
            interrupt_ack_pending: false,
            stop_reply: None,
            init_deadline: tokio::time::Instant::now() + Duration::from_secs(18),
            turn_deadline: tokio::time::Instant::now() + TURN_LIMIT,
            side_chat,
        })
    }
    #[allow(clippy::too_many_arguments)]
    fn spawn_transport(
        database: &Database,
        id: &str,
        agent: &str,
        prepared: agents::AgentCommand,
        frame_limit: Option<usize>,
        config: &LaunchConfig,
        request_id: Option<&str>,
        lifetime: agents::TransportLifetime,
        main_request_id: Option<&str>,
    ) -> Result<Transport> {
        let write_id = db(database, |s| {
            if let Some(reason) = s.unconfirmed_agent_close(id)? {
                bail!(reason);
            }
            if let Some(request) = request_id {
                s.start_side_write(request)?;
                Ok(Some(request.to_owned()))
            } else if config.permission_mode.is_some() {
                s.start_side_launch_write(id)
            } else {
                Ok(None)
            }
        })?;
        let spawned = Transport::spawn(prepared, frame_limit, config, lifetime);
        if let Err(error) = &spawned
            && let Some(failure) = error.downcast_ref::<transport::SpawnNotStarted>()
        {
            if let Some(request_id) = main_request_id {
                db(database, |s| {
                    s.record_confirmed_not_started(id, request_id, failure.evidence)
                })?;
            }
            if failure.evidence == crate::store::ConfirmedNotStarted::Enoent
                && let Some(write_id) = &write_id
            {
                db(database, |s| s.mark_side_write_not_started(write_id))?;
            }
        }
        spawned
            .with_context(|| format!("无法启动 Agent {agent}，请检查此 Host 的 CLI 安装和登录状态"))
    }
    async fn apply(&mut self, actions: Vec<Action>, database: &Database, id: &str) -> Result<()> {
        let mut batch = Vec::new();
        for action in actions {
            if let Action::SpawnTurn(prepared) = action {
                if self.adapter.transport_lifetime() != agents::TransportLifetime::PerTurn
                    || self.transport.is_some()
                    || !self.turn_active
                    || self.close_blocked
                {
                    bail!("Agent请求了未获准的单轮进程启动");
                }
                let session = db(database, |s| s.session(id))?;
                if !session.status.active() {
                    bail!("Agent请求未通过持久化admission的启动");
                }
                self.transport = Some(Self::spawn_transport(
                    database,
                    id,
                    &session.agent,
                    prepared,
                    self.adapter.frame_limit(),
                    &self.config,
                    self.active_request_id.as_deref(),
                    agents::TransportLifetime::PerTurn,
                    self.active_request_id.as_deref(),
                )?);
                self.result_deadline = None;
                self.native_initialized = false;
                self.init_deadline = tokio::time::Instant::now() + Duration::from_secs(18);
                continue;
            }
            if self.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn {
                if let Action::Finished { failed, message } = action {
                    if !self.turn_active || self.pending_result.is_some() {
                        bail!("Agent返回了重复或无活动轮次的result");
                    }
                    self.pending_result = Some((failed, message));
                    self.result_deadline =
                        Some(tokio::time::Instant::now() + Duration::from_secs(10));
                    continue;
                }
                if matches!(action, Action::Ready) {
                    bail!("单轮Agent不能宣称常驻会话Ready");
                }
            }
            let finished = matches!(action, Action::Finished { .. });
            batch.push(action);
            if finished {
                self.apply_batch(std::mem::take(&mut batch), database, id)
                    .await?;
            }
        }
        if !batch.is_empty() {
            self.apply_batch(batch, database, id).await?;
        }
        self.finish_settled_side_writes(database, id)
    }
    async fn apply_batch(
        &mut self,
        actions: Vec<Action>,
        database: &Database,
        id: &str,
    ) -> Result<()> {
        let mut remaining = Vec::new();
        let mut sideband_writes = Vec::new();
        for action in actions {
            if let Action::SidebandWrite(bytes) = action {
                sideband_writes.push(bytes);
            } else if let Action::GenerateTitle {
                native_session_id,
                description,
                model,
                native_provider,
            } = action
            {
                if self.title_job.is_some()
                    || self.stopping
                    || db(database, |s| s.session(id))?.custom_title
                {
                    continue;
                }
                let database = database.clone();
                let id = id.to_owned();
                let binary = self.binary.clone();
                let path = self.path.clone();
                let mut config = self.config.clone();
                config.model = model;
                let job = agents::codex_title::start_generate(
                    &id,
                    &binary,
                    &path,
                    &config,
                    &description,
                    native_provider.as_ref(),
                );
                self.title_job = Some(tokio::spawn(async move {
                    let result = match job {
                        Ok(job) => job.wait().await,
                        Err(error) => Err(error),
                    };
                    let _ = db(&database, |s| {
                        let session = s.session(&id)?;
                        if session.custom_title
                            || session.native_id.as_deref() != Some(&native_session_id)
                        {
                            return Ok(());
                        }
                        match result {
                            Ok(title) => {
                                s.sync_native_title(&id, &config.redact(&title), false)?;
                            }
                            Err(error) => {
                                s.event(
                                    &id,
                                    EventKind::Notice {
                                        text: format!(
                                            "会话自动命名未完成，保留原名称：{}",
                                            config.redact(&error.to_string())
                                        ),
                                    },
                                )?;
                            }
                        }
                        Ok(())
                    });
                }));
            } else if let Action::TitleRenamed(result) = action {
                if result.is_ok() {
                    self.cancel_title().await;
                }
                let result = result.and_then(|title| {
                    db(database, |s| {
                        s.sync_native_title(id, &self.config.redact(&title), true)
                    })
                    .map(|session| session.title)
                    .map_err(|e| e.to_string())
                });
                if let Some(reply) = self.rename_reply.take() {
                    let _ = reply.send(result);
                }
            } else if let Action::ApprovalReply { id: native, result } = action {
                let pending_reply = self.approval_replies.remove(&native);
                match result {
                    Ok(allow) => {
                        if let Some(request_id) = self.state.pending.iter().find_map(
                            |(request_id, (pending, _, questions))| {
                                (pending == &native && questions.is_none())
                                    .then(|| request_id.clone())
                            },
                        ) {
                            self.record_approval(database, id, request_id, allow)?;
                        }
                        if let Some(pending) = pending_reply
                            && let Some(reply) = pending.reply
                        {
                            let result = if pending.allow == allow {
                                Ok(())
                            } else {
                                Err("OpenCode 已按其他决定处理此审批".into())
                            };
                            let _ = reply.send(result);
                        }
                    }
                    Err(error) => {
                        if let Some(reply) = pending_reply.and_then(|p| p.reply) {
                            let _ = reply.send(Err(error));
                        }
                    }
                }
            } else {
                if matches!(&action, Action::NativeName(_)) {
                    self.cancel_title().await;
                }
                remaining.push(action);
            }
        }
        let actions = remaining;
        if actions.iter().any(|a| matches!(a, Action::Interrupted)) {
            self.interrupt_ack_pending = false;
        }
        let became_ready = actions.iter().any(|a| matches!(a, Action::Ready));
        if actions
            .iter()
            .any(|a| matches!(a, Action::NativeSession(_)))
        {
            self.native_initialized = true;
        }
        if actions.iter().any(|a| matches!(a, Action::TurnStarted)) {
            if !self.turn_active {
                self.cancel_prediction().await;
            }
            self.turn_active = true;
            self.settled_turn = None;
            self.background_at_start = self.adapter.has_background_work();
            self.turn_deadline = tokio::time::Instant::now() + TURN_LIMIT;
        }
        if actions.iter().any(|a| matches!(a, Action::Interrupted))
            || (self.stopping && actions.iter().any(|a| matches!(a, Action::Finished { .. })))
        {
            // A CLI may emit the interrupted result before its control acknowledgement.
            self.clear_approval_replies();
            self.state.pending.clear();
        }
        if let Some(context) = &mut self.prediction_turn {
            for action in &actions {
                match action {
                    Action::Event(event) => context.observe(event),
                    Action::Approval { .. } | Action::Question { .. } => context.boundary(),
                    _ => {}
                }
            }
        }
        let outcome = self.apply_state(actions, database, id).await?;
        // Persist the native session identity before any command can run
        // through the supplementary channel.
        for bytes in sideband_writes {
            let stream = self
                .transport
                .as_mut()
                .and_then(|transport| transport.sideband.as_mut())
                .and_then(|channel| channel.stream.as_mut())
                .context("Agent 辅助通道尚未连接")?;
            write(stream.get_mut(), &bytes).await?;
        }
        if let Some((status, message)) = outcome {
            if self
                .state
                .pending
                .values()
                .any(|(native, _, _)| !self.adapter.is_child_interaction(native))
            {
                bail!("Agent 在审批完成前结束了本轮任务");
            }
            self.turn_active = false;
            self.active_request_id = None;
            let (status, message) = if self.stopping {
                (
                    Status::Stopped,
                    Some("已停止；已执行的文件改动不会撤销。".into()),
                )
            } else {
                (status, message.map(|s| self.config.redact(&s)))
            };
            finish_turn(
                database,
                id,
                &self.path,
                status != Status::Completed,
                self.background_at_start || self.adapter.has_background_work(),
            )
            .await?;
            if let Some(context) = self.prediction_turn.take()
                && status == Status::Completed
                && context.useful()
            {
                let session = db(database, |s| s.session(id))?;
                if !session.archived && db(database, |s| Ok(s.side_parent(id)?.is_none()))? {
                    if let Some(snapshot) = self.adapter.prediction_snapshot(&self.config) {
                        self.prediction_job = crate::predictions::schedule(
                            id,
                            &session.agent,
                            self.binary.clone(),
                            self.path.clone(),
                            context,
                            snapshot,
                        );
                    } else {
                        crate::predictions::unsupported(
                            id,
                            &context.request_id,
                            context.source_user_seq,
                        );
                    }
                }
            }
            if self.state.pending.is_empty() {
                db(database, |s| s.state(id, status.clone(), message.clone()))?;
            }
            self.settled_turn = Some((status, message));
            self.stopping = false;
            self.interrupt_sent = false;
            if let Some(reply) = self.stop_reply.take() {
                let _ = reply.send(Ok(()));
            }
        }
        if became_ready && self.stopping && !self.interrupt_sent {
            self.interrupt_sent = true;
            self.interrupt_ack_pending = true;
            let actions = self.adapter.advance(Input::Interrupt)?;
            self.apply_state(actions, database, id).await?;
        }
        self.session_open.store(self.state.ready, Ordering::SeqCst);
        self.finish_settled_side_writes(database, id)
    }
    async fn apply_state(
        &mut self,
        actions: Vec<Action>,
        database: &Database,
        id: &str,
    ) -> Result<Option<Outcome>> {
        if let Some(input) = self
            .transport
            .as_mut()
            .and_then(|transport| transport.input.as_mut())
        {
            self.state
                .apply(actions, input, database, id, &self.config)
                .await
        } else {
            if actions.iter().any(|a| {
                matches!(
                    a,
                    Action::Write(_) | Action::MetadataWrite(_) | Action::SidebandWrite(_)
                )
            }) {
                bail!("Agent未启动，不能写入原生transport");
            }
            self.state
                .apply(actions, &mut tokio::io::sink(), database, id, &self.config)
                .await
        }
    }
    async fn finish_per_turn(&mut self, database: &Database, id: &str) -> Result<()> {
        let exit = self
            .transport
            .as_mut()
            .context("Agent transport missing")?
            .exited_successfully()
            .await;
        if self.pending_result.is_none() {
            let diagnostic = match exit {
                Ok(diagnostic) => diagnostic,
                Err(error) => format!("{error:#}"),
            };
            bail!("Agent stdout EOF但没有native result；任务不能确认完成：{diagnostic}");
        }
        exit?;
        self.retire_per_turn(database, id).await?;
        let (failed, message) = self.pending_result.take().context("Agent result missing")?;
        self.result_deadline = None;
        self.close_started = false;
        self.apply_batch(vec![Action::Finished { failed, message }], database, id)
            .await
    }
    async fn stop_per_turn(&mut self, database: &Database, id: &str) -> Result<()> {
        self.cancel_prediction().await;
        self.retire_per_turn(database, id).await?;
        self.pending_result = None;
        self.result_deadline = None;
        self.close_started = false;
        self.stopping = true;
        self.apply_batch(
            vec![Action::Finished {
                failed: true,
                message: None,
            }],
            database,
            id,
        )
        .await
    }
    fn record_approval(
        &mut self,
        database: &Database,
        id: &str,
        request_id: String,
        allow: bool,
    ) -> Result<()> {
        self.state.pending.remove(&request_id);
        db(database, |s| {
            s.event(id, EventKind::ApprovalResolved { request_id, allow })?;
            Ok(())
        })?;
        self.state_after_interaction(database, id)
    }
    fn clear_approval_replies(&mut self) {
        for pending in self.approval_replies.drain().map(|(_, pending)| pending) {
            if let Some(reply) = pending.reply {
                let _ = reply.send(Err("原生执行已停止，审批结果未确认".into()));
            }
        }
    }
    fn state_after_interaction(&mut self, database: &Database, id: &str) -> Result<()> {
        let (status, message) = if !self.state.pending.is_empty() {
            (Status::Waiting, None)
        } else if self.turn_active {
            (Status::Running, None)
        } else {
            self.settled_turn
                .clone()
                .unwrap_or((Status::Completed, None))
        };
        db(database, |s| s.state(id, status, message))?;
        self.finish_settled_side_writes(database, id)
    }
    fn finish_settled_side_writes(&self, database: &Database, id: &str) -> Result<()> {
        if self.side_chat
            && !self.turn_active
            && self.pending_result.is_none()
            && !self.adapter.has_background_work()
            && self.state.pending.is_empty()
            && (self.state.ready || self.transport.is_none())
        {
            db(database, |s| s.finish_side_writes(id))?;
        }
        Ok(())
    }
    fn request_prediction_cancel(&mut self) {
        crate::predictions::invalidate(&self.prediction_owner);
        self.prediction_turn = None;
        agents::codex_jobs::registry().cancel_predictions(&self.prediction_owner);
    }
    async fn cancel_prediction(&mut self) {
        self.request_prediction_cancel();
        if let Some(job) = self.prediction_job.take() {
            job.abort();
            let _ = job.await;
        }
    }
    async fn cancel_title(&mut self) {
        agents::codex_jobs::registry().cancel_titles(&self.prediction_owner);
        if let Some(job) = self.title_job.take() {
            job.abort();
            let _ = job.await;
        }
    }
    fn begin_close(&mut self, database: &Database, id: &str) -> Result<()> {
        let journal = db(database, |s| {
            if let Some(reason) = s.unconfirmed_agent_close(id)? {
                bail!(reason);
            }
            s.record_unconfirmed_agent_close(id, CLOSE_PENDING)
        });
        if let Err(error) = journal {
            self.close_blocked = true;
            // No signal was sent. Keep the handle for explicit Close, not timer retries.
            self.result_deadline = None;
            return Err(error);
        }
        self.close_blocked = false;
        self.close_started = true;
        Ok(())
    }
    async fn close_confirmed(&mut self, database: &Database, id: &str) -> Result<()> {
        // Even a prepared/retired PerTurn actor can own detached auxiliary jobs.
        self.begin_close(database, id)?;
        let confirmed = self.close().await;
        finish_native_close(database, id, confirmed)
    }
    async fn retire_per_turn(&mut self, database: &Database, id: &str) -> Result<()> {
        self.begin_close(database, id)?;
        // Retiring physical I/O is not closing the session or its title owner.
        let confirmed = match self.transport.as_mut() {
            Some(transport) => transport.terminate(true).await,
            None => true,
        };
        if confirmed {
            self.transport = None;
            self.adapter.transport_closed();
        }
        finish_native_close(database, id, confirmed)
    }
    async fn close(&mut self) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        self.cancel_prediction().await;
        self.cancel_title().await;
        self.clear_approval_replies();
        if let Some(reply) = self.rename_reply.take() {
            let _ = reply.send(Err("原生会话已关闭，标题修改结果待确认".into()));
        }
        self.session_open.store(false, Ordering::SeqCst);
        let scope = agents::codex_jobs::JobScope::session(&self.prediction_owner);
        agents::codex_jobs::registry().cancel_scope(&scope);
        let auxiliary = async {
            agents::codex_jobs::registry()
                .wait_scope(
                    &scope,
                    deadline.saturating_duration_since(tokio::time::Instant::now()),
                )
                .await
        };
        let Some(transport) = &mut self.transport else {
            return tokio::time::timeout_at(deadline, auxiliary)
                .await
                .unwrap_or(false);
        };
        let requires_drain = self.adapter.requires_close_drain();
        let background_confirmed = if requires_drain {
            matches!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    transport.drain_native_close(self.adapter.as_mut()),
                )
                .await,
                Ok(Ok(true))
            )
        } else {
            if let Ok(Some(bytes)) = self.adapter.close_request()
                && let Some(input) = transport.input.as_mut()
            {
                let (adapter, output) = (&mut self.adapter, &mut transport.output);
                let _ = tokio::time::timeout(Duration::from_millis(750), async move {
                    write(input, &bytes).await?;
                    for _ in 0..64 {
                        let Some(Ok(line)) = output.next().await else {
                            break;
                        };
                        if adapter.close_ack(&line) {
                            break;
                        }
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await;
            }
            true
        };
        let confirmed = transport
            .terminate_with_auxiliary(
                self.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn,
                requires_drain && background_confirmed,
                deadline,
                auxiliary,
            )
            .await;
        if confirmed {
            self.transport = None;
            self.adapter.transport_closed();
        }
        confirmed && background_confirmed
    }
}
async fn close_group(
    group: &mut Group,
    deadline: tokio::time::Instant,
    expect_clean_exit: bool,
    auxiliary: impl std::future::Future<Output = bool>,
) -> bool {
    let pid = Pid::from_raw(group.pid);
    let owned = group.child.id().is_some();
    if owned && !expect_clean_exit {
        let _ = killpg(pid, Signal::SIGTERM);
    }
    // Keep the native PID owned while auxiliary cleanup may suspend. Waiting
    // after reap would let Group::drop signal a reused numeric process group.
    let auxiliary_reaped = tokio::time::timeout_at(deadline, auxiliary)
        .await
        .unwrap_or(false);
    // Per-turn transports can already have reaped their native leader. Never
    // signal that numeric process group after an auxiliary await.
    if !owned {
        return auxiliary_reaped && !expect_clean_exit;
    }
    let exit = tokio::time::timeout_at(
        deadline.min(tokio::time::Instant::now() + Duration::from_secs(2)),
        group.child.wait(),
    )
    .await;
    let group_signaled = matches!(killpg(pid, Signal::SIGKILL), Ok(()) | Err(Errno::ESRCH));
    let native_confirmed = match exit {
        Ok(Ok(status)) => !expect_clean_exit || status.success(),
        _ => {
            let reaped = matches!(
                tokio::time::timeout_at(
                    deadline.min(tokio::time::Instant::now() + Duration::from_secs(2)),
                    group.child.wait(),
                )
                .await,
                Ok(Ok(_))
            );
            reaped && !expect_clean_exit
        }
    };
    native_confirmed && group_signaled && auxiliary_reaped
}
fn finish_native_close(database: &Database, id: &str, confirmed: bool) -> Result<()> {
    if !confirmed {
        bail!(CLOSE_PENDING);
    }
    db(database, |s| {
        s.clear_unconfirmed_agent_close(id)?;
        s.finish_side_writes(id)
    })
}
async fn finish_turn(
    database: &Database,
    id: &str,
    path: &str,
    interrupted: bool,
    background_pending: bool,
) -> Result<()> {
    if let Some((request_id, before)) = db(database, |s| s.pending_turn(id))? {
        let after = crate::task_changes::Snapshot::capture_stored(
            std::path::Path::new(path),
            &db(database, |s| Ok(s.snapshot_dir.clone()))?,
        )
        .await
        .unwrap_or_else(|e| crate::task_changes::Snapshot::unavailable(e.to_string()));
        let turn = crate::task_changes::FrozenTurn::freeze(
            request_id.clone(),
            before,
            after,
            interrupted,
            background_pending,
        )
        .await;
        let turn = match turn {
            Ok(turn) => turn,
            Err(error) => {
                crate::task_changes::FrozenTurn::freeze(
                    request_id,
                    crate::task_changes::Snapshot::unavailable(error.to_string()),
                    crate::task_changes::Snapshot::unavailable(error.to_string()),
                    interrupted,
                    background_pending,
                )
                .await?
            }
        };
        db(database, |s| s.finish_turn(id, &turn))?;
    }
    Ok(())
}
fn same_config(a: &LaunchConfig, b: &LaunchConfig) -> bool {
    a.model == b.model
        && a.environment == b.environment
        && a.traex_model == b.traex_model
        && a.effort == b.effort
        && a.permission_mode == b.permission_mode
        && match (&a.provider, &b.provider) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                a.credential == b.credential
                    && a.metadata.base_url == b.metadata.base_url
                    && a.metadata.protocol == b.metadata.protocol
                    && a.metadata.auth == b.metadata.auth
                    && a.metadata.model == b.metadata.model
            }
            _ => false,
        }
}
#[allow(clippy::too_many_arguments)]
async fn accept_turn(
    process: &mut Option<Process>,
    database: &Database,
    binary: &str,
    session: &Session,
    path: &str,
    turn: SendTurn,
    session_open: &Arc<AtomicBool>,
    admission: Option<&Guard>,
    on_admitted: impl FnOnce(),
) -> Result<bool> {
    let config = turn.config.clone();
    if db(database, |s| {
        s.already_accepted(
            &session.id,
            &turn.request_id,
            &turn.text,
            turn.model.as_deref(),
            config.effort,
            turn.fingerprint.as_deref(),
            config.permission_mode.as_deref(),
        )
    })? {
        return Ok(false);
    }
    if session.agent == "cursor" {
        agents::cursor::validate_prompt(&turn.text)
            .map_err(|error| reject_turn(admission, &turn.request_id, error.to_string()))?;
    }
    if db(database, |s| Ok(s.session(&session.id)?.status.active()))? {
        return Err(reject_turn(
            admission,
            &turn.request_id,
            "会话已有运行中的任务".into(),
        ));
    }
    let per_turn = match process.as_ref() {
        Some(p) => p.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn,
        None => {
            agents::create(&session.agent)?.transport_lifetime()
                == agents::TransportLifetime::PerTurn
        }
    };
    if per_turn
        && db(database, |s| {
            Ok(s.session(&session.id)?.native_id.is_none()
                && s.has_possibly_started_request(&session.id)?)
        })?
    {
        bail!(
            "此前请求已接收，但没有已确认的原生会话ID；不能新建chat冒充continuation，请核对原生记录或创建新任务"
        );
    }
    if process.as_ref().is_some_and(|p| !p.host_prepared()) {
        return Err(reject_turn(
            admission,
            &turn.request_id,
            "Agent 会话正在恢复，请稍后重试；消息未发送".into(),
        ));
    }
    if process.as_ref().is_some_and(|p| !p.can_start_turn()) {
        return Err(reject_turn(
            admission,
            &turn.request_id,
            "Agent 尚有本轮响应、审批或发送确认待处理；消息未发送".into(),
        ));
    }
    if let Some(current) = process.as_mut()
        && !same_config(&current.config, &config)
    {
        if !current.adapter.can_reconfigure() {
            return Err(reject_turn(
                admission,
                &turn.request_id,
                RECONFIGURE_BLOCKED.into(),
            ));
        }
        let closed = current.close_confirmed(database, &session.id).await;
        if current.close_started {
            *process = None;
        }
        closed?;
    }
    let Some(source_user_seq) = db(database, |s| {
        s.begin_with_source(
            &session.id,
            &turn.request_id,
            &turn.text,
            turn.model.as_deref(),
            config.effort,
            turn.fingerprint.as_deref(),
            config.permission_mode.as_deref(),
        )
    })?
    else {
        return Ok(false);
    };
    crate::predictions::invalidate(&session.id);
    agents::codex_jobs::registry().cancel_predictions(&session.id);
    if let Some(p) = process.as_mut() {
        p.request_prediction_cancel();
    }
    // Admission is complete once the request and User/Running events are durable.
    // Filesystem snapshots and Agent startup can take longer than the sender's
    // confirmation deadline; they must not make accepted input look rejected.
    on_admitted();
    // After durable admission, all failures become explicit terminal events. The
    // accepted request ID still reconciles a lost transport response without replay.
    let result = async {
        if let Some(p) = process.as_mut() {
            p.cancel_prediction().await;
        }
        // Side chats share the main working directory. An independent snapshot
        // could attribute concurrent main writes to the child and undo them.
        if db(database, |s| Ok(s.side_parent(&session.id)?.is_none()))? {
            let baseline = crate::task_changes::Snapshot::capture_stored(
                std::path::Path::new(path),
                &db(database, |s| Ok(s.snapshot_dir.clone()))?,
            )
            .await
            .unwrap_or_else(|e| crate::task_changes::Snapshot::unavailable(e.to_string()));
            db(database, |s| {
                s.save_turn_baseline(&session.id, &turn.request_id, &baseline)
            })?;
            if db(database, |s| s.baseline(&session.id))?.is_none() {
                let task_baseline = if db(database, |s| s.first_request(&session.id))? {
                    baseline
                } else {
                    crate::task_changes::Snapshot::unavailable(
                        "此历史任务没有记录文件基线，请查看工作区改动".into(),
                    )
                };
                db(database, |s| s.save_baseline(&session.id, &task_baseline))?;
            }
        }
        if process.is_some() {
            db(database, |s| s.start_side_write(&turn.request_id))?;
        } else {
            let current = db(database, |s| s.session(&session.id))?;
            *process = Some(
                Process::launch(
                    database,
                    binary,
                    &current,
                    path,
                    turn.config,
                    session_open.clone(),
                    Some(&turn.request_id),
                )
                .await?,
            );
        }
        let p = process.as_mut().context("Agent process missing")?;
        p.turn_active = true;
        p.active_request_id = Some(turn.request_id.clone());
        if !turn.text.trim_start().starts_with('/')
            && db(database, |s| Ok(s.side_parent(&session.id)?.is_none()))?
        {
            p.prediction_turn = crate::predictions::TurnContext::try_new(
                &turn.request_id,
                source_user_seq,
                &p.config.redact(&turn.text),
                p.config.redactor(),
            );
        }
        p.settled_turn = None;
        p.background_at_start = p.adapter.has_background_work();
        p.turn_deadline = tokio::time::Instant::now() + TURN_LIMIT;
        let notice = if let Some(provider) = &p.config.provider {
            Some(format!(
                "Provider：{} · 模型：{}",
                provider.metadata.name,
                p.config
                    .model
                    .as_deref()
                    .unwrap_or(&provider.metadata.model)
            ))
        } else {
            p.config.model.as_ref().map(|m| format!("模型：{m}"))
        };
        if let Some(text) = notice {
            db(database, |s| {
                s.event(&session.id, EventKind::Notice { text })
            })?;
        }
        let actions = p.adapter.advance(Input::Start { prompt: &turn.text })?;
        p.apply(actions, database, &session.id).await
    }
    .await;
    if let Err(error) = result {
        let background_pending = process
            .as_ref()
            .is_some_and(|p| p.turn_active && p.background_at_start);
        let message = if let Some(p) = process.as_mut() {
            let message = p.config.redact(&error.to_string());
            let closed = p.close_confirmed(database, &session.id).await;
            if closed.is_err() && !p.close_started {
                return Ok(true);
            }
            message
        } else {
            config.redact(&error.to_string())
        };
        *process = None;
        finish_turn(database, &session.id, path, true, background_pending).await?;
        db(database, |s| {
            s.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Unknown)?;
            s.state(&session.id, Status::Failed, Some(message))
        })?;
    }
    Ok(true)
}
#[allow(clippy::too_many_arguments)]
async fn receive_turn(
    process: &mut Option<Process>,
    database: &Database,
    binary: &str,
    session: &Session,
    path: &str,
    turn: SendTurn,
    session_open: &Arc<AtomicBool>,
    allow_queue: bool,
    pending_inputs: bool,
    configs: &mut HashMap<String, LaunchConfig>,
    admission: &Guard,
    on_admitted: impl FnOnce(),
) -> Result<Response> {
    {
        if let Some(response) = db(database, |d| d.queued_duplicate(&session.id, &turn))? {
            return Ok(response);
        }
    }
    if db(database, |d| {
        d.already_accepted(
            &session.id,
            &turn.request_id,
            &turn.text,
            turn.model.as_deref(),
            turn.config.effort,
            turn.fingerprint.as_deref(),
            turn.config.permission_mode.as_deref(),
        )
    })? {
        return Ok(Response::Accepted { duplicate: true });
    }
    if session.agent == "cursor" {
        agents::cursor::validate_prompt(&turn.text)
            .map_err(|error| reject_turn(admission, &turn.request_id, error.to_string()))?;
    }
    if pending_inputs && !allow_queue {
        return Err(reject_turn(
            admission,
            &turn.request_id,
            "Agent 尚有已交付的消息待处理".into(),
        ));
    }
    if allow_queue {
        let queued = db(database, |d| d.queued(&session.id))?;
        let busy = pending_inputs
            || db(database, |d| Ok(d.session(&session.id)?.status.active()))?
            || process.as_ref().is_some_and(|p| !p.can_start_turn());
        // An idle foreground can accept same-config input while its children run.
        // A config change still needs safe process replacement, even with a queue.
        if !busy
            && let Some(p) = process.as_ref()
            && !same_config(&p.config, &turn.config)
            && !p.adapter.can_reconfigure()
        {
            return Err(reject_turn(
                admission,
                &turn.request_id,
                RECONFIGURE_BLOCKED.into(),
            ));
        }
        if busy || !queued.is_empty() {
            if let Err(error) = db(database, |d| d.enqueue(&session.id, &turn)) {
                return Err(
                    if error.is::<crate::message_queue::QueueCapacityExceeded>() {
                        reject_send(admission, &turn.request_id, error.to_string())
                    } else {
                        error
                    },
                );
            }
            configs.insert(turn.request_id, turn.config);
            return Ok(Response::MessageQueued { duplicate: false });
        }
    }
    if allow_queue {
        db(database, |d| d.pause_queue(&session.id, None))?;
    }
    let new = accept_turn(
        process,
        database,
        binary,
        session,
        path,
        turn,
        session_open,
        Some(admission),
        on_admitted,
    )
    .await?;
    Ok(Response::Accepted { duplicate: !new })
}
#[allow(clippy::too_many_arguments)]
async fn actor(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    mut controls: mpsc::Receiver<Control>,
    safe_to_close: Arc<AtomicBool>,
    session_open: Arc<AtomicBool>,
) {
    struct Immediate {
        turn: SendTurn,
        restore_reason: Option<String>,
        reply: oneshot::Sender<Result<Response, String>>,
        deadline: tokio::time::Instant,
    }
    let mut immediate: Option<Immediate> = None;
    let mut forwarded = ForwardedInputs::default();
    let mut process: Option<Process> = None;
    let mut queued_configs = HashMap::<String, LaunchConfig>::new();
    let mut opening: Vec<oneshot::Sender<Result<(), String>>> = Vec::new();
    loop {
        let init_deadline = process
            .as_ref()
            .filter(|p| !p.close_blocked && p.initializing())
            .map(|p| p.init_deadline);
        let turn_deadline = process
            .as_ref()
            .filter(|p| !p.close_blocked && p.turn_active)
            .map(|p| p.turn_deadline);
        // A handoff delivered near the end of a long turn gets its own full
        // confirmation window. New deliveries never extend older inputs or the
        // active turn's execution limit.
        let handoff_deadline = forwarded.deadline();
        let immediate_deadline = immediate.as_ref().map(|v| v.deadline);
        let result_deadline = process
            .as_ref()
            .filter(|p| !p.close_blocked)
            .and_then(|p| p.result_deadline);
        let approval_deadline = process.as_ref().and_then(|p| {
            p.approval_replies
                .values()
                .filter(|p| p.reply.is_some())
                .map(|p| p.deadline)
                .min()
        });
        let previous_status = db(&database, |d| Ok(d.session(&session.id)?.status)).ok();
        let result: Result<()> = tokio::select! {
            control = controls.recv() => match control {
                Some(Control::TitleContext { reply }) => {
                    let _ = reply.send(process.as_ref().map(|p| p.config.clone()));
                    Ok(())
                }
                Some(Control::RenameTitle {title,reply}) => {
                    safe_to_close.store(false, Ordering::SeqCst);
                    if let Some(p)=process.as_mut().filter(|p|p.state.ready) {
                        if p.rename_reply.is_some() {let _=reply.send(Err("标题修改结果待确认，请稍后重试".into()));Ok(())}
                        else {
                            let id=uuid::Uuid::new_v4().to_string();
                            match p.adapter.advance(Input::RenameTitle {id:&id,title:&title}) {
                                Ok(actions)=>{p.rename_reply=Some(reply);p.apply(actions,&database,&session.id).await}
                                Err(error)=>{let _=reply.send(Err(error.to_string()));Ok(())}
                            }
                        }
                    } else {let _=reply.send(Err("原生会话尚未就绪，标题未修改".into()));Ok(())}
                }
                Some(Control::Open { config, reply }) => {
                    if process.as_ref().is_some_and(|p| p.close_blocked) {
                        let _ = reply.send(Err("关闭记录写入失败，请重试关闭后再打开".into()));
                        continue;
                    }
                    let result = async {
                        if process.is_none() {
                            let current = db(&database, |s| s.session(&session.id))?;
                            let mut p = Process::launch(
                                &database,
                                &binary,
                                &current,
                                &path,
                                config,
                                session_open.clone(),
                                None,
                            )
                            .await?;
                            let actions = p.adapter.advance(Input::Open)?;
                            p.apply(actions, &database, &session.id).await?;
                            process = Some(p);
                        }
                        Ok::<_, anyhow::Error>(())
                    }
                    .await;
                    match result {
                        Ok(()) if process.as_ref().is_some_and(Process::host_prepared) => {
                            let _ = reply.send(Ok(()));
                        }
                        Ok(()) => opening.push(reply),
                        Err(error) => {
                            let _ = reply.send(Err(error.to_string()));
                        }
                    }
                    Ok(())
                }
                Some(Control::Interrupt { reply }) => async {
                    if let Some(p) = process.as_mut().filter(|p| p.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn && p.turn_active) {
                        db(&database, |d| d.pause_queue(&session.id, Some("当前执行已停止，队列已暂停")))?;
                        let result = p.stop_per_turn(&database, &session.id).await;
                        let _ = reply.send(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                        return result;
                    }
                    if let Some(pending) = immediate.take() { let _ = pending.reply.send(Err("发送已取消，消息保留在队列".into())); }
                    if !forwarded.is_empty() {
                        let background_pending=process.as_ref().is_some_and(|p|p.turn_active&&p.background_at_start);
                        if let Some(p)=process.as_mut(){p.close_confirmed(&database, &session.id).await?;}
                        process=None;
                        forwarded.clear();
                        db(&database,|d|{d.uncertain_forwarded(&session.id)?;d.end_subagents(&session.id,latte_work_protocol::SubagentStatus::Unknown)?;d.pause_queue(&session.id,Some("当前执行已停止，队列已暂停"))})?;
                        finish_turn(&database,&session.id,&path,true,background_pending).await?;
                        db(&database,|d|d.state(&session.id,Status::Stopped,Some("已停止；已发送消息的处理状态请核对 Agent 记录".into())))?;
                        let _=reply.send(Ok(()));
                        Ok(())
                    } else if process.as_ref().is_some_and(|p| !p.turn_active && !p.state.pending.is_empty()) {
                        if let Some(p) = process.as_mut() {
                            p.close_confirmed(&database, &session.id).await?;
                        }
                        process = None;
                        db(&database, |d| {
                            d.pause_queue(&session.id, Some("当前执行已停止，队列已暂停"))?;
                            d.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Stopped)?;
                            d.state(&session.id, Status::Stopped, Some("已停止后台任务；已执行的文件改动不会撤销。".into()))
                        })?;
                        let _ = reply.send(Ok(()));
                        Ok(())
                    } else if let Some(p) = process.as_mut().filter(|p| p.turn_active) {
                        if p.stopping {
                            let _ = reply.send(Err("任务正在停止".into()));
                            Ok(())
                        } else {
                            p.stopping = true;
                            p.stop_reply = Some(reply);
                            p.turn_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                            if !p.state.ready && !p.adapter.can_interrupt_startup() {
                                Ok(())
                            } else {
                                p.interrupt_sent = true;
                                p.interrupt_ack_pending = true;
                                match p.adapter.advance(Input::Interrupt) {
                                    Ok(actions) => p.apply(actions, &database, &session.id).await,
                                    Err(error) => Err(error),
                                }
                            }
                        }
                    } else {
                        let _ = reply.send(Ok(()));
                        Ok(())
                    }
                }.await,
                Some(Control::SubagentHistory { task_id, permit, reply }) => {
                    let source=db(&database,|d|Ok((d.subagent(&session.id,&task_id)?,d.session(&session.id)?.native_id,d.child_history_cursor(&session.id,&task_id)?))).map(|(child,parent,cursor)|{
                        let process=process.as_ref().filter(|p|p.adapter.knows_subagent(&child.native_id));
                        let config=process.map(|p|p.config.clone());
                        // A resumed OpenCode session may run from its recorded
                        // directory; children export from that same directory.
                        let cwd=process.map(|p|p.agent_cwd.clone()).unwrap_or_else(||path.clone());
                        (child,parent,cursor,config,cwd)
                    });
                    let result=async {
                        let (child,parent,cursor,config,cwd)=source?;
                        let (Some(config),Some(parent))=(config,parent) else {return Ok(false);};
                        let page=agents::child_history(std::path::PathBuf::from(cwd),parent,child.native_id,session.id.clone(),config,cursor,permit).await?;
                        if let Some(page)=page {
                            db(&database,|d|d.cache_child_history(&session.id,&task_id,&page))?;
                            return Ok(page.has_more);
                        }
                        Ok::<_,anyhow::Error>(false)
                    }.await;
                    let _=reply.send(result.map_err(|e|e.to_string()));
                    Ok(())
                }
                Some(Control::SubagentTranscript { task_id, permit, reply }) => {
                    let source = db(&database, |d| Ok((d.subagent(&session.id, &task_id)?, d.session(&session.id)?.native_id))).map(|(child,parent)| {
                        let config = process.as_ref().filter(|p| p.adapter.knows_subagent(&child.native_id)).map(|p| p.config.clone());
                        (child, parent, config)
                    });
                    let result = async {
                        let (child, parent, config) = source?;
                        let (Some(config), Some(parent)) = (config, parent) else { return Ok(None); };
                        let snapshot = agents::child_transcript(std::path::PathBuf::from(&path), parent, child.native_id, session.id.clone(), config, permit).await?;
                        if let Some(snapshot) = &snapshot && !snapshot.0.is_empty() {
                            db(&database, |d| d.cache_subagent_transcript(&session.id, &task_id, snapshot))?;
                        }
                        Ok::<_, anyhow::Error>(snapshot.filter(|s| !s.0.is_empty()))
                    }.await;
                    let _ = reply.send(result.map_err(|e| e.to_string()));
                    Ok(())
                }
                Some(Control::Queue { action: QueueAction::Dispatch {interrupt:false,request_id,revision,config}, reply }) if process.as_ref().is_some_and(|p|p.turn_active) => {
                    let config=*config;
                    let prepared=(|| {
                        if immediate.is_some() || forwarded.len()>=16 {bail!("Agent 正在切换任务或待处理消息已达上限");}
                        let p=process.as_mut().context("Agent 未启动")?;
                        if !p.state.ready || p.stopping || p.interrupt_ack_pending || !same_config(&p.config,&config) {bail!("当前 Agent 尚未就绪或执行配置不一致，消息保留在队列");}
                        let (entry,_)=db(&database,|d|d.queued(&session.id))?.into_iter().find(|(e,_)|e.request_id==request_id && e.revision==revision).context("消息已执行、移除或更新，请刷新队列")?;
                        p.request_prediction_cancel();
                        if let Some(job) = p.prediction_job.take() { job.abort(); }
                        let actions=p.adapter.advance(Input::Queue{request_id:&request_id,prompt:&entry.text})?;
                        Ok(actions)
                    })();
                    match prepared {
                        Err(error)=>{let _=reply.send(Err(error.to_string()));Ok(())},
                        Ok(actions)=> {
                            let result=async {
                                // After adapter preparation, a failed durable handoff
                                // must fail/close the actor rather than retain an
                                // unwritten native UUID in a live adapter.
                                db(&database,|d|d.mark_forwarded(&session.id,&request_id,revision))?;
                                forwarded.insert(request_id.clone());
                                queued_configs.remove(&request_id);
                                process.as_mut().expect("prepared process").apply(actions,&database,&session.id).await
                            }.await;
                            match result {
                                Ok(())=>{let snapshot=db(&database,|d|d.queue_snapshot(&session.id));let _=reply.send(snapshot.map_err(|e|e.to_string()));Ok(())},
                                Err(error)=>{let _=reply.send(Err("消息交付结果待确认，不会自动重发，请核对 Agent 记录".into()));Err(error)}
                            }
                        }
                    }
                }
                Some(Control::Queue { action: QueueAction::Dispatch {interrupt, request_id, revision, config}, reply }) => async {
                    let config=*config;
                    let prepared = (|| {
                        if immediate.is_some() { bail!("正在发送，请稍后重试"); }
                        if !interrupt && !forwarded.is_empty() { bail!("Agent 尚有已交付的消息待处理，请稍后重试"); }
                        if let Some(p) = process.as_ref() {
                            if !p.host_prepared() || p.stopping || p.interrupt_ack_pending { bail!("Agent 正在准备或停止，请稍后重试"); }
                            if p.turn_active && !same_config(&p.config,&config) { bail!("立即发送需沿用当前 Agent 的执行配置，请编辑后重新发送"); }
                        }
                        db(&database, |d| {
                            let (entry,fingerprint) = d.queued(&session.id)?.into_iter().find(|(e,_)|e.request_id==request_id && e.revision==revision).context("消息已开始执行、移除或更新，请刷新队列")?;
                            let (paused,reason) = d.queue_state(&session.id)?;
                            d.pause_queue(&session.id,Some("正在发送消息"))?;
                            Ok((SendTurn { request_id: entry.request_id, text: entry.text, model: entry.model, fingerprint, config }, if paused {Some(reason.unwrap_or_else(||"队列已暂停".into()))} else {None}))
                        })
                    })();
                    match prepared {
                        Err(error) => { let _=reply.send(Err(error.to_string())); Ok(()) },
                        Ok((turn,restore_reason)) => {
                            immediate=Some(Immediate {turn,restore_reason,reply,deadline:tokio::time::Instant::now()+Duration::from_secs(8)});
                            if interrupt && !forwarded.is_empty() {
                                let background_pending=process.as_ref().is_some_and(|p|p.turn_active&&p.background_at_start);
                                if let Some(p)=process.as_mut() {p.close_confirmed(&database, &session.id).await?;}
                                process=None;
                                forwarded.clear();
                                db(&database,|d|{d.uncertain_forwarded(&session.id)?;d.end_subagents(&session.id,latte_work_protocol::SubagentStatus::Unknown)})?;
                                finish_turn(&database,&session.id,&path,true,background_pending).await?;
                                db(&database,|d|d.state(&session.id,Status::Stopped,Some("已停止当前任务".into())))?;
                                Ok(())
                            } else if let Some(p)=process.as_mut().filter(|p|p.turn_active && interrupt) {
                                if p.adapter.transport_lifetime() == agents::TransportLifetime::PerTurn {
                                    return p.stop_per_turn(&database, &session.id).await;
                                }
                                p.stopping=true;
                                p.interrupt_sent=true;
                                p.interrupt_ack_pending=true;
                                let actions=p.adapter.advance(Input::Interrupt);
                                match actions {Ok(actions)=>p.apply(actions,&database,&session.id).await,Err(error)=>Err(error)}
                            } else {Ok(())}
                        }
                    }
                }.await,
                Some(Control::Queue { action, reply }) => {
                    let result = db(&database, |d| {
                        if immediate.is_some() { bail!("正在发送，请稍后操作队列"); }
                        match action {
                            QueueAction::Dispatch {..} => unreachable!(),
                            QueueAction::Take {request_id,revision} => { let result=d.take_queued(&session.id,&request_id,revision)?; queued_configs.remove(&request_id); return Ok(result); },
                            QueueAction::Edit {request_id,revision,text} => {
                                if session.agent == "cursor" && let Some(text) = text.as_deref() {
                                    agents::cursor::validate_prompt(text)?;
                                }
                                d.edit_queued(&session.id,&request_id,revision,text.as_deref())?;
                                if text.is_none(){queued_configs.remove(&request_id);}
                            },
                            QueueAction::Reorder {expected,order} => d.reorder_queue(&session.id,&expected,&order)?,
                            QueueAction::Clear => {d.clear_queue(&session.id)?;queued_configs.clear();},
                            QueueAction::Resume {configs} => {
                                let entries=d.queued(&session.id)?;
                                if entries.len()!=configs.len() || entries.iter().any(|(e,_)|!configs.contains_key(&e.request_id)) {bail!("队列已变化，请刷新后继续");}
                                queued_configs=configs;d.pause_queue(&session.id,None)?;
                            }
                        }
                        d.queue_snapshot(&session.id)
                    });
                    let _=reply.send(result.map_err(|e|e.to_string()));
                    Ok(())
                }
                Some(Control::Send { turn, allow_queue, admission, reply }) => {
                    safe_to_close.store(false, Ordering::SeqCst);
                    let mut reply = Some(reply);
                    let result = receive_turn(&mut process, &database, &binary, &session, &path, turn, &session_open, allow_queue, !forwarded.is_empty(), &mut queued_configs, &admission, || {
                        if let Some(reply) = reply.take() {
                            let _ = reply.send(Ok(Response::Accepted { duplicate: false }));
                        }
                    }).await;
                    if let Some(reply) = reply {
                        let _ = reply.send(result);
                    }
                    // The decoded attempt ends here, not when its sender times out.
                    drop(admission);
                    Ok(())
                }
                Some(Control::Cancel { reply, only_if_idle }) => {
                    if !only_if_idle { forwarded.clear(); let _=db(&database,|d|d.uncertain_forwarded(&session.id)); }
                    if only_if_idle && (immediate.is_some() || !forwarded.is_empty() || process.as_ref().is_some_and(|p| p.turn_active || p.interrupt_ack_pending || !p.state.pending.is_empty() || !p.adapter.can_reconfigure()) || db(&database,|d|Ok(!d.queue_state(&session.id)?.0 && !d.queued(&session.id)?.is_empty())).unwrap_or(true)) {
                        if let Some(reply) = reply { let _ = reply.send(Err("会话有运行任务、审批或后台任务，请确认后关闭".into())); }
                        continue;
                    }
                    let _ = db(&database, |d| d.pause_queue(&session.id,Some("当前执行已停止，队列已暂停")));
                    if let Some(pending) = immediate.take() {
                        let _ = pending.reply.send(Err("发送已取消，消息保留在队列".into()));
                    }
                    let background_pending = process
                        .as_ref()
                        .is_some_and(|p| p.turn_active && p.background_at_start);
                    let close_unconfirmed = if let Some(p) = process.as_mut() {
                        let result = p.close_confirmed(&database, &session.id).await;
                        if let Err(error) = &result && !p.close_started {
                            safe_to_close.store(false, Ordering::SeqCst);
                            if let Some(reply) = reply { let _ = reply.send(Err(error.to_string())); }
                            continue;
                        }
                        result.is_err()
                    } else { false };
                    process = None;
                    if let Err(error) =
                        finish_turn(&database, &session.id, &path, true, background_pending).await
                    {
                        eprintln!("cannot freeze stopped turn: {error}");
                    }
                    // Preserve completed history when merely closing an idle runtime.
                    let result = db(&database, |s| {
                        let (status, subagent_status, message) = if close_unconfirmed {
                            (Status::Unknown, latte_work_protocol::SubagentStatus::Unknown,
                             CLOSE_PENDING)
                        } else {
                            (Status::Stopped, latte_work_protocol::SubagentStatus::Stopped,
                             "已停止；已执行的文件改动不会撤销。")
                        };
                        s.end_subagents(&session.id, subagent_status)?;
                        if s.session(&session.id)?.status.active() {
                            s.state(&session.id, status, Some(message.into()))?;
                        }
                        if close_unconfirmed {
                            bail!(message);
                        }
                        Ok(())
                    });
                    if let Ok(mut map) = runs.lock() {
                        map.remove(&session.id);
                    }
                    if let Some(reply) = reply {
                        let _ = reply.send(result.map_err(|error| error.to_string()));
                    }
                    break;
                }
                Some(Control::AnswerQuestion { id, answers, reply }) => {
                    let validation = process.as_ref().and_then(|p| p.state.pending.get(&id)).and_then(|(_, _, questions)| questions.as_ref()).context("问题已过期或不属于当前执行").and_then(|questions| match &answers { Some(answers) => crate::questions::validate(questions, answers), None => Ok(()) });
                    if let Err(error) = validation {
                        let _ = reply.send(Err(error.to_string()));
                        Ok(())
                    } else {
                        let result = async {
                            let p = process.as_mut().context("此会话没有运行中的任务")?;
                            let (native_id, original, questions) = p.state.pending.remove(&id).context("问题已过期")?;
                            let actions = p.adapter.advance(Input::QuestionAnswer { id: &native_id, input: original, questions: questions.context("此交互不是问题")?, answers: answers.clone() })?;
                            p.apply(actions, &database, &session.id).await?;
                            db(&database, |s| {
                                s.event(&session.id, p.config.redact_event(EventKind::QuestionResolved { request_id: id, answers })?)?;
                                Ok(())
                            })?;
                            p.state_after_interaction(&database, &session.id)
                        }.await;
                        let _ = reply.send(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                        result
                    }
                }
                Some(Control::Approval { id, allow, reply }) => {
                    async {
                        let Some(p) = process.as_mut().filter(|p| !p.stopping) else {
                            let _ = reply.send(Err("审批已过期或不属于当前执行".into()));
                            return Ok(());
                        };
                        let Some((native, original, None)) = p.state.pending.get(&id) else {
                            let _ = reply.send(Err("审批已过期或不属于当前执行".into()));
                            return Ok(());
                        };
                        if p.approval_replies.contains_key(native) {
                            let _ = reply.send(Err("OpenCode 审批结果待确认".into()));
                            return Ok(());
                        }
                        let deferred = p.adapter.awaits_approval_reply(native);
                        let actions = p.adapter.advance(Input::Approval {
                            id: native,
                            input: original.clone(),
                            allow,
                        })?;
                        if deferred {
                            p.approval_replies.insert(native.clone(), PendingApprovalReply {
                                reply: Some(reply),
                                deadline: tokio::time::Instant::now() + Duration::from_secs(8),
                                allow,
                            });
                            p.apply(actions, &database, &session.id).await
                        } else {
                            p.state.pending.remove(&id);
                            let result = async {
                                p.apply(actions, &database, &session.id).await?;
                                p.record_approval(&database, &session.id, id, allow)
                            }.await;
                            let _ = reply.send(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                            result
                        }
                    }.await
                }
                None => break,
            },
            line = async { match process.as_mut().filter(|p| !p.close_blocked) { Some(p) => p.next_message().await, None => std::future::pending().await } } => {
                async {
                    let p = process.as_mut().context("Agent process missing")?;
                    let Some((line, sideband)) = line? else {
                        return p.finish_per_turn(&database, &session.id).await;
                    };
                    let actions = p.adapter.advance(if sideband { Input::Sideband(&line) } else { Input::Message(&line) })?;
                    let consumed: Vec<_> = actions.iter().filter_map(|action| match action {
                        Action::InputsConsumed(ids) => Some(ids.as_slice()), _ => None,
                    }).flatten().cloned().chain(actions.iter().filter_map(|action| match action {
                        Action::InputRejected { request_id, .. } => Some(request_id.clone()), _ => None,
                    })).collect();
                    p.apply(actions, &database, &session.id).await?;
                    for id in consumed { forwarded.remove(&id); }
                    Ok(())
                }.await
            },
            _ = deadline(immediate_deadline) => {
                // Timing out a delivery confirmation is not evidence that the
                // native process failed. Keep its interrupt acknowledgement and
                // current turn under normal supervision, without replaying input.
                if let Some(pending) = immediate.take() {
                    let _ = pending.reply.send(Err("发送确认超时，消息保留在队列，请核对后重试".into()));
                    db(&database, |d| d.pause_queue(&session.id, pending.restore_reason.as_deref().or(Some("发送确认超时，队列已暂停，请核对后继续"))))
                } else { Ok(()) }
            },
            _ = deadline(init_deadline) => Err(anyhow::anyhow!("Agent 初始化超时（18 秒）")),
            _ = deadline(result_deadline) => Err(anyhow::anyhow!("Agent已返回result，但stdout/进程未在10秒内收尾；完成未确认")),
            _ = deadline(approval_deadline) => {
                if let Some(p) = &mut process {
                    let now = tokio::time::Instant::now();
                    for pending in p.approval_replies.values_mut().filter(|p| p.deadline <= now) {
                        if let Some(reply) = pending.reply.take() {
                            let _ = reply.send(Err("OpenCode 审批确认超时，审批结果待确认".into()));
                        }
                    }
                }
                Ok(())
            },
            _ = deadline(turn_deadline) => Err(anyhow::anyhow!("任务超过 24 小时上限")),
            _ = deadline(handoff_deadline) => Err(anyhow::anyhow!("Agent 未在 24 小时内确认已交付的消息，处理结果待确认；不会自动重发")),
        };
        if let Err(error) = result {
            forwarded.clear();
            let _ = db(&database, |d| d.uncertain_forwarded(&session.id));
            if let Some(pending) = immediate.take() {
                let _ = pending
                    .reply
                    .send(Err("发送未确认，消息保留在队列，请核对后重试".into()));
            }
            let _ = db(&database, |d| {
                d.pause_queue(&session.id, Some("执行出现异常，队列已暂停，请核对后继续"))
            });
            let recovery = process
                .as_ref()
                .filter(|p| p.state.ready)
                .map(|p| p.config.clone());
            let background_pending = process
                .as_ref()
                .is_some_and(|p| p.turn_active && p.background_at_start);
            let message = if let Some(p) = process.as_mut() {
                let text = p.config.redact(&error.to_string());
                if let Some(reply) = p.stop_reply.take() {
                    let _ = reply.send(Err(text.clone()));
                }
                let closed = p.close_confirmed(&database, &session.id).await;
                if let Err(error) = closed
                    && !p.close_started
                {
                    safe_to_close.store(false, Ordering::SeqCst);
                    for reply in opening.drain(..) {
                        let _ = reply.send(Err(error.to_string()));
                    }
                    continue;
                }
                text
            } else {
                error.to_string()
            };
            process = None;
            if let Err(error) =
                finish_turn(&database, &session.id, &path, true, background_pending).await
            {
                eprintln!("cannot freeze failed turn: {error}");
            }
            if let Err(e) = db(&database, |s| {
                s.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Unknown)?;
                s.state(&session.id, Status::Failed, Some(message))
            }) {
                eprintln!("cannot persist terminal state: {e}");
            }
            if let Some(config) = recovery
                && db(&database, |s| s.unconfirmed_agent_close(&session.id))
                    .is_ok_and(|pending| pending.is_none())
            {
                let restore = async {
                    let current = db(&database, |s| s.session(&session.id))?;
                    let mut p = Process::launch(
                        &database,
                        &binary,
                        &current,
                        &path,
                        config,
                        session_open.clone(),
                        None,
                    )
                    .await?;
                    let actions = p.adapter.advance(Input::Open)?;
                    p.apply(actions, &database, &session.id).await?;
                    Ok::<_, anyhow::Error>(p)
                }
                .await;
                if let Ok(p) = restore {
                    process = Some(p);
                }
            }
        }
        if db(&database, |s| s.unconfirmed_agent_close(&session.id))
            .is_ok_and(|pending| pending.is_some())
        {
            let _ = db(&database, |s| {
                s.pause_queue(&session.id, Some(CLOSE_PENDING))?;
                s.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Unknown)?;
                s.state(&session.id, Status::Unknown, Some(CLOSE_PENDING.into()))
            });
            for reply in opening.drain(..) {
                let _ = reply.send(Err(CLOSE_PENDING.into()));
            }
            if let Ok(mut map) = runs.lock() {
                map.remove(&session.id);
            }
            // Retain durable uncertainty; do not retry close or spawn a replacement.
            process = None;
            break;
        }
        if process.as_ref().is_some_and(Process::host_prepared) {
            for reply in opening.drain(..) {
                let _ = reply.send(Ok(()));
            }
        } else if process.is_none() {
            for reply in opening.drain(..) {
                let _ = reply.send(Err("Agent 会话未能打开，请重试".into()));
            }
        }
        let queue_result = async {
            let status = db(&database, |d| Ok(d.session(&session.id)?.status))?;
            if previous_status
                .as_ref()
                .is_some_and(|s| s.active() || *s != status)
                && !status.active()
                && status != Status::Completed
            {
                db(&database, |d| {
                    d.pause_queue(&session.id, Some("当前执行未完成，队列已暂停"))
                })?;
            }
            // Native completions can consume zero, one or several delivered
            // inputs. Never invent another turn or replay them at this boundary.
            if !status.active() && status != Status::Completed && !forwarded.is_empty() {
                forwarded.clear();
                db(&database, |d| d.uncertain_forwarded(&session.id))?;
            }
            let status = db(&database, |d| Ok(d.session(&session.id)?.status))?;
            if immediate.is_some()
                && !status.active()
                && process
                    .as_ref()
                    .is_none_or(|p| p.host_prepared() && !p.turn_active && !p.interrupt_ack_pending)
            {
                let pending = immediate.take().expect("checked immediate");
                let result = async {
                    if matches!(status, Status::Failed | Status::Unknown)
                        && previous_status.as_ref().is_some_and(|s| s.active())
                    {
                        bail!("当前执行异常，发送消息保留在队列");
                    }
                    accept_turn(
                        &mut process,
                        &database,
                        &binary,
                        &session,
                        &path,
                        pending.turn,
                        &session_open,
                        None,
                        || {},
                    )
                    .await?;
                    queued_configs.retain(|id, _| {
                        db(&database, |d| {
                            Ok(d.queued(&session.id)?
                                .iter()
                                .any(|(e, _)| &e.request_id == id))
                        })
                        .unwrap_or(false)
                    });
                    if db(&database, |d| {
                        Ok(d.session(&session.id)?.status == Status::Failed)
                    })? {
                        bail!("消息发送失败，请检查 Agent 状态");
                    }
                    db(&database, |d| {
                        d.pause_queue(&session.id, pending.restore_reason.as_deref())?;
                        d.queue_snapshot(&session.id)
                    })
                }
                .await;
                let _ = pending.reply.send(result.map_err(|e| e.to_string()));
            }
            let (status, paused) = db(&database, |d| {
                Ok((
                    d.session(&session.id)?.status,
                    d.queue_state(&session.id)?.0,
                ))
            })?;
            if !paused
                && forwarded.is_empty()
                && !status.active()
                && process.as_ref().is_none_or(Process::can_start_turn)
                && let Some((entry, fingerprint)) =
                    db(&database, |d| d.queued(&session.id))?.into_iter().next()
            {
                let config = queued_configs
                    .remove(&entry.request_id)
                    .context("排队的执行配置需重新确认，请点击继续排队")?;
                accept_turn(
                    &mut process,
                    &database,
                    &binary,
                    &session,
                    &path,
                    SendTurn {
                        request_id: entry.request_id,
                        text: entry.text,
                        model: entry.model,
                        fingerprint,
                        config,
                    },
                    &session_open,
                    None,
                    || {},
                )
                .await?;
                if db(&database, |d| {
                    Ok(d.session(&session.id)?.status == Status::Failed)
                })? {
                    bail!("排队消息未能开始执行，请核对后继续");
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = queue_result {
            forwarded.clear();
            let _ = db(&database, |d| d.uncertain_forwarded(&session.id));
            let _ = db(&database, |d| {
                d.pause_queue(&session.id, Some(&error.to_string()))
            });
        }
        let queue_idle = db(&database, |d| {
            Ok(d.queue_state(&session.id)?.0 || d.queued(&session.id)?.is_empty())
        })
        .unwrap_or(false);
        safe_to_close.store(
            queue_idle
                && immediate.is_none()
                && forwarded.is_empty()
                && process.as_ref().is_none_or(Process::idle_for_close),
            Ordering::SeqCst,
        );
    }
    if let Some(p) = process.as_mut() {
        let _ = p.close_confirmed(&database, &session.id).await;
    }
}
async fn deadline(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// A bounded metadata-only launch, sharing supervision but never storing or sending a turn.
pub async fn commands(
    binary: &str,
    agent: &str,
    path: &str,
    config: &LaunchConfig,
) -> Result<Vec<latte_work_protocol::AgentSlashCommand>> {
    if agent == "opencode" {
        return agents::opencode_commands(binary, path, config).await;
    }
    let mut adapter = agents::create(agent)?;
    let start = adapter.advance(Input::DiscoverCommands)?;
    let mut prepared = adapter.command(binary, path, None, config)?;
    let child = prepared
        .command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()
        .context("无法启动 Agent 读取命令列表")?;
    let pid = child.id().context("Agent PID missing")? as i32;
    let mut group = Group { child, pid };
    let mut input = group.child.stdin.take().context("Agent stdin missing")?;
    let mut output = FramedRead::new(
        group.child.stdout.take().context("Agent stdout missing")?,
        LinesCodec::new_with_max_length(1024 * 1024),
    );
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        for action in start {
            match action {
                Action::Write(bytes) => write(&mut input, &bytes).await?,
                _ => bail!("Agent 不支持命令发现"),
            }
        }
        for _ in 0..128 {
            let line = output
                .next()
                .await
                .context("Agent 在返回命令列表前退出")??;
            for action in adapter.advance(Input::Message(&line))? {
                match action {
                    Action::Commands(commands) => return Ok(commands),
                    // Discovery may reject control requests, but never approve tools.
                    Action::Write(bytes) => write(&mut input, &bytes).await?,
                    _ => bail!("命令发现期间 Agent 请求执行任务"),
                }
            }
        }
        bail!("Agent 命令发现消息超出限制")
    })
    .await;
    let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    let _ = group.child.wait().await;
    result.context("读取 Agent 命令超时，请重试")?
}

#[cfg(test)]
mod per_turn_tests;

#[cfg(test)]
#[path = "runtime_auxiliary_tests.rs"]
mod auxiliary_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn auxiliary_close_barrier_runs_before_native_pid_is_reaped() {
        for (command, expect_clean_exit, expected) in [
            ("exec sleep 60", false, true),
            ("exit 0", true, true),
            ("exit 17", true, false),
        ] {
            let child = tokio::process::Command::new("/bin/sh")
                .args(["-c", command])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .process_group(0)
                .spawn()
                .unwrap();
            let pid = i32::try_from(child.id().unwrap()).unwrap();
            let mut group = Group { child, pid };
            let owned_during_barrier = Arc::new(AtomicBool::new(false));
            let observed = owned_during_barrier.clone();
            let confirmed = close_group(
                &mut group,
                tokio::time::Instant::now() + Duration::from_secs(5),
                expect_clean_exit,
                async move {
                    observed.store(
                        nix::sys::signal::kill(Pid::from_raw(pid), None).is_ok(),
                        Ordering::SeqCst,
                    );
                    true
                },
            )
            .await;
            assert_eq!(confirmed, expected);
            assert!(
                owned_during_barrier.load(Ordering::SeqCst),
                "auxiliary await must not retain a reusable native PID"
            );
            assert!(group.child.id().is_none());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn close_confirmation_budget_includes_waiting_to_send_control() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let runs: Runs = Arc::default();
        let (control, _receive) = mpsc::channel(1);
        let (reply, _response) = oneshot::channel();
        control
            .try_send(Control::TitleContext { reply })
            .ok()
            .unwrap();
        runs.lock().unwrap().insert(
            session.id.clone(),
            Run {
                control,
                safe_to_close: Arc::new(AtomicBool::new(true)),
                session_open: Arc::new(AtomicBool::new(false)),
            },
        );
        let result = tokio::time::timeout(
            Duration::from_secs(6),
            close(&database, &runs, &session.id, false),
        )
        .await;
        assert!(
            result.is_ok(),
            "close must bound the control-queue wait too"
        );
        assert!(result.unwrap().is_err(), "no actor acknowledged closure");
    }

    #[tokio::test]
    async fn send_reply_preserves_terminal_rejection_and_full_channel_checks_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let runs: Runs = Arc::default();
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("claude", None, None)
            .unwrap();
        let (control, mut receive) = mpsc::channel(1);
        runs.lock().unwrap().insert(
            session.id.clone(),
            Run {
                control: control.clone(),
                safe_to_close: Arc::new(AtomicBool::new(true)),
                session_open: Arc::new(AtomicBool::new(false)),
            },
        );
        let responder = tokio::spawn(async move {
            let Some(Control::Send {
                turn,
                admission,
                reply,
                ..
            }) = receive.recv().await
            else {
                panic!("send control");
            };
            let error = reject_send(&admission, &turn.request_id, "明确拒绝".into());
            reply.send(Err(error)).unwrap();
            receive
        });
        let make_turn = |id: &str| SendTurn {
            request_id: id.into(),
            text: "once".into(),
            model: None,
            fingerprint: None,
            config: config.clone(),
        };
        let first = submit(
            database.clone(),
            runs.clone(),
            "/missing/cli".into(),
            session.clone(),
            dir.path().to_string_lossy().into_owned(),
            make_turn("rejected"),
            false,
        )
        .await;
        assert!(first.unwrap_err().is::<SendNotAdmitted>());
        let _receive = responder.await.unwrap();
        let (reply, _response) = oneshot::channel();
        control
            .try_send(Control::TitleContext { reply })
            .ok()
            .unwrap();
        db(&database, |s| {
            s.begin(&session.id, "accepted", "once", None, None, None, None)
        })
        .unwrap();
        for (id, not_admitted) in [("fresh", true), ("accepted", false)] {
            let result = submit(
                database.clone(),
                runs.clone(),
                "/missing/cli".into(),
                session.clone(),
                dir.path().to_string_lossy().into_owned(),
                make_turn(id),
                false,
            )
            .await;
            assert_eq!(result.unwrap_err().is::<SendNotAdmitted>(), not_admitted);
        }
        assert!(db(&database, |s| s.request_identity_absent("fresh")).unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn queued_admission_timeout_keeps_old_continuation_and_same_id_full_rejection_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let runs: Runs = Arc::default();
        let (control, mut queued) = mpsc::channel(1);
        runs.lock().unwrap().insert(
            session.id.clone(),
            Run {
                control,
                safe_to_close: Arc::new(AtomicBool::new(true)),
                session_open: Arc::new(AtomicBool::new(false)),
            },
        );
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("claude", None, None)
            .unwrap();
        let result = submit(
            database.clone(),
            runs.clone(),
            "/missing/cli".into(),
            session.clone(),
            dir.path().to_string_lossy().into_owned(),
            SendTurn {
                request_id: "delayed".into(),
                text: "once".into(),
                model: None,
                fingerprint: None,
                config: config.clone(),
            },
            false,
        )
        .await;
        assert!(result.unwrap_err().is::<AdmissionUnknown>());
        assert!(db(&database, |s| s.request_identity_absent("delayed")).unwrap());
        // The timed-out attempt still occupies the actor channel and can admit.
        let retry = submit(
            database.clone(),
            runs,
            "/missing/cli".into(),
            session.clone(),
            dir.path().to_string_lossy().into_owned(),
            SendTurn {
                request_id: "delayed".into(),
                text: "once".into(),
                model: None,
                fingerprint: None,
                config,
            },
            false,
        )
        .await
        .unwrap_err();
        assert!(
            !retry.is::<SendNotAdmitted>(),
            "old continuation still admits: {retry:#}"
        );
        let Control::Send {
            turn,
            admission,
            reply,
            ..
        } = queued.recv().await.unwrap()
        else {
            panic!("queued send");
        };
        assert!(reply.is_closed());
        assert_eq!(crate::admission::active(&database, "delayed"), 1);
        db(&database, |s| {
            s.begin(
                &session.id,
                &turn.request_id,
                &turn.text,
                None,
                None,
                None,
                None,
            )
        })
        .unwrap();
        assert!(
            db(&database, |s| s.already_accepted(
                &session.id,
                "delayed",
                "once",
                None,
                None,
                None,
                None
            ))
            .unwrap()
        );
        assert_eq!(
            db(&database, |s| s.events(&session.id, 0.0))
                .unwrap()
                .0
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1
        );
        drop(admission);
        assert_eq!(crate::admission::active(&database, "delayed"), 0);
    }

    #[tokio::test]
    async fn failed_native_reap_blocks_every_replacement_spawn_until_reconciled() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "opencode".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        db(&database, |s| {
            s.record_unconfirmed_agent_close(&session.id, CLOSE_PENDING)
        })
        .unwrap();
        assert!(finish_native_close(&database, &session.id, false).is_err());
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("opencode", None, None)
            .unwrap();
        // A saved native session would make launch probe the recorded
        // directory first; an unconfirmed close must gate even that helper.
        let mut saved = db(&database, |s| s.session(&session.id)).unwrap();
        saved.native_id = Some("ses_reaping".into());
        db(&database, |s| s.save(&saved)).unwrap();
        let probe = dir.path().join("probe.sh");
        std::fs::write(
            &probe,
            "#!/bin/sh\necho ran >> \"$0.log\"\necho '{\"info\":{\"id\":\"ses_reaping\",\"location\":{\"directory\":\"/\"}},\"messages\":[]}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).unwrap();
        for _ in 0..2 {
            let result = Process::launch(
                &database,
                probe.to_string_lossy().as_ref(),
                &session,
                dir.path().to_str().unwrap(),
                config.clone(),
                Arc::new(AtomicBool::new(false)),
                None,
            )
            .await;
            assert!(matches!(result, Err(error) if error.to_string() == CLOSE_PENDING));
        }
        assert!(
            !dir.path().join("probe.sh.log").exists(),
            "the export probe never runs while the close is unconfirmed"
        );
        assert!(
            db(&database, |s| s.unconfirmed_agent_close(&session.id))
                .unwrap()
                .is_some()
        );
        assert!(
            db(&database, |s| s.events(&session.id, 0.0))
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn managed_project_pages_include_processless_actors_and_keep_a_stable_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("state.sqlite")).unwrap();
        let project = store.add_project(directory.path()).unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let other = store.add_project(other_dir.path()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let runs: Runs = Arc::default();
        let mut receivers = Vec::new();
        let mut expected = Vec::new();
        for n in 0..66 {
            let project_id = if n == 65 { &other.id } else { &project.id };
            let session = db(&database, |store| {
                store.create_session(project_id.clone(), "codex".into())
            })
            .unwrap();
            if n != 65 {
                expected.push(session.id.clone());
            }
            let (control, receive) = mpsc::channel(1);
            receivers.push(receive);
            runs.lock().unwrap().insert(
                session.id,
                Run {
                    control,
                    safe_to_close: Arc::new(AtomicBool::new(true)),
                    session_open: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        expected.sort();
        let mut page = project_agent_sessions(&database, &runs, &project.id, None).unwrap();
        project_session_state(&runs, &mut page).unwrap();
        let Response::ProjectAgentSessions {
            sessions,
            next: Some(cursor),
        } = page
        else {
            panic!("first page");
        };
        assert_eq!(sessions.len(), 64);
        assert!(sessions.iter().all(|s| s.agent_session_open == Some(false)));
        assert_eq!(cursor, expected[63]);
        runs.lock().unwrap().remove(&cursor);
        let Response::ProjectAgentSessions {
            sessions,
            next: None,
        } = project_agent_sessions(&database, &runs, &project.id, Some(&cursor)).unwrap()
        else {
            panic!("last page");
        };
        assert_eq!(
            sessions.iter().map(|s| &s.id).collect::<Vec<_>>(),
            vec![&expected[64]]
        );
    }
    #[test]
    fn durable_admission_acknowledges_before_slow_snapshot_preparation() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .start_paused(true)
            .build()
            .unwrap();
        runtime.block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
            let project = store.add_project(root.path()).unwrap();
            let session = store.create_session(project.id, "claude".into()).unwrap();
            let database = Arc::new(Mutex::new(store));
            let runs = Arc::new(Mutex::new(HashMap::new()));
            // Saturate Tokio's filesystem worker without sleeping or touching a
            // real Agent. Snapshot preparation must wait until this is released.
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = blocked.recv();
            });
            let operation = tokio::spawn(submit(
                database.clone(),
                runs,
                dir.path().join("missing-cli").to_string_lossy().into_owned(),
                session.clone(),
                root.path().to_string_lossy().into_owned(),
                SendTurn {
                    request_id: "slow-preparation".into(),
                    text: "已提交的消息".into(),
                    model: None,
                    fingerprint: None,
                    config: LaunchConfig {
                        environment: Default::default(),
                        traex_model: None,
                        provider: None,
                        model: None,
                        effort: None,
                        permission_mode: None,
                        settings_dir: dir.path().into(),
                    },
                },
                true,
            ));
            for _ in 0..1000 {
                if db(&database, |s| Ok(s.session(&session.id)?.status == Status::Running)).unwrap() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            let saved = db(&database, |s| s.events(&session.id, 0.0)).unwrap().0;
            assert!(saved.iter().any(|e| matches!(&e.event, EventKind::User {request_id, ..} if request_id=="slow-preparation")));
            assert!(db(&database, |s| s.baseline(&session.id)).unwrap().is_none());
            tokio::time::advance(Duration::from_secs(11)).await;
            let result = operation.await.unwrap();
            drop(release);
            blocker.await.unwrap();
            assert!(
                matches!(result, Ok(Response::Accepted {duplicate: false})),
                "{result:?}"
            );
        });
    }
    #[tokio::test]
    async fn admitted_startup_failure_is_terminal_and_duplicate_never_replays() {
        let dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(root.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let make_turn = || SendTurn {
            request_id: "startup-failure".into(),
            text: "accepted".into(),
            model: None,
            fingerprint: None,
            config: LaunchConfig {
                environment: Default::default(),
                traex_model: None,
                provider: None,
                model: None,
                effort: None,
                permission_mode: None,
                settings_dir: dir.path().into(),
            },
        };
        let mut process = None;
        let mut admitted = false;
        let path = root.path().to_string_lossy();
        let open = Arc::new(AtomicBool::new(false));
        assert!(
            accept_turn(
                &mut process,
                &database,
                "/missing/claude",
                &session,
                &path,
                make_turn(),
                &open,
                Some(&Guard::reserve(&database, "startup-failure").unwrap()),
                || admitted = true
            )
            .await
            .unwrap()
        );
        assert!(admitted);
        assert_eq!(
            db(&database, |s| Ok(s.session(&session.id)?.status)).unwrap(),
            Status::Failed
        );
        let before = db(&database, |s| s.events(&session.id, 0.0))
            .unwrap()
            .0
            .len();
        assert!(
            !accept_turn(
                &mut process,
                &database,
                "/missing/claude",
                &session,
                &path,
                make_turn(),
                &open,
                Some(&Guard::reserve(&database, "startup-failure").unwrap()),
                || panic!("duplicate must not be newly admitted")
            )
            .await
            .unwrap()
        );
        assert_eq!(
            db(&database, |s| s.events(&session.id, 0.0))
                .unwrap()
                .0
                .len(),
            before
        );
        db(&database, |s| s.state(&session.id, Status::Running, None)).unwrap();
        let mut next = make_turn();
        next.request_id = "busy".into();
        assert!(
            accept_turn(
                &mut process,
                &database,
                "/missing/claude",
                &session,
                &path,
                next,
                &open,
                Some(&Guard::reserve(&database, "busy").unwrap()),
                || panic!("rejected input must not be acknowledged")
            )
            .await
            .unwrap_err()
            .is::<SendNotAdmitted>()
        );
    }

    #[tokio::test]
    async fn streaming_redaction_masks_pending_prefixes_at_content_and_turn_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config(
                "claude",
                None,
                Some(latte_work_protocol::TurnProvider::Configured {
                    provider: None,
                    environment: latte_work_protocol::AgentEnvironment(
                        std::collections::BTreeMap::from([
                            ("TOKEN".into(), "text".into()),
                            ("SECRET".into(), "fixture-environment-secret".into()),
                        ]),
                    ),
                }),
            )
            .unwrap();
        let (mut input, _reader) = tokio::io::duplex(1024);
        let mut state = TurnState::default();
        let actions = vec![
            Action::Event(EventKind::Text {
                text: "before fixture-environment-".into(),
            }),
            Action::Event(EventKind::Progress {
                phase: latte_work_protocol::ExecutionPhase::Thinking,
            }),
            Action::Event(EventKind::Text {
                text: "secret after fixture-".into(),
            }),
            Action::Event(EventKind::Tool {
                id: "text".into(),
                name: "text".into(),
                input: Value::Null,
            }),
            Action::Event(EventKind::Text {
                text: "safe fi".into(),
            }),
            Action::Finished {
                failed: false,
                message: None,
            },
        ];
        assert_eq!(
            state
                .apply(actions, &mut input, &database, &session.id, &config)
                .await
                .unwrap(),
            Some((Status::Completed, None))
        );
        let (events, _) = db(&database, |s| s.events(&session.id, 0.0)).unwrap();
        let text: String = events
            .iter()
            .filter_map(|e| match &e.event {
                EventKind::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "before [redacted] after [redacted]safe [redacted]");
        assert!(state.text_tails.is_empty());
    }

    #[tokio::test]
    async fn generated_titles_redact_credentials_and_preserve_identity_and_manual_names() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("titles.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "traex".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let config = LaunchConfig {
            environment: Default::default(),
            traex_model: None, model: None, effort: None, permission_mode: None,
            settings_dir: dir.path().into(),
            provider: Some(crate::providers::ResolvedProvider {
                metadata: serde_json::from_value(serde_json::json!({"id":"fixture","name":"Fixture","protocol":"openai_responses","base_url":"http://localhost:8000/v1","model":"test","auth":"bearer","has_credential":true})).unwrap(),
                credential: "private-token".into(),
            }),
        };
        let mut state = TurnState::default();
        let mut sink = tokio::io::sink();
        state
            .apply(
                vec![Action::NativeSession("current".into())],
                &mut sink,
                &database,
                &session.id,
                &config,
            )
            .await
            .unwrap();
        for (native, title, expected) in [
            ("stale", "wrong", "新任务"),
            ("current", "Fix private-token", "Fix [redacted]"),
        ] {
            state
                .apply(
                    vec![Action::GeneratedTitle {
                        native_session_id: native.into(),
                        title: title.into(),
                    }],
                    &mut sink,
                    &database,
                    &session.id,
                    &config,
                )
                .await
                .unwrap();
            assert_eq!(
                db(&database, |s| s.session(&session.id)).unwrap().title,
                expected
            );
        }
        db(&database, |s| s.rename_session(&session.id, "Manual")).unwrap();
        state
            .apply(
                vec![Action::GeneratedTitle {
                    native_session_id: "current".into(),
                    title: "Late".into(),
                }],
                &mut sink,
                &database,
                &session.id,
                &config,
            )
            .await
            .unwrap();
        assert_eq!(
            db(&database, |s| s.session(&session.id)).unwrap().title,
            "Manual"
        );
    }

    #[tokio::test]
    async fn title_requested_marks_the_session_without_finishing_the_turn() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("title-requests.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let database = Arc::new(Mutex::new(store));
        let config = LaunchConfig {
            environment: Default::default(),
            traex_model: None,
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            settings_dir: dir.path().into(),
        };
        let mut state = TurnState::default();
        let mut sink = tokio::io::sink();
        for _ in 0..2 {
            assert_eq!(
                state
                    .apply(
                        vec![Action::TitleRequested],
                        &mut sink,
                        &database,
                        &session.id,
                        &config,
                    )
                    .await
                    .unwrap(),
                None,
                "recording the marker never finishes a turn"
            );
            assert!(
                db(&database, |s| s.session(&session.id))
                    .unwrap()
                    .title_requested
            );
        }
    }

    #[tokio::test]
    async fn optional_metadata_write_failure_preserves_successful_completion() {
        let dir = tempfile::tempdir().unwrap();
        let database = Arc::new(Mutex::new(
            Store::open(&dir.path().join("state.sqlite")).unwrap(),
        ));
        let config = LaunchConfig {
            environment: Default::default(),
            traex_model: None,
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            settings_dir: dir.path().into(),
        };
        let (mut writer, reader) = tokio::io::duplex(1024);
        drop(reader);
        let actions = vec![
            Action::MetadataWrite(b"metadata\n".to_vec()),
            Action::Finished {
                failed: false,
                message: None,
            },
        ];
        assert_eq!(
            TurnState::default()
                .apply(actions, &mut writer, &database, "unused", &config)
                .await
                .unwrap(),
            Some((Status::Completed, None))
        );
    }

    #[tokio::test]
    async fn native_output_keeps_large_fragmented_unicode_records_and_line_boundaries() {
        let expected = "帧🙂x".repeat(2 * 1024 * 1024 + 1);
        assert!(expected.len() > 16 * 1024 * 1024);
        let bytes = expected.clone().into_bytes();
        let (mut writer, reader) = tokio::io::duplex(65536);
        let task = tokio::spawn(async move {
            for part in bytes.chunks(4093) {
                writer.write_all(part).await.unwrap();
            }
            writer.write_all(b"\r\nnext\nfinal").await.unwrap();
        });
        let mut output = native_output(reader);
        let line = tokio::time::timeout(Duration::from_secs(10), output.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(line, expected);
        assert_eq!(output.next().await.unwrap().unwrap(), "next");
        assert_eq!(output.next().await.unwrap().unwrap(), "final");
        assert!(output.next().await.is_none());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn native_output_retains_partial_records_across_cancelled_reads_and_rejects_invalid_utf8()
    {
        let (mut writer, reader) = tokio::io::duplex(65536);
        let (release, resume) = tokio::sync::oneshot::channel();
        let (written, partial) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; 1024 * 1024 + 1])
                .await
                .unwrap();
            written.send(()).unwrap();
            resume.await.unwrap();
            writer.write_all(b"end\n\xff\n").await.unwrap();
        });
        let mut output = native_output(reader);
        // Poll a large incomplete record, then cancel only the read future.
        tokio::select! {
            _ = output.next() => panic!("incomplete record was emitted"),
            _ = partial => {}
        }
        release.send(()).unwrap();
        let line = output.next().await.unwrap().unwrap();
        assert_eq!(line, format!("{}end", "x".repeat(1024 * 1024 + 1)));
        assert!(output.next().await.unwrap().is_err());
        task.await.unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn late_handoffs_get_a_full_window_without_extending_earlier_inputs() {
        let start = tokio::time::Instant::now();
        let original_turn_deadline = start + TURN_LIMIT;
        tokio::time::advance(Duration::from_secs(23 * 3600)).await;
        let mut inputs = ForwardedInputs::default();
        inputs.insert("first".into());
        let first_deadline = inputs.deadline().unwrap();
        assert_eq!(first_deadline, start + Duration::from_secs(47 * 3600));
        tokio::time::advance(Duration::from_secs(2 * 3600)).await;
        assert!(tokio::time::Instant::now() > original_turn_deadline);
        assert!(tokio::time::Instant::now() < inputs.deadline().unwrap());
        inputs.insert("second".into());
        assert_eq!(inputs.deadline(), Some(first_deadline));
        inputs.remove("first");
        assert_eq!(
            inputs.deadline(),
            Some(start + Duration::from_secs(49 * 3600))
        );
        inputs.clear();
        assert_eq!(inputs.deadline(), None);
    }
    #[tokio::test]
    async fn archive_waits_for_close_confirmation_and_preserves_metadata_on_failure() {
        for succeeds in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut store = Store::open(&dir.path().join("state.sqlite")).unwrap();
            let project = store.add_project(dir.path()).unwrap();
            let session = store.create_session(project.id, "claude".into()).unwrap();
            store.state(&session.id, Status::Completed, None).unwrap();
            store.pin_session(&session.id, true).unwrap();
            let database = Arc::new(Mutex::new(store));
            let (control, mut controls) = mpsc::channel(1);
            let runs = Arc::new(Mutex::new(HashMap::from([(
                session.id.clone(),
                Run {
                    control,
                    safe_to_close: Arc::new(AtomicBool::new(true)),
                    session_open: Arc::new(AtomicBool::new(true)),
                },
            )])));
            let id = session.id.clone();
            let db_clone = database.clone();
            let runs_clone = runs.clone();
            let operation =
                tokio::spawn(async move { archive(&db_clone, &runs_clone, &id, true).await });
            let Some(Control::Cancel {
                reply: Some(reply),
                only_if_idle: false,
            }) = controls.recv().await
            else {
                panic!("archive must close native session first");
            };
            let before = db(&database, |s| s.session(&session.id)).unwrap();
            assert!(!before.archived && before.pinned_at.is_some());
            assert!(!operation.is_finished());
            if succeeds {
                runs.lock().unwrap().remove(&session.id);
                reply.send(Ok(())).unwrap();
            } else {
                reply.send(Err("fixture close failed".into())).unwrap();
            }
            let result = operation.await.unwrap();
            assert_eq!(result.is_ok(), succeeds);
            let after = db(&database, |s| s.session(&session.id)).unwrap();
            assert_eq!(after.archived, succeeds);
            assert_eq!(after.pinned_at.is_none(), succeeds);
            assert_eq!(after.status, Status::Completed);
        }
    }
    #[tokio::test]
    async fn archived_sessions_cannot_allocate_an_actor_through_any_admission() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store.archive_session(&session.id, true).unwrap();
        // Also reject a caller holding a stale, unarchived metadata snapshot.
        let database = Arc::new(Mutex::new(store));
        let runs = Arc::new(Mutex::new(HashMap::new()));
        assert!(
            control_for(
                database,
                runs.clone(),
                "must-not-launch".into(),
                session,
                dir.path().to_string_lossy().into_owned()
            )
            .is_err()
        );
        assert!(runs.lock().unwrap().is_empty());
    }
    #[test]
    fn closed_title_refresh_is_debounced_per_native_identity_and_memory_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("titles.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let mut session = store.create_session(project.id, "claude".into()).unwrap();
        let mut cache = TitleRefreshCache::default();
        let now = Instant::now();
        assert!(!cache.claim(&session, now));
        session.native_id = Some("native-1".into());
        assert!(cache.claim(&session, now));
        assert!(!cache.claim(&session, now + Duration::from_millis(650)));
        assert!(cache.claim(&session, now + TitleRefreshCache::INTERVAL));
        session.native_id = Some("native-2".into());
        assert!(cache.claim(&session, now + TitleRefreshCache::INTERVAL));
        for i in 0..TitleRefreshCache::LIMIT + 5 {
            session.id = format!("session-{i}");
            cache.claim(&session, now + TitleRefreshCache::INTERVAL);
        }
        assert_eq!(cache.reads.len(), TitleRefreshCache::LIMIT);
        assert!(cache.claim(&session, now + TitleRefreshCache::INTERVAL * 2));
    }
    #[test]
    fn bounded_title_refresh_reaches_later_rows_even_when_polls_are_slow() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("titles.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let mut session = store.create_session(project.id, "claude".into()).unwrap();
        session.native_id = Some("native".into());
        let sessions: Vec<_> = (0..40)
            .map(|i| {
                let mut s = session.clone();
                s.id = i.to_string();
                s
            })
            .collect();
        let mut cache = TitleRefreshCache::default();
        let now = Instant::now();
        let mut seen = std::collections::HashSet::new();
        for i in 0..3 {
            let batch = cache.select(sessions.clone(), now + TitleRefreshCache::INTERVAL * i);
            assert!(batch.len() <= 16);
            seen.extend(batch.into_iter().map(|s| s.id));
        }
        assert_eq!(seen.len(), 40);
    }
    #[tokio::test]
    async fn actions_preserve_wire_bytes_and_ready_never_sends_an_implicit_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let database = Arc::new(Mutex::new(
            Store::open(&dir.path().join("state.sqlite")).unwrap(),
        ));
        let config = LaunchConfig {
            environment: Default::default(),
            traex_model: None,
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            settings_dir: dir.path().into(),
        };
        let (mut writer, mut reader) = tokio::io::duplex(1024);
        let mut state = TurnState::default();
        // Deliberately not JSON: Runtime must not encode or interpret an adapter's wire bytes.
        let actions = vec![
            Action::Write(b"first\n".to_vec()),
            Action::Ready,
            Action::Write(b"second\n".to_vec()),
        ];
        assert!(
            state
                .apply(actions, &mut writer, &database, "unused", &config)
                .await
                .unwrap()
                .is_none()
        );
        assert!(state.ready);
        drop(writer);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"first\nsecond\n");
        assert!(
            write(
                &mut tokio::io::sink(),
                &vec![0; latte_work_protocol::MAX_FRAME + 1]
            )
            .await
            .is_err()
        );
    }
}
