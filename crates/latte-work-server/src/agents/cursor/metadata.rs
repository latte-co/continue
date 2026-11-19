//! Prompt-free Cursor metadata; no status/login/empty-chat/model turns.
use anyhow::{Context, Result, bail};
use latte_work_protocol::{AgentEnvironment, AgentInfo, AgentPermissionMode, Effort, Response};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const OUTPUT_LIMIT: u64 = 128 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MODELS: usize = 256;

fn redactor(
    command: &tokio::process::Command,
    environment: &AgentEnvironment,
) -> crate::redaction::Redactor {
    let mut values: BTreeMap<String, String> = std::env::vars().collect();
    for (key, value) in command.as_std().get_envs() {
        if let Some(value) = value {
            values.insert(
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
    }
    values.extend(environment.0.clone());
    crate::redaction::Redactor::new(
        values
            .into_iter()
            .filter(|(name, value)| {
                let name = name.to_ascii_uppercase();
                ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
                    .iter()
                    .any(|part| name.contains(part))
                    || (value.contains("://") && value.contains('@'))
            })
            .map(|(_, value)| value),
    )
}
async fn output(
    binary: &str,
    args: &[&str],
    path: Option<&str>,
    environment: &AgentEnvironment,
) -> Result<String> {
    let mut command = crate::agent_environment::command(binary);
    command
        .args(args)
        .envs(&environment.0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    if let Some(path) = path {
        command.current_dir(path);
    }
    let redactor = redactor(&command, environment);
    let child = command.spawn().context("Cursor 元数据进程无法启动")?;
    let pid =
        i32::try_from(child.id().context("Cursor 元数据 PID 缺失")?).context("Cursor PID 无效")?;
    let mut group = crate::runtime::Group { child, pid };
    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut stdout = group
            .child
            .stdout
            .take()
            .context("Cursor stdout 缺失")?
            .take(OUTPUT_LIMIT + 1);
        let mut stderr = group
            .child
            .stderr
            .take()
            .context("Cursor stderr 缺失")?
            .take(OUTPUT_LIMIT + 1);
        let mut out = Vec::new();
        let mut err = Vec::new();
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
        if out.len() + err.len() > OUTPUT_LIMIT as usize {
            bail!("Cursor 元数据输出超出限制");
        }
        if !group.child.wait().await?.success() {
            let error = redactor.text(&String::from_utf8_lossy(&err));
            bail!(
                "Cursor 元数据读取失败；请检查 CLI 安装和登录状态：{}",
                error.trim()
            );
        }
        let out = String::from_utf8(out).context("Cursor 元数据不是 UTF-8")?;
        Ok(redactor.text(&out))
    })
    .await;
    // Do not return through '?' until the owned process group is terminated and reaped.
    let signal = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGKILL,
    );
    if let Err(error) = signal
        && error != nix::errno::Errno::ESRCH
    {
        bail!("Cursor 元数据进程组清理未确认：{error}");
    }
    tokio::time::timeout(Duration::from_secs(2), group.child.wait())
        .await
        .context("Cursor 元数据进程回收超时")??;
    result.context("Cursor 元数据读取超时")?
}
fn binary() -> String {
    if let Ok(binary) = std::env::var("LATTE_WORK_CURSOR") {
        return binary;
    }
    let home = crate::agent_environment::variable("HOME").unwrap_or_default();
    let installed = PathBuf::from(home).join(".local/bin/cursor-agent");
    if installed.is_file() {
        installed.to_string_lossy().into_owned()
    } else {
        "cursor-agent".into()
    }
}
pub(crate) async fn discover() -> (String, AgentInfo) {
    let binary = binary();
    let probe = output(&binary, &["--version"], None, &AgentEnvironment::default()).await;
    let available = probe
        .as_ref()
        .is_ok_and(|version| !version.trim().is_empty());
    let detail = match probe {
        Ok(version) if available => version.trim().to_owned(),
        _ => "未找到 Cursor Agent；在此 Host 安装并登录后重启 Server。".into(),
    };
    (
        binary,
        AgentInfo {
            id: "cursor".into(),
            name: "Cursor Agent".into(),
            available,
            detail,
            provider_protocols: vec![],
        },
    )
}
pub(crate) async fn permission_modes(binary: &str) -> Result<Vec<AgentPermissionMode>> {
    parse_permissions(&output(binary, &["--help"], None, &AgentEnvironment::default()).await?)
}
pub(super) fn parse_permissions(help: &str) -> Result<Vec<AgentPermissionMode>> {
    let section = help
        .split("--mode <mode>")
        .nth(1)
        .context("Cursor 未公布原生 mode")?
        .split("\n  --")
        .next()
        .unwrap_or_default();
    let choices = section
        .split("(choices:")
        .nth(1)
        .and_then(|s| s.split(')').next())
        .context("Cursor 未公布 mode choices")?;
    let modes: Vec<_> = ["plan", "ask"]
        .into_iter()
        .filter(|id| choices.split(',').any(|s| s.trim() == format!("\"{id}\"")))
        .map(|id| AgentPermissionMode {
            id: id.into(),
            label: if id == "plan" {
                "原生只读规划"
            } else {
                "原生只读问答"
            }
            .into(),
            description:
                "Cursor 原生 read-only mode override；不是硬安全边界，不扩展 App 审批能力。".into(),
            elevated: false,
        })
        .collect();
    if modes.is_empty() {
        bail!("Cursor 没有已核验的只读模式");
    }
    Ok(modes)
}
pub(crate) async fn models(
    binary: &str,
    path: Option<&str>,
    selected: Option<&str>,
    environment: &AgentEnvironment,
) -> Result<Response> {
    catalog(
        &output(binary, &["models"], path, environment).await?,
        selected,
    )
}
pub(crate) async fn validate_selection(
    binary: &str,
    path: Option<&str>,
    selected: Option<&str>,
    effort: Option<Effort>,
    environment: &AgentEnvironment,
) -> Result<()> {
    if effort.is_some() {
        bail!("Cursor Agent 不支持独立 effort");
    }
    if selected.is_some() {
        models(binary, path, selected, environment).await?;
    }
    Ok(())
}
pub(super) fn catalog(output: &str, selected: Option<&str>) -> Result<Response> {
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    if lines.next() != Some("Available models") {
        bail!("Cursor 未返回有效模型目录");
    }
    let mut models = Vec::new();
    let mut labels = BTreeMap::new();
    let mut default_model = None;
    for line in lines {
        if line.starts_with("Tip:") {
            break;
        }
        let (id, label) = line.split_once(" - ").context("Cursor 模型目录行无效")?;
        if id.is_empty()
            || id.len() > 512
            || id.chars().any(|c| c.is_control() || c.is_whitespace())
            || label.is_empty()
        {
            bail!("Cursor 模型 ID/label 无效");
        }
        if labels.contains_key(id) || models.len() >= MAX_MODELS {
            bail!("Cursor 模型目录重复或超出限制");
        }
        let label = if let Some(label) = label.strip_suffix(" (default)") {
            if default_model.is_some() {
                bail!("Cursor 模型目录包含多个 default");
            }
            default_model = Some(id.to_owned());
            label
        } else {
            label
        };
        models.push(id.to_owned());
        labels.insert(id.to_owned(), label.to_owned());
    }
    if models.is_empty() {
        bail!("Cursor 模型目录为空");
    }
    if let Some(selected) = selected
        && !labels.contains_key(selected)
    {
        bail!("Cursor 原生模型不支持所选 ID");
    }
    Ok(Response::Models {
        models,
        provider: None,
        default_model,
        effort_levels: vec![],
        model_labels: labels,
        model_variants: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture(script: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (dir, path.to_string_lossy().into_owned())
    }
    #[tokio::test]
    async fn cursor_metadata_is_prompt_free_environment_aware_and_redacted() {
        let (_dir, binary) = fixture(
            "[ \"$#\" = 1 ] && [ \"$1\" = models ] || exit 3\nprintf 'Available models\\nchosen - %s (default)\\n' \"$TEST_TOKEN\"",
        );
        let environment = AgentEnvironment(BTreeMap::from([(
            "TEST_TOKEN".into(),
            "private-token".into(),
        )]));
        let Response::Models { model_labels, .. } =
            models(&binary, None, None, &environment).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(model_labels["chosen"], "[redacted]");
        let (_dir, binary) = fixture("printf '%s' \"$TEST_TOKEN\" >&2; exit 4");
        let error = output(&binary, &["--help"], None, &environment)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("[redacted]") && !error.contains("private-token"));
    }
    #[tokio::test]
    async fn cursor_metadata_bounds_output_and_reaps_timeout() {
        let (_dir, binary) = fixture("/usr/bin/yes metadata | /usr/bin/head -c 131073");
        assert!(
            output(&binary, &["--version"], None, &AgentEnvironment::default())
                .await
                .is_err()
        );
        let (dir, binary) = fixture("printf '%s' \"$$\" > \"$0.pid\"; sleep 30");
        assert!(
            output(&binary, &["--help"], None, &AgentEnvironment::default())
                .await
                .is_err()
        );
        let pid: i32 = std::fs::read_to_string(dir.path().join("cursor.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        );
    }
}
