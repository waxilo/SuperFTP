import { invoke } from "@tauri-apps/api/core";
import type { ConnectResult, FileEntry, Protocol } from "../types";

export interface ConnectRequest {
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  password: string;
  passive: boolean;
}

export interface ListResult {
  cwd: string;
  entries: FileEntry[];
}

export interface ReadTextResult {
  /** Decoded content (UTF-8, lossy). Capped at the requested `maxBytes`. */
  content: string;
  /** Total size of the remote file in bytes, before truncation. */
  size: number;
  /** True when the file was larger than `maxBytes` and only the leading
   *  slice was returned. */
  truncated: boolean;
}

export const ftpApi = {
  connect: (request: ConnectRequest) =>
    invoke<ConnectResult>("ftp_connect", { request }),
  disconnect: (sessionId: string) =>
    invoke<void>("ftp_disconnect", { sessionId }),
  list: (sessionId: string, path: string) =>
    invoke<ListResult>("ftp_list", { sessionId, path }),
  cd: (sessionId: string, path: string) =>
    invoke<string>("ftp_cd", { sessionId, path }),
  /** Download a remote file into a local directory. Returns the absolute
   *  local path that was written. */
  download: (sessionId: string, remotePath: string, localDir: string) =>
    invoke<string>("ftp_download", { sessionId, remotePath, localDir }),
  /** Download a remote file into a private temp folder and return the
   *  absolute local path. Used by the "Open" action. */
  openTemp: (sessionId: string, remotePath: string) =>
    invoke<string>("ftp_open_temp", { sessionId, remotePath }),
  /** Upload a local file into `remoteDir` on the active session. Returns
   *  the resolved remote path that was written. */
  upload: (sessionId: string, localPath: string, remoteDir: string) =>
    invoke<string>("ftp_upload", { sessionId, localPath, remoteDir }),
  /** Delete a remote path. Files are removed directly; directories are
   *  removed recursively with all their contents. */
  delete: (sessionId: string, remotePath: string, isDir: boolean) =>
    invoke<void>("ftp_delete", { sessionId, remotePath, isDir }),
  /** Fetch a remote file's content as text (UTF-8 lossy), capped at
   *  `maxBytes` (defaults to 4 MiB in the backend). */
  readText: (sessionId: string, remotePath: string, maxBytes?: number) =>
    invoke<ReadTextResult>("ftp_read_text", {
      sessionId,
      remotePath,
      maxBytes,
    }),
};
