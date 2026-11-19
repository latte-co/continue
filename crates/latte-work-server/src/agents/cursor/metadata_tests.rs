use super::*;
use std::os::unix::fs::PermissionsExt;

// These tests measure a real five-second probe budget. Give each Cursor CLI
// fixture exclusive access to this test resource before its clock starts;
// libtest and unrelated tests remain parallel. Two concurrent fixtures still
// exhausted the fallback test's budget before its second process could start.
static CURSOR_FIXTURES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) async fn fixture_permit() -> tokio::sync::SemaphorePermit<'static> {
    CURSOR_FIXTURES.acquire().await.unwrap()
}

fn fixture(script: &str) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cursor");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (dir, path.to_string_lossy().into_owned())
}
pub(super) const COMPATIBLE_HELP: &str = "  -p, --print Print responses\n  --output-format <format> Output (choices: \"text\", \"json\", \"stream-json\")\n  --resume [chatId] Resume a chat\n  --model <model> Choose a model\n";

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
    let _permit = fixture_permit().await;
    let (wrong_dir, wrong) =
        probe_fixture("  --notes Mentions --print --output-format stream-json --resume --model");
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
    let _permit = fixture_permit().await;
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
async fn cursor_discovery_reaps_timeout_without_starting_over_budget_fallback() {
    let _permit = fixture_permit().await;
    let (_dir, binary) = fixture(
        "case \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s\\n' \"$$\" >> \"$0.pids\"; sleep 30;;\n*) exit 4;;\nesac",
    );
    let (_fallback_dir, fallback) = fixture("printf 'executed' > \"$0.marker\"; exit 4");
    let start = std::time::Instant::now();
    let (_, info) = discover_candidates(vec![binary.clone(), fallback.clone()]).await;
    let elapsed = start.elapsed();
    assert!(!info.available);
    let pids = std::fs::read_to_string(format!("{binary}.pids")).unwrap();
    let pids: Vec<i32> = pids.lines().map(|pid| pid.parse().unwrap()).collect();
    assert_eq!(pids.len(), 1);
    assert!(!std::path::Path::new(&format!("{fallback}.marker")).exists());
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
    let _permit = fixture_permit().await;
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
async fn cursor_discovery_fallback_reuses_remaining_read_budget() {
    let _permit = fixture_permit().await;
    let (_first_dir, first) = fixture("sleep 3; exit 4");
    let (_second_dir, second) = fixture(
        "printf '%s\\n' \"$$\" >> \"$0.pids\"\ncase \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) sleep 30;;\n*) exit 4;;\nesac",
    );
    let start = std::time::Instant::now();
    let (_, info) = discover_candidates(vec![first, second.clone()]).await;
    assert!(!info.available);
    let elapsed = start.elapsed();
    let pids = std::fs::read_to_string(format!("{second}.pids")).unwrap();
    assert_eq!(pids.lines().count(), 2);
    for pid in pids.lines().map(|pid| pid.parse::<i32>().unwrap()) {
        assert_eq!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH),
        );
    }
    assert!(
        elapsed < Duration::from_secs(7),
        "fallback reset the shared discovery deadline: {elapsed:?}"
    );
}

#[tokio::test]
async fn cursor_discovery_stops_before_executing_lower_priority_agent() {
    let _permit = fixture_permit().await;
    let (_first_dir, first) = probe_fixture(COMPATIBLE_HELP);
    let (_second_dir, second) = fixture("printf 'executed' > \"$0.marker\"; exit 4");
    let (selected, info) = discover_candidates(vec![first.clone(), second.clone()]).await;
    assert_eq!(selected, first);
    assert!(info.available);
    assert!(
        !std::path::Path::new(&format!("{second}.marker")).exists(),
        "a compatible preferred CLI must prevent executing the generic fallback"
    );
}

#[tokio::test]
async fn cursor_discovery_cleans_failed_candidate_before_fallback() {
    let _permit = fixture_permit().await;
    let (dir, first) = fixture(
        "case \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s' \"$$\" > \"$0.pid\"; sleep 0.1; printf 'incompatible\\n';;\n*) exit 4;;\nesac",
    );
    let pid_path = dir.path().join("cursor.pid");
    let (_second_dir, second) = fixture(&format!(
        "pid=$(cat '{}') || {{ printf 'premature' > \"$0.marker\"; exit 4; }}\nif kill -0 \"$pid\" 2>/dev/null; then printf 'unclean' > \"$0.marker\"; exit 4; fi\ncase \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s' '{COMPATIBLE_HELP}';;\n*) exit 4;;\nesac",
        pid_path.display()
    ));
    let (selected, info) = discover_candidates(vec![first, second.clone()]).await;
    assert_eq!(selected, second);
    assert!(info.available);
    assert!(!std::path::Path::new(&format!("{second}.marker")).exists());
}

#[tokio::test]
async fn cursor_incompatible_explicit_override_remains_unavailable() {
    let _permit = fixture_permit().await;
    let (_dir, wrong) = probe_fixture("  --notes stream-json --print --resume --model");
    let (selected, info) =
        discover_candidates(binary_candidates(Some(wrong.clone().into()), None)).await;
    assert_eq!(selected, wrong);
    assert!(!info.available);
}

#[tokio::test]
async fn cursor_metadata_is_prompt_free_environment_aware_and_redacted() {
    let _permit = fixture_permit().await;
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
    let _permit = fixture_permit().await;
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
    let _permit = fixture_permit().await;
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
