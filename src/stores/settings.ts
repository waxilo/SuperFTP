import { load, Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
const LAST_LOCAL_PATH = "lastLocalPath";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) {
    // `autoSave: true` flushes changes to disk on every set/save call.
    storePromise = load(FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}

/** The local folder the browser was left on, or `null` on a first run. */
export async function loadLastLocalPath(): Promise<string | null> {
  const store = await getStore();
  return (await store.get<string>(LAST_LOCAL_PATH)) ?? null;
}

export async function saveLastLocalPath(path: string): Promise<void> {
  const store = await getStore();
  await store.set(LAST_LOCAL_PATH, path);
  await store.save();
}
