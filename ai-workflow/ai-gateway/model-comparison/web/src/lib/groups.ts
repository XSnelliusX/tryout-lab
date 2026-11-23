import { DEFAULT_PRICE_SENSITIVITY, scoreFor, valueFor, type CostMode, type Task, type ValueMode } from "./tasks";
import type { Row } from "./types";

// One base model with its effort variants indented beneath it.
export interface ModelGroup {
  key: string;
  base: Row;
  // Effort variants, best value first. Empty when the model has no variants.
  variants: Row[];
}

// Groups rows by base model.
//
// The snapshot's `effort` field is not a reliable variant flag. Some base models
// carry an effort label too (for example claude-opus-5 is labelled "max", the
// default), so the grouping uses the slug structure instead. A row is a variant of
// the longest other row whose slug it extends with "-". Rows that extend nothing
// are bases. A variant whose base is filtered out stays as its own group.
export function groupByBase(rows: Row[], task: Task, mode: CostMode, preference: ValueMode = "price", sensitivity = DEFAULT_PRICE_SENSITIVITY): ModelGroup[] {
  if (rows.some((r) => r.release_slug)) {
    return groupByRelease(rows, task, mode, preference, sensitivity);
  }
  const slugs = new Set(rows.map((r) => r.slug));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const parentOf = new Map<string, string>();
  for (const r of rows) {
    const parent = longestPrefixParent(r, slugs, bySlug);
    if (parent) parentOf.set(r.slug, parent);
  }

  const variantsOf = new Map<string, Row[]>();
  for (const [child, parent] of parentOf) {
    let root = parent;
    while (parentOf.has(root)) root = parentOf.get(root)!;
    const list = variantsOf.get(root) ?? [];
    list.push(bySlug.get(child)!);
    variantsOf.set(root, list);
  }

  const groups: ModelGroup[] = [];
  for (const r of rows) {
    if (parentOf.has(r.slug)) continue;
    const variants = (variantsOf.get(r.slug) ?? []).slice().sort(byValueDesc(task, mode, preference, sensitivity));
    groups.push({ key: r.slug, base: r, variants });
  }

  return groups.sort(byBestValue(task, mode, preference, sensitivity));
}

// groupByRelease uses the AA release slug from the enriched snapshot. It is
// more reliable than slug-prefix grouping because AA variant slugs do not
// always extend the release slug.
function groupByRelease(rows: Row[], task: Task, mode: CostMode, preference: ValueMode, sensitivity: number): ModelGroup[] {
  const byRelease = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.release_slug || r.slug;
    const list = byRelease.get(key) ?? [];
    list.push(r);
    byRelease.set(key, list);
  }

  const groups: ModelGroup[] = [];
  for (const [key, members] of byRelease) {
    const base = members.find((r) => r.slug === key)
      ?? [...members].sort((a, b) => a.slug.length - b.slug.length || a.slug.localeCompare(b.slug))[0];
    const variants = members
      .filter((r) => r.slug !== base.slug)
      .sort(byValueDesc(task, mode, preference, sensitivity));
    groups.push({ key, base, variants });
  }

  return groups.sort(byBestValue(task, mode, preference, sensitivity));
}

function byBestValue(task: Task, mode: CostMode, preference: ValueMode, sensitivity: number) {
  return (a: ModelGroup, b: ModelGroup) => {
    const x = bestValue(a, task, mode, preference, sensitivity), y = bestValue(b, task, mode, preference, sensitivity);
    return x === y ? 0 : y > x ? 1 : -1;
  };
}

// longestPrefixParent returns the longest other row in view that this row is a
// variant of. A variant extends the parent's slug with "-" and shares the parent's
// display name before the parenthetical, the same rule the Go catalog uses. The
// name check stops "claude-opus-5" from claiming "claude-opus-5-5-low".
function longestPrefixParent(row: Row, slugs: Set<string>, bySlug: Map<string, Row>): string | null {
  let best: string | null = null;
  for (const candidate of slugs) {
    if (candidate === row.slug) continue;
    if (!row.slug.startsWith(candidate + "-")) continue;
    if (best !== null && candidate.length <= best.length) continue;
    if (baseNameKey(bySlug.get(candidate)!.name) !== baseNameKey(row.name)) continue;
    best = candidate;
  }
  return best;
}

// baseNameKey is the display name without its parenthetical, lower-cased, so
// "Claude Opus 5.5 (Low)" and "Claude Opus 5.5 (Max)" share a key.
function baseNameKey(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

// bestValue is the highest value across a group, or -Infinity when nothing in it
// has a value, which sorts those groups last.
export function bestValue(g: ModelGroup, task: Task, mode: CostMode, preference: ValueMode = "price", sensitivity = DEFAULT_PRICE_SENSITIVITY): number {
  let best = -Infinity;
  for (const r of [g.base, ...g.variants]) {
    const v = valueFor(r, task, mode, preference, sensitivity);
    if (v !== null && v > best) best = v;
  }
  return best;
}

function byValueDesc(task: Task, mode: CostMode, preference: ValueMode, sensitivity: number) {
  return (a: Row, b: Row) => {
    const va = valueFor(a, task, mode, preference, sensitivity);
    const vb = valueFor(b, task, mode, preference, sensitivity);
    if (va === null && vb === null) return (scoreFor(b, task) ?? 0) - (scoreFor(a, task) ?? 0);
    if (va === null) return 1;
    if (vb === null) return -1;
    return va === vb ? 0 : vb > va ? 1 : -1;
  };
}
