import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Loader2,
  Replace,
  ReplaceAll,
  Save,
  Search,
  WrapText,
  X,
} from "lucide-react";

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

/** Cap on how many hits the find bar tracks. A one-character needle in a 4 MiB
 *  log can match millions of times; nobody steps through that, and the array
 *  alone would cost tens of megabytes. Past the cap the count reads "20000+"
 *  and "replace all" works in batches. */
const MAX_MATCHES = 20000;

/** Cap on how many hits get a highlight box. Each one is a DOM node in the
 *  overlay, so a needle that matches thousands of times would make typing in
 *  the find box crawl. Above this only the current hit is boxed. */
const MAX_HIGHLIGHTS = 2000;

/** Number of lines in `text`, counted without allocating a split array — the
 *  in-app size cap is 4 MiB, so a log can easily reach six figures of lines
 *  and this runs on every keystroke. */
function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lines += 1;
  }
  return lines;
}

/** 0-based index of the line containing `offset`. */
function lineOfOffset(text: string, offset: number): number {
  let line = 0;
  for (
    let i = text.indexOf("\n");
    i !== -1 && i < offset;
    i = text.indexOf("\n", i + 1)
  ) {
    line += 1;
  }
  return line;
}

/**
 * Start offsets of every non-overlapping occurrence of `needle` in `haystack`.
 *
 * Plain substring search rather than a RegExp: the needle comes straight from a
 * text box, so metacharacters have to be taken literally. Case-insensitive
 * search is handled by the caller lower-casing both sides — that keeps offsets
 * valid against the original text, since `toLowerCase` preserves length for
 * every character we can realistically meet here.
 */
