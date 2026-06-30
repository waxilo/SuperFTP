import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Lightweight right-click menu. Closes on outside click, Escape, or after an
 * item is selected. Re-positions itself if it would overflow the viewport so
 * a row at the bottom of the screen still gets a usable menu.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Close on outside click / Escape.
  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Defer attachment by a tick so the same right-click event that opened
    // the menu doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onPointer);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Nudge the menu back on-screen after the first paint, so it sits inside
  // the viewport even when invoked at the edge of the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    let nx = x;
    let ny = y;
    if (rect.right > window.innerWidth) {
      nx = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (rect.bottom > window.innerHeight) {
      ny = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
  }, [x, y, pos.x, pos.y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
    >
      {items.map((item, i) => (
        <button
          key={i}
          className="context-menu-item"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
