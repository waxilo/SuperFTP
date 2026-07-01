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

/// Delete a remote entry. Files are removed directly; directories are
/// removed recursively (contents first, then the empty dir itself). The
/// caller passes `is_dir` because computing it server-side would cost an
/// extra round trip and the frontend already knows from the entry it just
/// right-clicked.
pub async fn delete_remote(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
    is_dir: bool,
) -> FtpResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => {
            if is_dir {
                delete_dir_recursive_ftp(stream, remote_path).await?;
            } else {
                stream.rm(remote_path).await?;
            }
        }
        Session::Sftp(holder) => {
            if is_dir {
                crate::sftp::delete_dir_recursive(holder, remote_path).await?;
            } else {
                crate::sftp::delete_file(holder, remote_path).await?;
            }
        }
    }
    Ok(())
}

/// Recursively delete an FTP directory. Boxed so the future is `Sized`,
/// which async recursion requires.
fn delete_dir_recursive_ftp<'a>(
    stream: &'a mut suppaftp::tokio::AsyncFtpStream,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = FtpResult<()>> + Send + 'a>> {
    Box::pin(async move {
        // Walk into the dir, list its contents, then remove children and the
        // dir itself. Using the CWD-then-LIST pattern matches list_dir_ftp;
        // some servers reject `LIST <path>` directly.
        stream.cwd(path).await?;
        let pwd = stream.pwd().await.unwrap_or_else(|_| path.to_string());
        let lines = stream.list(None).await?;

        let entries: Vec<crate::ftp::FileEntry> = lines
            .iter()
            .filter_map(|l| crate::ftp::parse_ftp_line(l, &pwd))
            .filter(|e| e.name != "." && e.name != "..")
            .collect();

        // Delete plain files first; recursing into subdirs afterwards leaves
        // the state predictable (we're back at `pwd` when the recursive call
        // returns, because it CDs to its own parent before rmdir'ing itself).
        for entry in &entries {
            if !entry.is_dir {
                stream.rm(&entry.path).await?;
            }
        }
        for entry in &entries {
            if entry.is_dir {
                delete_dir_recursive_ftp(stream, &entry.path).await?;
            }
        }

        // Must not be sitting inside the dir we're about to remove.
        let parent = pwd
            .rsplit_once('/')
            .map(|(p, _)| if p.is_empty() { "/" } else { p })
            .unwrap_or("/");
        stream.cwd(parent).await?;
        stream.rmdir(&pwd).await?;
        Ok(())
    })
}

/// Upload a single local file into `remote_dir`. The remote filename is the
/// basename of `local_path`, mirroring standard "put" semantics. Existing
/// remote files with the same name are overwritten — the caller (right-click
/// → Send) is an explicit user action so overwrite is the least surprising
/// outcome. Returns the resolved remote path that was written.
pub async fn upload(
    state: &FtpState,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
) -> FtpResult<String> {
    let local = PathBuf::from(local_path);
    if !local.is_file() {
        return Err(FtpError::Protocol(format!(
            "Local source is not a regular file: {local_path}"
        )));
    }
    let filename = local
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| FtpError::Protocol(format!("Invalid local path: {local_path}")))?
        .to_string();

    let remote_path = if remote_dir.ends_with('/') || remote_dir.is_empty() {
        format!("{remote_dir}{filename}")
    } else {
        format!("{remote_dir}/{filename}")
    };

    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => upload_ftp(stream, &local, &remote_path).await?,
        Session::Sftp(holder) => crate::sftp::upload(holder, &local, &remote_path).await?,
    }

    Ok(remote_path)
}

async fn upload_ftp(
    stream: &mut suppaftp::tokio::AsyncFtpStream,
    local_path: &Path,
    remote_path: &str,
) -> FtpResult<()> {
    let mut file = tokio::fs::File::open(local_path).await.map_err(io_err)?;
    let mut data = stream.put_with_stream(remote_path).await?;
    tokio::io::copy(&mut file, &mut data).await.map_err(io_err)?;
    data.flush().await.map_err(io_err)?;
    // Same reasoning as retr: signal STOR completion so the server can
    // return its final response and the next command sees a fresh state.
    stream.finalize_put_stream(data).await?;
    Ok(())
}

fn io_err(e: std::io::Error) -> FtpError {
    FtpError::Protocol(format!("Local I/O error: {e}"))
}
