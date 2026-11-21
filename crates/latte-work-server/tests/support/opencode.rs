use super::*;
use latte_work_protocol::{AgentEnvironment, Effort, TurnProvider};
use std::ffi::OsStr;

async fn project(client: &mut Client, path: &Path) -> String {
    let response = ask(
        client,
        Request::AddProject {
            path: path.to_string_lossy().into(),
            name: None,
        },
    )
    .await;
    let Response::Project { project } = response else {
        panic!("{response:?}")
    };
    project.id
}

async fn create(client: &mut Client, project_id: &str) -> String {
    let response = ask(
        client,
        Request::CreateSession {
            project_id: project_id.into(),
            agent: "opencode".into(),
        },
    )
    .await;
    let Response::Session { session } = response else {
        panic!("{response:?}")
    };
    session.id
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

fn open(id: &str) -> Request {
    Request::OpenAgentSession {
        session_id: id.into(),
        provider: Some(TurnProvider::Cli),
    }
}

fn close(id: &str, only_if_idle: bool) -> Request {
    Request::CloseAgentSession {
        session_id: id.into(),
        only_if_idle: Some(only_if_idle),
    }
}

fn turn(id: &str, request: &str, text: &str) -> Request {
    Request::SendQueued {
        session_id: id.into(),
        request_id: request.into(),
        text: text.into(),
        model: Some("test/other".into()),
        effort: Some(Effort::Max),
        permission_mode: None,
        provider: Some(TurnProvider::Cli),
    }
}

fn contains_text(events: &[latte_work_protocol::Event], text: &str) -> bool {
    events
        .iter()
        .any(|event| matches!(&event.event, EventKind::Text { text: actual } if actual == text))
}

#[tokio::test]
async fn opencode_rejects_v1_at_discovery() {
    let host =
        Host::start_with_environment(&[("LATTE_TEST_OPENCODE_VERSION", OsStr::new("1.19.5"))])
            .await;
    let mut client = host.client().await;
    let Response::Hello { agents, .. } =
        ask(&mut client, Request::Hello { version: VERSION }).await
    else {
        panic!("hello")
    };
    assert!(
        agents
            .iter()
            .any(|a| a.id == "opencode" && !a.available && a.detail.contains("2.x"))
    );
    let folder = tempfile::tempdir().unwrap();
    let project_id = project(&mut client, folder.path()).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::CreateSession {
                project_id,
                agent: "opencode".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
}

#[tokio::test]
async fn opencode_metadata_resume_and_reconciliation_use_native_identity() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let response = ask(
        &mut client,
        Request::ModelsForProvider {
            agent: "opencode".into(),
            model: Some("test/other".into()),
            project_id: Some(project_id.clone()),
            provider: None,
            environment: AgentEnvironment(
                [("OPENCODE_FIXTURE_LABEL".into(), "Configured".into())].into(),
            ),
        },
    )
    .await;
    assert!(
        matches!(response, Response::Models { default_model, effort_levels, model_labels, .. }
        if default_model.as_deref() == Some("test/default") && effort_levels == [Effort::Medium, Effort::Max] && model_labels["test/other"] == "Configured")
    );
    assert!(
        matches!(ask(&mut client, Request::AgentCommands { agent: "opencode".into(), project_id: project_id.clone(), provider: None }).await,
        Response::AgentCommands { commands } if commands.iter().any(|c| c.name == "compact") && commands.iter().any(|c| c.name == "project:check"))
    );
    assert_eq!(
        std::fs::read_dir(folder.path()).unwrap().count(),
        0,
        "metadata leaves no native session"
    );
    let id = create(&mut client, &project_id).await;
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    let draft = current(&mut client, &id).await;
    assert_eq!(draft.agent_session_open, Some(true));
    assert!(draft.native_id.is_none());
    assert!(!folder.path().join("prompts").exists());
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));

    let first = || turn(&id, "command", "/compact");
    assert!(matches!(
        ask(&mut client, first()).await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "fixture "));
    assert!(contains_text(&events, "reply"));
    assert!(!contains_text(&events, "wrong session"));
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("private reasoning")
    );
    assert!(events.iter().any(|event| matches!(&event.event, EventKind::Usage { context: Some(context), totals: Some(totals) } if context.model == "test/other" && totals.output_tokens == Some(3.0))));
    let native = current(&mut client, &id).await.native_id.unwrap();
    drop(client);
    let mut client = host.client().await;
    assert!(matches!(
        ask(&mut client, first()).await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    assert!(matches!(
        ask(&mut client, turn(&id, "second", "after reopen")).await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some(native.as_str())
    );
    let log = std::fs::read_to_string(folder.path().join("prompts")).unwrap();
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        [
            format!("{native}:test/other:max:/compact"),
            format!("{native}:test/other:max:after reopen"),
        ]
    );

    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    std::fs::remove_file(folder.path().join(&native)).unwrap();
    assert!(matches!(
        ask(&mut client, open(&id)).await,
        Response::Error { .. }
    ));
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some(native.as_str())
    );
    assert_eq!(
        std::fs::read_dir(folder.path()).unwrap().count(),
        1,
        "resume failure must not create a replacement session"
    );
}

