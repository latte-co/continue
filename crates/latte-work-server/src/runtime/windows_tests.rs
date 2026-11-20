//! Native Windows fixtures exercise the real Job-backed transport, without models.
use super::*;

#[test]
#[ignore = "native child launched by Windows runtime regressions"]
fn native_transport_fixture() {
    use std::io::{BufRead, Write};
    if std::env::var("LATTE_NATIVE_FIXTURE").as_deref() == Ok("graceful") {
        let line = std::io::stdin().lock().lines().next().unwrap().unwrap();
        assert_eq!(line, "end");
        println!("native-close-ack");
        std::io::stdout().flush().unwrap();
    } else if std::env::var("LATTE_NATIVE_FIXTURE").as_deref() == Ok("persistent") {
        println!("native-ready");
        std::io::stdout().flush().unwrap();
        let line = std::io::stdin().lock().lines().next().unwrap().unwrap();
        println!("native-echo:{line}");
    } else {
        println!("init\nresult");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(Duration::from_millis(150));
    }
    std::process::exit(0);
}

fn native_command(mode: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "runtime::windows_tests::native_transport_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("LATTE_NATIVE_FIXTURE", mode);
    command
}

struct SingleTurn;
impl agents::AgentAdapter for SingleTurn {
    fn transport_lifetime(&self) -> agents::TransportLifetime {
        agents::TransportLifetime::PerTurn
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
        _: Option<&str>,
        _: &LaunchConfig,
    ) -> Result<agents::AgentCommand> {
        Ok(agents::AgentCommand {
            command: native_command("per-turn").into(),
            _settings: None,
            sideband: None,
        })
    }
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>> {
        Ok(match input {
            Input::Start { .. } => vec![Action::SpawnTurn(Box::new(agents::AgentCommand {
                command: native_command("per-turn").into(),
                _settings: None,
                sideband: None,
            }))],
            Input::Message("init") => vec![Action::NativeSession("windows-native-session".into())],
            Input::Message("result") => vec![Action::Finished {
                failed: false,
                message: None,
            }],
            _ => vec![],
        })
    }
}

#[tokio::test]
async fn windows_per_turn_result_waits_for_native_exit_and_preserves_actor_for_stop() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("state.sqlite")).unwrap();
    let project = store.add_project(directory.path()).unwrap();
    let session = store.create_session(project.id, "cursor".into()).unwrap();
    let database = Arc::new(Mutex::new(store));
    let config = crate::providers::ProviderStore::open(directory.path())
        .unwrap()
        .turn_config("cursor", None, None)
        .unwrap();
    let mut process = Process::prepare_adapter(
        &database,
        "unused",
        &session,
        directory.path().to_str().unwrap(),
        directory.path().to_str().unwrap(),
        config,
        Arc::new(AtomicBool::new(false)),
        None,
        Box::new(SingleTurn),
    )
    .unwrap();
    assert!(
        process.transport.is_none(),
        "Open cannot spawn a PerTurn agent"
    );
    db(&database, |store| {
        store.begin(&session.id, "first", "hello", None, None, None, None)
    })
    .unwrap();
    process.turn_active = true;
    process.active_request_id = Some("first".into());
    let actions = process
        .adapter
        .advance(Input::Start { prompt: "hello" })
        .unwrap();
    process
        .apply(actions, &database, &session.id)
        .await
        .unwrap();
    while process.pending_result.is_none() {
        let (line, _) = process.next_message().await.unwrap().unwrap();
        let actions = process.adapter.advance(Input::Message(&line)).unwrap();
        process
            .apply(actions, &database, &session.id)
            .await
            .unwrap();
    }
    assert_eq!(
        db(&database, |store| store.session(&session.id))
            .unwrap()
            .status,
        Status::Running
    );
    assert!(process.next_message().await.unwrap().is_none());
    process
        .finish_per_turn(&database, &session.id)
        .await
        .unwrap();
    assert!(process.transport.is_none());
    let saved = db(&database, |store| store.session(&session.id)).unwrap();
    assert_eq!(saved.status, Status::Completed);
    assert_eq!(saved.native_id.as_deref(), Some("windows-native-session"));
    db(&database, |store| {
        store.begin(&session.id, "second", "again", None, None, None, None)
    })
    .unwrap();
    process.turn_active = true;
    process.active_request_id = Some("second".into());
    let actions = process
        .adapter
        .advance(Input::Start { prompt: "again" })
        .unwrap();
    process
        .apply(actions, &database, &session.id)
        .await
        .unwrap();
    process.stop_per_turn(&database, &session.id).await.unwrap();
    assert!(process.transport.is_none());
    assert_eq!(
        db(&database, |store| store.session(&session.id))
            .unwrap()
            .native_id,
        saved.native_id
    );
    process
        .close_confirmed(&database, &session.id)
        .await
        .unwrap();
}

