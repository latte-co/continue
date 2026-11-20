use super::*;
use latte_work_protocol::{AgentEnvironment, Session, TurnProvider, TurnUndoStatus};

#[tokio::test]
async fn side_chat_forks_while_parent_waits_and_resumes_independently() {
    for agent in ["codex", "traex"] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let project = terminal_project(&mut client, root.path()).await;
        let Response::Session { session: parent } = ask(
            &mut client,
            Request::CreateSession {
                project_id: project.clone(),
                agent: agent.into(),
            },
        )
        .await
        else {
            panic!("main session")
        };
        let open = || Request::OpenSideChat {
            session_id: parent.id.clone(),
            side_id: None,
        };
        assert!(matches!(
            ask(&mut client, open()).await,
            Response::Error { .. }
        ));
        assert!(matches!(
            send(&mut client, &parent.id, "main", "approval").await,
            Response::Accepted { .. }
        ));
        let pending = permission(&wait(&mut client, &parent.id, Status::Waiting).await);
        let Response::Session { session: side } = ask(&mut client, open()).await else {
            panic!("side session")
        };
        assert_ne!(side.id, parent.id);
        assert!(side.native_id.is_none());
        assert!(matches!(
            ask(
                &mut client,
                Request::OpenSideChat {
                    session_id: side.id.clone(),
                    side_id: None,
                }
            )
            .await,
            Response::Error { .. }
        ));
        assert!(
            matches!(ask(&mut client, Request::Sessions {project_id:project}).await,Response::Sessions{sessions} if sessions.len()==1 && sessions[0].id==parent.id)
        );
        assert!(matches!(
            send(&mut client, &side.id, "side", "side-only").await,
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &side.id, Status::Completed).await;
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.event, EventKind::Text{text} if text.contains("side-only")))
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(&e.event, EventKind::TurnChanges { .. }))
        );
        let mut reconnect = host.client().await;
        assert!(
            matches!(ask(&mut reconnect,open()).await,Response::Session{session} if session.id==side.id && session.native_id.as_deref().is_some_and(|id| id.starts_with("side-thread-")))
        );
        assert!(matches!(
            send(&mut reconnect, &side.id, "side", "side-only").await,
            Response::Accepted { duplicate: true }
        ));
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::CloseAgentSession {
                    session_id: side.id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Ok
        ));
        assert!(matches!(
            send(&mut reconnect, &side.id, "follow", "question").await,
            Response::Accepted { .. }
        ));
        wait(&mut reconnect, &side.id, Status::Waiting).await;
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::CloseAgentSession {
                    session_id: side.id.clone(),
                    only_if_idle: Some(false),
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut reconnect, &side.id, Status::Stopped).await;
        assert!(matches!(
            ask(&mut reconnect, Request::Session { session_id: side.id.clone() }).await,
            Response::Session { session } if session.agent_session_open == Some(false)
        ));
        let next_id = uuid::Uuid::new_v4().to_string();
        let new_chat = || Request::OpenSideChat {
            session_id: parent.id.clone(),
            side_id: Some(next_id.clone()),
        };
        for _ in 0..2 {
            assert!(
                matches!(ask(&mut reconnect, new_chat()).await, Response::Session{session} if session.id == next_id)
            );
        }
        assert!(
            matches!(ask(&mut reconnect, Request::SideChats{session_id:parent.id.clone()}).await, Response::Sessions{sessions} if sessions.len() == 2 && sessions[0].id == next_id && sessions[1].id == side.id)
        );
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::Send {
                    session_id: next_id.clone(),
                    request_id: "side-approval".into(),
                    text: "approval".into(),
                    model: None,
                    effort: None,
                    permission_mode: Some("default".into()),
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        let side_approval = permission(&wait(&mut reconnect, &next_id, Status::Waiting).await);
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::Approve {
                    session_id: next_id.clone(),
                    request_id: side_approval,
                    allow: true,
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut reconnect, &next_id, Status::Completed).await;
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::Send {
                    session_id: next_id.clone(),
                    request_id: "side-full-access".into(),
                    text: "full-access follow-up".into(),
                    model: None,
                    effort: None,
                    permission_mode: Some("bypass_permissions".into()),
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        wait(&mut reconnect, &next_id, Status::Completed).await;
        assert!(
            matches!(ask(&mut reconnect, Request::Session {session_id:next_id.clone()}).await,
            Response::Session{session} if session.permission_mode.as_deref()==Some("bypass_permissions"))
        );
        let original = wait(&mut client, &parent.id, Status::Waiting).await;
        assert_eq!(permission(&original), pending);
        assert_eq!(
            original
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1
        );
        assert!(matches!(
            ask(
                &mut client,
                Request::Approve {
                    session_id: parent.id.clone(),
                    request_id: pending,
                    allow: true
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut client, &parent.id, Status::Completed).await;
        assert!(
            matches!(ask(&mut client,Request::RecentSessions{before:None}).await,Response::RecentSessions{sessions,..} if sessions.len()==1 && sessions[0].session.id==parent.id)
        );
    }
}

#[tokio::test]
async fn claude_side_chat_resumes_its_own_native_session_and_handles_approvals() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = terminal_project(&mut client, root.path()).await;
    let Response::Session { session: parent } = ask(
        &mut client,
        Request::CreateSession {
            project_id,
            agent: "claude".into(),
        },
    )
    .await
    else {
        panic!("Claude main session");
    };
    let open = Request::OpenSideChat {
        session_id: parent.id.clone(),
        side_id: None,
    };
    assert!(matches!(
        send(&mut client, &parent.id, "main", "approve").await,
        Response::Accepted { .. }
    ));
    let pending = permission(&wait(&mut client, &parent.id, Status::Waiting).await);
    let Response::Session { session: side } = ask(&mut client, open).await else {
        panic!("Claude side session");
    };
    let read_session = |id: &str| Request::Session {
        session_id: id.into(),
    };
    let Response::Session {
        session: running_parent,
    } = ask(&mut client, read_session(&parent.id)).await
    else {
        panic!("running Claude main session");
    };
    assert!(matches!(
        send(&mut client, &side.id, "side", "approve").await,
        Response::Accepted { .. }
    ));
    let side_denied = permission(&wait(&mut client, &side.id, Status::Waiting).await);
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: side.id.clone(),
                request_id: side_denied,
                allow: false
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut client, &side.id, Status::Completed).await;
    assert!(!root.path().join("approved.txt").exists());
    let Response::Session {
        session: completed_side,
    } = ask(&mut client, read_session(&side.id)).await
    else {
        panic!("completed Claude side session");
    };
    assert!(completed_side.native_id.is_some());
    assert_ne!(completed_side.native_id, running_parent.native_id);
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: side.id.clone(),
                only_if_idle: Some(true)
            }
        )
        .await,
        Response::Ok
    ));
    let mut reconnect = host.client().await;
    assert!(matches!(
        ask(
            &mut reconnect,
            Request::Send {
                session_id: side.id.clone(),
                request_id: "side-write".into(),
                text: "approve".into(),
                model: None,
                effort: None,
                permission_mode: Some("default".into()),
                provider: Some(TurnProvider::Cli),
            }
        )
        .await,
        Response::Accepted { .. }
    ));
    let side_pending = permission(&wait(&mut reconnect, &side.id, Status::Waiting).await);
    assert!(matches!(
        ask(
            &mut reconnect,
            Request::Approve {
                session_id: side.id.clone(),
                request_id: side_pending,
                allow: true
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut reconnect, &side.id, Status::Completed).await;
    assert!(root.path().join("approved.txt").exists());
    assert!(
        matches!(ask(&mut reconnect, read_session(&side.id)).await, Response::Session { session } if session.native_id == completed_side.native_id)
    );
    assert_eq!(
        permission(&wait(&mut client, &parent.id, Status::Waiting).await),
        pending
    );
}

async fn create_session(client: &mut Client, project_id: String, agent: &str) -> Session {
    match ask(
        client,
        Request::CreateSession {
            project_id,
            agent: agent.into(),
        },
    )
    .await
    {
        Response::Session { session } => session,
        other => panic!("create session: {other:?}"),
    }
}

async fn open_side(client: &mut Client, parent: &Session) -> Session {
    match ask(
        client,
        Request::OpenSideChat {
            session_id: parent.id.clone(),
            side_id: Some(uuid::Uuid::new_v4().to_string()),
        },
    )
    .await
    {
        Response::Session { session } => session,
        other => panic!("open side chat: {other:?}"),
    }
}

#[tokio::test]
async fn legacy_cli_parent_with_missing_request_digest_forks_without_recording_proof() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project, "codex").await;
    assert!(matches!(
        send(&mut client, &parent.id, "legacy-cli", "hello").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &parent.id, Status::Completed).await;
    wait_for_agent_idle(&mut client, &parent.id, Status::Completed).await;
    let turn = |session_id: &str, request_id: &str, provider: TurnProvider| Request::Send {
        permission_mode: None,
        provider: Some(provider),
        session_id: session_id.into(),
        request_id: request_id.into(),
        text: request_id.into(),
        model: None,
        effort: None,
    };
    assert!(matches!(
        ask(
            &mut client,
            turn(&parent.id, "explicit-cli", TurnProvider::Cli)
        )
        .await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &parent.id, Status::Completed).await;

    drop(client);
    kill(Pid::from_raw(host.process.id() as i32), Signal::SIGINT).unwrap();
    assert!(host.process.wait().unwrap().success());
    let db_path = host.directory.path().join("state.sqlite");
    let db = rusqlite::Connection::open(&db_path).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM requests WHERE session_id=?1 AND provider_fingerprint IS NULL",
            [&parent.id],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.execute(
            "DELETE FROM native_session_contexts WHERE session_id=?1",
            [&parent.id],
        )
        .unwrap(),
        1
    );
    drop(db);

    host.process = Host::spawn(host.directory.path(), &[]);
    host.wait_ready().await;
    let mut client = host.client().await;
    let side = open_side(&mut client, &parent).await;
    assert!(matches!(
        ask(
            &mut client,
            turn(&side.id, "legacy-cli-fork", TurnProvider::Cli)
        )
        .await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &side.id, Status::Completed).await;

    let changed = open_side(&mut client, &parent).await;
    let provider = serde_json::from_value(serde_json::json!({
        "provider": {
            "id": "fixture-custom", "name": "Fixture", "protocol": "openai_responses",
            "base_url": "http://fixture.test/v1", "model": "codex-test",
            "auth": "none", "has_credential": false
        },
        "credential": ""
    }))
    .unwrap();
    for (request_id, config) in [
        ("legacy-new-provider", TurnProvider::Snapshot(provider)),
        (
            "legacy-custom-environment",
            TurnProvider::Configured {
                provider: None,
                environment: AgentEnvironment(
                    [("HTTPS_PROXY".into(), "http://fixture.test:8000".into())].into(),
                ),
            },
        ),
    ] {
        assert!(matches!(
            ask(&mut client, turn(&changed.id, request_id, config)).await,
            Response::Accepted { duplicate: false }
        ));
        let rejected = wait(&mut client, &changed.id, Status::Failed).await;
        assert!(rejected.iter().any(|event| matches!(&event.event,
            EventKind::State { message: Some(message), .. } if message.contains("请用原 Provider 和 Agent 环境续接一次")
        )));
    }
    let db = rusqlite::Connection::open(&db_path).unwrap();
    assert!(
        !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_session_contexts WHERE session_id=?1)",
            [&parent.id],
            |row| row.get::<_, bool>(0)
        )
        .unwrap()
    );
    let inputs = std::fs::read_to_string(root.path().join("codex-inputs")).unwrap();
    assert!(
        !inputs.contains("legacy-new-provider") && !inputs.contains("legacy-custom-environment")
    );
}

