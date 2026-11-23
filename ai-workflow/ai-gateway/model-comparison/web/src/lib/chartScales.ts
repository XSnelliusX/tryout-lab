// log1p is approximately linear near zero and logarithmic for large values.
// Unlike a logarithmic axis, it has a true, plottable zero.
export function costAxisPosition(cost: number, reference: number): number {
  return Math.log1p(cost / reference);
}

export function costAxisValue(position: number, reference: number): number {
  return Math.expm1(position) * reference;
}

export function scoreExtent(values: number[]): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 100];
  const min = Math.min(...finite), max = Math.max(...finite);
  const padding = Math.max((max - min) * 0.08, 2);
  return [Math.max(0, Math.floor(min - padding)), Math.ceil(max + padding)];
}

export function medianPositive(values: number[], fallback: number): number {
  const sorted = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
