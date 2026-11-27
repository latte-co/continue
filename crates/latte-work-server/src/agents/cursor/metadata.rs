//! Prompt-free Cursor metadata; no status/login/empty-chat/model turns.
#[cfg(test)]
#[path = "metadata_permission_tests.rs"]
mod permission_tests;
use anyhow::{Context, Result, bail};
use latte_work_protocol::{
    AgentCommandKind, AgentEnvironment, AgentInfo, AgentPermissionMode, AgentSlashCommand, Effort,
    Response, SkillInfo,
};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const OUTPUT_LIMIT: u64 = 128 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MODELS: usize = 256;

#[derive(Debug)]
struct CleanupUnconfirmed;
impl std::fmt::Display for CleanupUnconfirmed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Cursor 元数据进程清理未确认")
    }
}
impl std::error::Error for CleanupUnconfirmed {}

#[derive(Debug)]
struct SpawnFailure(std::io::Error);
impl std::fmt::Display for SpawnFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Cursor 元数据进程无法启动：{}", self.0)
    }
}
impl std::error::Error for SpawnFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

#[derive(Debug)]
struct RetryPathCandidate;
impl std::fmt::Display for RetryPathCandidate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Cursor 初次启动权限不足")
    }
}
impl std::error::Error for RetryPathCandidate {}

async fn output(
    binary: &str,
    args: &[&str],
    path: Option<&str>,
    environment: &AgentEnvironment,
) -> Result<String> {
    let (output, _) = output_until(binary, args, path, environment, None).await?;
    Ok(output)
}

