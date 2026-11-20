//! One-shot private pipes. The listener reuses the control-channel DACL and
//! authenticates the same user before handing out a stream, so a
//! different local process cannot read a transient handshake secret.
use crate::control;
use std::{
    io,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub type PrivateStream = control::Stream;

/// A bound local pipe with a random name and a user-only DACL.
pub struct PrivatePipe {
    name: String,
    listener: control::Listener,
    // Accepted streams survive a caller cancelling a pending first-byte read.
    pending: tokio::sync::Mutex<Option<PrivateStream>>,
}

impl PrivatePipe {
    /// Bind `\\.\pipe\latte-work-<tag>-<unique>`. `tag` is ASCII alphanumeric or `-`.
    pub fn bind(tag: &str) -> io::Result<Self> {
        if tag.is_empty()
            || tag.len() > 32
            || !tag
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pipe tag must be lowercase ASCII alphanumeric or '-'",
            ));
        }
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
            ^ u128::from(std::process::id())
            ^ u128::from(NEXT.fetch_add(1, Ordering::Relaxed));
        let name = format!(r"\\.\pipe\latte-work-{tag}-{unique:x}");
        let listener = control::listen(&name)?;
        Ok(Self {
            name,
            listener,
            pending: tokio::sync::Mutex::new(None),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Accept one authenticated client. The stream is returned only after the
    /// kernel-reported peer token matches the current user.
    pub async fn accept_once(&self) -> io::Result<PrivateStream> {
        let stream = self.listener.accept().await?;
        control::verify_peer(&stream)?;
        Ok(stream)
    }

    /// Node/libuv clients need one read before Windows permits impersonation.
    /// Only one bounded byte is buffered before authentication; the caller must
    /// put it back into its frame buffer before decoding any application input.
    pub async fn accept_with_prefix(&self) -> io::Result<(PrivateStream, u8)> {
        use tokio::io::AsyncReadExt;
        let mut pending = self.pending.lock().await;
        if pending.is_none() {
            *pending = Some(self.listener.accept().await?);
        }
        let prefix = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let stream = pending.as_mut().expect("accepted private stream");
            let mut prefix = [0];
            stream.read_exact(&mut prefix).await?;
            control::verify_peer(stream)?;
            Ok::<_, io::Error>(prefix[0])
        })
        .await
        .map_err(|_| {
            io::Error::new(io::ErrorKind::TimedOut, "private pipe handshake timed out")
        })??;
        Ok((
            pending.take().expect("authenticated private stream"),
            prefix,
        ))
    }
}

/// Synchronous connect for helper processes that run before the async runtime.
pub fn connect_file_once(name: &str) -> io::Result<std::fs::File> {
    control::connect_file_once(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn a_flushed_pipe_closes_the_client_with_eof() {
        use std::sync::mpsc;
        let pipe = PrivatePipe::bind("roundtrip").unwrap();
        let name = pipe.name().to_owned();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut file = connect_file_once(&name).unwrap();
            let mut data = Vec::new();
            file.read_to_end(&mut data).unwrap();
            let _ = tx.send(data);
        });
        let mut stream = pipe.accept_once().await.unwrap();
        stream.write_all(b"secret").await.unwrap();
        stream.flush().await.unwrap();
        stream.evade_limbo();
        let data = tokio::task::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(10))
        })
        .await
        .unwrap()
        .expect("client did not see EOF");
        assert_eq!(data, b"secret");
    }
}
