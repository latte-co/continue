//! Carry deterministic CLI overrides through bridge-triggered daemon upgrades.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub fn prepare(directory: &Path, environment: &[(&str, &OsStr)], program: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bridge = directory.join("fixture-bridge");
    if bridge.exists() {
        return bridge;
    }
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let agents = [
        ("LATTE_WORK_CLAUDE", "claude.py"),
        ("LATTE_WORK_TRAEX", "traex.py"),
        ("LATTE_WORK_CODEX", "codex.py"),
        ("LATTE_WORK_OPENCODE", "opencode.py"),
        ("LATTE_WORK_CURSOR", "cursor.py"),
    ];
    let defaults = agents
        .into_iter()
        .map(|(name, file)| {
            (
                name.to_owned(),
                fixtures.join(file).to_string_lossy().into_owned(),
            )
        })
        .chain([
            ("LATTE_WORK_AGENT_ENV".into(), "inherit".into()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                directory
                    .join("claude-config")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);
    let settings: std::collections::BTreeMap<_, _> = defaults
        .chain(
            environment
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string_lossy().into_owned())),
        )
        .collect();
    let exports = settings
        .iter()
        .map(|(name, value)| {
            assert!(
                !name.is_empty()
                    && !name.as_bytes()[0].is_ascii_digit()
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            );
            format!("export {name}={}\n", quote(value))
        })
        .collect::<String>();
    std::fs::write(
        &bridge,
        format!(
            "#!/bin/sh\n{exports}exec {} \"$@\"\n",
            quote(program.to_str().unwrap())
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bridge, std::fs::Permissions::from_mode(0o700)).unwrap();
    bridge
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[test]
fn local_upgrade_bridge_keeps_fixture_environment_and_quotes_values() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("peer");
    std::fs::write(&program,
        "#!/bin/sh\nprintf '%s\\n' \"$LATTE_WORK_CURSOR\" \"$TEST_BRIDGE_VALUE\" \"$LATTE_WORK_AGENT_ENV\"\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let value = OsStr::new("quoted ' value\nnext line");
    let bridge = prepare(directory.path(), &[("TEST_BRIDGE_VALUE", value)], &program);
    let output = std::process::Command::new(&bridge)
        .arg("connect-local")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "{}/tests/fixtures/cursor.py\nquoted ' value\nnext line\ninherit\n",
            env!("CARGO_MANIFEST_DIR")
        )
    );
    assert_eq!(
        std::fs::metadata(&bridge).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(prepare(directory.path(), &[], &program), bridge);
}