async fn spawn_output(
    binary: &str,
    args: &[&str],
    path: Option<&str>,
    environment: &AgentEnvironment,
    deadline: Option<tokio::time::Instant>,
) -> Result<(crate::runtime::Group, crate::redaction::Redactor)> {
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        bail!("Cursor 元数据读取超时");
    }
    let binary = binary.to_owned();
    let args: Vec<_> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let path = path.map(str::to_owned);
    let environment = environment.clone();
    // Environment preparation and Command::spawn are synchronous. Keep them off
    // the async executor; the shared deadline does not hard-bound a blocking spawn.
    tokio::task::spawn_blocking(move || {
        if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            bail!("Cursor 元数据读取超时");
        }
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
        let redactor = crate::redaction::for_command(
            &command,
            std::env::vars_os(),
            std::iter::empty::<String>(),
        );
        if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            bail!("Cursor 元数据读取超时");
        }
        let child = command.spawn().map_err(SpawnFailure)?;
        let pid = i32::try_from(child.id().context("Cursor 元数据 PID 缺失")?)
            .context("Cursor PID 无效")?;
        Ok((crate::runtime::Group { child, pid }, redactor))
    })
    .await
    .context("Cursor 元数据进程准备任务失败")?
}
async fn output_until(
    binary: &str,
    args: &[&str],
    path: Option<&str>,
    environment: &AgentEnvironment,
    deadline: Option<tokio::time::Instant>,
) -> Result<(String, tokio::time::Instant)> {
    let (mut group, redactor) = spawn_output(binary, args, path, environment, deadline).await?;
    // Models/permissions retain their original five-second post-spawn read
    // window; discovery shares one deadline across every candidate and step.
    let deadline = deadline.unwrap_or_else(|| tokio::time::Instant::now() + PROBE_TIMEOUT);
    let pid = group.pid;
    let result = tokio::time::timeout_at(deadline, async {
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
        return Err(
            anyhow::anyhow!("Cursor 元数据进程组清理未确认：{error}").context(CleanupUnconfirmed)
        );
    }
    tokio::time::timeout(Duration::from_secs(2), group.child.wait())
        .await
        .context("Cursor 元数据进程回收超时")
        .context(CleanupUnconfirmed)?
        .context("Cursor 元数据进程回收失败")
        .context(CleanupUnconfirmed)?;
    Ok((result.context("Cursor 元数据读取超时")??, deadline))
}
fn binary_candidates(
    overridden: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Vec<String> {
    if let Some(binary) = overridden {
        // A non-UTF-8 override cannot be represented by our launch contract.
        // Fail closed on that sole candidate rather than falling back to another CLI.
        return vec![binary.into_string().unwrap_or_default()];
    }
    let home = home.map(PathBuf::from);
    let mut candidates = Vec::new();
    for name in ["cursor-agent", "agent"] {
        if let Some(home) = &home {
            let installed = home.join(".local/bin").join(name);
            // Construct all priorities without touching the filesystem. Only
            // the individual candidate admitted by discovery may be checked.
            if let Some(installed) = installed.to_str() {
                candidates.push(installed.to_owned());
            }
        }
        candidates.push(name.to_owned());
    }
    candidates
}
pub(crate) async fn discover() -> (String, AgentInfo) {
    discover_candidates(binary_candidates(
        std::env::var_os("LATTE_WORK_CURSOR"),
        crate::agent_environment::variable("HOME"),
    ))
    .await
}
async fn discovery_context(
    deadline: tokio::time::Instant,
) -> Result<(String, Option<std::ffi::OsString>)> {
    if tokio::time::Instant::now() >= deadline {
        bail!("Cursor 元数据读取超时");
    }
    let effective_path = crate::agent_environment::variable("PATH");
    tokio::task::spawn_blocking(move || {
        if tokio::time::Instant::now() >= deadline {
            bail!("Cursor 元数据读取超时");
        }
        let cwd = std::env::current_dir().context("Cursor discovery cwd 无法读取")?;
        let cwd = cwd
            .to_str()
            .context("Cursor discovery cwd 不是 UTF-8")?
            .to_owned();
        Ok((cwd, effective_path))
    })
    .await
    .context("Cursor CLI 路径绑定任务失败")?
}

async fn probe_candidate(
    candidate: String,
    cwd: &str,
    path: Option<std::ffi::OsString>,
    deadline: tokio::time::Instant,
) -> Result<Option<(String, String)>> {
    probe_candidate_with(candidate, cwd, path, deadline, candidate_is_file).await
}

async fn candidate_is_file(binary: PathBuf, deadline: tokio::time::Instant) -> Result<bool> {
    if tokio::time::Instant::now() >= deadline {
        bail!("Cursor 元数据读取超时");
    }
    // Await each admitted worker. A syscall already in progress is not hard
    // bounded by the deadline; dropping a worker would not cancel that syscall.
    tokio::task::spawn_blocking(move || {
        if tokio::time::Instant::now() >= deadline {
            bail!("Cursor 元数据读取超时");
        }
        Ok(std::fs::metadata(binary).is_ok_and(|metadata| metadata.is_file()))
    })
    .await
    .context("Cursor CLI 文件检查任务失败")?
}

// A private checker seam observes the actual production scheduling loop in UT.
// It changes only filesystem checking, not probe/spawn/cleanup behavior.
async fn probe_candidate_with<F, Fut>(
    candidate: String,
    cwd: &str,
    path: Option<std::ffi::OsString>,
    deadline: tokio::time::Instant,
    mut is_file: F,
) -> Result<Option<(String, String)>>
where
    F: FnMut(PathBuf, tokio::time::Instant) -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    let bound_cwd = PathBuf::from(cwd);
    for binary in super::executable::resolve(candidate.as_ref(), path.as_deref(), &bound_cwd) {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        if !is_file(binary.clone(), deadline).await? {
            continue;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        // Never skip an unrepresentable first path to select another CLI.
        let Some(binary) = binary.to_str() else {
            break;
        };
        match probe_binary(binary, cwd, deadline).await {
            Ok(version) => return Ok(Some((binary.to_owned(), version))),
            Err(error) if error.is::<RetryPathCandidate>() => continue,
            Err(error) if error.is::<CleanupUnconfirmed>() => return Err(error),
            // Initial exec success fixes lookup even if version/help is wrong
            // or help later fails to spawn. Only pre-spawn EACCES can retry PATH.
            Err(_) => break,
        }
    }
    Ok(None)
}

async fn discover_candidates(candidates: Vec<String>) -> (String, AgentInfo) {
    let mut binary = candidates.first().cloned().unwrap_or_default();
    let mut available = false;
    let mut detail = "未找到兼容的 Cursor Agent；在此 Host 安装并登录后重启 Server。".into();
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    match discovery_context(deadline).await {
        Ok((cwd, path)) => {
            for candidate in candidates {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                match probe_candidate(candidate, &cwd, path.clone(), deadline).await {
                    Ok(Some((selected, version))) => {
                        binary = selected;
                        available = true;
                        detail = version;
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        detail = error.to_string();
                        break;
                    }
                }
            }
        }
        Err(error) => detail = error.to_string(),
    }
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
async fn probe_binary(binary: &str, cwd: &str, deadline: tokio::time::Instant) -> Result<String> {
    let environment = AgentEnvironment::default();
    let (version, _) = output_until(
        binary,
        &["--version"],
        Some(cwd),
        &environment,
        Some(deadline),
    )
    .await
    .map_err(|error| {
        if error.downcast_ref::<SpawnFailure>().is_some_and(|failure| {
            failure.0.raw_os_error() == Some(nix::errno::Errno::EACCES as i32)
        }) {
            error.context(RetryPathCandidate)
        } else {
            error
        }
    })?;
    if version.trim().is_empty() {
        bail!("Cursor 未返回有效版本");
    }
    let (help, _) =
        output_until(binary, &["--help"], Some(cwd), &environment, Some(deadline)).await?;
    validate_capabilities(&help)?;
    Ok(version.trim().to_owned())
}

// Read declarations, not mentions of flags in arbitrary help descriptions.
fn option_declaration(line: &str) -> Option<(&str, &str)> {
    let mut words = line.trim_start().splitn(2, char::is_whitespace);
    let mut flag = words.next()?;
    let mut body = words.next().unwrap_or_default().trim_start();
    if !flag.starts_with("--") {
        let short = flag.strip_suffix(',')?;
        if short.len() != 2 || !short.starts_with('-') {
            return None;
        }
        let mut words = body.splitn(2, char::is_whitespace);
        flag = words.next()?;
        body = words.next().unwrap_or_default().trim_start();
    }
    (flag.starts_with("--")
        && flag[2..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'))
    .then_some((flag, body))
}
fn option_section(help: &str, flag: &str) -> Option<String> {
    let mut lines = help.lines();
    while let Some(line) = lines.next() {
        let Some((declared, body)) = option_declaration(line) else {
            continue;
        };
        if declared != flag {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let mut section = body.to_owned();
        for continuation in lines {
            if continuation.trim().is_empty()
                || continuation.len() - continuation.trim_start().len() <= indent
                || option_declaration(continuation).is_some()
            {
                break;
            }
            section.push(' ');
            section.push_str(continuation.trim());
        }
        return Some(section);
    }
    None
}
fn argument_description(body: &str) -> Option<&str> {
    let close = match body.as_bytes().first()? {
        b'<' => '>',
        b'[' => ']',
        _ => return None,
    };
    let (argument, description) = body.split_once(close)?;
    (argument.len() > 1).then_some(description.trim())
}
fn stream_json_choice(description: &str) -> bool {
    if let Some((_, choices)) = description.split_once("(choices:") {
        return choices
            .split(')')
            .next()
            .unwrap_or_default()
            .split(',')
            .any(|choice| choice.trim().trim_matches(['\'', '"']) == "stream-json");
    }
    // Native CLI help also publishes an unquoted text, json, stream-json list.
    // Require a complete enum list, never just a stream-json mention in prose.
    std::iter::once(description)
        .chain(description.split(':').skip(1))
        .any(|part| {
            let choices: Vec<_> = part
                .split('(')
                .next()
                .unwrap_or_default()
                .split([',', '|'])
                .map(|choice| choice.trim().trim_matches(['\'', '"']))
                .collect();
            choices.len() == 3
                && ["text", "json", "stream-json"]
                    .iter()
                    .all(|format| choices.contains(format))
        })
}
fn validate_capabilities(help: &str) -> Result<()> {
    let print = option_section(help, "--print").context("Cursor 未公布 --print")?;
    if print.starts_with(['<', '[']) {
        bail!("Cursor --print 不是已核验的 flag");
    }
    for flag in ["--resume", "--model"] {
        let body = option_section(help, flag).with_context(|| format!("Cursor 未公布 {flag}"))?;
        if argument_description(&body).is_none() {
            bail!("Cursor 未公布 {flag} 参数");
        }
    }
    let body = option_section(help, "--output-format").context("Cursor 未公布 --output-format")?;
    if !argument_description(&body).is_some_and(stream_json_choice) {
        bail!("Cursor --output-format 未公布 stream-json 支持");
    }
    Ok(())
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
    if let Some(selected) = selected {
        let Response::Models { models, .. } = models(binary, path, None, environment).await? else {
            unreachable!("Cursor catalog always returns Models")
        };
        if !models.iter().any(|model| model == selected) {
            bail!("Cursor 原生模型不支持所选 ID");
        }
    }
    Ok(())
}
pub(super) fn catalog(output: &str, _selected: Option<&str>) -> Result<Response> {
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
    Ok(Response::Models {
        models,
        provider: None,
        default_model,
        effort_levels: vec![],
        model_labels: labels,
        model_variants: None,
    })
}

fn valid_cursor_slash_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn skill_roots(project: &std::path::Path, environment: &AgentEnvironment) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for parent in project.ancestors().take(32) {
        roots.extend(
            [
                ".cursor/skills",
                ".claude/skills",
                ".codex/skills",
                ".agents/skills",
            ]
            .map(|relative| parent.join(relative)),
        );
        if parent.join(".git").exists() {
            break;
        }
    }
    let home = crate::agent_environment::configured_variable("HOME", environment)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    if let Some(cursor_config) =
        crate::agent_environment::configured_variable("CURSOR_CONFIG_DIR", environment)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".cursor")))
    {
        roots.extend(["skills", "skills-cursor"].map(|relative| cursor_config.join(relative)));
    }
    if let Some(claude_config) =
        crate::agent_environment::configured_variable("CLAUDE_CONFIG_DIR", environment)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".claude")))
    {
        roots.push(claude_config.join("skills"));
    }
    if let Some(codex_home) =
        crate::agent_environment::configured_variable("CODEX_HOME", environment)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".codex")))
    {
        roots.push(codex_home.join("skills"));
    }
    if let Some(home) = home {
        roots.push(home.join(".agents/skills"));
    }
    roots
}

