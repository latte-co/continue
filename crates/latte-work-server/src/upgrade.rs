//! Local lifecycle handshake, intentionally independent of the application wire version.
//! SSH continues to use `connect`, which never replaces a running daemon.
use crate::{Service, connect_socket, db, lock};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
pub use latte_work_protocol::lifecycle::{Request, Resource, Response};
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io::Read, path::Path, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    sync::{Notify, RwLock},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub struct Lifecycle {
    build_id: String,
    pub draining: RwLock<bool>,
    owners: std::sync::Mutex<std::collections::HashMap<Resource, Ownership>>,
    pub shutdown: Notify,
}
struct Ownership {
    owner_id: String,
    claim_id: uuid::Uuid,
    version: uuid::Uuid,
    pending_admission: bool,
    closing: bool,
}
impl Ownership {
    fn new(owner_id: String, pending_admission: bool) -> Self {
        Self {
            owner_id,
            claim_id: uuid::Uuid::new_v4(),
            version: uuid::Uuid::new_v4(),
            pending_admission,
            closing: false,
        }
    }
}
struct OwnedClose<'a> {
    lifecycle: &'a Lifecycle,
    resource: Resource,
    confirmed: bool,
}
impl OwnedClose<'_> {
    fn confirm(mut self) {
        self.confirmed = true;
    }
}

