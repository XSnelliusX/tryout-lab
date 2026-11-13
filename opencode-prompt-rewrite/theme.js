function pickColor(...candidates) {
  for (const value of candidates) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (!trimmed || trimmed === "none" || trimmed === "transparent") continue
    return trimmed
  }
  return undefined
}

export function resolvePalette(theme = {}) {
  const t = theme ?? {}
  const text = t.text ?? {}
  const bg = t.background ?? {}
  const raised = bg.raised ?? {}
  const border = t.border ?? {}
  const feedbackText = text.feedback ?? {}
  const feedbackBg = bg.feedback ?? {}
  const actionText = text.action ?? {}
  const actionBg = bg.action ?? {}
  const syntax = t.syntax ?? {}

  const accent = pickColor(
    t.accent?.base,
    t.accent,
    t.primary,
    syntax.keyword,
    "#7aa2f7",
  )

  return {
    textBase: pickColor(text.base, typeof t.text === "string" ? t.text : undefined, "#e6edf3"),
    textMuted: pickColor(text.muted, t.muted, "#8b949e"),
    textFaint: pickColor(text.faint, text.muted, "#6e7681"),
    accent,
    secondary: pickColor(t.secondary, syntax.function, "#bb9af7"),
    info: pickColor(feedbackText.info, t.info, t.status?.info, syntax.type, "#7dcfff"),
    success: pickColor(feedbackText.success, t.success, t.status?.success, t.diff?.text?.added, "#9ece6a"),
    warning: pickColor(feedbackText.warning, t.warning, t.status?.warning, "#e0af68"),
    error: pickColor(feedbackText.danger, feedbackText.error, t.error, t.status?.error, t.diff?.text?.removed, "#f7768e"),
    border: pickColor(border.base, border.subtle, typeof t.border === "string" ? t.border : undefined, "#3b4261"),
    borderActive: pickColor(border.active, t.borderActive, accent, "#7aa2f7"),
    bgPanel: pickColor(raised.base, t.backgroundPanel, bg.panel),
    bgElevated: pickColor(raised.high, t.backgroundElement, raised.max),
    bgActionPrimary: pickColor(actionBg.primary, t.primary, accent, "#3d59a1"),
    textActionPrimary: pickColor(actionText.primary, text.base, "#ffffff"),
    bgBadgeInfo: pickColor(feedbackBg.info),
    bgBadgeSuccess: pickColor(feedbackBg.success),
    bgBadgeWarning: pickColor(feedbackBg.warning),
    bgBadgeError: pickColor(feedbackBg.danger, feedbackBg.error),
  }
}
