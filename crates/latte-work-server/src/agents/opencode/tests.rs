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
