import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import "./App.css";
import { Sidebar } from "./components/Sidebar";
import { LocalBrowser } from "./components/LocalBrowser";
import { ConnectionForm } from "./components/ConnectionForm";
import { Breadcrumb } from "./components/Breadcrumb";
import { FilterBar } from "./components/FilterBar";
import { FileList } from "./components/FileList";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { TextViewer } from "./components/TextViewer";

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
  entry: FileEntry;
}

interface LocalMenuState {
  x: number;
  y: number;
  entry: LocalEntry;
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

  // -- right-click menu on a local file row
  const [localMenu, setLocalMenu] = useState<LocalMenuState | null>(null);

  // -- in-app text preview of a remote file
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  // -- filter (Ctrl+F)
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // -- transient status message (e.g. "Downloaded foo.csv")
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(null), 4000);
    return () => window.clearTimeout(t);
  }, [status]);

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
    }
  }, [session]);

  const navigateTo = useCallback(
    (path: string) => {
      if (!session) return;
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
  const handleSend = useCallback(
    async (entry: FileEntry) => {
      if (!session) return;
      if (!localCwd) {
        setError("Pick a local folder first.");
        return;
      }
      if (entry.is_dir) {
        setError("Sending whole folders isn't supported yet.");
        return;
      }
      setError(null);
      try {
        const written = await ftpApi.download(
          session.sessionId,
          entry.path,
          localCwd,
        );
        setStatus(`Downloaded to ${written}`);
        // Refresh the local panel so the new file shows up immediately.
        refreshLocalAt(localCwd);
      } catch (e) {
        setError(String(e));
      }
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

  // Ctrl+F / Esc handlers — only meaningful while connected.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isFind = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
      if (isFind) {
        if (!session) return;
        e.preventDefault();
        setFilterOpen(true);
      } else if (e.key === "Escape" && filterOpen) {
        setFilterOpen(false);
        setFilter("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen, session]);

  const matchedCount = useMemo(() => {
    if (!filter.trim()) return entries.length;
    return entries.filter((e) => matchesFilter(e.name, filter)).length;
  }, [entries, filter]);

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
    if (!menu) return [];
    const target = localCwd || "(no folder)";
    const isDir = menu.entry.is_dir;
    return [
      {
        label: "Open",
        onSelect: () => handleOpenDefault(menu.entry),
        disabled: isDir,
      },
      {
        label: "Open as Text",
        onSelect: () => handleOpenAsText(menu.entry),
        disabled: isDir,
      },
      {
        label: isDir ? "Send (folders not supported)" : `Send → ${target}`,
        onSelect: () => handleSend(menu.entry),
        disabled: isDir || !localCwd,
      },
    ];
  }, [menu, localCwd, handleSend, handleOpenDefault, handleOpenAsText]);

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
    ];
  }, [localMenu, session, handleOpenLocal, handleOpenLocalAsText, handleUpload]);

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
          error={localError}
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
          </div>
          <div className="toolbar-right">
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

        {filterOpen && (
          <FilterBar
            value={filter}
            matched={matchedCount}
            total={entries.length}
            onChange={setFilter}
            onClose={() => {
              setFilterOpen(false);
              setFilter("");
            }}
          />
        )}

        {error && <div className="banner error">{error}</div>}
        {status && <div className="banner success">{status}</div>}

        {!session ? (
          <div className="welcome">
            <h1>Welcome to SuperFTP</h1>
            <p>
              Pick a saved connection on the left, or add a new one with the +
              button to get started.
            </p>
            <p className="hint">
              Tip: once connected, press <kbd>Ctrl</kbd> + <kbd>F</kbd> to filter
              files in the current directory.
            </p>
          </div>
        ) : connecting || (loading && entries.length === 0) ? (
          <div className="loading">
            <Loader2 size={20} className="spin" />
            <span>{connecting ? "Connecting…" : "Loading…"}</span>
          </div>
        ) : (
          <FileList
            entries={entries}
            canGoUp={session.cwd !== "/" && session.cwd !== ""}
            onOpen={openEntry}
            onGoUp={goUp}
            filter={filter}
            onContextMenu={(entry, x, y) => setMenu({ entry, x, y })}
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
