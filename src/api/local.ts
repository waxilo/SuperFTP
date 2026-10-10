import { invoke } from "@tauri-apps/api/core";
import type { ExistsResult } from "./ftp";

export interface LocalEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  /** Dot-prefixed, or FILE_ATTRIBUTE_HIDDEN on Windows. The UI filters on
   *  it — the backend no longer hides these itself. */
  is_hidden: boolean;
}

export interface LocalListResult {
  cwd: string;
  entries: LocalEntry[];
}

export interface LocalReadTextResult {
  content: string;
  size: number;
  truncated: boolean;
}

export const localApi = {
  home: () => invoke<string>("local_home"),
  list: (path: string) => invoke<LocalListResult>("local_list", { path }),
  /** Read a local file as text (UTF-8 lossy), capped at `maxBytes`
   *  (defaults to 4 MiB in the backend). */
  readText: (path: string, maxBytes?: number) =>
    invoke<LocalReadTextResult>("local_read_text", { path, maxBytes }),
  /** Overwrite a local file with `content` (UTF-8). Returns the number of
   *  bytes written. Only safe for files that were read in full. */
  writeText: (path: string, content: string) =>
    invoke<number>("local_write_text", { path, content }),
  /** Delete a local path. Files are removed directly; directories are
   *  removed recursively with all their contents. */
  delete: (path: string) => invoke<void>("local_delete", { path }),
  /** Create a local directory. Fails if the path is already taken. */
  mkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  /** Create an empty local file. Fails if the path already exists. */
  createFile: (path: string) => invoke<void>("local_create_file", { path }),
  /** Move/rename a local entry. `to` is the full destination path. Backs
   *  the Rename action and local "cut → paste". */
  rename: (from: string, to: string) =>
    invoke<void>("local_rename", { from, to }),
  /** Copy a local entry to `to`, recursing into directories. Backs local
   *  "copy → paste". */
  copy: (from: string, to: string) => invoke<void>("local_copy", { from, to }),
  /** Whether a local path already exists (and if so, whether it's a
   *  directory). Used to detect name clashes before a paste/rename lands. */
  exists: (path: string) => invoke<ExistsResult>("local_exists", { path }),
};
