//! Runtime boundaries use real auxiliary owners, not simulated cleanup completion.
use super::*;
use crate::agents::codex_jobs::{self, JobKind, JobScope};

// Only these integration tests share the global pool; serialize them while all
// private-pool owner tests remain parallel. Session IDs come from fresh stores.
static GLOBAL_POOL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn setup() -> (tempfile::TempDir, Database, Session) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
    let project = store.add_project(dir.path()).unwrap();
    let session = store.create_session(project.id, "claude".into()).unwrap();
    (dir, Arc::new(Mutex::new(store)), session)
}

fn assert_pid_gone(pid: u32) {
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None),
        Err(nix::errno::Errno::ESRCH),
    );
}

#[tokio::test]
async fn prepared_per_turn_close_without_transport_waits_for_auxiliary_owner() {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = per_turn_tests::context();
    let mut process = per_turn_tests::prepared(&dir, &database, &session, config, "exit 0");
    assert!(process.transport.is_none());
    let (owner, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let mut operation = tokio::spawn({
        let database = database.clone();
        let id = session.id.clone();
        async move { process.close_confirmed(&database, &id).await }
    });
    let entered = tokio::time::timeout(Duration::from_secs(1), gate.entered.notified()).await;
    if entered.is_err() {
        owner.request_cancel();
        gate.entered.notified().await;
    }
    let premature = tokio::time::timeout(Duration::from_millis(20), &mut operation).await;
    let acknowledged_early = premature.is_ok();
    let retained = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    gate.release.notify_one();
    assert!(owner.wait().await.is_err());
    let result = match premature {
        Ok(result) => result,
        Err(_) => operation.await,
    };
    assert!(result.unwrap().is_ok());
    assert!(
        entered.is_ok() && !acknowledged_early,
        "prepared host context is not owner cleanup evidence"
    );
    assert!(retained);
    assert_pid_gone(pid);
    assert!(
        db(&database, |store| store
            .unconfirmed_agent_close(&session.id))
        .unwrap()
        .is_none()
    );
}

#[tokio::test]
async fn prepared_per_turn_auxiliary_close_timeout_retains_unknown_and_owner_accounting() {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = per_turn_tests::context();
    let mut process = per_turn_tests::prepared(&dir, &database, &session, config, "exit 0");
    let (owner, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let operation = tokio::spawn({
        let database = database.clone();
        let id = session.id.clone();
        async move {
            let result = process.close_confirmed(&database, &id).await;
            (process, result)
        }
    });
    let entered = tokio::time::timeout(Duration::from_secs(1), gate.entered.notified()).await;
    if entered.is_err() {
        owner.request_cancel();
        gate.entered.notified().await;
    }
    let (process, result) = operation.await.unwrap();
    let unknown = db(&database, |store| {
        store.unconfirmed_agent_close(&session.id)
    })
    .unwrap();
    let retained = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    gate.release.notify_one();
    assert!(owner.wait().await.is_err());
    assert!(
        codex_jobs::registry()
            .wait_scope(&JobScope::session(&session.id), Duration::from_secs(2))
            .await
    );
    assert!(
        result.is_err(),
        "transport absence must not acknowledge an unconfirmed owner"
    );
    assert!(unknown.is_some() && retained);
    assert!(process.close_started);
    assert!(
        db(&database, |store| store
            .unconfirmed_agent_close(&session.id))
        .unwrap()
        .is_some(),
        "later owner reap cannot silently clear durable uncertainty"
    );
    assert_pid_gone(pid);
}

#[tokio::test]
async fn successful_per_turn_retirement_preserves_auxiliary_session_owners() {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = per_turn_tests::context();
    let mut process = per_turn_tests::prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\\nresult\\n'",
    );
    let (title, title_gate, title_pid) = codex_jobs::test_job(&session.id, JobKind::Title).unwrap();
    let (prediction, prediction_gate, prediction_pid) =
        codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let title_pid = title_pid.await.unwrap();
    let prediction_pid = prediction_pid.await.unwrap();
    per_turn_tests::start(&mut process, &database, &session).await;
    per_turn_tests::read_apply(&mut process, &database, &session).await;
    per_turn_tests::read_apply(&mut process, &database, &session).await;
    assert!(process.next_message().await.unwrap().is_none());
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        process.finish_per_turn(&database, &session.id),
    )
    .await;
    let retained = codex_jobs::registry()
        .inventory()
        .iter()
        .filter(|record| record.scope == JobScope::session(&session.id))
        .count();
    let title_cancelled =
        tokio::time::timeout(Duration::from_millis(20), title_gate.entered.notified())
            .await
            .is_ok();
    let prediction_cancelled = tokio::time::timeout(
        Duration::from_millis(20),
        prediction_gate.entered.notified(),
    )
    .await
    .is_ok();
    title.request_cancel();
    prediction.request_cancel();
    if !title_cancelled {
        title_gate.entered.notified().await;
    }
    if !prediction_cancelled {
        prediction_gate.entered.notified().await;
    }
    title_gate.release.notify_one();
    prediction_gate.release.notify_one();
    assert!(title.wait().await.is_err());
    assert!(prediction.wait().await.is_err());
    assert!(
        matches!(result, Ok(Ok(()))),
        "physical retirement must not wait for session owners: {result:?}"
    );
    assert_eq!(retained, 2);
    assert!(
        !title_cancelled && !prediction_cancelled,
        "a successful Cursor-style turn is not whole-session Close"
    );
    assert!(process.transport.is_none() && process.can_start_turn());
    assert_eq!(
        db(&database, |store| Ok(store.session(&session.id)?.status)).unwrap(),
        Status::Completed
    );
    process
        .close_confirmed(&database, &session.id)
        .await
        .unwrap();
    assert_pid_gone(title_pid);
    assert_pid_gone(prediction_pid);
}