fn command_roots(project: &std::path::Path, environment: &AgentEnvironment) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for parent in project.ancestors().take(32) {
        roots.extend([".cursor/commands", ".claude/commands"].map(|r| parent.join(r)));
        if parent.join(".git").exists() {
            break;
        }
    }
    let home = crate::agent_environment::configured_variable("HOME", environment)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    if let Some(cursor_config) =
        crate::agent_environment::configured_variable("CURSOR_CONFIG_DIR", environment)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".cursor")))
    {
        roots.push(cursor_config.join("commands"));
    }
    if let Some(claude_config) =
        crate::agent_environment::configured_variable("CLAUDE_CONFIG_DIR", environment)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".claude")))
    {
        roots.push(claude_config.join("commands"));
    }
    roots
}

fn parse_markdown_command(path: &std::path::Path, id: &str) -> Result<Option<AgentSlashCommand>> {
    let document = crate::agents::claude_skills::read(path, 64 * 1024)?;
    if document.trim().is_empty() {
        return Ok(None);
    }
    let front_desc = crate::agents::claude_skills::field(&document, "description");
    let front_name = crate::agents::claude_skills::field(&document, "name");
    let body = document
        .trim_start_matches('\u{feff}')
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n").map(|(_, body)| body))
        .or_else(|| {
            document
                .trim_start_matches('\u{feff}')
                .strip_prefix("---\r\n")
                .and_then(|rest| rest.split_once("\r\n---\r\n").map(|(_, body)| body))
        })
        .unwrap_or(&document);
    let mut heading: Option<String> = None;
    let mut first_line: Option<String> = None;
    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(stripped) = line.strip_prefix('#') {
            let clean = stripped.trim_start_matches('#').trim();
            if !clean.is_empty() {
                heading = Some(clean.into());
                break;
            }
        } else if first_line.is_none() {
            first_line = Some(line.into());
        }
    }
    let display_candidate = if !front_name.is_empty() {
        Some(front_name)
    } else {
        heading.clone()
    };
    let display_name = display_candidate.filter(|label| {
        label != id && label.chars().count() <= 80 && !label.chars().any(char::is_control)
    });
    let description = if !front_desc.is_empty() {
        front_desc
    } else {
        heading.or(first_line).unwrap_or_default()
    };
    Ok(Some(AgentSlashCommand {
        name: id.into(),
        display_name,
        description: description.chars().take(240).collect(),
        argument_hint: "[参数]".into(),
        kind: Some(AgentCommandKind::Command),
        ui_action: None,
    }))
}

