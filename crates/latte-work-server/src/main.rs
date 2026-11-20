//! A single host daemon; `connect` is a disposable local/SSH byte bridge.
mod admission;
mod agent_environment;
mod agents;
mod attachments;
mod files;
mod git_review;
mod image_preview;
mod message_queue;
mod predictions;
mod providers;
mod questions;
mod redaction;
mod runtime;
mod skill_staging;
mod skill_worker;
mod skills;
mod snapshot_migration;
mod snapshot_storage;
mod sources;
mod store;
mod task_changes;
mod terminal;
mod upgrade;
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{AgentInfo, MAX_FRAME, Request, Response, VERSION};
use runtime::{Control, Database, Runs, db};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::unix::fs::{FileTypeExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::{UnixListener, UnixStream},
    sync::oneshot,
};
use tokio_util::codec::{FramedRead, LinesCodec};

#[derive(Clone)]
struct Service {
    attachments: Arc<Mutex<attachments::Attachments>>,
    skills: Arc<skills::Skills>,
    skill_worker: skill_worker::Worker,
    lifecycle: Arc<upgrade::Lifecycle>,
    terminals: terminal::SharedTerminals,
    database: Database,
    runs: Runs,
    title_refresh: Arc<Mutex<runtime::TitleRefreshCache>>,
    command_probes: Arc<tokio::sync::Semaphore>,
    file_admission: Arc<tokio::sync::RwLock<()>>,
    agents: Vec<(String, AgentInfo)>,
    server_id: String,
    providers: Arc<Mutex<providers::ProviderStore>>,
}
impl Service {
    async fn resolve_native_model(
        &self,
        agent: &str,
        path: &str,
        config: &mut providers::LaunchConfig,
    ) -> Result<()> {
        if !agents::has_native_models(agent) || config.provider.is_some() {
            return Ok(());
        }
        // OpenCode validates its selection in the same ACP session that will
        // run the prompt, before writing session/prompt. No second launch.
        if agent == "opencode" {
            return Ok(());
        }
        let _permit = self
            .command_probes
            .try_acquire()
            .context("模型能力正在加载，请稍后重试")?;
        if agent == "codex" {
            agents::codex::validate_selection(
                self.agent_binary(agent)?,
                Some(path),
                config.model.as_deref(),
                config.effort,
                &config.environment,
            )
            .await?;
            return Ok(());
        }
        if agent == "cursor" {
            agents::cursor::validate_selection(
                self.agent_binary(agent)?,
                Some(path),
                config.model.as_deref(),
                config.effort,
                &config.environment,
            )
            .await?;
            return Ok(());
        }
        config.traex_model = agents::traex::validate_selection(
            self.agent_binary(agent)?,
            Some(path),
            config.model.as_deref(),
            config.effort,
            &config.environment,
        )
        .await?;
        Ok(())
    }
    fn agent_entry(&self, id: &str) -> Result<&(String, AgentInfo)> {
        self.agents
            .iter()
            .find(|(_, info)| info.id == id)
            .context("此 Agent 尚未实现")
    }
    fn agent_binary(&self, id: &str) -> Result<&str> {
        let (binary, info) = self.agent_entry(id)?;
        if !info.available {
            bail!(
                "{} CLI 不可用；请在此 Host 安装并登录后重启 Server",
                info.name
            );
        }
        Ok(binary)
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = entry().await {
        eprintln!("latte-work-server: {error:#}");
        std::process::exit(1);
    }
}
async fn entry() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" {
        println!(
            "latte-work-server 0.1.0\nUsage: latte-work-server <serve|connect|connect-local> [--state-dir PATH]\nOne daemon per host user; connect starts it if absent.\nLATTE_WORK_CLAUDE / LATTE_WORK_TRAEX / LATTE_WORK_CODEX: CLI path overrides (default auto-detected claude / traex / codex)."
        );
        return Ok(());
    }
    let dir = if args.len() == 3 && args[1] == "--state-dir" {
        PathBuf::from(&args[2])
    } else if args.len() == 1 {
        PathBuf::from(std::env::var_os("HOME").context("HOME missing")?)
            .join(".local/share/latte-work")
    } else {
        bail!("无效参数；使用 --help 查看用法");
    };
    let dir = prepare_dir(&dir)?;
    match args[0].as_str() {
        "serve" => serve(&dir).await,
        "connect" => bridge(&dir).await,
        "connect-local" => match upgrade::connect_local(&dir).await {
            Ok(stream) => forward(stream).await,
            Err(error) => {
                let response = Response::Error {
                    code: "local_upgrade_required".into(),
                    message: error.to_string(),
                };
                let mut bytes = serde_json::to_vec(&response)?;
                bytes.push(b'\n');
                tokio::io::stdout().write_all(&bytes).await?;
                Ok(())
            }
        },
        _ => bail!("未知命令"),
    }
}
fn prepare_dir(dir: &Path) -> Result<PathBuf> {
    if dir.exists() && dir.symlink_metadata()?.file_type().is_symlink() {
        bail!("状态目录不能是符号链接");
    }
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(dir.canonicalize()?)
}
fn lock(dir: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("server.lock"))?;
    file.try_lock().context("此 Host 的 Server 已运行")?;
    Ok(file)
}
async fn bridge(dir: &Path) -> Result<()> {
    forward(connect_socket(dir).await?).await
}
async fn connect_socket(dir: &Path) -> Result<UnixStream> {
    let socket = dir.join("control.sock");
    let stream = match UnixStream::connect(&socket).await {
        Ok(s) => s,
        Err(_) => {
            let mut command = std::process::Command::new(std::env::current_exe()?);
            use std::os::unix::process::CommandExt;
            command
                .arg("serve")
                .arg("--state-dir")
                .arg(dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            let mut daemon = command.spawn().context("无法启动 Host Server")?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                if let Ok(s) = UnixStream::connect(&socket).await {
                    break s;
                }
                if tokio::time::Instant::now() > deadline {
                    bail!("无法连接 Server；请运行 latte-work-server serve 查看诊断");
                }
                // A concurrent bridge may win the singleton lock; still wait for its socket.
                let _ = daemon.try_wait();
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    Ok(stream)
}
async fn forward(stream: UnixStream) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    tokio::select! {result=tokio::io::copy(&mut input,&mut writer)=>{result?;},result=tokio::io::copy(&mut reader,&mut output)=>{result?;}}
    Ok(())
}
async fn serve(dir: &Path) -> Result<()> {
    let _lock = lock(dir)?;
    let socket = dir.join("control.sock");
    if let Ok(metadata) = socket.symlink_metadata() {
        if !metadata.file_type().is_socket() {
            bail!("control.sock 被非 socket 文件占用");
        }
        std::fs::remove_file(&socket)?;
    }
    let database = Arc::new(Mutex::new(store::Store::open(&dir.join("state.sqlite"))?));
    let environment_warning = agent_environment::initialize().await;
    let mut agents = agents::discover().await;
    if let Some(warning) = environment_warning {
        for (_, agent) in &mut agents {
            agent.detail = format!("{} · {warning}", agent.detail);
        }
    }
    let service = Service {
        skills: Arc::new(skills::Skills::new(dir)?),
        skill_worker: skill_worker::Worker::new(),
        attachments: Arc::new(Mutex::new(attachments::Attachments::new(dir)?)),
        lifecycle: Arc::new(upgrade::Lifecycle::new()?),
        terminals: Arc::new(Mutex::new(terminal::Terminals::default())),
        providers: Arc::new(Mutex::new(providers::ProviderStore::open(dir)?)),
        database,
        runs: Arc::new(Mutex::new(HashMap::new())),
        title_refresh: Arc::new(Mutex::new(runtime::TitleRefreshCache::default())),
        command_probes: Arc::new(tokio::sync::Semaphore::new(2)),
        file_admission: Arc::new(tokio::sync::RwLock::new(())),
        agents,
        server_id: uuid::Uuid::new_v4().to_string(),
    };
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    eprintln!(
        "Latte Work server {} listening at {}",
        service.server_id,
        socket.display()
    );
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            result=listener.accept()=>{let (stream,_)=result?;let service=service.clone();tokio::spawn(async move {if let Err(e)=connection(stream,service).await {eprintln!("client disconnected: {e}");}});},
            _=tokio::signal::ctrl_c()=>break,
        _=terminate.recv()=>break,
        _=service.lifecycle.shutdown.notified()=>break,
        }
    }
    drain_service(&service).await?;
    std::fs::remove_file(socket)?;
    Ok(())
}
async fn drain_service(service: &Service) -> Result<()> {
    let jobs = agents::codex_jobs::registry();
    jobs.begin_drain();
    *service.lifecycle.draining.write().await = true;
    match service.terminals.lock() {
        Ok(mut terminals) => terminals.close_all(),
        Err(error) => eprintln!("Terminal shutdown remains unconfirmed: {error}"),
    }
    let controls: Vec<_> = match service.runs.lock() {
        Ok(runs) => runs.values().map(|run| run.control.clone()).collect(),
        Err(error) => {
            eprintln!("Agent shutdown inventory unavailable: {error}");
            Vec::new()
        }
    };
    let mut closing: futures_util::stream::FuturesUnordered<_> = controls
        .into_iter()
        .map(|control| async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let (reply, receive) = oneshot::channel();
                control
                    .send(Control::Cancel {
                        reply: Some(reply),
                        only_if_idle: false,
                    })
                    .await?;
                receive.await?.map_err(anyhow::Error::msg)
            })
            .await
            .context("停止时 Agent 关闭结果待确认")?
        })
        .collect();
    while let Some(result) = closing.next().await {
        if let Err(error) = result {
            eprintln!("Agent shutdown remains unconfirmed: {error}");
        }
    }
    // An observation deadline cannot destroy a resource owner. Keep the runtime
    // alive until direct children are reaped; forced OS termination is best effort.
    while !jobs.wait_drained(Duration::from_secs(5)).await {
        eprintln!("Codex auxiliary cleanup remains unconfirmed; continuing drain");
    }
    Ok(())
}
async fn connection(stream: UnixStream, service: Service) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME));
    let mut ready = false;
    let mut claims = upgrade::ConnectionClaims::default();
    while let Some(line) = lines.next().await {
        let line = line?;
        if let Ok(request) = serde_json::from_str::<upgrade::Request>(&line) {
            let response = upgrade::handle(&service, request, &mut claims).await;
            let mut bytes = serde_json::to_vec(&response)?;
            bytes.push(b'\n');
            let written =
                tokio::time::timeout(Duration::from_secs(15), writer.write_all(&bytes)).await;
            if matches!(response, upgrade::Response::UpgradeReady) {
                service.lifecycle.shutdown.notify_one();
            }
            written??;
            continue;
        }
        // Own decoded Send continuations before any lifecycle/file gate can suspend them.
        // This covers received attempts, not future requests or unread transport bytes.
        let decoded = serde_json::from_str::<Request>(&line);
        let admission = match &decoded {
            Ok(request) if ready => reserve_send(&service.database, request),
            _ => Ok(None),
        };
        // Hold admission through dispatch so a Send/CreateTerminal cannot race an idle check.
        let draining = service.lifecycle.draining.read().await;
        let response = if *draining {
            Response::Error {
                code: "server_upgrading".into(),
                message: "本机后台正在更新，请重新连接；任务不会自动重发".into(),
            }
        } else {
            match decoded {
                Ok(Request::Hello { version }) => {
                    if version == VERSION {
                        ready = true;
                        Response::Hello {
                            version: VERSION,
                            server_id: service.server_id.clone(),
                            agents: service
                                .agents
                                .iter()
                                .map(|(_, agent)| agent.clone())
                                .collect(),
                            composer_predictions: true,
                            permission_settings: true,
                            custom_agent_environment: true,
                            history_window: true,
                            skill_management: true,
                            skill_file_import: true,
                            change_preview: true,
                            side_chat_controls: true,
                            claude_side_chat: true,
                        }
                    } else {
                        Response::Error {
                            code: "version_mismatch".into(),
                            message: format!("Server 协议为 {VERSION}，客户端为 {version}"),
                        }
                    }
                }
                Ok(request) if ready => {
                    let result = match admission {
                        Ok(admission) => {
                            dispatch_reserved(&service, request, &mut claims, admission).await
                        }
                        Err(error) => Err(error),
                    };
                    match result {
                        Ok(response) => response,
                        Err(error) => Response::Error {
                            code: if error.is::<runtime::SendNotAdmitted>() {
                                "send_not_admitted"
                            } else if error.is::<runtime::AdmissionUnknown>() {
                                "admission_unknown"
                            } else if error.is::<files::NotGitRepository>() {
                                "not_git_repository"
                            } else {
                                "request_failed"
                            }
                            .into(),
                            message: error.to_string(),
                        },
                    }
                }
                Ok(_) => Response::Error {
                    code: "handshake_required".into(),
                    message: "请先发送 hello".into(),
                },
                Err(error) => Response::Error {
                    code: "invalid_request".into(),
                    message: error.to_string(),
                },
            }
        };
        let mut bytes = serde_json::to_vec(&response)?;
        if bytes.len() > MAX_FRAME {
            bytes = serde_json::to_vec(&Response::Error {
                code: "response_too_large".into(),
                message: "响应超出限制".into(),
            })?;
        }
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(15), writer.write_all(&bytes)).await??;
    }
    Ok(())
}
fn reserve_send(database: &Database, request: &Request) -> Result<Option<admission::Guard>> {
    match request {
        Request::Send { request_id, .. } | Request::SendQueued { request_id, .. } => {
            admission::Guard::reserve(database, request_id).map(Some)
        }
        _ => Ok(None),
    }
}
#[cfg(test)]
async fn dispatch(
    s: &Service,
    request: Request,
    claims: &mut upgrade::ConnectionClaims,
) -> Result<Response> {
    let admission = reserve_send(&s.database, &request)?;
    dispatch_reserved(s, request, claims, admission).await
}
async fn dispatch_reserved(
    s: &Service,
    request: Request,
    claims: &mut upgrade::ConnectionClaims,
    admission: Option<admission::Guard>,
) -> Result<Response> {
    let allow_queue = matches!(&request, Request::SendQueued { .. });
    let request = match request {
        Request::SendQueued {
            provider,
            session_id,
            request_id,
            text,
            model,
            effort,
            permission_mode,
        } => Request::Send {
            provider,
            session_id,
            request_id,
            text,
            model,
            effort,
            permission_mode,
        },
        other => other,
    };
    // Capture before waiting on admission or the actor. Cleanup must never erase
    // a later ClaimResources/AdoptResources, including one from the same App.
    let closing_resource = match &request {
        Request::CloseAgentSession { session_id, .. }
        | Request::ConfirmSideWritesEnded { session_id, .. }
        | Request::ConfirmAgentClosed { session_id, .. }
        | Request::ArchiveSession {
            session_id,
            archived: true,
        } => Some(upgrade::Resource::AgentSession(session_id.clone())),
        Request::CloseTerminal { terminal_id } => {
            Some(upgrade::Resource::Terminal(terminal_id.clone()))
        }
        _ => None,
    };
    let closing_claim = closing_resource
        .as_ref()
        .map(|resource| s.lifecycle.claim_version(resource))
        .transpose()?
        .flatten();
    // Undo, archive, and write confirmation hold exclusive admission through their durable result.
    // Archive must not race a new open/send between closing and saving metadata.
    // Ordinary turns retain concurrent admission; no request is replayed.
    let exclusive = matches!(
        &request,
        Request::UndoTurnChanges { .. }
            | Request::ConfirmSideWritesEnded { .. }
            | Request::ConfirmAgentClosed { .. }
            | Request::CloseTerminal { .. }
            | Request::ArchiveSession { archived: true, .. }
            | Request::RenameSession { .. }
    );
    let _exclusive_guard = if exclusive {
        Some(s.file_admission.write().await)
    } else {
        None
    };
    let _write_guard = if matches!(
        &request,
        Request::Send { .. }
            | Request::OpenAgentSession { .. }
            | Request::CloseAgentSession { .. }
            | Request::CreateTerminal { .. }
            | Request::WriteTerminal { .. }
            | Request::Approve { .. }
            | Request::AnswerQuestion { .. }
            | Request::ResumeMessageQueue { .. }
            | Request::DispatchQueuedMessage { .. }
    ) {
        Some(s.file_admission.read().await)
    } else {
        None
    };
    let closed_resource = match &request {
        Request::CloseAgentSession { session_id, .. }
        | Request::ConfirmAgentClosed { session_id, .. }
        | Request::ArchiveSession {
            session_id,
            archived: true,
        } => Some(upgrade::Resource::AgentSession(session_id.clone())),
        Request::CloseTerminal { terminal_id } => {
            Some(upgrade::Resource::Terminal(terminal_id.clone()))
        }
        _ => None,
    };
    let admitted_resource = match &request {
        Request::OpenAgentSession { session_id, .. }
        | Request::Send { session_id, .. }
        | Request::DispatchQueuedMessage { session_id, .. }
        | Request::ResumeMessageQueue { session_id, .. } => {
            Some(upgrade::Resource::AgentSession(session_id.clone()))
        }
        Request::CreateTerminal { terminal_id, .. } => {
            Some(upgrade::Resource::Terminal(terminal_id.clone()))
        }
        _ => None,
    };
    let admitted_claim = admitted_resource
        .as_ref()
        .map(|resource| s.lifecycle.admit_claim(resource, claims))
        .transpose()?
        .flatten();
    let result = dispatch_admitted(
        s,
        request,
        claims,
        allow_queue,
        admission,
        closed_resource,
        closing_claim,
    )
    .await;
    if let Some(resource) = admitted_resource {
        s.lifecycle.finish_admission(&resource, admitted_claim)?;
    }
    result
}

