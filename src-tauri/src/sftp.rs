//! SFTP backend built on top of `russh` (SSH-2) + `russh-sftp`.
//!
//! The module exposes a single owned holder, [`SftpHolder`], that keeps the
//! SSH session alive alongside the SFTP subsystem channel and tracks the
//! current working directory client-side (SFTP itself is stateless on paths).
//!
//! Public functions mirror the FTP backend's shape so the dispatcher in
//! `ftp.rs` can treat both protocols uniformly.

use std::sync::Arc;
use std::time::Duration;

use std::path::Path;

use chrono::{TimeZone, Utc};
use russh::client::{self, Handle};
use russh::keys::PublicKey;
use russh_sftp::client::SftpSession;
use russh_sftp::client::fs::DirEntry;
use russh_sftp::protocol::FileAttributes;
use tokio::io::AsyncWriteExt;

use crate::ftp::{FileEntry, FtpError, FtpResult, ListResult};

/// Holds an open SFTP session and everything required to keep it alive.
///
/// `_ssh` is intentionally kept around because dropping it tears down the
/// SSH transport (and therefore the SFTP subsystem channel) immediately.
pub struct SftpHolder {
    _ssh: Handle<SshClient>,
    sftp: SftpSession,
    cwd: String,
}

/// Minimal `russh` client handler.
///
/// The server's host key is accepted unconditionally for now. TODO: implement
/// trust-on-first-use storage so we can detect MITM after the first connect.
struct SshClient;

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Open an SSH connection, authenticate with the given password, and start
/// the SFTP subsystem. Returns the holder and the initial canonical cwd.
pub async fn connect(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> FtpResult<(SftpHolder, String)> {
    let mut config = client::Config::default();
    // Keep the control channel from going idle behind aggressive NATs.
    config.inactivity_timeout = Some(Duration::from_secs(300));
    config.keepalive_interval = Some(Duration::from_secs(30));
    let config = Arc::new(config);

    let mut session = client::connect(config, (host, port), SshClient)
        .await
        .map_err(map_ssh)?;

    let auth = session
        .authenticate_password(username, password)
        .await
        .map_err(map_ssh)?;
    if !auth.success() {
        return Err(FtpError::Protocol(
            "Authentication failed (wrong username or password)".into(),
        ));
    }

    // Open an SSH "session" channel and request the SFTP subsystem on it.
    let channel = session
        .channel_open_session()
        .await
        .map_err(map_ssh)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(map_ssh)?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(map_sftp)?;

    // Resolve "." to the user's home directory so the UI shows a real
    // absolute path on first render.
    let cwd = sftp.canonicalize(".").await.map_err(map_sftp)?;

    Ok((
        SftpHolder {
            _ssh: session,
            sftp,
            cwd: cwd.clone(),
        },
        cwd,
    ))
}

/// Close the SFTP session and the underlying SSH transport. Best-effort: any
/// error is swallowed because the holder is dropped immediately afterwards.
pub async fn disconnect(holder: SftpHolder) {
    let _ = holder
        ._ssh
        .disconnect(russh::Disconnect::ByApplication, "bye", "en")
        .await;
}

/// List a directory. `path` may be absolute, relative, or empty (= cwd).
pub async fn list_dir(holder: &mut SftpHolder, path: &str) -> FtpResult<ListResult> {
    let target = resolve_path(&holder.cwd, path);
    // Canonicalize so the UI always shows the real path (resolving `.`/`..`
    // and symlinked dirs).
    let canon = holder
        .sftp
        .canonicalize(&target)
        .await
        .map_err(map_sftp)?;

    let read = holder.sftp.read_dir(&canon).await.map_err(map_sftp)?;

    let mut entries: Vec<FileEntry> = read
        .into_iter()
        .filter(|e| e.file_name() != "." && e.file_name() != "..")
        .map(|e| dir_entry_to_file(e, &canon))
        .collect();

    // Only group directories above files — leave server order intact
    // within each group so the frontend's ascending/descending sort is
    // visibly different from the "default" (unsorted) state.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });

    holder.cwd = canon.clone();
    Ok(ListResult {
        cwd: canon,
        entries,
    })
}

/// Stream a remote file into the given local path. The local file is
/// truncated and overwritten if it exists.
pub async fn download(
    holder: &mut SftpHolder,
    remote_path: &str,
    local_path: &Path,
) -> FtpResult<()> {
    let target = resolve_path(&holder.cwd, remote_path);
    let mut remote = holder.sftp.open(&target).await.map_err(map_sftp)?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| FtpError::Protocol(format!("Local I/O error: {e}")))?;
    tokio::io::copy(&mut remote, &mut local)
        .await
        .map_err(|e| FtpError::Protocol(format!("Transfer failed: {e}")))?;
    local
        .flush()
        .await
        .map_err(|e| FtpError::Protocol(format!("Local I/O error: {e}")))?;
    Ok(())
}

