use super::*;
use latte_work_protocol::{ComposerPredictionStatus as PredictionStatus, Effort, TurnProvider};

async fn create(client: &mut Client, root: &Path, agent: &str) -> String {
    let Response::Project { project } = ask(
        client,
        Request::AddProject {
            path: root.to_string_lossy().into(),
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
            agent: agent.into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    session.id
}
fn provider(agent: &str) -> TurnProvider {
    serde_json::from_value(serde_json::json!({"kind":"snapshot","snapshot":{"provider":{"id":"prediction-provider","revision":"fixed","name":"Fixture","protocol":if agent == "claude" {"anthropic_messages"} else {"openai_responses"},"base_url":"http://localhost:8000/v1","model":if agent == "claude" {"claude-sonnet-4-6"} else {"custom-codex"},"models":[],"auth":"bearer","has_credential":true},"credential":"prediction-private-key"}})).unwrap()
}
async fn submit(client: &mut Client, session: &str, agent: &str, request: &str, prompt: &str) {
    let response = ask(
        client,
        Request::Send {
            session_id: session.into(),
            request_id: request.into(),
            text: prompt.into(),
            model: Some(
                if agent == "claude" {
                    "claude-sonnet-4-6"
                } else {
                    "custom-codex"
                }
                .into(),
            ),
            effort: if agent == "claude" {
                Some(Effort::High)
            } else {
                None
            },
            permission_mode: None,
            provider: Some(provider(agent)),
        },
    )
    .await;
    assert!(
        matches!(response, Response::Accepted { duplicate: false }),
        "{response:?}"
    );
}
async fn prediction(client: &mut Client, session: &str, expected: PredictionStatus) -> Response {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let response = ask(
            client,
            Request::ComposerPrediction {
                session_id: session.into(),
            },
        )
        .await;
        if matches!(&response, Response::ComposerPrediction { status,.. } if status == &expected) {
            return response;
        }
        assert!(
            Instant::now() < deadline,
            "prediction did not become {expected:?}: {response:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn inputs(root: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(root.join("prediction-inputs"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn composer_predictions_are_isolated_source_bound_read_only_and_not_replayed() {
    for agent in ["codex", "claude"] {
        let root = tempfile::tempdir().unwrap();
        let host = Host::start_with_environment(&[(
            "LATTE_FIXTURE_PREDICTION_ROOT",
            root.path().as_os_str(),
        )])
        .await;
        let mut client = host.client().await;
        assert!(matches!(
            ask(&mut client, Request::Hello { version: VERSION }).await,
            Response::Hello {
                composer_predictions: true,
                ..
            }
        ));
        let id = create(&mut client, root.path(), agent).await;
        prediction(&mut client, &id, PredictionStatus::None).await;
        assert!(inputs(root.path()).is_empty());
        submit(
            &mut client,
            &id,
            agent,
            "source-one",
            "prediction-ready prediction-private-key",
        )
        .await;
        let events = wait(&mut client, &id, Status::Completed).await;
        let ready = prediction(&mut client, &id, PredictionStatus::Ready).await;
        let Response::ComposerPrediction {
            source_request_id: Some(source),
            generation_id: Some(generation),
            suggestion: Some(text),
            ..
        } = &ready
        else {
            panic!("ready")
        };
        assert_eq!(source, "source-one");
        assert_eq!(text, "运行测试并检查结果");
        let mut reconnect = host.client().await;
        for _ in 0..5 {
            assert_eq!(
                serde_json::to_value(
                    ask(
                        &mut reconnect,
                        Request::ComposerPrediction {
                            session_id: id.clone()
                        }
                    )
                    .await
                )
                .unwrap(),
                serde_json::to_value(&ready).unwrap()
            );
        }
        let log = inputs(root.path());
        assert_eq!(log.len(), 1);
        assert_eq!(
            log[0]["effort"],
            if agent == "claude" {
                serde_json::json!("high")
            } else {
                serde_json::Value::Null
            }
        );
        assert_eq!(
            log[0]["model"],
            if agent == "claude" {
                "claude-sonnet-4-6"
            } else {
                "custom-codex"
            }
        );
        assert!(
            !log[0]["description"]
                .as_str()
                .unwrap()
                .contains("prediction-private-key")
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1
        );
        let later = wait(&mut reconnect, &id, Status::Completed).await;
        assert_eq!(
            later
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1
        );
        assert!(!later.iter().any(
            |e| matches!(&e.event,EventKind::Text {text} if text.contains("运行测试并检查结果"))
        ));
        submit(&mut client, &id, agent, "source-two", "prediction-none").await;
        wait(&mut client, &id, Status::Completed).await;
        let none = prediction(&mut client, &id, PredictionStatus::None).await;
        assert!(
            matches!(none,Response::ComposerPrediction {source_request_id:Some(ref source),generation_id:Some(ref current),suggestion:None,..} if source == "source-two" && current != generation)
        );
        assert_eq!(inputs(root.path()).len(), 2);
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: id.clone(),
                only_if_idle: Some(true),
            },
        )
        .await;
        let empty = prediction(&mut client, &id, PredictionStatus::None).await;
        assert!(matches!(
            empty,
            Response::ComposerPrediction {
                source_request_id: None,
                generation_id: None,
                ..
            }
        ));
        assert_eq!(inputs(root.path()).len(), 2);
    }
}

#[tokio::test]
async fn composer_prediction_invalid_tools_fail_without_main_events_and_close_cancels() {
    for agent in ["codex", "claude"] {
        let root = tempfile::tempdir().unwrap();
        let host = Host::start_with_environment(&[(
            "LATTE_FIXTURE_PREDICTION_ROOT",
            root.path().as_os_str(),
        )])
        .await;
        let mut client = host.client().await;
        let id = create(&mut client, root.path(), agent).await;
        submit(&mut client, &id, agent, "bad-source", "prediction-tools").await;
        wait(&mut client, &id, Status::Completed).await;
        prediction(&mut client, &id, PredictionStatus::Failed).await;
        let events = wait(&mut client, &id, Status::Completed).await;
        assert!(!events.iter().any(
            |e| matches!(&e.event,EventKind::Approval {tool,..} if tool == "PREDICTION_UNSAFE")
        ));
        submit(&mut client, &id, agent, "held-source", "prediction-held").await;
        wait(&mut client, &id, Status::Completed).await;
        prediction(&mut client, &id, PredictionStatus::Pending).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while inputs(root.path()).len() < 2 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = inputs(root.path())[1]["pid"].as_i64().unwrap() as i32;
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Ok
        ));
        prediction(&mut client, &id, PredictionStatus::None).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while kill(Pid::from_raw(pid), None).is_ok() {
            assert!(Instant::now() < deadline, "prediction child not reaped");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        std::fs::write(root.path().join("prediction-release"), "release").unwrap();
        prediction(&mut client, &id, PredictionStatus::None).await;
    }
}