#[tokio::test]
async fn side_chat_forks_and_resumes_after_switching_providers() {
    use latte_work_protocol::{Provider, ProviderSnapshot};
    use serde_json::{Value, json};

    // After migration, an existing side chat must prove its original
    // environment before accepting a Provider change.
    for legacy in [false, true] {
        let mut host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("check-side-provider-resume"), "").unwrap();
        let mut client = host.client().await;
        let project = terminal_project(&mut client, root.path()).await;
        let parent = create_session(&mut client, project, "codex").await;
        let environment =
            AgentEnvironment([("HTTPS_PROXY".into(), "http://fixture.test:8000".into())].into());
        let turn = |session: &Session,
                    request_id: &str,
                    version: &str,
                    environment: &AgentEnvironment| {
            let model = if version == "old" {
                "codex-test"
            } else {
                "custom-codex"
            };
            let provider: Provider = serde_json::from_value(json!({
                "id": format!("fixture-{version}"), "name": "Fixture", "protocol": "openai_responses",
                "base_url": format!("http://{version}.test/v1"),
                "model": model, "auth": "bearer", "has_credential": true
            }))
            .unwrap();
            let snapshot = Box::new(ProviderSnapshot {
                provider,
                credential: format!("fixture-{version}"),
            });
            Request::Send {
                session_id: session.id.clone(),
                request_id: request_id.into(),
                text: request_id.into(),
                model: Some(model.into()),
                effort: None,
                permission_mode: None,
                provider: Some(TurnProvider::Configured {
                    provider: Some(snapshot),
                    environment: environment.clone(),
                }),
            }
        };
        assert!(matches!(
            ask(
                &mut client,
                turn(&parent, "parent-first", "old", &environment)
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &parent.id, Status::Completed).await;
        wait_for_agent_idle(&mut client, &parent.id, Status::Completed).await;
        let existing = open_side(&mut client, &parent).await;
        assert!(matches!(
            ask(
                &mut client,
                turn(&existing, "side-first", "old", &environment)
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &existing.id, Status::Completed).await;
        let before = wait_for_agent_idle(&mut client, &existing.id, Status::Completed).await;
        let existing_native_id = before.native_id.unwrap();

        if legacy {
            drop(client);
            kill(Pid::from_raw(host.process.id() as i32), Signal::SIGINT).unwrap();
            assert!(host.process.wait().unwrap().success());
            let db =
                rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
            db.execute(
                "ALTER TABLE native_session_contexts DROP COLUMN environment_proof",
                [],
            )
            .unwrap();
            assert_eq!(
                db.execute(
                    "DELETE FROM native_session_contexts WHERE session_id=?1",
                    [&parent.id],
                )
                .unwrap(),
                1
            );
            drop(db);
            host.process = Host::spawn(host.directory.path(), &[]);
            host.wait_ready().await;
            client = host.client().await;

            assert!(matches!(
                ask(
                    &mut client,
                    turn(
                        &existing,
                        "cleared-environment",
                        "old",
                        &AgentEnvironment::default()
                    ),
                )
                .await,
                Response::Accepted { duplicate: false }
            ));
            let rejected = wait(&mut client, &existing.id, Status::Failed).await;
            assert!(rejected.iter().any(|event| matches!(&event.event,
                EventKind::State { message: Some(message), .. } if message.contains("请用原 Provider 和 Agent 环境续接一次")
            )));
            let confirmation = open_side(&mut client, &parent).await;
            assert!(matches!(
                ask(
                    &mut client,
                    turn(
                        &confirmation,
                        "cleared-parent-environment",
                        "old",
                        &AgentEnvironment::default()
                    ),
                )
                .await,
                Response::Accepted { duplicate: false }
            ));
            let rejected = wait(&mut client, &confirmation.id, Status::Failed).await;
            assert!(rejected.iter().any(|event| matches!(&event.event,
                EventKind::State { message: Some(message), .. } if message.contains("请用原 Provider 和 Agent 环境续接一次")
            )));
            // The historical parent can establish its environment from the
            // matching ledger without sending a new message in the main chat.
            for (side, request) in [
                (&existing, "confirm-child"),
                (&confirmation, "confirm-parent"),
            ] {
                assert!(matches!(
                    ask(&mut client, turn(side, request, "old", &environment)).await,
                    Response::Accepted { duplicate: false }
                ));
                wait(&mut client, &side.id, Status::Completed).await;
                wait_for_agent_idle(&mut client, &side.id, Status::Completed).await;
            }
        }

        let fresh = open_side(&mut client, &parent).await;
        assert!(matches!(
            ask(
                &mut client,
                turn(&fresh, "fork-after-change", "new", &environment)
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &fresh.id, Status::Completed).await;
        let forked = wait_for_agent_idle(&mut client, &fresh.id, Status::Completed).await;
        assert!(
            forked
                .native_id
                .as_deref()
                .is_some_and(|id| id != existing_native_id)
        );

        assert!(matches!(
            ask(
                &mut client,
                turn(&existing, "resume-after-change", "new", &environment)
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &existing.id, Status::Completed).await;
        let resumed = wait_for_agent_idle(&mut client, &existing.id, Status::Completed).await;
        let resumed_native_id = resumed.native_id.unwrap();
        assert_ne!(resumed_native_id, existing_native_id);
        assert_eq!(resumed.title, "Provider [redacted] / [redacted]");

        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: existing.id.clone(),
                    only_if_idle: Some(true),
                }
            )
            .await,
            Response::Ok
        ));
        assert!(matches!(
            ask(
                &mut client,
                Request::OpenSideChat {
                    session_id: parent.id.clone(),
                    side_id: Some(existing.id.clone()),
                }
            )
            .await,
            Response::Session { session } if session.native_id.as_deref() == Some(&resumed_native_id)
        ));
        assert!(matches!(
            ask(
                &mut client,
                turn(&existing, "cold-resume-same-provider", "new", &environment)
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &existing.id, Status::Completed).await;
        let reopened = wait_for_agent_idle(&mut client, &existing.id, Status::Completed).await;
        assert_eq!(
            reopened.native_id.as_deref(),
            Some(resumed_native_id.as_str())
        );

        let inputs = std::fs::read_to_string(root.path().join("codex-inputs")).unwrap();
        let inputs: Vec<Value> = inputs
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(inputs.len(), if legacy { 7 } else { 5 });
        assert!(!inputs.iter().any(|input| matches!(
            input["prompt"].as_str(),
            Some("cleared-environment" | "cleared-parent-environment")
        )));
        for (input, prompt) in inputs[inputs.len() - 3..].iter().zip([
            "fork-after-change",
            "resume-after-change",
            "cold-resume-same-provider",
        ]) {
            assert_eq!(input["prompt"], prompt);
            assert_eq!(input["params"]["model"], "custom-codex");
        }
        assert_eq!(
            inputs.last().unwrap()["params"]["threadId"],
            resumed_native_id
        );
    }
}

async fn start_writable_side(client: &mut Client, side: &Session, prompt: &str) {
    send_writable_side(client, side, prompt, "default", TurnProvider::Cli).await;
    wait(client, &side.id, Status::Completed).await;
}

async fn send_writable_side(
    client: &mut Client,
    side: &Session,
    prompt: &str,
    permission: &str,
    provider: TurnProvider,
) {
    assert!(matches!(
        ask(
            client,
            Request::Send {
                session_id: side.id.clone(),
                request_id: "side-write".into(),
                text: prompt.into(),
                model: None,
                effort: None,
                permission_mode: Some(permission.into()),
                provider: Some(provider),
            }
        )
        .await,
        Response::Accepted { .. }
    ));
}

#[tokio::test]
async fn undo_ignores_prelaunch_rejection_and_waits_for_side_recovery_to_settle() {
    for launch in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("shared.txt");
        std::fs::write(&file, "before\n").unwrap();
        let mut client = host.client().await;
        let project = terminal_project(&mut client, root.path()).await;
        let parent = create_session(&mut client, project, "codex").await;
        send(&mut client, &parent.id, "parent-init", "hello").await;
        wait(&mut client, &parent.id, Status::Completed).await;
        let side = open_side(&mut client, &parent).await;

        let main = &parent.id;
        send(&mut client, main, "main-write", "approval-then-main-write").await;
        let pending = permission(&wait(&mut client, main, Status::Waiting).await);
        let provider = if launch {
            TurnProvider::Cli
        } else {
            TurnProvider::Configured {
                provider: None,
                environment: AgentEnvironment(
                    [("LATTE_TEST_LITERAL".into(), "changed".into())].into(),
                ),
            }
        };
        if launch {
            // Hold recovery at the native initialization boundary, not at a
            // guessed delay after the persisted Failed event.
            std::fs::write(root.path().join("hold-side-resume"), "").unwrap();
        }
        send_writable_side(&mut client, &side, "eof", "default", provider).await;
        let events = wait(&mut client, &side.id, Status::Failed).await;
        let inputs = std::fs::read_to_string(root.path().join("codex-inputs")).unwrap();
        assert_eq!(inputs.contains(r#""prompt": "eof""#), launch);
        if !launch {
            assert!(events.iter().any(|event| matches!(&event.event,
                EventKind::State { message: Some(message), .. } if message.contains("Agent 环境无法与原会话匹配")
            )));
        }
        assert!(matches!(
            ask(
                &mut client,
                Request::Approve {
                    session_id: main.clone(),
                    request_id: pending,
                    allow: true,
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut client, main, Status::Completed).await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
        wait_for_agent_idle(&mut client, main, Status::Completed).await;
        if launch {
            wait_for_marker(&root.path().join("side-resume-entered")).await;
            let recovering = ask(
                &mut client,
                Request::Session {
                    session_id: side.id.clone(),
                },
            )
            .await;
            assert!(
                matches!(&recovering, Response::Session { session }
                if session.status == Status::Failed && session.agent_session_busy == Some(true)),
                "{recovering:?}"
            );
            let busy_undo = ask(
                &mut client,
                Request::UndoTurnChanges {
                    session_id: main.clone(),
                    request_id: "main-write".into(),
                },
            )
            .await;
            assert!(
                matches!(&busy_undo, Response::Error { message, .. }
                if message.contains("此主机仍有运行任务")),
                "{busy_undo:?}"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
            std::fs::write(root.path().join("release-side-resume"), "").unwrap();
        }
        wait_for_agent_idle(&mut client, &side.id, Status::Failed).await;
        let undo = ask(
            &mut client,
            Request::UndoTurnChanges {
                session_id: main.clone(),
                request_id: "main-write".into(),
            },
        )
        .await;
        assert!(
            matches!(&undo, Response::TurnChanges { changes }
            if changes.undo == TurnUndoStatus::Reverted),
            "{undo:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
    }
}

/// Durable turn status can precede native recovery/queue settlement. Observe the
/// same live evidence as Undo without closing an actor or retrying a mutation.
async fn wait_for_agent_idle(client: &mut Client, id: &str, status: Status) -> Session {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = ask(
            client,
            Request::Session {
                session_id: id.into(),
            },
        )
        .await;
        let Response::Session { session } = response else {
            panic!("{response:?}")
        };
        assert_eq!(
            session.status, status,
            "unexpected recovery outcome: {session:?}"
        );
        if session.agent_session_busy == Some(false) {
            return session;
        }
        assert!(
            Instant::now() < deadline,
            "native runtime did not settle: {session:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_marker(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "missing fixture marker: {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn concurrent_side_close_preserves_a_new_resource_claim() {
    use latte_work_protocol::lifecycle::Resource;
    for new_owner in ["reopened", "writer"] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut writer = host.client().await;
        let mut reopened = host.client().await;
        let project = terminal_project(&mut writer, root.path()).await;
        let parent = create_session(&mut writer, project, "codex").await;
        send(&mut writer, &parent.id, "main-init", "hello").await;
        wait(&mut writer, &parent.id, Status::Completed).await;
        let side = open_side(&mut writer, &parent).await;
        let resource = Resource::AgentSession(side.id.clone());
        let server_id = writer.server_id().to_owned();
        writer
            .claim_resources("writer".into(), vec![resource.clone()])
            .await
            .unwrap();
        start_writable_side(&mut writer, &side, "hello").await;
        std::fs::write(root.path().join("hold-side-close"), "").unwrap();
        let id = side.id.clone();
        let closing = tokio::spawn(async move {
            ask(
                &mut writer,
                Request::CloseAgentSession {
                    session_id: id,
                    only_if_idle: Some(true),
                },
            )
            .await
        });
        // The native SIGTERM handler holds the old actor open while the other
        // connection acknowledges a new claim, establishing the exact interleave.
        wait_for_marker(&root.path().join("side-close-entered")).await;
        reopened
            .claim_resources(new_owner.into(), vec![resource.clone()])
            .await
            .unwrap();
        std::fs::write(root.path().join("release-side-close"), "").unwrap();
        assert!(matches!(closing.await.unwrap(), Response::Ok));
        assert!(matches!(
            ask(
                &mut reopened,
                Request::OpenAgentSession {
                    session_id: side.id.clone(),
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Ok
        ));
        reopened
            .close_owned_resources(server_id, new_owner.into(), vec![resource])
            .await
            .unwrap();
        assert!(
            matches!(ask(&mut reopened, Request::Session { session_id: side.id }).await,
            Response::Session { session } if session.agent_session_open == Some(false)),
            "the newer claim must retain responsibility for closing the new actor"
        );
    }
}

#[tokio::test]
async fn claim_before_close_retains_ownership_when_open_or_send_follows() {
    use latte_work_protocol::lifecycle::Resource;
    for send_turn in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut writer = host.client().await;
        let mut reopened = host.client().await;
        let project = terminal_project(&mut writer, root.path()).await;
        let parent = create_session(&mut writer, project, "codex").await;
        send(&mut writer, &parent.id, "main-init", "hello").await;
        wait(&mut writer, &parent.id, Status::Completed).await;
        let side = open_side(&mut writer, &parent).await;
        let resource = Resource::AgentSession(side.id.clone());
        let server_id = writer.server_id().to_owned();
        writer
            .claim_resources("writer".into(), vec![resource.clone()])
            .await
            .unwrap();
        start_writable_side(&mut writer, &side, "hello").await;

        reopened
            .claim_resources("reopened".into(), vec![resource.clone()])
            .await
            .unwrap();
        // Model the desktop's Session lookup and Provider work between Claim and
        // Open/Send. A different connection completes the old actor's close here.
        assert!(
            matches!(ask(&mut reopened, Request::Session { session_id: side.id.clone() }).await,
            Response::Session { session } if session.agent_session_open == Some(true))
        );
        assert!(matches!(
            ask(
                &mut writer,
                Request::CloseAgentSession {
                    session_id: side.id.clone(),
                    only_if_idle: Some(true),
                }
            )
            .await,
            Response::Ok
        ));
        if send_turn {
            assert!(matches!(
                send(&mut reopened, &side.id, "after-close", "hello").await,
                Response::Accepted { duplicate: false }
            ));
            wait(&mut reopened, &side.id, Status::Completed).await;
        } else {
            assert!(matches!(
                ask(
                    &mut reopened,
                    Request::OpenAgentSession {
                        session_id: side.id.clone(),
                        provider: Some(TurnProvider::Cli),
                    }
                )
                .await,
                Response::Ok
            ));
        }
        assert!(
            matches!(ask(&mut reopened, Request::Session { session_id: side.id.clone() }).await,
            Response::Session { session } if session.agent_session_open == Some(true))
        );
        reopened
            .close_owned_resources(server_id, "reopened".into(), vec![resource])
            .await
            .unwrap();
        assert!(
            matches!(ask(&mut reopened, Request::Session { session_id: side.id }).await,
            Response::Session { session } if session.agent_session_open == Some(false))
        );
    }
}

#[tokio::test]
async fn superseded_connection_claim_cannot_admit_a_turn_or_steal_ownership() {
    use latte_work_protocol::lifecycle::Resource;
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut old = host.client().await;
    let mut current = host.client().await;
    let project = terminal_project(&mut old, root.path()).await;
    let main = create_session(&mut old, project, "codex").await;
    let resource = Resource::AgentSession(main.id.clone());
    old.claim_resources("old".into(), vec![resource.clone()])
        .await
        .unwrap();
    current
        .claim_resources("current".into(), vec![resource.clone()])
        .await
        .unwrap();
    assert!(matches!(send(&mut old, &main.id, "stale", "hello").await,
        Response::Error { message, .. } if message.contains("资源认领已变化")));
    assert!(
        matches!(ask(&mut old, Request::Poll { session_id: main.id.clone(), after: 0.0 }).await,
        Response::Events { session, events, .. } if session.agent_session_open == Some(false) && events.is_empty())
    );
    assert!(matches!(
        send(&mut current, &main.id, "current", "hello").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut current, &main.id, Status::Completed).await;
    current
        .close_owned_resources(
            current.server_id().to_owned(),
            "current".into(),
            vec![resource],
        )
        .await
        .unwrap();
    assert!(
        matches!(ask(&mut current, Request::Session { session_id: main.id }).await,
        Response::Session { session } if session.agent_session_open == Some(false))
    );
}

#[tokio::test]
async fn project_runtime_inventory_includes_side_chat_beyond_parent_history_limit() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project.clone(), "codex").await;
    send(&mut client, &parent.id, "init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let side = open_side(&mut client, &parent).await;
    send_writable_side(&mut client, &side, "approval", "default", TurnProvider::Cli).await;
    wait(&mut client, &side.id, Status::Waiting).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: parent.id.clone(),
                only_if_idle: Some(true),
            }
        )
        .await,
        Response::Ok
    ));
    for _ in 0..500 {
        create_session(&mut client, project.clone(), "codex").await;
    }
    assert!(
        matches!(ask(&mut client, Request::Sessions { project_id: project.clone() }).await,
        Response::Sessions { sessions } if sessions.len() == 500 && !sessions.iter().any(|s| s.id == parent.id))
    );
    let Response::ProjectAgentSessions { sessions, next } = ask(
        &mut client,
        Request::ProjectAgentSessions {
            project_id: project.clone(),
            after: None,
        },
    )
    .await
    else {
        panic!("managed inventory");
    };
    assert!(next.is_none());
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, side.id);
    assert_eq!(sessions[0].agent_session_open, Some(true));
    assert_eq!(sessions[0].agent_session_busy, Some(true));
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: side.id,
                only_if_idle: Some(false),
            }
        )
        .await,
        Response::Ok
    ));
    assert!(
        matches!(ask(&mut client, Request::ProjectAgentSessions { project_id: project, after: None }).await,
        Response::ProjectAgentSessions { sessions, next: None } if sessions.is_empty())
    );
}

#[tokio::test]
async fn cross_connection_cleanup_reclaims_capacity_without_reviving_old_claims() {
    use latte_work_protocol::lifecycle::Resource;
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut control = host.client().await;
    let mut cleanup = host.client().await;
    let project = terminal_project(&mut control, root.path()).await;
    let session = create_session(&mut control, project, "codex").await;
    let resource = Resource::AgentSession(session.id.clone());
    let server_id = control.server_id().to_owned();
    control
        .claim_resources("app".into(), vec![resource.clone()])
        .await
        .unwrap();
    cleanup
        .close_owned_resources(server_id.clone(), "app".into(), vec![resource.clone()])
        .await
        .unwrap();
    // Resource intents are claimed before creation. Releasing them on another
    // native lane must not exhaust this long-lived connection's 4096-entry bound.
    for batch in 0..33 {
        let resources: Vec<_> = (0..128)
            .map(|n| Resource::AgentSession(format!("intent-{batch}-{n}")))
            .collect();
        control
            .claim_resources("app".into(), resources.clone())
            .await
            .unwrap();
        cleanup
            .close_owned_resources(server_id.clone(), "app".into(), resources)
            .await
            .unwrap();
    }
    assert!(
        matches!(send(&mut control, &session.id, "stale", "hello").await,
        Response::Error { message, .. } if message.contains("资源认领已变化"))
    );
    control
        .claim_resources("app".into(), vec![resource.clone()])
        .await
        .unwrap();
    assert!(matches!(
        send(&mut control, &session.id, "fresh", "hello").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut control, &session.id, Status::Completed).await;
    cleanup
        .close_owned_resources(server_id, "app".into(), vec![resource])
        .await
        .unwrap();
    assert!(
        matches!(ask(&mut control, Request::Session { session_id: session.id }).await,
        Response::Session { session } if session.agent_session_open == Some(false))
    );
}

#[tokio::test]
async fn archive_retires_parent_and_side_ownership_before_unowned_reopen() {
    use latte_work_protocol::lifecycle::Resource;
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut control = host.client().await;
    let mut archive = host.client().await;
    let project = terminal_project(&mut control, root.path()).await;
    let parent = create_session(&mut control, project, "codex").await;
    let main_resource = Resource::AgentSession(parent.id.clone());
    control
        .claim_resources("old-app".into(), vec![main_resource.clone()])
        .await
        .unwrap();
    send(&mut control, &parent.id, "init", "hello").await;
    wait(&mut control, &parent.id, Status::Completed).await;
    let side = open_side(&mut control, &parent).await;
    let side_resource = Resource::AgentSession(side.id.clone());
    control
        .claim_resources("old-app".into(), vec![side_resource.clone()])
        .await
        .unwrap();
    send(&mut control, &side.id, "side", "hello").await;
    wait(&mut control, &side.id, Status::Completed).await;
    assert!(
        matches!(ask(&mut archive, Request::ArchiveSession { session_id: parent.id.clone(), archived: true }).await,
        Response::Session { session } if session.archived)
    );
    assert!(
        matches!(ask(&mut archive, Request::ProjectAgentSessions { project_id: parent.project_id.clone(), after: None }).await,
        Response::ProjectAgentSessions { sessions, .. } if sessions.is_empty())
    );
    ask(
        &mut archive,
        Request::ArchiveSession {
            session_id: parent.id.clone(),
            archived: false,
        },
    )
    .await;
    let mut unowned = host.client().await;
    for id in [&parent.id, &side.id] {
        assert!(matches!(
            ask(
                &mut unowned,
                Request::OpenAgentSession {
                    session_id: id.clone(),
                    provider: Some(TurnProvider::Cli)
                }
            )
            .await,
            Response::Ok
        ));
    }
    assert!(
        unowned
            .adopt_resources(
                unowned.server_id().to_owned(),
                "old-app".into(),
                "new-app".into(),
                vec![main_resource, side_resource]
            )
            .await
            .unwrap()
            .is_empty(),
        "archived child ownership must not survive into unrelated reopens"
    );
}

#[tokio::test]
async fn durable_unknown_main_close_blocks_undo_quit_and_replacement_until_confirmed() {
    use latte_work_protocol::lifecycle::Resource;
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("shared.txt");
    std::fs::write(&file, "before\n").unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let main = create_session(&mut client, project, "codex").await;
    send(&mut client, &main.id, "edit", "main-foreground-write").await;
    wait(&mut client, &main.id, Status::Completed).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: main.id.clone(),
                only_if_idle: Some(true)
            }
        )
        .await,
        Response::Ok
    ));
    let resource = Resource::AgentSession(main.id.clone());
    client
        .claim_resources("app".into(), vec![resource.clone()])
        .await
        .unwrap();
    // Model a close which has lost its actor but retained its durable uncertainty.
    let db = rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    db.execute("INSERT INTO unconfirmed_agent_closes(session_id,reason,close_id) VALUES (?1,'close unconfirmed','close-token')", [&main.id]).unwrap();
    for _ in 0..2 {
        assert!(
            client
                .close_owned_resources(
                    client.server_id().to_owned(),
                    "app".into(),
                    vec![resource.clone()]
                )
                .await
                .is_err()
        );
        assert!(
            matches!(ask(&mut client, Request::UndoTurnChanges { session_id: main.id.clone(), request_id: "edit".into() }).await,
            Response::Error { message, .. } if message.contains("关闭状态待确认"))
        );
        assert!(matches!(
            ask(
                &mut client,
                Request::OpenAgentSession {
                    session_id: main.id.clone(),
                    provider: Some(TurnProvider::Cli)
                }
            )
            .await,
            Response::Error { .. }
        ));
        assert!(matches!(
            send(&mut client, &main.id, "replacement", "hello").await,
            Response::Error { .. }
        ));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
    }
    assert!(matches!(
        ask(
            &mut client,
            Request::ConfirmAgentClosed {
                session_id: main.id.clone(),
                close_id: "close-token".into()
            }
        )
        .await,
        Response::Session { .. }
    ));
    assert!(
        matches!(ask(&mut client, Request::UndoTurnChanges { session_id: main.id.clone(), request_id: "edit".into() }).await,
        Response::TurnChanges { changes } if changes.undo == TurnUndoStatus::Reverted)
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "before\n");
}

#[tokio::test]
async fn an_interrupted_writable_side_chat_can_reopen_and_archive_its_parent() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project, "codex").await;
    send(&mut client, &parent.id, "main-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let side = open_side(&mut client, &parent).await;
    send_writable_side(&mut client, &side, "wait", "default", TurnProvider::Cli).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let path = root.path().join("codex-inputs");
        if std::fs::read_to_string(path)
            .is_ok_and(|contents| contents.contains("\"prompt\": \"wait\""))
        {
            break;
        }
        assert!(Instant::now() < deadline, "side chat did not reach the CLI");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: side.id.clone(),
                only_if_idle: Some(false),
            }
        )
        .await,
        Response::Ok
    ));
    assert!(matches!(ask(&mut client, Request::OpenSideChat {
        session_id: parent.id.clone(), side_id: Some(side.id.clone()),
    }).await, Response::Session { session } if session.id == side.id && session.status == Status::Stopped));
    assert!(matches!(
        send(&mut client, &side.id, "resumed-side", "hello").await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &side.id, Status::Completed).await;
    assert!(matches!(ask(&mut client, Request::ArchiveSession {
        session_id: parent.id.clone(), archived: true,
    }).await, Response::Session { session } if session.archived));
    assert!(matches!(ask(&mut client, Request::Poll {
        session_id: side.id, after: 0.0,
    }).await, Response::Events { session, .. } if session.agent_session_open == Some(false)));
}

