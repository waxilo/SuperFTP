import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CornerUpLeft,
  FileText,
  Folder,
  Link2,
} from "lucide-react";
import type { FileEntry } from "../types";
import { matchesFilter } from "../utils/filter";

interface Props {
  entries: FileEntry[];
  canGoUp: boolean;
  onOpen: (entry: FileEntry) => void;
  onGoUp: () => void;
  filter: string;
  onContextMenu?: (entry: FileEntry, x: number, y: number) => void;
  /** Right-click on empty space below the rows — used to offer "Paste" for
   *  the current directory without having to aim at a file. */
  onContextMenuBlank?: (x: number, y: number) => void;
  /** Paths of the rows rendered as selected. Drives the keyboard shortcuts
   *  in App, which need to know what Ctrl+C / Ctrl+X should act on. */
  selectedPaths?: ReadonlySet<string>;
  /** Called with the complete next selection whenever a click changes it.
   *  The list owns the click semantics (plain / Ctrl / Shift) because only
   *  it knows the visible row order a Shift range depends on. */
  onSelectionChange?: (paths: string[]) => void;
  /** Paths currently held in the clipboard in "cut" mode, dimmed to signal
   *  they're pending a move. */
  cutPaths?: ReadonlySet<string>;
  /** Show the Permissions column. Off for local listings, where the backend
   *  reports no mode bits and the column would be a full row of dashes. */
  showPermissions?: boolean;
}

const NO_PATHS: ReadonlySet<string> = new Set<string>();

type SortKey = "name" | "modified";
type SortDir = "asc" | "desc";

function humanSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function FileList({
  entries,
  canGoUp,
  onOpen,
  onGoUp,
  filter,
  onContextMenu,
  onContextMenuBlank,
  selectedPaths = NO_PATHS,
  onSelectionChange,
  cutPaths = NO_PATHS,
  showPermissions = true,
}: Props) {
  const columnCount = showPermissions ? 4 : 3;
  // `null` sort key means "default" — server order, dirs-on-top. Clicking a
  // header cycles asc → desc → back to default. This keeps three visibly
  // distinct states, and asc/desc are guaranteed to differ from default
  // because the backend no longer pre-sorts by name.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Row a Shift+click measures its range from. Held here rather than in App
  // because it's a pure view concern, and it must survive selection changes
  // (Shift+clicking twice in a row should re-measure from the same anchor).
  const [anchor, setAnchor] = useState<string | null>(null);

  function toggleSort(key: SortKey) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
      setSortDir("asc");
    }
  }

  const filtered = useMemo(
    () =>
      filter.trim()
        ? entries.filter((e) => matchesFilter(e.name, filter))
        : entries,
    [entries, filter],
  );

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      // Directories always float above files, matching common file managers.
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      } else {
        // Missing timestamps sink to the bottom regardless of direction.
        const ta = a.modified ? Date.parse(a.modified) : NaN;
        const tb = b.modified ? Date.parse(b.modified) : NaN;
        const aBad = Number.isNaN(ta);
        const bBad = Number.isNaN(tb);
        if (aBad && bBad) cmp = 0;
        else if (aBad) return 1;
        else if (bBad) return -1;
        else cmp = ta - tb;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  /** Selection semantics, matching desktop file managers:
   *  - plain click     → select just this row, and make it the anchor
   *  - Ctrl/Cmd click  → toggle this row, and make it the anchor
   *  - Shift click     → select the anchor..row range, replacing the selection
   *  - Ctrl+Shift click→ add the anchor..row range to the selection
   *  The anchor is deliberately left alone by Shift so the range can be
   *  widened or narrowed by repeated Shift+clicks. */
  function handleRowClick(entry: FileEntry, e: ReactMouseEvent) {
    if (!onSelectionChange) return;
    const additive = e.ctrlKey || e.metaKey;

    if (e.shiftKey) {
      const from = sorted.findIndex((x) => x.path === (anchor ?? entry.path));
      const to = sorted.findIndex((x) => x.path === entry.path);
      // A stale anchor (filtered out, or from a previous directory) degrades
      // to a plain click rather than selecting a nonsense range.
      if (from === -1 || to === -1) {
        setAnchor(entry.path);
        onSelectionChange([entry.path]);
        return;
      }
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const range = sorted.slice(lo, hi + 1).map((x) => x.path);
      onSelectionChange(
        additive ? [...new Set([...selectedPaths, ...range])] : range,
      );
      return;
    }

    setAnchor(entry.path);
    if (additive) {
      const next = new Set(selectedPaths);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      onSelectionChange([...next]);
      return;
    }
    onSelectionChange([entry.path]);
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return <ChevronsUpDown size={12} className="sort-icon dim" />;
    return sortDir === "asc" ? (
      <ChevronUp size={12} className="sort-icon" />
    ) : (
      <ChevronDown size={12} className="sort-icon" />
    );
  }

  return (
    <div
      className="file-table-wrap"
      onClick={(e) => {
        // Clicking genuinely empty space clears the selection. Anything
        // inside a row (or a header cell, e.g. the sort buttons) is left to
        // its own handler.
        if ((e.target as HTMLElement).closest("tr")) return;
        onSelectionChange?.([]);
      }}
      onContextMenu={(e) => {
        if (!onContextMenuBlank) return;
        // Row handlers call preventDefault before this bubbles up, so a
        // defaulted event means the click landed on empty space.
        if (e.defaultPrevented) return;
        e.preventDefault();
        onContextMenuBlank(e.clientX, e.clientY);
      }}
    >
      <table className="file-table">
        <thead>
          <tr>
            <th className="col-name">
              <button
                type="button"
                className={`th-sort ${sortKey === "name" ? "active" : ""}`}
                onClick={() => toggleSort("name")}
              >
                <span>Name</span>
                {sortIndicator("name")}
              </button>
            </th>
            <th className="col-size">Size</th>
            {showPermissions && <th className="col-perms">Permissions</th>}
            <th className="col-time">
              <button
                type="button"
                className={`th-sort ${sortKey === "modified" ? "active" : ""}`}
                onClick={() => toggleSort("modified")}
              >
                <span>Modified</span>
                {sortIndicator("modified")}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {canGoUp && !filter && (
            <tr className="row up" onDoubleClick={onGoUp}>
              <td className="col-name">
                <button className="name-cell" onClick={onGoUp} title="Go up">
                  <CornerUpLeft size={16} className="icon dir" />
                  <span>..</span>
                </button>
              </td>
              <td>—</td>
              {showPermissions && <td>—</td>}
              <td>—</td>
            </tr>
          )}

          {sorted.map((entry) => {
            const Icon = entry.is_symlink ? Link2 : entry.is_dir ? Folder : FileText;
            return (
              <tr
                key={entry.path}
                className={[
                  "row",
                  selectedPaths.has(entry.path) ? "selected" : "",
                  cutPaths.has(entry.path) ? "cut" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(e) => handleRowClick(entry, e)}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(e) => {
                  if (!onContextMenu) return;
                  e.preventDefault();
                  // App retargets the selection when the click lands outside
                  // it, and keeps it when the row is part of a multi-select.
                  // Either way this row becomes the Shift anchor.
                  setAnchor(entry.path);
                  onContextMenu(entry, e.clientX, e.clientY);
                }}
              >
                <td className="col-name">
                  <button
                    className="name-cell"
                    onClick={(e) => {
                      // With a modifier held the click means "select", not
                      // "open" — let it bubble to the row handler.
                      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                      if (!entry.is_dir) return;
                      // Navigating away invalidates the selection, so don't
                      // let this bubble to the row handler and re-arm it
                      // against the folder we're leaving.
                      e.stopPropagation();
                      onOpen(entry);
                    }}
                    title={entry.path}
                  >
                    <Icon
                      size={16}
                      className={`icon ${entry.is_dir ? "dir" : "file"}`}
                    />
                    <span>{entry.name}</span>
                  </button>
                </td>
                <td>{entry.is_dir ? "—" : humanSize(entry.size)}</td>
                {showPermissions && (
                  <td className="mono">{entry.permissions ?? "—"}</td>
                )}
                <td>{formatTime(entry.modified)}</td>
              </tr>
            );
          })}

          {sorted.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="empty-row">
                {filter ? `No matches for "${filter}"` : "Empty directory"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
