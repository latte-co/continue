//! Regression cases from PR #34's Cursor review; only isolated native peers.
use super::*;
use std::ffi::{OsStr, OsString};
use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};

fn install_cursor(path: &Path) {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cursor.py");
    std::fs::copy(source, path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

async fn discovery_host(binary: &Path, incompatible: bool, explicit: bool) -> Host {
    let directory = tempfile::Builder::new()
        .prefix("lw-")
        .tempdir_in("/tmp")
        .unwrap();
    let home = directory.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let python_bin = crate::isolated_python_bin(directory.path());
    let path = std::env::join_paths([
        binary.parent().unwrap(),
        python_bin.as_path(),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ])
    .unwrap();
    let mut environment = vec![("HOME", home.as_os_str()), ("PATH", path.as_os_str())];
    if explicit {
        environment.push(("LATTE_WORK_CURSOR", binary.as_os_str()));
    }
    if incompatible {
        std::fs::write(binary, "#!/bin/sh\nprintf 'generic agent --print --output-format stream-json --resume --model\\n'\n").unwrap();
        std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    fixture_bridge::prepare(
        directory.path(),
        &environment,
        Path::new(env!("CARGO_BIN_EXE_latte-continue-server")),
    );
    let removed = if explicit {
        &[][..]
    } else {
        &["LATTE_WORK_CURSOR"][..]
    };
    let process = Host::spawn_with_removed_environment(directory.path(), &environment, removed);
    let host = Host { directory, process };
    host.wait_ready().await;
    host
}

async fn cursor_available(client: &mut Client) -> bool {
    let Response::Hello { agents, .. } = ask(client, Request::Hello { version: VERSION }).await
    else {
        panic!("hello")
    };
    agents
        .iter()
        .find(|agent| agent.id == "cursor")
        .unwrap()
        .available
}

#[tokio::test]
async fn cursor_review_non_unicode_environment_does_not_abort_server_startup() {
    let secret = OsString::from_vec(b"fixture-secret-\xff-value".to_vec());
    let host = Host::start_with_environment(&[("CURSOR_FIXTURE_SECRET", secret.as_os_str())]).await;
    let mut client = host.client().await;
    assert!(cursor_available(&mut client).await);
    let root = tempfile::tempdir().unwrap();
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "non-unicode", "hello").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
}

#[tokio::test]
async fn cursor_review_only_agent_on_path_is_discovered_and_used() {
    let binaries = tempfile::tempdir().unwrap();
    let agent = binaries.path().join("agent");
    install_cursor(&agent);
    let host = discovery_host(&agent, false, false).await;
    let mut client = host.client().await;
    assert!(cursor_available(&mut client).await);
    let root = tempfile::tempdir().unwrap();
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "agent-fallback", "hello").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        Path::new(inputs(root.path())[0]["binary"].as_str().unwrap()).file_name(),
        Some(OsStr::new("agent"))
    );
}

#[tokio::test]
async fn cursor_review_incompatible_agent_is_not_cursor() {
    let binaries = tempfile::tempdir().unwrap();
    let agent = binaries.path().join("agent");
    let host = discovery_host(&agent, true, false).await;
    let mut client = host.client().await;
    assert!(!cursor_available(&mut client).await);
}

#[tokio::test]
async fn cursor_review_incompatible_cursor_name_falls_back_only_without_override() {
    let binaries = tempfile::tempdir().unwrap();
    let agent = binaries.path().join("agent");
    install_cursor(&agent);
    let named = binaries.path().join("cursor-agent");
    let host = discovery_host(&named, true, false).await;
    let mut client = host.client().await;
    assert!(cursor_available(&mut client).await);
    drop(client);
    drop(host);
    let host = discovery_host(&named, true, true).await;
    let mut client = host.client().await;
    assert!(
        !cursor_available(&mut client).await,
        "explicit incompatible override must not fall back"
    );
}

