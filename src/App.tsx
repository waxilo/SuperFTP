import { useCallback, useEffect, useMemo, useState } from "react";
import { FilePlus, FolderPlus, Loader2, RefreshCcw } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import "./App.css";
import { Sidebar } from "./components/Sidebar";
import { LocalBrowser } from "./components/LocalBrowser";
import { ConnectionForm } from "./components/ConnectionForm";
import { Breadcrumb } from "./components/Breadcrumb";
import { FilterBar } from "./components/FilterBar";
import { FileList } from "./components/FileList";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { PromptDialog } from "./components/PromptDialog";
import { TextViewer } from "./components/TextViewer";
import { Toast } from "./components/Toast";

import { ftpApi } from "./api/ftp";
import { localApi, type LocalEntry } from "./api/local";
import {
  emptyProfile,
  loadProfiles,
  saveProfiles,
} from "./stores/connections";
import type { ConnectionProfile, FileEntry } from "./types";
import { matchesFilter } from "./utils/filter";

type DialogState =
  | { kind: "closed" }
  | { kind: "add" }
  | { kind: "edit"; profile: ConnectionProfile };

interface Session {
  profileId: string;
  sessionId: string;
  cwd: string;
}

interface MenuState {
  x: number;
  y: number;
  /** `null` when the menu was opened on empty space rather than a row, in
   *  which case only directory-level actions (Paste) are offered. */
  entry: FileEntry | null;
}

/** What Copy / Cut put aside for a later Paste. Holds the entries themselves
 *  (not just their paths) so we know their names and whether they're
 *  directories without another round trip — and so the source rows can be
 *  dimmed while cut. Always non-empty. */
interface Clipboard {
  mode: "copy" | "cut";
  entries: FileEntry[];
}

interface LocalMenuState {
  x: number;
  y: number;
  entry: LocalEntry;
}

/** Drives the "New Folder" / "New File" dialog. `busy` and `error` are held
 *  here (rather than inside the dialog) because the create round trip lives
 *  in App — that way a name clash can be shown without closing the dialog. */
interface CreateDialogState {
  kind: "dir" | "file";
  /** Remote directory the new entry goes into. */
  destDir: string;
  busy: boolean;
  error: string | null;
}

interface ViewerState {
  /** Remote filename used as the modal title. */
  name: string;
  /** Decoded text, or `null` while the fetch is in flight. */
  content: string | null;
  /** Set when the fetch failed; rendered as a banner in the modal. */
  error: string | null;
  truncated: boolean;
  size: number;
}

