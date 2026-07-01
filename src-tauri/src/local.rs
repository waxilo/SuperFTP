//! Local-filesystem browsing for the sidebar's "Local" panel and as the
//! destination side of the remote → local "Send" action.
//!
//! Only the operations the UI actually needs are exposed: list a directory
//! and resolve the user's home directory. Heavy lifting (file transfers) is
//! handled by `transfer.rs`.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::transfer::ReadTextResult;

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

/// List the contents of `path`. Hides hidden files (dot-prefixed) — they
/// clutter the sidebar and the user can still navigate into them by typing
/// the full path elsewhere.
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
        if name.starts_with('.') {
            continue;
        }

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
        entries.push(LocalEntry {
            name,
            path: normalize_path(&abs),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
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

/// Convert a path to a UTF-8 string with forward slashes. On Windows the
/// `\\?\` extended-length prefix is stripped because the UI displays the
/// path verbatim and the prefix looks alarming to users.
pub fn normalize_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    s.replace('\\', "/")
}
