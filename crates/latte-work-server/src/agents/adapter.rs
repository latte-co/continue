//! Internal contract for a persistent agent session over line-framed stdio.
//! Adapters own wire encoding and protocol order, never process supervision or storage.
use crate::providers::LaunchConfig;
use anyhow::Result;
use latte_work_protocol::EventKind;
use serde_json::Value;
use tokio::process::Command;

/// Physical process lifetime, independent of the durable Host session actor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TransportLifetime {
    #[default]
    Persistent,
    PerTurn,
}

pub struct AgentCommand {
    pub command: Command,
    /// Keep private launch files alive until the agent exits, including spawn errors.
    pub _settings: Option<tempfile::NamedTempFile>,
    pub sideband: Option<Sideband>,
}

pub struct Sideband {
    pub listener: tokio::net::UnixListener,
    pub _directory: tempfile::TempDir,
}

pub enum Input<'a> {
    /// Initialize for metadata only. Must never send a user prompt.
    DiscoverCommands,
    /// Open the bidirectional session without sending a user prompt.
    Open,
    RenameTitle {
        id: &'a str,
        title: &'a str,
    },
    /// Interrupt the active turn while retaining the session's process.
    Interrupt,
    /// Start a turn. The first turn initializes; later turns reuse the same transport.
    Start {
        prompt: &'a str,
    },
    /// Hand an input to the native agent while retaining the active turn.
    Queue {
        request_id: &'a str,
        prompt: &'a str,
    },
    /// One complete line without its delimiter. Only the adapter interprets its payload.
    Message(&'a str),
    Sideband(&'a str),
    /// Delivered only after Runtime validates a pending public approval ID.
    Approval {
        id: &'a str,
        input: Value,
        allow: bool,
    },
    QuestionAnswer {
        id: &'a str,
        input: Value,
        questions: Vec<latte_work_protocol::UserQuestion>,
        answers: Option<Vec<latte_work_protocol::QuestionAnswer>>,
    },
}

pub enum Action {
    /// A PerTurn adapter starts physical I/O only after durable admission and baseline.
    /// Runtime owns spawn, stderr, termination and confirmation of the owned group.
    SpawnTurn(AgentCommand),
    /// Authoritative native session name, including external manual renames.
    NativeName(String),
    /// Optional generated metadata; never supersedes an explicit user name.
    GeneratedTitle {
        native_session_id: String,
        title: String,
    },
    /// An isolated metadata request, supervised independently of the main turn.
    GenerateTitle {
        native_session_id: String,
        description: String,
        model: Option<String>,
        native_provider: Option<super::codex_title::NativeProvider>,
    },
    /// The native title-generation request was sent for this session's lifetime.
    TitleRequested,
    TitleRenamed(Result<String, String>),
    SourceUsed {
        id: String,
        name: String,
    },
    Commands(Vec<latte_work_protocol::AgentSlashCommand>),
    /// Already encoded bytes, including framing. Runtime only bounds and writes them.
    Write(Vec<u8>),
    /// Best-effort metadata control. Failure must not fail the completed task.
    MetadataWrite(Vec<u8>),
    SidebandWrite(Vec<u8>),
    /// Stop the startup deadline; this does not implicitly send any message.
    Ready,
    /// Native evidence that the main agent started an autonomous follow-up turn.
    TurnStarted,
    /// Native completion evidence for inputs consumed in this turn (possibly a batch).
    /// A delivered input does not necessarily start an independent native turn.
    InputsConsumed(Vec<String>),
    /// A native RPC definitively rejected an input; preserve the active turn.
    InputRejected {
        request_id: String,
        message: String,
    },
    Interrupted,
    Event(EventKind),
    /// Native child output; never changes the parent turn's text or execution state.
    SubagentEvent {
        tool_use_id: String,
        event: EventKind,
    },
    NativeSession(String),
    /// Copy title credential digests before adopting a verified side-chat fork.
    InheritSideChatTitleCredentials {
        source: String,
        target: String,
    },
    Approval {
        id: String,
        tool_use_id: Option<String>,
        tool: String,
        input: Value,
    },
    /// Authoritative native decision, or failure to submit a requested decision.
    ApprovalReply {
        id: String,
        result: Result<bool, String>,
    },
    Question {
        id: String,
        tool_use_id: Option<String>,
        input: Value,
        questions: Vec<latte_work_protocol::UserQuestion>,
    },
    /// Must follow explicit native completion evidence, never EOF or a successful exit.
    Finished {
        failed: bool,
        message: Option<String>,
    },
}

pub trait AgentAdapter: Send {
    fn transport_lifetime(&self) -> TransportLifetime {
        TransportLifetime::Persistent
    }
    /// Runtime invokes this only after confirming the physical process group is gone.
    /// PerTurn adapters retire active decoder state without losing native identity.
    fn transport_closed(&mut self) {}
    /// Only true between turns when replacing the process cannot discard live work.
    fn can_reconfigure(&self) -> bool;
    /// A new turn may reuse a process that still owns background work. This
    /// never authorizes replacing that process or changing its configuration.
    fn can_start_turn(&self) -> bool {
        self.can_reconfigure()
    }
    /// Actual native tasks that outlive the main turn; distinct from reconfiguration readiness.
    fn has_background_work(&self) -> bool;
    /// A pending interaction can belong to a child that outlives the main turn.
    fn is_child_interaction(&self, _id: &str) -> bool {
        false
    }
    fn awaits_approval_reply(&self, _id: &str) -> bool {
        false
    }
    /// Only children observed by this process share its credential redaction context.
    fn knows_subagent(&self, native_id: &str) -> bool;
    /// Native `SKILL.md` path reported by an open session's own skill catalog, if known.
    fn skill_path(&self, _name: &str) -> Option<String> {
        None
    }
    /// Optional blocking classification of discovered slash commands off the Tokio worker.
    fn finish_command_discovery(
        &mut self,
        commands: Vec<latte_work_protocol::AgentSlashCommand>,
    ) -> Vec<latte_work_protocol::AgentSlashCommand> {
        commands
    }
    /// Persisted manual name, including resumed sessions. Creation arguments
    /// must not implicitly rename an existing native session. `title_requested`
    /// records the durable once-per-session generation marker.
    fn set_session_title(&mut self, title: Option<String>, resuming: bool, title_requested: bool);
    /// Keep inherited history private to a distinct native side thread.
    fn set_side_parent(&mut self, _native_id: String) -> Result<()> {
        anyhow::bail!("此 Agent 不支持侧边聊天")
    }
    /// Prepare launch resources; may retain resume/config context for later protocol steps.
    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand>;
    /// Effective source-turn configuration for an isolated auxiliary request.
    /// Unknown native Provider/model/effort must not be guessed.
    fn prediction_snapshot(&self, _config: &LaunchConfig) -> Option<crate::predictions::Snapshot> {
        None
    }
    /// Optional native read bound for one stdio frame.
    fn frame_limit(&self) -> Option<usize> {
        None
    }
    fn metadata_ready(&self) -> bool {
        true
    }
    /// Optional native shutdown or detach request. Shutdown stays bounded.
    fn close_request(&self) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn close_ack(&self, _line: &str) -> bool {
        false
    }
    /// Require the native shutdown acknowledgement, drained stdout and the
    /// child's exit to confirm cleanup of work outside the process group.
    fn requires_close_drain(&self) -> bool {
        false
    }
    fn observe_close_output(&mut self, _line: &str) -> Result<()> {
        Ok(())
    }
    fn background_close_complete(&self) -> bool {
        true
    }
    /// Whether this adapter can cancel a pending prompt before startup completes.
    fn can_interrupt_startup(&self) -> bool {
        false
    }
    /// Return ordered, bounded actions in response to a host or protocol input.
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>>;
}
