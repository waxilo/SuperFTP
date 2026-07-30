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

/// Whether a remote path exists, and if so whether it's a directory.
/// `is_dir` is meaningless when `exists` is false.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExistsResult {
    pub exists: bool,
    pub is_dir: bool,
}

/// Split a POSIX remote path into `(parent_dir, basename)`. Trailing slashes
/// are ignored, and a path with no `/` is treated as living in the root.
fn split_remote(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((parent, name)) => {
            let parent = if parent.is_empty() { "/" } else { parent };
            (parent.to_string(), name.to_string())
        }
        None => ("/".to_string(), trimmed.to_string()),
    }
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Check whether `remote_path` already exists. Used by the frontend before a
/// paste so it can pick a non-clashing name (copy) or ask about overwriting
/// (cut), instead of letting the server fail halfway through.
pub async fn remote_exists(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
) -> FtpResult<ExistsResult> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => exists_ftp(stream, remote_path).await,
        Session::Sftp(holder) => {
            let found = crate::sftp::stat(holder, remote_path).await?;
            Ok(ExistsResult {
                exists: found.is_some(),
                is_dir: found.unwrap_or(false),
            })
        }
    }
}

/// FTP has no portable "does this path exist" command — SIZE is refused for
/// directories (and in ASCII mode by some servers), and MLST isn't universal.
/// Listing the parent directory and looking for the basename works anywhere
/// LIST does, which is everywhere this app already relies on.
async fn exists_ftp(
    stream: &mut suppaftp::tokio::AsyncFtpStream,
    remote_path: &str,
) -> FtpResult<ExistsResult> {
    let (parent, name) = split_remote(remote_path);
    if name.is_empty() {
        // The root itself; always there.
        return Ok(ExistsResult {
            exists: true,
            is_dir: true,
        });
    }
    stream.cwd(&parent).await?;
    let pwd = stream.pwd().await.unwrap_or(parent);
    let lines = stream.list(None).await?;
    for entry in lines
        .iter()
        .filter_map(|l| crate::ftp::parse_ftp_line(l, &pwd))
    {
        if entry.name == name {
            return Ok(ExistsResult {
                exists: true,
                is_dir: entry.is_dir,
            });
        }
    }
    Ok(ExistsResult {
        exists: false,
        is_dir: false,
    })
}

/// Create a directory at `remote_path`. The parent must already exist — the
/// UI only ever creates inside a folder it's currently showing.
pub async fn create_dir_remote(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
) -> FtpResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => {
            stream.mkdir(remote_path).await?;
        }
        Session::Sftp(holder) => crate::sftp::create_dir(holder, remote_path).await?,
    }
    Ok(())
}

/// Create an empty file at `remote_path`.
///
/// Both backends would happily truncate an existing file here, so the caller
/// checks for a clash first (see `remote_exists`) instead of letting a typo
/// wipe out someone's data.
pub async fn create_file_remote(
    state: &FtpState,
    session_id: &str,
    remote_path: &str,
) -> FtpResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => {
            // A zero-byte STOR: open the data channel, write nothing, then
            // finalize so the server sends its completion reply and the
            // control connection stays usable.
            let mut data = stream.put_with_stream(remote_path).await?;
            data.flush().await.map_err(io_err)?;
            stream.finalize_put_stream(data).await?;
        }
        Session::Sftp(holder) => crate::sftp::create_file(holder, remote_path).await?,
    }
    Ok(())
}

/// Move a remote entry to `to`, which is a full destination path (not a
/// directory). This is how both "cut + paste" and a plain rename are
/// implemented: FTP's RNFR/RNTO and SFTP's RENAME both move and rename in a
/// single server-side operation, so no data crosses the wire.
///
/// The destination's parent directory must exist, and the destination itself
/// must not — the caller deletes it first if the user chose to overwrite.
pub async fn rename_remote(
    state: &FtpState,
    session_id: &str,
    from: &str,
    to: &str,
) -> FtpResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => {
            stream.rename(from, to).await?;
        }
        Session::Sftp(holder) => crate::sftp::rename(holder, from, to).await?,
    }
    Ok(())
}

/// Copy a remote entry to `to`, recursing into directories.
///
/// FTP has no server-side copy command, so each file is pulled down to an
/// app-private temp folder and pushed back up under the new name. That means
/// a copy costs twice the file size in traffic — unavoidable over plain FTP.
/// SFTP streams between two handles on the same channel instead (see
/// `sftp::copy_recursive`), which still passes through us but skips the disk.
pub async fn copy_remote(
    state: &FtpState,
    session_id: &str,
    from: &str,
    to: &str,
    is_dir: bool,
) -> FtpResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;

    match session {
        Session::Ftp(stream) => {
            // One scratch dir per copy operation, removed when we're done.
            let mut tmp = std::env::temp_dir();
            tmp.push("superftp-copy");
            tmp.push(uuid::Uuid::new_v4().to_string());
            tokio::fs::create_dir_all(&tmp).await.map_err(io_err)?;

            let result = if is_dir {
                copy_dir_recursive_ftp(stream, from, to, &tmp).await
            } else {
                copy_file_ftp(stream, from, to, &tmp).await
            };

            let _ = tokio::fs::remove_dir_all(&tmp).await;
            result?;
        }
        Session::Sftp(holder) => crate::sftp::copy_recursive(holder, from, to, is_dir).await?,
    }
    Ok(())
}

/// Copy one FTP file via a local scratch file. Sequential RETR then STOR on
/// the same control connection — both are finalized properly so the session
/// stays usable afterwards.
async fn copy_file_ftp(
    stream: &mut suppaftp::tokio::AsyncFtpStream,
    from: &str,
    to: &str,
    tmp_dir: &Path,
) -> FtpResult<()> {
    let scratch = tmp_dir.join(uuid::Uuid::new_v4().to_string());
    download_ftp(stream, from, &scratch).await?;
    let result = upload_ftp(stream, &scratch, to).await;
    let _ = tokio::fs::remove_file(&scratch).await;
    result
}

/// Recursively copy an FTP directory. Same CWD-then-LIST pattern as
/// `list_dir_ftp` / `delete_dir_recursive_ftp`, since some servers reject
/// `LIST <path>`. Boxed so the future is `Sized` for async recursion.
fn copy_dir_recursive_ftp<'a>(
    stream: &'a mut suppaftp::tokio::AsyncFtpStream,
    from: &'a str,
    to: &'a str,
    tmp_dir: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = FtpResult<()>> + Send + 'a>> {
    Box::pin(async move {
        // Ignore the error when the directory already exists — that's a merge,
        // which is what the user asked for by confirming the overwrite.
        let _ = stream.mkdir(to).await;

        stream.cwd(from).await?;
        let pwd = stream.pwd().await.unwrap_or_else(|_| from.to_string());
        let lines = stream.list(None).await?;

        let entries: Vec<crate::ftp::FileEntry> = lines
            .iter()
            .filter_map(|l| crate::ftp::parse_ftp_line(l, &pwd))
            .filter(|e| e.name != "." && e.name != "..")
            .collect();

        for entry in &entries {
            let dest = join_remote(to, &entry.name);
            if entry.is_dir {
                copy_dir_recursive_ftp(stream, &entry.path, &dest, tmp_dir).await?;
            } else {
                copy_file_ftp(stream, &entry.path, &dest, tmp_dir).await?;
            }
        }
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
