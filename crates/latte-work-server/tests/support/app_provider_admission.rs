//! AppProvider admission regression on real sockets and the account-free Codex fixture.
use super::*;

fn app_provider_catalog(app: &Path, provider_id: Option<String>, models: Vec<String>) -> String {
    use latte_work_config::ProviderStore;
    use latte_work_protocol::{ProviderAuth, ProviderDraft, ProviderProtocol};
    let mut store = ProviderStore::open(app, None).unwrap();
    let response = store
        .save(ProviderDraft {
            id: provider_id,
            name: "App admission fixture".into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: "http://localhost:8000/v1".into(),
            model: "custom-codex".into(),
            models,
            models_1m: Default::default(),
            model_labels: Default::default(),
            auth: ProviderAuth::Bearer,
            credential: Some("account-free-fixture-key".into()),
        })
        .unwrap();
    let Response::Providers { providers, .. } = response else {
        panic!("provider")
    };
    let id = providers[0].id.clone();
    store
        .bind("app-fixture-host", "codex", Some(id.clone()))
        .unwrap();
    id
}

fn app_send(session: &str, request: &str, model: &str, text: &str, queued: bool) -> Request {
    if queued {
        Request::SendQueued {
            session_id: session.into(),
            request_id: request.into(),
            text: text.into(),
            model: Some(model.into()),
            effort: None,
            permission_mode: None,
            provider: None,
        }
    } else {
        Request::Send {
            session_id: session.into(),
            request_id: request.into(),
            text: text.into(),
            model: Some(model.into()),
            effort: None,
            permission_mode: None,
            provider: None,
        }
    }
}

fn app_identity_counts(host: &Host, request: &str) -> (u32, u32, u32) {
    // Same two-ledger + User evidence as prediction_admission; neither ledger
    // can be inferred from the session's visible status or pending queue alone.
    rusqlite::Connection::open(host.directory.path().join("state.sqlite"))
        .unwrap()
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

#[tokio::test]
async fn app_provider_removed_model_is_not_admitted_then_valid_new_id_runs_once() {
    use latte_work_client::request_with_app_provider;
    use latte_work_config::ProviderStore;
    use tokio::sync::Mutex;
    for queued in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let provider_id = app_provider_catalog(app.path(), None, vec!["retired-codex".into()]);
        let app_path = app.path();
        let resolve = |agent: String| async move {
            ProviderStore::open(app_path, None)?.snapshot_for_host("app-fixture-host", &agent)
        };
        let target = Mutex::new(host.client().await);
        let mut client = host.client().await;
        let id = session(&mut client, root.path()).await;
        // Desktop retains this catalog if its next refresh fails; Send still
        // resolves the latest AppProvider snapshot, not the cached metadata.
        let cached = request_with_app_provider(
            &target,
            Request::Models {
                agent: "codex".into(),
                model: Some("retired-codex".into()),
                project_id: None,
            },
            resolve,
        )
        .await
        .unwrap();
        assert!(
            matches!(cached, Response::Models { models, .. } if models.contains(&"retired-codex".into()))
        );
        app_provider_catalog(app.path(), Some(provider_id), vec![]);
        let response = request_with_app_provider(
            &target,
            app_send(
                &id,
                "removed-app-model",
                "retired-codex",
                "never execute",
                queued,
            ),
            resolve,
        )
        .await
        .unwrap();
        assert_eq!(app_identity_counts(&host, "removed-app-model"), (0, 0, 0));
        assert!(
            matches!(ask(&mut client, Request::Poll { session_id: id.clone(), after: 0.0 }).await,
            Response::Events { events, .. } if events.is_empty())
        );
        assert!(
            matches!(ask(&mut client, Request::MessageQueue { session_id: id.clone() }).await,
            Response::MessageQueue { entries, .. } if entries.is_empty())
        );
        for record in [
            "codex-inputs",
            "codex-opens",
            "prediction-inputs",
            "codex-title-inputs",
        ] {
            assert!(
                !root.path().join(record).exists(),
                "{record} must remain absent"
            );
        }
        assert!(
            matches!(&response, Response::Error { code, message }
            if code == "send_not_admitted" && message.contains("模型不在当前 Provider 的可选列表中")),
            "real AppProvider turn_config rejection, requests/queue/User=(0,0,0), native prompts=0: {response:?}"
        );
        let valid = app_send(&id, "valid-app-model", "custom-codex", "hello", queued);
        assert!(matches!(
            request_with_app_provider(&target, valid.clone(), resolve)
                .await
                .unwrap(),
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &id, Status::Completed).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(&event.event,
            EventKind::Text { text } if text == "CODEX:hello"))
                .count(),
            1
        );
        assert!(matches!(
            request_with_app_provider(&target, valid, resolve)
                .await
                .unwrap(),
            Response::Accepted { duplicate: true }
        ));
        // A durable same ID must not acquire the new rejection code, even when
        // the changed selection fails before submit_reserved sees the replay.
        let known = request_with_app_provider(
            &target,
            app_send(&id, "valid-app-model", "retired-codex", "hello", true),
            resolve,
        )
        .await
        .unwrap();
        assert!(matches!(known, Response::Error { code, .. } if code == "request_failed"));
        assert_eq!(app_identity_counts(&host, "removed-app-model"), (0, 0, 0));
        assert_eq!(app_identity_counts(&host, "valid-app-model"), (1, 0, 1));
        assert_eq!(
            std::fs::read_to_string(root.path().join("codex-inputs"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert!(!host.directory.path().join("providers.json").exists());
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id,
                    only_if_idle: Some(true),
                }
            )
            .await,
            Response::Ok
        ));
    }
}

