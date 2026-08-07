use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use suppaftp::list::{File as FtpFile, PosixPexQuery};
use suppaftp::tokio::AsyncFtpStream;
use suppaftp::types::Mode;
use tauri::{AppHandle, Emitter, Manager};
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

/// How often an idle session gets a liveness probe.
///
/// FTP servers commonly close an idle control connection somewhere between
/// two and ten minutes in, and NAT devices in between often drop a silent
/// mapping even sooner. A minute sits comfortably inside both, and a NOOP
/// costs one line of traffic.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);

/// Events pushed to the frontend when the backend has to repair a session, so
/// the UI can say what's happening instead of just appearing to hang. Payload
/// is [`ReconnectEvent`] in all three cases.
pub const EVENT_RECONNECTING: &str = "session-reconnecting";
pub const EVENT_RECONNECTED: &str = "session-reconnected";
pub const EVENT_RECONNECT_FAILED: &str = "session-reconnect-failed";

#[derive(Debug, Clone, Serialize)]
pub struct ReconnectEvent {
    pub session_id: String,
    /// Why the reconnect failed. Only set on [`EVENT_RECONNECT_FAILED`].
    pub error: Option<String>,
}

/// Session pool. Each entry is keyed by a server-generated UUID handed back
/// to the frontend on a successful connect.
///
/// The id outlives the underlying socket: when a link dies it's rebuilt in
/// place, so the frontend never has to learn a new id.
#[derive(Default)]
pub struct FtpState {
    pub sessions: Mutex<HashMap<String, Session>>,
    /// Set once during `setup`, so the reconnect path and the keepalive task
    /// can push events without an `AppHandle` being threaded through every
    /// command signature.
    app: std::sync::OnceLock<AppHandle>,
}

impl FtpState {
    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    fn emit(&self, event: &str, session_id: &str, error: Option<String>) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                event,
                ReconnectEvent {
                    session_id: session_id.to_string(),
                    error,
                },
            );
        }
    }
}

/// A live remote connection plus everything needed to rebuild it.
///
/// Servers hang up on idle clients and NATs drop silent sockets, so a session
/// that looked fine five minutes ago is often dead by the time the user clicks
/// again. Keeping the credentials and the last known directory here lets a
/// dead link be replaced underneath the same `session_id`, which is what makes
/// the reconnect invisible to the frontend.
pub struct Session {
    conn: Connection,
    /// The parameters this session was opened with, replayed on reconnect.
    request: ConnectRequest,
    /// Directory the session was last known to be in. Restored after a
    /// reconnect so the replayed command resolves paths the same way.
    cwd: String,
    /// When this session last ran a command, so the keepalive can leave
    /// recently used sessions alone.
    last_used: Instant,
}

/// One concrete remote link. The variants carry whatever the backend needs to
/// talk to the server; the dispatcher below uses a single match to route every
/// public command.
pub enum Connection {
    Ftp(AsyncFtpStream),
    Sftp(SftpHolder),
}

