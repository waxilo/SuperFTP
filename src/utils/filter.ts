/**
 * Match a file name against a user-entered filter string.
 *
 * Matching is always case-insensitive and unanchored (the pattern can match
 * anywhere in the name).
 *
 * - No wildcards: plain substring match. e.g. `report` matches `2024-report.csv`.
 * - `*`: matches any run of characters (including the empty string).
 *   e.g. `hk*20260413` matches `hk_export_20260413.csv` and `hk20260413`.
 * - `?`: matches exactly one character. e.g. `hk?20260413` matches
 *   `hk_20260413` but not `hk__20260413`.
 *
 * Compiled regexes are cached because the filter is re-evaluated on every
 * render while the user is still typing.
 */
const CACHE = new Map<string, RegExp>();

export function matchesFilter(name: string, filter: string): boolean {
  const f = filter.trim();
  if (!f) return true;
  return compile(f).test(name);
}

function compile(filter: string): RegExp {
  const cached = CACHE.get(filter);
  if (cached) return cached;

  // First escape all regex metacharacters *except* `*` and `?`, then turn
  // those two into their regex equivalents. Order matters: if we escaped
  // them too the resulting `\*` / `\?` would be literal characters.
  const body = filter
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const re = new RegExp(body, "i");
  // Naive cap so a pathological session doesn't grow the cache forever.
  if (CACHE.size > 64) CACHE.clear();
  CACHE.set(filter, re);
  return re;
}