#[tokio::test]
async fn app_provider_removed_model_keeps_queue_and_tombstone_identities_generic() {
    use latte_work_client::request_with_app_provider;
    use latte_work_config::ProviderStore;
    use tokio::sync::Mutex;
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let app = tempfile::tempdir().unwrap();
    let provider_id = app_provider_catalog(app.path(), None, vec!["retired-codex".into()]);
    let app_path = app.path();
    let resolve = |agent: String| async move {
        ProviderStore::open(app_path, None)?.snapshot_for_host("app-fixture-host", &agent)
    };
    let target = Mutex::new(host.client().await);
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        request_with_app_provider(
            &target,
            app_send(&id, "app-active", "custom-codex", "wait", true),
            resolve,
        )
        .await
        .unwrap(),
        Response::Accepted { duplicate: false }
    ));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if matches!(ask(&mut client, Request::Poll { session_id: id.clone(), after: 0.0 }).await,
            Response::Events { events, .. } if events.iter().any(|event| matches!(&event.event,
                EventKind::Text { text } if text == "WAITING")))
        {
            break;
        }
        assert!(Instant::now() < deadline, "fixture waiting timeout");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(matches!(
        request_with_app_provider(
            &target,
            app_send(&id, "app-queued", "custom-codex", "hello", true),
            resolve,
        )
        .await
        .unwrap(),
        Response::MessageQueued { duplicate: false }
    ));
    app_provider_catalog(app.path(), Some(provider_id), vec![]);
    for status in ["pending", "cancelled"] {
        if status == "cancelled" {
            assert!(matches!(
                ask(
                    &mut client,
                    Request::ClearMessageQueue {
                        session_id: id.clone()
                    }
                )
                .await,
                Response::MessageQueue { .. }
            ));
        }
        let response = request_with_app_provider(
            &target,
            app_send(&id, "app-queued", "retired-codex", "hello", true),
            resolve,
        )
        .await
        .unwrap();
        assert!(
            matches!(&response, Response::Error { code, message }
            if code == "request_failed" && message.contains("模型不在当前 Provider 的可选列表中")),
            "{response:?}"
        );
        assert_eq!(app_identity_counts(&host, "app-queued"), (0, 1, 0));
        let stored: String = rusqlite::Connection::open(host.directory.path().join("state.sqlite"))
            .unwrap()
            .query_row(
                "SELECT status FROM message_queue WHERE request_id='app-queued'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, status);
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("codex-inputs"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::Cancel {
                session_id: id.clone()
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut client, &id, Status::Stopped).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: id,
                only_if_idle: Some(true),
            }
        )
        .await,
        Response::Ok
    ));
}
