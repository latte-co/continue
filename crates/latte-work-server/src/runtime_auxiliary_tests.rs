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

#[tokio::test]
async fn durable_send_acknowledges_before_slow_prediction_reap_and_does_not_launch_main() {
    let _serial = GLOBAL_POOL.lock().await;
    let (dir, database, session) = setup();
    let (handle, gate, pid) = codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let pid = pid.await.unwrap();
    let runs: Runs = Arc::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let config = LaunchConfig {
        environment: Default::default(),
        traex_model: None,
        provider: None,
        model: None,
        effort: None,
        permission_mode: None,
        settings_dir: dir.path().into(),
    };
    let receipt = tokio::time::timeout(
        Duration::from_millis(250),
        submit(
            database.clone(),
            runs,
            "/missing/must-not-launch".into(),
            session.clone(),
            dir.path().to_string_lossy().into_owned(),
            SendTurn {
                request_id: request_id.clone(),
                text: "durably admitted".into(),
                model: None,
                fingerprint: None,
                config,
            },
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
    let terminal = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if db(&database, |store| {
                Ok(store.session(&session.id)?.status == Status::Failed)
            })
            .unwrap()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let events = db(&database, |store| store.events(&session.id, 0.0))
        .unwrap()
        .0;
    let still_owned = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    gate.release.notify_one();
    assert!(handle.wait().await.is_err());
    assert_pid_gone(pid);
    assert!(
        matches!(receipt, Ok(Ok(Response::Accepted { duplicate: false }))),
        "durable receipt must not wait for reap: {receipt:?}"
    );
    assert!(
        entered.is_ok(),
        "admission must request cancellation without relying on a native actor"
    );
    assert!(
        terminal.is_ok(),
        "bounded preparation must fail rather than spawn during unconfirmed reap"
    );
    assert!(
        still_owned,
        "the owner must survive the bounded runtime preparation failure"
    );
    assert_eq!(events.iter().filter(|event| matches!(&event.event, EventKind::User { request_id: id, .. } if id == &request_id)).count(), 1);
    assert!(events.iter().any(|event| matches!(&event.event, EventKind::State { message: Some(message), .. } if message.contains("回收待确认") && message.contains("已接收"))), "preparation failure must report admitted-but-not-started, not CLI startup: {events:?}");
}

#[tokio::test]
async fn preparation_prediction_wait_does_not_cancel_or_wait_for_first_turn_title() {
    let _serial = GLOBAL_POOL.lock().await;
    let (_dir, _database, session) = setup();
    let (title, title_gate, title_pid) = codex_jobs::test_job(&session.id, JobKind::Title).unwrap();
    let (prediction, prediction_gate, prediction_pid) =
        codex_jobs::test_job(&session.id, JobKind::Prediction).unwrap();
    let title_pid = title_pid.await.unwrap();
    let prediction_pid = prediction_pid.await.unwrap();
    codex_jobs::registry().cancel_predictions(&session.id);
    prediction_gate.entered.notified().await;
    let early = codex_jobs::registry()
        .wait_predictions(&session.id, Duration::from_millis(10))
        .await;
    prediction_gate.release.notify_one();
    assert!(prediction.wait().await.is_err());
    let prediction_confirmed = codex_jobs::registry()
        .wait_predictions(&session.id, Duration::from_millis(10))
        .await;
    let title_preserved = !codex_jobs::registry().scope_confirmed(&JobScope::session(&session.id));
    codex_jobs::registry().cancel_titles(&session.id);
    title_gate.entered.notified().await;
    title_gate.release.notify_one();
    assert!(title.wait().await.is_err());
    assert!(!early);
    assert!(
        prediction_confirmed,
        "preparation must not wait for a title"
    );
    assert!(title_preserved);
    assert_pid_gone(title_pid);
    assert_pid_gone(prediction_pid);
}
