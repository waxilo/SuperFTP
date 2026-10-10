//! Local-filesystem browsing for the main pane and as the destination side
//! of the remote → local "Send" action.
//!
//! Mirrors the remote-side command surface (list, mkdir, create file,
//! rename, copy, delete, exists) so the context menu works identically on
//! either side. Heavy lifting (network transfers) is handled by
//! `transfer.rs`.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::transfer::{ExistsResult, ReadTextResult};

#[derive(thiserror::Error, Debug)]
pub enum LocalError {
    #[error("{0}")]
    Io(String),
    #[error("path not found: {0}")]
    NotFound(String),
}

impl From<std::io::Error> for LocalError {
    fn from(value: std::io::Error) -> Self {
        LocalError::Io(value.to_string())
    }
}

impl serde::Serialize for LocalError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type LocalResult<T> = std::result::Result<T, LocalError>;

/// A single directory entry. Kept separate from `ftp::FileEntry` because the
/// shapes differ (no permission strings on Windows, paths are OS-native, ...)
/// and conflating the two would force awkward Option fields downstream.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalEntry {
    pub name: String,
    /// Absolute path on the user's machine. Always serialized with forward
    /// slashes after normalization for predictable display in the UI.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    /// Dot-prefixed on every platform; additionally FILE_ATTRIBUTE_HIDDEN on
    /// Windows. Reported rather than filtered out — the UI owns whether
    /// hidden entries are displayed via its "Show hidden files" toggle.
    pub is_hidden: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalListResult {
    pub cwd: String,
    pub entries: Vec<LocalEntry>,
}

/// Resolve the user's home directory. Falls back to the current working
/// directory if `$HOME` / `%USERPROFILE%` isn't readable for any reason.
pub fn home_dir() -> String {
    let path = dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    normalize_path(&path)
}

/// Windows hides files two ways: a dot prefix (Unix convention) and the
/// FILE_ATTRIBUTE_HIDDEN bit (what Explorer's "Hidden" checkbox sets).
/// Entries matching either are reported `is_hidden` and filtered by the UI.
#[cfg(windows)]
fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    name.starts_with('.') || (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _meta: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

/// List the contents of `path`. Hidden entries are included and flagged
/// (`is_hidden`); the frontend decides whether to show them.
pub fn list_dir(path: &str) -> LocalResult<LocalListResult> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(LocalError::NotFound(path.to_string()));
    }
    let canon = p.canonicalize().unwrap_or(p);
    let cwd = normalize_path(&canon);

    let mut entries: Vec<LocalEntry> = Vec::new();
    for entry in std::fs::read_dir(&canon)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();

        // `metadata` can fail for symlinks pointing at nothing or items the
        // user has no read permission on; skip those rather than failing the
        // whole listing.
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| {
                DateTime::<Utc>::from(t)
                    .to_rfc3339()
                    .into()
            });

        let abs = entry.path();
        let hidden = is_hidden(&name, &meta);
        entries.push(LocalEntry {
            name,
            path: normalize_path(&abs),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
            is_hidden: hidden,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(LocalListResult { cwd, entries })
}

/// Read a local file and return its contents as text (UTF-8, lossy).
/// Anything past `max_bytes` is dropped so a misclick on a huge file
/// doesn't stall the UI thread. Mirrors the shape of `transfer::read_text`
/// so the frontend can render both through the same viewer.
pub fn read_text(path: &str, max_bytes: usize) -> LocalResult<ReadTextResult> {
    let bytes = std::fs::read(path)?;
    let size = bytes.len() as u64;
    let truncated = bytes.len() > max_bytes;
    let slice = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
    let content = String::from_utf8_lossy(slice).into_owned();
    Ok(ReadTextResult {
        content,
        size,
        truncated,
    })
}

/// Overwrite a local file with `content` (UTF-8). Mirrors
/// `transfer::write_text` so the in-app editor can save either side through
/// the same flow. Refuses directories outright; the caller is expected to
/// have read the file in full, since writing back a truncated preview would
/// throw away everything past the size cap.
///
/// Returns the number of bytes written.
pub fn write_text(path: &str, content: &str) -> LocalResult<u64> {
    let p = PathBuf::from(path);
    if p.is_dir() {
        return Err(LocalError::Io(format!("not a file: {path}")));
    }
    let bytes = content.as_bytes();
    std::fs::write(&p, bytes)?;
    Ok(bytes.len() as u64)
}

/// Delete a local path. Files use `remove_file`; directories are removed
/// recursively (with all contents) via `remove_dir_all`. The caller is
/// responsible for confirming the destructive action with the user before
/// dispatching this command.
pub fn delete_path(path: &str) -> LocalResult<()> {
    let p = PathBuf::from(path);
    let meta = std::fs::metadata(&p)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&p)?;
    } else {
        std::fs::remove_file(&p)?;
    }
    Ok(())
}

/// Create a single local directory. Fails if the path is already taken or
/// its parent doesn't exist — same strictness as the remote `mkdir`.
pub fn make_dir(path: &str) -> LocalResult<()> {
    std::fs::create_dir(path)?;
    Ok(())
}

/// Create an empty local file, refusing to touch an existing one
/// (`create_new`) so a typo'd name can't truncate real data.
pub fn make_file(path: &str) -> LocalResult<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    Ok(())
}

/// Move/rename a local entry. `to` is the full destination path. Backs both
/// the Rename menu action and "cut → paste" on the local side.
pub fn rename_path(from: &str, to: &str) -> LocalResult<()> {
    std::fs::rename(from, to)?;
    Ok(())
}

/// Copy a local entry to `to`, recursing into directories. Backs
/// "copy → paste" on the local side.
pub fn copy_path(from: &str, to: &str) -> LocalResult<()> {
    copy_recursive(Path::new(from), Path::new(to))?;
    Ok(())
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to)?;
        Ok(())
    }
}

/// Whether a local path already exists (and if so, whether it's a
/// directory). Mirrors `transfer::remote_exists` for the local paste flow.
pub fn exists(path: &str) -> LocalResult<ExistsResult> {
    let p = Path::new(path);
    let is_dir = p.is_dir();
    Ok(ExistsResult {
        exists: p.exists() || is_dir,
        is_dir,
    })
}

/// Convert a path to a UTF-8 string with forward slashes. On Windows the
/// `\\?\` extended-length prefix is stripped because the UI displays the
/// path verbatim and the prefix looks alarming to users.
pub fn normalize_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    s.replace('\\', "/")
}
