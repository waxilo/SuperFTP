import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";

interface Props {
  /** Modal title, e.g. "New Folder". */
  title: string;
  /** Label rendered above the input. */
  label: string;
  /** Muted line under the header — used for the destination path so the user
   *  can see *where* the thing is about to be created. */
  hint?: string;
  initialValue?: string;
  placeholder?: string;
  /** Text on the confirm button. Defaults to "Create". */
  confirmLabel?: string;
  /** Synchronous check run on every keystroke. Return a message to show it
   *  inline and block submission, or `null` when the value is fine. */
  validate?: (value: string) => string | null;
  /** Error surfaced by the caller's async submit (e.g. "already exists").
   *  Cleared automatically as soon as the user edits the value. */
  error?: string | null;
  /** True while the caller's submit is in flight. Locks the form so the
   *  request can't be cancelled or fired twice. */
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

/**
 * Single-line input modal — our replacement for `window.prompt`, which can't
 * be styled, ignores the app's theme, and on some platforms shows the page
 * origin in the dialog.
 *
 * Validation is inline rather than after-the-fact: the confirm button stays
 * disabled until the value is usable, and a failed submit (a name clash, say)
 * keeps the dialog open with the text intact so the user can just fix it.
 */
export function PromptDialog({
  title,
  label,
  hint,
  initialValue = "",
  placeholder,
  confirmLabel = "Create",
  validate,
  error,
  busy = false,
  onCancel,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initialValue);
  // Tracks whether the value changed since the caller handed us an error, so
  // a stale "already exists" message disappears the moment the user types.
  const [dirty, setDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const messageId = useId();

  // Focus and pre-select on mount: typing replaces the suggested value, which
  // is what you want both for a blank "new file" and a pre-filled rename.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Close on Escape, matching the other modals. Ignored while busy so a
  // stray keypress can't orphan an in-flight request.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const trimmed = value.trim();
  const localError = trimmed ? (validate?.(trimmed) ?? null) : null;
  const shownError = localError ?? (dirty ? null : (error ?? null));
  const canSubmit = !!trimmed && !localError && !busy;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setDirty(false);
    onSubmit(trimmed);
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="modal prompt-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-btn small"
            onClick={onCancel}
            disabled={busy}
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <form className="form" onSubmit={handleSubmit}>
          {hint && (
            <p className="prompt-hint" title={hint}>
              {hint}
            </p>
          )}

          <label>
            <span>{label}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setDirty(true);
              }}
              placeholder={placeholder}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!shownError}
              aria-describedby={shownError ? messageId : undefined}
            />
          </label>

          {/* `aria-live` so screen readers announce a clash without the user
              having to go hunting for the message. */}
          {shownError && (
            <div className="banner error small" id={messageId} aria-live="polite">
              {shownError}
            </div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!canSubmit}>
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