impl Drop for OwnedClose<'_> {
    fn drop(&mut self) {
        if let Ok(mut owners) = self.lifecycle.owners.lock() {
            if self.confirmed {
                owners.remove(&self.resource);
            } else if let Some(owner) = owners.get_mut(&self.resource) {
                owner.closing = false;
            }
        }
    }
}
/// Native claims are scoped to the connection which will submit Open/Send.
/// No tokens or owner identity are accepted from the WebView request schema.
#[derive(Default)]
pub struct ConnectionClaims {
    claims: std::collections::HashMap<Resource, uuid::Uuid>,
    requires_claim: bool,
}
impl ConnectionClaims {
    fn prune(&mut self, owners: &std::collections::HashMap<Resource, Ownership>) {
        let before = self.claims.len();
        self.claims.retain(|resource, claim| {
            owners
                .get(resource)
                .is_some_and(|owner| owner.claim_id == *claim)
        });
        // Once an obsolete claim is evicted, absence must not be confused with
        // a legacy unowned connection. No per-resource tombstones are needed.
        self.requires_claim |= self.claims.len() != before;
    }
    fn check_capacity(&self, resources: &[Resource]) -> Result<()> {
        if self.claims.len()
            + resources
                .iter()
                .filter(|r| !self.claims.contains_key(*r))
                .count()
            > 4096
        {
            bail!("此连接的资源认领已达上限，请重新连接");
        }
        Ok(())
    }
}
impl Lifecycle {
    /// Called under execution admission, before any operation can start work.
    /// Closing the old actor cannot revoke a still-pending claim. A superseded
    /// connection must explicitly reclaim rather than silently steal ownership.
    pub fn admit_claim(
        &self,
        resource: &Resource,
        claims: &ConnectionClaims,
    ) -> Result<Option<uuid::Uuid>> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?;
        if owners.get(resource).is_some_and(|owner| owner.closing) {
            bail!("此会话或终端正在关闭，请稍后重试；请求未执行");
        }
        let Some(claim_id) = claims.claims.get(resource) else {
            if claims.requires_claim {
                bail!("资源认领已变化，请重新认领后重试；请求未执行");
            }
            return Ok(None);
        };
        let ownership = owners
            .get_mut(resource)
            .filter(|owner| &owner.claim_id == claim_id)
            .context("资源认领已变化，请重新打开会话后重试；请求未执行")?;
        ownership.pending_admission = true;
        ownership.version = uuid::Uuid::new_v4();
        Ok(Some(*claim_id))
    }
    /// Keep the reservation through asynchronous Open/Send and its receipt.
    /// A close which saw the reservation cannot later retire this activation.
    pub fn finish_admission(&self, resource: &Resource, claim: Option<uuid::Uuid>) -> Result<()> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?;
        if let Some(owner) = owners
            .get_mut(resource)
            .filter(|owner| Some(owner.claim_id) == claim)
        {
            owner.pending_admission = false;
            owner.version = uuid::Uuid::new_v4();
        }
        Ok(())
    }
    pub fn new() -> Result<Self> {
        Ok(Self {
            build_id: executable_id()?,
            draining: RwLock::new(false),
            owners: std::sync::Mutex::new(std::collections::HashMap::new()),
            shutdown: Notify::new(),
        })
    }
}
impl Lifecycle {
    pub fn claim_version(&self, resource: &Resource) -> Result<Option<uuid::Uuid>> {
        Ok(self
            .owners
            .lock()
            .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?
            .get(resource)
            .map(|ownership| ownership.version))
    }
    /// A close can await the old actor while another connection reclaims its ID.
    /// Even a reclaim by the same App is a new version, not the closed resource.
    pub fn forget_claim(
        &self,
        resource: &Resource,
        version: Option<uuid::Uuid>,
        claims: &mut ConnectionClaims,
    ) -> Result<()> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?;
        if owners.get(resource).is_some_and(|ownership| {
            !ownership.closing
                && Some(ownership.version) == version
                && (!ownership.pending_admission
                    || claims.claims.get(resource) == Some(&ownership.claim_id))
        }) {
            owners.remove(resource);
        }
        // This connection explicitly closed/archived the resource. Its old claim
        // no longer represents a future open, unlike another client's reservation.
        claims.claims.remove(resource);
        Ok(())
    }
}
fn executable_id() -> Result<String> {
    let mut file = std::fs::File::open(std::env::current_exe()?)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub async fn handle(
    service: &Service,
    request: Request,
    claims: &mut ConnectionClaims,
) -> Response {
    match handle_inner(service, request, claims).await {
        Ok(response) => response,
        Err(error) => Response::Error {
            code: "upgrade_blocked".into(),
            message: error.to_string(),
        },
    }
}
async fn handle_inner(
    service: &Service,
    request: Request,
    claims: &mut ConnectionClaims,
) -> Result<Response> {
    match request {
        Request::ClaimResources {
            owner_id,
            resources,
        } => {
            validate_resources(&owner_id, &resources)?;
            let draining = service.lifecycle.draining.read().await;
            if *draining {
                bail!("后台正在停止，请重新连接");
            }
            let mut owners = service
                .lifecycle
                .owners
                .lock()
                .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?;
            claims.prune(&owners);
            claims.check_capacity(&resources)?;
            check_not_closing(&owners, &resources)?;
            let new = resources
                .iter()
                .filter(|r| !owners.contains_key(*r))
                .count();
            if owners.len() + new > 4096 {
                bail!("会话资源归属数量已达上限");
            }
            for resource in resources {
                let ownership = Ownership::new(owner_id.clone(), true);
                claims.claims.insert(resource.clone(), ownership.claim_id);
                owners.insert(resource, ownership);
            }
            Ok(Response::ResourcesClaimed)
        }
        Request::AdoptResources {
            server_id,
            previous_owner_id,
            owner_id,
            resources,
        } => {
            validate_resources(&owner_id, &resources)?;
            if previous_owner_id.is_empty() || previous_owner_id.len() > 128 {
                bail!("无效的资源归属");
            }
            if server_id != service.server_id {
                return Ok(Response::ResourcesAdopted { resources: vec![] });
            }
            let _admission = service.lifecycle.draining.read().await;
            let runs = service
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?;
            let terminals = service
                .terminals
                .lock()
                .map_err(|_| anyhow::anyhow!("终端锁异常"))?;
            let mut owners = service
                .lifecycle
                .owners
                .lock()
                .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?;
            claims.prune(&owners);
            claims.check_capacity(&resources)?;
            check_not_closing(&owners, &resources)?;
            let mut adopted = Vec::new();
            for resource in resources {
                let live = match &resource {
                    Resource::AgentSession(id) => runs.get(id).is_some_and(|r| {
                        !r.control.is_closed()
                            && (r.session_open.load(std::sync::atomic::Ordering::SeqCst)
                                || !r.safe_to_close.load(std::sync::atomic::Ordering::SeqCst))
                    }),
                    Resource::Terminal(id) => terminals.is_open(id),
                };
                if live
                    && owners.get(&resource).is_some_and(|ownership| {
                        ownership.owner_id == previous_owner_id || ownership.owner_id == owner_id
                    })
                {
                    let ownership = Ownership::new(owner_id.clone(), false);
                    claims.claims.insert(resource.clone(), ownership.claim_id);
                    owners.insert(resource.clone(), ownership);
                    adopted.push(resource);
                }
            }
            Ok(Response::ResourcesAdopted { resources: adopted })
        }
        Request::CloseOwnedResources {
            server_id,
            owner_id,
            resources,
        } => {
            validate_resources(&owner_id, &resources)?;
            // A restarted daemon has already lost these ephemeral resources. Never
            // apply an old close to a new server or a resource reclaimed by another App.
            if server_id != service.server_id {
                return Ok(Response::ResourcesClosed);
            }
            close_owned(service, &owner_id, resources).await?;
            Ok(Response::ResourcesClosed)
        }
        Request::ServerStatus => Ok(Response::ServerStatus {
            server_id: service.server_id.clone(),
            build_id: service.lifecycle.build_id.clone(),
            draining: *service.lifecycle.draining.read().await,
        }),
        Request::PrepareUpgrade { server_id } => {
            if server_id != service.server_id {
                bail!("后台实例已变化，请重新连接");
            }
            let mut draining =
                tokio::time::timeout(Duration::from_secs(2), service.lifecycle.draining.write())
                    .await
                    .context("后台正在处理请求，请稍后重新连接以更新")?;
            let running = service
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .values()
                .any(|run| !run.safe_to_close.load(std::sync::atomic::Ordering::SeqCst));
            let terminals = !service
                .terminals
                .lock()
                .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                .is_empty();
            let closing = service
                .lifecycle
                .owners
                .lock()
                .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?
                .values()
                .any(|owner| owner.closing);
            if running
                || terminals
                || closing
                || db(&service.database, |d| d.has_active_sessions())?
            {
                bail!(
                    "本机后台需要更新，但仍有任务或终端；请等待任务完成并关闭终端后重新连接。当前任务不会中断"
                );
            }
            *draining = true;
            Ok(Response::UpgradeReady)
        }
    }
}
fn check_not_closing(
    owners: &std::collections::HashMap<Resource, Ownership>,
    resources: &[Resource],
) -> Result<()> {
    if resources
        .iter()
        .any(|resource| owners.get(resource).is_some_and(|owner| owner.closing))
    {
        bail!("此会话或终端正在关闭，请稍后重试；请求未执行");
    }
    Ok(())
}

async fn close_owned(service: &Service, owner_id: &str, resources: Vec<Resource>) -> Result<()> {
    let mut retry = false;
    let reservations = {
        // Wait out admitted requests, then fence only the resources being
        // closed. Slow native shutdown must leave Hello and other chats usable.
        let admission =
            tokio::time::timeout(Duration::from_secs(2), service.lifecycle.draining.write())
                .await
                .context("后台正在处理请求")?;
        if *admission {
            bail!("后台正在停止，请重新连接");
        }
        let mut owners = service
            .lifecycle
            .owners
            .lock()
            .map_err(|_| anyhow::anyhow!("资源归属锁异常"))?;
        let mut seen = std::collections::HashSet::new();
        let mut reservations = Vec::new();
        for resource in resources {
            if !seen.insert(resource.clone()) {
                continue;
            }
            if let Some(owner) = owners
                .get_mut(&resource)
                .filter(|owner| owner.owner_id == owner_id)
            {
                if owner.closing {
                    retry = true;
                    continue;
                }
                owner.closing = true;
                reservations.push(OwnedClose {
                    lifecycle: &service.lifecycle,
                    resource,
                    confirmed: false,
                });
            }
        }
        reservations
    };
    let results =
        futures_util::future::join_all(reservations.into_iter().map(|close| async move {
            match &close.resource {
                Resource::AgentSession(id) => {
                    let _admission = service.file_admission.read().await;
                    let exists = service
                        .runs
                        .lock()
                        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
                        .contains_key(id);
                    if exists {
                        crate::runtime::close(&service.database, &service.runs, id, false).await?;
                    } else {
                        // An actor can be gone while its native close is still unknown.
                        db(&service.database, |store| {
                            if let Some(reason) = store.unconfirmed_agent_close(id)? {
                                bail!(reason);
                            }
                            Ok(())
                        })?;
                    }
                }
                Resource::Terminal(id) => {
                    service
                        .terminals
                        .lock()
                        .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                        .close(id);
                }
            }
            close.confirm();
            Ok::<_, anyhow::Error>(())
        }))
        .await;
    for result in results {
        result?;
    }
    if retry {
        bail!("部分资源仍在关闭，请稍后重试");
    }
    Ok(())
}
fn validate_resources(owner: &str, resources: &[Resource]) -> Result<()> {
    if owner.is_empty()
        || owner.len() > 128
        || resources.len() > latte_work_protocol::lifecycle::RESOURCE_BATCH_LIMIT
        || resources
            .iter()
            .any(|r| r.id().is_empty() || r.id().len() > 256)
    {
        bail!("无效的资源关闭请求");
    }
    Ok(())
}
async fn exchange(stream: UnixStream, request: &Request) -> Result<Response> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let (reader, mut writer) = stream.into_split();
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        let mut lines = FramedRead::new(reader, LinesCodec::new_with_max_length(4096));
        let line = lines.next().await.context("后台连接关闭")??;
        Ok::<_, anyhow::Error>(serde_json::from_str(&line)?)
    })
    .await
    .context("后台升级检查超时")?
}
// A daemon can close the first control connection while a desktop is reopening.
// Retry only the read-only status query; never retry upgrade admission or user work.
async fn server_status(dir: &Path) -> Result<Response> {
    for attempt in 0..3 {
        let result =
            async { exchange(connect_socket(dir).await?, &Request::ServerStatus).await }.await;
        match result {
            Ok(response) => return Ok(response),
            Err(error) if attempt == 2 => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(150)).await,
        }
    }
    unreachable!("bounded status attempts return on the last iteration")
}
const LEGACY: &str = "检测到旧版本机后台，无法安全确认其任务状态；请先在旧版应用中完成任务并关闭终端，再手动重启本机 Server，然后重新连接。仅重启桌面应用不会停止后台";