async fn selected_send(client: &mut Client, id: &str, request: &str, model: &str) -> Response {
    ask(
        client,
        Request::SendQueued {
            session_id: id.into(),
            request_id: request.into(),
            text: request.into(),
            model: Some(model.into()),
            effort: None,
            permission_mode: None,
            provider: Some(TurnProvider::Cli),
        },
    )
    .await
}

#[tokio::test]
async fn cursor_review_removed_model_can_be_replaced_in_the_same_native_session() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        selected_send(&mut client, &id, "old-model", "cursor-test").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let before = current(&mut client, &id).await;
    std::fs::write(root.path().join("cursor-models-next"), "").unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: id.clone(),
                only_if_idle: Some(true),
            }
        )
        .await,
        Response::Ok
    ));
    open(&mut client, &id).await;
    let reopened = current(&mut client, &id).await;
    assert_eq!(reopened.native_id, before.native_id);
    assert_eq!(reopened.model.as_deref(), Some("cursor-test"));
    let catalog = ask(
        &mut client,
        Request::Models {
            agent: "cursor".into(),
            model: Some("cursor-test".into()),
            project_id: Some(before.project_id),
        },
    )
    .await;
    assert!(matches!(catalog, Response::Models { models, .. } if models == ["cursor-next"]));
    assert!(matches!(
        selected_send(&mut client, &id, "invalid-old", "cursor-test").await,
        Response::Error { .. }
    ));
    assert_eq!(inputs(root.path()).len(), 1);
    assert!(matches!(
        selected_send(&mut client, &id, "new-model", "cursor-next").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let records = inputs(root.path());
    assert_eq!(records.len(), 2);
    assert_eq!(records[1]["resume"], before.native_id.unwrap());
    assert!(
        records[1]["options"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("cursor-next"))
    );
    assert_eq!(
        current(&mut client, &id).await.model.as_deref(),
        Some("cursor-next")
    );
}

#[tokio::test]
async fn cursor_review_limit_is_pre_admission_and_short_input_remains_sendable() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    for (n, text) in [
        "x".repeat(128 * 1024),
        "é".repeat(64 * 1024),
        "before\0after".into(),
    ]
    .into_iter()
    .enumerate()
    {
        for queued in [false, true] {
            let request_id = format!("limit-{n}-{queued}");
            let request = if queued {
                Request::SendQueued {
                    session_id: id.clone(),
                    request_id,
                    text: text.clone(),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    provider: Some(TurnProvider::Cli),
                }
            } else {
                Request::Send {
                    session_id: id.clone(),
                    request_id,
                    text: text.clone(),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    provider: Some(TurnProvider::Cli),
                }
            };
            assert!(
                matches!(ask(&mut client, request).await, Response::Error { .. }),
                "limit must reject before accepting"
            );
        }
    }
    assert!(
        matches!(ask(&mut client, Request::Poll { session_id: id.clone(), after: 0.0 }).await, Response::Events { events, .. } if events.is_empty())
    );
    assert!(!root.path().join("cursor-inputs").exists());
    assert!(matches!(
        send(&mut client, &id, "short", "short").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(inputs(root.path()).len(), 1);
}

#[tokio::test]
async fn cursor_review_actual_spawn_failure_survives_restart_without_replaying() {
    let fixture_dir = tempfile::tempdir().unwrap();
    let binary = fixture_dir.path().join("cursor-agent");
    install_cursor(&binary);
    let environment = [("LATTE_WORK_CURSOR", binary.as_os_str())];
    let mut host = Host::start_with_environment(&environment).await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    open(&mut client, &id).await;
    std::fs::remove_file(&binary).unwrap();
    assert!(matches!(
        send(&mut client, &id, "never-started", "must not replay").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Failed).await;
    assert!(current(&mut client, &id).await.native_id.is_none());
    assert!(!root.path().join("cursor-inputs").exists());
    install_cursor(&binary);
    drop(client);
    host.process.kill().unwrap();
    host.process.wait().unwrap();
    host.process = Host::spawn(host.directory.path(), &environment);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut client = host.client().await;
    assert!(matches!(
        send(&mut client, &id, "never-started", "must not replay").await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        send(&mut client, &id, "retry", "short retry").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let records = inputs(root.path());
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["prompt"], "short retry");
    assert!(records[0]["resume"].is_null());
}

#[tokio::test]
async fn cursor_review_eof_before_result_keeps_bounded_redacted_diagnostics() {
    for prompt in [
        "stderr-no-result",
        "stderr-after-init",
        "stderr-exit-zero",
        "stderr-oversize",
        "eof-hold",
    ] {
        let secret = "fixture-cursor-review-private";
        let host =
            Host::start_with_environment(&[("CURSOR_FIXTURE_SECRET", OsStr::new(secret))]).await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, root.path()).await;
        let started = Instant::now();
        assert!(matches!(
            send(&mut client, &id, prompt, prompt).await,
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &id, Status::Failed).await;
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "EOF retirement must stay bounded"
        );
        let message = events
            .iter()
            .find_map(|event| match &event.event {
                EventKind::State {
                    status: Status::Failed,
                    message,
                } => message.as_deref(),
                _ => None,
            })
            .unwrap();
        assert!(message.contains("native result"), "{prompt}: {message}");
        assert!(!message.contains(secret), "{prompt}: {message}");
        match prompt {
            "stderr-no-result" | "stderr-after-init" | "stderr-exit-zero" => {
                assert!(
                    message.contains("fixture diagnostic"),
                    "{prompt}: {message}"
                );
                assert!(message.contains("[redacted]"), "{prompt}: {message}");
            }
            "stderr-oversize" => assert!(message.contains("stderr truncated"), "{message}"),
            "eof-hold" => assert!(message.contains("退出未确认"), "{message}"),
            _ => unreachable!(),
        }
        assert!(!events.iter().any(|event| matches!(
            &event.event,
            EventKind::State {
                status: Status::Completed,
                ..
            }
        )));
    }
}

#[tokio::test]
async fn cursor_review_started_without_init_stays_unknown_after_restart() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "started-no-init", "before-init").await,
        Response::Accepted { duplicate: false }
    ));
    file(&root.path().join("cursor-active")).await;
    assert!(current(&mut client, &id).await.native_id.is_none());
    drop(client);
    host.process.kill().unwrap();
    host.process.wait().unwrap();
    std::fs::write(root.path().join("cursor-release"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while root.path().join("cursor-active").exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    host.process = Host::spawn(host.directory.path(), &[]);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut client = host.client().await;
    assert_eq!(current(&mut client, &id).await.status, Status::Unknown);
    assert!(matches!(
        send(&mut client, &id, "started-no-init", "before-init").await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        send(&mut client, &id, "must-block", "short").await,
        Response::Error { .. }
    ));
    assert_eq!(inputs(root.path()).len(), 1);
    assert!(current(&mut client, &id).await.native_id.is_none());
}

#[tokio::test]
async fn cursor_review_edited_queue_keeps_original_admission_reconciliation() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "queue-head", "hold").await,
        Response::Accepted { duplicate: false }
    ));
    file(&root.path().join("cursor-active")).await;
    assert!(matches!(
        send(&mut client, &id, "queue-edited", "original").await,
        Response::MessageQueued { duplicate: false }
    ));
    assert!(matches!(
        ask(
            &mut client,
            Request::EditQueuedMessage {
                session_id: id.clone(),
                request_id: "queue-edited".into(),
                revision: 0,
                text: "edited".into(),
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    std::fs::write(root.path().join("cursor-release"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while inputs(root.path()).len() != 2
        || current(&mut client, &id).await.status != Status::Completed
    {
        assert!(Instant::now() < deadline, "edited queue completion");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(inputs(root.path())[1]["prompt"], "edited");
    assert!(matches!(
        send(&mut client, &id, "queue-edited", "original").await,
        Response::Accepted { duplicate: true }
    ));
    assert_eq!(inputs(root.path()).len(), 2);
}

#[tokio::test]
async fn cursor_review_invalid_queue_edits_leave_revision_payload_and_fifo_unchanged() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "edit-head", "hold").await,
        Response::Accepted { duplicate: false }
    ));
    file(&root.path().join("cursor-active")).await;
    assert!(matches!(
        send(&mut client, &id, "edit-entry", "original").await,
        Response::MessageQueued { duplicate: false }
    ));
    assert!(matches!(
        send(&mut client, &id, "edit-tail", "tail").await,
        Response::MessageQueued { duplicate: false }
    ));
    for text in [
        "x".repeat(128 * 1024),
        "é".repeat(64 * 1024),
        "before\0after".into(),
    ] {
        assert!(
            matches!(
                ask(
                    &mut client,
                    Request::EditQueuedMessage {
                        session_id: id.clone(),
                        request_id: "edit-entry".into(),
                        revision: 0,
                        text,
                    }
                )
                .await,
                Response::Error { .. }
            ),
            "invalid Cursor edit must reject before saving"
        );
        let Response::MessageQueue {
            entries,
            paused: false,
            ..
        } = ask(
            &mut client,
            Request::MessageQueue {
                session_id: id.clone(),
            },
        )
        .await
        else {
            panic!("queue paused")
        };
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.text.as_str(), e.revision))
                .collect::<Vec<_>>(),
            [("original", 0), ("tail", 0)]
        );
        assert_eq!(inputs(root.path()).len(), 1);
    }
    assert!(matches!(
        ask(
            &mut client,
            Request::EditQueuedMessage {
                session_id: id.clone(),
                request_id: "edit-entry".into(),
                revision: 0,
                text: "x".repeat(128 * 1024 - 1),
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    assert!(matches!(
        ask(
            &mut client,
            Request::EditQueuedMessage {
                session_id: id.clone(),
                request_id: "edit-entry".into(),
                revision: 1,
                text: "edited".into(),
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    std::fs::write(root.path().join("cursor-release"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while inputs(root.path()).len() != 3
        || current(&mut client, &id).await.status != Status::Completed
    {
        assert!(Instant::now() < deadline, "valid FIFO remains dispatchable");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        inputs(root.path())
            .iter()
            .map(|r| r["prompt"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["hold", "edited", "tail"]
    );
}

#[tokio::test]
async fn cursor_review_permission_denied_path_entry_does_not_hide_later_cli() {
    let denied = tempfile::tempdir().unwrap();
    let usable = tempfile::tempdir().unwrap();
    let interpreter = denied.path().join("interpreter");
    std::fs::write(&interpreter, "not executable").unwrap();
    std::fs::set_permissions(&interpreter, std::fs::Permissions::from_mode(0o600)).unwrap();
    let first = denied.path().join("cursor-agent");
    std::fs::write(&first, format!("#!{}\n", interpreter.display())).unwrap();
    // Owner execution is denied although a different permission class has X.
    // The denied interpreter also makes the spawn fail under a root test runner.
    std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o610)).unwrap();
    assert_eq!(
        std::process::Command::new(&first)
            .arg("--version")
            .spawn()
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let second = usable.path().join("cursor-agent");
    install_cursor(&second);
    let directory = tempfile::Builder::new()
        .prefix("lw-")
        .tempdir_in("/tmp")
        .unwrap();
    let home = directory.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let python_bin = crate::isolated_python_bin(directory.path());
    let path = std::env::join_paths([
        denied.path(),
        usable.path(),
        python_bin.as_path(),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ])
    .unwrap();
    let environment = [("HOME", home.as_os_str()), ("PATH", path.as_os_str())];
    fixture_bridge::prepare(
        directory.path(),
        &environment,
        Path::new(env!("CARGO_BIN_EXE_latte-continue-server")),
    );
    let process = Host::spawn_with_removed_environment(
        directory.path(),
        &environment,
        &["LATTE_WORK_CURSOR"],
    );
    let host = Host { directory, process };
    host.wait_ready().await;
    let mut client = host.client().await;
    assert!(
        cursor_available(&mut client).await,
        "EACCES on the first PATH entry must not hide the usable same-name CLI"
    );
    let root = tempfile::tempdir().unwrap();
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "permission-fallback", "hello").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(inputs(root.path())[0]["binary"], second.to_str().unwrap());
}

fn quote_path(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

#[tokio::test]
async fn cursor_review_configured_path_cannot_replace_the_discovered_executable() {
    let original = tempfile::tempdir().unwrap();
    let shadow = tempfile::tempdir().unwrap();
    let agent = original.path().join("agent");
    install_cursor(&agent);
    let marker = shadow.path().join("shadow-calls");
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cursor.py");
    let shadow_agent = shadow.path().join("agent");
    std::fs::write(
        &shadow_agent,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nexec python3 {} \"$@\"\n",
            quote_path(&marker),
            quote_path(&source)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&shadow_agent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let host = discovery_host(&agent, false, false).await;
    let mut client = host.client().await;
    assert!(cursor_available(&mut client).await);
    assert!(!marker.exists());
    let root = tempfile::tempdir().unwrap();
    let id = session(&mut client, root.path()).await;
    let python_bin = crate::isolated_python_bin(shadow.path());
    let path = std::env::join_paths([
        shadow.path(),
        python_bin.as_path(),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ])
    .unwrap()
    .into_string()
    .unwrap();
    let environment = latte_work_protocol::AgentEnvironment(std::collections::BTreeMap::from([(
        "PATH".into(),
        path.clone(),
    )]));
    assert!(matches!(
        ask(
            &mut client,
            Request::SendQueued {
                session_id: id.clone(),
                request_id: "pinned-executable".into(),
                text: "private fixture prompt".into(),
                model: Some("cursor-test".into()),
                effort: None,
                permission_mode: None,
                provider: Some(TurnProvider::Configured {
                    provider: None,
                    environment
                }),
            }
        )
        .await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert!(
        !marker.exists(),
        "unverified same-name agent received metadata or prompt"
    );
    let record = &inputs(root.path())[0];
    assert_eq!(record["binary"], agent.to_str().unwrap());
    assert_eq!(
        record["path"], path,
        "configured PATH remains available to CLI dependencies"
    );
}

async fn restart(host: &mut Host, environment: &[(&str, &OsStr)]) {
    host.process.kill().unwrap();
    host.process.wait().unwrap();
    host.process = Host::spawn(host.directory.path(), environment);
    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn cursor_review_offline_cli_can_reconcile_but_cannot_accept_new_input() {
    let fixture_dir = tempfile::tempdir().unwrap();
    let binary = fixture_dir.path().join("cursor-agent");
    install_cursor(&binary);
    let environment = [("LATTE_WORK_CURSOR", binary.as_os_str())];
    let mut host = Host::start_with_environment(&environment).await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    open(&mut client, &id).await;
    std::fs::remove_file(&binary).unwrap();
    assert!(matches!(
        send(&mut client, &id, "offline-original", "never started").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Failed).await;
    drop(client);
    restart(&mut host, &environment).await;
    let mut client = host.client().await;
    assert!(!cursor_available(&mut client).await);
    assert!(matches!(
        send(&mut client, &id, "offline-original", "never started").await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        send(&mut client, &id, "offline-new", "short").await,
        Response::Error { .. }
    ));
    assert!(!root.path().join("cursor-inputs").exists());
    drop(client);
    install_cursor(&binary);
    restart(&mut host, &environment).await;
    let mut client = host.client().await;
    assert!(matches!(
        send(&mut client, &id, "online-retry", "short").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(inputs(root.path()).len(), 1);
}
