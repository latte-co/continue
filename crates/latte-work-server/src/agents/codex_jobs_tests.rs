use super::*;

fn gated(
    pool: &Arc<Registry>,
    scope: &str,
    kind: JobKind,
    gate: Arc<ReapGate>,
    outcome: Option<bool>,
) -> JobHandle<()> {
    pool.start(JobScope::session(scope), kind, move |owner| {
        Box::pin(async move {
            owner.test_gate = Some(gate);
            owner.spawn(test_command())?;
            match outcome {
                Some(true) => Ok(()),
                Some(false) => bail!("wire failure"),
                None => std::future::pending::<Result<()>>().await,
            }
        })
    })
    .unwrap()
}

#[tokio::test]
async fn second_spawn_is_rejected_without_replacing_owned_child() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let (pid_tx, pid_rx) = oneshot::channel();
    let handle = pool
        .start(
            JobScope::session("one-child"),
            JobKind::Title,
            move |owner| {
                Box::pin(async move {
                    let pid = owner.spawn(test_command())?.id().unwrap();
                    pid_tx.send(pid).unwrap();
                    let rejected = owner.spawn(test_command()).is_err();
                    Ok(rejected)
                })
            },
        )
        .unwrap();
    let pid = pid_rx.await.unwrap();
    assert!(handle.wait().await.unwrap());
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None),
        Err(nix::errno::Errno::ESRCH)
    );
}

#[tokio::test]
async fn spawned_child_setup_failure_is_reaped_before_error_completion() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let gate = ReapGate::new();
    let owner_gate = gate.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let handle = pool
        .start(JobScope::session("setup"), JobKind::Title, move |owner| {
            Box::pin(async move {
                owner.test_gate = Some(owner_gate);
                let child = owner.spawn(test_command())?;
                pid_tx.send(child.id().unwrap()).unwrap();
                // Test command intentionally has no piped stdout: same fallible
                // setup boundary as structured(), immediately after spawn.
                child.stdout.take().context("stdout setup failed")?;
                Ok(())
            })
        })
        .unwrap();
    let pid = pid_rx.await.unwrap();
    gate.entered.notified().await;
    assert_eq!(pool.execution.available_permits(), 1);
    gate.release.notify_one();
    assert!(
        handle
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("stdout setup failed")
    );
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None),
        Err(nix::errno::Errno::ESRCH)
    );
    assert!(pool.scope_confirmed(&JobScope::session("setup")));
}

#[tokio::test]
async fn cancelling_synchronously_registered_owner_before_poll_prevents_launch() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let handle = pool
        .start(JobScope::session("session"), JobKind::Prediction, |_| {
            Box::pin(async { Err::<(), _>(anyhow::anyhow!("unexpected launch")) })
        })
        .unwrap();
    assert!(!pool.scope_confirmed(&JobScope::session("session")));
    pool.cancel_scope(&JobScope::session("session"));
    assert!(
        handle
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("取消")
    );
    assert!(pool.scope_confirmed(&JobScope::session("session")));
}

#[tokio::test]
async fn normal_and_error_results_only_publish_after_cleanup() {
    for outcome in [true, false] {
        let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
        let gate = ReapGate::new();
        let mut handle = gated(
            &pool,
            "session",
            JobKind::Title,
            gate.clone(),
            Some(outcome),
        );
        gate.entered.notified().await;
        assert_eq!(pool.execution.available_permits(), 1);
        assert_eq!(pool.titles.available_permits(), 7);
        assert!(!handle.wait_cleanup(Duration::from_millis(5)).await);
        assert!(
            !pool
                .wait_scope(&JobScope::session("session"), Duration::from_millis(5))
                .await
        );
        gate.release.notify_one();
        assert_eq!(handle.wait().await.is_ok(), outcome);
        assert!(pool.scope_confirmed(&JobScope::session("session")));
        assert_eq!(pool.execution.available_permits(), 2);
    }
}

#[tokio::test]
async fn execution_timer_does_not_destroy_cleanup_and_observer_timeout_only_cancels() {
    for observer_timeout in [false, true] {
        let pool = Registry::new(Duration::from_secs(150), Duration::from_millis(20));
        let gate = ReapGate::new();
        let handle = gated(&pool, "session", JobKind::Prediction, gate.clone(), None);
        gate.started.notified().await;
        let observer = tokio::spawn(async move {
            if observer_timeout {
                tokio::time::timeout(Duration::from_millis(2), handle.wait())
                    .await
                    .map_err(anyhow::Error::from)?
            } else {
                handle.wait().await
            }
        });
        gate.entered.notified().await;
        assert_eq!(pool.execution.available_permits(), 1);
        assert!(!pool.scope_confirmed(&JobScope::session("session")));
        gate.release.notify_one();
        assert!(observer.await.unwrap().is_err());
        assert!(pool.wait_drained(Duration::from_secs(2)).await);
        assert_eq!(pool.execution.available_permits(), 2);
    }
}

