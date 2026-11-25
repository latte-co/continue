use super::*;

fn adapter() -> OpenCode {
    OpenCode {
        session: Some("ses_test".into()),
        ready: true,
        saved: true,
        sideband_ready: true,
        commands: Some(vec![]),
        ..OpenCode::default()
    }
}

fn event(adapter: &mut OpenCode, kind: &str, data: Value) -> Vec<Action> {
    let mut data = data;
    data["sessionID"] = json!("ses_test");
    adapter
        .sideband(&json!({"type":kind,"data":data}).to_string())
        .unwrap()
}

fn delivered(adapter: &mut OpenCode, id: &str) -> Vec<Action> {
    event(adapter, "session.inbox.delivered", json!({"inboxID":id}))
}

fn begin_prompt(adapter: &mut OpenCode) {
    adapter.start("foreground").unwrap();
    let id = adapter.native_prompt.clone().unwrap();
    event(adapter, "session.execution.started", json!({}));
    delivered(adapter, &id);
}

fn queue(adapter: &mut OpenCode) -> String {
    adapter
        .advance(Input::Queue {
            request_id: "late-input",
            prompt: "more work",
        })
        .unwrap();
    adapter.steering.as_ref().unwrap().1.clone()
}

#[test]
fn steering_after_foreground_end_starts_one_successor_with_approval_and_usage() {
    let mut adapter = adapter();
    begin_prompt(&mut adapter);
    let id = queue(&mut adapter);
    assert!(
        event(&mut adapter, "session.execution.succeeded", json!({}))
            .iter()
            .any(|a| matches!(a, Action::Finished { failed: false, .. }))
    );
    event(
        &mut adapter,
        "session.inbox.enqueued",
        json!({"inboxID":id,"itemType":"user"}),
    );
    assert!(matches!(
        event(&mut adapter, "session.execution.started", json!({})).as_slice(),
        [Action::TurnStarted]
    ));
    assert!(matches!(delivered(&mut adapter, &id).as_slice(),
        [Action::InputsConsumed(ids)] if ids == &["late-input"]));
    assert!(delivered(&mut adapter, &id).is_empty());
    let actions = event(
        &mut adapter,
        "permission.asked",
        json!({"id":"ask","action":"shell"}),
    );
    assert!(matches!(actions.as_slice(), [Action::Approval { id, .. }] if id == "ask"));
    event(
        &mut adapter,
        "permission.replied",
        json!({"requestID":"ask","reply":"once"}),
    );
    let actions = event(
        &mut adapter,
        "session.text.delta",
        json!({"delta":"one reply"}),
    );
    assert!(
        matches!(actions.as_slice(), [Action::Event(EventKind::Text { text })] if text == "one reply")
    );
    event(
        &mut adapter,
        "session.step.ended",
        json!({"tokens":{"input":12,"output":3}}),
    );
    let actions = event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(
        matches!(actions.as_slice(), [Action::Event(EventKind::Usage { totals: Some(totals), .. }), Action::Finished { failed:false, .. }] if totals.output_tokens == Some(3.0))
    );
    assert!(adapter.can_reconfigure());
}

#[test]
fn steering_during_foreground_stays_in_the_same_turn() {
    let mut adapter = adapter();
    begin_prompt(&mut adapter);
    let id = queue(&mut adapter);
    delivered(&mut adapter, &id);
    let actions = event(
        &mut adapter,
        "session.text.delta",
        json!({"delta":"same turn"}),
    );
    assert!(matches!(
        actions.as_slice(),
        [Action::Event(EventKind::Text { .. })]
    ));
    let actions = event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(matches!(
        actions.as_slice(),
        [Action::Finished { failed: false, .. }]
    ));
    assert!(adapter.can_reconfigure());
}

