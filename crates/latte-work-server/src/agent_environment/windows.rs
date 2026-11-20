use latte_work_platform::process::PreparedCommand;
use std::{collections::BTreeMap, ffi::OsString};

pub(super) async fn capture_default() -> anyhow::Result<BTreeMap<OsString, OsString>> {
    // Windows v1 inherits the Server environment. No PowerShell/Git Bash profiles
    // or duplicate case-sensitive PATH overlays; Command applies Windows semantics.
    Ok(BTreeMap::new())
}

/// Resolve package-manager entrypoints as structured native argv. Shell shims
/// themselves are never interpreted; their package's declared bin is authoritative.
pub(super) fn command_in(
    binary: &std::ffi::OsStr,
    paths: Option<&std::ffi::OsStr>,
    cwd: &std::path::Path,
) -> PreparedCommand {
    let path = std::path::Path::new(binary);
    let resolved = if path.is_absolute() && path.is_file() {
        Some(path.to_owned())
    } else {
        which::which_in(path, paths, cwd).ok()
    };
    let Some(resolved) = resolved else {
        return tokio::process::Command::new(binary).into();
    };
    let extension = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    if !["cmd", "bat", "ps1"]
        .iter()
        .any(|ext| extension.eq_ignore_ascii_case(ext))
    {
        return tokio::process::Command::new(resolved).into();
    }
    let Some(name) = resolved.file_stem().and_then(|name| name.to_str()) else {
        return tokio::process::Command::new(resolved).into();
    };
    let Some(directory) = resolved.parent() else {
        return tokio::process::Command::new(resolved).into();
    };
    if let Some(entrypoint) = package_entrypoint(directory, name) {
        if entrypoint
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return tokio::process::Command::new(entrypoint).into();
        }
        if entrypoint.extension().is_some_and(|ext| {
            ["js", "mjs", "cjs"]
                .iter()
                .any(|suffix| ext.eq_ignore_ascii_case(suffix))
        }) {
            let node = directory.join("node.exe");
            let node = if node.is_file() {
                Some(node)
            } else {
                which::which_in("node.exe", paths, cwd).ok()
            };
            if let Some(node) = node {
                let mut command = tokio::process::Command::new(node);
                command.arg(cli_path(&entrypoint));
                return command.into();
            }
        }
    }
    // Official TRAE CLI 2.0 aliases wrap the sibling native traex.exe.
    // https://trae.cn/trae-cli/install_v2.ps1
    if ["traex", "traecli", "trae-cli", "trae-agent", "ta", "coco"].contains(&name) {
        let native = directory.join("traex.exe");
        if native.is_file() {
            return tokio::process::Command::new(native).into();
        }
    }
    // Cursor's official Windows package ships PowerShell launchers as well as
    // optional native launchers. Let PowerShell execute its own script contract
    // via -File and separate argv; never compose a -Command/cmd shell expression.
    // https://cursor.com/install?win32=true
    let script = resolved.with_extension("ps1");
    if ["cursor-agent", "agent"].contains(&name)
        && script.is_file()
        && let Ok(pwsh) = which::which_in("pwsh.exe", paths, cwd)
        && let Ok(prepared) = powershell(pwsh, &script)
    {
        return prepared;
    }
    // ManagedChild reports unsupported when a shim has no native package entry.
    tokio::process::Command::new(resolved).into()
}

fn powershell(
    pwsh: std::path::PathBuf,
    target: &std::path::Path,
) -> std::io::Result<PreparedCommand> {
    use std::io::Write;
    let root = tempfile::Builder::new().prefix("latte-cli-").tempdir()?;
    let private = latte_work_platform::fs::PrivateDir::prepare(&root.path().join("launch"))?;
    let mut file = private.tempfile("bootstrap-", ".ps1")?;
    file.write_all(include_bytes!("bootstrap.ps1"))?;
    file.flush()?;
    let (file, path) = file.keep().map_err(|error| error.error)?;
    drop(file);
    let mut command = tokio::process::Command::new(pwsh);
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
        .arg(path)
        .arg(target);
    Ok(PreparedCommand::retaining(command, root))
}

