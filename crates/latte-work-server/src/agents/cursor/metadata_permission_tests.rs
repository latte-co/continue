//! Isolated discovery regressions: no mutation of the test runner's environment.
use super::*;
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    process::{Command, Stdio},
};

const CASE_ENV: &str = "LATTE_CURSOR_PERMISSION_TEST_CASE";
const ROOT_ENV: &str = "LATTE_CURSOR_PERMISSION_TEST_ROOT";
const CHILD_TEST: &str = "cursor_permission_subprocess_case";

fn install(path: &Path, script: &str, mode: u32) {
    std::fs::write(path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn compatible_script(version: &str) -> String {
    format!(
        "printf '%s\\n' \"$1\" >> \"$0.args\"\ncase \"$1\" in\n--version) printf '{version}\\n';;\n--help) printf '%s' '{help}';;\nmodels) printf 'Available models\\nchosen - Chosen (default)\\n';;\n*) exit 4;;\nesac",
        help = super::tests::COMPATIBLE_HELP,
    )
}

fn deny_spawn(path: &Path) {
    if nix::unistd::Uid::effective().is_root() {
        // Root bypasses owner/group permission selection when any x bit exists.
        // A non-executable shebang interpreter gives real kernel EACCES even then.
        let interpreter = path.with_extension("interpreter");
        install(&interpreter, "exit 4", 0o600);
        std::fs::write(path, format!("#!{}\nexit 4\n", interpreter.display())).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    } else {
        install(path, &compatible_script("denied-version"), 0o010);
        let metadata = std::fs::metadata(path).unwrap();
        assert_eq!(metadata.uid(), nix::unistd::Uid::effective().as_raw());
        assert_eq!(metadata.gid(), nix::unistd::Gid::effective().as_raw());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o010);
    }
    let error = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .expect_err("permission fixture must fail before starting a child");
    assert_eq!(error.raw_os_error(), Some(nix::errno::Errno::EACCES as i32));
}

fn run_case(case: &str) {
    // The parent owns the shared permit across the entire isolated child case.
    // Acquisition needs no I/O/timer driver and occurs before discovery timing.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let _permit = runtime.block_on(super::tests::fixture_permit());
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let generic = root.path().join("generic");
    for directory in [&first, &second, &generic] {
        std::fs::create_dir(directory).unwrap();
    }
    deny_spawn(&first.join("cursor-agent"));
    install(
        &second.join("cursor-agent"),
        &compatible_script("second-version"),
        0o700,
    );
    install(
        &generic.join("agent"),
        &compatible_script("generic-version"),
        0o700,
    );
    install(
        &generic.join("cursor-agent"),
        "printf 'reselected' > \"$0.marker\"; exit 4",
        0o700,
    );
    customize_case(
        case,
        &first.join("cursor-agent"),
        &second.join("cursor-agent"),
    );
    let path = std::env::join_paths([&first, &second, &generic]).unwrap();
    // Re-exec the test binary to supply a Host PATH safely (Rust 2024 set_var is unsafe).
    let output = Command::new(std::env::current_exe().unwrap())
        .args([CHILD_TEST, "--nocapture", "--test-threads=1"])
        .env(CASE_ENV, case)
        .env(ROOT_ENV, root.path())
        .env("PATH", path)
        .env("LATTE_WORK_AGENT_ENV", "inherit")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "isolated permission case {case} failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

fn customize_case(case: &str, first: &Path, second: &Path) {
    if matches!(case, "incompatible" | "help_eacces" | "enoexec") {
        // The EACCES precondition has already been checked. Restore owner write
        // before replacing this fixture, not the behavior under test.
        std::fs::set_permissions(first, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    match case {
        "incompatible" => install(
            first,
            "printf '%s\\n' \"$1\" >> \"$0.args\"\ncase \"$1\" in\n--version) printf 'wrong-version\\n';;\n--help) printf 'incompatible\\n';;\n*) exit 4;;\nesac",
            0o700,
        ),
        "help_eacces" => install(
            first,
            "printf '%s\\n' \"$1\" >> \"$0.args\"\n/bin/chmod 600 \"$0\"\nprintf 'first-version\\n'",
            0o700,
        ),
        "enoexec" => std::fs::write(first, "not an executable image\n").unwrap(),
        "budget" => install(
            second,
            "printf '%s\\n' \"$$\" >> \"$0.pids\"\ncase \"$1\" in\n--version) /bin/sleep 3; printf 'second-version\\n';;\n--help) /bin/sleep 30;;\n*) exit 4;;\nesac",
            0o700,
        ),
        _ => {}
    }
    if case == "enoexec" {
        std::fs::set_permissions(first, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn cursor_discovery_retries_real_eacces_in_same_name_path_order() {
    run_case("eacces");
}

#[test]
fn cursor_bare_override_retries_only_its_same_name_path_candidates() {
    run_case("bare_override");
}

#[test]
fn cursor_slash_override_does_not_replace_permission_denied_binary() {
    run_case("slash_override");
}

#[test]
fn cursor_started_incompatible_binary_does_not_try_same_name_later_path() {
    run_case("incompatible");
}

#[test]
fn cursor_help_spawn_eacces_does_not_replace_already_started_binary() {
    run_case("help_eacces");
}

#[test]
fn cursor_non_eacces_spawn_error_does_not_try_same_name_later_path() {
    run_case("enoexec");
}

#[test]
fn cursor_eacces_retry_keeps_shared_deadline_and_reaps_probe_group() {
    run_case("budget");
}

#[test]
fn cursor_permission_bound_binary_ignores_configured_path() {
    run_case("configured_path");
}

#[tokio::test]
async fn cursor_permission_subprocess_case() {
    let Ok(case) = std::env::var(CASE_ENV) else {
        return;
    };
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap());
    let first = root.join("first/cursor-agent").to_str().unwrap().to_owned();
    let second = root
        .join("second/cursor-agent")
        .to_str()
        .unwrap()
        .to_owned();
    let generic = root.join("generic/agent").to_str().unwrap().to_owned();
    let overridden = match case.as_str() {
        "bare_override" => Some("cursor-agent".into()),
        "slash_override" => Some(first.clone().into()),
        _ => None,
    };
    let start = std::time::Instant::now();
    let (selected, info) = discover_candidates(binary_candidates(overridden, None)).await;
    if case == "slash_override" {
        assert!(!info.available);
        assert_eq!(selected, first);
        assert!(!Path::new(&format!("{second}.args")).exists());
        assert!(!Path::new(&format!("{generic}.args")).exists());
    } else if case == "budget" {
        assert_budget_cleanup(&info, start, &second, &generic);
    } else if matches!(case.as_str(), "incompatible" | "help_eacces" | "enoexec") {
        assert!(info.available);
        assert_eq!(selected, generic);
        assert!(!Path::new(&format!("{second}.args")).exists());
    } else {
        assert!(
            info.available,
            "must continue same-name PATH after spawn EACCES"
        );
        assert_eq!(selected, second);
        assert_eq!(info.detail, "second-version");
        assert_eq!(
            std::fs::read_to_string(format!("{second}.args")).unwrap(),
            "--version\n--help\n"
        );
        assert!(
            !Path::new(&format!("{generic}.args")).exists(),
            "generic fallback must stay lazy"
        );
        if case == "configured_path" {
            assert_configured_path(&root, &selected).await;
        }
    }
    assert!(!root.join("generic/cursor-agent.marker").exists());
}

fn assert_budget_cleanup(info: &AgentInfo, start: std::time::Instant, second: &str, generic: &str) {
    assert!(
        !info.available,
        "EACCES retry must spend the one discovery budget on second CLI"
    );
    assert!(start.elapsed() < Duration::from_secs(7));
    let pids = std::fs::read_to_string(format!("{second}.pids")).unwrap();
    assert_eq!(pids.lines().count(), 2);
    for pid in pids.lines().map(|pid| pid.parse::<i32>().unwrap()) {
        assert_eq!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH),
        );
    }
    assert!(!Path::new(&format!("{generic}.args")).exists());
}

async fn assert_configured_path(root: &Path, selected: &str) {
    let environment = AgentEnvironment(BTreeMap::from([(
        "PATH".into(),
        root.join("generic").to_str().unwrap().into(),
    )]));
    let Response::Models { models, .. } = models(selected, None, None, &environment).await.unwrap()
    else {
        panic!("expected fixture model catalog");
    };
    assert_eq!(models, ["chosen"]);
}