#[test]
fn steering_after_acp_end_is_not_lost_in_the_foreground_stream() {
    let mut adapter = adapter();
    adapter.start_prompt("/compact", AcpInput::Compact).unwrap();
    let rpc = adapter.request.unwrap().0;
    let id = queue(&mut adapter);
    event(
        &mut adapter,
        "session.inbox.enqueued",
        json!({"inboxID":"compact","itemType":"compaction"}),
    );
    event(&mut adapter, "session.execution.started", json!({}));
    delivered(&mut adapter, "compact");
    event(&mut adapter, "session.execution.succeeded", json!({}));
    // The successor can publish before the independent ACP response arrives.
    event(&mut adapter, "session.execution.started", json!({}));
    delivered(&mut adapter, &id);
    assert!(
        event(
            &mut adapter,
            "session.text.delta",
            json!({"delta":"late reply"})
        )
        .is_empty()
    );
    assert!(event(&mut adapter, "session.execution.succeeded", json!({})).is_empty());
    let actions = adapter
        .response(&json!({"id":rpc,"result":{"stopReason":"end_turn"}}))
        .unwrap();
    assert!(
        matches!(actions.as_slice(), [Action::Finished { .. }, Action::TurnStarted, Action::InputsConsumed(_), Action::Event(EventKind::Text { text }), Action::Finished { failed:false, .. }] if text == "late reply")
    );
    assert!(adapter.can_reconfigure());
}

#[test]
fn plugin_terminal_cannot_finish_an_undelivered_foreground_prompt() {
    let mut adapter = adapter();
    adapter.start("foreground").unwrap();
    let id = adapter.native_prompt.clone().unwrap();
    event(&mut adapter, "session.execution.started", json!({}));
    assert!(event(&mut adapter, "session.execution.succeeded", json!({})).is_empty());
    assert!(!adapter.can_start_turn());
    event(&mut adapter, "session.execution.started", json!({}));
    delivered(&mut adapter, &id);
    assert!(matches!(
        event(&mut adapter, "session.execution.succeeded", json!({})).as_slice(),
        [Action::Finished { failed: false, .. }]
    ));
    assert!(adapter.can_reconfigure());
}

#[test]
fn autonomous_token_limit_is_reported_even_without_text_output() {
    let mut adapter = adapter();
    event(
        &mut adapter,
        "session.inbox.enqueued",
        json!({"inboxID":"plugin","itemType":"synthetic"}),
    );
    event(&mut adapter, "session.execution.started", json!({}));
    delivered(&mut adapter, "plugin");
    let actions = event(
        &mut adapter,
        "session.step.ended",
        json!({"finish":"length","tokens":{"output":9}}),
    );
    assert!(actions.is_empty());
    let actions = event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(
        matches!(actions.as_slice(), [Action::Event(EventKind::Usage { totals:Some(totals), .. }), Action::Finished { failed:true, message:Some(message) }] if totals.output_tokens == Some(9.0) && message.contains("令牌上限"))
    );
}

