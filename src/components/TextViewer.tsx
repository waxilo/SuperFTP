import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, WrapText, X } from "lucide-react";

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
  /** Persist the edited text. Omit to keep the viewer read-only. Rejecting
   *  keeps the editor open with the draft intact so the user can retry. */
  onSave?: (text: string) => Promise<void>;
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
 * Modal text editor used by "open as text" (double-click on a remote file, or
 * the local panel's context menu).
 *
 * Plain textarea, no syntax highlighting — the goal is a quick peek at (and
 * touch-up of) server-side configs / logs / scripts without leaving the app.
 * Editing is disabled when the file came back truncated: saving would write
 * only the prefix and silently destroy the rest.
 */
export function TextViewer({
  title,
  content,
  error,
  truncated,
  size,
  onSave,
  onClose,
}: Props) {
  // Word-wrap toggle. Off by default so log files and CSVs keep their column
  // alignment; the user can opt in with one click for prose-y content.
  const [wrap, setWrap] = useState(false);

  // The editable buffer. Seeded from `content` and re-seeded whenever the
  // parent hands over a new one — which happens exactly twice: when the fetch
  // resolves, and after a successful save re-baselines the text.
  const [draft, setDraft] = useState(content ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(content ?? "");
    setDirty(false);
    setSaveError(null);
  }, [content]);

  const loading = content == null && !error;
  const editable = !!onSave && !truncated && !loading && !error;

  const save = useCallback(async () => {
    if (!onSave || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      // The parent re-baselines `content` on success, which clears `dirty`
      // through the effect above. Clearing it here too keeps the button
      // honest even if a caller chooses not to.
      setDirty(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [onSave, dirty, saving, draft]);

  // Closing with unsaved edits is the one place where a click can lose work,
  // so it's the one place that asks.
  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [dirty, saving, onClose]);

  // Escape closes, Ctrl/Cmd+S saves. Both are handled here rather than in the
  // app-level shortcut handler because only this component knows whether
  // there are unsaved changes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editable) save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, save, editable]);

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        className="modal text-viewer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Text content of ${title}`}
      >
        <div className="modal-header">
          <h2 title={title}>
            {title}
            {dirty && (
              <span className="text-viewer-dirty" title="Unsaved changes">
                {" "}
                •
              </span>
            )}
          </h2>
          <div className="text-viewer-actions">
            {onSave && (
              <button
                className="icon-btn small"
                onClick={save}
                disabled={!editable || !dirty || saving}
                title={
                  truncated
                    ? "Can't save a partially loaded file"
                    : dirty
                      ? "Save (Ctrl+S)"
                      : "No changes to save"
                }
              >
                {saving ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Save size={14} />
                )}
              </button>
            )}
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
              onClick={requestClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {truncated && size != null && (
          <div className="banner small">
            Showing the first part of a {humanSize(size)} file, so editing is
            disabled — saving would drop the rest. Open it in an external app
            to work on the whole file.
          </div>
        )}
        {error && <div className="banner error small">{error}</div>}
        {saveError && <div className="banner error small">{saveError}</div>}

        <div className="text-viewer-body">
          {loading ? (
            <div className="loading">
              <Loader2 size={18} className="spin" />
              <span>Loading…</span>
            </div>
          ) : (
            <textarea
              className={`text-viewer-area ${wrap ? "wrap" : ""}`}
              value={draft}
              // Frozen mid-save so keystrokes can't be lost when the parent
              // re-baselines the content on success.
              readOnly={!editable || saving}
              spellCheck={false}
              wrap={wrap ? "soft" : "off"}
              aria-label={`Content of ${title}`}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(e.target.value !== (content ?? ""));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