#[tokio::test]
async fn close_without_actor_waits_for_registered_auxiliary_reap_before_success() {
    let _serial = GLOBAL_POOL.lock().await;
    let (_dir, database, session) = setup();
    let (handle, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let runs: Runs = Arc::default();
    let mut operation = tokio::spawn({
        let database = database.clone();
        let id = session.id.clone();
        async move { close(&database, &runs, &id, false).await }
    });
    let entered = tokio::time::timeout(Duration::from_secs(1), gate.entered.notified()).await;
    let premature = tokio::time::timeout(Duration::from_millis(10), &mut operation).await;
    if entered.is_err() {
        handle.request_cancel();
        gate.entered.notified().await;
    }
    gate.release.notify_one();
    assert!(
        codex_jobs::registry()
            .wait_scope(&JobScope::session(&session.id), Duration::from_secs(2))
            .await
    );
    assert!(handle.wait().await.is_err());
    assert!(
        entered.is_ok(),
        "close must cancel an owner even when the actor is gone"
    );
    assert!(
        premature.is_err(),
        "close acknowledged before direct-child reap"
    );
    assert!(
        !operation.await.unwrap().unwrap(),
        "there was no native actor to close"
    );
    assert_pid_gone(pid);
    assert!(
        db(&database, |store| store
            .unconfirmed_agent_close(&session.id))
        .unwrap()
        .is_none()
    );
}

fn codex_setup() -> (tempfile::TempDir, Database, Session, LaunchConfig) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
    let project = store.add_project(dir.path()).unwrap();
    let session = store.create_session(project.id, "codex".into()).unwrap();
    // Keep the fixture focused on main execution, without scheduling another title.
    store.mark_title_requested(&session.id).unwrap();
    let session = store.session(&session.id).unwrap();
    let config = LaunchConfig {
        environment: Default::default(),
        traex_model: None,
        provider: None,
        model: Some("codex-test".into()),
        effort: None,
        permission_mode: None,
        settings_dir: dir.path().join("settings"),
    };
    (dir, Arc::new(Mutex::new(store)), session, config)
}