#[tokio::test]
async fn bounded_registry_counts_waiting_active_and_cleanup_and_drain_fences_admission() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let gates: Vec<_> = (0..2).map(|_| ReapGate::new()).collect();
    let mut handles: Vec<_> = gates
        .iter()
        .map(|gate| gated(&pool, "session", JobKind::Title, gate.clone(), Some(true)))
        .collect();
    for gate in &gates {
        gate.entered.notified().await;
    }
    for _ in 0..6 {
        handles.push(
            pool.start(JobScope::session("session"), JobKind::Title, |_| {
                Box::pin(async { Ok(()) })
            })
            .unwrap(),
        );
    }
    assert_eq!(pool.inventory().len(), 8);
    assert!(
        pool.start(JobScope::session("session"), JobKind::Title, |_| Box::pin(
            async { Ok(()) }
        ))
        .is_err()
    );
    assert!(
        pool.start(JobScope::session("session"), JobKind::Prediction, |_| {
            Box::pin(async { Ok(()) })
        })
        .is_err()
    );
    pool.begin_drain();
    assert!(
        pool.start(JobScope::session("foreign"), JobKind::Title, |_| Box::pin(
            async { Ok(()) }
        ))
        .is_err()
    );
    assert!(!pool.wait_drained(Duration::from_millis(5)).await);
    assert_eq!(pool.execution.available_permits(), 0);
    for gate in gates {
        gate.release.notify_one();
    }
    for handle in handles {
        let result = handle.wait().await;
        assert!(result.is_ok() || result.unwrap_err().to_string().contains("取消"));
    }
    assert!(pool.wait_drained(Duration::from_secs(2)).await);
    assert_eq!(pool.titles.available_permits(), 8);
}

#[tokio::test]
async fn kind_cancellation_preserves_other_scope_and_title() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let title_gate = ReapGate::new();
    let prediction_gate = ReapGate::new();
    let title = gated(&pool, "same", JobKind::Title, title_gate.clone(), None);
    let prediction = gated(
        &pool,
        "same",
        JobKind::Prediction,
        prediction_gate.clone(),
        None,
    );
    title_gate.started.notified().await;
    prediction_gate.started.notified().await;
    pool.cancel_predictions("foreign");
    pool.cancel_predictions("same");
    prediction_gate.entered.notified().await;
    assert!(
        !pool
            .wait_predictions("same", Duration::from_millis(5))
            .await
    );
    assert!(
        pool.wait_predictions("foreign", Duration::from_millis(5))
            .await
    );
    assert_eq!(pool.inventory().len(), 2);
    assert_eq!(pool.execution.available_permits(), 0);
    prediction_gate.release.notify_one();
    assert!(
        prediction
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("取消")
    );
    assert!(!pool.scope_confirmed(&JobScope::session("same")));
    assert!(
        pool.wait_predictions("same", Duration::from_millis(5))
            .await
    );
    pool.cancel_titles("same");
    title_gate.entered.notified().await;
    title_gate.release.notify_one();
    assert!(title.wait().await.is_err());
}

#[tokio::test]
async fn failed_group_signal_after_direct_reap_never_resignals_or_releases_slots() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let gate = ReapGate::new();
    gate.kill_errors
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let owner_gate = gate.clone();
    let handle = pool
        .start(
            JobScope::session("unconfirmed"),
            JobKind::Title,
            move |owner| {
                Box::pin(async move {
                    owner.test_gate = Some(owner_gate);
                    let mut command = tokio::process::Command::new("/bin/sh");
                    command.args(["-c", "exit 0"]);
                    owner.spawn(command)?;
                    Ok(())
                })
            },
        )
        .unwrap();
    gate.entered.notified().await;
    gate.release.notify_one();
    let confirmed = pool
        .wait_scope(
            &JobScope::session("unconfirmed"),
            Duration::from_millis(250),
        )
        .await;
    assert!(
        !confirmed,
        "wait success alone must not erase a failed process-group signal"
    );
    assert_eq!(
        gate.kill_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "never signal a possibly reused PGID after direct reap"
    );
    assert_eq!(pool.execution.available_permits(), 1);
    assert_eq!(pool.titles.available_permits(), 7);
    assert!(pool.inventory()[0].cleanup_error);
    drop(handle); // Requests cancel only; owner remains until runtime teardown.
}

