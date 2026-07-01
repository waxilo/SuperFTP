mod ftp;
mod local;
mod sftp;
mod transfer;

use tauri::State;

use crate::ftp::{ConnectRequest, ConnectResult, FtpResult, FtpState, ListResult};
use crate::local::{LocalListResult, LocalResult};
use crate::transfer::ReadTextResult;

#[tauri::command]
async fn ftp_connect(
    state: State<'_, FtpState>,
    request: ConnectRequest,
) -> FtpResult<ConnectResult> {
    ftp::connect(state.inner(), request).await
}

#[tauri::command]
async fn ftp_disconnect(state: State<'_, FtpState>, session_id: String) -> FtpResult<()> {
    ftp::disconnect(state.inner(), &session_id).await
}

#[tauri::command]
async fn ftp_list(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
) -> FtpResult<ListResult> {
    ftp::list_dir(state.inner(), &session_id, &path).await
}

#[tauri::command]
async fn ftp_cd(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
) -> FtpResult<String> {
    ftp::change_dir(state.inner(), &session_id, &path).await
}

#[tauri::command]
async fn ftp_download(
    state: State<'_, FtpState>,
    session_id: String,
    remote_path: String,
    local_dir: String,
) -> FtpResult<String> {
    transfer::download(state.inner(), &session_id, &remote_path, &local_dir).await
}

/// Download a remote file into a private temp folder and hand the local path
/// back to the UI, which then asks the OS to open it with its default app.
#[tauri::command]
async fn ftp_open_temp(
    state: State<'_, FtpState>,
    session_id: String,
    remote_path: String,
) -> FtpResult<String> {
    transfer::download_to_temp(state.inner(), &session_id, &remote_path).await
}

/// Download a remote file and return its content as text, capped at
/// `max_bytes` (defaults to 4 MiB) so a misclick on a huge file doesn't
/// freeze the renderer.
#[tauri::command]
async fn ftp_read_text(
    state: State<'_, FtpState>,
    session_id: String,
    remote_path: String,
    max_bytes: Option<usize>,
) -> FtpResult<ReadTextResult> {
    let cap = max_bytes.unwrap_or(4 * 1024 * 1024);
    transfer::read_text(state.inner(), &session_id, &remote_path, cap).await
}

#[tauri::command]
fn local_home() -> String {
    local::home_dir()
}

#[tauri::command]
fn local_list(path: String) -> LocalResult<LocalListResult> {
    local::list_dir(&path)
}

/// Read a local file as text (capped at `max_bytes`, defaulting to 4 MiB).
#[tauri::command]
fn local_read_text(path: String, max_bytes: Option<usize>) -> LocalResult<ReadTextResult> {
    let cap = max_bytes.unwrap_or(4 * 1024 * 1024);
    local::read_text(&path, cap)
}

/// Upload a local file into `remote_dir` on the active session. Returns
/// the resolved remote path that was written.
#[tauri::command]
async fn ftp_upload(
    state: State<'_, FtpState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
) -> FtpResult<String> {
    transfer::upload(state.inner(), &session_id, &local_path, &remote_dir).await
}

/// Delete a remote entry. Files are removed directly; directories are
/// removed recursively. The frontend passes `is_dir` since it already knows
/// from the right-clicked entry.
#[tauri::command]
async fn ftp_delete(
    state: State<'_, FtpState>,
    session_id: String,
    remote_path: String,
    is_dir: bool,
) -> FtpResult<()> {
    transfer::delete_remote(state.inner(), &session_id, &remote_path, is_dir).await
}

/// Delete a local path (file or directory, recursive for directories).
#[tauri::command]
fn local_delete(path: String) -> LocalResult<()> {
    local::delete_path(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(FtpState::default())
        .invoke_handler(tauri::generate_handler![
            ftp_connect,
            ftp_disconnect,
            ftp_list,
            ftp_cd,
            ftp_download,
            ftp_upload,
            ftp_delete,
            ftp_open_temp,
            ftp_read_text,
            local_home,
            local_list,
            local_read_text,
            local_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