fn fixture() -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/codex.py")
        .to_string_lossy()
        .into_owned()
}

fn send_turn(config: &LaunchConfig, request_id: &str, text: &str) -> SendTurn {
    SendTurn {
        request_id: request_id.into(),
        text: text.into(),
        model: config.model.clone(),
        fingerprint: None,
        config: config.clone(),
    }
}

async fn completed(database: &Database, id: &str) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let status = db(database, |store| Ok(store.session(id)?.status)).unwrap();
            if status == Status::Completed {
                return true;
            }
            if matches!(status, Status::Failed | Status::Unknown) {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or(false)
}

fn main_inputs(dir: &std::path::Path) -> Vec<serde_json::Value> {
    match std::fs::read_to_string(dir.join("codex-inputs")) {
        Ok(contents) => contents
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("read main fixture inputs: {error}"),
    }
}

#[tokio::test]
async fn durable_send_starts_and_completes_before_slow_prediction_reap() {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = codex_setup();
    // Occupy both optional execution slots; main Group must need neither slot.
    let (handle, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let (other, other_gate, other_pid) =
        codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let other_pid = other_pid.await.unwrap();
    let runs: Runs = Arc::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let started = tokio::time::Instant::now();
    let receipt = tokio::time::timeout(
        Duration::from_millis(250),
        submit(
            database.clone(),
            runs.clone(),
            fixture(),
            session.clone(),
            dir.path().to_string_lossy().into_owned(),
            send_turn(&config, &request_id, "slow-reap"),
            true,
        ),
    )
    .await;
    let entered = tokio::time::timeout(Duration::from_millis(250), gate.entered.notified()).await;
    // On RED, cancel explicitly so a failed assertion never strands a global slot.
    if entered.is_err() {
        handle.request_cancel();
        gate.entered.notified().await;
    }
    other_gate.entered.notified().await;
    let finished_before_reap = completed(&database, &session.id).await;
    let inputs_before_reap = main_inputs(dir.path());
    // Remain unconfirmed beyond the old production deadline, even on GREEN.
    tokio::time::sleep_until(started + Duration::from_millis(3250)).await;
    let status_after_deadline =
        db(&database, |store| Ok(store.session(&session.id)?.status)).unwrap();
    let duplicate = submit(
        database.clone(),
        runs.clone(),
        fixture(),
        session.clone(),
        dir.path().to_string_lossy().into_owned(),
        send_turn(&config, &request_id, "slow-reap"),
        true,
    )
    .await;
    let inputs_after_duplicate = main_inputs(dir.path());
    let followup_id = uuid::Uuid::new_v4().to_string();
    let followup = submit(
        database.clone(),
        runs.clone(),
        fixture(),
        session.clone(),
        dir.path().to_string_lossy().into_owned(),
        send_turn(&config, &followup_id, "same-config-followup"),
        true,
    )
    .await;
    let followup_finished = completed(&database, &session.id).await;
    let inventory = codex_jobs::registry().inventory();
    let still_owned = inventory
        .iter()
        .filter(|record| {
            record.scope == JobScope::session(&session.id) && record.kind == JobKind::Prediction
        })
        .count();
    // A newly admitted prediction must not reuse either unconfirmed owner's slot.
    let extra = codex_jobs::test_job(&uuid::Uuid::new_v4().to_string(), JobKind::Prediction);
    let slots_retained = extra.is_err();
    if let Ok((extra, extra_gate, extra_pid)) = extra {
        let extra_pid = extra_pid.await.unwrap();
        extra.request_cancel();
        extra_gate.entered.notified().await;
        extra_gate.release.notify_one();
        let _ = extra.wait().await;
        assert_pid_gone(extra_pid);
    }
    gate.release.notify_one();
    other_gate.release.notify_one();
    let owner_cancelled = handle.wait().await.is_err();
    let other_cancelled = other.wait().await.is_err();
    let owner_confirmed = codex_jobs::registry()
        .wait_predictions(&session.id, Duration::from_secs(2))
        .await;
    let closed = close(&database, &runs, &session.id, false).await;
    let events = db(&database, |store| store.events(&session.id, 0.0))
        .unwrap()
        .0;
    let inputs = main_inputs(dir.path());
    assert_pid_gone(pid);
    assert_pid_gone(other_pid);
    assert!(owner_cancelled && other_cancelled && owner_confirmed);
    assert!(closed.is_ok(), "fixture close: {closed:?}");
    assert!(
        matches!(receipt, Ok(Ok(Response::Accepted { duplicate: false }))),
        "durable receipt must not wait for reap: {receipt:?}"
    );
    assert!(
        entered.is_ok(),
        "admission must request cancellation without relying on a native actor"
    );
    assert!(
        finished_before_reap,
        "main must complete while prediction cleanup is unconfirmed: {events:?}"
    );
    assert_eq!(
        status_after_deadline,
        Status::Completed,
        "prediction cleanup must not fail accepted main execution"
    );
    assert!(
        matches!(duplicate, Ok(Response::Accepted { duplicate: true })),
        "same ID must reconcile without replay: {duplicate:?}"
    );
    assert_eq!(
        still_owned, 2,
        "both owners must remain in inventory until reap confirmation"
    );
    assert!(
        slots_retained,
        "cleanup must not release auxiliary execution permits early"
    );
    assert_eq!(
        inputs_before_reap.len(),
        1,
        "real fixture must receive Start before gate release"
    );
    assert_eq!(
        inputs_after_duplicate.len(),
        1,
        "duplicate must not send another native Start"
    );
    assert!(
        matches!(followup, Ok(Response::Accepted { duplicate: false })) && followup_finished,
        "retained same-config main must execute without waiting for auxiliary cleanup: {followup:?}"
    );
    assert_eq!(
        inputs.len(),
        2,
        "each distinct request must execute exactly once"
    );
    assert_eq!(inputs[0]["prompt"], "slow-reap");
    assert_eq!(inputs[1]["prompt"], "same-config-followup");
    assert_eq!(
        inputs[0]["pid"], inputs[1]["pid"],
        "same-config Send must not replace the native Group"
    );
    for expected in [&request_id, &followup_id] {
        assert_eq!(events.iter().filter(|event| matches!(&event.event, EventKind::User { request_id, .. } if request_id == expected)).count(), 1);
    }
    assert!(
        !events.iter().any(|event| matches!(
            &event.event,
            EventKind::State {
                status: Status::Failed,
                ..
            }
        )),
        "no cleanup-induced terminal failure: {events:?}"
    );
}

#[tokio::test]
async fn actual_send_does_not_cancel_or_wait_for_first_turn_title() {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = codex_setup();
    let (title, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Title).unwrap();
    let pid = pid.await.unwrap();
    let runs: Runs = Arc::default();
    let receipt = submit(
        database.clone(),
        runs.clone(),
        fixture(),
        session.clone(),
        dir.path().to_string_lossy().into_owned(),
        send_turn(&config, &uuid::Uuid::new_v4().to_string(), "title-only"),
        true,
    )
    .await;
    let finished = completed(&database, &session.id).await;
    let unexpectedly_cancelled =
        tokio::time::timeout(Duration::from_millis(20), gate.entered.notified())
            .await
            .is_ok();
    let title_preserved = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    let once_marker = db(&database, |store| {
        Ok(store.session(&session.id)?.title_requested)
    })
    .unwrap();
    let inputs = main_inputs(dir.path());
    let events = db(&database, |store| store.events(&session.id, 0.0))
        .unwrap()
        .0;
    title.request_cancel();
    if !unexpectedly_cancelled {
        gate.entered.notified().await;
    }
    gate.release.notify_one();
    let cancelled = title.wait().await.is_err();
    let closed = close(&database, &runs, &session.id, false).await;
    assert_pid_gone(pid);
    assert!(cancelled && closed.is_ok());
    assert!(matches!(
        receipt,
        Ok(Response::Accepted { duplicate: false })
    ));
    assert!(
        finished,
        "real Send must finish with the title owner still pending: {events:?}"
    );
    assert!(
        !unexpectedly_cancelled && title_preserved,
        "Send must not cancel title ownership"
    );
    assert!(
        once_marker,
        "Send must not reset the first-turn title marker"
    );
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0]["prompt"], "title-only");
}