function parentOf(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/** Join a remote directory and a basename with exactly one separator.
 *  Remote paths are always POSIX-style, even when the app runs on Windows. */
function joinRemote(dir: string, name: string): string {
  if (!dir || dir === "/") return `/${name}`;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Split a filename into `[stem, extension]` so a copy suffix lands before
 *  the extension ("notes copy.txt", not "notes.txt copy"). Dotfiles have no
 *  extension by this definition, so ".bashrc" stays whole. */
function splitExtension(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

/** Human label for a batch: the quoted name when there's exactly one entry,
 *  a count otherwise. Keeps menu labels and status text readable whether the
 *  action targets one file or twenty. */
function describeBatch(entries: FileEntry[]): string {
  if (entries.length === 1) return `"${entries[0].name}"`;
  return `${entries.length} items`;
}

/** Inline validation for a new remote folder/file name. Returns a message to
 *  show under the input, or `null` when the name is usable.
 *
 *  Remote paths are POSIX, so a slash would silently create (or overwrite)
 *  something in a different directory than the one the dialog claims, and the
 *  dot names are reserved. The dialog trims before validating, so surrounding
 *  whitespace needs no rule of its own. */
function validateRemoteName(name: string): string | null {
  if (name.includes("/")) return "A name can't contain a slash.";
  if (name === "." || name === "..") return "That name is reserved.";
  return null;
}

/** Find a free name for a copy landing next to its source: "notes copy.txt",
 *  then "notes copy 2.txt", and so on. Gives up after a sane number of tries
 *  rather than probing the server forever. */
async function uniqueRemoteName(
  sessionId: string,
  destDir: string,
  name: string,
): Promise<string> {
  const [stem, ext] = splitExtension(name);
  for (let i = 1; i <= 50; i += 1) {
    const candidate = i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
    const probe = await ftpApi.exists(sessionId, joinRemote(destDir, candidate));
    if (!probe.exists) return candidate;
  }
  throw new Error(`Couldn't find an unused name for a copy of "${name}".`);
}

export default function App() {
  // -- saved profiles persisted via tauri-plugin-store
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  // -- active remote session
  const [session, setSession] = useState<Session | null>(null);
  const [connecting, setConnecting] = useState(false);

  // -- remote directory browsing
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -- local directory browsing (sidebar bottom panel)
  const [localCwd, setLocalCwd] = useState<string>("");
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // -- right-click menu on a remote file row
  const [menu, setMenu] = useState<MenuState | null>(null);

  // -- remote row selection, so Ctrl+C / Ctrl+X / Delete have a target.
  // Paths rather than entries: a path is stable across a refresh, while an
  // entry object is replaced on every listing. Always confined to the
  // directory on screen, so `selectedEntries` can resolve it against
  // `entries`.
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  // The selected entries in listing order, so batch operations run in a
  // predictable sequence regardless of the order rows were clicked in.
  // Paths that vanished from the listing simply drop out.
  const selectedEntries = useMemo(
    () => entries.filter((e) => selectedSet.has(e.path)),
    [entries, selectedSet],
  );

  // -- copy/cut clipboard for remote entries
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  // Guards against a second paste starting while the first is still running;
  // a recursive copy over FTP can take a while and overlapping the two would
  // interleave commands on the single control connection.
  const [pasting, setPasting] = useState(false);

  // Rows to ghost because they're waiting to be moved by a paste.
  const cutPaths = useMemo(
    () =>
      new Set(
        clipboard?.mode === "cut" ? clipboard.entries.map((e) => e.path) : [],
      ),
    [clipboard],
  );

  // -- right-click menu on a local file row
  const [localMenu, setLocalMenu] = useState<LocalMenuState | null>(null);

  // -- in-app text preview of a remote file
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  // -- "New Folder" / "New File" dialog
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(
    null,
  );

  // -- filter (Ctrl+F)
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // -- transient status message (e.g. "Downloaded foo.csv")
  const [status, setStatus] = useState<string | null>(null);
  // Auto-dismiss is owned by the <Toast/> component so it can play a proper
  // exit transition before unmounting — driving it from an App-level
  // setTimeout+setState(null) removed the DOM the instant the timer fired,
  // which showed up as a "flash then jump" in the UI.

  // Suppress the browser's default context menu everywhere. The two file
  // lists (local sidebar bottom, remote right pane) install their own
  // `onContextMenu` handlers on file rows, which call `preventDefault` and
  // then show our custom menu — so they keep working. This global listener
  // only prevents the fallback browser menu from appearing on empty areas,
  // headers, breadcrumbs, banners, etc.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Load saved profiles on mount.
  useEffect(() => {
    loadProfiles()
      .then((p) => setProfiles(p))
      .catch((e) => setError(String(e)))
      .finally(() => setProfilesLoaded(true));
  }, []);

  // Persist profiles whenever they change (after initial load).
  useEffect(() => {
    if (!profilesLoaded) return;
    saveProfiles(profiles).catch((e) => setError(String(e)));
  }, [profiles, profilesLoaded]);

  // Initialize the local browser at the user's home directory once on mount.
  const refreshLocalAt = useCallback(async (path: string) => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const result = await localApi.list(path);
      setLocalEntries(result.entries);
      setLocalCwd(result.cwd || path);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    localApi
      .home()
      .then((home) => refreshLocalAt(home))
      .catch((e) => setLocalError(String(e)));
  }, [refreshLocalAt]);

  // Reveal the current local directory in the OS file manager (Explorer on
  // Windows, Finder on macOS). `openPath` accepts both files and directories.
  const openLocalCwd = useCallback(async () => {
    if (!localCwd) return;
    try {
      await openPath(localCwd);
    } catch (e) {
      setLocalError(String(e));
    }
  }, [localCwd]);

  const refreshAt = useCallback(
    async (sessionId: string, path: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await ftpApi.list(sessionId, path);
        setEntries(result.entries);
        // Drop selected paths the listing no longer has, so a batch action
        // can never target something that was moved or deleted out from
        // under it (by a paste, a delete, or another client).
        const alive = new Set(result.entries.map((e) => e.path));
        setSelectedPaths((prev) => {
          const next = prev.filter((p) => alive.has(p));
          return next.length === prev.length ? prev : next;
        });
        setSession((prev) =>
          prev ? { ...prev, cwd: result.cwd || path } : prev,
        );
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleConnect = useCallback(
    async (profile: ConnectionProfile) => {
      if (session) {
        try {
          await ftpApi.disconnect(session.sessionId);
        } catch {
          // ignore
        }
      }
      setConnecting(true);
      setError(null);
      setEntries([]);
      try {
        const result = await ftpApi.connect({
          protocol: profile.protocol,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          password: profile.password,
          passive: profile.passive,
        });
        const newSession: Session = {
          profileId: profile.id,
          sessionId: result.session_id,
          cwd: result.cwd || "/",
        };
        setSession(newSession);
        await refreshAt(newSession.sessionId, newSession.cwd);
      } catch (e) {
        setSession(null);
        setError(String(e));
      } finally {
        setConnecting(false);
      }
    },
    [refreshAt, session],
  );

  const handleDisconnect = useCallback(async () => {
    if (!session) return;
    try {
      await ftpApi.disconnect(session.sessionId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSession(null);
      setEntries([]);
      setFilter("");
      setFilterOpen(false);
      setSelectedPaths([]);
      setClipboard(null);
    }
  }, [session]);

  const navigateTo = useCallback(
    (path: string) => {
      if (!session) return;
      // Filtering is inherently per-directory — the query and match count
      // don't carry meaning after you leave the folder. Close the bar so it
      // doesn't linger over an unrelated listing. Filter text is kept so
      // Ctrl+F still restores the last query if the user wants it back.
      setFilterOpen(false);
      // The selection is path-based and meaningless in another directory.
      // The clipboard deliberately survives navigation — that's the whole
      // point of cut/copy here.
      setSelectedPaths([]);
      refreshAt(session.sessionId, path);
    },
    [refreshAt, session],
  );

  const goUp = useCallback(() => {
    if (!session) return;
    navigateTo(parentOf(session.cwd));
  }, [navigateTo, session]);

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        navigateTo(entry.path);
      }
    },
    [navigateTo],
  );

  const refresh = useCallback(() => {
    if (!session) return;
    refreshAt(session.sessionId, session.cwd);
  }, [refreshAt, session]);

  // Save / update / delete profiles.
  const handleSubmitProfile = useCallback((profile: ConnectionProfile) => {
    setProfiles((prev) => {
      const idx = prev.findIndex((p) => p.id === profile.id);
      if (idx === -1) return [...prev, profile];
      const next = [...prev];
      next[idx] = profile;
      return next;
    });
    setDialog({ kind: "closed" });
  }, []);

  const handleDeleteProfile = useCallback(
    (profile: ConnectionProfile) => {
      const ok = window.confirm(`Delete connection "${profile.name || profile.host}"?`);
      if (!ok) return;
      setProfiles((prev) => prev.filter((p) => p.id !== profile.id));
      if (session?.profileId === profile.id) {
        handleDisconnect();
      }
    },
    [handleDisconnect, session],
  );

  // ----- Send (download) -------------------------------------------------
  // Takes a batch so a multi-selection downloads in one go. Transfers run
  // one at a time: the session has a single control connection, so
  // overlapping them would interleave commands on it.
  const handleSend = useCallback(
    async (targets: FileEntry[]) => {
      if (!session || targets.length === 0) return;
      if (!localCwd) {
        setError("Pick a local folder first.");
        return;
      }
      const files = targets.filter((e) => !e.is_dir);
      const skippedDirs = targets.length - files.length;
      if (files.length === 0) {
        setError("Sending whole folders isn't supported yet.");
        return;
      }
      setError(null);
      const failures: string[] = [];
      let written = "";
      for (const [i, entry] of files.entries()) {
        setStatus(
          files.length > 1
            ? `Downloading ${i + 1}/${files.length}: ${entry.name}…`
            : `Downloading ${entry.name}…`,
        );
        try {
          written = await ftpApi.download(
            session.sessionId,
            entry.path,
            localCwd,
          );
        } catch (e) {
          failures.push(`${entry.name}: ${String(e)}`);
        }
      }
      const ok = files.length - failures.length;
      if (failures.length) {
        setError(
          `Failed to download ${failures.length} of ${files.length}:\n${failures.join("\n")}`,
        );
      }
      if (ok > 0) {
        setStatus(
          ok === 1 && !skippedDirs
            ? `Downloaded to ${written}`
            : `Downloaded ${ok} file${ok === 1 ? "" : "s"} to ${localCwd}${
                skippedDirs ? ` (skipped ${skippedDirs} folder(s))` : ""
              }`,
        );
      }
      // Refresh the local panel so the new files show up immediately.
      refreshLocalAt(localCwd);
    },
    [session, localCwd, refreshLocalAt],
  );

  // ----- Open with system default app ------------------------------------
  // Downloads the file into a private temp folder, then asks the OS to open
  // it with whatever application is registered for that file type. Folders
  // are excluded — the menu item disables itself for them anyway.
  const handleOpenDefault = useCallback(
    async (entry: FileEntry) => {
      if (!session || entry.is_dir) return;
      setError(null);
      setStatus(`Opening ${entry.name}…`);
      try {
        const localPath = await ftpApi.openTemp(session.sessionId, entry.path);
        await openPath(localPath);
        setStatus(`Opened ${entry.name}`);
      } catch (e) {
        setError(String(e));
      }
    },
    [session],
  );

  // ----- Open as text in the in-app viewer -------------------------------
  // Shows the modal immediately with a loading state so the user gets
  // feedback even on a slow link, then fills in the content (or error) when
  // the download resolves.
  const handleOpenAsText = useCallback(
    async (entry: FileEntry) => {
      if (!session || entry.is_dir) return;
      setError(null);
      setViewer({
        name: entry.name,
        content: null,
        error: null,
        truncated: false,
        size: 0,
      });
      try {
        const result = await ftpApi.readText(session.sessionId, entry.path);
        setViewer({
          name: entry.name,
          content: result.content,
          error: null,
          truncated: result.truncated,
          size: result.size,
        });
      } catch (e) {
        setViewer({
          name: entry.name,
          content: "",
          error: String(e),
          truncated: false,
          size: 0,
        });
      }
    },
    [session],
  );

  // The filter state persists across close/reopen, but must only actually
  // filter the list while the bar is visible. Everything downstream reads
  // this instead of `filter` directly.
  const effectiveFilter = filterOpen ? filter : "";

  // Rows the user can actually see. Ctrl+A selects exactly these, so a
  // filtered "select all" doesn't quietly rope in hidden entries.
  const visibleEntries = useMemo(
    () =>
      effectiveFilter.trim()
        ? entries.filter((e) => matchesFilter(e.name, effectiveFilter))
        : entries,
    [entries, effectiveFilter],
  );

  const matchedCount = visibleEntries.length;

  // Rows the filter hides must not stay selected — a batch delete acting on a
  // row that isn't on screen would be a nasty surprise. Also catches entries
  // that disappeared from the listing between refreshes.
  useEffect(() => {
    setSelectedPaths((prev) => {
      if (prev.length === 0) return prev;
      const visible = new Set(visibleEntries.map((e) => e.path));
      const next = prev.filter((p) => visible.has(p));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleEntries]);

  // ----- Local: open with system default app -----------------------------
  const handleOpenLocal = useCallback(async (entry: LocalEntry) => {
    setError(null);
    try {
      await openPath(entry.path);
      setStatus(`Opened ${entry.name}`);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // ----- Local: open as text in the in-app viewer -------------------------
  const handleOpenLocalAsText = useCallback(async (entry: LocalEntry) => {
    if (entry.is_dir) return;
    setError(null);
    setViewer({
      name: entry.name,
      content: null,
      error: null,
      truncated: false,
      size: 0,
    });
    try {
      const result = await localApi.readText(entry.path);
      setViewer({
        name: entry.name,
        content: result.content,
        error: null,
        truncated: result.truncated,
        size: result.size,
      });
    } catch (e) {
      setViewer({
        name: entry.name,
        content: "",
        error: String(e),
        truncated: false,
        size: 0,
      });
    }
  }, []);

  // ----- Delete remote entries -------------------------------------------
  // Confirmation via `window.confirm` is deliberately minimal; delete is
  // destructive but the user just picked the entries themselves, so a
  // heavier custom modal would feel out of place. Folders trigger a more
  // explicit "and all its contents" prompt since the backend recurses.
  //
  // A batch keeps going after a failure — stopping halfway would leave the
  // user guessing which of the twenty files actually went away — and reports
  // everything that didn't work at the end.
  const handleDeleteRemote = useCallback(
    async (targets: FileEntry[]) => {
      if (!session || targets.length === 0) return;
      const dirs = targets.filter((e) => e.is_dir).length;
      let prompt: string;
      if (targets.length === 1) {
        const only = targets[0];
        prompt = only.is_dir
          ? `Delete remote folder "${only.name}" and all its contents?\nThis cannot be undone.`
          : `Delete remote file "${only.name}"?`;
      } else {
        prompt =
          `Delete ${targets.length} selected remote items?` +
          (dirs
            ? `\nThis includes ${dirs} folder${dirs === 1 ? "" : "s"} and all their contents.`
            : "") +
          `\nThis cannot be undone.`;
      }
      if (!window.confirm(prompt)) return;

      setError(null);
      const failures: string[] = [];
      const deleted: string[] = [];
      for (const [i, entry] of targets.entries()) {
        if (targets.length > 1) {
          setStatus(`Deleting ${i + 1}/${targets.length}: ${entry.name}…`);
        }
        try {
          await ftpApi.delete(session.sessionId, entry.path, entry.is_dir);
          deleted.push(entry.path);
        } catch (e) {
          failures.push(`${entry.name}: ${String(e)}`);
        }
      }

      // Drop any reference to entries that just went away, so the clipboard
      // shortcuts can't act on a path the server no longer has.
      if (deleted.length) {
        const gone = new Set(deleted);
        setSelectedPaths((prev) => prev.filter((p) => !gone.has(p)));
        setClipboard((prev) => {
          if (!prev) return prev;
          const kept = prev.entries.filter((e) => !gone.has(e.path));
          return kept.length ? { ...prev, entries: kept } : null;
        });
        setStatus(
          deleted.length === 1 && targets.length === 1
            ? `Deleted ${targets[0].name}`
            : `Deleted ${deleted.length} item${deleted.length === 1 ? "" : "s"}`,
        );
      }
      if (failures.length) {
        setError(
          `Failed to delete ${failures.length} of ${targets.length}:\n${failures.join("\n")}`,
        );
      }
      refreshAt(session.sessionId, session.cwd);
    },
    [session, refreshAt],
  );

  // ----- Create a remote folder / file -----------------------------------
  // Opening the dialog is all this does; the work happens in submitCreate so
  // a name clash can be reported inside the dialog instead of closing it and
  // making the user start over.
  const handleCreateRemote = useCallback(
    (kind: "dir" | "file", destDir: string) => {
      if (!session) return;
      setCreateDialog({ kind, destDir, busy: false, error: null });
    },
    [session],
  );

  const submitCreate = useCallback(
    async (name: string) => {
      if (!session || !createDialog || createDialog.busy) return;
      const { kind, destDir } = createDialog;
      const target = joinRemote(destDir, name);

      setCreateDialog((d) => (d ? { ...d, busy: true, error: null } : d));
      try {
        // Creating a file would truncate an existing one, so refuse up front
        // rather than destroying data on a typo.
        const clash = await ftpApi.exists(session.sessionId, target);
        if (clash.exists) {
          setCreateDialog((d) =>
            d ? { ...d, busy: false, error: `"${name}" already exists here.` } : d,
          );
          return;
        }
        if (kind === "dir") {
          await ftpApi.mkdir(session.sessionId, target);
        } else {
          await ftpApi.createFile(session.sessionId, target);
        }
        setCreateDialog(null);
        setStatus(`Created ${target}`);
        refreshAt(session.sessionId, session.cwd);
      } catch (e) {
        // Keep the dialog open with the text intact so the user can adjust
        // the name and retry without retyping it.
        setCreateDialog((d) => (d ? { ...d, busy: false, error: String(e) } : d));
      }
    },
    [session, createDialog, refreshAt],
  );

  // ----- Copy / Cut / Paste on the remote side ---------------------------
  // Copy and Cut only stash the entries; nothing touches the server until a
  // Paste names a destination. Cut is implemented as a server-side rename at
  // paste time rather than "copy then delete", so a move never transfers
  // bytes and can't leave a half-written duplicate behind if it fails.
  // Batches run strictly one entry at a time: the session has a single
  // control connection, so overlapping transfers would interleave on it.
  const handleCopyRemote = useCallback((targets: FileEntry[]) => {
    if (targets.length === 0) return;
    setClipboard({ mode: "copy", entries: targets });
    setStatus(`Copied ${describeBatch(targets)} — paste into any folder`);
  }, []);

  const handleCutRemote = useCallback((targets: FileEntry[]) => {
    if (targets.length === 0) return;
    setClipboard({ mode: "cut", entries: targets });
    setStatus(`Cut ${describeBatch(targets)} — paste into any folder to move`);
  }, []);

  const handlePasteRemote = useCallback(
    async (destDir: string) => {
      if (!session || !clipboard || pasting) return;
      const { entries: sources, mode } = clipboard;
      if (sources.length === 0) return;

      // Weed out entries that can't land here before touching the server, so
      // one impossible item doesn't abort the rest of the batch.
      const skipped: string[] = [];
      const sinks = sources.filter((src) => {
        // A directory can't contain itself. Without this a recursive copy
        // would spiral until the server ran out of something.
        if (
          src.is_dir &&
          (destDir === src.path || destDir.startsWith(`${src.path}/`))
        ) {
          skipped.push(`"${src.name}" can't be pasted into itself`);
          return false;
        }
        // Moving something to where it already is has no meaning; treat it as
        // a no-op rather than prompting about a name clash with itself.
        if (mode === "cut" && parentOf(src.path) === destDir) {
          skipped.push(`"${src.name}" is already in this folder`);
          return false;
        }
        return true;
      });

      if (sinks.length === 0) {
        // Nothing to do — report why and spend the cut so the ghosted rows
        // don't linger.
        setStatus(skipped.join("; "));
        if (mode === "cut") setClipboard(null);
        return;
      }

      setPasting(true);
      setError(null);
      const failures: string[] = [];
      // Sources a cut couldn't move; they stay on the clipboard so the user
      // can retry them without re-selecting.
      const unmoved: FileEntry[] = [];
      let lastTarget = "";
      let done = 0;

      try {
        for (const [i, src] of sinks.entries()) {
          const verb = mode === "copy" ? "Copying" : "Moving";
          setStatus(
            sinks.length > 1
              ? `${verb} ${i + 1}/${sinks.length}: ${src.name}…`
              : src.is_dir
                ? `${verb} folder "${src.name}"…`
                : `${verb} "${src.name}"…`,
          );
          try {
            let name = src.name;
            let target = joinRemote(destDir, name);

            const clash = await ftpApi.exists(session.sessionId, target);
            if (clash.exists) {
              if (mode === "copy") {
                // Pasting a copy next to the original is the common case, so
                // auto-renaming beats interrupting with a dialog.
                name = await uniqueRemoteName(session.sessionId, destDir, name);
                target = joinRemote(destDir, name);
              } else {
                // A move over an existing entry is destructive, so ask. Both
                // FTP and SFTP refuse to rename onto an existing path, hence
                // the explicit delete first.
                const ok = window.confirm(
                  `"${name}" already exists in ${destDir}.\nReplace it?`,
                );
                if (!ok) {
                  skipped.push(`"${name}" kept as-is`);
                  unmoved.push(src);
                  continue;
                }
                await ftpApi.delete(session.sessionId, target, clash.is_dir);
              }
            }

            if (mode === "copy") {
              await ftpApi.copy(session.sessionId, src.path, target, src.is_dir);
            } else {
              await ftpApi.rename(session.sessionId, src.path, target);
            }
            lastTarget = target;
            done += 1;
          } catch (e) {
            failures.push(`${src.name}: ${String(e)}`);
            unmoved.push(src);
          }
        }

        if (done > 0) {
          const what = done === 1 ? lastTarget : `${done} items into ${destDir}`;
          setStatus(mode === "copy" ? `Copied to ${what}` : `Moved to ${what}`);
        } else if (skipped.length) {
          setStatus(skipped.join("; "));
        }
        if (failures.length) {
          setError(
            `Failed to paste ${failures.length} of ${sinks.length}:\n${failures.join("\n")}`,
          );
        }
        // A cut is spent once pasted, except for entries that didn't make it
        // — those stay armed. A copy always stays on the clipboard so it can
        // be pasted into several folders in a row.
        if (mode === "cut") {
          setClipboard(
            unmoved.length ? { mode: "cut", entries: unmoved } : null,
          );
        }
        refreshAt(session.sessionId, session.cwd);
      } finally {
        setPasting(false);
      }
    },
    [session, clipboard, pasting, refreshAt],
  );

  // Keyboard shortcuts. Defined after the remote clipboard handlers because
  // the dependency array references them.
  //
  // Ctrl+C / Ctrl+X / Ctrl+V drive the remote clipboard. Ctrl+F opens the
  // filter, F5 refreshes the current listing. Esc is a stacked-modal close:
  // viewer first, then any open right-click menu, then the filter bar.
  // Closing the filter keeps the current filter text so reopening (Ctrl+F)
  // restores it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The create dialog is modal: it handles its own Enter/Escape, and no
      // app-level shortcut should fire behind it.
      if (createDialog) return;

      // Never hijack keys while the user is typing in a field or reading the
      // text viewer — Ctrl+C there means "copy this text", not "copy a file".
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);

      // Copy/Cut act on the selected rows; Paste targets the directory
      // currently on screen; Ctrl+A selects every visible row.
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !typing && !viewer && session) {
        const key = e.key.toLowerCase();
        // Leave Ctrl+C alone when there's a text selection to copy.
        const hasTextSelection = !!window.getSelection()?.toString();
        if (key === "a") {
          // Always preventDefault: the webview's own "select all text" is
          // never what someone wants in a file listing.
          e.preventDefault();
          setSelectedPaths(visibleEntries.map((en) => en.path));
          return;
        }
        if (key === "c" && selectedEntries.length && !hasTextSelection) {
          e.preventDefault();
          handleCopyRemote(selectedEntries);
          return;
        }
        if (key === "x" && selectedEntries.length) {
          e.preventDefault();
          handleCutRemote(selectedEntries);
          return;
        }
        if (key === "v" && clipboard) {
          e.preventDefault();
          handlePasteRemote(session.cwd);
          return;
        }
      }

      // Delete removes the whole selection, matching the context menu.
      if (
        e.key === "Delete" &&
        !typing &&
        !viewer &&
        !mod &&
        session &&
        !pasting &&
        selectedEntries.length
      ) {
        e.preventDefault();
        handleDeleteRemote(selectedEntries);
        return;
      }

      const isFind = mod && e.key.toLowerCase() === "f";
      if (isFind) {
        if (!session) return;
        e.preventDefault();
        setFilterOpen(true);
        return;
      }
      // F5 / Ctrl+R → refresh the remote listing. Preventing default keeps
      // the browser from reloading the whole webview, which would drop the
      // session state.
      const isRefresh = e.key === "F5" || (mod && e.key.toLowerCase() === "r");
      if (isRefresh) {
        e.preventDefault();
        if (!session || loading) return;
        refreshAt(session.sessionId, session.cwd);
        return;
      }
      if (e.key !== "Escape") return;

      if (viewer) {
        setViewer(null);
      } else if (menu) {
        setMenu(null);
      } else if (localMenu) {
        setLocalMenu(null);
      } else if (filterOpen) {
        setFilterOpen(false);
      } else if (selectedPaths.length) {
        // Last rung of the ladder: nothing left to close, so drop the
        // selection.
        setSelectedPaths([]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    filterOpen,
    session,
    viewer,
    menu,
    localMenu,
    createDialog,
    loading,
    pasting,
    refreshAt,
    selectedPaths,
    selectedEntries,
    visibleEntries,
    clipboard,
    handleCopyRemote,
    handleCutRemote,
    handlePasteRemote,
    handleDeleteRemote,
  ]);

  // ----- Delete a local entry --------------------------------------------
  const handleDeleteLocal = useCallback(
    async (entry: LocalEntry) => {
      const prompt = entry.is_dir
        ? `Delete local folder "${entry.name}" and all its contents?\nThis cannot be undone.`
        : `Delete local file "${entry.name}"?`;
      const ok = window.confirm(prompt);
      if (!ok) return;
      setLocalError(null);
      try {
        await localApi.delete(entry.path);
        setStatus(`Deleted ${entry.name}`);
        if (localCwd) refreshLocalAt(localCwd);
      } catch (e) {
        setLocalError(String(e));
      }
    },
    [localCwd, refreshLocalAt],
  );

  // ----- Local → remote upload -------------------------------------------
  // Uses the remote session's current directory as the destination, matching
  // how the remote → local "Send" action uses the local panel's cwd.
  const handleUpload = useCallback(
    async (entry: LocalEntry) => {
      if (!session) {
        setError("Not connected to a server.");
        return;
      }
      if (entry.is_dir) {
        setError("Uploading whole folders isn't supported yet.");
        return;
      }
      setError(null);
      try {
        const written = await ftpApi.upload(session.sessionId, entry.path, session.cwd);
        setStatus(`Uploaded to ${written}`);
        // Refresh the remote panel so the new file appears immediately.
        refreshAt(session.sessionId, session.cwd);
      } catch (e) {
        setError(String(e));
      }
    },
    [session, refreshAt],
  );

  // Build the context menu items lazily so the destination is always up-to-
  // date when the user clicks (they may have navigated locally first).
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu || !session) return [];
    const target = localCwd || "(no folder)";
    const entry = menu.entry;

    // What the batch actions act on. Right-clicking a row inside the current
    // multi-selection keeps the whole batch; right-clicking outside it makes
    // the clicked row the selection (done in the FileList handler below), so
    // `selectedEntries` is the batch either way. The `[entry]` fallback covers
    // the render before that retarget lands.
    const targets =
      entry && selectedSet.has(entry.path) && selectedEntries.length
        ? selectedEntries
        : entry
          ? [entry]
          : [];
    const batch = targets.length > 1;
    const batchLabel = describeBatch(targets);

    // Right-clicking a folder targets *inside* it, matching how desktop file
    // managers behave; anywhere else targets the directory on screen. Applies
    // to both pasting and creating.
    const pasteDir = entry?.is_dir ? entry.path : session.cwd;
    const createItems: ContextMenuItem[] = [
      {
        label: entry?.is_dir ? `New Folder in "${entry.name}"…` : "New Folder…",
        onSelect: () => handleCreateRemote("dir", pasteDir),
      },
      {
        label: entry?.is_dir ? `New File in "${entry.name}"…` : "New File…",
        onSelect: () => handleCreateRemote("file", pasteDir),
      },
    ];
    const pasteItem: ContextMenuItem = {
      label: pasting
        ? "Pasting…"
        : !clipboard
          ? "Paste"
          : entry?.is_dir
            ? `Paste ${describeBatch(clipboard.entries)} into "${entry.name}"`
            : `Paste ${describeBatch(clipboard.entries)}`,
      onSelect: () => handlePasteRemote(pasteDir),
      disabled: !clipboard || pasting,
    };

    // Empty-space click: only the directory-level actions make sense.
    if (!entry) {
      return [
        ...createItems,
        { label: "sep-blank", separator: true, onSelect: () => {} },
        pasteItem,
      ];
    }

    const isDir = entry.is_dir;
    // Open / Open as Text stay single-target: they act on the row that was
    // actually right-clicked, since opening a dozen files at once is rarely
    // what's wanted. Everything below the first separator runs on the batch.
    const sendableCount = targets.filter((t) => !t.is_dir).length;
    return [
      {
        label: "Open",
        onSelect: () => handleOpenDefault(entry),
        disabled: isDir,
      },
      {
        label: "Open as Text",
        onSelect: () => handleOpenAsText(entry),
        disabled: isDir,
      },
      {
        label:
          sendableCount === 0
            ? "Send (folders not supported)"
            : batch
              ? `Send ${sendableCount} file${sendableCount === 1 ? "" : "s"} → ${target}`
              : `Send → ${target}`,
        onSelect: () => handleSend(targets),
        disabled: sendableCount === 0 || !localCwd,
      },
      { label: "sep-create", separator: true, onSelect: () => {} },
      ...createItems,
      { label: "sep-clipboard", separator: true, onSelect: () => {} },
      {
        label: batch ? `Copy ${batchLabel}` : "Copy",
        onSelect: () => handleCopyRemote(targets),
      },
      {
        label: batch ? `Cut ${batchLabel}` : "Cut",
        onSelect: () => handleCutRemote(targets),
      },
      pasteItem,
      { label: "sep-delete", separator: true, onSelect: () => {} },
      {
        label: batch
          ? `Delete ${batchLabel}…`
          : isDir
            ? "Delete folder…"
            : "Delete",
        onSelect: () => handleDeleteRemote(targets),
      },
    ];
  }, [
    menu,
    session,
    localCwd,
    clipboard,
    pasting,
    selectedSet,
    selectedEntries,
    handleSend,
    handleOpenDefault,
    handleOpenAsText,
    handleDeleteRemote,
    handleCreateRemote,
    handleCopyRemote,
    handleCutRemote,
    handlePasteRemote,
  ]);

  const localMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!localMenu) return [];
    const isDir = localMenu.entry.is_dir;
    const remoteTarget = session?.cwd ?? "(not connected)";
    return [
      {
        label: "Open",
        onSelect: () => handleOpenLocal(localMenu.entry),
      },
      {
        label: "Open as Text",
        onSelect: () => handleOpenLocalAsText(localMenu.entry),
        disabled: isDir,
      },
      {
        label: isDir
          ? "Send to FTP (folders not supported)"
          : session
            ? `Send to FTP → ${remoteTarget}`
            : "Send to FTP (not connected)",
        onSelect: () => handleUpload(localMenu.entry),
        disabled: isDir || !session,
      },
      {
        label: isDir ? "Delete folder…" : "Delete",
        onSelect: () => handleDeleteLocal(localMenu.entry),
      },
    ];
  }, [
    localMenu,
    session,
    handleOpenLocal,
    handleOpenLocalAsText,
    handleUpload,
    handleDeleteLocal,
  ]);

  return (
    <div className="app">
      <aside className="sidebar">
        <Sidebar
          profiles={profiles}
          activeProfileId={session?.profileId ?? null}
          connecting={connecting}
          onAdd={() => setDialog({ kind: "add" })}
          onEdit={(profile) => setDialog({ kind: "edit", profile })}
          onDelete={handleDeleteProfile}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
        <LocalBrowser
          cwd={localCwd}
          entries={localEntries}
          loading={localLoading}
          onNavigate={refreshLocalAt}
          onGoHome={() => localApi.home().then(refreshLocalAt)}
          onRefresh={() => localCwd && refreshLocalAt(localCwd)}
          onOpenInSystem={openLocalCwd}
          onContextMenu={(entry, x, y) => setLocalMenu({ entry, x, y })}
        />
      </aside>

      <main className="main">
        <header className="toolbar">
          <div className="toolbar-left">
            <Breadcrumb path={session?.cwd ?? "/"} onNavigate={navigateTo} />
            {/* Ctrl+A can select rows that are scrolled out of view, so the
                count is the only reliable feedback on how big the batch is. */}
            {selectedPaths.length > 1 && (
              <span className="selection-count" role="status" aria-live="polite">
                {selectedPaths.length} selected
              </span>
            )}
          </div>
          <div className="toolbar-right">
            <button
              className="icon-btn"
              onClick={() => session && handleCreateRemote("dir", session.cwd)}
              disabled={!session || loading}
              title="New folder here"
            >
              <FolderPlus size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={() => session && handleCreateRemote("file", session.cwd)}
              disabled={!session || loading}
              title="New empty file here"
            >
              <FilePlus size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={refresh}
              disabled={!session || loading}
              title="Refresh"
            >
              <RefreshCcw size={16} className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        {!session ? (
          <div className="welcome">
            <h1>Welcome to SuperFTP</h1>
            <p>
              Pick a saved connection on the left, or add a new one with the +
              button to get started.
            </p>
            <p className="hint">
              Tip: once connected, press <kbd>Ctrl</kbd> + <kbd>F</kbd> to filter
              files in the current directory. <kbd>Ctrl</kbd> or{" "}
              <kbd>Shift</kbd> + click picks several at a time,{" "}
              <kbd>Ctrl</kbd> + <kbd>A</kbd> takes the lot — then copy, cut or
              delete them in one go.
            </p>
          </div>
        ) : connecting ? (
          <div className="loading">
            <Loader2 size={20} className="spin" />
            <span>Connecting…</span>
          </div>
        ) : (
          // Wrap so a loading mask can overlay the file list during
          // refreshes / folder navigation, keeping the previous listing
          // visible underneath so the user retains context.
          <div className="file-list-container">
            <FileList
              entries={entries}
              canGoUp={session.cwd !== "/" && session.cwd !== ""}
              onOpen={openEntry}
              onGoUp={goUp}
              filter={effectiveFilter}
              onContextMenu={(entry, x, y) => {
                // Right-clicking outside the current selection retargets it
                // to the clicked row; right-clicking a row that's already
                // part of the batch leaves the batch intact, so the menu can
                // act on all of it.
                if (!selectedSet.has(entry.path)) setSelectedPaths([entry.path]);
                setMenu({ entry, x, y });
              }}
              onContextMenuBlank={(x, y) => setMenu({ entry: null, x, y })}
              selectedPaths={selectedSet}
              onSelectionChange={setSelectedPaths}
              cutPaths={cutPaths}
            />
            {loading && (
              <div className="loading-overlay" aria-live="polite">
                <div className="loading-badge">
                  <Loader2 size={14} className="spin" />
                  <span>Loading…</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Filter bar lives at the bottom of the right pane so it feels
            like a search HUD anchored to the window edge, similar to the
            in-page find bars in most browsers. */}
        {filterOpen && (
          <FilterBar
            value={filter}
            matched={matchedCount}
            total={entries.length}
            onChange={setFilter}
            // Keep the filter text so reopening (Ctrl+F) restores the last
            // query. Users who want to clear can just backspace it.
            onClose={() => setFilterOpen(false)}
          />
        )}
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {localMenu && (
        <ContextMenu
          x={localMenu.x}
          y={localMenu.y}
          items={localMenuItems}
          onClose={() => setLocalMenu(null)}
        />
      )}

      {createDialog && (
        <PromptDialog
          title={createDialog.kind === "dir" ? "New Folder" : "New File"}
          label="Name"
          hint={`in ${createDialog.destDir}`}
          placeholder={
            createDialog.kind === "dir" ? "my-folder" : "notes.txt"
          }
          confirmLabel="Create"
          validate={validateRemoteName}
          error={createDialog.error}
          busy={createDialog.busy}
          onCancel={() => setCreateDialog(null)}
          onSubmit={submitCreate}
        />
      )}

      {viewer && (
        <TextViewer
          title={viewer.name}
          content={viewer.content}
          error={viewer.error}
          truncated={viewer.truncated}
          size={viewer.size}
          onClose={() => setViewer(null)}
        />
      )}

      {dialog.kind === "add" && (
        <ConnectionForm
          title="New Connection"
          initial={emptyProfile()}
          onCancel={() => setDialog({ kind: "closed" })}
          onSubmit={handleSubmitProfile}
        />
      )}
      {/* Toasts overlay the UI without shifting layout. Each Toast owns
          its own enter/exit animation and auto-dismiss timer. */}
      <div className="toaster">
        {error && (
          <Toast kind="error" message={error} onDismiss={() => setError(null)} />
        )}
        {localError && (
          <Toast
            kind="error"
            message={localError}
            onDismiss={() => setLocalError(null)}
          />
        )}
        {status && (
          <Toast
            kind="success"
            message={status}
            onDismiss={() => setStatus(null)}
          />
        )}
      </div>

      {dialog.kind === "edit" && (
        <ConnectionForm
          title="Edit Connection"
          initial={dialog.profile}
          onCancel={() => setDialog({ kind: "closed" })}
          onSubmit={handleSubmitProfile}
        />
      )}
    </div>
  );
}
