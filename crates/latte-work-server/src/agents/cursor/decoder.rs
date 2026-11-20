//! Native Cursor records are interpreted only here; no inference from exit or silence.
use super::{Action, valid_id};
use anyhow::{Context, Result, bail};
use latte_work_protocol::EventKind;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const MAX_TOOL_CALLS: usize = 512;
#[derive(Clone, PartialEq)]
struct ToolInput {
    name: String,
    args: Value,
    generic: bool,
}
fn tool_input(value: &Value) -> Result<(ToolInput, &Value)> {
    let envelope = value["tool_call"]
        .as_object()
        .context("Cursor tool_call 无效")?;
    let calls: Vec<_> = envelope
        .iter()
        .filter(|(key, _)| key.ends_with("ToolCall") || key.as_str() == "function")
        .collect();
    let [(key, call)] = &calls[..] else {
        bail!("Cursor tool_call 缺少唯一原生工具");
    };
    let generic = key.as_str() == "function";
    let (name, args) = if generic {
        let name = call["name"].as_str().context("Cursor function name 无效")?;
        if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
            bail!("Cursor function name 无效");
        }
        // Official arguments are an opaque string, not guaranteed JSON.
        let arguments = call["arguments"]
            .as_str()
            .context("Cursor function arguments 无效")?;
        (name.to_owned(), Value::String(arguments.to_owned()))
    } else {
        let args = call["args"].as_object().context("Cursor tool args 无效")?;
        ((*key).clone(), Value::Object(args.clone()))
    };
    Ok((
        ToolInput {
            name,
            args,
            generic,
        },
        *call,
    ))
}
#[derive(Default)]
pub(super) struct Decoder {
    session: Option<String>,
    active: bool,
    initialized: bool,
    finished: bool,
    assistant_seen: bool,
    tools: HashMap<String, ToolInput>,
    seen_tools: HashSet<String>,
}
impl Decoder {
    pub(super) fn new(session: Option<String>) -> Self {
        Self {
            session,
            ..Self::default()
        }
    }
    pub(super) fn active(&self) -> bool {
        self.active
    }
    pub(super) fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }
    pub(super) fn start(&mut self) -> Result<()> {
        if self.active {
            bail!("Cursor 本轮尚未完成");
        }
        *self = Self {
            session: self.session.clone(),
            active: true,
            ..Self::default()
        };
        Ok(())
    }
    pub(super) fn message(&mut self, line: &str) -> Result<Vec<Action>> {
        // Parser diagnostics never include the original record or credential values.
        let value: Value = serde_json::from_str(line).context("Cursor NDJSON 无效")?;
        let kind = value["type"].as_str().context("Cursor 缺少消息类型")?;
        if !self.active || self.finished {
            bail!("Cursor 输出不属于当前执行轮次");
        }
        if kind == "system" && value["subtype"] == "init" {
            return self.init(&value);
        }
        if !self.initialized {
            bail!("Cursor 在本轮 init 前输出执行结果");
        }
        let id = value["session_id"]
            .as_str()
            .context("Cursor 输出缺少 session_id")?;
        if Some(id) != self.session() {
            bail!("Cursor 输出 session_id 与本轮不匹配");
        }
        match kind {
            "assistant" => self.assistant(&value),
            "tool_call" => self.tool(&value),
            "result" => self.result(&value),
            "system" | "user" => Ok(vec![]),
            // Unknown extension events do not imply output, readiness or success.
            _ => Ok(vec![]),
        }
    }
    fn init(&mut self, value: &Value) -> Result<Vec<Action>> {
        if self.initialized {
            bail!("Cursor 本轮重复 init");
        }
        let id = value["session_id"]
            .as_str()
            .context("Cursor init 缺少 session_id")?;
        valid_id(id)?;
        if let Some(expected) = self.session()
            && expected != id
        {
            bail!("Cursor resume 返回了不同的 native session ID");
        }
        self.session = Some(id.into());
        self.initialized = true;
        Ok(vec![Action::NativeSession(id.into())])
    }
    fn assistant(&mut self, value: &Value) -> Result<Vec<Action>> {
        if value.get("timestamp_ms").is_some() || value.get("model_call_id").is_some() {
            bail!("Cursor 返回未启用的 partial output");
        }
        let content = value["message"]["content"]
            .as_array()
            .context("Cursor assistant content 无效")?;
        let mut actions = Vec::new();
        for block in content {
            if block["type"] == "text" {
                let text = block["text"]
                    .as_str()
                    .context("Cursor assistant text 无效")?;
                if !text.is_empty() {
                    actions.push(Action::Event(EventKind::Text { text: text.into() }));
                    self.assistant_seen = true;
                }
            }
        }
        Ok(actions)
    }
    fn tool(&mut self, value: &Value) -> Result<Vec<Action>> {
        let id = value["call_id"]
            .as_str()
            .context("Cursor tool 缺少 call_id")?;
        valid_id(id)?;
        let (input, call) = tool_input(value)?;
        match value["subtype"].as_str() {
            Some("started") => self.tool_started(id, input),
            Some("completed") => self.tool_completed(id, input, call),
            _ => bail!("Cursor tool subtype 无效"),
        }
    }
    fn tool_started(&mut self, id: &str, input: ToolInput) -> Result<Vec<Action>> {
        if self.seen_tools.contains(id) {
            bail!("Cursor 重复 tool call_id");
        }
        if self.seen_tools.len() >= MAX_TOOL_CALLS {
            bail!("Cursor tool 数量超出限制");
        }
        self.seen_tools.insert(id.into());
        self.tools.insert(id.into(), input.clone());
        Ok(vec![Action::Event(EventKind::Tool {
            id: id.into(),
            name: input.name,
            input: input.args,
        })])
    }
    fn tool_completed(&mut self, id: &str, input: ToolInput, call: &Value) -> Result<Vec<Action>> {
        let started = self
            .tools
            .get(id)
            .context("Cursor tool result 没有对应 started")?;
        if started != &input {
            bail!("Cursor tool result 与 started 不匹配");
        }
        if input.generic {
            // The published function input has no published completion result
            // schema. Completed ends pending activity, not a successful tool result.
            self.tools.remove(id);
            return Ok(vec![Action::Event(EventKind::Notice {
                text: format!(
                    "Cursor 工具 {}（call_id={id}）已报告 completed；结果结构未提供已适配契约，工具结果未确认。",
                    input.name
                ),
            })]);
        }
        let result = call["result"]
            .as_object()
            .context("Cursor tool result 无效")?;
        let success = result.get("success");
        let error = result.get("error");
        if success.is_some() == error.is_some()
            || success.or(error).is_none_or(|payload| !payload.is_object())
        {
            bail!("Cursor tool result 缺少明确 success/error");
        }
        self.tools.remove(id);
        Ok(vec![Action::Event(EventKind::ToolResult {
            id: id.into(),
            content: call["result"].clone(),
            is_error: error.is_some(),
        })])
    }
    fn result(&mut self, value: &Value) -> Result<Vec<Action>> {
        let failed = value["is_error"]
            .as_bool()
            .context("Cursor result 缺少 is_error")?;
        let subtype = value["subtype"]
            .as_str()
            .context("Cursor result 缺少 subtype")?;
        if subtype != "success" || failed {
            bail!("Cursor result 未明确报告 success/is_error=false");
        }
        let result = value["result"]
            .as_str()
            .context("Cursor result text 无效")?;
        if !self.tools.is_empty() {
            bail!("Cursor result 到达但工具结果尚未确认");
        }
        let mut actions = Vec::new();
        // Terminal result aggregates all assistant prose, including intermediate messages.
        // Do not deduplicate separate assistant records by text equality.
        if !self.assistant_seen && !result.is_empty() {
            actions.push(Action::Event(EventKind::Text {
                text: result.into(),
            }));
        }
        self.active = false;
        self.finished = true;
        actions.push(Action::Finished {
            failed: false,
            message: None,
        });
        Ok(actions)
    }
}
