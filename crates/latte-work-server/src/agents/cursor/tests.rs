use super::*;
use serde_json::json;

fn config() -> LaunchConfig {
    LaunchConfig {
        environment: Default::default(),
        provider: None,
        settings_dir: std::path::PathBuf::new(),
        model: None,
        traex_model: None,
        effort: None,
        permission_mode: None,
    }
}
fn started(resume: Option<&str>) -> Cursor {
    let mut adapter = Cursor::default();
    adapter
        .command("/fixture/cursor", "/tmp", resume, &config())
        .unwrap();
    adapter.advance(Input::Start { prompt: "test" }).unwrap();
    adapter
}
fn message(adapter: &mut Cursor, value: serde_json::Value) -> anyhow::Result<Vec<Action>> {
    adapter.advance(Input::Message(&value.to_string()))
}
fn init(adapter: &mut Cursor, id: &str) {
    let actions = message(
        adapter,
        json!({"type":"system","subtype":"init","session_id":id}),
    )
    .unwrap();
    assert!(matches!(&actions[..], [Action::NativeSession(s)] if s == id));
}
fn text(actions: &[Action]) -> String {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Event(latte_work_protocol::EventKind::Text { text }) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn cursor_spawn_is_prompt_argv_and_resume_is_exact() {
    let mut adapter = Cursor::default();
    let mut cfg = config();
    cfg.model = Some("native-id".into());
    cfg.permission_mode = Some("ask".into());
    adapter
        .command("/fixture/cursor", "/tmp", Some("session-one"), &cfg)
        .unwrap();
    assert_eq!(
        adapter.transport_lifetime(),
        super::super::TransportLifetime::PerTurn
    );
    assert!(adapter.advance(Input::Open).unwrap().is_empty());
    let actions = adapter
        .advance(Input::Start {
            prompt: "--force; $(touch /tmp/never)",
        })
        .unwrap();
    let [Action::SpawnTurn(command)] = &actions[..] else {
        panic!("expected native spawn")
    };
    let argv: Vec<_> = command
        .command
        .as_std()
        .get_args()
        .map(|a| a.to_str().unwrap())
        .collect();
    assert_eq!(
        argv,
        [
            "--print",
            "--output-format",
            "stream-json",
            "--model",
            "native-id",
            "--mode",
            "ask",
            "--resume",
            "session-one",
            "--",
            "--force; $(touch /tmp/never)"
        ]
    );
    assert_eq!(
        command.command.as_std().get_current_dir().unwrap(),
        std::path::Path::new("/tmp")
    );
    assert!(
        message(
            &mut adapter,
            json!({"type":"system","subtype":"init","session_id":"different"})
        )
        .is_err()
    );
}

#[test]
fn cursor_complete_assistant_segments_keep_legitimate_repetitions_not_result_aggregate() {
    let mut adapter = started(None);
    init(&mut adapter, "session");
    let frame = json!({"type":"assistant","session_id":"session","message":{"role":"assistant","content":[{"type":"text","text":"same"}]}});
    assert_eq!(text(&message(&mut adapter, frame.clone()).unwrap()), "same");
    assert_eq!(text(&message(&mut adapter, frame).unwrap()), "same");
    let actions = message(&mut adapter,json!({"type":"result","subtype":"success","session_id":"session","is_error":false,"result":"samesame"})).unwrap();
    assert_eq!(text(&actions), "");
    assert!(matches!(
        actions.last(),
        Some(Action::Finished { failed: false, .. })
    ));
    assert!(
        message(
            &mut adapter,
            json!({"type":"assistant","session_id":"session","message":{"content":[]}})
        )
        .is_err()
    );
    adapter.advance(Input::Start { prompt: "next" }).unwrap();
    assert!(message(&mut adapter,json!({"type":"result","subtype":"success","session_id":"session","is_error":false,"result":"stale"})).is_err());
    init(&mut adapter, "session");
    assert_eq!(text(&message(&mut adapter,json!({"type":"result","subtype":"success","session_id":"session","is_error":false,"result":"result-only"})).unwrap()),"result-only");
}

#[test]
fn cursor_tools_pair_by_call_id_and_report_native_errors() {
    let mut adapter = started(None);
    init(&mut adapter, "session");
    let call = |subtype: &str, result: serde_json::Value| json!({"type":"tool_call","subtype":subtype,"session_id":"session","call_id":"read-1","tool_call":{"readToolCall":{"args":{"path":"a.rs"},"result":result}}});
    let actions = message(&mut adapter, call("started", serde_json::Value::Null)).unwrap();
    assert!(
        matches!(&actions[..],[Action::Event(latte_work_protocol::EventKind::Tool { id,name,.. })] if id == "read-1" && name == "readToolCall")
    );
    let actions = message(
        &mut adapter,
        call("completed", json!({"error":{"message":"not found"}})),
    )
    .unwrap();
    assert!(
        matches!(&actions[..],[Action::Event(latte_work_protocol::EventKind::ToolResult { id,is_error:true,.. })] if id == "read-1")
    );
    assert!(message(&mut adapter, call("completed", json!({"success":{}}))).is_err());
}

#[test]
fn cursor_rejects_unfenced_or_malformed_critical_frames() {
    for frame in [
        json!({"type":"result","subtype":"success","session_id":"s","result":"x"}),
        json!({"type":"result","subtype":"success","session_id":"s","is_error":true,"result":"x"}),
        json!({"type":"assistant","session_id":"other","message":{"content":[]}}),
        json!({"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":1}]}}),
        json!({"type":"tool_call","subtype":"completed","session_id":"s","call_id":"unknown","tool_call":{"readToolCall":{"args":{},"result":{"success":{}}}}}),
    ] {
        let mut adapter = started(None);
        init(&mut adapter, "s");
        assert!(message(&mut adapter, frame).is_err());
    }
    let mut adapter = started(None);
    assert!(adapter.advance(Input::Message("not json")).is_err());
    assert!(
        message(
            &mut adapter,
            json!({"type":"assistant","session_id":"s","message":{"content":[]}})
        )
        .is_err()
    );
}

