//! Resume-time lookup of a native OpenCode session's recorded directory.
//!
//! OpenCode pins every native session to the directory it was created in or
//! moved to, and refuses `session/resume` from any other cwd. Before
//! relaunching a saved conversation, Latte asks the CLI where that session
//! now lives, and keeps the conversation in place when the directory still
//! exists. Every failure falls back to the project directory, where the
//! in-process mismatch repair can still recover the session.
use crate::{providers::LaunchConfig, runtime::Group};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

const LIMIT: u64 = 8 * 1024 * 1024;

pub(in crate::agents) async fn directory(
    binary: &str,
    project: &Path,
    id: &str,
    config: &LaunchConfig,
) -> Result<Option<String>> {
    // The ID reaches a CLI argument; keep it to the native session shape.
    if !super::history::plausible_session_id(id) {
        return Ok(None);
    }
    let document =
        match tokio::time::timeout(Duration::from_secs(5), export(binary, project, id, config))
            .await
        {
            Ok(Ok(document)) => document,
            // A stalled or broken CLI never blocks the resume itself.
            _ => return Ok(None),
        };
    let Some(directory) = native_directory(document.as_ref(), id) else {
        return Ok(None);
    };
    let directory = Path::new(&directory);
    if !directory.is_absolute() || !directory.is_dir() {
        return Ok(None);
    }
    // The recorded directory may carry a symlinked spelling (for example
    // /var instead of /private/var on macOS) that would not match the
    // process cwd the way project paths already do.
    let Ok(recorded) = directory.canonicalize() else {
        return Ok(None);
    };
    if project
        .canonicalize()
        .is_ok_and(|current| recorded == current)
    {
        return Ok(None);
    }
    Ok(Some(recorded.to_string_lossy().into_owned()))
}

async fn export(
    binary: &str,
    project: &Path,
    id: &str,
    config: &LaunchConfig,
) -> Result<Option<Value>> {
    let mut command =
        crate::agent_environment::configured_command(binary, Some(project), &config.environment);
    command
        .envs(&config.environment.0)
        .current_dir(project)
        .args(["session", "export", "--standalone", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut group = Group::spawn(&mut command)?;
    let stdout = group.child.stdout.take().context("OpenCode 探测输出缺失")?;
    let Ok(bytes) = bounded(stdout).await else {
        // An oversized export is dropped; kill_on_drop reaps the group.
        return Ok(None);
    };
    if !group
        .child
        .wait()
        .await
        .is_ok_and(|status| status.success())
    {
        return Ok(None);
    }
    let Ok(mut document) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    if let Some(data) = document.get_mut("data") {
        document = data.take();
    }
    Ok(Some(document))
}

fn native_directory(document: Option<&Value>, id: &str) -> Option<String> {
    let info = document?["info"].as_object()?;
    if info.get("id").and_then(Value::as_str) != Some(id) {
        return None;
    }
    Some(info.get("location")?["directory"].as_str()?.to_owned())
}

async fn bounded(stdout: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stdout.take(LIMIT + 1).read_to_end(&mut bytes).await?;
    anyhow::ensure!(bytes.len() as u64 <= LIMIT, "OpenCode 导出超出读取范围");
    Ok(bytes)
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

    async fn lookup(project: &Path, id: &str) -> Result<Option<String>> {
        let store = crate::providers::ProviderStore::open(project)?;
        let config = store.turn_config("opencode", None, None)?;
        directory(&fixture_binary(), project, id, &config).await
    }

    fn export_file(project: &Path, id: &str, recorded: &str) {
        std::fs::write(
            project.join(format!("{id}.json")),
            serde_json::json!({
                "info": {"id": id, "location": {"directory": recorded}},
                "messages": [],
            })
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn recorded_directory_wins_when_it_exists_elsewhere() {
        let home = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        export_file(home.path(), "ses_moved", worktree.path().to_str().unwrap());
        let recorded = worktree.path().canonicalize().unwrap();
        assert_eq!(
            lookup(home.path(), "ses_moved").await.unwrap().as_deref(),
            Some(recorded.to_str().unwrap()),
        );
    }

    #[tokio::test]
    async fn project_directory_and_missing_paths_fall_back() {
        let home = tempfile::tempdir().unwrap();
        export_file(home.path(), "ses_home", home.path().to_str().unwrap());
        export_file(home.path(), "ses_gone", "/definitely/not/present");
        assert_eq!(lookup(home.path(), "ses_home").await.unwrap(), None);
        assert_eq!(lookup(home.path(), "ses_gone").await.unwrap(), None);
        // A missing export file makes the fixture exit non-zero.
        assert_eq!(lookup(home.path(), "ses_unknown").await.unwrap(), None);
        // IDs that never reach a CLI argument.
        assert_eq!(lookup(home.path(), "../escape").await.unwrap(), None);
    }
}
