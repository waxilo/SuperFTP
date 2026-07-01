import { invoke } from "@tauri-apps/api/core";

export interface LocalEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
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
};
