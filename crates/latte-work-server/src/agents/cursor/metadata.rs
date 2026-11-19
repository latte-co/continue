//! Prompt-free Cursor metadata; no status/login/empty-chat/model turns.
use anyhow::{Context, Result, bail};
use latte_work_protocol::{AgentEnvironment, AgentInfo, AgentPermissionMode, Effort, Response};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const OUTPUT_LIMIT: u64 = 128 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MODELS: usize = 256;

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
    let binary = binary.to_owned();
    let args: Vec<_> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let path = path.map(str::to_owned);
    let environment = environment.clone();
    // Environment preparation and Command::spawn are synchronous. Keep them off
    // the async executor so one candidate cannot exhaust another's read budget.
    tokio::task::spawn_blocking(move || {
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
        let child = command.spawn().context("Cursor 元数据进程无法启动")?;
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
    // window; discovery starts this window once and reuses it for --help.
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
        bail!("Cursor 元数据进程组清理未确认：{error}");
    }
    tokio::time::timeout(Duration::from_secs(2), group.child.wait())
        .await
        .context("Cursor 元数据进程回收超时")??;
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
            if installed.is_file()
                && let Some(installed) = installed.to_str()
            {
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
async fn discover_candidates(candidates: Vec<String>) -> (String, AgentInfo) {
    let mut binary = candidates.first().cloned().unwrap_or_default();
    let mut available = false;
    let mut detail = "未找到兼容的 Cursor Agent；在此 Host 安装并登录后重启 Server。".into();
    // Await every owned probe, including cleanup, before choosing by priority.
    // Do not race/drop losing probes: each output path must confirm kill/reap.
    let probes =
        futures_util::future::join_all(candidates.iter().map(|candidate| probe_binary(candidate)))
            .await;
    for (candidate, probe) in candidates.into_iter().zip(probes) {
        if let Ok(version) = probe {
            binary = candidate;
            available = true;
            detail = version;
            break;
        }
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
async fn probe_binary(binary: &str) -> Result<String> {
    let environment = AgentEnvironment::default();
    let (version, deadline) =
        output_until(binary, &["--version"], None, &environment, None).await?;
    if version.trim().is_empty() {
        bail!("Cursor 未返回有效版本");
    }
    let (help, _) = output_until(binary, &["--help"], None, &environment, Some(deadline)).await?;
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
    const COMPATIBLE_HELP: &str = "  -p, --print Print responses\n  --output-format <format> Output (choices: \"text\", \"json\", \"stream-json\")\n  --resume [chatId] Resume a chat\n  --model <model> Choose a model\n";

    fn probe_fixture(help: &str) -> (tempfile::TempDir, String) {
        fixture(&format!(
            "printf '%s\\n' \"$1\" >> \"$0.args\"\ncase \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s' '{help}';;\n*) exit 4;;\nesac"
        ))
    }

    #[test]
    fn cursor_capabilities_require_real_option_declarations_and_scoped_format_choices() {
        validate_capabilities(COMPATIBLE_HELP).unwrap();
        let native = "  --print Print\n  --output-format <format> Output (only with --print): text, json, stream-json (default: \"text\")\n  --resume [chatId] Resume\n  --model <model> Model";
        validate_capabilities(native).unwrap();
        let wrapped = "  --print Print\n  --output-format <format> Output\n      (choices: \"text\", \"json\", \"stream-json\")\n  --resume <chatId> Resume\n  --model <model> Model";
        validate_capabilities(wrapped).unwrap();
        for flag in ["--print", "--output-format", "--resume", "--model"] {
            // Mentions of the missing option in unrelated descriptions do not count.
            let help = COMPATIBLE_HELP
                .lines()
                .filter(|line| !line.contains(flag))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(validate_capabilities(&format!("{help}\n  --notes mentions {flag}")).is_err());
        }
        for unsupported in [
            COMPATIBLE_HELP.replace("\"stream-json\"", "\"stream-json-v2\""),
            COMPATIBLE_HELP.replace("\"stream-json\"", "\"not-stream-json\""),
            COMPATIBLE_HELP.replace("<format>", "format"),
            COMPATIBLE_HELP.replace("[chatId]", "chatId"),
            COMPATIBLE_HELP.replace("<model>", "model"),
            COMPATIBLE_HELP.replace("--print Print", "--print <value> Print"),
        ] {
            assert!(validate_capabilities(&unsupported).is_err());
        }
        for description in [
            "Use another program for stream-json",
            "Example: stream-json",
            "Output (choices: \"text\", \"json\")",
        ] {
            let help = format!(
                "  --print Print\n  --output-format <format> {description}\n  --resume [chatId] Resume\n  --model <model> Model (choices: \"stream-json\")"
            );
            assert!(validate_capabilities(&help).is_err());
        }
    }

    #[test]
    fn cursor_candidates_prioritize_cursor_agent_and_never_fallback_from_override() {
        use std::os::unix::ffi::OsStringExt;
        let home = tempfile::tempdir().unwrap();
        let installed = home.path().join(".local/bin");
        std::fs::create_dir_all(&installed).unwrap();
        for name in ["cursor-agent", "agent"] {
            std::fs::write(installed.join(name), "fixture").unwrap();
        }
        assert_eq!(
            binary_candidates(None, Some(home.path().into())),
            [
                installed.join("cursor-agent").to_str().unwrap(),
                "cursor-agent",
                installed.join("agent").to_str().unwrap(),
                "agent",
            ]
        );
        assert_eq!(
            binary_candidates(Some("/explicit/cursor".into()), Some(home.path().into())),
            ["/explicit/cursor"]
        );
        assert_eq!(
            binary_candidates(
                Some(std::ffi::OsString::from_vec(b"/invalid/\xff".to_vec())),
                Some(home.path().into()),
            ),
            [""]
        );
    }

    #[tokio::test]
    async fn cursor_discovery_checks_help_and_advances_to_compatible_generic_agent() {
        let (wrong_dir, wrong) = probe_fixture(
            "  --notes Mentions --print --output-format stream-json --resume --model",
        );
        let (dir, binary) = probe_fixture(COMPATIBLE_HELP);
        let agent = dir.path().join("agent");
        std::fs::rename(&binary, &agent).unwrap();
        let agent = agent.to_str().unwrap().to_owned();
        let (selected, info) = discover_candidates(vec![wrong, agent.clone()]).await;
        assert_eq!(selected, agent);
        assert!(info.available);
        assert_eq!(info.detail, "fixture-version");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("agent.args")).unwrap(),
            "--version\n--help\n"
        );
        assert_eq!(
            std::fs::read_to_string(wrong_dir.path().join("cursor.args")).unwrap(),
            "--version\n--help\n"
        );
    }

    #[tokio::test]
    async fn cursor_discovery_skips_failed_or_empty_versions_without_more_commands() {
        for script in [
            "printf '%s\\n' \"$1\" >> \"$0.args\"; exit 3",
            "printf '%s\\n' \"$1\" >> \"$0.args\"; printf '  \\n'",
        ] {
            let (bad_dir, bad) = fixture(script);
            let (_dir, good) = probe_fixture(COMPATIBLE_HELP);
            let (selected, info) = discover_candidates(vec![bad, good.clone()]).await;
            assert!(info.available);
            assert_eq!(selected, good);
            assert_eq!(
                std::fs::read_to_string(bad_dir.path().join("cursor.args")).unwrap(),
                "--version\n"
            );
        }
    }

    #[tokio::test]
    async fn cursor_discovery_bounds_the_whole_candidate_set_and_reaps_every_probe() {
        let (_dir, binary) = fixture(
            "case \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s\\n' \"$$\" >> \"$0.pids\"; sleep 30;;\n*) exit 4;;\nesac",
        );
        let start = std::time::Instant::now();
        let (_, info) = discover_candidates(vec![binary.clone(); 4]).await;
        let elapsed = start.elapsed();
        assert!(!info.available);
        let pids = std::fs::read_to_string(format!("{binary}.pids")).unwrap();
        let pids: Vec<i32> = pids.lines().map(|pid| pid.parse().unwrap()).collect();
        assert_eq!(pids.len(), 4);
        for pid in pids {
            assert_eq!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                Err(nix::errno::Errno::ESRCH),
            );
        }
        assert!(
            elapsed < Duration::from_secs(9),
            "discovery exceeded the connection startup budget: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn cursor_discovery_version_and_help_share_one_read_deadline() {
        let (_dir, binary) = fixture(
            "printf '%s\\n' \"$$\" >> \"$0.pids\"\ncase \"$1\" in\n--version) sleep 3; printf 'fixture-version\\n';;\n--help) sleep 30;;\n*) exit 4;;\nesac",
        );
        let start = std::time::Instant::now();
        let (_, info) = discover_candidates(vec![binary.clone()]).await;
        assert!(!info.available);
        let elapsed = start.elapsed();
        let pids = std::fs::read_to_string(format!("{binary}.pids")).unwrap();
        assert_eq!(pids.lines().count(), 2);
        for pid in pids.lines().map(|pid| pid.parse::<i32>().unwrap()) {
            assert_eq!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                Err(nix::errno::Errno::ESRCH),
            );
        }
        assert!(
            elapsed < Duration::from_secs(7),
            "version/help did not share the candidate deadline: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn cursor_discovery_preserves_priority_and_cleans_losing_candidates() {
        let (_first_dir, first) = probe_fixture(COMPATIBLE_HELP);
        let (_second_dir, second) = probe_fixture(COMPATIBLE_HELP);
        let (selected, info) = discover_candidates(vec![first.clone(), second.clone()]).await;
        assert_eq!(selected, first);
        assert!(info.available);
        assert_eq!(
            std::fs::read_to_string(format!("{second}.args")).unwrap(),
            "--version\n--help\n"
        );
        let (_dir, hung) = fixture(
            "case \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s' \"$$\" > \"$0.pid\"; sleep 30;;\n*) exit 4;;\nesac",
        );
        let (selected, info) = discover_candidates(vec![first.clone(), hung.clone()]).await;
        assert_eq!(selected, first);
        assert!(info.available);
        let pid: i32 = std::fs::read_to_string(format!("{hung}.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH),
        );
    }

    #[tokio::test]
    async fn cursor_incompatible_explicit_override_remains_unavailable() {
        let (_dir, wrong) = probe_fixture("  --notes stream-json --print --resume --model");
        let (selected, info) =
            discover_candidates(binary_candidates(Some(wrong.clone().into()), None)).await;
        assert_eq!(selected, wrong);
        assert!(!info.available);
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
    async fn cursor_selection_still_requires_current_membership_and_no_effort() {
        let (_dir, binary) = fixture("printf 'Available models\\ncurrent - Current (default)\\n'");
        let environment = AgentEnvironment::default();
        validate_selection(&binary, None, Some("current"), None, &environment)
            .await
            .unwrap();
        assert!(
            validate_selection(&binary, None, Some("removed-model"), None, &environment)
                .await
                .is_err()
        );
        assert!(
            validate_selection(&binary, None, None, Some(Effort::High), &environment)
                .await
                .is_err()
        );
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