#[tokio::test]
async fn opencode_permissions_cancel_and_eof_do_not_infer_completion() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    let other = create(&mut client, &project_id).await;
    for (request, allow) in [("permission-allow", true), ("permission-deny", false)] {
        assert!(matches!(
            ask(&mut client, turn(&id, request, request)).await,
            Response::Accepted { .. }
        ));
        let events = wait(&mut client, &id, Status::Waiting).await;
        let token = permission(&events);
        let approve = |session_id: &str| Request::Approve {
            session_id: session_id.into(),
            request_id: token.clone(),
            allow,
        };
        assert!(matches!(
            ask(&mut client, approve(&other)).await,
            Response::Error { .. }
        ));
        assert!(matches!(ask(&mut client, approve(&id)).await, Response::Ok));
        assert!(matches!(
            ask(&mut client, approve(&id)).await,
            Response::Error { .. }
        ));
        let events = wait(&mut client, &id, Status::Completed).await;
        assert!(contains_text(
            &events,
            if allow {
                "decision:once"
            } else {
                "decision:no"
            }
        ));
    }
    assert!(matches!(
        ask(&mut client, turn(&id, "cancel", "permission-cancel")).await,
        Response::Accepted { .. }
    ));
    let token = permission(&wait(&mut client, &id, Status::Waiting).await);
    let stopped = ask(
        &mut client,
        Request::Cancel {
            session_id: id.clone(),
        },
    )
    .await;
    assert!(matches!(stopped, Response::Ok), "{stopped:?}");
    wait(&mut client, &id, Status::Stopped).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: token,
                allow: true
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert!(matches!(
        ask(&mut client, turn(&id, "eof", "unexpected-eof")).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Failed).await;
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::State { status: Status::Failed, message: Some(text) } if text.contains("意外退出"))));
}

#[tokio::test]
async fn opencode_delayed_steering_tracks_successor_approval_and_completion() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "parent", "steer-parent")).await,
        Response::Accepted { .. }
    ));
    // Reconcile metadata readiness through the existing open call.
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    assert!(matches!(
        ask(&mut client, turn(&id, "delayed", "more work")).await,
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
    let entry = entries
        .iter()
        .find(|entry| entry.request_id == "delayed")
        .unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::DispatchQueuedMessage {
                session_id: id.clone(),
                request_id: entry.request_id.clone(),
                revision: entry.revision,
                interrupt: false,
                provider: Some(TurnProvider::Cli),
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "steered parent finished"));
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Error { .. }
    ));
    std::fs::write(folder.path().join("release-steer"), "release").unwrap();
    let token = permission(&wait(&mut client, &id, Status::Waiting).await);
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: token,
                allow: true,
            }
        )
        .await,
        Response::Ok
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        events
            .iter()
            .filter(
                |event| matches!(&event.event, EventKind::Text { text } if text == "decision:once")
            )
            .count(),
        1
    );
    assert_eq!(events.iter().filter(|event| matches!(&event.event, EventKind::Usage { totals:Some(totals), .. } if totals.output_tokens == Some(3.0))).count(), 2);
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
}

