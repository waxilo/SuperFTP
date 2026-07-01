import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

interface Props {
  kind: "error" | "success";
  message: string;
  /** Optional override; defaults to 8 s for errors, 4 s for success. */
  duration?: number;
  /** Called after the exit transition finishes, so the parent can free
   *  whichever state slot was driving this toast. */
  onDismiss: () => void;
}

/**
 * A single flat toast card that animates in on mount and animates out
 * before the parent unmounts it. Owning enter/exit here (instead of relying
 * on the parent to time state changes) prevents the abrupt disappearance
 * that felt "jittery" — the DOM stays around long enough for the CSS
 * transition to finish.
 *
 * The auto-dismiss timer resets whenever `message` changes, so quick
 * status updates like "Opening…" → "Opened" don't cut the read time short.
 */
export function Toast({ kind, message, duration, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);
  const closingRef = useRef(false);

  // Ref-latch the callback so the timer below never captures a stale
  // closure when the parent recreates the arrow inline each render.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Enter: initial render paints the toast in its hidden state, then a
  // rAF flip to `visible=true` lets the CSS transition play.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  function beginClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    // Match the CSS transition duration below; unmount is deferred so the
    // exit animation actually plays.
    window.setTimeout(() => onDismissRef.current(), 200);
  }

  // Auto-dismiss. The timer resets on message change so subsequent updates
  // (e.g. an operation-progress toast that ends with a success message)
  // stay visible for the full duration after the *last* update.
  useEffect(() => {
    if (closingRef.current) return;
    const total = duration ?? (kind === "error" ? 8000 : 4000);
    const timer = window.setTimeout(beginClose, total);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, kind, duration]);

  const Icon = kind === "error" ? AlertCircle : CheckCircle2;
  const role = kind === "error" ? "alert" : "status";

  return (
    <div
      className={`toast ${kind} ${visible ? "visible" : ""}`}
      role={role}
      aria-live={kind === "error" ? "assertive" : "polite"}
    >
      <Icon size={14} className="toast-icon" />
      <span className="toast-text">{message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={beginClose}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}