/// Node's entrypoint loader rejects extended Win32 namespace spelling. Preserve
/// the resolved object while presenting the ordinary absolute DOS/UNC spelling.
fn cli_path(path: &std::path::Path) -> std::path::PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Prefix};
    let units: Vec<_> = path.as_os_str().encode_wide().collect();
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(_) => std::path::PathBuf::from(OsString::from_wide(&units[4..])),
            Prefix::VerbatimUNC(_, _) => {
                let ordinary: Vec<_> = [u16::from(b'\\'), u16::from(b'\\')]
                    .into_iter()
                    .chain(units[8..].iter().copied())
                    .collect();
                std::path::PathBuf::from(OsString::from_wide(&ordinary))
            }
            _ => path.to_owned(),
        },
        _ => path.to_owned(),
    }
}

fn package_entrypoint(directory: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    use std::io::Read;
    let modules = directory.join("node_modules");
    let mut packages = Vec::new();
    for entry in std::fs::read_dir(&modules).ok()?.take(256).flatten() {
        if entry.file_name().to_string_lossy().starts_with('@') {
            if let Ok(children) = std::fs::read_dir(entry.path()) {
                packages.extend(children.take(256).flatten().map(|child| child.path()));
            }
        } else {
            packages.push(entry.path());
        }
        if packages.len() > 512 {
            return None;
        }
    }
    let mut found = None;
    for package in packages {
        let Ok(file) = std::fs::File::open(package.join("package.json")) else {
            continue;
        };
        let mut bytes = Vec::new();
        if file.take(64 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 64 * 1024 {
            continue;
        }
        let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let bin = &manifest["bin"];
        let relative = if let Some(path) = bin.get(name).and_then(|value| value.as_str()) {
            Some(path)
        } else if manifest["name"]
            .as_str()
            .and_then(|id| id.rsplit('/').next())
            == Some(name)
        {
            bin.as_str()
        } else {
            None
        };
        let Some(relative) = relative else {
            continue;
        };
        let Ok(root) = package.canonicalize() else {
            continue;
        };
        let Ok(target) = package.join(relative).canonicalize() else {
            continue;
        };
        if !target.starts_with(root) || !target.is_file() {
            continue;
        }
        if found.is_some() {
            return None;
        } // Do not select an ambiguous package.
        found = Some(target);
    }
    found
}

#[cfg(test)]
fn command(binary: &std::ffi::OsStr) -> PreparedCommand {
    crate::agent_environment::command(binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configured_path_selects_child_executable_and_preserves_explicit_binding() {
        use latte_work_protocol::AgentEnvironment;
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("A");
        let second = root.path().join("B");
        for directory in [&first, &second] {
            std::fs::create_dir(directory).unwrap();
            std::fs::copy(
                std::env::current_exe().unwrap(),
                directory.join("codex.exe"),
            )
            .unwrap();
        }
        let record = root.path().join("executed.txt");
        let configured = AgentEnvironment(BTreeMap::from([(
            "pAtH".into(),
            second.to_string_lossy().into_owned(),
        )]));
        let relative = AgentEnvironment(BTreeMap::from([("PATH".into(), "B".into())]));
        let first_path = first.join("codex.exe");
        let mut baseline = command_in("codex".as_ref(), Some(first.as_os_str()), root.path());
        baseline.current_dir(root.path());
        let launches = [
            (baseline, first_path.clone()),
            (
                crate::agent_environment::configured_command(
                    "codex",
                    Some(root.path()),
                    &configured,
                ),
                second.join("codex.exe"),
            ),
            (
                crate::agent_environment::configured_command("codex", Some(root.path()), &relative),
                second.join("codex.exe"),
            ),
            (
                crate::agent_environment::configured_command(
                    &first_path,
                    Some(root.path()),
                    &configured,
                ),
                first_path,
            ),
        ];
        for (mut command, expected) in launches {
            command
                .args([
                    "--exact",
                    "agent_environment::backend::tests::configured_path_executable_fixture",
                    "--ignored",
                ])
                .env("LATTE_TEST_EXECUTABLE_RECORD", &record);
            let (status, output) = latte_work_platform::process::output(
                &mut command,
                std::time::Duration::from_secs(15),
                16 * 1024,
            )
            .await
            .unwrap();
            assert!(status.success(), "{}", String::from_utf8_lossy(&output));
            let actual = std::fs::read_to_string(&record).unwrap();
            assert_eq!(
                std::path::Path::new(&actual).canonicalize().unwrap(),
                expected.canonicalize().unwrap()
            );
            std::fs::remove_file(&record).unwrap();
        }
    }

    #[test]
    #[ignore = "native executable identity fixture launched by configured PATH regression"]
    fn configured_path_executable_fixture() {
        std::fs::write(
            std::env::var_os("LATTE_TEST_EXECUTABLE_RECORD").unwrap(),
            std::env::current_exe().unwrap().to_str().unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn npm_shim_launch_preserves_arguments_without_shell_evaluation() {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("node_modules/fixture-cli");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"fixture-cli","bin":{"fixture-cli":"cli.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("cli.js"),
            "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        )
        .unwrap();
        std::fs::write(
            root.path().join("fixture-cli.cmd"),
            "not executable shell code",
        )
        .unwrap();
        let args = [
            "a b",
            "引号与 Unicode",
            "quotes\" and trailing\\",
            "& echo injected",
            "%PATH%",
            "$()",
            "--leading-dash",
            "line\nnext",
        ];
        let mut child = command(root.path().join("fixture-cli.cmd").as_os_str());
        child.args(args);
        let (status, bytes) = latte_work_platform::process::output(
            &mut child,
            std::time::Duration::from_secs(5),
            4096,
        )
        .await
        .unwrap();
        assert!(status.success());
        assert_eq!(serde_json::from_slice::<Vec<String>>(&bytes).unwrap(), args);
    }

    #[tokio::test]
    async fn official_cursor_powershell_launcher_preserves_argv() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("agent.cmd"), "unused shell shim").unwrap();
        std::fs::write(
            root.path().join("agent.ps1"),
            "[Console]::Out.Write((ConvertTo-Json -InputObject @($args) -Compress))",
        )
        .unwrap();
        let args = [
            "a b",
            "引号 Unicode",
            "quotes\" and trailing\\",
            "& echo injected",
            "%PATH%",
            "$()",
            "--leading-dash",
            "line\nnext",
        ];
        let mut launch = command(root.path().join("agent.cmd").as_os_str());
        let bootstrap = std::path::PathBuf::from(launch.as_std().get_args().nth(4).unwrap());
        latte_work_platform::fs::verify_private_file(&std::fs::File::open(&bootstrap).unwrap())
            .unwrap();
        launch.args(args);
        let (status, output) = latte_work_platform::process::output(
            &mut launch,
            std::time::Duration::from_secs(5),
            4096,
        )
        .await
        .unwrap();
        assert!(status.success());
        assert!(
            !bootstrap.exists(),
            "confirmed child cleanup releases its private bootstrap"
        );
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&output).unwrap_or_else(|error| panic!(
                "{error}; output={:?}",
                String::from_utf8_lossy(&output)
            )),
            args
        );
    }

    #[tokio::test]
    async fn failed_spawn_releases_the_private_bootstrap_with_the_prepared_owner() {
        let root = tempfile::tempdir().unwrap();
        let mut launch = powershell(
            root.path().join("missing-pwsh.exe"),
            &root.path().join("agent.ps1"),
        )
        .unwrap();
        let bootstrap = std::path::PathBuf::from(launch.as_std().get_args().nth(4).unwrap());
        assert!(bootstrap.is_file());
        assert!(latte_work_platform::process::ManagedChild::spawn(&mut launch).is_err());
        assert!(
            bootstrap.exists(),
            "failed spawn leaves cleanup with its prepared owner"
        );
        drop(launch);
        assert!(!bootstrap.exists());
    }

    #[test]
    fn npm_manifest_entry_cannot_escape_its_package_or_choose_ambiguously() {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("node_modules/fixture-cli");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(root.path().join("outside.js"), "").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"bin":{"fixture":"../../outside.js"}}"#,
        )
        .unwrap();
        assert!(package_entrypoint(root.path(), "fixture").is_none());
        std::fs::write(package.join("cli.js"), "").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"bin":{"fixture":"cli.js"}}"#,
        )
        .unwrap();
        let other = root.path().join("node_modules/another-cli");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("cli.js"), "").unwrap();
        std::fs::write(
            other.join("package.json"),
            r#"{"bin":{"fixture":"cli.js"}}"#,
        )
        .unwrap();
        assert!(package_entrypoint(root.path(), "fixture").is_none());
    }
}
