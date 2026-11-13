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
  const formFieldBg = bg.formField ?? {}
  const diff = t.diff ?? {}
  const diffText = diff.text ?? {}
  const diffBg = diff.background ?? {}
  const syntax = t.syntax ?? {}

  const accent = pickColor(
    t.accent?.base,
    t.accent,
    t.primary,
    syntax.keyword,
    "#7aa2f7",
  )

  const textBase = pickColor(text.base, typeof t.text === "string" ? t.text : undefined, "#e6edf3")
  const success = pickColor(feedbackText.success, t.success, t.status?.success, diffText.added, "#9ece6a")
  const error = pickColor(feedbackText.danger, feedbackText.error, t.error, t.status?.error, diffText.removed, "#f7768e")

  return {
    textBase,
    textMuted: pickColor(text.muted, t.muted, "#8b949e"),
    textFaint: pickColor(text.faint, text.muted, "#6e7681"),
    textFormField: pickColor(text.formField?.base, typeof text.formField === "string" ? text.formField : undefined, textBase),
    accent,
    secondary: pickColor(t.secondary, syntax.function, "#bb9af7"),
    info: pickColor(feedbackText.info, t.info, t.status?.info, syntax.type, "#7dcfff"),
    success,
    warning: pickColor(feedbackText.warning, t.warning, t.status?.warning, "#e0af68"),
    error,
    border: pickColor(border.base, border.subtle, typeof t.border === "string" ? t.border : undefined, "#3b4261"),
    borderSubtle: pickColor(border.subtle, border.base, typeof t.border === "string" ? t.border : undefined, "#30363d"),
    borderActive: pickColor(border.active, t.borderActive, accent, "#7aa2f7"),
    bgBase: pickColor(bg.base),
    bgPanel: pickColor(raised.base, t.backgroundPanel, bg.panel),
    bgElevated: pickColor(raised.high, t.backgroundElement, raised.max),
    bgHover: pickColor(actionBg.hover, raised.active, raised.high, raised.max, t.backgroundElement, raised.base),
    bgFormField: pickColor(formFieldBg.base, typeof bg.formField === "string" ? bg.formField : undefined, raised.base),
    bgActionPrimary: pickColor(actionBg.primary, t.primary, accent, "#3d59a1"),
    bgActionActive: pickColor(actionBg.active, actionBg.hover, raised.active, raised.high),
    textActionPrimary: pickColor(actionText.primary, text.base, "#ffffff"),
    bgBadgeInfo: pickColor(feedbackBg.info),
    bgBadgeSuccess: pickColor(feedbackBg.success),
    bgBadgeWarning: pickColor(feedbackBg.warning),
    bgBadgeError: pickColor(feedbackBg.danger, feedbackBg.error),
    diffAdded: pickColor(diffText.added, success),
    diffRemoved: pickColor(diffText.removed, error),
    diffBgAdded: pickColor(diffBg.added, feedbackBg.success),
    diffBgRemoved: pickColor(diffBg.removed, feedbackBg.danger, feedbackBg.error),
  }
}