async fn dispatch_admitted(
    s: &Service,
    request: Request,
    claims: &mut upgrade::ConnectionClaims,
    allow_queue: bool,
    admission: Option<admission::Guard>,
    mut closed_resource: Option<upgrade::Resource>,
    closing_claim: Option<uuid::Uuid>,
) -> Result<Response> {
    let mut response = match request {
        Request::Hello { .. } => unreachable!(),
        Request::ComposerPrediction { session_id } => {
            let (session, is_side) = db(&s.database, |store| {
                Ok((
                    store.session(&session_id)?,
                    store.side_parent(&session_id)?.is_some(),
                ))
            })?;
            predictions::query(&session, is_side)?
        }
        Request::Providers => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .list(),
        Request::AgentPermissions { agent } => {
            let binary = s.agent_binary(&agent)?;
            let _permit = s
                .command_probes
                .try_acquire()
                .context("权限选项正在加载，请稍后重试")?;
            Response::AgentPermissions {
                modes: agents::permission_modes(&agent, binary).await?,
            }
        }
        Request::AgentCommands {
            agent,
            project_id,
            provider,
        } => {
            let binary = s.agent_binary(&agent)?;
            let project = db(&s.database, |d| d.project(&project_id))?;
            let _permit = s
                .command_probes
                .try_acquire()
                .context("命令列表正在加载，请稍后重试")?;
            let config = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                .turn_config(&agent, None, provider)?;
            Response::AgentCommands {
                commands: runtime::commands(binary, &agent, &project.path, &config).await?,
            }
        }
        Request::Models {
            agent,
            model,
            project_id,
        } => {
            let project = project_id
                .map(|id| db(&s.database, |d| d.project(&id)))
                .transpose()?;
            let mut response = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                .models(&agent, model.as_deref())?;
            if agents::has_native_models(&agent)
                && matches!(&response, Response::Models { provider: None, .. })
            {
                let binary = s.agent_binary(&agent)?;
                let _permit = s
                    .command_probes
                    .try_acquire()
                    .context("模型列表正在加载，请稍后重试")?;
                response = agents::native_models(
                    &agent,
                    binary,
                    project.as_ref().map(|p| p.path.as_str()),
                    model.as_deref(),
                    &Default::default(),
                )
                .await?;
            }
            if !agents::has_native_models(&agent)
                && let Response::Models {
                    provider: None,
                    model_labels,
                    ..
                } = &mut response
            {
                *model_labels = agents::model_labels(
                    &agent,
                    project.as_ref().map(|p| std::path::Path::new(&p.path)),
                    &Default::default(),
                );
            }
            response
        }
        Request::SaveProvider { provider } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .save(provider)?,
        Request::DeleteProvider { id } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .delete(&id)?,
        Request::BindAgentProvider {
            agent,
            provider_id,
            target,
        } => {
            if let Some(target) = target {
                let snapshot = provider_id
                    .as_deref()
                    .map(|id| {
                        s.providers
                            .lock()
                            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                            .snapshot(&agent, id)
                    })
                    .transpose()?;
                let mut client =
                    latte_work_client::Client::ssh(&target.ssh, &target.server_path).await?;
                let response = client
                    .request(Request::SyncAgentProvider { agent, snapshot })
                    .await?;
                match response {
                    Response::Providers { .. } => response,
                    Response::Error { message, .. } => bail!("远程同步失败：{message}"),
                    _ => bail!("远程 Provider 响应格式不匹配"),
                }
            } else {
                s.providers
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                    .bind(&agent, provider_id)?
            }
        }
        Request::ProvidersForHost { host_id } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .list_for_host(&host_id)?,
        Request::BindHostAgentProvider {
            host_id,
            agent,
            provider_id,
        } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .bind_host(&host_id, &agent, provider_id)?,
        Request::ForgetHostProviders { host_id } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .forget_host(&host_id)?,
        Request::ExportHostAgentProvider { host_id, agent } => {
            let store = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?;
            Response::ProviderSnapshot {
                snapshot: store.snapshot_for_host(&host_id, &agent)?,
                configured: store.host_configured(&host_id),
            }
        }
        Request::ModelsForProvider {
            agent,
            model,
            project_id,
            provider,
            environment,
        } => {
            latte_work_config::validate_agent_environment(&environment)?;
            let project = project_id
                .map(|id| db(&s.database, |d| d.project(&id)))
                .transpose()?;
            let mut response =
                providers::ProviderStore::models_for_provider(&agent, model.as_deref(), provider)?;
            if agents::has_native_models(&agent)
                && matches!(&response, Response::Models { provider: None, .. })
            {
                let binary = s.agent_binary(&agent)?;
                let _permit = s
                    .command_probes
                    .try_acquire()
                    .context("模型列表正在加载，请稍后重试")?;
                response = agents::native_models(
                    &agent,
                    binary,
                    project.as_ref().map(|p| p.path.as_str()),
                    model.as_deref(),
                    &environment,
                )
                .await?;
            }
            if !agents::has_native_models(&agent)
                && let Response::Models {
                    provider: None,
                    model_labels,
                    ..
                } = &mut response
            {
                *model_labels = agents::model_labels(
                    &agent,
                    project.as_ref().map(|p| std::path::Path::new(&p.path)),
                    &environment,
                );
            }
            response
        }
        Request::Session { session_id } => Response::Session {
            session: db(&s.database, |d| d.session(&session_id))?,
        },
        Request::SyncAgentProvider { agent, snapshot } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .sync(&agent, snapshot)?,
        Request::WriteTerminal { terminal_id, data } => {
            terminal::write(&s.terminals, &terminal_id, data).await?
        }
        Request::CreateTerminal {
            project_id,
            terminal_id,
            cols,
            rows,
        } => {
            let project = db(&s.database, |d| d.project(&project_id))?;
            let terminals = s.terminals.clone();
            tokio::task::spawn_blocking(move || {
                terminals
                    .lock()
                    .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                    .create(
                        project_id,
                        Path::new(&project.path),
                        terminal_id,
                        cols,
                        rows,
                    )
            })
            .await??
        }
        Request::Terminals { project_id } => {
            db(&s.database, |d| d.project(&project_id))?;
            s.terminals
                .lock()
                .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                .list(&project_id)?
        }
        Request::ReadTerminal { terminal_id, after } => s
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("终端锁异常"))?
            .read(&terminal_id, after)?,
        Request::ResizeTerminal {
            terminal_id,
            cols,
            rows,
        } => s
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("终端锁异常"))?
            .resize(&terminal_id, cols, rows)?,
        Request::CloseTerminal { terminal_id } => s
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("终端锁异常"))?
            .close(&terminal_id),
        Request::Projects => Response::Projects {
            projects: db(&s.database, |d| d.projects())?,
        },
        Request::AddProject { path, name } => Response::Project {
            project: db(&s.database, |d| {
                d.add_named_project(Path::new(&path), name.as_deref())
            })?,
        },
        Request::RenameProject { project_id, name } => Response::Project {
            project: db(&s.database, |d| d.rename_project(&project_id, &name))?,
        },
        Request::RemoveProject { project_id } => {
            db(&s.database, |d| d.remove_project(&project_id))?;
            Response::Projects {
                projects: db(&s.database, |d| d.projects())?,
            }
        }
        Request::BrowseDirectories { path } => {
            tokio::task::spawn_blocking(move || files::browse_directories(path.as_deref()))
                .await??
        }
        Request::Sessions { project_id } => Response::Sessions {
            sessions: db(&s.database, |d| d.sessions(&project_id))?,
        },
        Request::PinnedSessions => Response::Sessions {
            sessions: db(&s.database, |d| d.pinned_sessions())?,
        },
        Request::RecentSessions { before } => {
            let (sessions, next) = db(&s.database, |d| d.recent_sessions(before.as_ref()))?;
            Response::RecentSessions { sessions, next }
        }
        Request::RenameSession {
            session_id,
            title,
            provider,
        } => {
            let session = db(&s.database, |d| d.session(&session_id))?;
            let project = db(&s.database, |d| d.project(&session.project_id))?;
            // Omitted snapshots never consult a newly selected host Provider.
            let config = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                .turn_config(
                    &session.agent,
                    None,
                    Some(provider.unwrap_or(latte_work_protocol::TurnProvider::Cli)),
                )?;
            let open_code_binary = (session.agent == "opencode" && session.native_id.is_some())
                .then(|| s.agent_binary("opencode").map(str::to_owned))
                .transpose()?;
            Response::Session {
                session: runtime::rename_title(
                    &s.database,
                    &s.runs,
                    session,
                    project.path,
                    title,
                    config,
                    open_code_binary,
                )
                .await?,
            }
        }
        Request::PinSession { session_id, pinned } => Response::Session {
            session: db(&s.database, |d| d.pin_session(&session_id, pinned))?,
        },
        Request::MarkSessionUnread { session_id, unread } => Response::Session {
            session: db(&s.database, |d| d.mark_session_unread(&session_id, unread))?,
        },
        Request::ArchiveSession {
            session_id,
            archived,
        } => {
            let children = if archived {
                db(&s.database, |d| d.side_chat_ids(&session_id))?
                    .into_iter()
                    .map(|id| {
                        let resource = upgrade::Resource::AgentSession(id);
                        let version = s.lifecycle.claim_version(&resource)?;
                        Ok((resource, version))
                    })
                    .collect::<Result<Vec<_>>>()?
            } else {
                Vec::new()
            };
            let session = runtime::archive(&s.database, &s.runs, &session_id, archived).await?;
            // Archive holds exclusive execution admission. Retire only the
            // child claims captured before closing, preserving concurrent claims.
            for (resource, version) in children {
                s.lifecycle.forget_claim(&resource, version, claims)?;
            }
            Response::Session { session }
        }
        Request::OpenSideChat {
            session_id,
            side_id,
        } => Response::Session {
            session: db(&s.database, |d| {
                d.open_side_chat(&session_id, side_id.as_deref())
            })?,
        },
        Request::SideChats { session_id } => Response::Sessions {
            sessions: db(&s.database, |d| {
                Ok(d.side_chat_history(&session_id, None)?.0)
            })?,
        },
        Request::SideChatHistory { session_id, before } => {
            let (sessions, next) = db(&s.database, |d| {
                d.side_chat_history(&session_id, before.as_deref())
            })?;
            Response::SideChatHistory { sessions, next }
        }
        Request::ProjectAgentSessions { project_id, after } => {
            runtime::project_agent_sessions(&s.database, &s.runs, &project_id, after.as_deref())?
        }
        Request::CreateSession { project_id, agent } => {
            s.agent_binary(&agent)?;
            Response::Session {
                session: db(&s.database, |d| d.create_session(project_id, agent))?,
            }
        }
        Request::OpenAgentSession {
            session_id,
            provider,
        } => {
            let (session, path) = db(&s.database, |d| {
                let session = d.session(&session_id)?;
                let path = d.project(&session.project_id)?.path;
                Ok((session, path))
            })?;
            let binary = s.agent_binary(&session.agent)?;
            if session.archived {
                bail!("请先取消归档再打开 Agent 会话");
            }
            let mut config = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                .open_config(&session.agent, session.model.as_deref(), provider)?;
            config.effort = session.effort.filter(|level| {
                (agents::has_native_models(&session.agent) && config.provider.is_none())
                    || agents::effort_levels(&session.agent, config.model.as_deref())
                        .contains(level)
            });
            config.permission_mode = session.permission_mode.clone();
            if session.agent == "cursor" {
                // Open preserves historical model/native ID even after catalog removal.
                // Send still validates current membership before accepting a new turn.
                agents::cursor::validate_selection(
                    binary,
                    Some(&path),
                    None,
                    config.effort,
                    &config.environment,
                )
                .await?;
            } else {
                s.resolve_native_model(&session.agent, &path, &mut config)
                    .await?;
            }
            runtime::open(
                s.database.clone(),
                s.runs.clone(),
                binary.to_owned(),
                session,
                path,
                config,
            )
            .await?;
            Response::Ok
        }
        Request::ConfirmSideWritesEnded {
            session_id,
            request_id,
        } => {
            let needs_confirmation = db(&s.database, |d| {
                d.check_side_write_confirmation(&session_id, &request_id)
            })?;
            let actor_closed = needs_confirmation
                && runtime::close(&s.database, &s.runs, &session_id, true).await?;
            let mut session = db(&s.database, |d| {
                d.confirm_side_writes_ended(&session_id, &request_id)
            })?;
            if actor_closed {
                closed_resource = Some(upgrade::Resource::AgentSession(session_id));
            }
            session.agent_closed_by_confirmation = Some(actor_closed);
            Response::Session { session }
        }
        Request::ConfirmAgentClosed {
            session_id,
            close_id,
        } => {
            if s.runs
                .lock()
                .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
                .contains_key(&session_id)
            {
                bail!("原生会话仍由 Server 管理，请先关闭后再确认");
            }
            Response::Session {
                session: db(&s.database, |d| {
                    d.confirm_agent_closed(&session_id, &close_id)
                })?,
            }
        }
        Request::CloseAgentSession {
            session_id,
            only_if_idle,
        } => {
            runtime::close(
                &s.database,
                &s.runs,
                &session_id,
                only_if_idle.unwrap_or(false),
            )
            .await?;
            if db(&s.database, |d| d.pending_side_write(&session_id))?.is_some() {
                Response::SideChatClosed
            } else {
                Response::Ok
            }
        }
        Request::SendQueued { .. } => unreachable!(),
        Request::Send {
            provider,
            session_id,
            request_id,
            text,
            model,
            effort,
            permission_mode,
        } => {
            let admission = admission.context("消息准入所有权缺失，请使用原请求 ID 核对")?;
            if !admission.matches(&s.database, &request_id) {
                bail!("消息准入所有权不匹配，请使用原请求 ID 核对");
            }
            if allow_queue && db(&s.database, |d| Ok(d.side_parent(&session_id)?.is_some()))? {
                return Err(runtime::reject_send(
                    &admission,
                    &request_id,
                    "侧边聊天暂不支持消息排队".into(),
                ));
            }
            if allow_queue && provider.is_none() {
                return Err(runtime::reject_send(
                    &admission,
                    &request_id,
                    "消息排队需要明确的执行配置，请更新客户端".into(),
                ));
            }
            let fingerprint = providers::turn_fingerprint(provider.as_ref())?;
            if !allow_queue
                && db(&s.database, |d| {
                    d.already_accepted(
                        &session_id,
                        &request_id,
                        &text,
                        model.as_deref(),
                        effort,
                        fingerprint.as_deref(),
                        permission_mode.as_deref(),
                    )
                })?
            {
                return Ok(Response::Accepted { duplicate: true });
            }
            let agent_id = db(&s.database, |d| Ok(d.session(&session_id)?.agent))?;
            if agent_id == "cursor" && allow_queue {
                // Edited queue data may differ from the original accepted payload.
                // Reconcile that admission before the executed requests ledger or
                // current model catalog; neither identity check sends native input.
                let original = runtime::SendTurn {
                    request_id: request_id.clone(),
                    text: text.clone(),
                    model: model.clone(),
                    fingerprint: fingerprint.clone(),
                    // This value is identity-only and is never submitted to Runtime.
                    // Queue comparison consumes only effort and permission_mode.
                    config: providers::LaunchConfig {
                        environment: latte_work_protocol::AgentEnvironment::default(),
                        provider: None,
                        settings_dir: std::path::PathBuf::new(),
                        model: None,
                        traex_model: None,
                        effort,
                        permission_mode: permission_mode.clone(),
                    },
                };
                if let Some(response) =
                    db(&s.database, |d| d.queued_duplicate(&session_id, &original))?
                {
                    return Ok(response);
                }
                if db(&s.database, |d| {
                    d.already_accepted(
                        &session_id,
                        &request_id,
                        &text,
                        model.as_deref(),
                        effort,
                        fingerprint.as_deref(),
                        permission_mode.as_deref(),
                    )
                })? {
                    return Ok(Response::Accepted { duplicate: true });
                }
            }
            let binary = s.agent_binary(&agent_id)?;
            let launch_config = {
                let providers = s
                    .providers
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?;
                providers.turn_config(&agent_id, model.as_deref(), provider)
            };
            // Release the Provider lock before the admission -> database proof.
            let mut launch_config = launch_config.map_err(|error| {
                runtime::reject_send(&admission, &request_id, error.to_string())
            })?;
            let selected_model = launch_config.model.as_deref().or_else(|| {
                launch_config
                    .provider
                    .as_ref()
                    .map(|p| p.metadata.model.as_str())
            });
            if (!agents::has_native_models(&agent_id) || launch_config.provider.is_some())
                && effort.is_some_and(|level| {
                    !agents::effort_levels(&agent_id, selected_model).contains(&level)
                })
            {
                return Err(runtime::reject_send(
                    &admission,
                    &request_id,
                    "此 Agent 不支持所选思考强度".into(),
                ));
            }
            if let Some(mode) = &permission_mode {
                let _permit = s
                    .command_probes
                    .try_acquire()
                    .context("权限能力正在加载，请稍后重试")?;
                if !agents::permission_modes(&agent_id, binary)
                    .await?
                    .iter()
                    .any(|item| &item.id == mode)
                {
                    return Err(runtime::reject_send(
                        &admission,
                        &request_id,
                        format!("此 Agent 不支持所选权限模式：{mode}"),
                    ));
                }
            }
            launch_config.permission_mode = permission_mode.clone();
            launch_config.effort = effort;
            let (session, path) = db(&s.database, |d| {
                let session = d.session(&session_id)?;
                let path = d.project(&session.project_id)?.path;
                Ok((session, path))
            })?;
            s.resolve_native_model(&agent_id, &path, &mut launch_config)
                .await
                .map_err(|error| {
                    runtime::reject_send(&admission, &request_id, error.to_string())
                })?;
            runtime::submit_reserved(
                s.database.clone(),
                s.runs.clone(),
                binary.to_owned(),
                session,
                path,
                runtime::Submission {
                    turn: runtime::SendTurn {
                        request_id,
                        text,
                        model,
                        fingerprint,
                        config: launch_config,
                    },
                    allow_queue,
                    admission,
                },
            )
            .await?
        }
        Request::MessageQueue { session_id } => db(&s.database, |d| d.queue_snapshot(&session_id))?,
        request @ (Request::TakeQueuedMessage { .. }
        | Request::DispatchQueuedMessage { .. }
        | Request::ReorderMessageQueue { .. }
        | Request::EditQueuedMessage { .. }
        | Request::CancelQueuedMessage { .. }
        | Request::ClearMessageQueue { .. }
        | Request::ResumeMessageQueue { .. }) => {
            let id = match &request {
                Request::TakeQueuedMessage { session_id, .. }
                | Request::DispatchQueuedMessage { session_id, .. }
                | Request::ReorderMessageQueue { session_id, .. }
                | Request::EditQueuedMessage { session_id, .. }
                | Request::CancelQueuedMessage { session_id, .. }
                | Request::ClearMessageQueue { session_id }
                | Request::ResumeMessageQueue { session_id, .. } => session_id.clone(),
                _ => unreachable!(),
            };
            let (session, path) = db(&s.database, |d| {
                let session = d.session(&id)?;
                let path = d.project(&session.project_id)?.path;
                Ok((session, path))
            })?;
            let action = match request {
                Request::TakeQueuedMessage {
                    request_id,
                    revision,
                    ..
                } => runtime::QueueAction::Take {
                    request_id,
                    revision,
                },
                Request::DispatchQueuedMessage {
                    interrupt,
                    request_id,
                    revision,
                    provider,
                    ..
                } => {
                    s.agent_binary(&session.agent)?;
                    if provider.is_none() || session.archived {
                        bail!("Agent 不可用、会话已归档或执行配置未确认");
                    }
                    let fingerprint = providers::turn_fingerprint(provider.as_ref())?;
                    let (entry, original) = db(&s.database, |d| d.queued(&id))?
                        .into_iter()
                        .find(|(e, _)| e.request_id == request_id && e.revision == revision)
                        .context("消息已开始执行、移除或更新，请刷新队列")?;
                    if fingerprint != original {
                        bail!("排队时的 Provider 配置已改变，请取消后重新发送");
                    }
                    let mut config = s
                        .providers
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                        .turn_config(&session.agent, entry.model.as_deref(), provider)?;
                    config.effort = entry.effort;
                    config.permission_mode = entry.permission_mode;
                    s.resolve_native_model(&session.agent, &path, &mut config)
                        .await?;
                    runtime::QueueAction::Dispatch {
                        interrupt,
                        request_id,
                        revision,
                        config: Box::new(config),
                    }
                }
                Request::ReorderMessageQueue {
                    expected, order, ..
                } => runtime::QueueAction::Reorder { expected, order },
                Request::EditQueuedMessage {
                    request_id,
                    revision,
                    text,
                    ..
                } => runtime::QueueAction::Edit {
                    request_id,
                    revision,
                    text: Some(text),
                },
                Request::CancelQueuedMessage {
                    request_id,
                    revision,
                    ..
                } => runtime::QueueAction::Edit {
                    request_id,
                    revision,
                    text: None,
                },
                Request::ClearMessageQueue { .. } => runtime::QueueAction::Clear,
                Request::ResumeMessageQueue { provider, .. } => {
                    s.agent_binary(&session.agent)?;
                    if provider.is_none() {
                        bail!("继续排队需要重新确认执行配置，请更新客户端");
                    }
                    if session.archived {
                        bail!("请先取消归档再继续排队");
                    }
                    let fingerprint = providers::turn_fingerprint(provider.as_ref())?;
                    let entries = db(&s.database, |d| d.queued(&id))?;
                    let mut configs = HashMap::new();
                    {
                        let providers = s
                            .providers
                            .lock()
                            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?;
                        for (entry, original) in entries {
                            if fingerprint != original {
                                bail!("排队时的 Provider 配置已改变，请核对后取消并重新发送消息");
                            }
                            let mut config = providers.turn_config(
                                &session.agent,
                                entry.model.as_deref(),
                                provider.clone(),
                            )?;
                            config.effort = entry.effort;
                            config.permission_mode = entry.permission_mode;
                            configs.insert(entry.request_id, config);
                        }
                    }
                    for config in configs.values_mut() {
                        s.resolve_native_model(&session.agent, &path, config)
                            .await?;
                    }
                    runtime::QueueAction::Resume { configs }
                }
                _ => unreachable!(),
            };
            let binary = s.agent_entry(&session.agent)?.0.as_str();
            runtime::queue_action(
                s.database.clone(),
                s.runs.clone(),
                binary.to_owned(),
                session,
                path,
                action,
            )
            .await?
        }
        Request::History { session_id, before } => db(&s.database, |d| {
            let session = d.session(&session_id)?;
            let (events, has_more, needs_earlier, before) = d.history(&session_id, before)?;
            let composer_prediction = d
                .side_parent(&session_id)
                .ok()
                .and_then(|parent| predictions::snapshot(&session, parent.is_some()));
            Ok(Response::History {
                session,
                events,
                has_more,
                needs_earlier,
                before,
                composer_prediction,
            })
        })?,
        Request::Subagents { session_id } => db(&s.database, |d| {
            d.session(&session_id)?;
            let (tasks, truncated) = d.subagents(&session_id)?;
            Ok(Response::Subagents { tasks, truncated })
        })?,
        Request::SubagentHistory {
            provider,
            session_id,
            task_id,
            after,
            source,
        } => {
            db(&s.database, |d| d.subagent(&session_id, &task_id))?;
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .map(|run| run.control.clone());
            let mut source_has_more = false;
            if let Some(control) = control {
                let permit = agents::child_read_permit()?;
                let (reply, receive) = oneshot::channel();
                if control
                    .send(Control::SubagentHistory {
                        task_id: task_id.clone(),
                        permit,
                        reply,
                    })
                    .await
                    .is_ok()
                {
                    source_has_more = tokio::time::timeout(Duration::from_secs(10), receive)
                        .await??
                        .map_err(anyhow::Error::msg)?;
                }
            }
            let cursor = db(&s.database, |d| {
                d.child_history_cursor(&session_id, &task_id)
            })?;
            let session = db(&s.database, |d| d.session(&session_id))?;
            if session.agent == "opencode"
                && cursor.identity.is_empty()
                && let Some(parent) = session.native_id.as_deref()
                && let Ok(binary) = s.agent_binary("opencode")
            {
                let (child, cwd, accepted, known_children) = db(&s.database, |d| {
                    Ok((
                        d.subagent(&session_id, &task_id)?,
                        d.project(&session.project_id)?.path,
                        d.child_provider_fingerprint(&session_id, &task_id)?,
                        d.child_native_ids(&session_id)?,
                    ))
                })?;
                let fingerprint = providers::turn_fingerprint(provider.as_ref())?;
                if !child.status.active() && accepted == Some(fingerprint.clone()) {
                    let config = s
                        .providers
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                        .turn_config("opencode", None, provider.clone())?;
                    if (fingerprint.is_some() || config.provider.is_none())
                        && let Ok(Some(page)) = agents::opencode_child_history(
                            binary,
                            std::path::Path::new(&cwd),
                            parent,
                            &child.native_id,
                            &known_children,
                            &session_id,
                            &config,
                        )
                        .await
                    {
                        db(&s.database, |d| {
                            let current = d.session(&session_id)?;
                            let same_context =
                                d.child_provider_fingerprint(&session_id, &task_id)? == accepted;
                            let latest = d.subagent(&session_id, &task_id)?;
                            if current.native_id.as_deref() == Some(parent)
                                && latest.native_id == child.native_id
                                && latest.updated_at == child.updated_at
                                && !latest.status.active()
                                && same_context
                            {
                                d.cache_child_history(&session_id, &task_id, &page)?;
                            }
                            Ok(())
                        })?;
                    }
                }
            }
            if session.agent == "claude"
                && !source_has_more
                && (cursor.identity.is_empty() || cursor.has_more)
            {
                let fingerprint = providers::turn_fingerprint(provider.as_ref())?;
                let accepted = db(&s.database, |d| {
                    d.child_provider_fingerprint(&session_id, &task_id)
                })?;
                let config = s
                    .providers
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                    .turn_config(&session.agent, None, provider)?;
                // A legacy request with no snapshot is only safe when it also
                // used native defaults. A changed/unknown context serves cache.
                if accepted == Some(fingerprint.clone())
                    && (fingerprint.is_some() || config.provider.is_none())
                    && let Some(parent) = session.native_id
                {
                    let (child, cwd) = db(&s.database, |d| {
                        Ok((
                            d.subagent(&session_id, &task_id)?,
                            d.project(&session.project_id)?.path,
                        ))
                    })?;
                    let permit = agents::child_read_permit()?;
                    if let Some(page) = agents::child_history(
                        std::path::PathBuf::from(cwd),
                        parent,
                        child.native_id,
                        session_id.clone(),
                        config,
                        cursor,
                        permit,
                    )
                    .await?
                    {
                        source_has_more = page.has_more;
                        db(&s.database, |d| {
                            d.cache_child_history(&session_id, &task_id, &page)
                        })?;
                    }
                }
            }
            db(&s.database, |d| {
                d.subagent_history(
                    &session_id,
                    &task_id,
                    after,
                    source.as_deref(),
                    source_has_more,
                )
            })?
        }
        Request::SubagentTranscript {
            session_id,
            task_id,
        } => {
            db(&s.database, |d| d.subagent(&session_id, &task_id))?;
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .map(|run| run.control.clone());
            if let Some(control) = control {
                let permit = agents::child_read_permit()?;
                let (reply, receive) = oneshot::channel();
                if control
                    .send(Control::SubagentTranscript {
                        task_id: task_id.clone(),
                        permit,
                        reply,
                    })
                    .await
                    .is_ok()
                {
                    tokio::time::timeout(Duration::from_secs(10), receive)
                        .await??
                        .map_err(anyhow::Error::msg)?;
                }
            }
            let (events, truncated) = db(&s.database, |d| {
                let snapshot = d.subagent_transcript(&session_id, &task_id)?;
                agents::normalize_child_transcript(&d.session(&session_id)?.agent, snapshot)
            })?;
            Response::SubagentTranscript { events, truncated }
        }
        Request::Poll { session_id, after } => db(&s.database, |d| {
            let session = d.session(&session_id)?;
            let (events, has_more) = d.events(&session_id, after)?;
            let composer_prediction = d
                .side_parent(&session_id)
                .ok()
                .and_then(|parent| predictions::snapshot(&session, parent.is_some()));
            Ok(Response::Events {
                session,
                events,
                has_more,
                composer_prediction,
            })
        })?,
        Request::EventContent {
            session_id,
            seq,
            offset,
        } => db(&s.database, |d| {
            d.session(&session_id)?;
            let (encoding, chunk, total, next) = d.event_content(&session_id, seq, offset)?;
            Ok(Response::EventContent {
                encoding,
                chunk,
                total,
                next,
            })
        })?,
        Request::AnswerQuestion {
            session_id,
            request_id,
            answers,
        } => {
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .map(|run| run.control.clone())
                .context("此会话没有运行中的任务")?;
            let (reply, receive) = oneshot::channel();
            control
                .send(Control::AnswerQuestion {
                    id: request_id,
                    answers,
                    reply,
                })
                .await?;
            tokio::time::timeout(Duration::from_secs(10), receive)
                .await??
                .map_err(anyhow::Error::msg)?;
            Response::Ok
        }
        Request::Approve {
            session_id,
            request_id,
            allow,
        } => {
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .map(|run| run.control.clone())
                .context("此会话没有运行中的任务")?;
            let (reply, receive) = oneshot::channel();
            control
                .send(Control::Approval {
                    id: request_id,
                    allow,
                    reply,
                })
                .await?;
            tokio::time::timeout(Duration::from_secs(10), receive)
                .await??
                .map_err(anyhow::Error::msg)?;
            Response::Ok
        }
        Request::Cancel { session_id } => {
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .map(|run| run.control.clone())
                .context("此会话没有运行中的任务")?;
            let (reply, receive) = oneshot::channel();
            control.send(Control::Interrupt { reply }).await?;
            tokio::time::timeout(Duration::from_secs(15), receive)
                .await??
                .map_err(anyhow::Error::msg)?;
            Response::Ok
        }
        Request::Files { project_id, path } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            Response::Files {
                entries: files::list(Path::new(&p.path), &path)?,
            }
        }
        Request::BeginAttachment { name, size } => Response::AttachmentUpload {
            id: s
                .attachments
                .lock()
                .map_err(|_| anyhow::anyhow!("附件存储锁异常"))?
                .begin(name, size)?,
        },
        Request::AttachmentChunk { id, offset, data } => {
            s.attachments
                .lock()
                .map_err(|_| anyhow::anyhow!("附件存储锁异常"))?
                .chunk(&id, offset, &data)?;
            Response::Ok
        }
        Request::FinishAttachment { id } => Response::FileReference {
            entry: s
                .attachments
                .lock()
                .map_err(|_| anyhow::anyhow!("附件存储锁异常"))?
                .finish(&id)?,
        },
        Request::AbortAttachment { id } => {
            s.attachments
                .lock()
                .map_err(|_| anyhow::anyhow!("附件存储锁异常"))?
                .abort(&id);
            Response::Ok
        }
        Request::ResolveReference { project_id, path } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let entry = files::reference(Path::new(&p.path), &path).await?;
            if Path::new(&entry.path).is_absolute() {
                db(&s.database, |d| {
                    d.grant_reference(&project_id, &entry.path, entry.directory)
                })?;
            }
            Response::FileReference { entry }
        }
        Request::ReferenceAccess { project_id } => {
            let (entries, truncated) = db(&s.database, |d| d.reference_access(&project_id))?;
            Response::ReferenceAccess { entries, truncated }
        }
        Request::RevokeReferenceAccess { project_id, path } => {
            if path.len() > 4096 || path.contains('\0') || !Path::new(&path).is_absolute() {
                bail!("来源路径无效");
            }
            let removed = db(&s.database, |d| {
                d.revoke_reference_access(&project_id, &path)
            })?;
            // Preserve deletion of a recorded key after the file has disappeared;
            // otherwise resolve existing aliases without blocking the database lock.
            if !removed {
                let canonical =
                    tokio::time::timeout(Duration::from_secs(5), tokio::fs::canonicalize(&path))
                        .await
                        .context("读取路径超时")?;
                if let Ok(canonical) = canonical {
                    let canonical = canonical.to_str().context("路径不是 UTF-8")?;
                    db(&s.database, |d| {
                        d.revoke_reference_access(&project_id, canonical)
                    })?;
                }
            }
            Response::Ok
        }
        action @ (Request::Skills { .. }
        | Request::SkillDetail { .. }
        | Request::SetSkillState { .. }
        | Request::InstallSkill { .. }
        | Request::ImportSkillFiles { .. }) => {
            let project_id = match &action {
                Request::Skills { project_id }
                | Request::SkillDetail { project_id, .. }
                | Request::SetSkillState { project_id, .. }
                | Request::InstallSkill { project_id, .. } => project_id.as_deref(),
                Request::ImportSkillFiles { .. } => None,
                _ => unreachable!(),
            };
            if project_id.is_some() {
                bail!("技能管理仅支持当前主机的全局技能，不支持项目级管理");
            }
            let manager = s.skills.clone();
            s.skill_worker
                .run(move |budget| {
                    let manager = manager.with_budget(budget);
                    match action {
                        Request::SkillDetail { id, .. } => {
                            let (skill, markdown) = manager.detail(None, &id)?;
                            Ok(Response::SkillDetail { skill, markdown })
                        }
                        action => {
                            match action {
                                Request::SetSkillState {
                                    id,
                                    state,
                                    expected_state,
                                    ..
                                } => manager.set_state_checked(None, &id, expected_state, state)?,
                                Request::InstallSkill { scope, path, .. } => {
                                    manager.install(None, scope, Path::new(&path))?
                                }
                                Request::ImportSkillFiles { name, files } => {
                                    manager.import_files(&name, &files)?
                                }
                                _ => {}
                            }
                            let catalog = manager.list(None)?;
                            Ok(Response::Skills {
                                skills: catalog.skills,
                                warnings: catalog.warnings,
                                truncated: catalog.truncated,
                            })
                        }
                    }
                })
                .await?
        }
        Request::SkillInfo { session_id, name } => {
            let session = db(&s.database, |d| d.session(&session_id))?;
            let project = db(&s.database, |d| d.project(&session.project_id))?;
            Response::SkillInfo {
                skill: agents::skill_info(&session.agent, project.path.into(), name).await?,
            }
        }
        Request::Sources { session_id } => {
            let (entries, truncated) = db(&s.database, |d| d.sources(&session_id))?;
            Response::Sources { entries, truncated }
        }
        Request::ChangeSummary {
            project_id,
            session_id,
            offset,
            path,
        } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let summary = if let Some(id) = session_id {
                let session = db(&s.database, |d| d.session(&id))?;
                if session.project_id != project_id {
                    bail!("任务不属于当前项目");
                }
                let baseline = db(&s.database, |d| d.baseline(&id))?.unwrap_or_else(|| {
                    task_changes::Snapshot::unavailable(
                        "此任务没有记录文件基线，请查看工作区改动".into(),
                    )
                });
                baseline.summary(Path::new(&p.path)).await?
            } else {
                task_changes::workspace_summary(Path::new(&p.path)).await?
            };
            Response::ChangeSummary {
                summary: task_changes::summary_page(
                    &summary,
                    offset.unwrap_or_else(|| {
                        path.as_ref()
                            .and_then(|path| summary.entries.iter().position(|e| &e.path == path))
                            .unwrap_or(0) as u32
                    }),
                )?,
            }
        }
        Request::UndoTurnChanges {
            session_id,
            request_id,
        } => {
            use latte_work_protocol::TurnUndoStatus;
            let mut turn = db(&s.database, |d| d.turn_changes(&session_id, &request_id))?;
            if turn.changes.undo == TurnUndoStatus::Reverted {
                return Ok(Response::TurnChanges {
                    changes: turn.changes,
                });
            }
            if db(&s.database, |d| d.latest_request(&session_id))? != request_id {
                bail!("只能撤销此会话最近一轮的修改，请查看历史 diff 后手动调整");
            }
            db(&s.database, |d| d.check_no_unconfirmed_closes())?;
            if db(&s.database, |d| d.has_active_sessions())?
                || s.runs
                    .lock()
                    .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
                    .values()
                    .any(|r| !r.safe_to_close.load(std::sync::atomic::Ordering::SeqCst))
                || !s
                    .terminals
                    .lock()
                    .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                    .is_empty()
            {
                bail!("此主机仍有运行任务、后台 Agent 或终端；请结束后再撤销");
            }
            if let Some((side_id, unknown)) = db(&s.database, |d| {
                d.overlapping_side_chat(&session_id, &request_id)
            })? {
                let reason = if unknown {
                    "的写入结束时间待确认"
                } else {
                    "与本轮同时执行"
                };
                bail!(
                    "具备写权限的侧边聊天（{side_id}）{reason}，无法安全撤销。请核对侧边聊天记录，并按本轮差异手动调整文件。"
                );
            }
            let session = db(&s.database, |d| d.session(&session_id))?;
            let project = db(&s.database, |d| d.project(&session.project_id))?;
            let root = Path::new(&project.path);
            turn = turn.check_undo(root.to_owned(), false).await?;
            // Close only idle runtimes in overlapping directories before restoration.
            let running_ids: Vec<_> = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
                .keys()
                .cloned()
                .collect();
            for id in running_ids {
                let session = db(&s.database, |d| d.session(&id))?;
                let other = db(&s.database, |d| d.project(&session.project_id))?;
                let other = Path::new(&other.path);
                if root.starts_with(other) || other.starts_with(root) {
                    runtime::close(&s.database, &s.runs, &session.id, true).await?;
                }
            }
            turn = turn.check_undo(root.to_owned(), false).await?;
            db(&s.database, |d| d.check_no_unconfirmed_closes())?;
            turn.changes.undo = TurnUndoStatus::Unknown;
            db(&s.database, |d| d.update_turn(&session_id, &turn))?;
            turn = turn
                .check_undo(root.to_owned(), true)
                .await
                .context("撤销未能全部完成，状态待核对；请检查工作区，系统不会自动重试")?;
            turn.changes.undo = TurnUndoStatus::Reverted;
            db(&s.database, |d| d.update_turn(&session_id, &turn))?;
            Response::TurnChanges {
                changes: turn.changes,
            }
        }
        Request::LastTurnChanges {
            session_id,
            offset,
            path,
        } => {
            let turn = db(&s.database, |d| d.last_turn_changes(&session_id))?;
            let changes = if let Some(mut turn) = turn {
                turn.changes.summary = turn.page_for_async(offset, path.as_deref()).await?;
                Some(turn.changes)
            } else {
                None
            };
            Response::LastTurnChanges { changes }
        }
        Request::TurnChangeSummary {
            session_id,
            request_id,
            offset,
            path,
        } => {
            let mut turn = db(&s.database, |d| d.turn_changes(&session_id, &request_id))?;
            turn.changes.summary = turn.page_for_async(offset, path.as_deref()).await?;
            Response::TurnChanges {
                changes: turn.changes,
            }
        }
        Request::TurnChangeDiff {
            session_id,
            request_id,
            path,
        } => {
            let turn = db(&s.database, |d| d.turn_changes(&session_id, &request_id))?;
            let (text, truncated) = turn.patch(&path).await?;
            Response::Content { text, truncated }
        }
        Request::TaskChangeDiff { session_id, path } => {
            let session = db(&s.database, |d| d.session(&session_id))?;
            let project = db(&s.database, |d| d.project(&session.project_id))?;
            let baseline =
                db(&s.database, |d| d.baseline(&session_id))?.context("此任务没有记录文件基线")?;
            let (text, truncated) = baseline.patch(Path::new(&project.path), &path).await?;
            Response::Content { text, truncated }
        }
        Request::PreviewChange {
            target,
            path,
            before,
            offset,
        } => {
            let _permit = image_preview::permit()?;
            let chunk = tokio::time::timeout(Duration::from_secs(20), async {
                use latte_work_protocol::ChangePreviewTarget;
                match target {
                    ChangePreviewTarget::Turn {
                        session_id,
                        request_id,
                    } => {
                        let turn = db(&s.database, |d| d.turn_changes(&session_id, &request_id))?;
                        turn.image_chunk(&path, before, offset).await
                    }
                    ChangePreviewTarget::Task { session_id } => {
                        let session = db(&s.database, |d| d.session(&session_id))?;
                        let project = db(&s.database, |d| d.project(&session.project_id))?;
                        let baseline = db(&s.database, |d| d.baseline(&session_id))?
                            .context("此任务没有记录文件基线")?;
                        if before {
                            baseline.image_chunk(&path, offset).await
                        } else {
                            task_changes::validate_path(&path)?;
                            let root = Path::new(&project.path);
                            let mut target = root.to_path_buf();
                            for component in Path::new(&path).components() {
                                target.push(component);
                                let metadata = match target.symlink_metadata() {
                                    Ok(metadata) => metadata,
                                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                        return Ok(None);
                                    }
                                    Err(error) => return Err(error.into()),
                                };
                                anyhow::ensure!(
                                    !metadata.file_type().is_symlink(),
                                    "符号链接不支持图片预览"
                                );
                            }
                            image_preview::file(&files::resolve(root, &path)?, offset, None, None)
                                .await
                                .map(Some)
                        }
                    }
                    ChangePreviewTarget::Git {
                        project_id,
                        scope,
                        base,
                        head,
                    } => {
                        let project = db(&s.database, |d| d.project(&project_id))?;
                        git_review::image_chunk(
                            Path::new(&project.path),
                            scope,
                            base.as_deref(),
                            head.as_deref(),
                            &path,
                            before,
                            offset,
                        )
                        .await
                    }
                }
            })
            .await
            .context("读取图片预览超时")??;
            Response::ChangePreview { chunk }
        }
        Request::PreviewSource {
            project_id,
            session_id,
            path,
            offset,
        } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            if path.len() > 4096 || path.contains('\0') {
                bail!("来源路径无效");
            }
            let requested = if Path::new(&path).is_absolute() {
                std::path::PathBuf::from(&path)
            } else {
                files::resolve(Path::new(&p.path), &path)?
            };
            let target = tokio::fs::canonicalize(&requested).await?;
            let mut allowed = target.starts_with(&p.path)
                || db(&s.database, |d| d.reference_allowed(&project_id, &target))?;
            allowed |= s
                .attachments
                .lock()
                .map_err(|_| anyhow::anyhow!("附件存储锁异常"))?
                .is_completed(&target);
            if let Some(id) = session_id {
                let session = db(&s.database, |d| d.session(&id))?;
                if session.project_id != project_id {
                    bail!("来源不属于当前项目");
                }
                let (sources, _) = db(&s.database, |d| d.sources(&id))?;
                for source in sources {
                    if let Some(path) = source.path {
                        let original = Path::new(&path);
                        let original = if original.is_absolute() {
                            original.to_path_buf()
                        } else {
                            Path::new(&p.path).join(original)
                        };
                        // An explicit canonical reference never follows a replacement symlink.
                        if original == target
                            || (source.kind == latte_work_protocol::SourceKind::Directory
                                && target.starts_with(&original))
                        {
                            allowed = true;
                            break;
                        }
                    }
                }
            }
            if !allowed {
                bail!("请先将项目外文件或目录添加为此项目的来源");
            }
            sources::preview(&target, offset).await?
        }
        Request::PreviewMessageImage {
            project_id,
            path,
            offset,
        } => {
            db(&s.database, |d| d.project(&project_id))?;
            if path.len() > 4096 || path.contains('\0') {
                bail!("来源路径无效");
            }
            if !Path::new(&path).is_absolute() {
                bail!("消息图片需要绝对路径");
            }
            // Slow mounts can hang canonicalize well past the client's
            // transport deadline; bound it like the reference revoke path.
            let target = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::fs::canonicalize(Path::new(&path)),
            )
            .await
            .context("读取路径超时")??;
            // Display-only read: never consults or writes reference_access,
            // so a reply can neither gain nor resurrect persisted access by
            // rendering an image. The image-only gate plus the bounded
            // preview pipeline keeps the exposure to decodable raster data.
            let data = sources::preview(&target, offset).await?;
            let Response::SourcePreview { mime_type, .. } = &data else {
                bail!("消息图片需要指向具体文件");
            };
            if !mime_type.starts_with("image/") {
                bail!("此文件不是可显示的图片");
            }
            data
        }
        Request::ReadFile { project_id, path } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (text, truncated) = files::read(Path::new(&p.path), &path).await?;
            Response::Content { text, truncated }
        }
        Request::Changes { project_id } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (entries, truncated) = files::changes(Path::new(&p.path)).await?;
            Response::Changes { entries, truncated }
        }
        Request::GitInfo { project_id } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            Response::GitInfo {
                info: git_review::info(Path::new(&p.path)).await?,
            }
        }
        Request::GitCommits {
            project_id,
            head,
            offset,
        } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (head, commits, has_more) =
                git_review::commits(Path::new(&p.path), head.as_deref(), offset).await?;
            Response::GitCommits {
                head,
                commits,
                has_more,
            }
        }
        Request::GitReview {
            project_id,
            scope,
            base,
        } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            Response::GitReview {
                review: git_review::review(Path::new(&p.path), scope, base.as_deref()).await?,
            }
        }
        Request::GitReviewDiff {
            project_id,
            scope,
            base,
            head,
            path,
            full_context,
        } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (text, truncated) = git_review::diff(
                Path::new(&p.path),
                scope,
                base.as_deref(),
                head.as_deref(),
                &path,
                full_context,
            )
            .await?;
            Response::Content { text, truncated }
        }
        Request::ChangeDiff {
            project_id,
            path,
            section,
        } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (text, truncated) = files::change_diff(Path::new(&p.path), &path, section).await?;
            Response::Content { text, truncated }
        }
        Request::Diff { project_id } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (text, truncated) = files::diff(Path::new(&p.path)).await?;
            Response::Content { text, truncated }
        }
    };
    if let Some(resource) = closed_resource {
        s.lifecycle.forget_claim(&resource, closing_claim, claims)?;
    }
    runtime::refresh_titles(&s.database, &s.runs, &s.title_refresh, &mut response).await?;
    db(&s.database, |d| {
        match &mut response {
            Response::Session { session }
            | Response::Events { session, .. }
            | Response::History { session, .. } => d.project_session_recovery(session)?,
            Response::Sessions { sessions }
            | Response::SideChatHistory { sessions, .. }
            | Response::ProjectAgentSessions { sessions, .. } => {
                for session in sessions {
                    d.project_session_recovery(session)?;
                }
            }
            Response::RecentSessions { sessions, .. } => {
                for entry in sessions {
                    d.project_session_recovery(&mut entry.session)?;
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    runtime::project_session_state(&s.runs, &mut response)?;
    Ok(response)
}

#[cfg(test)]
mod send_admission_tests {
    use super::*;

    fn service(dir: &Path) -> Service {
        Service {
            attachments: Arc::new(Mutex::new(attachments::Attachments::new(dir).unwrap())),
            skills: Arc::new(skills::Skills::new(dir).unwrap()),
            skill_worker: skill_worker::Worker::new(),
            lifecycle: Arc::new(upgrade::Lifecycle::new().unwrap()),
            terminals: Arc::new(Mutex::new(terminal::Terminals::default())),
            database: Arc::new(Mutex::new(
                store::Store::open(&dir.join("state.sqlite")).unwrap(),
            )),
            runs: Arc::default(),
            title_refresh: Arc::default(),
            command_probes: Arc::new(tokio::sync::Semaphore::new(2)),
            file_admission: Arc::new(tokio::sync::RwLock::new(())),
            agents: vec![(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/codex.py")
                    .to_string_lossy()
                    .into_owned(),
                AgentInfo {
                    id: "codex".into(),
                    name: "Fixture".into(),
                    available: true,
                    provider_protocols: vec![],
                    detail: "fixture".into(),
                },
            )],
            server_id: "fixture".into(),
            providers: Arc::new(Mutex::new(providers::ProviderStore::open(dir).unwrap())),
        }
    }

    fn unsupported(request_id: &str, session_id: &str) -> Request {
        Request::Send {
            session_id: session_id.into(), request_id: request_id.into(), text: "once".into(),
            model: None, effort: Some(latte_work_protocol::Effort::High), permission_mode: None,
            provider: Some(serde_json::from_value(serde_json::json!({"kind":"snapshot","snapshot":{"provider":{"id":"fixture","name":"Fixture","protocol":"openai_responses","base_url":"http://localhost:8000/v1","model":"custom-codex","auth":"bearer","has_credential":true},"credential":"not-a-real-credential"}})).unwrap()),
        }
    }

    async fn decoded_send_is_owned_before_gate(lifecycle: bool) {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let session = db(&service.database, |store| {
            let project = store.add_project(root.path())?;
            store.create_session(project.id, "codex".into())
        })
        .unwrap();
        let (server_socket, socket) = UnixStream::pair().unwrap();
        let server = tokio::spawn(connection(server_socket, service.clone()));
        let (reader, mut writer) = socket.into_split();
        let mut responses = FramedRead::new(reader, LinesCodec::new());
        writer
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&Request::Hello { version: VERSION }).unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        responses.next().await.unwrap().unwrap();
        let draining = if lifecycle {
            Some(service.lifecycle.draining.write().await)
        } else {
            None
        };
        let file_gate = if lifecycle {
            None
        } else {
            Some(service.file_admission.write().await)
        };
        let request = Request::Send {
            session_id: session.id.clone(),
            request_id: "gate-held".into(),
            text: "once".into(),
            model: None,
            effort: None,
            permission_mode: None,
            provider: Some(latte_work_protocol::TurnProvider::Cli),
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while admission::active(&service.database, "gate-held") != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("decoded Send must reserve before waiting on the gate");
        let later = admission::Guard::reserve(&service.database, "gate-held").unwrap();
        let error = runtime::reject_send(&later, "gate-held", "明确前置拒绝".into());
        assert!(
            !error.is::<runtime::SendNotAdmitted>(),
            "older decoded continuation still exists"
        );
        drop(later);
        drop(draining);
        drop(file_gate);
        let response = tokio::time::timeout(Duration::from_secs(10), responses.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&response).unwrap(),
            Response::Accepted { duplicate: false }
        ));
        assert!(
            !db(&service.database, |store| store
                .request_identity_absent("gate-held"))
            .unwrap()
        );
        runtime::close(&service.database, &service.runs, &session.id, false)
            .await
            .unwrap();
        drop(writer);
        drop(responses);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn decoded_send_attempt_is_owned_before_lifecycle_gate() {
        decoded_send_is_owned_before_gate(true).await;
    }
    #[tokio::test]
    async fn decoded_send_attempt_is_owned_before_file_admission_gate() {
        decoded_send_is_owned_before_gate(false).await;
    }

    fn missing_native_model(session: &str, request: &str) -> Request {
        Request::Send {
            session_id: session.into(),
            request_id: request.into(),
            text: "never execute".into(),
            model: Some("missing-model".into()),
            effort: None,
            permission_mode: None,
            provider: Some(latte_work_protocol::TurnProvider::Cli),
        }
    }

    async fn model_rejection(service: &Service, root: &Path, request: &str) -> anyhow::Error {
        let session = db(&service.database, |store| {
            let project = store.add_project(root)?;
            store.create_session(project.id, "codex".into())
        })
        .unwrap();
        std::fs::write(root.join("codex-catalog.json"), r#"["codex-test"]"#).unwrap();
        let trace = root.join("codex-catalog-reads");
        let reads = || std::fs::read_to_string(&trace).unwrap().lines().count();
        let before = if trace.exists() { reads() } else { 0 };
        let error = dispatch(
            service,
            missing_native_model(&session.id, request),
            &mut upgrade::ConnectionClaims::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(reads(), before + 1, "real resolver metadata probe must run");
        assert!(!root.join("codex-inputs").exists());
        assert!(!root.join("codex-opens").exists());
        error
    }

    async fn provider_model_rejection(
        service: &Service,
        root: &Path,
        request: &str,
    ) -> anyhow::Error {
        let session = db(&service.database, |store| {
            let project = store.add_project(root)?;
            store.create_session(project.id, "codex".into())
        })
        .unwrap();
        let mut send = unsupported(request, &session.id);
        if let Request::Send { model, effort, .. } = &mut send {
            *model = Some("removed-app-model".into());
            *effort = None;
        }
        let error = dispatch(service, send, &mut upgrade::ConnectionClaims::default())
            .await
            .unwrap_err();
        assert!(!root.join("codex-inputs").exists());
        assert!(!root.join("codex-opens").exists());
        error
    }

    #[tokio::test]
    async fn provider_model_rejection_requires_sole_guard_not_old_same_id_continuation() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let older = admission::Guard::reserve(&service.database, "same-provider-model-id").unwrap();
        let error = provider_model_rejection(&service, root.path(), "same-provider-model-id").await;
        assert!(
            !error.is::<runtime::SendNotAdmitted>(),
            "older continuation may still admit"
        );
        assert!(
            error
                .to_string()
                .contains("模型不在当前 Provider 的可选列表中")
        );
        assert!(
            db(&service.database, |store| store
                .request_identity_absent("same-provider-model-id"))
            .unwrap()
        );
        assert_eq!(
            admission::active(&service.database, "same-provider-model-id"),
            1
        );
        drop(older);
        let error = provider_model_rejection(&service, root.path(), "same-provider-model-id").await;
        assert!(
            error.is::<runtime::SendNotAdmitted>(),
            "sole guard and both ledgers absent: {error:#}"
        );
        assert_eq!(
            admission::active(&service.database, "same-provider-model-id"),
            0
        );
    }

    #[tokio::test]
    async fn provider_model_rejection_stays_generic_when_queue_ledger_read_fails() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        rusqlite::Connection::open(root.path().join("state.sqlite"))
            .unwrap()
            .execute_batch("DROP TABLE message_queue")
            .unwrap();
        let error =
            provider_model_rejection(&service, root.path(), "broken-provider-model-ledger").await;
        assert!(
            !error.is::<runtime::SendNotAdmitted>(),
            "DB failure is not absence"
        );
        assert!(
            error.to_string().contains("无法核实消息准入状态"),
            "{error:#}"
        );
        assert!(
            db(&service.database, |store| store
                .request_identity_absent("broken-provider-model-ledger"))
            .is_err()
        );
        assert_eq!(
            admission::active(&service.database, "broken-provider-model-ledger"),
            0
        );
    }

    #[tokio::test]
    async fn native_model_rejection_requires_sole_guard_not_old_same_id_continuation() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let older = admission::Guard::reserve(&service.database, "same-model-id").unwrap();
        let error = model_rejection(&service, root.path(), "same-model-id").await;
        assert!(
            !error.is::<runtime::SendNotAdmitted>(),
            "older continuation may still admit"
        );
        assert!(
            db(&service.database, |store| store
                .request_identity_absent("same-model-id"))
            .unwrap()
        );
        assert_eq!(admission::active(&service.database, "same-model-id"), 1);
        drop(older);
        let error = model_rejection(&service, root.path(), "same-model-id").await;
        assert!(
            error.is::<runtime::SendNotAdmitted>(),
            "sole guard and both ledgers absent: {error:#}"
        );
    }

    #[tokio::test]
    async fn native_model_rejection_stays_generic_when_queue_ledger_read_fails() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        // Send's early dedup reads requests only; break the other ledger so
        // native validation still runs but the final absence proof cannot pass.
        rusqlite::Connection::open(root.path().join("state.sqlite"))
            .unwrap()
            .execute_batch("DROP TABLE message_queue")
            .unwrap();
        let error = model_rejection(&service, root.path(), "broken-model-ledger").await;
        assert!(
            !error.is::<runtime::SendNotAdmitted>(),
            "DB failure is not absence"
        );
        assert!(
            error.to_string().contains("无法核实消息准入状态"),
            "ledger proof failure must remain generic/unknown: {error:#}"
        );
        assert!(
            db(&service.database, |store| store
                .request_identity_absent("broken-model-ledger"))
            .is_err()
        );
        assert_eq!(
            admission::active(&service.database, "broken-model-ledger"),
            0
        );
    }

    #[tokio::test(start_paused = true)]
    async fn unsupported_prevalidation_does_not_prove_absence_with_an_older_timed_out_control() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let session = db(&service.database, |store| {
            let project = store.add_project(root.path())?;
            store.create_session(project.id, "codex".into())
        })
        .unwrap();
        let (control, mut receive) = tokio::sync::mpsc::channel(1);
        service.runs.lock().unwrap().insert(
            session.id.clone(),
            runtime::Run {
                control,
                safe_to_close: Arc::default(),
                session_open: Arc::default(),
            },
        );
        let config = service
            .providers
            .lock()
            .unwrap()
            .turn_config("codex", None, Some(latte_work_protocol::TurnProvider::Cli))
            .unwrap();
        let error = runtime::submit(
            service.database.clone(),
            service.runs.clone(),
            "/missing/cli".into(),
            session.clone(),
            root.path().to_string_lossy().into_owned(),
            runtime::SendTurn {
                request_id: "old-control".into(),
                text: "once".into(),
                model: None,
                fingerprint: None,
                config,
            },
            false,
        )
        .await
        .unwrap_err();
        assert!(error.is::<runtime::AdmissionUnknown>());
        let error = dispatch(
            &service,
            unsupported("old-control", &session.id),
            &mut upgrade::ConnectionClaims::default(),
        )
        .await
        .unwrap_err();
        assert!(
            !error.is::<runtime::SendNotAdmitted>(),
            "old decoded attempt can still admit: {error:#}"
        );
        let Control::Send {
            turn,
            admission,
            reply,
            ..
        } = receive.recv().await.unwrap()
        else {
            panic!("send")
        };
        assert!(reply.is_closed());
        assert_eq!(
            crate::admission::active(&service.database, "old-control"),
            1
        );
        assert!(
            db(&service.database, |store| store.begin(
                &session.id,
                &turn.request_id,
                &turn.text,
                None,
                None,
                None,
                None
            ))
            .unwrap()
        );
        drop(admission);
        assert_eq!(
            crate::admission::active(&service.database, "old-control"),
            0
        );
    }
}