#[tokio::test]
async fn composer_predictions_unsupported_agents_and_unknown_native_provider_do_not_generate() {
    for agent in ["traex", "opencode", "claude"] {
        let root = tempfile::tempdir().unwrap();
        let host = Host::start_with_environment(&[(
            "LATTE_FIXTURE_PREDICTION_ROOT",
            root.path().as_os_str(),
        )])
        .await;
        let mut client = host.client().await;
        let id = create(&mut client, root.path(), agent).await;
        if agent != "claude" {
            prediction(&mut client, &id, PredictionStatus::Unsupported).await;
        } else {
            send(&mut client, &id, "cli-only", "prediction-ready").await;
            wait(&mut client, &id, Status::Completed).await;
            prediction(&mut client, &id, PredictionStatus::Unsupported).await;
        }
        assert!(inputs(root.path()).is_empty());
    }
}

#[tokio::test]
async fn composer_prediction_new_turn_archive_and_daemon_restart_invalidate_without_backfill() {
    for agent in ["codex", "claude"] {
        let root = tempfile::tempdir().unwrap();
        let environment = [("LATTE_FIXTURE_PREDICTION_ROOT", root.path().as_os_str())];
        let mut host = Host::start_with_environment(&environment).await;
        let mut client = host.client().await;
        let id = create(&mut client, root.path(), agent).await;
        submit(&mut client, &id, agent, "held-old", "prediction-held").await;
        wait(&mut client, &id, Status::Completed).await;
        prediction(&mut client, &id, PredictionStatus::Pending).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while inputs(root.path()).is_empty() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let old_pid = inputs(root.path())[0]["pid"].as_i64().unwrap() as i32;
        submit(&mut client, &id, agent, "fresh-source", "prediction-ready").await;
        wait(&mut client, &id, Status::Completed).await;
        let fresh = prediction(&mut client, &id, PredictionStatus::Ready).await;
        assert!(
            matches!(fresh, Response::ComposerPrediction { source_request_id:Some(ref source), .. } if source == "fresh-source")
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while kill(Pid::from_raw(old_pid), None).is_ok() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(matches!(
            ask(
                &mut client,
                Request::ArchiveSession {
                    session_id: id.clone(),
                    archived: true
                }
            )
            .await,
            Response::Session { .. }
        ));
        prediction(&mut client, &id, PredictionStatus::None).await;
        ask(
            &mut client,
            Request::ArchiveSession {
                session_id: id.clone(),
                archived: false,
            },
        )
        .await;
        prediction(&mut client, &id, PredictionStatus::None).await;
        drop(client);
        kill(Pid::from_raw(host.process.id() as i32), Signal::SIGINT).unwrap();
        host.process.wait().unwrap();
        host.process = Host::spawn(host.directory.path(), &environment);
        host.wait_ready().await;
        let mut reconnect = host.client().await;
        prediction(&mut reconnect, &id, PredictionStatus::None).await;
        assert_eq!(inputs(root.path()).len(), 2);
    }
}

#[tokio::test]
async fn composer_prediction_native_commands_and_failed_turns_never_schedule() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = create(&mut client, root.path(), "codex").await;
    send(&mut client, &id, "failed-source", "failed").await;
    wait(&mut client, &id, Status::Failed).await;
    prediction(&mut client, &id, PredictionStatus::None).await;
    assert!(inputs(root.path()).is_empty());
    let claude = create(&mut client, root.path(), "claude").await;
    submit(
        &mut client,
        &claude,
        "claude",
        "command-source",
        "/project:check",
    )
    .await;
    wait(&mut client, &claude, Status::Completed).await;
    prediction(&mut client, &claude, PredictionStatus::None).await;
    assert!(inputs(root.path()).is_empty());
}

