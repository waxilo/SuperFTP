import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

/**
 * The window's own title bar. The native frame is switched off in
 * `tauri.conf.json` (`decorations: false`), so this strip is the only way to
 * move, maximise or close the window — the whole bar is a drag region, and
 * double-clicking it toggles the maximised state (handled by Tauri's built-in
 * drag-region behaviour, which needs `core:window:allow-internal-toggle-maximize`).
 *
 * Nothing else lives here on purpose: the brand mark stays in the sidebar and
 * the file actions stay in the toolbar.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    // Resizing fires continuously while the window is dragged, so refreshes
    // are folded into one check per frame instead of one per event.
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        win
          .isMaximized()
          .then((m) => alive && setMaximized(m))
          .catch(() => {});
      });
    };
    refresh();
    const unlisten = win.onResized(refresh);
    return () => {
      alive = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-buttons">
        <button
          type="button"
          className="win-btn"
          onClick={() => win.minimize()}
          title="最小化"
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className="win-btn"
          onClick={() => win.toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button
          type="button"
          className="win-btn close"
          onClick={() => win.close()}
          title="关闭"
          aria-label="Close"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
