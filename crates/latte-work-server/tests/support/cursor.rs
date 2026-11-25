use super::*;
use latte_work_protocol::TurnProvider;

#[path = "cursor_merge.rs"]
mod merge;
#[path = "cursor_review.rs"]
mod review;

async fn session(client: &mut Client, path: &Path) -> String {
    let Response::Project { project } = ask(
        client,
        Request::AddProject {
            path: path.to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    else {
        panic!("project")
    };
    let response = ask(
        client,
        Request::CreateSession {
            project_id: project.id,
            agent: "cursor".into(),
        },
    )
    .await;
    let Response::Session { session } = response else {
        panic!("Cursor session: {response:?}")
    };
    session.id
}

async fn send(client: &mut Client, id: &str, request: &str, text: &str) -> Response {
    ask(
        client,
        Request::SendQueued {
            session_id: id.into(),
            request_id: request.into(),
            text: text.into(),
            model: None,
            effort: None,
            permission_mode: None,
            provider: Some(TurnProvider::Cli),
        },
    )
    .await
}

async fn current(client: &mut Client, id: &str) -> latte_work_protocol::Session {
    let Response::Session { session } = ask(
        client,
        Request::Session {
            session_id: id.into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    session
}

async fn file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "fixture file: {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn inputs(root: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(root.join("cursor-inputs"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn open(client: &mut Client, id: &str) {
    assert!(matches!(
        ask(
            client,
            Request::OpenAgentSession {
                session_id: id.into(),
                provider: Some(TurnProvider::Cli),
            }
        )
        .await,
        Response::Ok
    ));
    assert_eq!(current(client, id).await.agent_session_open, Some(false));
}

#[tokio::test]
async fn cursor_catalog_open_and_two_process_turns_preserve_native_identity() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let Response::Hello { agents, .. } =
        ask(&mut client, Request::Hello { version: VERSION }).await
    else {
        panic!("hello")
    };
    let cursor = agents.iter().find(|agent| agent.id == "cursor").unwrap();
    assert!(cursor.available);
    assert_eq!(cursor.name, "Cursor Agent");
    assert!(cursor.provider_protocols.is_empty());
    let id = session(&mut client, root.path()).await;
    open(&mut client, &id).await;
    assert!(current(&mut client, &id).await.native_id.is_none());
    assert!(!root.path().join("cursor-inputs").exists());
    assert!(matches!(
        ask(&mut client, Request::Poll { session_id: id.clone(), after: 0.0 }).await,
        Response::Events { events, .. } if events.is_empty()
    ));
    assert!(matches!(
        send(&mut client, &id, "one", "first").await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                &event.event, EventKind::Text { text } if text == "CURSOR:first"
            ))
            .count(),
        1
    );
    assert!(events.iter().any(|event| matches!(
        &event.event,
        EventKind::ToolResult {
            is_error: false,
            ..
        }
    )));
    let first = current(&mut client, &id).await;
    assert_eq!(first.native_id.as_deref(), Some("cursor-native-session"));
    assert_eq!(first.agent_session_open, Some(false));
    drop(client);
    let mut client = host.client().await;
    assert!(matches!(
        send(&mut client, &id, "one", "first").await,
        Response::Accepted { duplicate: true }
    ));
    open(&mut client, &id).await;
    assert!(matches!(
        send(&mut client, &id, "two", "second").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let records = inputs(root.path());
    assert_eq!(records.len(), 2);
    assert_ne!(records[0]["pid"], records[1]["pid"]);
    assert!(records[0]["resume"].is_null());
    assert_eq!(records[1]["resume"], "cursor-native-session");
    assert_eq!(records[1]["prompt"], "second");
    assert!(!root.path().join("cursor-active").exists());
}

#[tokio::test]
async fn cursor_fifo_waits_for_result_and_process_exit() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "one", "delayed-exit").await;
    file(&root.path().join("cursor-result-emitted")).await;
    assert_eq!(current(&mut client, &id).await.status, Status::Running);
    assert!(matches!(
        send(&mut client, &id, "two", "second").await,
        Response::MessageQueued { .. }
    ));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(inputs(root.path()).len(), 1);
    assert_eq!(current(&mut client, &id).await.status, Status::Running);
    std::fs::write(root.path().join("cursor-release"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let state = current(&mut client, &id).await;
        if inputs(root.path()).len() == 2 && state.status == Status::Completed {
            break;
        }
        assert!(Instant::now() < deadline, "queue did not drain: {state:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(inputs(root.path())[1]["resume"], "cursor-native-session");
}

#[tokio::test]
async fn cursor_eof_nonzero_and_invalid_output_never_become_success() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    for (n, prompt) in [
        "eof",
        "nonzero",
        "malformed",
        "wrong-session",
        "oversize",
        "unframed",
    ]
    .iter()
    .enumerate()
    {
        let request = format!("error-{n}");
        assert!(matches!(
            send(&mut client, &id, &request, prompt).await,
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &id, Status::Failed).await;
        let final_state = events.iter().rev().find_map(|event| match &event.event {
            EventKind::State { status, .. } => Some(status.clone()),
            _ => None,
        });
        assert_eq!(final_state, Some(Status::Failed));
        assert_eq!(
            current(&mut client, &id).await.native_id.as_deref(),
            Some("cursor-native-session")
        );
        assert!(matches!(
            send(&mut client, &id, &request, prompt).await,
            Response::Accepted { duplicate: true }
        ));
    }
    assert_eq!(inputs(root.path()).len(), 6);
    let Response::Events { events, .. } = ask(
        &mut client,
        Request::Poll {
            session_id: id,
            after: 0.0,
        },
    )
    .await
    else {
        panic!("events")
    };
    assert!(!events.iter().any(|event| matches!(
        &event.event, EventKind::Text { text } if text == "WRONG"
    )));
}

#[tokio::test]
async fn cursor_stop_retains_id_and_unsupported_steering_preserves_queue() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "hold", "hold").await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while current(&mut client, &id).await.native_id.is_none() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(matches!(
        send(&mut client, &id, "queued", "second").await,
        Response::MessageQueued { .. }
    ));
    let Response::MessageQueue { entries, .. } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("queue")
    };
    let queued = &entries[0];
    assert!(matches!(
        ask(
            &mut client,
            Request::DispatchQueuedMessage {
                interrupt: false,
                session_id: id.clone(),
                request_id: queued.request_id.clone(),
                revision: queued.revision,
                provider: Some(TurnProvider::Cli),
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert_eq!(inputs(root.path()).len(), 1);
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
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some("cursor-native-session")
    );
    assert!(!root.path().join("cursor-active").exists());
    assert!(matches!(
        ask(
            &mut client,
            Request::ResumeMessageQueue {
                session_id: id.clone(),
                provider: Some(TurnProvider::Cli),
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(inputs(root.path()).len(), 2);
    assert_eq!(inputs(root.path())[1]["resume"], "cursor-native-session");
}

#[tokio::test]
async fn cursor_pre_init_stop_cannot_silently_create_replacement_session() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "one", "before-init").await;
    file(&root.path().join("cursor-active")).await;
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
    assert!(current(&mut client, &id).await.native_id.is_none());
    assert!(matches!(
        send(&mut client, &id, "two", "second").await,
        Response::Error { .. }
    ));
    assert_eq!(inputs(root.path()).len(), 1);
}

#[tokio::test]
async fn cursor_result_only_and_flag_like_prompt_are_native_inputs() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    for (request, prompt) in [("one", "result-only"), ("two", "--force do not interpret")] {
        assert!(matches!(
            send(&mut client, &id, request, prompt).await,
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &id, Status::Completed).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    &event.event, EventKind::Text { text } if text == &format!("CURSOR:{prompt}")
                ))
                .count(),
            1
        );
    }
    assert_eq!(inputs(root.path())[1]["prompt"], "--force do not interpret");
}

#[tokio::test]
async fn cursor_prepared_session_can_close_archive_and_reopen_without_prompt() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    open(&mut client, &id).await;
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
    assert!(matches!(
        ask(
            &mut client,
            Request::ArchiveSession {
                session_id: id.clone(),
                archived: true,
            }
        )
        .await,
        Response::Session { session } if session.archived && session.agent_session_open == Some(false)
    ));
    assert!(!root.path().join("cursor-inputs").exists());
}

#[tokio::test]
async fn cursor_models_and_unsupported_overrides_are_host_owned() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    let catalog = ask(
        &mut client,
        Request::Models {
            agent: "cursor".into(),
            model: Some("cursor-test".into()),
            project_id: None,
        },
    )
    .await;
    assert!(matches!(catalog,
        Response::Models { models, effort_levels, model_labels, .. }
        if models == ["cursor-test"] && effort_levels.is_empty()
            && model_labels["cursor-test"] == "Cursor Test"));
    for (request, model, effort, permission_mode) in [
        ("model", Some("unknown-model".into()), None, None),
        (
            "effort",
            None,
            Some(latte_work_protocol::Effort::High),
            None,
        ),
        ("permission", None, None, Some("force".into())),
    ] {
        assert!(matches!(
            ask(
                &mut client,
                Request::SendQueued {
                    session_id: id.clone(),
                    request_id: request.into(),
                    text: "never sent".into(),
                    model,
                    effort,
                    permission_mode,
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Error { .. }
        ));
    }
    assert!(!root.path().join("cursor-inputs").exists());
    std::fs::create_dir_all(root.path().join(".cursor/commands")).unwrap();
    std::fs::create_dir_all(root.path().join(".cursor/skills/cursor-skill")).unwrap();
    std::fs::write(
        root.path().join(".cursor/commands/check-cursor.md"),
        "---\nname: 检查配置\ndescription: Cursor 命令说明\n---\n内容\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join(".cursor/skills/cursor-skill/SKILL.md"),
        "---\nname: Cursor 技能\ndescription: Cursor 技能说明\n---\n步骤\n",
    )
    .unwrap();
    let project_id = current(&mut client, &id).await.project_id;
    let discovered = ask(
        &mut client,
        Request::AgentCommands {
            agent: "cursor".into(),
            project_id: project_id.clone(),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    match discovered {
        Response::AgentCommands { commands } => {
            assert!(commands.iter().any(|c| {
                c.name == "check-cursor"
                    && c.display_name.as_deref() == Some("检查配置")
                    && c.kind == Some(latte_work_protocol::AgentCommandKind::Command)
            }));
            assert!(commands.iter().any(|c| {
                c.name == "cursor-skill"
                    && c.display_name.as_deref() == Some("Cursor 技能")
                    && c.kind == Some(latte_work_protocol::AgentCommandKind::Skill)
            }));
        }
        other => panic!("expected cursor commands: {other:?}"),
    }
    assert!(matches!(
        ask(
            &mut client,
            Request::SkillInfo {
                session_id: id.clone(),
                name: "cursor-skill".into(),
            }
        )
        .await,
        Response::SkillInfo { skill: Some(info) }
            if info.name == "Cursor 技能" && info.description == "Cursor 技能说明"
    ));
    assert!(!root.path().join("cursor-inputs").exists());
    assert!(matches!(
        ask(
            &mut client,
            Request::AgentCommands {
                agent: "cursor".into(),
                project_id,
                provider: Some(TurnProvider::Snapshot(Box::new(
                    latte_work_protocol::ProviderSnapshot {
                        provider: latte_work_protocol::Provider {
                            id: "p".into(),
                            name: "Provider".into(),
                            protocol: latte_work_protocol::ProviderProtocol::AnthropicMessages,
                            base_url: "https://example.invalid".into(),
                            model: "m".into(),
                            models: vec![],
                            model_labels: Default::default(),
                            models_1m: vec![],
                            auth: latte_work_protocol::ProviderAuth::ApiKey,
                            has_credential: true,
                            revision: "1".into(),
                        },
                        credential: "secret".into(),
                    },
                ))),
            }
        )
        .await,
        Response::Error { .. }
    ));
}

#[tokio::test]
async fn cursor_daemon_restart_preserves_unknown_and_never_replays_active_input() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "head", "hold").await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while current(&mut client, &id).await.native_id.is_none() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(matches!(
        send(&mut client, &id, "next", "second").await,
        Response::MessageQueued { .. }
    ));
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
    assert!(
        matches!(ask(&mut client, Request::MessageQueue { session_id: id.clone() }).await,
        Response::MessageQueue { entries, paused: true, .. } if entries.len() == 1)
    );
    open(&mut client, &id).await;
    assert!(matches!(
        send(&mut client, &id, "head", "hold").await,
        Response::Accepted { duplicate: true }
    ));
    assert_eq!(inputs(root.path()).len(), 1);
    assert_eq!(current(&mut client, &id).await.status, Status::Unknown);
    ask(
        &mut client,
        Request::ResumeMessageQueue {
            session_id: id.clone(),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(inputs(root.path()).len(), 2);
    assert_eq!(inputs(root.path())[1]["prompt"], "second");
    assert_eq!(inputs(root.path())[1]["resume"], "cursor-native-session");
}

#[tokio::test]
async fn cursor_env_reaches_native_process_and_stderr_is_redacted() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    let secret = "cursor-private-fixture-secret";
    let environment = latte_work_protocol::AgentEnvironment(std::collections::BTreeMap::from([(
        "CURSOR_FIXTURE_SECRET".into(),
        secret.into(),
    )]));
    assert!(matches!(
        ask(
            &mut client,
            Request::SendQueued {
                session_id: id.clone(),
                request_id: "env".into(),
                text: "nonzero".into(),
                model: None,
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
    let events = wait(&mut client, &id, Status::Failed).await;
    assert_eq!(inputs(root.path())[0]["env"], secret);
    let serialized = serde_json::to_string(&events).unwrap();
    assert!(serialized.contains("fixture diagnostic"), "{serialized}");
    assert!(serialized.contains("[redacted]"), "{serialized}");
    assert!(!serialized.contains(secret));
}

#[tokio::test]
async fn cursor_native_model_and_read_only_modes_reach_selected_cli() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    for mode in ["ask", "plan"] {
        assert!(matches!(
            ask(
                &mut client,
                Request::SendQueued {
                    session_id: id.clone(),
                    request_id: mode.into(),
                    text: format!("mode-{mode}"),
                    model: Some("cursor-test".into()),
                    effort: None,
                    permission_mode: Some(mode.into()),
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &id, Status::Completed).await;
    }
    let records = inputs(root.path());
    assert_eq!(records.len(), 2);
    for (record, mode) in records.iter().zip(["ask", "plan"]) {
        let options = record["options"].as_array().unwrap();
        let mode_index = options.iter().position(|item| item == "--mode").unwrap();
        let model_index = options.iter().position(|item| item == "--model").unwrap();
        assert_eq!(options[mode_index + 1], mode);
        assert_eq!(options[model_index + 1], "cursor-test");
    }
}

#[tokio::test]
async fn cursor_inherited_host_secret_never_enters_diagnostic_events() {
    let secret = std::ffi::OsStr::new("cursor-inherited-fixture-secret");
    let host = Host::start_with_environment(&[("CURSOR_FIXTURE_SECRET", secret)]).await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    assert!(matches!(
        send(&mut client, &id, "inherited-env", "nonzero").await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Failed).await;
    assert_eq!(
        inputs(root.path())[0]["env"],
        "cursor-inherited-fixture-secret"
    );
    let serialized = serde_json::to_string(&events).unwrap();
    assert!(serialized.contains("fixture diagnostic"), "{serialized}");
    assert!(serialized.contains("[redacted]"), "{serialized}");
    assert!(!serialized.contains("cursor-inherited-fixture-secret"));
}
