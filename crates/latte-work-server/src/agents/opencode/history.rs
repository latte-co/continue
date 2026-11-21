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

#[allow(clippy::too_many_arguments)]
pub(in crate::agents) async fn read(
    binary: &str,
    cwd: &Path,
    former_paths: &[String],
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
    // (for example a worktree resume) or have created children under a former
    // project root before the project path was updated.
    let mut allowed = vec![cwd.to_path_buf()];
    if let Some(directory) = super::resume::directory(binary, cwd, former_paths, parent, config)
        .await
        .ok()
        .flatten()
    {
        allowed.push(Path::new(&directory).to_path_buf());
    }
    tokio::time::timeout(Duration::from_secs(6), async {
        let Some(document) = export(binary, &allowed, former_paths, child, config).await? else {
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
            let Some(next) = export(binary, &allowed, former_paths, id, config).await? else {
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
    former_paths: &[String],
    id: &str,
    config: &LaunchConfig,
) -> Result<Option<Value>> {
    if !plausible_session_id(id) {
        return Ok(None);
    }
    let process = crate::agent_environment::command(binary)
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
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let pid = process.id().context("OpenCode export PID missing")? as i32;
    let mut group = Group {
        child: process,
        pid,
    };
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
    // /private/var) does not reject a session this project owns, while also
    // accepting canonical former project roots without following symlinks
    // planted at the former path after the move.
    let known = info["location"]["directory"].as_str().is_some_and(|raw| {
        let path = Path::new(raw);
        let in_live = path.canonicalize().is_ok_and(|recorded| {
            allowed.iter().any(|base| {
                base.as_os_str() == recorded.as_os_str()
                    || base
                        .canonicalize()
                        .is_ok_and(|canonical| canonical == recorded)
            })
        });
        in_live
            || normalize_without_following_leaf(path).is_some_and(|resolved| {
                former_paths
                    .iter()
                    .any(|former| Path::new(former) == resolved)
            })
    });
    Ok((info["id"] == id && known).then_some(document))
}

pub(super) fn normalize_without_following_leaf(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return None;
    }
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir()) {
        return path.canonicalize().ok();
    }
    let mut suffix = vec![path.file_name()?.to_os_string()];
    let mut cursor = path.parent()?;
    while !cursor.exists() {
        suffix.push(cursor.file_name()?.to_os_string());
        cursor = cursor.parent()?;
    }
    let mut resolved = cursor.canonicalize().ok()?;
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    Some(resolved)
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
            .join("tests/fixtures/opencode.py")
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
            &[],
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

    #[tokio::test]
    async fn child_history_accepts_former_project_roots_even_after_rename_on_disk() {
        let sandbox = tempfile::tempdir().unwrap();
        let old_dir = sandbox.path().join("old");
        let new_dir = sandbox.path().join("new");
        let foreign_dir = sandbox.path().join("foreign");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::create_dir_all(&foreign_dir).unwrap();
        let old_canonical = old_dir
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let foreign_canonical = foreign_dir.canonicalize().unwrap();
        std::fs::remove_dir_all(&old_dir).unwrap();
        export_file(&new_dir, "ses_parent", None, &old_canonical);
        export_file(&new_dir, "ses_child", Some("ses_parent"), &old_canonical);
        let store = crate::providers::ProviderStore::open(&new_dir).unwrap();
        let config = store.turn_config("opencode", None, None).unwrap();
        let known = HashSet::from(["ses_parent".to_owned()]);
        let former = vec![old_canonical];
        let page = read(
            &fixture_binary(),
            &new_dir,
            &former,
            "ses_parent",
            "ses_child",
            &known,
            "sess",
            &config,
        )
        .await
        .unwrap();
        assert!(
            page.is_some(),
            "children recorded under a former project path remain readable"
        );

        // Planting a symlink at the former path to a foreign directory must keep
        // former-path children readable while still rejecting foreign children.
        std::os::unix::fs::symlink(&foreign_canonical, &old_dir).unwrap();
        export_file(
            &new_dir,
            "ses_foreign_child",
            Some("ses_parent"),
            foreign_canonical.to_str().unwrap(),
        );
        let kept = read(
            &fixture_binary(),
            &new_dir,
            &former,
            "ses_parent",
            "ses_child",
            &known,
            "sess",
            &config,
        )
        .await
        .unwrap();
        let rejected = read(
            &fixture_binary(),
            &new_dir,
            &former,
            "ses_parent",
            "ses_foreign_child",
            &known,
            "sess",
            &config,
        )
        .await
        .unwrap();
        assert!(kept.is_some());
        assert!(
            rejected.is_none(),
            "a symlink at a former path never adopts foreign directories"
        );
    }
}
