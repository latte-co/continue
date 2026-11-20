//! Real independently linked Server images exercise the executable-identity handoff.
#![cfg(feature = "test-fixture")]
use futures_util::StreamExt;
use latte_work_platform::ipc::{self, Endpoint};
use latte_work_protocol::{MAX_FRAME, VERSION};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdout, Command},
};
use tokio_util::codec::{FramedRead, LinesCodec};

const SERVER: &str = env!("CARGO_BIN_EXE_latte-work-server");
const ALTERNATE: &str = env!("CARGO_BIN_EXE_native-alternate-server");
const FIXTURE: &str = env!("CARGO_BIN_EXE_native-claude-fixture");

fn image_id(binary: &str) -> String {
    let mut file = std::fs::File::open(binary).unwrap();
    let mut hash = Sha256::new();
    let mut bytes = [0; 64 * 1024];
    loop {
        let read = file.read(&mut bytes).unwrap();
        if read == 0 {
            break;
        }
        hash.update(&bytes[..read]);
    }
    format!("{:x}", hash.finalize())
}

fn command(binary: &str, mode: &str, state: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .arg(mode)
        .arg("--state-dir")
        .arg(state)
        .env("LATTE_WORK_CLAUDE", FIXTURE)
        .env("LATTE_WORK_AGENT_ENV", "inherit")
        .env(
            "LATTE_NATIVE_PROMPT_LOG",
            state.parent().unwrap().join("prompts.log"),
        )
        .kill_on_drop(true);
    command
}

async fn lifecycle_exchange(state: &Path, request: Value) -> anyhow::Result<Value> {
    use anyhow::Context;
    let stream = Endpoint::open(state)?
        .connect(Duration::from_secs(3))
        .await?;
    let (reader, mut writer) = stream.into_split();
    let mut bytes = serde_json::to_vec(&request)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    let mut output = FramedRead::new(reader, LinesCodec::new_with_max_length(4096));
    let line = output.next().await.context("lifecycle peer closed")??;
    Ok(serde_json::from_str(&line)?)
}

async fn lifecycle(state: &Path, request: Value) -> Value {
    tokio::time::timeout(Duration::from_secs(3), lifecycle_exchange(state, request))
        .await
        .unwrap()
        .unwrap()
}

struct Host {
    root: tempfile::TempDir,
    process: Child,
}
impl Host {
    async fn start() -> Self {
        #[cfg(unix)]
        let root = tempfile::Builder::new()
            .prefix("lwu-")
            .tempdir_in("/tmp")
            .unwrap();
        #[cfg(windows)]
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let process = command(SERVER, "serve", &state)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut host = Self { root, process };
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                assert!(host.process.try_wait().unwrap().is_none());
                match Endpoint::open(&state) {
                    Ok(endpoint) => match endpoint.connect(Duration::from_secs(1)).await {
                        Ok(_) => break,
                        Err(error) if ipc::daemon_absent(&error) => {}
                        Err(error) => panic!("{error}"),
                    },
                    Err(error) if ipc::daemon_absent(&error) => {}
                    Err(error) => panic!("{error}"),
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        host
    }
    fn state(&self) -> PathBuf {
        self.root.path().join("state")
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        // The old daemon is owned; the replacement is detached by the real coordinator.
        // On assertion failure, stop the old child and attempt bounded authenticated
        // idle shutdown of the replacement before TempDir removes its isolated state.
        let _ = self.process.start_kill();
        let state = self.state();
        let cleanup = std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            runtime.block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(8), async {
                    let Ok(status) =
                        lifecycle_exchange(&state, json!({"method":"server_status"})).await
                    else {
                        return;
                    };
                    let _ = lifecycle_exchange(
                        &state,
                        json!({"method":"prepare_upgrade",
                        "server_id":status["server_id"]}),
                    )
                    .await;
                    let Ok(endpoint) = Endpoint::open(&state) else {
                        return;
                    };
                    while endpoint.try_lock_server().is_err() {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await;
            });
        });
        let _ = cleanup.join();
    }
}

