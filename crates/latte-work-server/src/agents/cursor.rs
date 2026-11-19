//! Cursor's print NDJSON transport. The Host owns per-turn spawn, drain and reap.
mod decoder;
mod metadata;
#[cfg(test)]
mod tests;

use super::{Action, AgentAdapter, AgentCommand, Input, TransportLifetime};
use crate::providers::LaunchConfig;
use anyhow::{Context, Result, bail};

pub(crate) use metadata::{discover, models, permission_modes, validate_selection};

const NATIVE_FRAME_LIMIT: usize = 1024 * 1024;
const PROMPT_ARG_LIMIT: usize = 128 * 1024;

pub(crate) fn validate_prompt(prompt: &str) -> Result<()> {
    // Reserve the terminating argv NUL; Linux's single-argument bound includes it.
    if prompt.len() >= PROMPT_ARG_LIMIT || prompt.contains('\0') {
        bail!("Cursor prompt 必须小于 128 KiB 且不能包含 NUL；消息未发送");
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Cursor {
    launch: Option<Launch>,
    decoder: decoder::Decoder,
}
struct Launch {
    binary: String,
    cwd: String,
    config: LaunchConfig,
}

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 512 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        bail!("Cursor native session ID 无效");
    }
    Ok(())
}
fn native_command(launch: &Launch, resume: Option<&str>, prompt: Option<&str>) -> AgentCommand {
    let mut command = crate::agent_environment::command(&launch.binary);
    command
        .current_dir(&launch.cwd)
        .envs(&launch.config.environment.0);
    if let Some(prompt) = prompt {
        command.args(["--print", "--output-format", "stream-json"]);
        if let Some(model) = &launch.config.model {
            command.args(["--model", model]);
        }
        if let Some(mode) = &launch.config.permission_mode {
            command.args(["--mode", mode]);
        }
        if let Some(id) = resume {
            command.args(["--resume", id]);
        }
        command.arg("--").arg(prompt);
    }
    AgentCommand {
        command,
        _settings: None,
        sideband: None,
    }
}

impl AgentAdapter for Cursor {
    fn frame_limit(&self) -> Option<usize> {
        Some(NATIVE_FRAME_LIMIT)
    }
    fn transport_lifetime(&self) -> TransportLifetime {
        TransportLifetime::PerTurn
    }
    fn transport_closed(&mut self) {
        self.decoder = decoder::Decoder::new(self.decoder.session().map(str::to_owned));
    }
    fn can_reconfigure(&self) -> bool {
        !self.decoder.active()
    }
    fn can_start_turn(&self) -> bool {
        !self.decoder.active()
    }
    fn has_background_work(&self) -> bool {
        false
    }
    fn knows_subagent(&self, _native_id: &str) -> bool {
        false
    }
    fn set_session_title(
        &mut self,
        _title: Option<String>,
        _resuming: bool,
        _title_requested: bool,
    ) {
    }
    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand> {
        if config.provider.is_some() {
            bail!("Cursor Agent 不支持 App Provider");
        }
        if config.effort.is_some() {
            bail!("Cursor Agent 不支持独立 effort");
        }
        if let Some(mode) = config.permission_mode.as_deref()
            && !matches!(mode, "ask" | "plan")
        {
            bail!("Cursor Agent 不支持所选权限模式");
        }
        if let Some(model) = config.model.as_deref()
            && (model.is_empty() || model.len() > 512 || model.chars().any(char::is_control))
        {
            bail!("Cursor model ID 无效");
        }
        if let Some(id) = resume {
            valid_id(id)?;
        }
        self.decoder = decoder::Decoder::new(resume.map(str::to_owned));
        let launch = Launch {
            binary: binary.into(),
            cwd: cwd.into(),
            config: config.clone(),
        };
        // Prepared only. Runtime must not spawn this command for a PerTurn Open.
        let prepared = native_command(&launch, resume, None);
        self.launch = Some(launch);
        Ok(prepared)
    }
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>> {
        match input {
            Input::Open => Ok(vec![]),
            Input::Start { prompt } => {
                validate_prompt(prompt)?;
                let launch = self.launch.as_ref().context("Cursor launch 尚未准备")?;
                self.decoder.start()?;
                Ok(vec![Action::SpawnTurn(native_command(
                    launch,
                    self.decoder.session(),
                    Some(prompt),
                ))])
            }
            Input::Message(line) => self.decoder.message(line),
            Input::Interrupt => bail!("Cursor 无原生 interrupt RPC；由 Host 停止本轮进程"),
            Input::Queue { .. } => bail!("Cursor Agent 不支持即时 steering"),
            Input::DiscoverCommands => bail!("Cursor Agent 不支持原生命令发现"),
            Input::RenameTitle { .. } => bail!("Cursor Agent 不支持原生标题修改"),
            Input::Approval { .. } => bail!("Cursor Agent 不支持机器审批"),
            Input::QuestionAnswer { .. } => bail!("Cursor Agent 不支持机器问题回答"),
            Input::Sideband(_) => bail!("Cursor Agent 不支持辅助通道"),
        }
    }
}
