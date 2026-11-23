import type { ChartTheme } from "./theme";

const CREATOR_COLORS: Record<string, [string, string]> = {
  Alibaba: ["#e65e00", "#ff8b43"], Amazon: ["#b85b00", "#ffae3d"],
  Anthropic: ["#c56445", "#e99778"], DeepSeek: ["#5059ce", "#8991ff"],
  Google: ["#276bcd", "#78aaff"], InclusionAI: ["#7552b4", "#b393f2"],
  Kimi: ["#7352a3", "#c09fe9"], Meta: ["#0874b9", "#57b1f2"],
  MiniMax: ["#c94675", "#f48eaf"], Mistral: ["#ca6420", "#ffa351"],
  NVIDIA: ["#5b8400", "#a4d346"], OpenAI: ["#177965", "#56c4a7"],
  SpaceXAI: ["#343c4b", "#c7d0df"], StepFun: ["#a25b23", "#e8a562"],
  "Z AI": ["#07819a", "#5dd1e1"],
};
const PALETTE = ["#356fca", "#138574", "#9a5caf", "#bb7441", "#c25372", "#467f9b", "#768a41", "#bd647d", "#7463ab", "#97722f", "#3c8e8c", "#b95d45", "#647eb3", "#866c55", "#a06794"];
const CREATORS = Object.keys(CREATOR_COLORS);

export function colorIndex(value: string, creator: boolean): number {
  if (creator && CREATORS.includes(value)) return CREATORS.indexOf(value);
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % PALETTE.length;
}

export function groupColor(value: string, creator: boolean, theme: ChartTheme): string {
  return creator && CREATOR_COLORS[value] ? CREATOR_COLORS[value][theme.surface === "#1c293a" ? 1 : 0] : PALETTE[colorIndex(value, creator)];
}

export function creatorColor(creator: string, theme: ChartTheme): string {
  return groupColor(creator, true, theme);
}
