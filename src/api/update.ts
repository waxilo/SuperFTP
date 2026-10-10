import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** An update whose bytes are already on disk, waiting for one click to
 *  install and restart into. */
export interface ReadyUpdate {
  version: string;
  notes: string | null;
  installAndRestart: () => Promise<void>;
}

export interface DownloadProgress {
  received: number;
  total: number | null;
}

/**
 * Ask the updater endpoint for a newer release and, if one exists, download
 * it immediately ("silent" in the sense that the user never has to start it
 * — a debug/dev build always resolves to null, so dev runs stay quiet too).
 *
 * Returns the ready-to-install update, or null when the app is current.
 * `onProgress` fires for every downloaded chunk; the caller owns throttling
 * it into React state.
 */
export async function checkAndDownload(
  onProgress: (p: DownloadProgress) => void
): Promise<ReadyUpdate | null> {
  // A network blip or a not-yet-published latest.json must never surface as
  // an error toast in a feature that runs unattended at startup.
  let update: Update | null;
  try {
    update = await check();
  } catch {
    return null;
  }
  if (!update) return null;

  let installed = false;
  let received = 0;
  let total: number | null = null;
  const result = await update
    .downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        received = 0;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
      } else if (event.event === "Finished") {
        installed = true;
      }
      onProgress({ received, total });
    })
    .catch(() => null);
  if (!installed || !result) return null;

  return {
    version: update.version,
    notes: update.body || null,
    installAndRestart: async () => {
      // Windows runs the cached NSIS installer silently; macOS/Linux unpack
      // the new .app. Either way the new binary is only live after relaunch.
      await relaunch();
    },
  };
}
