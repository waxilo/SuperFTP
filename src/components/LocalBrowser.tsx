import { useMemo, useState } from "react";
import {
  CornerUpLeft,
  Folder,
  FolderOpen,
  FileText,
  Home,
  RefreshCcw,
  Search,
  X,
} from "lucide-react";
import type { LocalEntry } from "../api/local";
import { matchesFilter } from "../utils/filter";

interface Props {
  cwd: string;
  entries: LocalEntry[];
  loading: boolean;
  error: string | null;
  onNavigate: (path: string) => void;
  onGoHome: () => void;
  onRefresh: () => void;
  onOpenInSystem: () => void;
  onContextMenu?: (entry: LocalEntry, x: number, y: number) => void;
}

/** Return the parent directory of an absolute path (forward-slash form),
 *  or the path itself when already at the root. */
function parentOf(path: string): string {
  if (!path) return path;
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {
    // Unix root or drive-only Windows path like "C:". The trailing slash
    // keeps `list_dir` happy on Windows since "C:" alone resolves to the
    // CWD on that drive rather than its root.
    return trimmed.includes(":") ? `${trimmed.split(":")[0]}:/` : "/";
  }
  return trimmed.slice(0, idx) || "/";
}

export function LocalBrowser({
  cwd,
  entries,
  loading,
  error,
  onNavigate,
  onGoHome,
  onRefresh,
  onOpenInSystem,
  onContextMenu,
}: Props) {
  const [filter, setFilter] = useState("");

  const canGoUp = cwd !== "" && parentOf(cwd) !== cwd;

  const filtered = useMemo(() => {
    if (!filter.trim()) return entries;
    return entries.filter((e) => matchesFilter(e.name, filter));
  }, [entries, filter]);

  return (
    <section className="local-panel" aria-label="Local files">
      <div className="local-header">
        <div className="local-title">Local</div>
        <div className="local-actions">
          <button
            className="icon-btn small"
            onClick={onOpenInSystem}
            disabled={!cwd}
            title="Open in system file manager"
          >
            <FolderOpen size={13} />
          </button>
          <button
            className="icon-btn small"
            onClick={onGoHome}
            title="Go to home directory"
          >
            <Home size={13} />
          </button>
          <button
            className="icon-btn small"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCcw size={13} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      <div className="local-cwd" title={cwd}>
        {cwd || "—"}
      </div>

      <div className="local-filter">
        <Search size={12} className="local-filter-icon" />
        <input
          type="text"
          placeholder="Filter (supports * and ?)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              // Escape clears the filter, mirroring the right-side panel's
              // close behavior without leaving the input.
              e.preventDefault();
              setFilter("");
            }
          }}
        />
        {filter && (
          <>
            <span className="local-filter-count" title="matched / total">
              {filtered.length}/{entries.length}
            </span>
            <button
              type="button"
              className="local-filter-clear"
              onClick={() => setFilter("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>

      {error && <div className="banner error small">{error}</div>}

      <ul className="local-list">
        {/* Hide ".." while filtering — the user is searching, not navigating. */}
        {canGoUp && !filter && (
          <li>
            <button
              className="local-item"
              onDoubleClick={() => onNavigate(parentOf(cwd))}
              title="Double-click to go up"
            >
              <CornerUpLeft size={14} className="icon dir" />
              <span>..</span>
            </button>
          </li>
        )}
        {filtered.length === 0 && !loading && (
          <li className="empty-hint small">
            {filter ? `No matches for "${filter}"` : canGoUp ? "" : "Empty"}
          </li>
        )}
        {filtered.map((entry) => {
          const Icon = entry.is_dir ? Folder : FileText;
          return (
            <li key={entry.path}>
              <button
                className={`local-item ${entry.is_dir ? "" : "file"}`}
                onDoubleClick={() => entry.is_dir && onNavigate(entry.path)}
                onContextMenu={(e) => {
                  if (!onContextMenu) return;
                  e.preventDefault();
                  onContextMenu(entry, e.clientX, e.clientY);
                }}
                title={entry.path}
                // Files are not clickable/navigable, but stay enabled so the
                // right-click event still fires (disabled buttons don't emit
                // contextmenu events on all browsers).
              >
                <Icon size={14} className={`icon ${entry.is_dir ? "dir" : "file"}`} />
                <span>{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
