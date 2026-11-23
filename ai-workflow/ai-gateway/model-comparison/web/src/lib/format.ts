// Formatting helpers. Null means "not measured" and is shown as an en dash,
// never as zero.

const NOT_MEASURED = "–";

export function formatNumber(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return NOT_MEASURED;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatUsd(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return NOT_MEASURED;
  const extra = v > 0 && v < 10 ** -digits ? 8 : digits;
  if (v > 0 && v < 1e-8) return `<$0.00000001`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: extra, minimumFractionDigits: digits })}`;
}

export function formatSeconds(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return NOT_MEASURED;
  return `${v.toFixed(2)} s`;
}

export function formatSpeed(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return NOT_MEASURED;
  return `${Math.round(v)} tok/s`;
}

export function formatContext(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return NOT_MEASURED;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${Math.round(tokens)}`;
}

export function formatMetric(value: number | null | undefined, scale: "index" | "percent"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_MEASURED;
  return scale === "percent" ? `${formatNumber(value, 1)}%` : formatNumber(value, 1);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return NOT_MEASURED;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return NOT_MEASURED;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_MEASURED;
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const DEFAULT_TAG = /,?\s*Default Fallback/g;

// Artificial Analysis appends "Default Fallback" to some names. It is internal
// bookkeeping, so the UI drops it. The stored name stays unchanged.
export function displayName(name: string): string {
  return name.replace(DEFAULT_TAG, "").replace(/\s*\(\)/g, "").trim();
}
