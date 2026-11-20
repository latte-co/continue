//! Observe filesystem admissions in the production lookup loop, with real probes.
use super::*;
use std::{os::unix::fs::PermissionsExt, path::Path};

fn install(path: &Path, script: &str, mode: u32) {
    std::fs::write(path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn compatible_script() -> String {
    format!(
        "printf '%s\\n' \"$1\" >> \"$0.args\"\ncase \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf '%s' '{help}';;\n*) exit 4;;\nesac",
        help = super::tests::COMPATIBLE_HELP,
    )
}

fn lookup_fixture() -> (tempfile::TempDir, Vec<PathBuf>, std::ffi::OsString) {
    let root = tempfile::tempdir().unwrap();
    let directories: Vec<_> = ["first", "second", "third"]
        .into_iter()
        .map(|name| root.path().join(name))
        .collect();
    for directory in &directories {
        std::fs::create_dir(directory).unwrap();
    }
    let binaries = directories.iter().map(|path| path.join("agent")).collect();
    let path = std::env::join_paths(directories).unwrap();
    (root, binaries, path)
}

#[tokio::test]
async fn cursor_lookup_first_success_does_not_check_tail() {
    let _permit = super::tests::fixture_permit().await;
    let (root, binaries, path) = lookup_fixture();
    install(&binaries[0], &compatible_script(), 0o700);
    let checked = std::cell::RefCell::new(Vec::new());
    let result = probe_candidate_with(
        "agent".into(),
        root.path().to_str().unwrap(),
        Some(path),
        tokio::time::Instant::now() + PROBE_TIMEOUT,
        |binary, deadline| {
            assert_eq!(binary, binaries[0], "must not check second PATH entry");
            checked.borrow_mut().push(binary.clone());
            candidate_is_file(binary, deadline)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        Some((
            binaries[0].to_str().unwrap().into(),
            "fixture-version".into()
        ))
    );
    assert_eq!(*checked.borrow(), [binaries[0].clone()]);
    assert_eq!(
        std::fs::read_to_string(binaries[0].with_extension("args")).unwrap(),
        "--version\n--help\n"
    );
}

#[tokio::test]
async fn cursor_lookup_initial_eacces_checks_only_next_before_success() {
    let _permit = super::tests::fixture_permit().await;
    let (root, binaries, path) = lookup_fixture();
    // No execute bits yields kernel EACCES for both root and non-root callers.
    install(&binaries[0], &compatible_script(), 0o600);
    let error = std::process::Command::new(&binaries[0])
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .expect_err("fixture must fail before starting a child");
    assert_eq!(error.raw_os_error(), Some(nix::errno::Errno::EACCES as i32));
    install(&binaries[1], &compatible_script(), 0o700);
    let checked = std::cell::RefCell::new(Vec::new());
    let result = probe_candidate_with(
        "agent".into(),
        root.path().to_str().unwrap(),
        Some(path),
        tokio::time::Instant::now() + PROBE_TIMEOUT,
        |binary, deadline| {
            assert_ne!(binary, binaries[2], "must not check third PATH entry");
            assert_eq!(binary, binaries[checked.borrow().len()]);
            checked.borrow_mut().push(binary.clone());
            candidate_is_file(binary, deadline)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        Some((
            binaries[1].to_str().unwrap().into(),
            "fixture-version".into()
        ))
    );
    assert_eq!(*checked.borrow(), binaries[..2]);
    assert!(!binaries[0].with_extension("args").exists());
    assert_eq!(
        std::fs::read_to_string(binaries[1].with_extension("args")).unwrap(),
        "--version\n--help\n"
    );
}

#[tokio::test]
async fn cursor_lookup_incompatible_and_help_eacces_do_not_check_tail() {
    let _permit = super::tests::fixture_permit().await;
    for (script, expected_args) in [
        (
            "printf '%s\\n' \"$1\" >> \"$0.args\"\ncase \"$1\" in\n--version) printf 'fixture-version\\n';;\n--help) printf 'incompatible\\n';;\n*) exit 4;;\nesac",
            "--version\n--help\n",
        ),
        (
            "printf '%s\\n' \"$1\" >> \"$0.args\"\n/bin/chmod 600 \"$0\"\nprintf 'fixture-version\\n'",
            "--version\n",
        ),
    ] {
        let (root, binaries, path) = lookup_fixture();
        install(&binaries[0], script, 0o700);
        install(&binaries[1], &compatible_script(), 0o700);
        let checked = std::cell::RefCell::new(Vec::new());
        let result = probe_candidate_with(
            "agent".into(),
            root.path().to_str().unwrap(),
            Some(path),
            tokio::time::Instant::now() + PROBE_TIMEOUT,
            |binary, deadline| {
                assert_eq!(binary, binaries[0], "started CLI fixes same-name lookup");
                checked.borrow_mut().push(binary.clone());
                candidate_is_file(binary, deadline)
            },
        )
        .await
        .unwrap();
        assert_eq!(result, None);
        assert_eq!(*checked.borrow(), [binaries[0].clone()]);
        assert_eq!(
            std::fs::read_to_string(binaries[0].with_extension("args")).unwrap(),
            expected_args
        );
        assert!(!binaries[1].with_extension("args").exists());
        if expected_args == "--version\n" {
            let error = std::process::Command::new(&binaries[0])
                .arg("--help")
                .output()
                .expect_err("version must have made subsequent help spawn fail");
            assert_eq!(error.raw_os_error(), Some(nix::errno::Errno::EACCES as i32));
        }
    }
}

#[tokio::test]
async fn cursor_lookup_non_eacces_initial_spawn_error_does_not_check_tail() {
    let _permit = super::tests::fixture_permit().await;
    let (root, binaries, path) = lookup_fixture();
    std::fs::write(&binaries[0], "not an executable image\n").unwrap();
    std::fs::set_permissions(&binaries[0], std::fs::Permissions::from_mode(0o700)).unwrap();
    let checked = std::cell::RefCell::new(Vec::new());
    let result = probe_candidate_with(
        "agent".into(),
        root.path().to_str().unwrap(),
        Some(path),
        tokio::time::Instant::now() + PROBE_TIMEOUT,
        |binary, deadline| {
            assert_eq!(binary, binaries[0], "only initial EACCES may retry");
            checked.borrow_mut().push(binary.clone());
            candidate_is_file(binary, deadline)
        },
    )
    .await
    .unwrap();
    assert_eq!(result, None);
    assert_eq!(*checked.borrow(), [binaries[0].clone()]);
}

#[tokio::test]
async fn cursor_lookup_expired_deadline_does_not_admit_first_check() {
    let (root, _, path) = lookup_fixture();
    let result = probe_candidate_with(
        "agent".into(),
        root.path().to_str().unwrap(),
        Some(path),
        tokio::time::Instant::now(),
        |_, _| -> std::future::Ready<Result<bool>> {
            panic!("expired lookup must not admit any filesystem check")
        },
    )
    .await
    .unwrap();
    assert_eq!(result, None);
}

#[tokio::test]
async fn cursor_lookup_deadline_during_check_prevents_probe_and_later_check() {
    let _permit = super::tests::fixture_permit().await;
    // Cover both eligible and missing paths: neither may start new I/O once the
    // in-flight check has consumed the deadline. No child needs cancellation.
    for eligible in [true, false] {
        let (root, binaries, path) = lookup_fixture();
        install(&binaries[0], &compatible_script(), 0o700);
        let checked = std::cell::RefCell::new(Vec::new());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let result = probe_candidate_with(
            "agent".into(),
            root.path().to_str().unwrap(),
            Some(path),
            deadline,
            |binary, deadline| {
                assert_eq!(binary, binaries[0], "expired budget must not check tail");
                checked.borrow_mut().push(binary);
                async move {
                    tokio::time::sleep_until(deadline).await;
                    Ok(eligible)
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(result, None);
        assert_eq!(*checked.borrow(), [binaries[0].clone()]);
        assert!(!binaries[0].with_extension("args").exists());
    }
}