#[tokio::test]
async fn windows_persistent_transport_keeps_bidirectional_stdin_until_confirmed_close() {
    let directory = tempfile::tempdir().unwrap();
    let config = crate::providers::ProviderStore::open(directory.path())
        .unwrap()
        .turn_config("claude", None, None)
        .unwrap();
    let mut transport = Transport::spawn(
        agents::AgentCommand {
            command: native_command("persistent").into(),
            _settings: None,
            sideband: None,
        },
        Some(1024),
        &config,
        agents::TransportLifetime::Persistent,
    )
    .unwrap();
    while transport.output.next().await.unwrap().unwrap() != "native-ready" {}
    write(
        transport.input.as_mut().unwrap(),
        "原生参数 & %PATH%\n".as_bytes(),
    )
    .await
    .unwrap();
    assert_eq!(
        transport.output.next().await.unwrap().unwrap(),
        "native-echo:原生参数 & %PATH%"
    );
    assert!(transport.terminate(false).await);
}

#[tokio::test]
async fn windows_opencode_sideband_accepts_node_named_pipe_without_socket_emulation() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let listener = latte_work_platform::pipe::PrivatePipe::bind("opencode-test").unwrap();
    let mut command = crate::agent_environment::command("node");
    command.args(["-e", "const s=require('node:net').createConnection(process.env.LATTE_TEST_PIPE);s.on('connect',()=>{process.stdout.write('connected\\n');setTimeout(()=>s.write('ready\\n'),150)});s.on('data',b=>{process.stdout.write(b);s.end()});s.on('error',()=>process.exit(2))"])
        .env("LATTE_TEST_PIPE", listener.name()).stdout(Stdio::piped());
    let mut child = latte_work_platform::process::ManagedChild::spawn(&mut command).unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut connected = String::new();
    let mut first_accept = Box::pin(listener.accept_with_prefix());
    tokio::select! {
        result = &mut first_accept => panic!("peer sent prefix before cancellation seam: {}", result.is_ok()),
        result = stdout.read_line(&mut connected) => { result.unwrap(); assert_eq!(connected, "connected\n"); }
    }
    drop(first_accept);
    let (stream, prefix) =
        tokio::time::timeout(Duration::from_secs(5), listener.accept_with_prefix())
            .await
            .unwrap()
            .unwrap();
    let mut stream = BufReader::new(stream);
    let mut line = String::new();
    stream.read_line(&mut line).await.unwrap();
    assert_eq!(format!("{}{line}", char::from(prefix)), "ready\n");
    stream.get_mut().write_all(b"reply\n").await.unwrap();
    stream.get_mut().flush().await.unwrap();
    drop(stream);
    let mut output = String::new();
    tokio::time::timeout(Duration::from_secs(5), stdout.read_to_string(&mut output))
        .await
        .unwrap()
        .unwrap();
    assert!(child.wait().await.unwrap().success());
    child.close(Duration::ZERO).await.unwrap();
    assert_eq!(output, "reply\n");
}