#[tokio::test]
async fn opencode_project_command_waits_for_native_response_without_sending_a_prompt() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(
            &mut client,
            turn(&id, "native-command", "/project:check now")
        )
        .await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "command reply"));
    assert!(current(&mut client, &id).await.native_id.is_some());
    assert!(!folder.path().join("prompts").exists());
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
}

#[tokio::test]
async fn opencode_skill_metadata_reads_project_install_without_starting_agent() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    let skill = folder
        .path()
        .join(".opencode/skills/fixture-opencode-skill");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: Fixture Skill\ndescription: Project skill\n---\nprivate body\n",
    )
    .unwrap();
    let request = |name: &str| Request::SkillInfo {
        session_id: id.clone(),
        name: name.into(),
    };
    assert!(matches!(
        ask(&mut client, request("fixture-opencode-skill")).await,
        Response::SkillInfo { skill: Some(info) }
            if info.name == "Fixture Skill" && info.description == "Project skill"
                && std::path::Path::new(&info.directory) == skill.canonicalize().unwrap()
    ));
    assert!(matches!(
        ask(&mut client, request("../fixture-opencode-skill")).await,
        Response::Error { .. }
    ));
    assert_eq!(
        current(&mut client, &id).await.agent_session_open,
        Some(false)
    );
}

#[tokio::test]
async fn opencode_child_transcript_is_separate_and_prevents_idle_close() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "child", "background")).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "main only"));
    assert!(!contains_text(&events, "child only"));
    assert_eq!(
        current(&mut client, &id).await.agent_session_busy,
        Some(true)
    );
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Error { .. }
    ));
    let Response::Subagents { tasks, .. } = ask(
        &mut client,
        Request::Subagents {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("children")
    };
    assert_eq!(tasks.len(), 1);
    let task_id = tasks[0].id.clone();
    assert!(
        matches!(ask(&mut client, Request::SubagentHistory { session_id: id.clone(), task_id, after: None, source: None, provider: None }).await,
        Response::SubagentHistory { events, .. } if contains_text(&events, "child only"))
    );
    assert!(matches!(
        ask(&mut client, close(&id, false)).await,
        Response::Ok
    ));
}

#[tokio::test]
async fn opencode_recovers_nested_history_only_within_known_project_and_ancestry() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "nested", "nested")).await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    for (task_id, expected_source, expected_text) in [
        ("ses_nested", "native", "native ses_nested"),
        ("ses_unowned", "stream", "stream ses_unowned"),
        ("ses_other_project", "stream", "stream ses_other_project"),
    ] {
        let response = ask(
            &mut client,
            Request::SubagentHistory {
                session_id: id.clone(),
                task_id: task_id.into(),
                after: None,
                source: None,
                provider: Some(TurnProvider::Cli),
            },
        )
        .await;
        assert!(
            matches!(&response, Response::SubagentHistory { source, events, .. }
                if source == expected_source && contains_text(events, expected_text)),
            "{response:?}"
        );
        if task_id == "ses_nested" {
            let Response::SubagentHistory {
                incomplete, events, ..
            } = response
            else {
                unreachable!()
            };
            assert!(incomplete);
            assert!(events.iter().any(|e| matches!(&e.event, EventKind::ToolResult { is_error: true, content, .. } if content[0]["text"] == "native shell failure")));
            assert!(events.iter().any(
                |e| matches!(&e.event, EventKind::Tool { id, .. } if id == "tool_unfinished")
            ));
            assert!(!events.iter().any(
                |e| matches!(&e.event, EventKind::ToolResult { id, .. } if id == "tool_unfinished")
            ));
        }
    }
}

