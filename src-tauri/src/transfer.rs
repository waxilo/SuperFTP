//! Transfers between an active remote session and the local filesystem.
//!
//! Currently supports remote → local downloads only. Uploads are planned but
//! not wired yet.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

use crate::ftp::{FtpError, FtpResult, FtpState, Session};
use crate::local;

/// Result of [`read_text`]. `truncated` is true when the remote file was
/// larger than `max_bytes` and only the leading slice was returned.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReadTextResult {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
}

/// Download a single remote file into `local_dir`. The local filename is
/// taken from the basename of `remote_path`, mirroring how a regular FTP
/// "get" works. Returns the absolute local path that was written.
///
/// If a file with the same name already exists it is **overwritten**. We
/// could add a "rename on conflict" mode later; for now the explicit user
/// action (right-click → Send) makes overwrite the least surprising choice.
pub async fn download(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
) -> FtpResult<String> {
    let local_path = resolve_local_target(remote_path, local_dir)?;

    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => download_ftp(stream, remote_path, &local_path).await?,
        Session::Sftp(holder) => crate::sftp::download(holder, remote_path, &local_path).await?,
    }

    Ok(local::normalize_path(&local_path))
}

fn resolve_local_target(remote_path: &str, local_dir: &str) -> FtpResult<PathBuf> {
    let dir = PathBuf::from(local_dir);
    if !dir.is_dir() {
        return Err(FtpError::Protocol(format!(
            "Local target is not a directory: {local_dir}"
        )));
    }
    // Remote paths are POSIX-style ("/foo/bar.csv"); take everything after the
    // last `/` as the filename. Falling back to the whole string handles the
    // (unlikely) case where the remote path is just a bare filename.
    let filename = remote_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(remote_path);
    Ok(dir.join(filename))
}

/// Download a single remote file into a fresh, app-private temp directory.
/// Used by the "Open" actions so multiple opens of the same filename (from
/// different remote folders) don't trample each other, and so the regular
/// download folder isn't littered with preview files.
///
/// Returns the absolute local path that was written.
pub async fn download_to_temp(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
) -> FtpResult<String> {
    let mut dir = std::env::temp_dir();
    dir.push("superftp");
    dir.push(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir).await.map_err(io_err)?;
    let dir_str = local::normalize_path(&dir);
    download(state, session_id, remote_path, &dir_str).await
}

/// Download a remote file into the temp folder and return its contents as a
/// UTF-8 string (lossy decoding so binary files still render something). Any
/// bytes past `max_bytes` are dropped and the `truncated` flag is set so the
/// UI can warn the user that they're only seeing a prefix.
pub async fn read_text(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
    max_bytes: usize,
) -> FtpResult<ReadTextResult> {
    let path = download_to_temp(state, session_id, remote_path).await?;
    let bytes = tokio::fs::read(&path).await.map_err(io_err)?;
    let size = bytes.len() as u64;
    let truncated = bytes.len() > max_bytes;
    let slice = if truncated { &bytes[..max_bytes] } else { &bytes[..] };
    let content = String::from_utf8_lossy(slice).into_owned();
    Ok(ReadTextResult {
        content,
        size,
        truncated,
    })
}

async fn download_ftp(
    stream: &mut suppaftp::tokio::AsyncFtpStream,
    remote_path: &str,
    local_path: &Path,
) -> FtpResult<()> {
    let mut data = stream.retr_as_stream(remote_path).await?;
    let mut out = File::create(local_path).await.map_err(io_err)?;
    tokio::io::copy(&mut data, &mut out).await.map_err(io_err)?;
    out.flush().await.map_err(io_err)?;
    // Crucial: tell the server we're done so it can close the data channel
    // and return its final response code. Without this the next FTP command
    // on this session will see a stale reply.
    stream.finalize_retr_stream(data).await?;
    Ok(())
}

fn io_err(e: std::io::Error) -> FtpError {
    FtpError::Protocol(format!("Local I/O error: {e}"))
}