async fn queue_runs_before_reap(explicit: bool) {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = codex_setup();
    let runs: Runs = Arc::default();
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    db(&database, |store| {
        store.pause_queue(&session.id, Some("test preparation"))?;
        store.enqueue(&session.id, &send_turn(&config, &first, "queue-first"))?;
        store.enqueue(&session.id, &send_turn(&config, &second, "queue-second"))
    })
    .unwrap();
    let (owner, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let first_revision = db(&database, |store| {
        Ok(store.queued(&session.id)?[0].0.revision)
    })
    .unwrap();
    let action = if explicit {
        QueueAction::Dispatch {
            interrupt: false,
            request_id: first.clone(),
            revision: first_revision,
            config: Box::new(config.clone()),
        }
    } else {
        QueueAction::Resume {
            configs: HashMap::from([
                (first.clone(), config.clone()),
                (second.clone(), config.clone()),
            ]),
        }
    };
    let receipt = tokio::time::timeout(
        Duration::from_secs(1),
        queue_action(
            database.clone(),
            runs.clone(),
            fixture(),
            session.clone(),
            dir.path().to_string_lossy().into_owned(),
            action,
        ),
    )
    .await;
    let entered = tokio::time::timeout(Duration::from_secs(1), gate.entered.notified()).await;
    if entered.is_err() {
        owner.request_cancel();
        gate.entered.notified().await;
    }
    let first_finished = completed(&database, &session.id).await;
    let second_receipt = if explicit && first_finished {
        let revision = db(&database, |store| {
            Ok(store.queued(&session.id)?[0].0.revision)
        })
        .unwrap();
        Some(
            queue_action(
                database.clone(),
                runs.clone(),
                fixture(),
                session.clone(),
                dir.path().to_string_lossy().into_owned(),
                QueueAction::Dispatch {
                    interrupt: false,
                    request_id: second.clone(),
                    revision,
                    config: Box::new(config.clone()),
                },
            )
            .await,
        )
    } else {
        None
    };
    let all_finished = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if main_inputs(dir.path()).len() == 2 && completed(&database, &session.id).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    let inputs = main_inputs(dir.path());
    let retained = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    gate.release.notify_one();
    let cancelled = owner.wait().await.is_err();
    let closed = close(&database, &runs, &session.id, false).await;
    let events = db(&database, |store| store.events(&session.id, 0.0))
        .unwrap()
        .0;
    assert_pid_gone(pid);
    assert!(cancelled && closed.is_ok());
    assert!(
        all_finished,
        "queue must execute while cleanup is pending; explicit={explicit}: {events:?}"
    );
    assert!(
        matches!(receipt, Ok(Ok(_))),
        "queue action failed: {receipt:?}"
    );
    assert!(!explicit || matches!(second_receipt, Some(Ok(_))));
    assert!(entered.is_ok() && retained);
    assert_eq!(
        inputs
            .iter()
            .map(|input| input["prompt"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["queue-first", "queue-second"]
    );
    assert_eq!(
        inputs[0]["pid"], inputs[1]["pid"],
        "same config must retain the main native Group"
    );
    for id in [&first, &second] {
        assert_eq!(events.iter().filter(|event| matches!(&event.event, EventKind::User { request_id, .. } if request_id == id)).count(), 1);
    }
    assert!(!events.iter().any(|event| matches!(
        &event.event,
        EventKind::State {
            status: Status::Failed,
            ..
        }
    )));
}

async fn native_boundary_still_waits_for_reap(reconfigure: bool) {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session, config) = codex_setup();
    let runs: Runs = Arc::default();
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let initial = submit(
        database.clone(),
        runs.clone(),
        fixture(),
        session.clone(),
        dir.path().to_string_lossy().into_owned(),
        send_turn(&config, &first, "before-close"),
        true,
    )
    .await;
    assert!(matches!(
        initial,
        Ok(Response::Accepted { duplicate: false })
    ));
    assert!(
        completed(&database, &session.id).await,
        "fixture must work before installing a reap gate"
    );
    let original_pid = main_inputs(dir.path())[0]["pid"].as_u64().unwrap() as u32;
    let (owner, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let mut changed = config.clone();
    changed.effort = Some(latte_work_protocol::Effort::Low);
    let mut operation = tokio::spawn({
        let database = database.clone();
        let runs = runs.clone();
        let session = session.clone();
        let second = second.clone();
        let path = dir.path().to_string_lossy().into_owned();
        async move {
            if reconfigure {
                submit(
                    database,
                    runs,
                    fixture(),
                    session,
                    path,
                    send_turn(&changed, &second, "after-reconfigure"),
                    true,
                )
                .await
            } else {
                close(&database, &runs, &session.id, false)
                    .await
                    .map(|_| Response::Accepted { duplicate: false })
            }
        }
    });
    let entered = tokio::time::timeout(Duration::from_secs(1), gate.entered.notified()).await;
    if entered.is_err() {
        owner.request_cancel();
        gate.entered.notified().await;
    }
    // The genuine Close/config replacement retains its five-second gate.
    tokio::time::sleep(Duration::from_millis(3250)).await;
    let premature = tokio::time::timeout(Duration::from_millis(10), &mut operation).await;
    let acknowledged_before_reap = premature.is_ok();
    let events_before_reap = db(&database, |store| store.events(&session.id, 0.0))
        .unwrap()
        .0;
    let inputs_before_reap = main_inputs(dir.path());
    let retained = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    gate.release.notify_one();
    let cancelled = owner.wait().await.is_err();
    let result = match premature {
        Ok(result) => result,
        Err(_) => operation.await,
    };
    let second_finished = !reconfigure || completed(&database, &session.id).await;
    let inputs = main_inputs(dir.path());
    let final_close = close(&database, &runs, &session.id, false).await;
    assert_pid_gone(pid);
    assert_pid_gone(original_pid);
    assert!(cancelled && final_close.is_ok());
    assert!(
        !acknowledged_before_reap,
        "real Close/reconfiguration must still wait for owner confirmation"
    );
    assert!(entered.is_ok() && retained);
    assert!(
        matches!(result, Ok(Ok(_))),
        "native boundary must succeed after confirmed reap: {result:?}"
    );
    assert_eq!(
        inputs_before_reap.len(),
        1,
        "must not replace the native Group before confirmation"
    );
    assert!(!events_before_reap.iter().any(|event| matches!(&event.event, EventKind::User { request_id, .. } if request_id == &second)), "changed config must not admit before confirmed native close");
    assert!(second_finished);
    assert_eq!(inputs.len(), if reconfigure { 2 } else { 1 });
    if reconfigure {
        assert_ne!(inputs[0]["pid"], inputs[1]["pid"]);
    }
}

#[tokio::test]
async fn changed_config_keeps_native_close_gate_before_admission() {
    native_boundary_still_waits_for_reap(true).await;
}

#[tokio::test]
async fn close_with_native_actor_waits_for_prediction_owner() {
    native_boundary_still_waits_for_reap(false).await;
}

#[tokio::test]
async fn fifo_queue_executes_once_before_prediction_reap() {
    queue_runs_before_reap(false).await;
}

#[tokio::test]
async fn explicit_queue_dispatch_executes_once_before_prediction_reap() {
    queue_runs_before_reap(true).await;
}