#[tokio::test]
async fn opencode_ignores_late_foreground_events_and_runs_the_background_notification() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    for (request, text) in [
        ("path", "/tmp/project/src inspect this"),
        ("single-component-path", "/tmp inspect this"),
        (
            "missing-path",
            "/missing-project explain why this path does not exist",
        ),
        ("race", "/compact late-native"),
    ] {
        assert!(matches!(
            ask(&mut client, turn(&id, request, text)).await,
            Response::Accepted { .. }
        ));
        wait(&mut client, &id, Status::Completed).await;
    }
    std::fs::write(folder.path().join("release-native"), "").unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(6), async {
        loop {
            let events = wait(&mut client, &id, Status::Completed).await;
            if contains_text(&events, "real follow-up") {
                break events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert!(contains_text(&events, "ACP reply"));
    assert!(!contains_text(&events, "duplicate native reply"));
    let after = events.last().unwrap().seq;
    assert!(matches!(
        ask(&mut client, turn(&id, "ordered", "before-delivery")).await,
        Response::Accepted { .. }
    ));
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let Response::Events {
                session, events, ..
            } = ask(
                &mut client,
                Request::Poll {
                    session_id: id.clone(),
                    after: 0.0,
                },
            )
            .await
            else {
                panic!("poll");
            };
            if contains_text(&events, "plugin finished first") {
                assert_eq!(session.status, Status::Running);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    std::fs::write(folder.path().join("release-prompt"), "").unwrap();
    let events = wait(&mut client, &id, Status::Completed).await;
    let usage: Vec<_> = events
        .iter()
        .filter(|event| event.seq > after)
        .filter_map(|event| match &event.event {
            EventKind::Usage {
                totals: Some(totals),
                ..
            } => Some(totals),
            _ => None,
        })
        .collect();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].output_tokens, Some(3.0));
    let log = std::fs::read_to_string(folder.path().join("prompts")).unwrap();
    assert!(log.contains(":/missing-project explain why this path does not exist\n"));
}

#[tokio::test]
async fn opencode_routes_native_command_child_approval_and_preserves_tool_identity() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(
            &mut client,
            turn(&id, "command", "/project:check child permission")
        )
        .await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Waiting).await;
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::Approval { input, .. } if input["command"] == "printf fixture")));
    let request_id = permission(&events);
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: request_id.clone(),
                allow: true
            }
        )
        .await,
        Response::Error { message, .. } if message.contains("仍待处理")
    ));
    let events = wait(&mut client, &id, Status::Waiting).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(&e.event, EventKind::ApprovalResolved { .. }))
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id,
                allow: true
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut client, &id, Status::Completed).await;
    let Response::Subagents { tasks, .. } = ask(
        &mut client,
        Request::Subagents {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("children")
    };
    let Response::SubagentHistory { events, .. } = ask(
        &mut client,
        Request::SubagentHistory {
            session_id: id,
            task_id: tasks[0].id.clone(),
            after: None,
            source: None,
            provider: None,
        },
    )
    .await
    else {
        panic!("history")
    };
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::Tool { name, input, .. } if name == "Skill" && input["skill"] == "fixture-skill")));
}