#[tokio::test]
async fn windows_auxiliary_close_failure_keeps_the_journal_and_explicit_retry_owner() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("state.sqlite")).unwrap();
    let project = store.add_project(directory.path()).unwrap();
    let session = store.create_session(project.id, "cursor".into()).unwrap();
    let database = Arc::new(Mutex::new(store));
    let config = crate::providers::ProviderStore::open(directory.path())
        .unwrap()
        .turn_config("cursor", None, None)
        .unwrap();
    let mut process = Process::prepare_adapter(
        &database,
        "unused",
        &session,
        directory.path().to_str().unwrap(),
        directory.path().to_str().unwrap(),
        config,
        Arc::new(AtomicBool::new(false)),
        None,
        Box::new(SingleTurn),
    )
    .unwrap();
    let (owner, gate, pid) =
        agents::codex_jobs::test_job(&session.id, agents::codex_jobs::JobKind::Prediction).unwrap();
    let _pid = pid.await.unwrap();
    let (process, result) = tokio::spawn({
        let database = database.clone();
        let id = session.id.clone();
        async move {
            let result = process.close_confirmed(&database, &id).await;
            (process, result)
        }
    })
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(process.close_started && process.close_blocked);
    assert!(
        db(&database, |store| store
            .unconfirmed_agent_close(&session.id))
        .unwrap()
        .is_some()
    );
    assert!(!process.can_start_turn());
    gate.release.notify_one();
    assert!(owner.wait().await.is_err());
    let mut process = process;
    process
        .close_confirmed(&database, &session.id)
        .await
        .unwrap();
    assert!(!process.close_blocked);
    assert!(
        db(&database, |store| store
            .unconfirmed_agent_close(&session.id))
        .unwrap()
        .is_none()
    );
}

struct GracefulClose;
impl agents::AgentAdapter for GracefulClose {
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
    fn close_request(&self) -> Result<Option<Vec<u8>>> {
        Ok(Some(b"end\n".to_vec()))
    }
    fn close_ack(&self, line: &str) -> bool {
        line == "native-close-ack"
    }
    fn requires_close_drain(&self) -> bool {
        true
    }
    fn command(
        &mut self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: &LaunchConfig,
    ) -> Result<agents::AgentCommand> {
        Ok(agents::AgentCommand {
            command: native_command("graceful").into(),
            _settings: None,
            sideband: None,
        })
    }
    fn advance(&mut self, _: Input<'_>) -> Result<Vec<Action>> {
        Ok(vec![])
    }
}

#[tokio::test]
async fn windows_graceful_native_receipt_survives_auxiliary_only_cleanup_retry() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("state.sqlite")).unwrap();
    let project = store.add_project(directory.path()).unwrap();
    let session = store.create_session(project.id, "claude".into()).unwrap();
    let database = Arc::new(Mutex::new(store));
    let config = crate::providers::ProviderStore::open(directory.path())
        .unwrap()
        .turn_config("claude", None, None)
        .unwrap();
    let mut process = Process::prepare_adapter(
        &database,
        "unused",
        &session,
        directory.path().to_str().unwrap(),
        directory.path().to_str().unwrap(),
        config,
        Arc::new(AtomicBool::new(false)),
        None,
        Box::new(GracefulClose),
    )
    .unwrap();
    let (owner, gate, pid) =
        agents::codex_jobs::test_job(&session.id, agents::codex_jobs::JobKind::Prediction).unwrap();
    pid.await.unwrap();
    assert!(
        process
            .close_confirmed(&database, &session.id)
            .await
            .is_err()
    );
    assert_eq!(process.native_close_evidence, Some(true));
    assert!(
        !process.close_cleanup_complete,
        "live auxiliary owner must remain tracked"
    );
    assert!(process.transport.is_some());
    gate.release.notify_one();
    assert!(owner.wait().await.is_err());
    process
        .close_confirmed(&database, &session.id)
        .await
        .unwrap();
    assert_eq!(process.native_close_evidence, Some(true));
    assert!(process.close_cleanup_complete);
    assert!(process.transport.is_none());
    assert!(
        db(&database, |store| store
            .unconfirmed_agent_close(&session.id))
        .unwrap()
        .is_none()
    );
}