#[cfg(test)]
mod skill_admission_tests {
    use super::*;
    #[tokio::test]
    async fn cursor_native_model_route_never_probes_traex_or_a_real_agent() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let binary = dir.join("cursor-fixture");
        std::fs::write(&binary, "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = models ] || exit 77\nprintf 'Available models\\nfixture-native - Native High 1M (default)\\n'\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let service = Service {
            attachments: Arc::new(Mutex::new(attachments::Attachments::new(dir).unwrap())),
            skills: Arc::new(skills::Skills::new(dir).unwrap()),
            skill_worker: skill_worker::Worker::new(),
            lifecycle: Arc::new(upgrade::Lifecycle::new().unwrap()),
            terminals: Arc::new(Mutex::new(terminal::Terminals::default())),
            database: Arc::new(Mutex::new(
                store::Store::open(&dir.join("state.sqlite")).unwrap(),
            )),
            runs: Arc::new(Mutex::new(HashMap::new())),
            title_refresh: Arc::new(Mutex::new(runtime::TitleRefreshCache::default())),
            command_probes: Arc::new(tokio::sync::Semaphore::new(2)),
            file_admission: Arc::new(tokio::sync::RwLock::new(())),
            agents: vec![(
                binary.to_string_lossy().into_owned(),
                AgentInfo {
                    id: "cursor".into(),
                    name: "Fixture".into(),
                    available: true,
                    provider_protocols: vec![],
                    detail: "fixture".into(),
                },
            )],
            server_id: "fixture".into(),
            providers: Arc::new(Mutex::new(providers::ProviderStore::open(dir).unwrap())),
        };
        let mut config = service
            .providers
            .lock()
            .unwrap()
            .turn_config(
                "cursor",
                Some("fixture-native"),
                Some(latte_work_protocol::TurnProvider::Cli),
            )
            .unwrap();
        service
            .resolve_native_model("cursor", dir.to_str().unwrap(), &mut config)
            .await
            .unwrap();
        assert!(config.traex_model.is_none());
        config.model = Some("unreported-model".into());
        assert!(
            service
                .resolve_native_model("cursor", dir.to_str().unwrap(), &mut config)
                .await
                .is_err()
        );
        config.model = None;
        config.effort = Some(latte_work_protocol::Effort::High);
        assert!(
            service
                .resolve_native_model("cursor", dir.to_str().unwrap(), &mut config)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn busy_skill_worker_keeps_agent_probe_capacity_available() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let service = Service {
            attachments: Arc::new(Mutex::new(attachments::Attachments::new(dir).unwrap())),
            skills: Arc::new(skills::Skills::new(dir).unwrap()),
            skill_worker: skill_worker::Worker::new(),
            lifecycle: Arc::new(upgrade::Lifecycle::new().unwrap()),
            terminals: Arc::new(Mutex::new(terminal::Terminals::default())),
            database: Arc::new(Mutex::new(
                store::Store::open(&dir.join("state.sqlite")).unwrap(),
            )),
            runs: Arc::new(Mutex::new(HashMap::new())),
            title_refresh: Arc::new(Mutex::new(runtime::TitleRefreshCache::default())),
            command_probes: Arc::new(tokio::sync::Semaphore::new(2)),
            file_admission: Arc::new(tokio::sync::RwLock::new(())),
            agents: vec![(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/claude.py")
                    .to_string_lossy()
                    .into(),
                AgentInfo {
                    id: "claude".into(),
                    name: "Fixture".into(),
                    available: true,
                    provider_protocols: vec![],
                    detail: "fixture".into(),
                },
            )],
            server_id: "fixture".into(),
            providers: Arc::new(Mutex::new(providers::ProviderStore::open(dir).unwrap())),
        };
        let (started, start) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let worker = service.skill_worker.clone();
        let job = tokio::spawn(async move {
            worker
                .run(move |_| {
                    started.send(()).unwrap();
                    let _ = wait.blocking_recv();
                    Ok(())
                })
                .await
        });
        start.await.unwrap();
        assert!(
            dispatch(
                &service,
                Request::Skills { project_id: None },
                &mut upgrade::ConnectionClaims::default()
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("仍在进行")
        );
        let _other_probe = service.command_probes.try_acquire().unwrap();
        assert!(
            matches!(dispatch(&service,Request::AgentPermissions{agent:"claude".into()}, &mut upgrade::ConnectionClaims::default()).await.unwrap(),Response::AgentPermissions{modes}if !modes.is_empty())
        );
        release.send(()).unwrap();
        job.await.unwrap().unwrap();
    }
}