/// Serialize local coordinators, ask the owning daemon to drain atomically, then wait for
/// its singleton lock. Never kill a daemon, remove its socket, or replay application requests.
pub async fn connect_local(dir: &Path) -> Result<UnixStream> {
    tokio::time::timeout(Duration::from_secs(20), connect_local_inner(dir))
        .await
        .context("本机后台切换超时，请稍后重新连接；任务不会自动重发")?
}
async fn connect_local_inner(dir: &Path) -> Result<UnixStream> {
    let coordinator = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("upgrade.lock"))?;
    loop {
        match coordinator.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(error) => return Err(error.into()),
        }
    }
    let build_id = executable_id()?;
    let (server_id, accepted_build) = match server_status(dir)
        .await
        .context("无法确认本机后台版本，请稍后重新连接；后台未被停止")?
    {
        Response::ServerStatus {
            server_id,
            build_id: current,
            draining: false,
        } if current == build_id => (server_id, current),
        Response::ServerStatus {
            server_id,
            build_id: current,
            draining,
        } => {
            if !draining {
                let stream = UnixStream::connect(dir.join("control.sock")).await?;
                match exchange(
                    stream,
                    &Request::PrepareUpgrade {
                        server_id: server_id.clone(),
                    },
                )
                .await?
                {
                    Response::UpgradeReady => {}
                    Response::Error { code, .. } if code == "upgrade_blocked" => {
                        // Keep this exact live instance available. The client still
                        // performs the regular versioned Hello before using it.
                        return connect_verified(dir, &server_id, &current).await;
                    }
                    Response::Error { message, .. } => bail!("{message}"),
                    _ => bail!("后台升级响应不兼容，请重新连接"),
                }
            }
            // The lock is released only after the old daemon has removed its own socket.
            loop {
                if let Ok(guard) = lock(dir) {
                    drop(guard);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let stream = connect_socket(dir).await?;
            match exchange(stream, &Request::ServerStatus).await? {
                Response::ServerStatus {
                    server_id,
                    build_id: current,
                    draining: false,
                } if current == build_id => (server_id, current),
                _ => bail!("另一个版本的后台已启动，请关闭其他版本应用后重新连接"),
            }
        }
        _ => bail!("{LEGACY}"),
    };
    connect_verified(dir, &server_id, &accepted_build).await
}

async fn connect_verified(dir: &Path, server_id: &str, build_id: &str) -> Result<UnixStream> {
    // Return this exact, verified instance's socket. Recheck after reconnect because a
    // concurrent external shutdown/start may otherwise attach us to a different build.
    let mut stream = UnixStream::connect(dir.join("control.sock")).await?;
    let mut bytes = serde_json::to_vec(&Request::ServerStatus)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    let mut response = Vec::new();
    // Read exactly one line; do not buffer and discard any subsequent application bytes.
    use tokio::io::AsyncReadExt;
    loop {
        let byte = stream.read_u8().await?;
        if byte == b'\n' {
            break;
        }
        if response.len() >= 4096 {
            bail!("后台状态响应过大");
        }
        response.push(byte);
    }
    match serde_json::from_slice::<Response>(&response)? {
        Response::ServerStatus {
            server_id: instance,
            build_id: current,
            draining: false,
        } if instance == server_id && current == build_id => Ok(stream),
        _ => bail!("后台实例已变化，请重新连接"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::UnixListener};
    #[test]
    fn close_cleanup_requires_the_captured_claim_version() {
        let lifecycle = Lifecycle::new().unwrap();
        let resource = Resource::AgentSession("session".into());
        let absent = lifecycle.claim_version(&resource).unwrap();
        lifecycle
            .owners
            .lock()
            .unwrap()
            .insert(resource.clone(), Ownership::new("app".into(), false));
        lifecycle
            .forget_claim(&resource, absent, &mut ConnectionClaims::default())
            .unwrap();
        let first = lifecycle.claim_version(&resource).unwrap();
        assert!(first.is_some());
        lifecycle
            .owners
            .lock()
            .unwrap()
            .insert(resource.clone(), Ownership::new("app".into(), false));
        let newer = lifecycle.claim_version(&resource).unwrap();
        assert_ne!(first, newer);
        lifecycle
            .forget_claim(&resource, first, &mut ConnectionClaims::default())
            .unwrap();
        assert_eq!(lifecycle.claim_version(&resource).unwrap(), newer);
        lifecycle
            .forget_claim(&resource, newer, &mut ConnectionClaims::default())
            .unwrap();
        assert!(lifecycle.claim_version(&resource).unwrap().is_none());
    }
    #[test]
    fn pending_claim_survives_close_and_admission_refreshes_the_runtime_version() {
        let lifecycle = Lifecycle::new().unwrap();
        let resource = Resource::AgentSession("session".into());
        let ownership = Ownership::new("app".into(), true);
        let mut claims = ConnectionClaims::default();
        claims.claims.insert(resource.clone(), ownership.claim_id);
        lifecycle
            .owners
            .lock()
            .unwrap()
            .insert(resource.clone(), ownership);
        let closing = lifecycle.claim_version(&resource).unwrap();
        lifecycle
            .forget_claim(&resource, closing, &mut ConnectionClaims::default())
            .unwrap();
        assert_eq!(lifecycle.claim_version(&resource).unwrap(), closing);
        let claim = lifecycle.admit_claim(&resource, &claims).unwrap();
        let admitted = lifecycle.claim_version(&resource).unwrap();
        assert_ne!(closing, admitted);
        lifecycle
            .forget_claim(&resource, closing, &mut ConnectionClaims::default())
            .unwrap();
        assert_eq!(lifecycle.claim_version(&resource).unwrap(), admitted);
        lifecycle
            .forget_claim(&resource, admitted, &mut ConnectionClaims::default())
            .unwrap();
        assert_eq!(lifecycle.claim_version(&resource).unwrap(), admitted);
        lifecycle.finish_admission(&resource, claim).unwrap();
        let active = lifecycle.claim_version(&resource).unwrap();
        lifecycle
            .forget_claim(&resource, admitted, &mut ConnectionClaims::default())
            .unwrap();
        assert_eq!(lifecycle.claim_version(&resource).unwrap(), active);
        lifecycle
            .forget_claim(&resource, active, &mut ConnectionClaims::default())
            .unwrap();
        assert!(lifecycle.claim_version(&resource).unwrap().is_none());
        assert!(lifecycle.admit_claim(&resource, &claims).is_err());
    }
    #[test]
    fn explicit_close_on_claiming_connection_retires_its_own_reservation() {
        let lifecycle = Lifecycle::new().unwrap();
        let resource = Resource::AgentSession("session".into());
        let ownership = Ownership::new("app".into(), true);
        let mut claims = ConnectionClaims::default();
        claims.claims.insert(resource.clone(), ownership.claim_id);
        lifecycle
            .owners
            .lock()
            .unwrap()
            .insert(resource.clone(), ownership);
        let version = lifecycle.claim_version(&resource).unwrap();
        lifecycle
            .forget_claim(&resource, version, &mut claims)
            .unwrap();
        assert!(lifecycle.claim_version(&resource).unwrap().is_none());
        assert!(claims.claims.is_empty());
    }
    #[test]
    fn pruned_connection_claims_free_capacity_without_admitting_stale_requests() {
        let lifecycle = Lifecycle::new().unwrap();
        let mut control = ConnectionClaims::default();
        let mut read = ConnectionClaims::default();
        for n in 0..4096 {
            let resource = Resource::AgentSession(format!("archived-{n}"));
            let owner = Ownership::new("app".into(), false);
            control.claims.insert(resource.clone(), owner.claim_id);
            let version = owner.version;
            lifecycle
                .owners
                .lock()
                .unwrap()
                .insert(resource.clone(), owner);
            lifecycle
                .forget_claim(&resource, Some(version), &mut read)
                .unwrap();
        }
        let stale = Resource::AgentSession("archived-0".into());
        let live = Resource::AgentSession("next".into());
        assert!(control.check_capacity(std::slice::from_ref(&live)).is_err());
        control.prune(&lifecycle.owners.lock().unwrap());
        assert!(control.claims.is_empty());
        assert!(control.check_capacity(std::slice::from_ref(&live)).is_ok());
        assert!(lifecycle.admit_claim(&stale, &control).is_err());
        let owner = Ownership::new("app".into(), true);
        control.claims.insert(live.clone(), owner.claim_id);
        lifecycle.owners.lock().unwrap().insert(live.clone(), owner);
        assert!(lifecycle.admit_claim(&live, &control).is_ok());
        lifecycle
            .owners
            .lock()
            .unwrap()
            .insert(live.clone(), Ownership::new("other".into(), true));
        control.prune(&lifecycle.owners.lock().unwrap());
        assert!(lifecycle.admit_claim(&live, &control).is_err());
    }
    #[tokio::test]
    async fn status_retries_a_closed_connection_without_requesting_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(directory.path().join("control.sock")).unwrap();
        let service = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = vec![];
                loop {
                    let byte = stream.read_u8().await.unwrap();
                    if byte == b'\n' {
                        break;
                    }
                    bytes.push(byte);
                }
                assert!(matches!(
                    serde_json::from_slice::<Request>(&bytes).unwrap(),
                    Request::ServerStatus
                ));
                if attempt == 1 {
                    let mut response = serde_json::to_vec(&Response::ServerStatus {
                        server_id: "fixture".into(),
                        build_id: "build".into(),
                        draining: false,
                    })
                    .unwrap();
                    response.push(b'\n');
                    stream.write_all(&response).await.unwrap();
                }
            }
        });
        let response =
            tokio::time::timeout(Duration::from_secs(2), server_status(directory.path()))
                .await
                .unwrap()
                .unwrap();
        assert!(matches!(
            response,
            Response::ServerStatus {
                draining: false,
                ..
            }
        ));
        service.await.unwrap();
    }
}
