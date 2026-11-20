use super::*;
use crate::agents::{AgentCommand, TransportLifetime};

struct OneShot {
    script: String,
    resume: Option<String>,
    environment: std::collections::BTreeMap<String, String>,
}
impl agents::AgentAdapter for OneShot {
    fn transport_lifetime(&self) -> TransportLifetime {
        TransportLifetime::PerTurn
    }
    fn can_reconfigure(&self) -> bool {
        true
    }
    fn has_background_work(&self) -> bool {
        false
    }
    fn knows_subagent(&self, _: &str) -> bool {
        false
    }
    fn set_session_title(&mut self, _: Option<String>, _: bool, _: bool) {}
    fn command(
        &mut self,
        _: &str,
        _: &str,
        resume: Option<&str>,
        _: &LaunchConfig,
    ) -> Result<AgentCommand> {
        self.resume = resume.map(str::to_owned);
        Ok(AgentCommand {
            command: tokio::process::Command::new("/must-not-spawn").into(),
            _settings: None,
            sideband: None,
        })
    }
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>> {
        match input {
            Input::Open => Ok(vec![]),
            Input::Start { .. } => {
                let mut command = tokio::process::Command::new("/bin/sh");
                command.arg("-c").arg(&self.script).envs(&self.environment);
                Ok(vec![Action::SpawnTurn(Box::new(AgentCommand {
                    command: command.into(),
                    _settings: None,
                    sideband: None,
                }))])
            }
            Input::Message("init") => {
                self.resume = Some("native-test".into());
                Ok(vec![Action::NativeSession("native-test".into())])
            }
            Input::Message("result") => Ok(vec![Action::Finished {
                failed: false,
                message: None,
            }]),
            Input::Message(line) => Ok(vec![Action::Event(EventKind::Text { text: line.into() })]),
            _ => bail!("unsupported test input"),
        }
    }
}
pub(super) fn context() -> (tempfile::TempDir, Database, Session, LaunchConfig) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
    let project = store.add_project(dir.path()).unwrap();
    let session = store.create_session(project.id, "claude".into()).unwrap();
    let config = crate::providers::ProviderStore::open(dir.path())
        .unwrap()
        .turn_config("claude", None, None)
        .unwrap();
    (dir, Arc::new(Mutex::new(store)), session, config)
}
pub(super) fn prepared(
    dir: &tempfile::TempDir,
    database: &Database,
    session: &Session,
    config: LaunchConfig,
    script: &str,
) -> Process {
    let environment = config.environment.0.clone();
    Process::prepare_adapter(
        database,
        "/must-not-spawn",
        session,
        dir.path().to_str().unwrap(),
        dir.path().to_str().unwrap(),
        config,
        Arc::new(AtomicBool::new(false)),
        None,
        Box::new(OneShot {
            script: script.into(),
            resume: None,
            environment,
        }),
    )
    .unwrap()
}
pub(super) async fn start(p: &mut Process, database: &Database, session: &Session) {
    db(database, |s| {
        s.begin(&session.id, "first", "hello", None, None, None, None)
    })
    .unwrap();
    p.turn_active = true;
    p.active_request_id = Some("first".into());
    let actions = p.adapter.advance(Input::Start { prompt: "hello" }).unwrap();
    p.apply(actions, database, &session.id).await.unwrap();
}
pub(super) async fn read_apply(p: &mut Process, database: &Database, session: &Session) {
    let (line, _) = p.next_message().await.unwrap().unwrap();
    let actions = p.adapter.advance(Input::Message(&line)).unwrap();
    p.apply(actions, database, &session.id).await.unwrap();
}
#[tokio::test]
async fn per_turn_positional_prompt_closes_stdin_before_waiting_for_native_init() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "cat >/dev/null; printf 'init\nresult\n'",
    );
    start(&mut p, &database, &session).await;
    tokio::time::timeout(
        Duration::from_millis(500),
        read_apply(&mut p, &database, &session),
    )
    .await
    .expect("single-turn stdin must be EOF before native initialization");
    read_apply(&mut p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    p.finish_per_turn(&database, &session.id).await.unwrap();
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Completed
    );
}
#[tokio::test]
async fn per_turn_rejects_machine_input_without_stdin_transport() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\n'; sleep 30",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert!(p.transport.as_ref().unwrap().input.is_none());
    assert!(
        p.apply(
            vec![Action::Write(b"unexpected input\n".to_vec())],
            &database,
            &session.id
        )
        .await
        .is_err()
    );
    p.stop_per_turn(&database, &session.id).await.unwrap();
}
#[test]
fn existing_four_agents_keep_default_persistent_transport() {
    for name in ["claude", "codex", "traex", "opencode"] {
        assert_eq!(
            agents::create(name).unwrap().transport_lifetime(),
            TransportLifetime::Persistent
        );
    }
}
#[tokio::test]
async fn per_turn_failed_close_journal_disables_result_deadline_and_allows_explicit_retry() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\nresult\n'; sleep 30",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert!(p.result_deadline.is_some());
    db(&database, |s| {
        s.db.execute_batch("PRAGMA query_only=ON")?;
        Ok(())
    })
    .unwrap();
    assert!(p.close_confirmed(&database, &session.id).await.is_err());
    assert!(p.close_blocked);
    assert!(!p.close_started);
    assert!(p.pending_result.is_some());
    assert!(p.transport.is_some());
    assert!(
        p.result_deadline.is_none(),
        "a blocked close cannot leave an expired actor deadline armed"
    );
    db(&database, |s| {
        s.db.execute_batch("PRAGMA query_only=OFF")?;
        Ok(())
    })
    .unwrap();
    p.close_confirmed(&database, &session.id).await.unwrap();
    assert!(!p.close_blocked);
    assert!(p.transport.is_none());
    assert!(
        db(&database, |s| s.unconfirmed_agent_close(&session.id))
            .unwrap()
            .is_none()
    );
    assert_ne!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Completed
    );
}
#[tokio::test]
async fn cursor_frame_limit_rejects_fragmented_unterminated_output() {
    let limit = agents::create("cursor")
        .unwrap()
        .frame_limit()
        .expect("Cursor must bound native frames");
    let (reader, mut writer) = tokio::io::duplex(4096);
    let mut output = FramedRead::new(reader, LinesCodec::new_with_max_length(limit));
    let producer = tokio::spawn(async move {
        let chunk = [b'x'; 4096];
        for _ in 0..=limit / chunk.len() {
            writer.write_all(&chunk).await.unwrap();
        }
        // Keep the pipe open: the reader must reject before EOF or newline.
        std::future::pending::<()>().await;
    });
    let result = tokio::time::timeout(Duration::from_secs(2), output.next())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        result,
        Err(tokio_util::codec::LinesCodecError::MaxLineLengthExceeded)
    ));
    producer.abort();
    let _ = producer.await;
}
#[tokio::test]
async fn per_turn_initialization_is_bounded_without_claiming_ready() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\n'; sleep 30",
    );
    assert!(!p.initializing());
    start(&mut p, &database, &session).await;
    assert!(p.initializing());
    read_apply(&mut p, &database, &session).await;
    assert!(!p.initializing());
    assert!(!p.state.ready);
    p.stop_per_turn(&database, &session.id).await.unwrap();
}
#[tokio::test]
async fn per_turn_missing_native_id_fences_new_admission_but_reconciles_old_request() {
    let (dir, database, session, config) = context();
    let mut p = prepared(&dir, &database, &session, config.clone(), "sleep 30");
    start(&mut p, &database, &session).await;
    p.stop_per_turn(&database, &session.id).await.unwrap();
    let mut process = Some(p);
    for (request_id, expected) in [("first", false), ("next", true)] {
        let result = accept_turn(
            &mut process,
            &database,
            "/must-not-spawn",
            &session,
            dir.path().to_str().unwrap(),
            SendTurn {
                request_id: request_id.into(),
                text: "hello".into(),
                model: None,
                fingerprint: None,
                config: config.clone(),
            },
            &Arc::new(AtomicBool::new(false)),
            None,
            || {},
        )
        .await;
        if expected {
            assert!(result.unwrap_err().to_string().contains("continuation"));
        } else {
            assert!(!result.unwrap());
        }
    }
    assert!(process.as_ref().unwrap().transport.is_none());
    assert_eq!(
        db(&database, |s| s.events(&session.id, 0.0))
            .unwrap()
            .0
            .iter()
            .filter(|e| matches!(e.event, EventKind::User { .. }))
            .count(),
        1
    );
}
#[tokio::test]
async fn per_turn_spawn_follows_request_and_baseline_and_deduplicates() {
    let (dir, database, session, config) = context();
    let p = prepared(
        &dir,
        &database,
        &session,
        config.clone(),
        "printf 'init\nresult\n'",
    );
    let mut process = Some(p);
    for expected in [true, false] {
        let new = accept_turn(
            &mut process,
            &database,
            "/must-not-spawn",
            &session,
            dir.path().to_str().unwrap(),
            SendTurn {
                request_id: "first".into(),
                text: "hello".into(),
                model: None,
                fingerprint: None,
                config: config.clone(),
            },
            &Arc::new(AtomicBool::new(false)),
            None,
            || {
                assert!(db(&database, |s| s.has_admitted_request(&session.id)).unwrap());
            },
        )
        .await
        .unwrap();
        assert_eq!(new, expected);
    }
    assert!(
        db(&database, |s| s.pending_turn(&session.id))
            .unwrap()
            .is_some()
    );
    assert!(
        db(&database, |s| s.baseline(&session.id))
            .unwrap()
            .is_some()
    );
    let p = process.as_mut().unwrap();
    read_apply(p, &database, &session).await;
    read_apply(p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    p.finish_per_turn(&database, &session.id).await.unwrap();
    assert!(
        db(&database, |s| s.pending_turn(&session.id))
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn per_turn_open_prepares_without_process_ready_or_native_identity() {
    let (dir, database, session, config) = context();
    let mut p = prepared(&dir, &database, &session, config, "exit 0");
    let actions = p.adapter.advance(Input::Open).unwrap();
    p.apply(actions, &database, &session.id).await.unwrap();
    assert!(p.transport.is_none());
    assert!(!p.state.ready);
    assert!(!p.session_open.load(Ordering::SeqCst));
    assert!(p.can_start_turn());
    assert!(
        db(&database, |s| s.session(&session.id))
            .unwrap()
            .native_id
            .is_none()
    );
}
#[tokio::test]
async fn per_turn_result_waits_for_stdout_exit_and_reap() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\nresult\ntrailing\n'; sleep 0.05",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Running
    );
    assert!(!p.can_start_turn());
    assert!(
        !p.idle_for_close(),
        "native result must not release the runtime idle fence before drain/reap"
    );
    read_apply(&mut p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    p.finish_per_turn(&database, &session.id).await.unwrap();
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Completed
    );
    assert!(p.transport.is_none());
    assert!(p.can_start_turn());
    assert_eq!(
        db(&database, |s| s.session(&session.id))
            .unwrap()
            .native_id
            .as_deref(),
        Some("native-test")
    );
    assert!(!p.session_open.load(Ordering::SeqCst));
}
#[tokio::test]
async fn per_turn_result_and_stdout_eof_wait_for_natural_child_cleanup_before_retirement() {
    let (dir, database, session, mut config) = context();
    // The test adapter captures launch ENV, so prepare it with the marker override.
    let marker = dir.path().join("native-cleanup-finished");
    config.environment.0.insert(
        "CURSOR_CLEANUP_MARKER".into(),
        marker.to_string_lossy().into_owned(),
    );
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\\nresult\\n'; exec 1>&-; sleep 0.05; printf 'natural exit' > \"$CURSOR_CLEANUP_MARKER\"; exit 0",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    assert_eq!(
        db(&database, |store| Ok(store.session(&session.id)?.status)).unwrap(),
        Status::Running
    );
    p.finish_per_turn(&database, &session.id).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(marker).unwrap(),
        "natural exit",
        "result + EOF must not SIGKILL a child still cleaning up before its successful natural exit"
    );
    assert_eq!(
        db(&database, |store| Ok(store.session(&session.id)?.status)).unwrap(),
        Status::Completed
    );
    assert!(p.transport.is_none() && p.can_start_turn());
}