#[test]
fn cursor_launch_rejects_unsupported_provider_effort_and_permission() {
    for permission in ["default", "bypass_permissions", "--force"] {
        let mut cfg = config();
        cfg.permission_mode = Some(permission.into());
        assert!(
            Cursor::default()
                .command("fixture", "/tmp", None, &cfg)
                .is_err()
        );
    }
    let mut cfg = config();
    cfg.effort = Some(latte_work_protocol::Effort::High);
    assert!(
        Cursor::default()
            .command("fixture", "/tmp", None, &cfg)
            .is_err()
    );
    assert!(
        Cursor::default()
            .command("fixture", "/tmp", Some(""), &config())
            .is_err()
    );
}

#[test]
fn cursor_confirmed_transport_close_preserves_resume_without_simulated_ready() {
    let mut adapter = started(None);
    assert!(!adapter.can_reconfigure());
    assert!(!adapter.can_start_turn());
    assert!(
        adapter
            .advance(Input::Start {
                prompt: "concurrent"
            })
            .is_err()
    );
    init(&mut adapter, "session-kept");
    adapter.transport_closed();
    assert!(adapter.can_reconfigure());
    assert!(adapter.can_start_turn());
    assert!(!adapter.has_background_work());
    assert!(!adapter.knows_subagent("child"));
    let actions = adapter
        .advance(Input::Start {
            prompt: "after stop",
        })
        .unwrap();
    let [Action::SpawnTurn(command)] = &actions[..] else {
        panic!()
    };
    let argv: Vec<_> = command.command.as_std().get_args().collect();
    assert_eq!(
        argv,
        [
            "--print",
            "--output-format",
            "stream-json",
            "--resume",
            "session-kept",
            "--",
            "after stop"
        ]
    );
    init(&mut adapter, "session-kept");
    assert!(
        message(
            &mut adapter,
            json!({"type":"system","subtype":"init","session_id":"session-kept"})
        )
        .is_err()
    );
}

