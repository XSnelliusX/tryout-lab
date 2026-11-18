// Display names for AA effort levels, as they appear in the variant rows.
const NAMES: Record<string, string> = {
  none: "No",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortName(level: string): string {
  return NAMES[level] ?? level;
}