#[tokio::test]
async fn composer_prediction_ready_and_pending_restart_discard_cache_and_reap_owned_child() {
    let root = tempfile::tempdir().unwrap();
    let environment = [("LATTE_FIXTURE_PREDICTION_ROOT", root.path().as_os_str())];
    let mut host = Host::start_with_environment(&environment).await;
    let mut client = host.client().await;
    let id = create(&mut client, root.path(), "codex").await;
    for (index, (prompt, status)) in [
        ("prediction-ready", PredictionStatus::Ready),
        ("prediction-held", PredictionStatus::Pending),
    ]
    .into_iter()
    .enumerate()
    {
        submit(
            &mut client,
            &id,
            "codex",
            &format!("restart-source-{index}"),
            prompt,
        )
        .await;
        wait(&mut client, &id, Status::Completed).await;
        prediction(&mut client, &id, status).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while inputs(root.path()).len() < index + 1 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = inputs(root.path())[index]["pid"].as_i64().unwrap() as i32;
        drop(client);
        kill(Pid::from_raw(host.process.id() as i32), Signal::SIGINT).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while host.process.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "graceful daemon shutdown timed out"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while kill(Pid::from_raw(pid), None).is_ok() {
            assert!(
                Instant::now() < deadline,
                "owned prediction child survived graceful restart"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        host.process = Host::spawn(host.directory.path(), &environment);
        host.wait_ready().await;
        client = host.client().await;
        let none = prediction(&mut client, &id, PredictionStatus::None).await;
        assert!(matches!(
            none,
            Response::ComposerPrediction {
                source_request_id: None,
                generation_id: None,
                ..
            }
        ));
        for _ in 0..3 {
            prediction(&mut client, &id, PredictionStatus::None).await;
        }
        assert_eq!(
            inputs(root.path()).len(),
            index + 1,
            "restart/read must not replay generation"
        );
    }
}
