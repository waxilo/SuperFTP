import { useMemo, useState } from "react";
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
}

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

export function FileList({ entries, canGoUp, onOpen, onGoUp, filter, onContextMenu }: Props) {
  // `null` sort key means "default" — server order, dirs-on-top. Clicking a
  // header cycles asc → desc → back to default. This keeps three visibly
  // distinct states, and asc/desc are guaranteed to differ from default
  // because the backend no longer pre-sorts by name.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return <ChevronsUpDown size={12} className="sort-icon dim" />;
    return sortDir === "asc" ? (
      <ChevronUp size={12} className="sort-icon" />
    ) : (
      <ChevronDown size={12} className="sort-icon" />
    );
  }

  return (
    <div className="file-table-wrap">
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
            <th className="col-perms">Permissions</th>
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
              <td>—</td>
              <td>—</td>
            </tr>
          )}

          {sorted.map((entry) => {
            const Icon = entry.is_symlink ? Link2 : entry.is_dir ? Folder : FileText;
            return (
              <tr
                key={entry.path}
                className="row"
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(e) => {
                  if (!onContextMenu) return;
                  e.preventDefault();
                  onContextMenu(entry, e.clientX, e.clientY);
                }}
              >
                <td className="col-name">
                  <button
                    className="name-cell"
                    onClick={() => entry.is_dir && onOpen(entry)}
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
                <td className="mono">{entry.permissions ?? "—"}</td>
                <td>{formatTime(entry.modified)}</td>
              </tr>
            );
          })}

          {sorted.length === 0 && (
            <tr>
              <td colSpan={4} className="empty-row">
                {filter ? `No matches for "${filter}"` : "Empty directory"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