#[tokio::test]
async fn main_and_side_closes_can_be_verified_after_a_restart() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project, "codex").await;
    send(&mut client, &parent.id, "main-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let side = open_side(&mut client, &parent).await;
    send(&mut client, &side.id, "read-only", "hello").await;
    wait(&mut client, &side.id, Status::Completed).await;
    drop(client);

    // Simulate interruption after the close journal commits and before its acknowledgement.
    let db = rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    for id in [&parent.id, &side.id] {
        db.execute(
            "INSERT INTO unconfirmed_agent_closes(session_id,reason) VALUES (?1,'close unknown')",
            [id],
        )
        .unwrap();
    }
    drop(db);
    host.process.kill().unwrap();
    host.process.wait().unwrap();
    std::fs::remove_file(host.directory.path().join("control.sock")).unwrap();
    host.process = Host::spawn(host.directory.path(), &[]);
    host.wait_ready().await;
    let mut client = host.client().await;
    for id in [&side.id, &parent.id] {
        let lookup = || Request::Session {
            session_id: id.clone(),
        };
        let close = || Request::CloseAgentSession {
            session_id: id.clone(),
            only_if_idle: Some(false),
        };
        let Response::Session { session } = ask(&mut client, lookup()).await else {
            panic!("session")
        };
        let close_id = session.agent_close_pending.expect("durable close");
        assert!(matches!(
            ask(&mut client, close()).await,
            Response::Error { .. }
        ));
        assert!(matches!(ask(&mut client, Request::ConfirmAgentClosed {
            session_id: id.clone(), close_id,
        }).await, Response::Session { session } if session.agent_close_pending.is_none()));
        assert!(matches!(
            send(&mut client, id, &format!("resumed-{id}"), "hello").await,
            Response::Accepted { .. }
        ));
        wait(&mut client, id, Status::Completed).await;
        assert!(matches!(ask(&mut client, close()).await, Response::Ok));
    }
    assert!(
        matches!(ask(&mut client, Request::ArchiveSession { session_id: parent.id, archived: true }).await,
        Response::Session { session } if session.archived)
    );
}

