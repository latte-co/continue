//! Final-binary admission evidence: real sockets and existing account-free fixtures.
use super::*;
use latte_work_protocol::{Effort, TurnProvider};

async fn create(client: &mut Client, root: &Path) -> String {
    let Response::Project { project } = ask(
        client,
        Request::AddProject {
            path: root.to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    else {
        panic!("project")
    };
    let Response::Session { session } = ask(
        client,
        Request::CreateSession {
            project_id: project.id,
            agent: "codex".into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    session.id
}

fn send_request(session: &str, request: &str, text: &str, queued: bool) -> Request {
    configured_request(session, request, text, queued, None)
}

fn native_request(
    session: &str,
    request: &str,
    model: &str,
    effort: Option<Effort>,
    queued: bool,
) -> Request {
    configured_request(session, request, "hello", queued, Some((model, effort)))
}

fn configured_request(
    session: &str,
    request: &str,
    text: &str,
    queued: bool,
    selection: Option<(&str, Option<Effort>)>,
) -> Request {
    let (model, effort) =
        selection.map_or((None, None), |(model, effort)| (Some(model.into()), effort));
    if queued {
        Request::SendQueued {
            session_id: session.into(),
            request_id: request.into(),
            text: text.into(),
            model,
            effort,
            permission_mode: None,
            provider: Some(TurnProvider::Cli),
        }
    } else {
        Request::Send {
            session_id: session.into(),
            request_id: request.into(),
            text: text.into(),
            model,
            effort,
            permission_mode: None,
            provider: Some(TurnProvider::Cli),
        }
    }
}

fn catalog(root: &Path, models: &[&str]) {
    std::fs::write(
        root.join("codex-catalog.json"),
        serde_json::to_vec(models).unwrap(),
    )
    .unwrap();
}

fn catalog_reads(root: &Path) -> usize {
    fixture_records(root, "codex-catalog-reads")
}

fn fixture_records(root: &Path, record: &str) -> usize {
    std::fs::read_to_string(root.join(record))
        .unwrap()
        .lines()
        .count()
}

fn assert_native_rejection(response: Response, code: &str, message: &str) {
    assert!(
        matches!(&response, Response::Error { code: actual, message: detail } if actual == code && detail.contains(message)),
        "{response:?}"
    );
}

async fn assert_no_native_admission(
    host: &Host,
    client: &mut Client,
    root: &Path,
    session: &str,
    request: &str,
) {
    assert_eq!(identity_counts(host, request), (0, 0, 0));
    let Response::Events { events, .. } = ask(
        client,
        Request::Poll {
            session_id: session.into(),
            after: 0.0,
        },
    )
    .await
    else {
        panic!("events")
    };
    assert!(
        events.is_empty(),
        "pre-admission rejection must not append User/terminal events: {events:?}"
    );
    assert!(!root.join("codex-inputs").exists());
    assert!(!root.join("codex-opens").exists());
    assert!(!root.join("prediction-inputs").exists());
    assert!(!root.join("codex-title-inputs").exists());
}

#[tokio::test]
async fn native_model_and_effort_rejections_are_not_admitted_for_send_and_send_queued() {
    for queued in [false, true] {
        for (model, effort, message) in [
            ("missing-model", None, "模型不在当前 Codex 可选列表中"),
            (
                "codex-test",
                Some(Effort::Medium),
                "此 Codex 模型不支持所选思考强度",
            ),
        ] {
            let host = Host::start().await;
            let root = tempfile::tempdir().unwrap();
            catalog(root.path(), &["codex-test"]);
            let mut client = host.client().await;
            let session = create(&mut client, root.path()).await;
            let response = ask(
                &mut client,
                native_request(&session, "native-rejected", model, effort, queued),
            )
            .await;
            assert_eq!(
                catalog_reads(root.path()),
                1,
                "real resolver metadata probe"
            );
            assert_native_rejection(response, "send_not_admitted", message);
            assert_no_native_admission(
                &host,
                &mut client,
                root.path(),
                &session,
                "native-rejected",
            )
            .await;
        }
    }
}

#[tokio::test]
async fn native_catalog_removal_rejects_selected_model_then_new_valid_id_completes() {
    for queued in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        catalog(root.path(), &["codex-test", "retired-codex"]);
        let mut client = host.client().await;
        let session = create(&mut client, root.path()).await;
        let Response::Session { session: current } = ask(
            &mut client,
            Request::Session {
                session_id: session.clone(),
            },
        )
        .await
        else {
            panic!("session")
        };
        let response = ask(
            &mut client,
            Request::Models {
                project_id: Some(current.project_id),
                agent: "codex".into(),
                model: Some("retired-codex".into()),
            },
        )
        .await;
        assert!(
            matches!(response, Response::Models { models, .. } if models.contains(&"retired-codex".into()))
        );
        assert_eq!(catalog_reads(root.path()), 1);
        catalog(root.path(), &["codex-test"]);
        let response = ask(
            &mut client,
            native_request(&session, "removed-model", "retired-codex", None, queued),
        )
        .await;
        assert_eq!(
            catalog_reads(root.path()),
            2,
            "Send must re-read the current native catalog"
        );
        assert_native_rejection(
            response,
            "send_not_admitted",
            "模型不在当前 Codex 可选列表中",
        );
        assert_no_native_admission(&host, &mut client, root.path(), &session, "removed-model")
            .await;
        let response = ask(
            &mut client,
            native_request(
                &session,
                "valid-new-id",
                "codex-test",
                Some(Effort::Low),
                queued,
            ),
        )
        .await;
        assert!(
            matches!(response, Response::Accepted { duplicate: false }),
            "{response:?}"
        );
        let events = wait(&mut client, &session, Status::Completed).await;
        assert!(events.iter().any(
            |event| matches!(&event.event, EventKind::Text { text } if text == "CODEX:hello")
        ));
        assert_eq!(identity_counts(&host, "removed-model"), (0, 0, 0));
        assert_eq!(identity_counts(&host, "valid-new-id"), (1, 0, 1));
        assert_eq!(fixture_records(root.path(), "codex-inputs"), 1);
    }
}

#[tokio::test]
async fn native_model_rejection_keeps_admitted_and_queue_tombstone_identities_generic() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    let response = ask(
        &mut client,
        send_request(&session, "reserved-queue", "hello", true),
    )
    .await;
    assert!(matches!(
        response,
        Response::MessageQueued { duplicate: false }
    ));
    catalog(root.path(), &["codex-test"]);
    for (index, (request, counts, status)) in [
        ("active", (1, 0, 1), None),
        ("reserved-queue", (0, 1, 0), Some("pending")),
        ("reserved-queue", (0, 1, 0), Some("cancelled")),
    ]
    .into_iter()
    .enumerate()
    {
        if status == Some("cancelled") {
            ask(
                &mut client,
                Request::ClearMessageQueue {
                    session_id: session.clone(),
                },
            )
            .await;
        }
        let response = ask(
            &mut client,
            native_request(&session, request, "missing-model", None, true),
        )
        .await;
        assert_eq!(catalog_reads(root.path()), index + 1);
        assert_native_rejection(response, "request_failed", "模型不在当前 Codex 可选列表中");
        assert_eq!(identity_counts(&host, request), counts);
        if let Some(status) = status {
            assert_eq!(queue_status(&host, request), status);
        }
    }
    assert_eq!(fixture_records(root.path(), "codex-inputs"), 1);
}

fn snapshot_provider() -> TurnProvider {
    serde_json::from_value(serde_json::json!({
        "kind": "snapshot", "snapshot": {
            "provider": {
                "id": "admission-fixture", "name": "Fixture", "protocol": "openai_responses",
                "base_url": "http://localhost:8000/v1", "model": "custom-codex",
                "models": [], "auth": "bearer", "has_credential": true
            },
            "credential": "admission-fixture-not-a-real-key"
        }
    }))
    .unwrap()
}

fn assert_code(response: Response, expected: &str) {
    assert!(
        matches!(&response, Response::Error { code, .. } if code == expected),
        "{response:?}"
    );
}

fn database(host: &Host) -> rusqlite::Connection {
    rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap()
}

fn identity_counts(host: &Host, request: &str) -> (u32, u32, u32) {
    database(host)
        .query_row(
            "SELECT (SELECT COUNT(*) FROM requests WHERE id=?1),
                (SELECT COUNT(*) FROM message_queue WHERE request_id=?1),
                (SELECT COUNT(*) FROM events WHERE json_extract(data,'$.kind')='user'
                    AND json_extract(data,'$.request_id')=?1)",
            [request],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn queue_status(host: &Host, request: &str) -> String {
    database(host)
        .query_row(
            "SELECT status FROM message_queue WHERE request_id=?1",
            [request],
            |row| row.get(0),
        )
        .unwrap()
}

async fn wait_for_waiting(client: &mut Client, session: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let response = ask(
            client,
            Request::Poll {
                session_id: session.into(),
                after: 0.0,
            },
        )
        .await;
        if matches!(&response, Response::Events { events, .. } if events.iter().any(|event| matches!(&event.event, EventKind::Text { text } if text == "WAITING")))
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "fixture never entered wait: {response:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn start_waiting(host: &Host, client: &mut Client, root: &Path) -> String {
    let session = create(client, root).await;
    let response = ask(client, send_request(&session, "active", "wait", false)).await;
    assert!(
        matches!(response, Response::Accepted { duplicate: false }),
        "{response:?}"
    );
    wait_for_waiting(client, &session).await;
    assert_eq!(identity_counts(host, "active"), (1, 0, 1));
    session
}

#[tokio::test]
async fn busy_send_is_explicitly_not_admitted_without_user_or_ledger_write() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    let response = ask(
        &mut client,
        send_request(&session, "busy-rejected", "supplement", false),
    )
    .await;
    assert_code(response, "send_not_admitted");
    assert_eq!(identity_counts(&host, "busy-rejected"), (0, 0, 0));
    assert_eq!(identity_counts(&host, "active"), (1, 0, 1));
    let Response::Events { events, .. } = ask(
        &mut client,
        Request::Poll {
            session_id: session,
            after: 0.0,
        },
    )
    .await
    else {
        panic!("events")
    };
    assert!(!events.iter().any(|event| matches!(&event.event, EventKind::User { request_id, .. } if request_id == "busy-rejected")));
}

#[tokio::test]
async fn unsupported_effort_is_explicitly_not_admitted_before_native_start() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = create(&mut client, root.path()).await;
    let response = ask(
        &mut client,
        Request::Send {
            session_id: session,
            request_id: "effort-rejected".into(),
            text: "never execute".into(),
            model: None,
            effort: Some(Effort::High),
            permission_mode: None,
            provider: Some(snapshot_provider()),
        },
    )
    .await;
    assert_code(response, "send_not_admitted");
    assert_eq!(identity_counts(&host, "effort-rejected"), (0, 0, 0));
    assert!(!root.path().join("codex-inputs").exists());
    assert!(!root.path().join("codex-opens").exists());
}

#[tokio::test]
async fn admitted_identity_and_provider_conflicts_remain_request_failed() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    assert_code(
        ask(
            &mut client,
            send_request(&session, "active", "different", false),
        )
        .await,
        "request_failed",
    );
    let response = ask(
        &mut client,
        Request::Send {
            session_id: session.clone(),
            request_id: "active".into(),
            text: "wait".into(),
            model: None,
            effort: None,
            permission_mode: None,
            provider: Some(snapshot_provider()),
        },
    )
    .await;
    assert_code(response, "request_failed");
    let response = ask(
        &mut client,
        Request::Send {
            session_id: session.clone(),
            request_id: "active".into(),
            text: "wait".into(),
            model: None,
            effort: Some(Effort::High),
            permission_mode: None,
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert_code(response, "request_failed");
    assert_eq!(identity_counts(&host, "active"), (1, 0, 1));
    assert!(matches!(
        ask(&mut client, send_request(&session, "active", "wait", false)).await,
        Response::Accepted { duplicate: true }
    ));
    assert_eq!(
        std::fs::read_to_string(root.path().join("codex-inputs"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[tokio::test]
async fn queue_capacity_rejections_are_not_admitted_and_tombstones_still_reserve_ids() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    for index in 0..16 {
        let response = ask(
            &mut client,
            send_request(&session, &format!("queued-{index}"), "hello", true),
        )
        .await;
        assert!(
            matches!(response, Response::MessageQueued { duplicate: false }),
            "{response:?}"
        );
    }
    assert_code(
        ask(
            &mut client,
            send_request(&session, "count-overflow", "hello", true),
        )
        .await,
        "send_not_admitted",
    );
    assert_eq!(identity_counts(&host, "count-overflow"), (0, 0, 0));
    assert_code(
        ask(
            &mut client,
            send_request(&session, "queued-0", "different", true),
        )
        .await,
        "request_failed",
    );
    assert_eq!(identity_counts(&host, "queued-0"), (0, 1, 0));
    let response = ask(
        &mut client,
        Request::ClearMessageQueue {
            session_id: session.clone(),
        },
    )
    .await;
    assert!(matches!(response, Response::MessageQueue { entries, .. } if entries.is_empty()));
    assert_code(
        ask(
            &mut client,
            send_request(&session, "queued-0", "hello", true),
        )
        .await,
        "request_failed",
    );
    assert_eq!(queue_status(&host, "queued-0"), "cancelled");
    for index in 0..3 {
        let response = ask(
            &mut client,
            send_request(
                &session,
                &format!("large-{index}"),
                &"x".repeat(128 * 1024),
                true,
            ),
        )
        .await;
        assert!(
            matches!(response, Response::MessageQueued { duplicate: false }),
            "{response:?}"
        );
    }
    assert_code(
        ask(
            &mut client,
            send_request(&session, "bytes-overflow", &"x".repeat(128 * 1024), true),
        )
        .await,
        "send_not_admitted",
    );
    assert_eq!(identity_counts(&host, "bytes-overflow"), (0, 0, 0));
    let Response::MessageQueue { entries, .. } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: session,
        },
    )
    .await
    else {
        panic!("queue")
    };
    assert_eq!(entries.len(), 3);
}

async fn dispatch(client: &mut Client, session: &str, request: &str, text: &str) {
    let response = ask(client, send_request(session, request, text, true)).await;
    assert!(
        matches!(response, Response::MessageQueued { duplicate: false }),
        "{response:?}"
    );
    let response = ask(
        client,
        Request::DispatchQueuedMessage {
            session_id: session.into(),
            request_id: request.into(),
            revision: 0,
            interrupt: false,
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert!(
        matches!(response, Response::MessageQueue { .. }),
        "{response:?}"
    );
}

async fn wait_for_held_handoff(client: &mut Client, root: &Path, session: &str, request: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let response = ask(
            client,
            Request::Poll {
                session_id: session.into(),
                after: 0.0,
            },
        )
        .await;
        if root.join("steer-completion-held").exists()
            && matches!(&response, Response::Events { events, .. } if events.iter().any(|event| matches!(&event.event, EventKind::Text { text } if text == "STEER:hold-steer"))
                && events.iter().any(|event| matches!(&event.event, EventKind::QueuedMessageSent { request_id, text } if request_id == request && text == "hold-steer")))
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "native ack not observed: {response:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn codex_successful_native_steer_has_receipt_but_no_durable_user_turn() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    dispatch(&mut client, &session, "steered", "hold-steer").await;
    wait_for_held_handoff(&mut client, root.path(), &session, "steered").await;
    // A matching receipt/native ack is evidence of handoff, not consumption.
    assert_eq!(queue_status(&host, "steered"), "forwarded");
    assert_eq!(identity_counts(&host, "steered"), (0, 1, 0));
    std::fs::write(root.path().join("steer-completion-release"), "release").unwrap();
    let events = wait(&mut client, &session, Status::Completed).await;
    assert!(events.iter().any(|event| matches!(&event.event, EventKind::QueuedMessageSent { request_id, text } if request_id == "steered" && text == "hold-steer")));
    assert!(events.iter().any(
        |event| matches!(&event.event, EventKind::Text { text } if text == "STEER:hold-steer")
    ));
    assert!(!events.iter().any(|event| matches!(&event.event, EventKind::User { request_id, .. } if request_id == "steered")));
    assert_eq!(identity_counts(&host, "steered"), (0, 1, 0));
    assert_eq!(queue_status(&host, "steered"), "dispatched");
    assert!(matches!(
        ask(
            &mut client,
            send_request(&session, "steered", "hold-steer", true)
        )
        .await,
        Response::Accepted { duplicate: true }
    ));
    assert_eq!(
        std::fs::read_to_string(root.path().join("codex-inputs"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[tokio::test]
async fn codex_acknowledged_handoff_interrupted_by_daemon_restart_stays_uncertain() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    dispatch(&mut client, &session, "interrupted-steer", "hold-steer").await;
    wait_for_held_handoff(&mut client, root.path(), &session, "interrupted-steer").await;
    assert_eq!(queue_status(&host, "interrupted-steer"), "forwarded");
    assert_eq!(identity_counts(&host, "interrupted-steer"), (0, 1, 0));
    // Daemon SIGKILL cannot reap its native fixture. Keep explicit cleanup on
    // every test exit without pretending that process shutdown consumed input.
    struct FixtureProcess(Pid);
    impl Drop for FixtureProcess {
        fn drop(&mut self) {
            let _ = kill(self.0, Signal::SIGTERM);
        }
    }
    let opens = std::fs::read_to_string(root.path().join("codex-opens")).unwrap();
    let native: serde_json::Value = serde_json::from_str(opens.lines().next().unwrap()).unwrap();
    let native = FixtureProcess(Pid::from_raw(
        i32::try_from(native["pid"].as_i64().unwrap()).unwrap(),
    ));
    drop(client);
    host.process.kill().unwrap();
    host.process.wait().unwrap();
    drop(native);
    host.process = Host::spawn(host.directory.path(), &[]);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(socket) =
            tokio::net::UnixStream::connect(host.directory.path().join("control.sock")).await
        {
            drop(socket);
            break;
        }
        assert!(Instant::now() < deadline, "restarted daemon not ready");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut client = host.client().await;
    let Response::MessageQueue {
        entries, paused, ..
    } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: session.clone(),
        },
    )
    .await
    else {
        panic!("queue")
    };
    assert!(paused);
    assert!(
        entries.is_empty(),
        "uncertain handoff must not become pending"
    );
    assert_eq!(queue_status(&host, "interrupted-steer"), "uncertain");
    assert_eq!(identity_counts(&host, "interrupted-steer"), (0, 1, 0));
    let Response::Session { session: current } = ask(
        &mut client,
        Request::Session {
            session_id: session.clone(),
        },
    )
    .await
    else {
        panic!("session")
    };
    assert_eq!(current.status, Status::Unknown);
    assert!(matches!(
        ask(
            &mut client,
            send_request(&session, "interrupted-steer", "hold-steer", true)
        )
        .await,
        Response::Accepted { duplicate: true }
    ));
    assert_eq!(queue_status(&host, "interrupted-steer"), "uncertain");
    assert_eq!(
        std::fs::read_to_string(root.path().join("codex-inputs"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(!root.path().join("steer-completion-release").exists());
}

#[tokio::test]
async fn codex_definitive_native_steer_rejection_restores_pending_revision_without_user() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let session = start_waiting(&host, &mut client, root.path()).await;
    dispatch(&mut client, &session, "rejected-steer", "reject-steer").await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let response = ask(
            &mut client,
            Request::MessageQueue {
                session_id: session.clone(),
            },
        )
        .await;
        if let Response::MessageQueue {
            entries,
            paused: true,
            ..
        } = &response
            && entries.iter().any(|entry| {
                entry.request_id == "rejected-steer"
                    && entry.revision == 1
                    && entry.text == "reject-steer"
            })
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "rejection not restored: {response:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(identity_counts(&host, "rejected-steer"), (0, 1, 0));
    assert_eq!(queue_status(&host, "rejected-steer"), "pending");
    assert_code(
        ask(
            &mut client,
            Request::DispatchQueuedMessage {
                session_id: session,
                request_id: "rejected-steer".into(),
                revision: 0,
                interrupt: false,
                provider: Some(TurnProvider::Cli),
            },
        )
        .await,
        "request_failed",
    );
}
