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

export const localApi = {
  home: () => invoke<string>("local_home"),
  list: (path: string) => invoke<LocalListResult>("local_list", { path }),
};