fn scan_local_catalog(
    project: &std::path::Path,
    environment: &AgentEnvironment,
) -> Vec<AgentSlashCommand> {
    const LIMIT: usize = 512;
    const DIR_SCAN_HARD_LIMIT: usize = 8192;
    let mut seen = std::collections::HashSet::new();
    let mut catalog = Vec::new();
    for root in command_roots(project, environment) {
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        let Ok(listing) = std::fs::read_dir(&canonical_root) else {
            continue;
        };
        let mut files: Vec<(String, PathBuf)> = listing
            .take(DIR_SCAN_HARD_LIMIT)
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_name = entry.file_name().into_string().ok()?;
                let stem = file_name.strip_suffix(".md")?;
                valid_cursor_slash_id(stem).then(|| (stem.to_owned(), entry.path()))
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (stem, path) in files {
            if catalog.len() >= LIMIT {
                return catalog;
            }
            if seen.contains(&stem) {
                continue;
            }
            let Ok(resolved) = path.canonicalize() else {
                continue;
            };
            if !resolved.starts_with(&canonical_root) {
                continue;
            }
            if let Ok(Some(cmd)) = parse_markdown_command(&resolved, &stem) {
                seen.insert(stem);
                catalog.push(cmd);
            }
        }
    }
    for (slug, info) in crate::agents::claude_skills::scan_roots(&skill_roots(project, environment))
    {
        if catalog.len() >= LIMIT {
            break;
        }
        if !valid_cursor_slash_id(&slug) || seen.contains(&slug) {
            continue;
        }
        let skill_file = PathBuf::from(&info.directory).join("SKILL.md");
        if let Ok(doc) = crate::agents::claude_skills::read(&skill_file, 64 * 1024)
            && crate::agents::claude_skills::field(&doc, "user-invocable")
                .eq_ignore_ascii_case("false")
        {
            continue;
        }
        seen.insert(slug.clone());
        let display_name = (info.name != slug
            && info.name.chars().count() <= 80
            && !info.name.chars().any(char::is_control))
        .then_some(info.name);
        catalog.push(AgentSlashCommand {
            name: slug,
            display_name,
            description: info.description.chars().take(240).collect(),
            argument_hint: "[任务说明]".into(),
            kind: Some(AgentCommandKind::Skill),
            ui_action: None,
        });
    }
    catalog
}

pub(crate) async fn commands(
    binary: &str,
    cwd: &str,
    config: &crate::providers::LaunchConfig,
) -> Result<Vec<AgentSlashCommand>> {
    if config.provider.is_some() {
        bail!("Cursor Agent 不支持 App Provider");
    }
    validate_capabilities(&output(binary, &["--help"], Some(cwd), &config.environment).await?)?;
    let project = PathBuf::from(cwd);
    let environment = config.environment.clone();
    tokio::time::timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(move || scan_local_catalog(&project, &environment)),
    )
    .await
    .context("读取 Cursor 命令与技能目录超时")?
    .context("读取 Cursor 命令与技能目录失败")
}

pub(crate) fn skill_info(
    project: &std::path::Path,
    name: &str,
    environment: &AgentEnvironment,
) -> Result<Option<SkillInfo>> {
    crate::agents::claude_skills::find_in_roots(&skill_roots(project, environment), name)
}

#[cfg(test)]
#[path = "metadata_lookup_tests.rs"]
mod lookup_tests;
#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;