#[test]
fn native_approval_requires_a_matching_decision_event() {
    let mut adapter = adapter();
    begin_prompt(&mut adapter);
    event(
        &mut adapter,
        "permission.asked",
        json!({"id":"ask","action":"shell"}),
    );
    assert!(
        adapter
            .sideband(r#"{"type":"reply","id":"permission:ask"}"#)
            .unwrap()
            .is_empty()
    );
    assert!(adapter.awaits_approval_reply("ask"));
    assert!(adapter.sideband(r#"{"type":"permission.replied","data":{"sessionID":"other","requestID":"ask","reply":"once"}}"#).unwrap().is_empty());
    assert!(adapter.awaits_approval_reply("ask"));
    let actions = event(
        &mut adapter,
        "permission.replied",
        json!({"requestID":"ask","reply":"reject"}),
    );
    assert!(matches!(
        actions.as_slice(),
        [Action::ApprovalReply {
            result: Ok(false),
            ..
        }]
    ));
    assert!(!adapter.awaits_approval_reply("ask"));
}

#[test]
fn successor_can_be_interrupted_before_delivery_or_output() {
    let mut adapter = adapter();
    begin_prompt(&mut adapter);
    let id = queue(&mut adapter);
    event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(matches!(
        event(&mut adapter, "session.execution.started", json!({})).as_slice(),
        [Action::TurnStarted]
    ));
    assert!(matches!(
        adapter.advance(Input::Interrupt).unwrap().as_slice(),
        [Action::SidebandWrite(_)]
    ));
    delivered(&mut adapter, &id);
    assert!(matches!(
        event(&mut adapter, "session.execution.interrupted", json!({})).as_slice(),
        [Action::Interrupted, Action::Finished { .. }]
    ));
    assert!(event(&mut adapter, "session.execution.interrupted", json!({})).is_empty());
    assert!(adapter.can_reconfigure());
}

#[test]
fn acp_completion_exposes_a_silent_successor_without_waiting_for_output() {
    let mut adapter = adapter();
    adapter.start_prompt("/compact", AcpInput::Compact).unwrap();
    let rpc = adapter.request.unwrap().0;
    event(
        &mut adapter,
        "session.inbox.enqueued",
        json!({"inboxID":"compact","itemType":"compaction"}),
    );
    event(&mut adapter, "session.execution.started", json!({}));
    delivered(&mut adapter, "compact");
    event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(event(&mut adapter, "session.execution.started", json!({})).is_empty());
    let actions = adapter
        .response(&json!({"id":rpc,"result":{"stopReason":"end_turn"}}))
        .unwrap();
    assert!(matches!(
        actions.as_slice(),
        [Action::Finished { .. }, Action::TurnStarted]
    ));
    assert!(matches!(
        adapter.advance(Input::Interrupt).unwrap().as_slice(),
        [Action::SidebandWrite(_)]
    ));
}

#[test]
fn native_context_uses_last_step_actual_model_and_all_token_components() {
    let mut adapter = adapter();
    begin_prompt(&mut adapter);
    for (model, window, input) in [("first", Some(10000), 30), ("routed", Some(50000), 50)] {
        event(
            &mut adapter,
            "session.step.started",
            json!({"model":{"providerID":"custom","id":model},"contextWindow":window}),
        );
        event(
            &mut adapter,
            "session.step.ended",
            json!({"tokens":{"input":input,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}),
        );
    }
    let actions = event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(
        matches!(actions.as_slice(), [Action::Event(EventKind::Usage { context:Some(context), totals:Some(totals) }), Action::Finished { .. }]
        if context.model == "custom/routed" && context.used_tokens == 68.0 && context.window_tokens == Some(50000.0) && totals.input_tokens == Some(80.0) && totals.output_tokens == Some(6.0))
    );
    begin_prompt(&mut adapter);
    event(
        &mut adapter,
        "session.step.started",
        json!({"model":{"providerID":"custom","id":"unknown"}}),
    );
    event(
        &mut adapter,
        "session.step.ended",
        json!({"tokens":{"input":1,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}),
    );
    let actions = event(&mut adapter, "session.execution.succeeded", json!({}));
    assert!(
        matches!(actions.as_slice(), [Action::Event(EventKind::Usage { context:Some(context), totals:Some(totals) }), Action::Finished { .. }]
        if context.model == "custom/unknown" && context.used_tokens == 3.0 && context.window_tokens.is_none() && totals.input_tokens == Some(1.0))
    );
}

#[test]
fn failed_command_submission_keeps_admitted_execution_interruptible_until_terminal() {
    for terminal in [
        "session.execution.succeeded",
        "session.execution.interrupted",
    ] {
        let mut adapter = adapter();
        adapter.native_command = Some("command".into());
        event(&mut adapter, "session.execution.started", json!({}));
        assert!(
            adapter
                .sideband(r#"{"type":"reply","id":"command","error":true}"#)
                .unwrap()
                .is_empty()
        );
        assert!(adapter.running());
        assert!(!adapter.can_start_turn());
        if terminal.ends_with("interrupted") {
            assert!(matches!(
                adapter.advance(Input::Interrupt).unwrap().as_slice(),
                [Action::SidebandWrite(_)]
            ));
        }
        let actions = event(&mut adapter, terminal, json!({}));
        assert!(matches!(
            actions.last(),
            Some(Action::Finished { failed: true, .. })
        ));
        assert!(adapter.can_start_turn());
    }
}

fn resuming() -> OpenCode {
    OpenCode {
        cwd: "/proj".into(),
        resume: Some("ses_moved".into()),
        saved: true,
        ..OpenCode::default()
    }
}

fn wire(actions: &[Action]) -> (String, String) {
    let mut writes = String::new();
    let mut sideband = String::new();
    for action in actions {
        match action {
            Action::Write(bytes) => writes.push_str(&String::from_utf8_lossy(bytes)),
            Action::SidebandWrite(bytes) => sideband.push_str(&String::from_utf8_lossy(bytes)),
            _ => {}
        }
    }
    (writes, sideband)
}

fn result(id: u64, result: Value) -> String {
    json!({"jsonrpc":"2.0", "id": id, "result": result}).to_string()
}

const MISMATCH: &str = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32602,
"message":"Invalid params: session ses_moved does not belong to cwd: /proj",
"data":{"sessionId":"ses_moved","cwd":"/proj"}}}"#;

fn initialize_response() -> Value {
    json!({
        "protocolVersion": 1,
        "agentInfo": {"name": "OpenCode", "version": "2.3.0"},
        "agentCapabilities": {"sessionCapabilities": {"resume": {}, "close": {}, "delete": {}}}
    })
}

fn resumed_response() -> Value {
    json!({"configOptions": [
        {"id": "model", "type": "select", "currentValue": "test/default",
         "options": [{"value": "test/default", "name": "default"}]},
        {"id": "effort", "type": "select", "currentValue": "default",
         "options": [{"value": "default", "name": "default"}]}
    ]})
}

#[test]
fn directory_mismatch_resume_is_repaired_and_retried() {
    let mut adapter = resuming();
    adapter.advance(Input::Open).unwrap();
    let (writes, _) = wire(
        &adapter
            .advance(Input::Message(&result(1, initialize_response())))
            .unwrap(),
    );
    assert!(writes.contains("session/resume") && writes.contains("ses_moved"));
    // The mismatch launches the repair with a disposable session.
    let (writes, _) = wire(&adapter.advance(Input::Message(MISMATCH)).unwrap());
    assert!(writes.contains("session/new"));
    let (writes, sideband) = wire(
        &adapter
            .advance(Input::Message(&result(3, json!({"sessionId": "ses_temp"}))))
            .unwrap(),
    );
    assert!(writes.is_empty() && sideband.is_empty());
    // The plugin joins only after the disposable session hosted it.
    let (_, sideband) = wire(
        &adapter
            .advance(Input::Sideband(r#"{"type":"ready"}"#))
            .unwrap(),
    );
    assert!(
        sideband.contains("repair-move")
            && sideband.contains("ses_moved")
            && sideband.contains(r#""directory":"/proj""#)
    );
    // A moved session drops its disposable twin and retries the resume.
    let (writes, _) = wire(
        &adapter
            .advance(Input::Sideband(r#"{"type":"reply","id":"repair-move"}"#))
            .unwrap(),
    );
    assert!(writes.contains("session/delete") && writes.contains("ses_temp"));
    let (writes, _) = wire(
        &adapter
            .advance(Input::Message(&result(4, json!({}))))
            .unwrap(),
    );
    assert!(writes.contains("session/resume") && writes.contains("ses_moved"));
    // The retried resume adopts the saved session and refreshes its title.
    let (_, sideband) = wire(
        &adapter
            .advance(Input::Message(&result(5, resumed_response())))
            .unwrap(),
    );
    assert_eq!(adapter.session.as_deref(), Some("ses_moved"));
    assert!(sideband.contains(r#""action":"get""#));
}

#[test]
fn failed_move_reports_the_original_error() {
    let mut adapter = resuming();
    adapter.advance(Input::Open).unwrap();
    adapter
        .advance(Input::Message(&result(1, initialize_response())))
        .unwrap();
    adapter.advance(Input::Message(MISMATCH)).unwrap();
    adapter
        .advance(Input::Message(&result(3, json!({"sessionId": "ses_temp"}))))
        .unwrap();
    adapter
        .advance(Input::Sideband(r#"{"type":"ready"}"#))
        .unwrap();
    let error = match adapter.advance(Input::Sideband(
        r#"{"type":"reply","id":"repair-move","error":true}"#,
    )) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("the failed move must fail the resume"),
    };
    assert!(error.contains("自动迁移未成功"));
}

#[test]
fn repair_runs_at_most_once() {
    let mut adapter = resuming();
    adapter.advance(Input::Open).unwrap();
    adapter
        .advance(Input::Message(&result(1, initialize_response())))
        .unwrap();
    adapter.advance(Input::Message(MISMATCH)).unwrap();
    adapter
        .advance(Input::Message(&result(3, json!({"sessionId": "ses_temp"}))))
        .unwrap();
    adapter
        .advance(Input::Sideband(r#"{"type":"ready"}"#))
        .unwrap();
    adapter
        .advance(Input::Sideband(r#"{"type":"reply","id":"repair-move"}"#))
        .unwrap();
    adapter
        .advance(Input::Message(&result(4, json!({}))))
        .unwrap();
    // A second mismatch is terminal instead of looping through the repair.
    let second = json!({"jsonrpc":"2.0","id":5,"error":{"code":-32602,
        "message":"Invalid params: session ses_moved does not belong to cwd: /proj",
        "data":{"sessionId":"ses_moved","cwd":"/proj"}}})
    .to_string();
    let error = match adapter.advance(Input::Message(&second)) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("the second mismatch must not repair again"),
    };
    assert!(error.contains("does not belong to cwd"));
}

#[test]
fn failed_probe_session_reports_original_error() {
    let mut adapter = resuming();
    adapter.advance(Input::Open).unwrap();
    adapter
        .advance(Input::Message(&result(1, initialize_response())))
        .unwrap();
    adapter.advance(Input::Message(MISMATCH)).unwrap();
    let error = match adapter.advance(Input::Message(
        &json!({"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Invalid params"}})
            .to_string(),
    )) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("the failed probe session must fail the resume"),
    };
    assert!(error.contains("does not belong to cwd"));
}

#[test]
fn slash_reference_gating_distinguishes_modern_commands_and_legacy_acp_skills() {
    // OpenCode 2.3+: ACP `commands` only lists native commands; skills are regular foreground prompts.
    let mut modern = adapter();
    modern.legacy_acp_skills = false;
    modern.commands = Some(vec![AgentSlashCommand {
        name: "init".into(),
        display_name: None,
        description: "Init".into(),
        argument_hint: String::new(),
        kind: Some(latte_work_protocol::AgentCommandKind::Command),
        ui_action: None,
    }]);
    let ref_suffix = "\n引用（相对项目；绝对路径在当前主机，按现有权限读取）：\n[{\"type\":\"file\",\"path\":\"README.md\",\"name\":\"README.md\"}]";
    let rejected = modern.start(&format!("/init 检查{ref_suffix}")).unwrap();
    assert!(matches!(
        rejected.as_slice(),
        [Action::Finished { failed: true, message: Some(msg) }] if msg.contains("请先移除项目引用")
    ));
    let skill_actions = modern
        .start(&format!("/fixture-skill 检查{ref_suffix}"))
        .unwrap();
    let (_, sideband) = wire(&skill_actions);
    assert!(sideband.contains(r#""action":"prompt""#));
    assert!(sideband.contains("fixture-skill"));

    // OpenCode 2.0-2.2: `commands` mixes commands and skills; sideband decides `viaACP` vs `rejectedReferences`.
    let mut legacy = adapter();
    legacy.legacy_acp_skills = true;
    legacy.commands = Some(vec![
        AgentSlashCommand {
            name: "fixture-skill".into(),
            display_name: None,
            description: "Skill".into(),
            argument_hint: String::new(),
            kind: Some(latte_work_protocol::AgentCommandKind::Skill),
            ui_action: None,
        },
        AgentSlashCommand {
            name: "init".into(),
            display_name: None,
            description: "Init".into(),
            argument_hint: String::new(),
            kind: Some(latte_work_protocol::AgentCommandKind::Command),
            ui_action: None,
        },
    ]);
    let prompt_with_ref = format!("/fixture-skill 检查{ref_suffix}");
    let (_, sideband) = wire(&legacy.start(&prompt_with_ref).unwrap());
    assert!(sideband.contains(r#""action":"command""#));
    assert!(sideband.contains(r#""hasReferences":true"#));
    let cmd_id = legacy.native_command.clone().unwrap();
    let (writes, _) = wire(
        &legacy
            .sideband(&json!({"type":"reply","id":cmd_id,"viaACP":true}).to_string())
            .unwrap(),
    );
    assert!(writes.contains("session/prompt"));
    assert!(writes.contains("fixture-skill"));
    assert!(writes.contains("README.md"));

    let mut legacy_cmd = adapter();
    legacy_cmd.legacy_acp_skills = true;
    legacy_cmd.commands = legacy.commands.clone();
    legacy_cmd
        .start(&format!("/init 检查{ref_suffix}"))
        .unwrap();
    let cmd_id = legacy_cmd.native_command.clone().unwrap();
    let rejected = legacy_cmd
        .sideband(&json!({"type":"reply","id":cmd_id,"rejectedReferences":true}).to_string())
        .unwrap();
    assert!(matches!(
        rejected.as_slice(),
        [Action::Finished { failed: true, message: Some(msg) }] if msg.contains("请先移除项目引用")
    ));
}