#[tokio::test]
async fn opencode_parent_finishes_while_a_child_question_remains_answerable() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "parent", "background-question")).await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Waiting).await;
    std::fs::write(folder.path().join("release-parent"), "").unwrap();
    let (request_id, question_id) = tokio::time::timeout(std::time::Duration::from_secs(6), async {
        loop {
            let events = wait(&mut client, &id, Status::Waiting).await;
            if events.iter().any(|e| matches!(&e.event, EventKind::TurnChanges { changes } if changes.request_id == "parent"))
                && let Some(ids) = events.iter().find_map(|e| match &e.event {
                    EventKind::Question { request_id, questions, .. } => Some((request_id.clone(), questions[0].id.clone())),
                    _ => None,
                })
            {
                break ids;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }).await.unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::AnswerQuestion {
                session_id: id.clone(),
                request_id,
                answers: Some(vec![latte_work_protocol::QuestionAnswer {
                    question_id,
                    option_indices: vec![0],
                    text: None,
                }]),
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut client, &id, Status::Completed).await;
}

#[tokio::test]
async fn opencode_silent_successor_is_running_and_cancel_reaches_native_execution() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "parent", "steer-parent")).await,
        Response::Accepted { .. }
    ));
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    assert!(matches!(
        ask(&mut client, turn(&id, "silent", "silent successor")).await,
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
    let entry = &entries[0];
    assert!(matches!(
        ask(
            &mut client,
            Request::DispatchQueuedMessage {
                session_id: id.clone(),
                request_id: entry.request_id.clone(),
                revision: entry.revision,
                interrupt: false,
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::Usage { context:Some(context), totals:Some(totals) }
        if context.model == "test/other" && context.used_tokens == 28.0 && context.window_tokens == Some(10000.0) && totals.input_tokens == Some(25.0))));
    let native = current(&mut client, &id).await.native_id;
    std::fs::write(folder.path().join("release-steer"), "release").unwrap();
    // Wait until the input is consumed, so cancellation cannot pass through
    // the fallback that kills a process with an uncertain forwarded input.
    let db = rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let status: String = db
            .query_row(
                "SELECT status FROM message_queue WHERE session_id=?1 AND request_id='silent'",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        if status == "dispatched" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "input remains {status}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(current(&mut client, &id).await.status, Status::Running);
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
        std::fs::read_to_string(folder.path().join("native-interrupted")).unwrap(),
        native.unwrap()
    );
    assert!(matches!(
        ask(&mut client, turn(&id, "after", "after stop")).await,
        Response::Accepted { .. }
    ));
    assert!(contains_text(
        &wait(&mut client, &id, Status::Completed).await,
        "reply"
    ));
}

#[tokio::test]
async fn opencode_resume_repairs_a_moved_native_session_directory() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "first", "hello")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let native = current(&mut client, &id).await.native_id.unwrap();
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    // The fixture pins the session to a directory that no longer matches the
    // project, mirroring an OpenCode session moved into a deleted worktree.
    std::fs::write(folder.path().join(&native), "moved").unwrap();
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    assert!(matches!(
        ask(&mut client, turn(&id, "second", "after move")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some(native.as_str())
    );
    let log = std::fs::read_to_string(folder.path().join("prompts")).unwrap();
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        [
            format!("{native}:test/other:max:hello"),
            format!("{native}:test/other:max:after move"),
        ]
    );
    let leftovers: Vec<_> = std::fs::read_dir(folder.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("ses_"))
        })
        .collect();
    assert_eq!(
        leftovers,
        vec![folder.path().join(&native)],
        "the disposable repair session is deleted"
    );
}