struct Bridge {
    process: Child,
    output: FramedRead<ChildStdout, LinesCodec>,
}
impl Bridge {
    fn spawn(binary: &str, mode: &str, state: &Path) -> Self {
        let mut process = command(binary, mode, state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = FramedRead::new(
            process.stdout.take().unwrap(),
            LinesCodec::new_with_max_length(MAX_FRAME),
        );
        Self { process, output }
    }
    async fn request(&mut self, request: Value) -> Value {
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(25), async {
            self.process
                .stdin
                .as_mut()
                .unwrap()
                .write_all(&bytes)
                .await
                .unwrap();
            let line = self.output.next().await.unwrap().unwrap();
            serde_json::from_str(&line).unwrap()
        })
        .await
        .unwrap()
    }
    async fn exited_with_open_stdin(&mut self) {
        assert!(self.process.stdin.is_some());
        assert!(
            tokio::time::timeout(Duration::from_secs(5), self.output.next())
                .await
                .expect("old bridge stdout must close without parent stdin EOF")
                .is_none()
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(3), self.process.wait())
                .await
                .expect("bridge process must exit without parent stdin EOF")
                .unwrap()
                .success()
        );
    }
    async fn wait_status(&mut self, session: &Value, expected: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = self
                    .request(json!({"method":"poll","session_id":session,"after":0}))
                    .await;
                assert_ne!(state["kind"], "error", "{state}");
                if state["session"]["status"] == expected {
                    break;
                }
                assert_ne!(state["session"]["status"], "failed", "{state}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn native_busy_different_image_defers_then_concurrent_idle_handoff() {
    let original_id = image_id(SERVER);
    let replacement_id = image_id(ALTERNATE);
    assert_ne!(
        original_id, replacement_id,
        "test needs independently linked images with different SHA-256"
    );
    let mut host = Host::start().await;
    let state = host.state();
    let endpoint = Endpoint::open(&state).unwrap();
    let mut old = Bridge::spawn(SERVER, "connect", &state);
    let hello = old
        .request(json!({"method":"hello","version":VERSION}))
        .await;
    assert_eq!(hello["kind"], "hello");
    let old_server = hello["server_id"].clone();
    let status = lifecycle(&state, json!({"method":"server_status"})).await;
    assert_eq!(status["build_id"], original_id);
    assert_eq!(status["server_id"], old_server);
    let project = old
        .request(json!({"method":"add_project","path":host.root.path(),"name":null}))
        .await;
    let created = old.request(json!({"method":"create_session","project_id":project["project"]["id"],"agent":"claude"})).await;
    let session = &created["session"]["id"];
    assert!(session.is_string(), "{created}");
    assert_eq!(
        old.request(json!({"method":"send","session_id":session,
        "request_id":"upgrade-active","text":"wait"}))
            .await,
        json!({"kind":"accepted","duplicate":false})
    );
    old.wait_status(session, "running").await;
    let mut vetoed = Bridge::spawn(ALTERNATE, "connect-local", &state);
    let deferred = vetoed
        .request(json!({"method":"hello","version":VERSION}))
        .await;
    assert_eq!(deferred["kind"], "hello", "{deferred}");
    assert_eq!(
        deferred["server_id"], old_server,
        "busy daemon must remain the exact live instance"
    );
    assert_eq!(
        vetoed.request(json!({"method":"projects"})).await["kind"],
        "projects"
    );
    assert_eq!(
        vetoed
            .request(json!({"method":"poll","session_id":session,"after":0}))
            .await["session"]["status"],
        "running"
    );
    assert!(host.process.try_wait().unwrap().is_none());
    let status = lifecycle(&state, json!({"method":"server_status"})).await;
    assert_eq!(status["server_id"], old_server);
    assert_eq!(status["build_id"], original_id);
    assert_eq!(status["draining"], false);
    assert_eq!(
        old.request(json!({"method":"cancel","session_id":session}))
            .await["kind"],
        "ok"
    );
    old.wait_status(session, "stopped").await;
    assert_eq!(
        old.request(json!({"method":"close_agent_session","session_id":session}))
            .await["kind"],
        "ok"
    );
    let prompts = std::fs::read_to_string(host.root.path().join("prompts.log")).unwrap();
    assert_eq!(prompts, "wait\n");
    let mut first = Bridge::spawn(ALTERNATE, "connect-local", &state);
    let mut second = Bridge::spawn(ALTERNATE, "connect-local", &state);
    let (first_hello, second_hello) = tokio::join!(
        first.request(json!({"method":"hello","version":VERSION})),
        second.request(json!({"method":"hello","version":VERSION})),
    );
    assert_eq!(first_hello["kind"], "hello", "{first_hello}");
    assert_eq!(second_hello["kind"], "hello", "{second_hello}");
    let new_server = &first_hello["server_id"];
    assert_ne!(new_server, &old_server);
    assert_eq!(second_hello["server_id"], *new_server);
    for bridge in [&mut first, &mut second] {
        let status = bridge.request(json!({"method":"server_status"})).await;
        assert_eq!(status["server_id"], *new_server);
        assert_eq!(status["build_id"], replacement_id);
        assert_eq!(status["draining"], false);
    }
    old.exited_with_open_stdin().await;
    vetoed.exited_with_open_stdin().await;
    assert!(
        tokio::time::timeout(Duration::from_secs(3), host.process.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(matches!(
        endpoint.try_lock_server(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    let mut duplicate = command(SERVER, "serve", &state)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(
        !tokio::time::timeout(Duration::from_secs(3), duplicate.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert_eq!(
        lifecycle(&state, json!({"method":"server_status"})).await["server_id"],
        *new_server
    );
    assert_eq!(
        first
            .request(json!({"method":"poll","session_id":session,"after":0}))
            .await["session"]["status"],
        "stopped"
    );
    assert_eq!(
        std::fs::read_to_string(host.root.path().join("prompts.log")).unwrap(),
        prompts
    );
    assert_eq!(
        first
            .request(json!({"method":"prepare_upgrade","server_id":new_server}))
            .await["kind"],
        "upgrade_ready"
    );
    first.exited_with_open_stdin().await;
    second.exited_with_open_stdin().await;
    assert!(endpoint.try_lock_server().is_ok());
}

/// Deterministic v1 peers exercise the actual native bridge. Linux CI separately
/// runs the historical 899411e executable; this is wire-compatibility evidence.
#[tokio::test]
async fn busy_legacy_peer_stays_bound_to_instance_and_requires_compatible_hello() {
    use latte_work_client::Client;
    use tokio::io::{AsyncBufReadExt, BufReader};
    for compatible in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let endpoint = Endpoint::prepare(root.path()).unwrap();
        let listener = endpoint.bind().await.unwrap();
        let peer = tokio::spawn(async move {
            let status = json!({"kind":"server_status","server_id":"busy-v1",
                "build_id":"historical-build","draining":false});
            for methods in [
                vec!["server_status"],
                vec!["prepare_upgrade"],
                vec!["server_status", "hello"],
            ] {
                let mut stream = BufReader::new(listener.accept().await.unwrap());
                for method in methods {
                    let mut line = String::new();
                    stream.read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(request["method"], method);
                    let response = match method {
                        "server_status" => status.clone(),
                        "prepare_upgrade" => {
                            assert_eq!(request["server_id"], "busy-v1");
                            json!({"kind":"error","code":"upgrade_blocked","message":"still busy"})
                        }
                        "hello" if compatible => {
                            json!({"kind":"hello","version":VERSION,"server_id":"busy-v1","agents":[]})
                        }
                        _ => {
                            json!({"kind":"error","code":"version_mismatch","message":"fixture protocol mismatch"})
                        }
                    };
                    stream
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
            }
        });
        let result = Client::local(Path::new(SERVER), Some(root.path())).await;
        if compatible {
            assert_eq!(result.unwrap().server_id(), "busy-v1");
        } else {
            let error = result
                .err()
                .expect("Hello must reject an incompatible busy peer");
            assert!(format!("{error:#}").contains("fixture protocol mismatch"));
        }
        peer.await.unwrap();
        assert!(endpoint.try_lock_server().is_ok());
    }
}

#[tokio::test]
async fn legacy_first_error_close_is_reconciled_as_bound_individual_receipts() {
    use latte_work_client::{Client, CloseReceipt};
    use latte_work_protocol::lifecycle::Resource;
    use tokio::io::{AsyncBufReadExt, BufReader};
    let root = tempfile::tempdir().unwrap();
    let endpoint = Endpoint::prepare(root.path()).unwrap();
    let listener = endpoint.bind().await.unwrap();
    let peer = tokio::spawn(async move {
        let mut stream = BufReader::new(listener.accept().await.unwrap());
        let mut closed = std::collections::HashSet::new();
        let mut sizes = Vec::new();
        loop {
            let mut line = String::new();
            if stream.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            let request: Value = serde_json::from_str(&line).unwrap();
            let response = match request["method"].as_str().unwrap() {
                "hello" => json!({"kind":"hello","version":VERSION,"server_id":"v1","agents":[]}),
                "close_owned_resources" => {
                    assert_eq!(request["server_id"], "v1");
                    assert_eq!(request["owner_id"], "quitting-app");
                    let resources = request["resources"].as_array().unwrap();
                    sizes.push(resources.len());
                    let mut response = json!({"kind":"resources_closed"});
                    for resource in resources {
                        let id = resource["id"].as_str().unwrap();
                        if id == "session-1" {
                            response = json!({"kind":"error","code":"upgrade_blocked","message":"native close pending"});
                            break; // Historical behavior: later resources were not attempted.
                        }
                        closed.insert(id.to_owned());
                    }
                    response
                }
                other => panic!("unexpected application request or replay: {other}"),
            };
            stream
                .get_mut()
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
        (closed, sizes)
    });
    let mut client = Client::local_cleanup(Path::new(SERVER), Some(root.path()))
        .await
        .unwrap();
    let resources: Vec<_> = (0..130)
        .map(|index| Resource::AgentSession(format!("session-{index}")))
        .collect();
    let mut closes = client.close_owned_inventory("v1", "quitting-app", &resources);
    let mut acknowledged = std::collections::HashSet::new();
    let mut blocked = Vec::new();
    while let Some(receipt) = closes.next_receipt().await.unwrap() {
        match receipt {
            CloseReceipt::Closed(resources) => acknowledged.extend(resources.iter().cloned()),
            CloseReceipt::Blocked(resource, _) => blocked.push(resource.clone()),
        }
    }
    assert_eq!(blocked, vec![Resource::AgentSession("session-1".into())]);
    assert_eq!(acknowledged.len(), 129);
    drop(client);
    let (closed, sizes) = tokio::time::timeout(Duration::from_secs(5), peer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed.len(), 129);
    assert_eq!(sizes[0], 128);
    assert_eq!(sizes.len(), 130); // one rejected batch, 128 singles, one suffix batch
    assert_eq!(sizes.last(), Some(&2));
}