#[tokio::test]
async fn a_missing_side_cli_does_not_block_undo() {
    use std::os::unix::fs::PermissionsExt;

    let cli_dir = tempfile::tempdir().unwrap();
    let cli = cli_dir.path().join("claude");
    std::fs::write(
        &cli,
        r#"#!/bin/sh
if [ "$1" = "--help" ]; then
    rm -- "$0"
fi
exec "$LATTE_FIXTURE_CLAUDE" "$@"
"#,
    )
    .unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude.py");
    let host = Host::start_with_environment(&[
        ("LATTE_WORK_CLAUDE", cli.as_os_str()),
        ("LATTE_FIXTURE_CLAUDE", fixture.as_os_str()),
    ])
    .await;
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("shared.txt");
    std::fs::write(&file, "before\n").unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project.clone(), "claude").await;
    send(&mut client, &parent.id, "parent-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let side = open_side(&mut client, &parent).await;

    let main = create_session(&mut client, project, "codex").await;
    send(
        &mut client,
        &main.id,
        "main-write",
        "approval-then-main-write",
    )
    .await;
    let pending = permission(&wait(&mut client, &main.id, Status::Waiting).await);
    send_writable_side(&mut client, &side, "hello", "default", TurnProvider::Cli).await;
    assert!(!cli.exists());
    let events = wait(&mut client, &side.id, Status::Failed).await;
    assert!(events.iter().any(|event| matches!(&event.event,
        EventKind::State { message: Some(message), .. } if message.contains("无法启动 Agent claude")
    )));
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: main.id.clone(),
                request_id: pending,
                allow: true,
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut client, &main.id, Status::Completed).await;
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
    let response = ask(
        &mut client,
        Request::UndoTurnChanges {
            session_id: main.id,
            request_id: "main-write".into(),
        },
    )
    .await;
    assert!(
        matches!(&response, Response::TurnChanges { changes }
        if changes.undo == TurnUndoStatus::Reverted),
        "{response:?}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
}

