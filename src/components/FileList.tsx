import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
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

/** Reused for every name comparison. `a.localeCompare(b, undefined, {...})`
 *  builds a collator on each call, which costs hundreds of milliseconds on a
 *  five-figure listing; one shared Collator is roughly an order of magnitude
 *  faster and applies identical rules. */
const NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Assumed row height until the real one can be measured from the DOM (see
 *  `rowH`), and the number of extra rows rendered above/below the viewport so
 *  scrolling never shows a gap. */
const ROW_HEIGHT_FALLBACK = 34;
const OVERSCAN = 8;

/** Below this many rows the list is rendered in full. Windowing a short list
 *  buys nothing and keeps the component honest before the viewport has been
 *  measured (first paint reports a height of 0). */
const VIRTUALIZE_THRESHOLD = 200;

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
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "name") {
      return [...filtered].sort((a, b) => {
        // Directories always float above files, matching common file managers.
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return dir * NAME_COLLATOR.compare(a.name, b.name);
      });
    }
    // Timestamps are parsed once per entry rather than once per comparison
    // (~2n against n log n), because Date.parse inside the comparator
    // dominated the sort on large listings.
    const stamped = filtered.map((e) => ({
      e,
      t: e.modified ? Date.parse(e.modified) : NaN,
    }));
    stamped.sort((a, b) => {
      if (a.e.is_dir !== b.e.is_dir) return a.e.is_dir ? -1 : 1;
      const aBad = Number.isNaN(a.t);
      const bBad = Number.isNaN(b.t);
      // Missing timestamps sink to the bottom regardless of direction.
      if (aBad && bBad) return 0;
      if (aBad) return 1;
      if (bBad) return -1;
      return dir * (a.t - b.t);
    });
    return stamped.map((s) => s.e);
  }, [filtered, sortKey, sortDir]);

  // -- windowed rendering. A big directory (tens of thousands of rows) is
  // unusable if every entry becomes a real <tr>: the DOM build, the inline
  // row closures and one toLocaleString() per timestamp all scale linearly,
  // so the pane stays blank long after the listing has arrived. Only the
  // visible slice is rendered, with empty rows above and below standing in
  // for the hidden ones to preserve the scrollbar size and position.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // One extra slot when the ".." row is present; it lives inside the window
  // too, so the row math below treats it as index 0.
  const upRow = canGoUp && !filter;
  const rowCount = filtered.length + (upRow ? 1 : 0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowH, setRowH] = useState(ROW_HEIGHT_FALLBACK);

  // rAF-throttled so a fast flick doesn't schedule a render per event.
  const scrollRaf = useRef(0);
  const handleScroll = useCallback(() => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = wrapRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  // Re-sync geometry whenever the row count changes: navigating into a new
  // directory can clamp the browser's scrollTop without firing a scroll event
  // in time, and the row height is only measurable once rows exist.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    // Fractional height on purpose: `offsetHeight` rounds (36.625 → 37), and
    // that 0.4px/row error compounds into a multi-row offset by the time the
    // user has scrolled deep into a five-figure listing.
    const probe = el.querySelector<HTMLElement>("tbody tr.row");
    const measured = probe && probe.getBoundingClientRect().height;
    if (measured && measured > 0) setRowH(measured);
  }, [rowCount]);

  // Track container resizes (window resize, filter bar appearing).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const windowed = rowCount > VIRTUALIZE_THRESHOLD;
  const first = windowed
    ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
    : 0;
  const last = windowed
    ? Math.min(
        rowCount,
        first + Math.ceil((viewportH || 600) / rowH) + OVERSCAN * 2,
      )
    : rowCount;
  // Rows the spacers stand in for. Measured in real pixels so the scrollbar
  // keeps its length and thumb position even though the DOM is short.
  const padTop = first * rowH;
  const padBottom = (rowCount - last) * rowH;

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

  // The ".." row occupies index 0 of the window's coordinate space when it is
  // shown, so the row math and the spacers stay in sync with it. It is itself
  // a rendered row, so it only appears while index 0 is inside the window.
  const upRowNode =
    upRow && first === 0 ? (
    <tr key="__up" className="row up" onDoubleClick={onGoUp}>
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
  ) : null;

  const windowRows: FileEntry[] = [];
  for (let i = first; i < last; i++) {
    // Index 0 belongs to the ".." row, which is rendered separately above.
    if (upRow && i === 0) continue;
    const entry = sorted[i - (upRow ? 1 : 0)];
    if (entry) windowRows.push(entry);
  }

  function renderEntryRow(entry: FileEntry) {
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
  }

  // A bare <tr> with the outstanding height, so the table's total height —
  // and therefore the scrollbar length and thumb position — matches the full
  // listing even though only the visible slice is in the DOM.
  function spacerRow(px: number, key: string) {
    if (px <= 0) return null;
    return (
      <tr key={key} className="row-spacer" aria-hidden="true">
        <td colSpan={columnCount} style={{ height: `${px}px` }} />
      </tr>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="file-table-wrap"
      onScroll={handleScroll}
      onClick={(e) => {
        // Clicking genuinely empty space clears the selection. Anything
        // inside a row (or a header cell, e.g. the sort buttons) is left to
        // its own handler. The windowing spacers count as empty space — they
        // exist only to hold the scrollbar's length, not to be interacted
        // with.
        if ((e.target as HTMLElement).closest("tr:not(.row-spacer)")) return;
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
          {spacerRow(padTop, "pad-top")}

          {upRowNode}

          {windowRows.map(renderEntryRow)}

          {spacerRow(padBottom, "pad-bottom")}

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
