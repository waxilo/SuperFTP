use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use suppaftp::list::{File as FtpFile, PosixPexQuery};
use suppaftp::tokio::AsyncFtpStream;
use suppaftp::types::Mode;
use tokio::sync::Mutex;

use crate::sftp::{self, SftpHolder};

/// Which wire protocol a connection profile uses. Defaults to plain FTP so
/// older saved profiles (written before SFTP support landed) keep working.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Ftp,
    Sftp,
}

/// Session pool. Each entry is keyed by a server-generated UUID handed back
/// to the frontend on a successful connect.
#[derive(Default)]
pub struct FtpState {
    pub sessions: Mutex<HashMap<String, Session>>,
}

/// One concrete remote connection. The variants carry whatever the backend
/// needs to keep the link alive; the dispatcher below uses a single match to
/// route every public command.
pub enum Session {
    Ftp(AsyncFtpStream),
    Sftp(SftpHolder),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectRequest {
    /// FTP or SFTP. Omitted by older clients, in which case we default to FTP.
    #[serde(default)]
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// FTP passive (PASV/EPSV) mode. Ignored for SFTP. Defaults to true.
    #[serde(default = "default_true")]
    pub passive: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectResult {
    pub session_id: String,
    pub welcome: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: usize,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Modified time in RFC3339 (UTC) if available
    pub modified: Option<String>,
    /// Unix-style permission string when provided by the server, e.g. "rwxr-xr-x"
    pub permissions: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListResult {
    pub cwd: String,
    pub entries: Vec<FileEntry>,
}

#[derive(thiserror::Error, Debug)]
pub enum FtpError {
    #[error("{0}")]
    Protocol(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
}

impl From<suppaftp::FtpError> for FtpError {
    fn from(value: suppaftp::FtpError) -> Self {
        FtpError::Protocol(format_ftp_error(&value))
    }
}

fn format_ftp_error(err: &suppaftp::FtpError) -> String {
    use suppaftp::FtpError as E;
    match err {
        // The server replied with a code we didn't expect. Surface the body so
        // it's actually debuggable instead of just saying "bad response".
        E::UnexpectedResponse(resp) => {
            let body = resp.as_string().unwrap_or_else(|_| "<non-utf8>".into());
            format!("Server replied {} {}", resp.status.code(), body.trim())
        }
        E::ConnectionError(e) => format!("Connection error: {e}"),
        // Most commonly seen when the user pointed an FTP client at port 22.
        E::BadResponse => "The server's response wasn't valid FTP. \
            If you meant to use SFTP, switch the protocol on the connection."
            .to_string(),
        other => other.to_string(),
    }
}

impl serde::Serialize for FtpError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type FtpResult<T> = std::result::Result<T, FtpError>;

// ---------------------------------------------------------------------------
// Dispatcher — every Tauri command routes through here.
// ---------------------------------------------------------------------------

pub async fn connect(state: &FtpState, req: ConnectRequest) -> FtpResult<ConnectResult> {
    match req.protocol {
        Protocol::Ftp => connect_ftp(state, req).await,
        Protocol::Sftp => connect_sftp(state, req).await,
    }
}

pub async fn disconnect(state: &FtpState, session_id: &str) -> FtpResult<()> {
    let removed = {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(session_id)
    };
    match removed {
        Some(Session::Ftp(mut s)) => {
            let _ = s.quit().await;
        }
        Some(Session::Sftp(holder)) => sftp::disconnect(holder).await,
        None => {}
    }
    Ok(())
}

pub async fn list_dir(state: &FtpState, session_id: &str, path: &str) -> FtpResult<ListResult> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;
    match session {
        Session::Ftp(stream) => list_dir_ftp(stream, path).await,
        Session::Sftp(holder) => sftp::list_dir(holder, path).await,
    }
}

pub async fn change_dir(state: &FtpState, session_id: &str, path: &str) -> FtpResult<String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| FtpError::SessionNotFound(session_id.to_string()))?;
    match session {
        Session::Ftp(stream) => change_dir_ftp(stream, path).await,
        Session::Sftp(holder) => sftp::change_dir(holder, path).await,
    }
}

// ---------------------------------------------------------------------------
// FTP backend
// ---------------------------------------------------------------------------

async fn connect_ftp(state: &FtpState, req: ConnectRequest) -> FtpResult<ConnectResult> {
    let address = format!("{}:{}", req.host, req.port);
    let mut stream = AsyncFtpStream::connect(address).await?;
    let welcome = stream.get_welcome_msg().unwrap_or_default().to_string();
    stream.login(&req.username, &req.password).await?;

    // Set data-transfer mode before any data command. Default to standard PASV
    // (PASV) which is supported by nearly every server. ExtendedPassive (EPSV)
    // is IPv6-friendly but many real-world servers don't speak it and respond
    // with a malformed reply that the parser rejects with "BadResponse".
    if req.passive {
        stream.set_mode(Mode::Passive);
        // Many FTP servers sit behind NAT and answer PASV with a private LAN
        // address that we can never reach. Replacing that with the control
        // connection's peer address (and just using the negotiated port) is
        // the standard fix used by GUI clients like FileZilla.
        stream.set_passive_nat_workaround(true);
    } else {
        stream.set_mode(Mode::Active);
    }

    // Some servers return a non-standard PWD reply on login (mismatched
    // quotes, extra bytes, ...). Fall back to "/" rather than failing the
    // whole connection attempt.
    let cwd = stream.pwd().await.unwrap_or_else(|_| "/".to_string());
    let session_id = uuid::Uuid::new_v4().to_string();

    let mut sessions = state.sessions.lock().await;
    sessions.insert(session_id.clone(), Session::Ftp(stream));

    Ok(ConnectResult {
        session_id,
        welcome,
        cwd,
    })
}

async fn list_dir_ftp(stream: &mut AsyncFtpStream, path: &str) -> FtpResult<ListResult> {
    // Some servers reject `LIST <path>` when the path doesn't exist or contains
    // spaces, so CWD into the target first and then issue LIST with no arg.
    if !path.is_empty() {
        stream.cwd(path).await?;
    }
    // PWD may fail (or return a non-UTF-8 body) on quirky servers — fall back
    // to the requested path so the row "Open" still produces something useful.
    let actual = stream.pwd().await.unwrap_or_else(|_| path.to_string());
    let raw_lines = stream.list(None).await?;

    let mut entries: Vec<FileEntry> = raw_lines
        .iter()
        .filter_map(|line| parse_ftp_line(line, &actual))
        // Hide the current and parent directory entries; the UI handles those.
        .filter(|entry| entry.name != "." && entry.name != "..")
        .collect();

    // Only group directories above files. We deliberately don't sort by
    // name here so the frontend's "default" state is distinguishable from
    // its explicit name-ascending sort. `sort_by` is stable, so the raw
    // server order within each group is preserved.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });

    Ok(ListResult {
        cwd: actual,
        entries,
    })
}

async fn change_dir_ftp(stream: &mut AsyncFtpStream, path: &str) -> FtpResult<String> {
    stream.cwd(path).await?;
    // pwd() is best-effort — fall back to whatever we requested.
    let cwd = stream.pwd().await.unwrap_or_else(|_| path.to_string());
    Ok(cwd)
}

fn parse_ftp_line(line: &str, cwd: &str) -> Option<FileEntry> {
    let parsed: Result<FtpFile, _> = line.parse();
    let Ok(file) = parsed else {
        return None;
    };

    let name = file.name().to_string();
    let path = join_path(cwd, &name);

    let modified: DateTime<Utc> = file.modified().into();

    Some(FileEntry {
        name,
        path,
        size: file.size(),
        is_dir: file.is_directory(),
        is_symlink: file.is_symlink(),
        modified: Some(modified.to_rfc3339()),
        permissions: Some(format_permissions(&file)),
    })
}

fn join_path(cwd: &str, name: &str) -> String {
    if cwd.ends_with('/') {
        format!("{cwd}{name}")
    } else {
        format!("{cwd}/{name}")
    }
}

fn format_permissions(file: &FtpFile) -> String {
    fn bits(r: bool, w: bool, x: bool) -> String {
        let mut s = String::with_capacity(3);
        s.push(if r { 'r' } else { '-' });
        s.push(if w { 'w' } else { '-' });
        s.push(if x { 'x' } else { '-' });
        s
    }
    let u = bits(
        file.can_read(PosixPexQuery::Owner),
        file.can_write(PosixPexQuery::Owner),
        file.can_execute(PosixPexQuery::Owner),
    );
    let g = bits(
        file.can_read(PosixPexQuery::Group),
        file.can_write(PosixPexQuery::Group),
        file.can_execute(PosixPexQuery::Group),
    );
    let o = bits(
        file.can_read(PosixPexQuery::Others),
        file.can_write(PosixPexQuery::Others),
        file.can_execute(PosixPexQuery::Others),
    );
    format!("{u}{g}{o}")
}

// ---------------------------------------------------------------------------
// SFTP connect — thin wrapper around the helper in `sftp.rs` that puts the
// resulting holder into the shared session pool.
// ---------------------------------------------------------------------------

async fn connect_sftp(state: &FtpState, req: ConnectRequest) -> FtpResult<ConnectResult> {
    let (holder, cwd) = sftp::connect(&req.host, req.port, &req.username, &req.password).await?;

    let session_id = uuid::Uuid::new_v4().to_string();
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id.clone(), Session::Sftp(holder));
    }

    Ok(ConnectResult {
        session_id,
        // SSH doesn't really have an FTP-style banner. Surface the protocol
        // so the UI (which displays this in a tooltip / future log pane) has
        // something useful to show.
        welcome: format!("SFTP connected to {}", req.host),
        cwd,
    })
}
