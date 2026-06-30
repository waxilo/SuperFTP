import { useEffect, useState } from "react";
import { Loader2, WrapText, X } from "lucide-react";

interface Props {
  /** Window title — usually the remote filename. */
  title: string;
  /** Decoded content, or `null` while the download is still in flight. */
  content: string | null;
  /** Set when fetching/decoding failed. */
  error?: string | null;
  /** When true, the file was larger than the in-app size cap and only the
   *  leading slice is displayed. */
  truncated?: boolean;
  /** Total file size in bytes, used in the "truncated" notice. */
  size?: number;
  onClose: () => void;
}

function humanSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Modal text viewer for the right-click "Open as Text" action.
 *
 * Read-only, no syntax highlighting — the goal is a quick peek at server-side
 * configs / logs / scripts without spinning up an external editor.
 */
export function TextViewer({
  title,
  content,
  error,
  truncated,
  size,
  onClose,
}: Props) {
  // Word-wrap toggle. Off by default so log files and CSVs keep their column
  // alignment; the user can opt in with one click for prose-y content.
  const [wrap, setWrap] = useState(false);

  // Close on Escape, matching the other modals in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal text-viewer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Text preview of ${title}`}
      >
        <div className="modal-header">
          <h2 title={title}>{title}</h2>
          <div className="text-viewer-actions">
            <button
              className={`icon-btn small ${wrap ? "active" : ""}`}
              onClick={() => setWrap((w) => !w)}
              title={wrap ? "Disable word wrap" : "Enable word wrap"}
              aria-pressed={wrap}
            >
              <WrapText size={14} />
            </button>
            <button
              className="icon-btn small"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {truncated && size != null && (
          <div className="banner small">
            Showing the first part of a {humanSize(size)} file. Use “Open” to
            view the full file in an external app.
          </div>
        )}
        {error && <div className="banner error small">{error}</div>}

        <div className="text-viewer-body">
          {content == null && !error ? (
            <div className="loading">
              <Loader2 size={18} className="spin" />
              <span>Loading…</span>
            </div>
          ) : (
            <pre className={`text-viewer-pre ${wrap ? "wrap" : ""}`}>
              {content ?? ""}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
