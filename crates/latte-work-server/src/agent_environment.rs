//! Host-local environment snapshot shared by agent probes and launches.
//! Never mutate the daemon's environment or persist captured credentials.
use latte_work_platform::process::PreparedCommand;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    sync::OnceLock,
};
#[cfg(unix)]
use tokio::process::Command;

#[cfg(unix)]
#[path = "agent_environment/unix.rs"]
mod backend;
#[cfg(windows)]
#[path = "agent_environment/windows.rs"]
mod backend;

static ENVIRONMENT: OnceLock<BTreeMap<OsString, OsString>> = OnceLock::new();

pub async fn initialize() -> Option<String> {
    let result = if std::env::var("LATTE_WORK_AGENT_ENV").as_deref() == Ok("inherit") {
        Ok(BTreeMap::new())
    } else {
        backend::capture_default().await
    };
    match result {
        Ok(env) => {
            let _ = ENVIRONMENT.set(env);
            None
        }
        Err(error) => {
            let _ = ENVIRONMENT.set(BTreeMap::new());
            Some(format!(
                "Shell 环境加载失败（{error}），当前使用后台继承环境；修复 Shell 配置后重启后台。"
            ))
        }
    }
}

/// Resolve a native storage setting from the same environment used by the agent.
pub fn variable(name: impl AsRef<OsStr>) -> Option<OsString> {
    let name = name.as_ref();
    ENVIRONMENT
        .get()
        .and_then(|env| env.get(name).cloned())
        .or_else(|| std::env::var_os(name))
}

/// Preserve the execution host's exported HOME, falling back to its native profile.
pub fn home_dir() -> Option<std::path::PathBuf> {
    variable("HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| latte_work_platform::dirs::home_dir().ok())
}

/// Per-instance App overrides are applied after the host shell snapshot.
pub fn configured_variable(
    name: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Option<OsString> {
    environment
        .0
        .iter()
        .find(|(key, _)| {
            if cfg!(windows) {
                key.eq_ignore_ascii_case(name)
            } else {
                key.as_str() == name
            }
        })
        .map(|(_, value)| value)
        .map(OsString::from)
        .or_else(|| variable(name))
}

pub fn command(binary: impl AsRef<std::ffi::OsStr>) -> PreparedCommand {
    configured_command(
        binary,
        None,
        &latte_work_protocol::AgentEnvironment::default(),
    )
}

/// Bind Windows launchers using the same effective PATH and cwd the child gets.
/// Unix continues to let exec resolve its bare executable after env/cwd overlays.
pub fn configured_command(
    binary: impl AsRef<std::ffi::OsStr>,
    cwd: Option<&std::path::Path>,
    environment: &latte_work_protocol::AgentEnvironment,
) -> PreparedCommand {
    #[cfg(unix)]
    let mut cmd: PreparedCommand = Command::new(binary).into();
    #[cfg(windows)]
    let mut cmd = {
        let directory = cwd
            .map(std::path::Path::to_owned)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let paths = configured_variable("PATH", environment);
        backend::command_in(binary.as_ref(), paths.as_deref(), &directory)
    };
    if let Some(env) = ENVIRONMENT.get() {
        cmd.envs(env);
    }
    cmd.envs(&environment.0);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd
}