impl Session {
    fn new(conn: Connection, request: ConnectRequest, cwd: String) -> Self {
        Self {
            conn,
            request,
            cwd,
            last_used: Instant::now(),
        }
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    /// Record the directory a successful command landed in, so a later
    /// reconnect can put us back there.
    pub fn remember_cwd(&mut self, cwd: &str) {
        if !cwd.is_empty() {
            self.cwd = cwd.to_string();
        }
    }

    /// Dial the server again with the saved credentials and return to the
    /// remembered directory.
    ///
    /// The dead connection is dropped without a QUIT: the peer is already
    /// gone, so waiting for a reply that will never arrive would add a socket
    /// timeout to every reconnect.
    async fn reconnect(&mut self) -> FtpResult<()> {
        let wanted = self.cwd.clone();
        let (conn, landed, _welcome) = dial(&self.request).await?;
        // Assigning replaces (and therefore drops) the old connection.
        self.conn = conn;
        self.cwd = landed;
        self.last_used = Instant::now();

        if !wanted.is_empty() && wanted != self.cwd {
            // Best-effort: the directory may have been renamed or removed
            // while we were away. Staying at the login directory is better
            // than claiming to be somewhere we aren't — the caller's own
            // command will report the missing path.
            let restored = match &mut self.conn {
                Connection::Ftp(stream) => change_dir_ftp(stream, &wanted).await,
                Connection::Sftp(holder) => sftp::change_dir(holder, &wanted).await,
            };
            if let Ok(actual) = restored {
                self.cwd = actual;
            }
        }
        Ok(())
    }
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
    /// The link is gone, as opposed to the server refusing the command.
    ///
    /// Split out from `Protocol` because it's the one class of failure a
    /// reconnect can plausibly fix, so [`with_session`] retries it once.
    #[error("{0}")]
    Disconnected(String),
}

impl FtpError {
    /// Whether rebuilding the connection and replaying the command is worth a
    /// try.
    pub fn is_disconnected(&self) -> bool {
        matches!(self, FtpError::Disconnected(_))
    }
}

impl From<suppaftp::FtpError> for FtpError {
    fn from(value: suppaftp::FtpError) -> Self {
        let message = format_ftp_error(&value);
        if is_ftp_link_failure(&value) {
            FtpError::Disconnected(message)
        } else {
            FtpError::Protocol(message)
        }
    }
}

/// Does this failure mean the control connection is gone, rather than the
/// server having rejected the command?
///
/// The `BadResponse` case is the important one and isn't obvious: when a
/// server closes an idle connection, the next read returns zero bytes, which
/// the parser reports as a malformed reply rather than an I/O error. Treating
/// it as a live protocol error is exactly why an idle session used to need a
/// manual reconnect.
fn is_ftp_link_failure(err: &suppaftp::FtpError) -> bool {
    use suppaftp::FtpError as E;
    match err {
        // Socket level: reset, broken pipe, timeout, EOF mid-reply.
        E::ConnectionError(_) => true,
        // Empty or truncated reply — usually a closed socket (see above).
        E::BadResponse => true,
        E::UnexpectedResponse(resp) => matches!(
            resp.status.code(),
            // 421: service not available, closing control connection — what
            // an idle timeout looks like when the server is polite about it.
            // 425/426: the data channel failed or was cut, which on a stale
            // NAT mapping means the control link is suspect too.
            421 | 425 | 426
        ),
        _ => false,
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
        // Either the connection was closed under us, or this isn't an FTP
        // server at all — the classic case being an FTP client aimed at
        // port 22.
        E::BadResponse => "The server didn't send a valid FTP reply; \
            the connection may have been closed. If you meant to use SFTP, \
            switch the protocol on the connection."
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
// Session access with automatic repair
// ---------------------------------------------------------------------------

/// Run a command against a pooled session, rebuilding the connection and
/// replaying the command once if the link turned out to be dead.
///
/// The body receives `&mut Session` and must evaluate to `FtpResult<T>`. It is
/// expanded twice, so it has to be safe to run again from the top — which is
/// why every operation in this crate is written as a self-contained sequence
/// (CWD, then LIST, then act) instead of something that resumes mid-flight.
/// Repeating a delete or a copy is harmless for the same reason: both re-read
/// the directory before touching anything.
///
/// A failed reconnect surfaces its own error rather than the original one,
/// since "couldn't reach the server" is the more actionable message.
macro_rules! with_session {
    ($state:expr, $session_id:expr, |$session:ident| $body:block) => {{
        let state: &$crate::ftp::FtpState = $state;
        let session_id: &str = $session_id;
        let mut guard = state.sessions.lock().await;
        let $session: &mut $crate::ftp::Session = guard
            .get_mut(session_id)
            .ok_or_else(|| $crate::ftp::FtpError::SessionNotFound(session_id.to_string()))?;
        $session.touch();
        match $body {
            Ok(value) => Ok(value),
            Err(err) => {
                if err.is_disconnected() {
                    $crate::ftp::reconnect_session(state, session_id, $session).await?;
                    $body
                } else {
                    Err(err)
                }
            }
        }
    }};
}
pub(crate) use with_session;

/// Rebuild a session's connection, announcing each step to the frontend so a
/// slow reconnect reads as progress rather than a freeze.
pub(crate) async fn reconnect_session(
    state: &FtpState,
    session_id: &str,
    session: &mut Session,
) -> FtpResult<()> {
    state.emit(EVENT_RECONNECTING, session_id, None);
    match session.reconnect().await {
        Ok(()) => {
            state.emit(EVENT_RECONNECTED, session_id, None);
            Ok(())
        }
        Err(e) => {
            state.emit(EVENT_RECONNECT_FAILED, session_id, Some(e.to_string()));
            Err(e)
        }
    }
}

/// Background task that keeps idle sessions alive, and repairs the ones that
/// already died, so the user's next click doesn't pay for it.
///
/// This is the half of the fix that avoids the problem instead of recovering
/// from it: a NOOP every minute stops the server's idle timer from ever
/// expiring.
pub async fn keepalive_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(KEEPALIVE_INTERVAL).await;

        let state = app.state::<FtpState>();
        // A transfer in flight holds the lock and is keeping the link warm on
        // its own, so skip this round instead of queueing behind it.
        let Ok(mut sessions) = state.sessions.try_lock() else {
            continue;
        };

        for (id, session) in sessions.iter_mut() {
            if session.last_used.elapsed() < KEEPALIVE_INTERVAL {
                continue;
            }
            session.touch();
            let alive = match session.conn_mut() {
                Connection::Ftp(stream) => stream.noop().await.is_ok(),
                // russh sends SSH-level keepalives on its own (configured in
                // `sftp::connect`), so an idle SFTP session needs no poking
                // here. A dead one is still caught by the retry in
                // `with_session!`.
                Connection::Sftp(_) => true,
            };
            if !alive {
                let _ = reconnect_session(state.inner(), id, session).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatcher — every Tauri command routes through here.
// ---------------------------------------------------------------------------

pub async fn connect(state: &FtpState, req: ConnectRequest) -> FtpResult<ConnectResult> {
    let (conn, cwd, welcome) = dial(&req).await?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let mut sessions = state.sessions.lock().await;
    sessions.insert(session_id.clone(), Session::new(conn, req, cwd.clone()));

    Ok(ConnectResult {
        session_id,
        welcome,
        cwd,
    })
}

/// Open a connection without registering it. Shared by the initial connect and
/// by [`Session::reconnect`], so a rebuilt link is configured identically to
/// the original (passive mode, NAT workaround, and all).
///
/// Returns the connection, the directory it landed in, and the server's
/// greeting.
async fn dial(req: &ConnectRequest) -> FtpResult<(Connection, String, String)> {
    match req.protocol {
        Protocol::Ftp => dial_ftp(req).await,
        Protocol::Sftp => dial_sftp(req).await,
    }
}

pub async fn disconnect(state: &FtpState, session_id: &str) -> FtpResult<()> {
    let removed = {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(session_id)
    };
    match removed.map(|s| s.conn) {
        Some(Connection::Ftp(mut s)) => {
            let _ = s.quit().await;
        }
        Some(Connection::Sftp(holder)) => sftp::disconnect(holder).await,
        None => {}
    }
    Ok(())
}

pub async fn list_dir(state: &FtpState, session_id: &str, path: &str) -> FtpResult<ListResult> {
    with_session!(state, session_id, |s| {
        let result = match s.conn_mut() {
            Connection::Ftp(stream) => list_dir_ftp(stream, path).await,
            Connection::Sftp(holder) => sftp::list_dir(holder, path).await,
        };
        if let Ok(listing) = &result {
            s.remember_cwd(&listing.cwd);
        }
        result
    })
}

pub async fn change_dir(state: &FtpState, session_id: &str, path: &str) -> FtpResult<String> {
    with_session!(state, session_id, |s| {
        let result = match s.conn_mut() {
            Connection::Ftp(stream) => change_dir_ftp(stream, path).await,
            Connection::Sftp(holder) => sftp::change_dir(holder, path).await,
        };
        if let Ok(cwd) = &result {
            s.remember_cwd(cwd);
        }
        result
    })
}

// ---------------------------------------------------------------------------
// FTP backend
// ---------------------------------------------------------------------------

async fn dial_ftp(req: &ConnectRequest) -> FtpResult<(Connection, String, String)> {
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

    Ok((Connection::Ftp(stream), cwd, welcome))
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

pub(crate) fn parse_ftp_line(line: &str, cwd: &str) -> Option<FileEntry> {
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
// SFTP connect — thin wrapper around the helper in `sftp.rs`.
// ---------------------------------------------------------------------------

async fn dial_sftp(req: &ConnectRequest) -> FtpResult<(Connection, String, String)> {
    let (holder, cwd) = sftp::connect(&req.host, req.port, &req.username, &req.password).await?;
    Ok((
        Connection::Sftp(holder),
        cwd,
        // SSH doesn't really have an FTP-style banner. Surface the protocol
        // so the UI (which displays this in a tooltip / future log pane) has
        // something useful to show.
        format!("SFTP connected to {}", req.host),
    ))
}