#[tokio::test]
async fn per_turn_eof_without_result_never_completes() {
    let (dir, database, session, config) = context();
    let mut p = prepared(&dir, &database, &session, config, "printf 'init\n'");
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    assert!(
        p.finish_per_turn(&database, &session.id)
            .await
            .unwrap_err()
            .to_string()
            .contains("result")
    );
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Running
    );
    p.close_confirmed(&database, &session.id).await.unwrap();
}
#[tokio::test]
async fn per_turn_nonzero_after_result_is_not_success_and_stderr_is_bounded() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\nresult\n'; printf 'native failure' >&2; exit 7",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    let error = p
        .finish_per_turn(&database, &session.id)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("7"), "{error}");
    assert!(error.contains("native failure"), "{error}");
    assert_ne!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Completed
    );
    p.close_confirmed(&database, &session.id).await.unwrap();
}
#[path = "per_turn_review_tests.rs"]
mod review;

#[tokio::test]
async fn per_turn_stop_preserves_actor_and_native_id() {
    let (dir, database, session, config) = context();
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\n'; sleep 30",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    p.stop_per_turn(&database, &session.id).await.unwrap();
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Stopped
    );
    assert_eq!(
        db(&database, |s| s.session(&session.id))
            .unwrap()
            .native_id
            .as_deref(),
        Some("native-test")
    );
    assert!(p.transport.is_none());
    assert!(p.can_start_turn());
}