#[tokio::test]
async fn opencode_resume_keeps_a_worktree_session_in_its_worktree() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "seed", "in project")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let native = current(&mut client, &id).await.native_id.unwrap();
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    // The session moved into a worktree that still exists; its export
    // reports the new directory, and the native session state moved along.
    std::fs::write(
        folder.path().join(format!("{native}.json")),
        serde_json::json!({
            "info": {"id": native, "location": {"directory": worktree.path()}},
            "messages": [],
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(worktree.path().join(&native), "prompted").unwrap();
    let response = ask(&mut client, open(&id)).await;
    let Response::Ok = response else {
        panic!("open failed: {response:?}");
    };
    assert!(matches!(
        ask(&mut client, turn(&id, "wt", "from worktree")).await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some(native.as_str())
    );
    // The turn's before and after snapshots both cover the project directory;
    // running the agent in the worktree must not fabricate cross-directory
    // changes (the session export file is not reported as deleted).
    let changes = events
        .iter()
        .find_map(|event| match &event.event {
            EventKind::TurnChanges { changes } if changes.request_id == "wt" => {
                Some(&changes.summary)
            }
            _ => None,
        })
        .expect("turn changes");
    assert!(
        changes.entries.is_empty() && changes.unavailable.is_none(),
        "snapshot stays rooted at the project directory: {changes:?}"
    );
    let log = std::fs::read_to_string(worktree.path().join("prompts")).unwrap();
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        [format!("{native}:test/other:max:from worktree")],
        "the agent process resumed inside the worktree"
    );
    let seeded = std::fs::read_to_string(folder.path().join("prompts")).unwrap();
    assert_eq!(
        seeded.lines().collect::<Vec<_>>(),
        [format!("{native}:test/other:max:in project")],
        "only the first turn ran in the project directory"
    );
}

#[tokio::test]
async fn opencode_update_project_directory_migrates_project_sessions_and_preserves_subagent_history()
 {
    let host = Host::start().await;
    let old_folder = tempfile::tempdir().unwrap();
    let new_folder = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, old_folder.path()).await;

    // 1. A project-rooted session with nested subagents in old_folder.
    let main_id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&main_id, "seed-nested", "nested")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &main_id, Status::Completed).await;
    let main_native = current(&mut client, &main_id).await.native_id.unwrap();

    // 2. A worktree-pinned session under the same project.
    let wt_id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&wt_id, "seed-wt", "in old root")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &wt_id, Status::Completed).await;
    let wt_native = current(&mut client, &wt_id).await.native_id.unwrap();

    // Move project from old_folder to new_folder while old_folder still exists on disk!
    // Without former_paths filtering, resume_directory would mistake old_folder for a live
    // worktree and silently keep main_id pinned to old_folder.
    let Response::ProjectUpdated {
        closed_session_ids, ..
    } = ask(
        &mut client,
        Request::UpdateProject {
            project_id: project_id.clone(),
            name: "OpenCode Moved".into(),
            path: new_folder.path().to_string_lossy().into_owned(),
        },
    )
    .await
    else {
        panic!("expected ProjectUpdated");
    };
    assert!(closed_session_ids.contains(&main_id));
    assert!(closed_session_ids.contains(&wt_id));

    // Export metadata in new_folder still reports main_native's recorded directory as old_folder,
    // and OpenCode rejects resuming main_native in new_folder until repair-move runs.
    let old_canonical = old_folder.path().canonicalize().unwrap();
    std::fs::write(
        new_folder.path().join(format!("{main_native}.json")),
        serde_json::json!({
            "info": {"id": main_native, "location": {"directory": old_canonical}},
            "messages": [],
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(new_folder.path().join(&main_native), "moved").unwrap();

    // Subagent exports in new_folder also still carry old_canonical as their location.directory.
    for child_export in ["ses_child.json", "ses_nested.json"] {
        std::fs::copy(
            old_folder.path().join(child_export),
            new_folder.path().join(child_export),
        )
        .unwrap();
    }

    // Worktree session's export reports `worktree`, which is NOT in former_paths.
    std::fs::write(
        new_folder.path().join(format!("{wt_native}.json")),
        serde_json::json!({
            "info": {"id": wt_native, "location": {"directory": worktree.path()}},
            "messages": [],
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(worktree.path().join(&wt_native), "prompted").unwrap();

    // Reopening main_id must repair-move into new_folder (NOT launch in old_folder).
    assert!(matches!(
        ask(&mut client, open(&main_id)).await,
        Response::Ok
    ));
    assert!(matches!(
        ask(&mut client, turn(&main_id, "after-move", "in new root")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &main_id, Status::Completed).await;
    let new_log = std::fs::read_to_string(new_folder.path().join("prompts")).unwrap();
    assert_eq!(
        new_log.lines().collect::<Vec<_>>(),
        [format!("{main_native}:test/other:max:in new root")]
    );

    // Reopening wt_id continues to resume inside its dedicated worktree.
    assert!(matches!(ask(&mut client, open(&wt_id)).await, Response::Ok));
    assert!(matches!(
        ask(&mut client, turn(&wt_id, "wt-turn", "still in worktree")).await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut client, &wt_id, Status::Completed).await;
    let wt_log = std::fs::read_to_string(worktree.path().join("prompts")).unwrap();
    assert_eq!(
        wt_log.lines().collect::<Vec<_>>(),
        [format!("{wt_native}:test/other:max:still in worktree")]
    );

    // Even after old_folder is deleted from disk, native subagent history recorded under
    // old_canonical remains trusted via former_paths.
    drop(old_folder);
    let subagent_resp = ask(
        &mut client,
        Request::SubagentHistory {
            session_id: main_id.clone(),
            task_id: "ses_nested".into(),
            after: None,
            source: None,
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert!(
        matches!(
            &subagent_resp,
            Response::SubagentHistory { source, events, .. }
                if source == "native" && contains_text(events, "native ses_nested")
        ),
        "{subagent_resp:?}"
    );
}
