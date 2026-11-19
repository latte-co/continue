//! Physical native I/O. Host session state and adapter survive a PerTurn transport.
use super::*;

const STDERR_LIMIT: usize = 16 * 1024;
const REAP_LIMIT: Duration = Duration::from_secs(2);

fn stderr_redactor(
    command: &tokio::process::Command,
    inherited: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    config: &LaunchConfig,
) -> crate::redaction::Redactor {
    // Provider credentials may live in private settings instead of child ENV.
    crate::redaction::for_command(
        command,
        inherited,
        config.provider.iter().map(|p| p.credential.clone()),
    )
}

/// Constructed only at the exact Command::spawn failure boundary.
#[derive(Debug)]
pub(super) struct SpawnNotStarted {
    pub evidence: crate::store::ConfirmedNotStarted,
    source: std::io::Error,
}
impl std::fmt::Display for SpawnNotStarted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.source, f)
    }
}
impl std::error::Error for SpawnNotStarted {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

pub(super) struct Transport {
    pub group: Group,
    pub input: Option<tokio::process::ChildStdin>,
    pub output: Output,
    pub sideband: Option<AgentSideband>,
    drain: tokio::task::JoinHandle<Result<Stderr>>,
    redactor: crate::redaction::Redactor,
    _settings: Option<tempfile::NamedTempFile>,
}
#[derive(Default)]
struct Stderr {
    bytes: Vec<u8>,
    truncated: bool,
}
impl Stderr {
    fn append(&mut self, bytes: &[u8]) {
        let remaining = STDERR_LIMIT.saturating_sub(self.bytes.len());
        self.truncated |= bytes.len() > remaining;
        self.bytes
            .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    }
    fn diagnostic(&self, redactor: &crate::redaction::Redactor) -> String {
        if self.truncated {
            // A byte cap can cut both secret text and UTF-8/JSON escapes. Never
            // display the raw retained prefix as if exact redaction made it safe.
            "[redacted] [stderr truncated] diagnostic omitted".into()
        } else {
            redactor.text(&String::from_utf8_lossy(&self.bytes))
        }
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.drain.abort();
    }
}
impl Transport {
    pub fn spawn(
        mut prepared: agents::AgentCommand,
        frame_limit: Option<usize>,
        config: &LaunchConfig,
        lifetime: agents::TransportLifetime,
    ) -> Result<Self> {
        let bidirectional = lifetime == agents::TransportLifetime::Persistent;
        let redactor = stderr_redactor(&prepared.command, std::env::vars_os(), config);
        let child = prepared
            .command
            .stdin(if bidirectional {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .map_err(|source| {
                let evidence = match source.raw_os_error() {
                    Some(code) if code == Errno::ENOENT as i32 => {
                        crate::store::ConfirmedNotStarted::Enoent
                    }
                    Some(code) if code == Errno::E2BIG as i32 => {
                        crate::store::ConfirmedNotStarted::E2big
                    }
                    _ => return anyhow::Error::from(source),
                };
                anyhow::Error::new(SpawnNotStarted { evidence, source })
            })?;
        let pid = child.id().context("Agent PID missing")? as i32;
        let mut group = Group { child, pid };
        let input = if bidirectional {
            Some(group.child.stdin.take().context("Agent stdin missing")?)
        } else {
            None
        };
        let stdout = group.child.stdout.take().context("Agent stdout missing")?;
        let output = match frame_limit {
            Some(limit) => FramedRead::new(stdout, LinesCodec::new_with_max_length(limit)),
            None => native_output(stdout),
        };
        let mut stderr = group.child.stderr.take().context("Agent stderr missing")?;
        let drain = tokio::spawn(async move {
            let mut captured = Stderr::default();
            let mut buf = [0; 4096];
            loop {
                let n = stderr
                    .read(&mut buf)
                    .await
                    .context("Agent stderr读取失败")?;
                if n == 0 {
                    return Ok(captured);
                }
                captured.append(&buf[..n]);
            }
        });
        Ok(Self {
            group,
            input,
            output,
            sideband: prepared.sideband.map(|listener| AgentSideband {
                listener,
                stream: None,
            }),
            drain,
            redactor,
            _settings: prepared._settings,
        })
    }
    /// stdout EOF is handled by Runtime before this call. Exit alone never finishes a turn.
    pub async fn exited_successfully(&mut self) -> Result<String> {
        let status = tokio::time::timeout(Duration::from_secs(5), self.group.child.wait())
            .await
            .context("Agent stdout已结束，但进程退出未确认")??;
        let stderr = tokio::time::timeout(REAP_LIMIT, &mut self.drain)
            .await
            .context("Agent stderr尚未排空，进程收尾未确认")???
            .diagnostic(&self.redactor);
        if !status.success() {
            bail!("Agent进程非零退出 ({status})：{stderr}");
        }
        Ok(format!("Agent进程退出 ({status})：{stderr}"))
    }
    /// A parent wait is not proof that inherited descendants have stopped writing.
    pub async fn terminate(&mut self, confirm_group: bool) -> bool {
        let group = Pid::from_raw(self.group.pid);
        let _ = killpg(group, Signal::SIGTERM);
        let mut reaped = matches!(
            tokio::time::timeout(REAP_LIMIT, self.group.child.wait()).await,
            Ok(Ok(_))
        );
        let _ = killpg(group, Signal::SIGKILL);
        let finished = tokio::time::timeout(REAP_LIMIT, async {
            if !reaped {
                reaped = self.group.child.wait().await.is_ok();
            }
            if confirm_group {
                loop {
                    match killpg(group, None) {
                        Err(Errno::ESRCH) => break,
                        Ok(()) | Err(Errno::EPERM) => {
                            tokio::time::sleep(Duration::from_millis(10)).await
                        }
                        Err(_) => return false,
                    }
                }
            }
            reaped
        })
        .await
        .unwrap_or(false);
        self.drain.abort();
        finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn only_exact_spawn_enoent_and_e2big_produce_not_started_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("cursor", None, None)
            .unwrap();
        for (binary, oversized, expected) in [
            (
                dir.path().join("missing-agent"),
                false,
                Some(crate::store::ConfirmedNotStarted::Enoent),
            ),
            (
                std::path::PathBuf::from("/bin/sh"),
                true,
                Some(crate::store::ConfirmedNotStarted::E2big),
            ),
            (dir.path().to_owned(), false, None),
        ] {
            let mut command = tokio::process::Command::new(binary);
            if oversized {
                command.arg("x".repeat(8 * 1024 * 1024));
            }
            let error = match Transport::spawn(
                agents::AgentCommand {
                    command,
                    _settings: None,
                    sideband: None,
                },
                Some(1024),
                &config,
                agents::TransportLifetime::PerTurn,
            ) {
                Ok(_) => panic!("invalid executable/argv must fail"),
                Err(error) => error,
            };
            assert_eq!(
                error.downcast_ref::<SpawnNotStarted>().map(|e| e.evidence),
                expected
            );
        }
    }
    #[tokio::test]
    async fn persistent_transport_retains_bidirectional_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("claude", None, None)
            .unwrap();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf 'ready\n'; IFS= read -r line; printf '%s\n' \"$line\"");
        let mut transport = Transport::spawn(
            agents::AgentCommand {
                command,
                _settings: None,
                sideband: None,
            },
            Some(1024),
            &config,
            agents::TransportLifetime::Persistent,
        )
        .unwrap();
        assert_eq!(transport.output.next().await.unwrap().unwrap(), "ready");
        write(
            transport.input.as_mut().expect("persistent stdin"),
            b"host turn\n",
        )
        .await
        .unwrap();
        assert_eq!(transport.output.next().await.unwrap().unwrap(), "host turn");
        assert!(transport.terminate(false).await);
    }
    #[test]
    fn stderr_redactor_tracks_inheritance_overlay_removal_and_authenticated_proxies() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("claude", None, None)
            .unwrap();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .env("CURSOR_API_KEY", "synthetic-overlay-token")
            .env_remove("REMOVED_PASSWORD");
        let inherited = [
            ("CURSOR_API_KEY", "synthetic-original-token"),
            ("INHERITED_AUTH", "synthetic-inherited-auth"),
            ("REMOVED_PASSWORD", "synthetic-removed-password"),
            (
                "HTTP_PROXY",
                "https://synthetic-user:synthetic-password@localhost.invalid",
            ),
            ("DISPLAY_LABEL", "ordinary-public-label"),
        ]
        .into_iter()
        .map(|(name, value)| {
            (
                std::ffi::OsString::from(name),
                std::ffi::OsString::from(value),
            )
        });
        let redactor = stderr_redactor(&command, inherited, &config);
        assert_eq!(redactor.text("synthetic-overlay-token synthetic-inherited-auth https://synthetic-user:synthetic-password@localhost.invalid"), "[redacted] [redacted] [redacted]");
        assert_eq!(
            redactor
                .text("synthetic-original-token synthetic-removed-password ordinary-public-label"),
            "synthetic-original-token synthetic-removed-password ordinary-public-label"
        );
    }
    #[tokio::test]
    async fn stderr_redacts_credentials_from_the_actual_command_environment() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("claude", None, None)
            .unwrap();
        assert!(config.environment.is_empty());
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf 'native diagnostic %s' \"$CURSOR_API_KEY\" >&2; exit 7");
        command.env("CURSOR_API_KEY", "synthetic-native-command-token");
        let mut transport = Transport::spawn(
            agents::AgentCommand {
                command,
                _settings: None,
                sideband: None,
            },
            Some(1024),
            &config,
            agents::TransportLifetime::PerTurn,
        )
        .unwrap();
        assert!(transport.output.next().await.is_none());
        let error = transport
            .exited_successfully()
            .await
            .unwrap_err()
            .to_string();
        assert!(
            !error.contains("synthetic-native-command-token"),
            "native command credential escaped LaunchConfig-only redaction"
        );
        assert!(error.contains("native diagnostic [redacted]"));
        assert!(transport.terminate(true).await);
    }
    #[test]
    fn stderr_truncation_masks_a_secret_prefix_at_the_retained_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::providers::ProviderStore::open(dir.path())
            .unwrap()
            .turn_config("claude", None, None)
            .unwrap();
        config.environment.0.insert(
            "CURSOR_FIXTURE_SECRET".into(),
            "sensitive-native-token".into(),
        );
        let mut stderr = Stderr::default();
        stderr.append(&vec![b'x'; STDERR_LIMIT - 10]);
        stderr.append(b"sensitive-native-token");
        let diagnostic = stderr.diagnostic(&config.redactor());
        assert!(
            !diagnostic.contains("sensitive"),
            "truncated secret prefix escaped redaction"
        );
        assert!(diagnostic.contains("[redacted]"));
        assert!(diagnostic.contains("[stderr truncated]"));
    }
    #[test]
    fn stderr_retention_is_bounded_even_when_drained_continuously() {
        let mut stderr = Stderr::default();
        for _ in 0..100 {
            stderr.append(&[b'x'; 4096]);
        }
        assert_eq!(stderr.bytes.len(), STDERR_LIMIT);
        assert!(stderr.truncated);
    }
}
