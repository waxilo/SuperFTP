/** Wire protocol used by a saved connection. */
export type Protocol = "ftp" | "sftp";

/** Saved connection profile. Stored persistently via tauri-plugin-store. */
export interface ConnectionProfile {
  id: string;
  /** "ftp" (default) or "sftp". Older saved profiles may lack this field; the
   *  store loader fills it in as "ftp" so existing connections keep working. */
  protocol: Protocol;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** FTP passive (PASV) mode. Ignored for SFTP. */
  passive: boolean;
}

export interface ConnectResult {
  session_id: string;
  welcome: string;
  cwd: string;
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_symlink: boolean;
  modified: string | null;
  permissions: string | null;
  /** Local listings only: dot-prefixed, or Windows hidden attribute. The
   *  "Show hidden files" toggle filters on it client-side; remote entries
   *  leave it unset (servers already decided what to list). */
  is_hidden?: boolean;
}
