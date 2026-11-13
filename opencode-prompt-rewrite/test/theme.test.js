import test from "node:test"
import assert from "node:assert/strict"
import { resolvePalette } from "../theme.js"

test("resolvePalette resolves OpenCode V2 nested semantic tokens and preserves transparent backgrounds", () => {
  const palette = resolvePalette({
    text: {
      base: "#f0f6fc",
      muted: "#9198a1",
      faint: "#656d76",
      feedback: {
        info: "#58a6ff",
        success: "#3fb950",
        warning: "#d29922",
        danger: "#f85149",
      },
      action: { primary: "#0d1117" },
    },
    background: {
      raised: { base: "none", high: "#161b22" },
      action: { primary: "#7ee787" },
      feedback: {
        info: "#0c2d6b",
        success: "#0f5323",
        warning: "#5a3d00",
        danger: "#67060c",
      },
    },
    border: { base: "#30363d", active: "#58a6ff" },
    accent: { base: "#a371f7" },
    syntax: { function: "#d2a8ff" },
  })

  assert.equal(palette.textBase, "#f0f6fc")
  assert.equal(palette.textMuted, "#9198a1")
  assert.equal(palette.textFaint, "#656d76")
  assert.equal(palette.accent, "#a371f7")
  assert.equal(palette.secondary, "#d2a8ff")
  assert.equal(palette.info, "#58a6ff")
  assert.equal(palette.success, "#3fb950")
  assert.equal(palette.warning, "#d29922")
  assert.equal(palette.error, "#f85149")
  assert.equal(palette.border, "#30363d")
  assert.equal(palette.borderActive, "#58a6ff")
  // "none" is filtered out so transparent terminal backgrounds aren't filled solidly
  assert.equal(palette.bgPanel, undefined)
  assert.equal(palette.bgElevated, "#161b22")
  assert.equal(palette.bgActionPrimary, "#7ee787")
  assert.equal(palette.textActionPrimary, "#0d1117")
  assert.equal(palette.bgBadgeSuccess, "#0f5323")
})

test("resolvePalette supports legacy flat tokens and provides safe defaults", () => {
  const legacy = resolvePalette({
    text: "#ffffff",
    muted: "#aaaaaa",
    primary: "#112233",
    secondary: "#445566",
    info: "#0088ff",
    success: "#00aa44",
    warning: "#ffaa00",
    error: "#ff0044",
    border: "#222222",
    borderActive: "#999999",
    backgroundPanel: "#101010",
    backgroundElement: "transparent",
  })

  assert.equal(legacy.textBase, "#ffffff")
  assert.equal(legacy.accent, "#112233")
  assert.equal(legacy.bgPanel, "#101010")
  assert.equal(legacy.bgElevated, undefined)
  assert.equal(legacy.borderActive, "#999999")

  const empty = resolvePalette()
  assert.ok(empty.textBase)
  assert.ok(empty.accent)
  assert.ok(empty.border)
})