#[test]
fn cursor_all_machine_control_capabilities_fail_explicitly() {
    let mut adapter = Cursor::default();
    assert!(
        adapter
            .advance(Input::Start {
                prompt: "not prepared"
            })
            .is_err()
    );
    assert!(
        adapter
            .advance(Input::RenameTitle {
                id: "r",
                title: "title"
            })
            .is_err()
    );
    assert!(
        adapter
            .advance(Input::Approval {
                id: "a",
                input: json!({}),
                allow: true
            })
            .is_err()
    );
    assert!(
        adapter
            .advance(Input::QuestionAnswer {
                id: "q",
                input: json!({}),
                questions: vec![],
                answers: None
            })
            .is_err()
    );
    assert!(adapter.advance(Input::Sideband("{}")).is_err());
    let mut cfg = config();
    cfg.provider = Some(crate::providers::ResolvedProvider {
        metadata: latte_work_protocol::Provider {
            id: "p".into(),
            name: "Fixture".into(),
            protocol: latte_work_protocol::ProviderProtocol::OpenaiResponses,
            base_url: "https://example.test".into(),
            model: "fixture".into(),
            models: vec![],
            model_labels: Default::default(),
            models_1m: vec![],
            auth: latte_work_protocol::ProviderAuth::None,
            has_credential: false,
            revision: "fixture".into(),
        },
        credential: String::new(),
    });
    assert!(adapter.command("fixture", "/tmp", None, &cfg).is_err());
    for id in ["", "a b", "a\n"] {
        assert!(
            adapter
                .command("fixture", "/tmp", Some(id), &config())
                .is_err()
        );
    }
    let mut cfg = config();
    cfg.model = Some("bad\nmodel".into());
    assert!(adapter.command("fixture", "/tmp", None, &cfg).is_err());
}

#[test]
fn cursor_successful_tools_remain_unconfirmed_until_valid_result_and_fence_mismatches() {
    let call = |id: &str, subtype: &str, args: serde_json::Value, result: serde_json::Value| json!({"type":"tool_call","subtype":subtype,"session_id":"s","call_id":id,"tool_call":{"writeToolCall":{"args":args,"result":result}}});
    let mut adapter = started(None);
    init(&mut adapter, "s");
    let args = json!({"path":"a.rs","fileText":"text"});
    message(
        &mut adapter,
        call("w", "started", args.clone(), json!(null)),
    )
    .unwrap();
    assert!(
        message(
            &mut adapter,
            call("w", "started", args.clone(), json!(null))
        )
        .is_err()
    );
    assert!(
        message(
            &mut adapter,
            call(
                "w",
                "completed",
                json!({"path":"other"}),
                json!({"success":{}})
            )
        )
        .is_err()
    );
    for result in [
        json!({}),
        json!({"success":null}),
        json!({"success":false}),
        json!({"success":"untyped"}),
        json!({"success":{},"error":{}}),
    ] {
        assert!(message(&mut adapter, call("w", "completed", args.clone(), result)).is_err());
    }
    assert!(message(&mut adapter, json!({"type":"result","subtype":"success","session_id":"s","is_error":false,"result":"unconfirmed"})).is_err());
    let success = json!({"success":{"path":"a.rs","fileSize":4,"linesCreated":1}});
    let actions = message(&mut adapter, call("w", "completed", args, success.clone())).unwrap();
    assert!(
        matches!(&actions[..], [Action::Event(latte_work_protocol::EventKind::ToolResult { content, is_error:false,.. })] if content == &success)
    );
    assert!(
        message(
            &mut adapter,
            json!({"type":"extension","session_id":"s","extra":true})
        )
        .unwrap()
        .is_empty()
    );
    assert!(message(&mut adapter,json!({"type":"assistant","session_id":"s","message":{"content":[{"type":"thinking","text":"hidden"},{"type":"text","text":""}]}})).unwrap().is_empty());
    let actions = message(
        &mut adapter,
        json!({"type":"result","subtype":"success","session_id":"s","is_error":false,"result":""}),
    )
    .unwrap();
    assert!(matches!(
        &actions[..],
        [Action::Finished { failed: false, .. }]
    ));
}

#[test]
fn cursor_model_parser_uses_native_ids_without_inventing_effort_or_context() {
    let catalog = metadata::catalog("Available models\n\nauto - Auto (default)\nnative-high - Native High 1M\n\nTip: use --model <id>\n", Some("native-high")).unwrap();
    let latte_work_protocol::Response::Models {
        models,
        default_model,
        model_labels,
        effort_levels,
        model_variants,
        ..
    } = catalog
    else {
        panic!()
    };
    assert_eq!(models, ["auto", "native-high"]);
    assert_eq!(default_model.as_deref(), Some("auto"));
    assert_eq!(model_labels["native-high"], "Native High 1M");
    assert!(effort_levels.is_empty());
    assert!(model_variants.is_none());
    for invalid in [
        "login required",
        "Available models\n",
        "Available models\na - A\na - B",
        "Available models\na - A (default)\nb - B (default)",
    ] {
        assert!(metadata::catalog(invalid, None).is_err());
    }
}