function findMatches(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    out.push(at);
    if (out.length >= MAX_MATCHES) break;
    from = at + needle.length;
  }
  return out;
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
 *
 * Ctrl/Cmd+F opens find, Ctrl/Cmd+R (or Ctrl+H) opens find & replace.
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

  // ----- Find & replace state -------------------------------------------
  const [findOpen, setFindOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(content ?? "");
    setDirty(false);
    setSaveError(null);
  }, [content]);

  const loading = content == null && !error;
  const editable = !!onSave && !truncated && !loading && !error;
  const canEdit = editable && !saving;

  // ----- Line numbers ----------------------------------------------------
  // Rendered as a single text node in a gutter beside the textarea rather
  // than one element per line: a 4 MiB log can run to six figures of lines,
  // and that many DOM nodes makes opening the file visibly slow.
  //
  // Only shown with wrapping off. A wrapped line occupies several visual rows
  // while still being one numbered line, so the column would drift out of
  // step with the text — showing nothing beats showing wrong numbers.
  const showGutter = !loading && !wrap;

  const lineCount = useMemo(() => countLines(draft), [draft]);
  const gutterText = useMemo(() => {
    const rows = new Array<number>(lineCount);
    for (let i = 0; i < lineCount; i += 1) rows[i] = i + 1;
    return rows.join("\n");
  }, [lineCount]);

  // The gutter and the highlight overlay don't scroll on their own (overflow
  // is hidden); both are driven from the textarea's scroll position so the
  // three stay locked together.
  const syncScroll = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    const gutter = gutterRef.current;
    if (gutter) gutter.scrollTop = area.scrollTop;
    const marks = highlightRef.current;
    if (marks) {
      marks.scrollTop = area.scrollTop;
      marks.scrollLeft = area.scrollLeft;
    }
  }, []);

  // ----- Matching --------------------------------------------------------
  // Lower-casing 4 MiB is not free, so it's memoised on the buffer rather
  // than redone for every keystroke in the find box.
  const haystack = useMemo(
    () => (matchCase ? draft : draft.toLowerCase()),
    [draft, matchCase],
  );
  const needle = matchCase ? query : query.toLowerCase();
  const matches = useMemo(
    () => (findOpen ? findMatches(haystack, needle) : []),
    [findOpen, haystack, needle],
  );
  const cappedMatches = matches.length >= MAX_MATCHES;

  // Editing the buffer can drop the hit the user was standing on.
  useEffect(() => {
    setActiveMatch((i) =>
      matches.length === 0 ? 0 : Math.min(i, matches.length - 1),
    );
  }, [matches]);

  /** Select a range in the buffer and scroll it into view without stealing
   *  focus from whichever find field the user is typing in. `text` is passed
   *  in because callers often work from a buffer React hasn't committed yet. */
  const revealRange = useCallback(
    (text: string, start: number, end: number) => {
      const area = areaRef.current;
      if (!area) return;
      const previous = document.activeElement as HTMLElement | null;
      // Selecting only paints (and auto-scrolls) while the textarea has
      // focus, so borrow it for a moment and hand it straight back.
      area.focus({ preventScroll: true });
      area.setSelectionRange(start, end);
      if (!wrap) {
        // Centre the hit vertically. Only safe with wrapping off, where one
        // logical line is exactly one visual row.
        const style = getComputedStyle(area);
        const lineHeight = parseFloat(style.lineHeight) || 18;
        const padTop = parseFloat(style.paddingTop) || 0;
        const line = lineOfOffset(text, start);
        area.scrollTop = Math.max(
          0,
          padTop + line * lineHeight - (area.clientHeight - lineHeight) / 2,
        );
      }
      if (previous && previous !== area) previous.focus();
      syncScroll();
    },
    [wrap, syncScroll],
  );

  /** Jump `delta` hits away, wrapping around at either end. */
  const step = useCallback(
    (delta: number) => {
      if (!matches.length) return;
      const next = (activeMatch + delta + matches.length) % matches.length;
      setActiveMatch(next);
      revealRange(draft, matches[next], matches[next] + query.length);
    },
    [matches, activeMatch, draft, query.length, revealRange],
  );

  /** Re-run the search and land on the first hit — used when the needle or
   *  the case option changes, so the buffer follows along as you type. */
  const research = useCallback(
    (nextQuery: string, nextCase: boolean) => {
      // Reuse the memoised lower-cased copy unless the case option itself is
      // what changed — re-folding 4 MiB per keystroke would be felt.
      const hay = nextCase ? draft : matchCase ? draft.toLowerCase() : haystack;
      const found = findMatches(
        hay,
        nextCase ? nextQuery : nextQuery.toLowerCase(),
      );
      setActiveMatch(0);
      if (found.length) {
        revealRange(draft, found[0], found[0] + nextQuery.length);
      }
    },
    [draft, haystack, matchCase, revealRange],
  );

  const openFind = useCallback(
    (withReplace: boolean) => {
      setFindOpen(true);
      if (withReplace) setShowReplace(true);
      // Seed the needle from the selection, the way editors and browsers do.
      const area = areaRef.current;
      if (area && area.selectionStart !== area.selectionEnd) {
        const picked = area.value.slice(area.selectionStart, area.selectionEnd);
        if (picked && !picked.includes("\n")) {
          setQuery(picked);
          // Stand on the hit that was selected instead of snapping back to
          // the top of the file.
          const found = findMatches(
            matchCase ? draft : haystack,
            matchCase ? picked : picked.toLowerCase(),
          );
          const at = found.findIndex((m) => m >= area.selectionStart);
          setActiveMatch(at === -1 ? 0 : at);
        }
      }
      // The field may only mount in this commit, so focus after the paint.
      requestAnimationFrame(() => {
        const input = findInputRef.current;
        input?.focus();
        input?.select();
      });
    },
    [draft, haystack, matchCase],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setShowReplace(false);
    // Hand focus back so typing continues in the buffer, at the last hit.
    areaRef.current?.focus();
  }, []);

  const commitDraft = useCallback(
    (text: string) => {
      setDraft(text);
      setDirty(text !== (content ?? ""));
    },
    [content],
  );

  const replaceCurrent = useCallback(() => {
    if (!canEdit || !query || !matches.length) return;
    const index = Math.min(activeMatch, matches.length - 1);
    const start = matches[index];
    const next =
      draft.slice(0, start) + replacement + draft.slice(start + query.length);
    commitDraft(next);

    // Resume past the inserted text: a replacement that contains the needle
    // ("a" -> "aa") would otherwise trap us on the same spot forever.
    const cursor = start + replacement.length;
    const found = findMatches(
      matchCase ? next : next.toLowerCase(),
      needle,
    );
    let nextIndex = found.findIndex((m) => m >= cursor);
    if (nextIndex === -1) nextIndex = 0;
    setActiveMatch(nextIndex);
    if (found.length) {
      const at = found[nextIndex];
      // Wait for React to flush the new text before scrolling to an offset
      // that only exists in it.
      requestAnimationFrame(() => revealRange(next, at, at + query.length));
    }
  }, [
    canEdit,
    query,
    matches,
    activeMatch,
    draft,
    replacement,
    commitDraft,
    matchCase,
    needle,
    revealRange,
  ]);

  const replaceAll = useCallback(() => {
    if (!canEdit || !query || !matches.length) return;
    // Built by slicing between hits, so the replacement text is inserted
    // verbatim — no `$1`-style expansion surprises.
    const parts: string[] = [];
    let from = 0;
    for (const at of matches) {
      parts.push(draft.slice(from, at));
      from = at + query.length;
    }
    parts.push(draft.slice(from));
    commitDraft(parts.join(replacement));
    setActiveMatch(0);
  }, [canEdit, query, matches, draft, replacement, commitDraft]);

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

  // Shortcuts live here rather than in the app-level handler because only
  // this component knows about the draft and the find state. Ctrl+R is
  // preventDefault-ed on purpose: unhandled, the webview would reload the app
  // and throw away unsaved edits.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === "Escape") {
        e.preventDefault();
        if (findOpen) closeFind();
        else requestClose();
        return;
      }
      if (mod && key === "f") {
        e.preventDefault();
        openFind(false);
        return;
      }
      if (mod && (key === "r" || key === "h")) {
        e.preventDefault();
        openFind(canEdit);
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        if (findOpen) step(e.shiftKey ? -1 : 1);
        else openFind(false);
        return;
      }
      if (mod && key === "s") {
        e.preventDefault();
        if (editable) save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    requestClose,
    save,
    editable,
    canEdit,
    findOpen,
    closeFind,
    openFind,
    step,
  ]);

  // ----- Match highlighting ----------------------------------------------
  // A textarea can't style its own content, so the hits are painted by a
  // mirror layer behind the (transparent) buffer. Same trade-off as the
  // gutter: only with wrapping off, where a logical line is one visual row
  // and the mirror can't disagree with the textarea about where lines break.
  const showHighlights = findOpen && !loading && !wrap && matches.length > 0;
  const highlightNodes = useMemo<ReactNode[] | null>(() => {
    if (!showHighlights) return null;
    const active = matches[Math.min(activeMatch, matches.length - 1)];
    const boxed =
      matches.length <= MAX_HIGHLIGHTS ? matches : [active];
    const nodes: ReactNode[] = [];
    let from = 0;
    for (const at of boxed) {
      if (at > from) nodes.push(draft.slice(from, at));
      nodes.push(
        <mark key={at} className={at === active ? "active" : undefined}>
          {draft.slice(at, at + query.length)}
        </mark>,
      );
      from = at + query.length;
    }
    nodes.push(draft.slice(from));
    return nodes;
  }, [showHighlights, matches, activeMatch, draft, query.length]);

  // Re-sync after anything that can change scroll extents or the mirror: a
  // new file, an edit that adds or removes lines, or toggling wrap back off.
  useEffect(() => {
    syncScroll();
  }, [gutterText, showGutter, highlightNodes, syncScroll]);

  const matchLabel = matches.length
    ? `${Math.min(activeMatch, matches.length - 1) + 1} / ${matches.length}${cappedMatches ? "+" : ""}`
    : query
      ? "No results"
      : "";

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
            <button
              className={`icon-btn small ${findOpen ? "active" : ""}`}
              onClick={() => (findOpen ? closeFind() : openFind(false))}
              disabled={loading}
              title="Find (Ctrl+F)"
              aria-label="Find"
              aria-pressed={findOpen}
            >
              <Search size={14} />
            </button>
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

        {findOpen && (
          <div className="text-viewer-find" role="search">
            <div className="find-row">
              <Search size={13} className="find-icon" aria-hidden="true" />
              <input
                ref={findInputRef}
                className="find-input"
                value={query}
                placeholder="Find"
                spellCheck={false}
                aria-label="Find"
                onChange={(e) => {
                  const value = e.target.value;
                  setQuery(value);
                  // Jumping to a hit borrows focus for a moment, which would
                  // cancel an in-progress IME composition — so mid-composition
                  // keystrokes only update the count, and the jump waits for
                  // compositionend.
                  if (!(e.nativeEvent as InputEvent).isComposing) {
                    research(value, matchCase);
                  }
                }}
                onCompositionEnd={(e) =>
                  research(e.currentTarget.value, matchCase)
                }
                onKeyDown={(e) => {
                  // `isComposing` guards the Enter that commits an IME
                  // candidate — that one isn't a "next match" request.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    step(e.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span className="find-count">{matchLabel}</span>
              <button
                className={`icon-btn small ${matchCase ? "active" : ""}`}
                onClick={() => {
                  const next = !matchCase;
                  setMatchCase(next);
                  research(query, next);
                }}
                title="Match case"
                aria-label="Match case"
                aria-pressed={matchCase}
              >
                <CaseSensitive size={14} />
              </button>
              <button
                className="icon-btn small"
                onClick={() => step(-1)}
                disabled={!matches.length}
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
              >
                <ChevronUp size={14} />
              </button>
              <button
                className="icon-btn small"
                onClick={() => step(1)}
                disabled={!matches.length}
                title="Next match (Enter)"
                aria-label="Next match"
              >
                <ChevronDown size={14} />
              </button>
              <button
                className={`icon-btn small ${showReplace ? "active" : ""}`}
                onClick={() => {
                  const next = !showReplace;
                  setShowReplace(next);
                  if (next) {
                    requestAnimationFrame(() =>
                      replaceInputRef.current?.focus(),
                    );
                  }
                }}
                disabled={!canEdit}
                title={
                  canEdit
                    ? "Toggle replace (Ctrl+R)"
                    : "This file is read-only"
                }
                aria-label="Toggle replace"
                aria-pressed={showReplace}
              >
                <Replace size={14} />
              </button>
              <button
                className="icon-btn small"
                onClick={closeFind}
                title="Close find (Esc)"
                aria-label="Close find"
              >
                <X size={14} />
              </button>
            </div>

            {showReplace && (
              <div className="find-row">
                <Replace size={13} className="find-icon" aria-hidden="true" />
                <input
                  ref={replaceInputRef}
                  className="find-input"
                  value={replacement}
                  placeholder="Replace with"
                  spellCheck={false}
                  aria-label="Replace with"
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (e.ctrlKey || e.metaKey) replaceAll();
                      else replaceCurrent();
                    }
                  }}
                />
                <button
                  className="btn find-btn"
                  onClick={replaceCurrent}
                  disabled={!canEdit || !matches.length}
                  title="Replace this match (Enter)"
                >
                  Replace
                </button>
                <button
                  className="btn find-btn"
                  onClick={replaceAll}
                  disabled={!canEdit || !matches.length}
                  title={
                    cappedMatches
                      ? `Replace the first ${MAX_MATCHES} matches (Ctrl+Enter)`
                      : "Replace all matches (Ctrl+Enter)"
                  }
                >
                  <ReplaceAll size={13} />
                  All
                </button>
              </div>
            )}
          </div>
        )}

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
            <>
              {showGutter && (
                <div
                  className="text-viewer-gutter"
                  ref={gutterRef}
                  aria-hidden="true"
                  // Widens with the line count so four- and six-digit files
                  // both sit flush against the text.
                  style={{ minWidth: `${String(lineCount).length}ch` }}
                >
                  {gutterText}
                </div>
              )}
              <div className="text-viewer-buffer">
                {highlightNodes && (
                  <div
                    className="text-viewer-highlights"
                    ref={highlightRef}
                    aria-hidden="true"
                  >
                    {highlightNodes}
                  </div>
                )}
                <textarea
                  className={`text-viewer-area ${wrap ? "wrap" : ""}`}
                  ref={areaRef}
                  value={draft}
                  // Frozen mid-save so keystrokes can't be lost when the parent
                  // re-baselines the content on success.
                  readOnly={!editable || saving}
                  spellCheck={false}
                  wrap={wrap ? "soft" : "off"}
                  aria-label={`Content of ${title}`}
                  onScroll={syncScroll}
                  onChange={(e) => commitDraft(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