/// Delete a single remote file. `path` may be relative to the current
/// session cwd. Directories are not accepted — callers must gate on the
/// entry type before invoking this.
pub async fn delete_file(holder: &mut SftpHolder, path: &str) -> FtpResult<()> {
    let target = resolve_path(&holder.cwd, path);
    holder.sftp.remove_file(&target).await.map_err(map_sftp)
}

/// Recursively delete an SFTP directory. Contents are removed before the
/// dir itself. Boxed for async recursion.
pub fn delete_dir_recursive<'a>(
    holder: &'a mut SftpHolder,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = FtpResult<()>> + Send + 'a>> {
    Box::pin(async move {
        let target = resolve_path(&holder.cwd, path);
        let canon = holder
            .sftp
            .canonicalize(&target)
            .await
            .map_err(map_sftp)?;

        // Collect first so we release the borrow on `holder.sftp` before the
        // loop, letting us call `holder.sftp.remove_*` inside it.
        let children: Vec<(String, bool)> = holder
            .sftp
            .read_dir(&canon)
            .await
            .map_err(map_sftp)?
            .into_iter()
            .filter(|e| e.file_name() != "." && e.file_name() != "..")
            .map(|e| (e.file_name(), e.metadata().is_dir()))
            .collect();

        for (name, is_dir) in children {
            let child = join_path(&canon, &name);
            if is_dir {
                delete_dir_recursive(holder, &child).await?;
            } else {
                holder.sftp.remove_file(&child).await.map_err(map_sftp)?;
            }
        }

        holder.sftp.remove_dir(&canon).await.map_err(map_sftp)?;
        Ok(())
    })
}

/// Stream a local file up to the remote server. The remote file is
/// created (or overwritten if it already exists).
pub async fn upload(
    holder: &mut SftpHolder,
    local_path: &Path,
    remote_path: &str,
) -> FtpResult<()> {
    let target = resolve_path(&holder.cwd, remote_path);
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| FtpError::Protocol(format!("Local I/O error: {e}")))?;
    let mut remote = holder.sftp.create(&target).await.map_err(map_sftp)?;
    tokio::io::copy(&mut local, &mut remote)
        .await
        .map_err(|e| FtpError::Protocol(format!("Transfer failed: {e}")))?;
    remote
        .flush()
        .await
        .map_err(|e| FtpError::Protocol(format!("Transfer failed: {e}")))?;
    Ok(())
}

/// Change the working directory. Returns the resolved absolute path.
pub async fn change_dir(holder: &mut SftpHolder, path: &str) -> FtpResult<String> {
    let target = resolve_path(&holder.cwd, path);
    let canon = holder
        .sftp
        .canonicalize(&target)
        .await
        .map_err(map_sftp)?;

    // Make sure the resolved path is actually a directory; otherwise the
    // sidebar would happily "enter" a regular file and the next list would
    // fail with a confusing error.
    let meta = holder.sftp.metadata(&canon).await.map_err(map_sftp)?;
    if !meta.is_dir() {
        return Err(FtpError::Protocol(format!("Not a directory: {canon}")));
    }

    holder.cwd = canon.clone();
    Ok(canon)
}

fn dir_entry_to_file(entry: DirEntry, cwd: &str) -> FileEntry {
    let name = entry.file_name();
    let attrs = entry.metadata();
    let path = join_path(cwd, &name);

    FileEntry {
        name,
        path,
        size: attrs.size.unwrap_or(0) as usize,
        is_dir: attrs.is_dir(),
        is_symlink: attrs.is_symlink(),
        modified: format_mtime(&attrs),
        permissions: attrs.permissions.map(format_unix_mode),
    }
}

fn resolve_path(cwd: &str, requested: &str) -> String {
    if requested.is_empty() {
        cwd.to_string()
    } else if requested.starts_with('/') {
        requested.to_string()
    } else {
        join_path(cwd, requested)
    }
}

fn join_path(cwd: &str, name: &str) -> String {
    if cwd.ends_with('/') {
        format!("{cwd}{name}")
    } else {
        format!("{cwd}/{name}")
    }
}

fn format_mtime(attrs: &FileAttributes) -> Option<String> {
    let ts = attrs.mtime? as i64;
    Utc.timestamp_opt(ts, 0).single().map(|d| d.to_rfc3339())
}

/// Format the low 9 bits of a Unix mode as `rwxr-xr-x`.
fn format_unix_mode(mode: u32) -> String {
    fn triplet(bits: u32) -> String {
        let mut s = String::with_capacity(3);
        s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
        s
    }
    format!(
        "{}{}{}",
        triplet((mode >> 6) & 0o7),
        triplet((mode >> 3) & 0o7),
        triplet(mode & 0o7),
    )
}

fn map_ssh(e: russh::Error) -> FtpError {
    FtpError::Protocol(format!("SSH error: {e}"))
}

fn map_sftp<E: std::fmt::Display>(e: E) -> FtpError {
    FtpError::Protocol(format!("SFTP error: {e}"))
}