#[test]
fn cursor_catalog_returns_current_models_when_saved_selection_is_unavailable() {
    let catalog = metadata::catalog(
        "Available models\ncurrent - Current (default)",
        Some("removed-model"),
    )
    .unwrap();
    let latte_work_protocol::Response::Models {
        models,
        model_labels,
        default_model,
        ..
    } = catalog
    else {
        panic!("expected current Cursor catalog")
    };
    assert_eq!(models, ["current"]);
    assert_eq!(default_model.as_deref(), Some("current"));
    assert!(!model_labels.contains_key("removed-model"));
}

#[test]
fn cursor_native_frames_have_a_one_mib_ingestion_bound() {
    assert_eq!(Cursor::default().frame_limit(), Some(1024 * 1024));
    assert_eq!(super::super::create("claude").unwrap().frame_limit(), None);
}

#[test]
fn cursor_official_generic_function_input_preserves_opaque_arguments() {
    // Official Other tools contract only publishes name + string arguments.
    // It does not publish a generic-function completed result schema.
    let mut adapter = started(None);
    init(&mut adapter, "s");
    let started = json!({"type":"tool_call","subtype":"started","session_id":"s","call_id":"f",
        "tool_call":{"function":{"name":"tool_name","arguments":"..."}}});
    let actions = message(&mut adapter, started).unwrap();
    assert!(
        matches!(&actions[..], [Action::Event(latte_work_protocol::EventKind::Tool { id, name, input })]
        if id == "f" && name == "tool_name" && input == &json!("..."))
    );
    let completion = |name: &str, arguments: &str| {
        json!({"type":"tool_call","subtype":"completed","session_id":"s","call_id":"f",
        "tool_call":{"function":{"name":name,"arguments":arguments}}})
    };
    assert!(
        message(&mut adapter, completion("different", "..."))
            .err()
            .unwrap()
            .to_string()
            .contains("不匹配")
    );
    assert!(
        message(&mut adapter, completion("tool_name", "changed"))
            .err()
            .unwrap()
            .to_string()
            .contains("不匹配")
    );
    let actions = message(&mut adapter, completion("tool_name", "...")).unwrap();
    assert!(
        matches!(&actions[..], [Action::Event(latte_work_protocol::EventKind::Notice { text })] if text.contains("工具结果未确认"))
    );
    // No assumed result location or fabricated is_error:false tool outcome.
    // A native terminal success can complete the turn, not certify this tool.
    let actions = message(&mut adapter,json!({"type":"result","subtype":"success","session_id":"s","is_error":false,"result":"reply"})).unwrap();
    assert!(matches!(
        actions.last(),
        Some(Action::Finished { failed: false, .. })
    ));
}

#[test]
fn cursor_duplicate_completed_call_pair_is_rejected_and_total_ids_are_bounded() {
    let call = |id: &str, subtype: &str| {
        json!({"type":"tool_call","subtype":subtype,"session_id":"s","call_id":id,
        "tool_call":{"readToolCall":{"args":{"path":"a"},"result":{"success":{}}}}})
    };
    let mut adapter = started(None);
    init(&mut adapter, "s");
    message(&mut adapter, call("same", "started")).unwrap();
    message(&mut adapter, call("same", "completed")).unwrap();
    assert!(message(&mut adapter, call("same", "started")).is_err());
    for index in 1..512 {
        let id = format!("call-{index}");
        message(&mut adapter, call(&id, "started")).unwrap();
        message(&mut adapter, call(&id, "completed")).unwrap();
    }
    assert!(message(&mut adapter, call("call-513", "started")).is_err());
    message(
        &mut adapter,
        json!({"type":"result","subtype":"success","session_id":"s","is_error":false,"result":""}),
    )
    .unwrap();
    adapter
        .advance(Input::Start { prompt: "new turn" })
        .unwrap();
    init(&mut adapter, "s");
    // IDs may be reused by a different native turn, but never within a turn.
    message(&mut adapter, call("same", "started")).unwrap();
}

#[test]
fn cursor_permission_parser_requires_explicit_choices_and_never_offers_bypass() {
    let modes = metadata::parse_permissions(
        "--mode <mode> read-only (choices: \"plan\", \"ask\")\n  --force force",
    )
    .unwrap();
    assert_eq!(
        modes.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["plan", "ask"]
    );
    assert!(
        modes
            .iter()
            .all(|m| !m.elevated && m.description.contains("不是硬安全边界"))
    );
    assert!(metadata::parse_permissions("--mode <mode> ask or plan").is_err());
}
