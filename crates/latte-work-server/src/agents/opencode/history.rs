//! Bounded, prompt-free recovery of a known child's native transcript.
use crate::{
    agents::{ChildHistoryCursor, ChildHistoryPage},
    providers::LaunchConfig,
    runtime::Group,
};
use anyhow::{Context, Result, ensure};
use latte_work_protocol::{Event, EventKind};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

const LIMIT: u64 = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 8;

pub(in crate::agents) async fn read(
    binary: &str,
    cwd: &Path,
    parent: &str,
    child: &str,
    known_children: &HashSet<String>,
    session_id: &str,
    config: &LaunchConfig,
) -> Result<Option<ChildHistoryPage>> {
    if parent == child {
        return Ok(None);
    }
    // The parent session may run from a moved or symlink-spelled directory
    // (for example a worktree resume); its children record that directory.
    // Accept both the project path and the parent's recorded directory, so a
    // legitimate export is never rejected while foreign sessions still are.
    let mut allowed = vec![cwd.to_path_buf()];
    if let Some(directory) = super::resume::directory(binary, cwd, parent, config)
        .await
        .ok()
        .flatten()
    {
        allowed.push(Path::new(&directory).to_path_buf());
    }
    tokio::time::timeout(Duration::from_secs(6), async {
        let Some(document) = export(binary, &allowed, child, config).await? else {
            return Ok(None);
        };
        let mut current = &document;
        let mut ancestor;
        let mut seen = HashSet::from([child.to_owned()]);
        for depth in 1..=MAX_DEPTH {
            let Some(id) = current["info"]["parentID"].as_str() else {
                break;
            };
            if id == parent {
                return history(&document, child, session_id, config);
            }
            if depth == MAX_DEPTH || !known_children.contains(id) || !seen.insert(id.to_owned()) {
                break;
            }
            let Some(next) = export(binary, &allowed, id, config).await? else {
                break;
            };
            ancestor = next;
            current = &ancestor;
        }
        Ok(None)
    })
    .await
    .context("读取 OpenCode 子任务历史超时")?
}

