//! Normal Host requests against all five deterministic CLI peers on Windows.
#![cfg(all(windows, feature = "test-fixture"))]
use latte_work_client::Client;
use latte_work_platform::ipc::{self, Endpoint};
use latte_work_protocol::{Request, Response, VERSION};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::{Child, Command};

const SERVER: &str = env!("CARGO_BIN_EXE_latte-work-server");
const AGENTS: [&str; 5] = ["claude", "traex", "codex", "opencode", "cursor"];
struct Host {
    root: tempfile::TempDir,
    process: Child,
}
impl Host {
    async fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("invocations")).unwrap();
        let python = which::which("python.exe").expect("native fixture gate requires Python 3");
        let mut command = Command::new(SERVER);
        command
            .args(["serve", "--state-dir"])
            .arg(root.path().join("state"))
            .env("LATTE_WORK_AGENT_ENV", "inherit")
            .env("PYTHONUTF8", "1")
            .env("LATTE_RUNTIME_NATIVE_PYTHON", python)
            .env("LATTE_RUNTIME_NATIVE_ROOT", root.path())
            .env(
                "LATTE_RUNTIME_NATIVE_FIXTURES",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"),
            )
            .env("CLAUDE_CONFIG_DIR", root.path().join("claude-config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for agent in AGENTS {
            let directory = root.path().join(agent);
            std::fs::create_dir(&directory).unwrap();
            if agent == "claude" {
                let fixture = directory.join("native-claude.exe");
                std::fs::copy(env!("CARGO_BIN_EXE_native-claude-fixture"), &fixture).unwrap();
                command
                    .env("LATTE_WORK_CLAUDE", fixture)
                    .env(
                        "LATTE_NATIVE_PROMPT_LOG",
                        root.path().join("native-claude-prompts"),
                    )
                    .env(
                        "LATTE_NATIVE_ACTION_LOG",
                        root.path().join("native-claude-actions"),
                    );
                continue;
            }
            std::fs::write(
                directory.join("fixture.py"),
                include_str!("fixtures/runtime_windows_agent.py"),
            )
            .unwrap();
            std::fs::write(directory.join("agent.ps1"), "& $env:LATTE_RUNTIME_NATIVE_PYTHON -u (Join-Path $PSScriptRoot 'fixture.py') @args\nexit $LASTEXITCODE\n").unwrap();
            command.env(
                format!("LATTE_WORK_{}", agent.to_ascii_uppercase()),
                directory.join("agent.ps1"),
            );
        }
        let mut host = Self {
            process: command.spawn().unwrap(),
            root,
        };
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                assert!(
                    host.process.try_wait().unwrap().is_none(),
                    "fixture daemon exited before readiness"
                );
                match Endpoint::open(&host.state()) {
                    Ok(endpoint) => match endpoint.connect(Duration::from_secs(1)).await {
                        Ok(_) => break,
                        Err(error) if ipc::daemon_absent(&error) => {}
                        Err(error) => panic!("fixture endpoint: {error}"),
                    },
                    Err(error) if ipc::daemon_absent(&error) => {}
                    Err(error) => panic!("fixture endpoint: {error}"),
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        host
    }
    fn state(&self) -> PathBuf {
        self.root.path().join("state")
    }
    async fn client(&self) -> Client {
        Client::local(Path::new(SERVER), Some(&self.state()))
            .await
            .unwrap()
    }
    async fn stop(&mut self, client: &mut Client) {
        assert!(client.shutdown_if_idle().await.unwrap());
        assert!(
            tokio::time::timeout(Duration::from_secs(10), self.process.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert!(
            Endpoint::open(&self.state())
                .unwrap()
                .try_lock_server()
                .is_ok()
        );
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Ok(errors) = std::fs::read_to_string(self.root.path().join("fixture-errors.log"))
        {
            eprintln!("Native peer diagnostic: {errors}");
        }
        if self.process.try_wait().ok().flatten().is_none() {
            let _ = self.process.start_kill();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while self.process.try_wait().ok().flatten().is_none()
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

async fn ask(client: &mut Client, request: Value) -> Value {
    let session = request["session_id"].as_str().map(str::to_owned);
    let response = client
        .request(serde_json::from_value::<Request>(request.clone()).unwrap())
        .await
        .unwrap();
    let response = serde_json::to_value(response).unwrap();
    if response["kind"] == "error" {
        let state = match session {
            Some(session_id) => serde_json::to_value(
                client
                    .request(Request::Poll {
                        session_id,
                        after: 0.0,
                    })
                    .await
                    .unwrap(),
            )
            .unwrap(),
            None => Value::Null,
        };
        panic!("native fixture request={request}; response={response}; state={state}");
    }
    response
}

async fn poll_until(
    client: &mut Client,
    session: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let events = ask(
                client,
                json!({"method":"poll","session_id":session,"after":0}),
            )
            .await;
            assert_ne!(events["session"]["status"], "failed", "{events}");
            if predicate(&events) {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap()
}
async fn send(client: &mut Client, id: &str, request: &str, prompt: &str) -> Value {
    ask(client, json!({"method":"send_queued","session_id":id,"request_id":format!("{id}-{request}"),"text":prompt,"model":null,"effort":null,"permission_mode":null,"provider":{"kind":"cli"}})).await
}
async fn close(client: &mut Client, id: &str) {
    let reply = ask(
        client,
        json!({"method":"close_agent_session","session_id":id,"only_if_idle":false}),
    )
    .await;
    assert_eq!(reply["kind"], "ok", "{reply}");
}
fn transcript(value: &Value) -> String {
    value["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|event| event["event"]["text"].as_str())
        .collect()
}

async fn verify_agents(selected: &[&str]) {
    let mut host = Host::start().await;
    let mut client = host.client().await;
    let Response::Hello { agents, .. } = client
        .request(Request::Hello { version: VERSION })
        .await
        .unwrap()
    else {
        panic!("Hello");
    };
    for id in AGENTS {
        assert!(
            agents.iter().any(|agent| agent.id == id && agent.available),
            "missing compatible fixture: {id}: {agents:?}"
        );
    }
    for agent in selected.iter().copied() {
        let directory = host.root.path().join(format!("project-{agent}"));
        std::fs::create_dir(&directory).unwrap();
        let project = ask(
            &mut client,
            json!({"method":"add_project","path":directory,"name":null}),
        )
        .await;
        let session = ask(
            &mut client,
            json!({"method":"create_session","project_id":project["project"]["id"],"agent":agent}),
        )
        .await;
        let id = session["session"]["id"].as_str().unwrap();
        let opened = ask(
            &mut client,
            json!({"method":"open_agent_session","session_id":id,"provider":{"kind":"cli"}}),
        )
        .await;
        assert_eq!(opened["kind"], "ok", "{agent}: {opened}");
        assert_eq!(
            send(&mut client, id, "first", "first").await["duplicate"],
            false
        );
        let first = poll_until(&mut client, id, |events| {
            events["session"]["status"] == "completed"
        })
        .await;
        assert!(!transcript(&first).is_empty(), "{agent}: no streamed reply");
        let native = first["session"]["native_id"].as_str().unwrap().to_owned();
        assert_eq!(
            send(&mut client, id, "first", "first").await["duplicate"],
            true,
            "{agent}: durable request identity"
        );
        close(&mut client, id).await;
        assert_eq!(
            send(&mut client, id, "second", "second").await["duplicate"],
            false
        );
        let second = poll_until(&mut client, id, |events| {
            events["session"]["status"] == "completed"
        })
        .await;
        assert_eq!(
            second["session"]["native_id"], native,
            "{agent}: cold resume identity"
        );
        assert_eq!(
            second["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["event"]["kind"] == "user")
                .count(),
            2,
            "{agent}: no replay"
        );
        let hold = match agent {
            "claude" => "wait",
            "cursor" => "hold",
            "opencode" => "steer-parent",
            _ => "wait",
        };
        send(&mut client, id, "cancel", hold).await;
        let _active = poll_until(&mut client, id, |events| {
            if events["session"]["status"] != "running" {
                return false;
            }
            match agent {
                "claude" => std::fs::read_to_string(host.root.path().join("native-claude-prompts"))
                    .unwrap_or_default()
                    .lines()
                    .any(|line| line == "wait"),
                "traex" | "codex" => transcript(events).contains("WAITING"),
                "cursor" => std::fs::read_to_string(directory.join("cursor-inputs"))
                    .unwrap_or_default()
                    .contains("\"hold\""),
                "opencode" => std::fs::read_to_string(directory.join("prompts"))
                    .unwrap_or_default()
                    .contains("steer-parent"),
                _ => false,
            }
        })
        .await;
        close(&mut client, id).await;
        let stopped = poll_until(&mut client, id, |events| {
            events["session"]["status"] == "stopped"
        })
        .await;
        assert_eq!(stopped["session"]["native_id"], native);
    }
    host.stop(&mut client).await;
    for entry in std::fs::read_dir(host.root.path().join("invocations")).unwrap() {
        let record: Value =
            serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
        assert_pid_gone(u32::try_from(record["pid"].as_u64().unwrap()).unwrap());
    }
}
#[tokio::test]
async fn five_windows_agents_discover_stream_resume_deduplicate_and_cancel_owned_trees() {
    verify_agents(&AGENTS).await;
}

#[tokio::test]
async fn cursor_windows_host_streams_resumes_and_cancels_independently() {
    verify_agents(&["cursor"]).await;
}

async fn claude_session(host: &Host, client: &mut Client, name: &str) -> (String, PathBuf) {
    let directory = host.root.path().join(name);
    std::fs::create_dir(&directory).unwrap();
    let project = ask(
        client,
        json!({"method":"add_project","path":directory,"name":null}),
    )
    .await;
    let session = ask(
        client,
        json!({"method":"create_session","project_id":project["project"]["id"],"agent":"claude"}),
    )
    .await;
    let id = session["session"]["id"].as_str().unwrap().to_owned();
    ask(
        client,
        json!({"method":"open_agent_session","session_id":id,"provider":{"kind":"cli"}}),
    )
    .await;
    (id, directory)
}

#[tokio::test]
async fn claude_windows_shutdown_requires_ack_eof_task_settlement_and_successful_exit() {
    let mut host = Host::start().await;
    let mut client = host.client().await;
    let (peer, _) = claude_session(&host, &mut client, "peer-session").await;
    send(&mut client, &peer, "peer-start", "wait").await;
    poll_until(&mut client, &peer, |events| {
        events["session"]["status"] == "running"
    })
    .await;
    for mode in [
        "close-late-settled",
        "close-late-unsettled",
        "close-no-ack",
        "close-wrong-ack",
        "close-nonzero",
        "close-no-eof",
    ] {
        let (id, directory) = claude_session(&host, &mut client, mode).await;
        send(&mut client, &id, "prepare-close", mode).await;
        poll_until(&mut client, &id, |events| {
            events["session"]["status"] == "completed"
        })
        .await;
        let child: u32 = std::fs::read_to_string(directory.join("close-child/leaf.ready"))
            .unwrap()
            .parse()
            .unwrap();
        let request = Request::CloseAgentSession {
            session_id: id.clone(),
            only_if_idle: Some(false),
        };
        let response = client.request(request.clone()).await.unwrap();
        let confirmed = mode == "close-late-settled";
        assert_eq!(
            matches!(response, Response::Ok),
            confirmed,
            "{mode}: {response:?}"
        );
        assert_pid_gone(child);
        let lock = std::fs::File::open(directory.join("close-child/leaf.lock")).unwrap();
        lock.try_lock()
            .expect("descendant cleanup releases its lock");
        drop(lock);
        let saved = ask(&mut client, json!({"method":"session","session_id":id})).await;
        let drained = ask(
            &mut client,
            json!({"method":"poll","session_id":id,"after":0}),
        )
        .await;
        assert!(
            !transcript(&drained).contains("CLOSE_MUST_NOT_RESTART"),
            "native close output restarted the turn"
        );
        assert_eq!(
            saved["session"]["agent_session_open"], false,
            "{mode}: {saved}"
        );
        assert_eq!(
            saved["session"]["agent_close_pending"].is_null(),
            confirmed,
            "{mode}: {saved}"
        );
        if !confirmed {
            let pending = saved["session"]["agent_close_pending"].clone();
            for _ in 0..2 {
                assert!(
                    matches!(
                        client.request(request.clone()).await.unwrap(),
                        Response::Error { .. }
                    ),
                    "{mode}: retry fabricated a native receipt"
                );
                let retried = ask(&mut client, json!({"method":"session","session_id":id})).await;
                assert_eq!(
                    retried["session"]["agent_close_pending"], pending,
                    "{mode}: retry changed durable fence"
                );
            }
            assert!(matches!(
                client
                    .request(Request::OpenAgentSession {
                        session_id: id.clone(),
                        provider: None
                    })
                    .await
                    .unwrap(),
                Response::Error { .. }
            ));
            // Every fixture child and held lock has been verified gone above.
            // Explicit user verification may now clear the durable uncertainty.
            let verified = ask(
                &mut client,
                json!({"method":"confirm_agent_closed","session_id":id,"close_id":pending}),
            )
            .await;
            assert!(verified["session"]["agent_close_pending"].is_null());
        }
        let other = ask(&mut client, json!({"method":"session","session_id":peer})).await;
        assert_eq!(
            other["session"]["status"], "running",
            "{mode}: peer was interrupted"
        );
        assert_eq!(other["session"]["agent_session_open"], true);
        assert!(other["session"]["agent_close_pending"].is_null());
    }
    close(&mut client, &peer).await;
    host.stop(&mut client).await;
}

fn assert_pid_gone(pid: u32) {
    let output = std::process::Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains(&format!("\",\"{pid}\",")),
        "fixture PID still alive: {pid}"
    );
}