#[tokio::test]
async fn history_pages_past_one_hundred_and_can_reopen_the_oldest_chat() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project, "codex").await;
    send(&mut client, &parent.id, "parent-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let oldest = open_side(&mut client, &parent).await;
    for _ in 0..100 {
        open_side(&mut client, &parent).await;
    }
    let history = |before| Request::SideChatHistory {
        session_id: parent.id.clone(),
        before,
    };
    let Response::SideChatHistory {
        sessions,
        next: Some(next),
    } = ask(&mut client, history(None)).await
    else {
        panic!("first page")
    };
    assert_eq!(sessions.len(), 100);
    assert_eq!(sessions.last().unwrap().id, next);
    assert!(!sessions.iter().any(|entry| entry.id == oldest.id));
    open_side(&mut client, &parent).await;
    assert!(matches!(ask(&mut client, history(Some(next))).await,
        Response::SideChatHistory { sessions, next: None } if sessions.len() == 1 && sessions[0].id == oldest.id
    ));
    assert!(matches!(ask(&mut client, Request::OpenSideChat {
        session_id: parent.id, side_id: Some(oldest.id.clone()),
    }).await, Response::Session { session } if session.id == oldest.id));
}

#[tokio::test]
async fn failed_close_journal_keeps_actor_for_repeated_close_and_reconfigure_attempts() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let main = create_session(&mut client, project, "codex").await;
    send(&mut client, &main.id, "init", "hello").await;
    wait(&mut client, &main.id, Status::Completed).await;
    let db = rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_close_journal BEFORE INSERT ON unconfirmed_agent_closes BEGIN SELECT RAISE(FAIL, 'injected close journal write failure'); END;").unwrap();
    // Configuration replacement also must retain the old handle if it cannot
    // first journal the close. The rejected request cannot enter the ledger.
    assert!(matches!(ask(&mut client, Request::Send {
        session_id: main.id.clone(), request_id: "reconfigure".into(), text: "hello".into(),
        model: None, effort: None, permission_mode: Some("bypass_permissions".into()), provider: Some(TurnProvider::Cli),
    }).await, Response::Error { message, .. } if message.contains("injected")));
    for _ in 0..2 {
        assert!(matches!(ask(&mut client, Request::CloseAgentSession {
            session_id: main.id.clone(), only_if_idle: Some(false),
        }).await, Response::Error { message, .. } if message.contains("injected")));
        assert!(
            matches!(ask(&mut client, Request::Session { session_id: main.id.clone() }).await,
            Response::Session { session } if session.agent_session_open == Some(true) && session.agent_close_pending.is_none())
        );
    }
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM requests WHERE id='reconfigure'",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    db.execute_batch("DROP TRIGGER fail_close_journal").unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: main.id.clone(),
                only_if_idle: Some(false)
            }
        )
        .await,
        Response::Ok
    ));
    assert!(
        matches!(ask(&mut client, Request::Session { session_id: main.id }).await,
        Response::Session { session } if session.agent_session_open == Some(false))
    );
}
