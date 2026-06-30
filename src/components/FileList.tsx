import { Folder, FileText, CornerUpLeft, Link2 } from "lucide-react";
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
  const filtered = filter.trim()
    ? entries.filter((e) => matchesFilter(e.name, filter))
    : entries;

  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <thead>
          <tr>
            <th className="col-name">Name</th>
            <th className="col-size">Size</th>
            <th className="col-perms">Permissions</th>
            <th className="col-time">Modified</th>
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

          {filtered.map((entry) => {
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

          {filtered.length === 0 && (
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