#[tokio::test]
async fn confirmed_group_signal_wait_failure_retries_only_wait_and_preserves_error() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let gate = ReapGate::new();
    gate.wait_errors
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let handle = gated(&pool, "session", JobKind::Title, gate.clone(), Some(true));
    gate.entered.notified().await;
    gate.release.notify_one();
    // Inventory update precedes retry sleep, so wait for that exact evidence.
    loop {
        if pool.inventory().iter().any(|entry| entry.cleanup_error) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(pool.execution.available_permits(), 1);
    assert_eq!(pool.titles.available_permits(), 7);
    let error = format!("{:#}", handle.wait().await.unwrap_err());
    assert!(error.contains("wait failure"));
    assert_eq!(
        gate.kill_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "a confirmed kill must never be repeated after a failed wait"
    );
    assert!(pool.scope_confirmed(&JobScope::session("session")));
}

#[tokio::test]
async fn actual_semaphore_poll_fifo_cannot_be_overtaken_by_try_prediction() {
    use std::task::{Context, Poll};
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let one = pool.execution.clone().try_acquire_owned().unwrap();
    let two = pool.execution.clone().try_acquire_owned().unwrap();
    let mut first = Box::pin(pool.execution.clone().acquire_owned());
    let mut second = Box::pin(pool.execution.clone().acquire_owned());
    let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
    assert!(first.as_mut().poll(&mut context).is_pending());
    assert!(second.as_mut().poll(&mut context).is_pending());
    drop(one);
    assert!(pool.execution.clone().try_acquire_owned().is_err());
    assert!(second.as_mut().poll(&mut context).is_pending());
    let Poll::Ready(Ok(first)) = first.as_mut().poll(&mut context) else {
        panic!("first waiter");
    };
    drop(two);
    let Poll::Ready(Ok(second)) = second.as_mut().poll(&mut context) else {
        panic!("second waiter");
    };
    drop((first, second));
    assert_eq!(pool.execution.available_permits(), 2);
}

#[tokio::test]
async fn queued_title_timeout_and_cancellation_never_spawn_child() {
    let pool = Registry::new(Duration::from_millis(10), Duration::from_secs(30));
    let one = pool.execution.clone().try_acquire_owned().unwrap();
    let two = pool.execution.clone().try_acquire_owned().unwrap();
    let timed_out = pool
        .start(JobScope::session("timeout"), JobKind::Title, |_| {
            Box::pin(async { Err::<(), _>(anyhow::anyhow!("must not start")) })
        })
        .unwrap();
    assert!(
        timed_out
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("等待超时")
    );
    let cancelled = pool
        .start(JobScope::session("cancel"), JobKind::Title, |_| {
            Box::pin(async { Err::<(), _>(anyhow::anyhow!("must not start")) })
        })
        .unwrap();
    pool.cancel_scope(&JobScope::session("cancel"));
    assert!(
        cancelled
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("取消")
    );
    assert_eq!(pool.titles.available_permits(), 8);
    assert!(pool.inventory().is_empty());
    drop((one, two));
}

#[tokio::test]
async fn caller_abort_keeps_execution_and_inventory_until_reap_confirmed() {
    let pool = Registry::new(Duration::from_secs(150), Duration::from_secs(30));
    let gate = ReapGate::new();
    let owner_gate = gate.clone();
    let handle = pool
        .start(
            JobScope::session("session"),
            JobKind::Prediction,
            move |owner| {
                Box::pin(async move {
                    owner.test_gate = Some(owner_gate);
                    owner.spawn(test_command())?;
                    std::future::pending::<Result<()>>().await
                })
            },
        )
        .unwrap();
    let observer = tokio::spawn(handle.wait());
    gate.started.notified().await;
    observer.abort();
    gate.entered.notified().await;
    assert!(!pool.scope_confirmed(&JobScope::session("session")));
    assert_eq!(pool.execution.available_permits(), 1);
    gate.release.notify_one();
    assert!(
        pool.wait_scope(&JobScope::session("session"), Duration::from_secs(2))
            .await
    );
    assert_eq!(pool.execution.available_permits(), 2);
    assert!(gate.confirmed.load(std::sync::atomic::Ordering::SeqCst));
}
