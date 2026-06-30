import { load, Store } from "@tauri-apps/plugin-store";
import type { ConnectionProfile } from "../types";

const FILE = "connections.json";
const KEY = "profiles";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) {
    // `autoSave: true` flushes changes to disk on every set/save call.
    storePromise = load(FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}

/** Forward-compat shim: profiles written before SFTP support didn't have a
 *  `protocol` field. Treat them as plain FTP so the user doesn't have to
 *  re-create their saved connections. */
function migrate(profile: Partial<ConnectionProfile> & { id: string }): ConnectionProfile {
  return {
    id: profile.id,
    protocol: profile.protocol === "sftp" ? "sftp" : "ftp",
    name: profile.name ?? "",
    host: profile.host ?? "",
    port: profile.port ?? 21,
    username: profile.username ?? "anonymous",
    password: profile.password ?? "",
    passive: profile.passive ?? true,
  };
}

export async function loadProfiles(): Promise<ConnectionProfile[]> {
  const store = await getStore();
  const value = await store.get<ConnectionProfile[]>(KEY);
  return (value ?? []).map(migrate);
}

export async function saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY, profiles);
  await store.save();
}

export function createId(): string {
  // crypto.randomUUID is available in modern WebViews (Tauri 2 / WebView2 / WKWebView)
  return crypto.randomUUID();
}

export function emptyProfile(): ConnectionProfile {
  return {
    id: createId(),
    protocol: "ftp",
    name: "",
    host: "",
    port: 21,
    username: "anonymous",
    password: "",
    passive: true,
  };
}