pub(in crate::agents) fn plausible_session_id(id: &str) -> bool {
    id.starts_with("ses_")
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

async fn export(
    binary: &str,
    allowed: &[std::path::PathBuf],
    id: &str,
    config: &LaunchConfig,
) -> Result<Option<Value>> {
    if !plausible_session_id(id) {
        return Ok(None);
    }
    let mut command = crate::agent_environment::configured_command(
        binary,
        allowed.first().map(PathBuf::as_path),
        &config.environment,
    );
    command
        .envs(&config.environment.0)
        .current_dir(
            allowed
                .first()
                .map(PathBuf::as_path)
                .unwrap_or_else(|| Path::new(".")),
        )
        .args(["session", "export", "--standalone", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut group = Group::spawn(&mut command)?;
    let stdout = group
        .child
        .stdout
        .take()
        .context("OpenCode export stdout missing")?;
    let bytes = bounded(stdout).await?;
    if !group.child.wait().await?.success() {
        return Ok(None);
    }
    let mut document: Value = serde_json::from_slice(&bytes).context("无效的 OpenCode 导出")?;
    if let Some(data) = document.get_mut("data") {
        document = data.take();
    }
    let info = &document["info"];
    // Compare canonical forms so a symlinked spelling (macOS /var versus
    // /private/var) does not reject a session this project owns.
    let known = info["location"]["directory"]
        .as_str()
        .map(Path::new)
        .and_then(|directory| directory.canonicalize().ok())
        .is_some_and(|recorded| {
            allowed
                .iter()
                .any(|allowed| allowed.canonicalize().is_ok_and(|base| base == recorded))
        });
    Ok((info["id"] == id && known).then_some(document))
}

fn history(
    document: &Value,
    child: &str,
    session_id: &str,
    config: &LaunchConfig,
) -> Result<Option<ChildHistoryPage>> {
    let messages = document["messages"]
        .as_array()
        .context("OpenCode 导出缺少消息")?;
    let mut events = Vec::new();
    let mut pending_tail = false;
    let redactor = config.redactor();
    let mut bytes = 0;
    for message in messages {
        let at = message["time"]["created"].as_f64().unwrap_or_default();
        for event in message_events(message, &mut pending_tail) {
            let event = redactor.event(event);
            bytes += serde_json::to_vec(&event)?.len();
            ensure!(
                bytes <= LIMIT as usize && events.len() < 4096,
                "OpenCode 子任务历史超出限制"
            );
            events.push(Event {
                seq: (events.len() + 1) as f64,
                session_id: session_id.into(),
                at,
                event,
                content_size: None,
            });
        }
    }
    if events.is_empty() {
        return Ok(None);
    }
    let cursor = ChildHistoryCursor {
        identity: child.into(),
        offset: events.len() as u64,
        pending_tail,
        ..Default::default()
    };
    Ok(Some(ChildHistoryPage {
        events,
        cursor,
        has_more: false,
    }))
}

async fn bounded(stdout: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stdout.take(LIMIT + 1).read_to_end(&mut bytes).await?;
    ensure!(bytes.len() as u64 <= LIMIT, "OpenCode 导出超出读取范围");
    Ok(bytes)
}

fn message_events(message: &Value, pending_tail: &mut bool) -> Vec<EventKind> {
    let mut events = Vec::new();
    if message["type"] == "user" {
        if let (Some(text), Some(id)) = (message["text"].as_str(), message["id"].as_str()) {
            events.push(EventKind::User {
                text: text.into(),
                request_id: id.into(),
            });
        }
    } else if message["type"] == "assistant" {
        for part in message["content"].as_array().into_iter().flatten() {
            if let Some(text) = part["text"].as_str().filter(|_| part["type"] == "text") {
                events.push(EventKind::Text { text: text.into() });
            } else if part["type"] == "tool"
                && let (Some(id), Some(name)) = (part["id"].as_str(), part["name"].as_str())
            {
                let state = &part["state"];
                let is_error = state["status"] == "error";
                let input = state["input"].clone();
                let (name, input) = super::named_tool(
                    super::tool_label(&json!({"name":name,"rawInput":input}), None),
                    input,
                );
                events.push(EventKind::Tool {
                    id: id.into(),
                    name,
                    input,
                });
                if !is_error && state["status"] != "completed" {
                    *pending_tail = true;
                    continue;
                }
                let mut images = super::super::ToolImages::default();
                let mut content: Vec<_> = state["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| {
                        if part["type"] == "text" {
                            return Some(json!({"type":"text","text":part["text"].as_str()?}));
                        }
                        let (mime, data) = part["uri"]
                            .as_str()?
                            .strip_prefix("data:")?
                            .split_once(";base64,")?;
                        Some(images.inline(mime, data))
                    })
                    .collect();
                if is_error
                    && let Some(message) = state["error"]["message"].as_str()
                    && !content.iter().any(|item| item["text"] == message)
                {
                    content.push(json!({"type":"text","text":message}));
                }
                events.push(EventKind::ToolResult {
                    id: id.into(),
                    content: json!(content),
                    is_error,
                });
            }
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_binary() -> String {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(if cfg!(windows) {
                "src/agents/opencode/fixtures/agent.ps1"
            } else {
                "tests/fixtures/opencode.py"
            })
            .to_string_lossy()
            .into_owned()
    }

    async fn read_history(
        home: &Path,
        parent: &str,
        child: &str,
    ) -> Result<Option<ChildHistoryPage>> {
        let store = crate::providers::ProviderStore::open(home)?;
        let config = store.turn_config("opencode", None, None)?;
        let known = HashSet::from([parent.to_owned()]);
        read(
            &fixture_binary(),
            home,
            parent,
            child,
            &known,
            "sess",
            &config,
        )
        .await
    }

    fn export_file(home: &Path, id: &str, parent: Option<&str>, directory: &str) {
        std::fs::write(
            home.join(format!("{id}.json")),
            serde_json::json!({
                "info": {"id": id, "parentID": parent,
                         "location": {"directory": directory}},
                "messages": [
                    {"type": "user", "id": "msg_child", "text": "native child instruction"},
                    {"type": "assistant", "content": [{"type": "text", "text": "native reply"}]},
                ],
            })
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn child_history_follows_a_parent_into_its_recorded_directory() {
        let home = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        // The parent export reports the worktree (in its raw spelling, which
        // canonicalizes differently on macOS); the child lives there too.
        export_file(
            home.path(),
            "ses_parent",
            None,
            worktree.path().to_str().unwrap(),
        );
        export_file(
            home.path(),
            "ses_child",
            Some("ses_parent"),
            worktree.path().to_str().unwrap(),
        );
        let page = read_history(home.path(), "ses_parent", "ses_child")
            .await
            .unwrap();
        assert!(
            page.is_some(),
            "a child of a moved parent is still readable"
        );
    }

    #[tokio::test]
    async fn child_history_rejects_sessions_in_foreign_directories() {
        let home = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        // The parent never moved, so only the project path is accepted.
        export_file(
            home.path(),
            "ses_parent",
            None,
            home.path().to_str().unwrap(),
        );
        export_file(
            home.path(),
            "ses_child",
            Some("ses_parent"),
            foreign.path().to_str().unwrap(),
        );
        let page = read_history(home.path(), "ses_parent", "ses_child")
            .await
            .unwrap();
        assert!(page.is_none(), "a foreign directory is never adopted");
    }
}
