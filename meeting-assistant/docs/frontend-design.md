# Frontend design

Personal desktop tool, opened in a browser window on a Mac (Safari or Chrome), minimum window width
1100 px. No responsive or mobile layouts. Vanilla HTML/CSS/ES modules: no build step, no dependencies, no CDN.

The guide is Apple's Human Interface Guidelines as packaged in
<https://github.com/dickwu/apple-design-skill> (`references/hig/liquid-glass.md` for the material rules and
review checklist; `materials.md`, `color.md`, `typography.md`, `layout.md`, `accessibility.md` and the
component pages for the rest).

## Thesis

The screen has one job: let me follow a Mandarin conversation in English, live. The characteristic
element is the bilingual caption stream — English leads, Chinese is the quieter second voice — and its
"live edge", where provisional text firms up into a final caption. Everything else is secondary:
reachable, never in the way.

## Two layers (Liquid Glass discipline)

- **Content layer (no glass):** the caption stream, forms, lists, results, text. Opaque or plain
  surfaces. The page background is the content layer's ambient backdrop: a very soft, static colour field
  (indigo → teal → warm) so the glass has something to pick up. Brand colour lives here, not on controls.
- **Functional layer (glass, regular variant):** exactly these surfaces
  1. floating top toolbar (capsule groups),
  2. floating left sidebar (sessions), thicker and more opaque,
  3. floating right inspector, thicker and more opaque because it is text heavy,
  4. sheets (modal dialogs),
  5. toasts.

  Nothing else gets `backdrop-filter`. Glass is never nested in glass: controls inside a glass surface are
  plain fills or tints on that surface. The clear variant exists in the component set but the app uses regular.
- Content scrolls beneath the toolbar with a scroll edge effect (fade and blur band), not a solid bar background.

## Colour budget

- Labels on glass are monochrome. One tinted (prominent) control per view: Record when idle (accent), Stop
  when recording (red). Destructive actions are red text, tinted only inside a confirmation sheet.
- Accent: indigo `#5856D6` light / `#5E5CE6` dark. Status: red `#FF3B30` / `#FF453A` (recording, errors),
  orange `#FF9500` / `#FF9F0A` (warnings), green `#34C759` / `#30D158` (healthy level, ready).
- Labels: primary `rgba(0,0,0,.85)` / `rgba(255,255,255,.85)`; secondary `.55`; tertiary `.3`.
  Body text contrast is at least 4.5:1 on its actual surface in both appearances.

## Material tokens (CSS custom properties; starting points from `liquid-glass.md`)

- regular: `backdrop-filter: blur(28px) saturate(1.5)`; fill light `rgba(255,255,255,.66)`, dark `rgba(38,38,44,.62)`
- thick (sidebar, inspector, sheet): blur 36px; fill light `rgba(250,250,252,.80)`, dark `rgba(30,30,36,.78)`
- clear: blur 12px, fill `.28`, only over media; optional 35% black dimming layer
- edge: 0.5px hairline border (`rgba(255,255,255,.5)` light / `rgba(255,255,255,.14)` dark), inset top
  highlight, soft drop shadow `0 12px 32px -12px rgba(0,0,0,.28)`. Capsule radius 999px, panel 20px, sheet
  26px; inner radii are concentric (outer radius minus padding).
- Accessibility states, all required:
  - `@media (prefers-reduced-transparency: reduce)` and `@supports not (backdrop-filter: blur(1px))`: opaque fills, no blur
  - `@media (prefers-contrast: more)`: opaque fills, 1px solid borders, stronger label colours
  - `@media (prefers-reduced-motion: reduce)`: no thumb slide, sheet spring or meter easing
  - manual override on `<html>`: `data-transparency="reduced"` (Safari lacks the media query)
- Light and dark through `prefers-color-scheme`, plus a `data-theme="light|dark"` override on `<html>`.

## Type

System stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`. Chinese text
carries `lang="zh-Hant"` and puts `"PingFang TC"` first. macOS built-in text styles are tokens: Body 13/16,
Headline 13/16 bold, Title 3 15/20, Title 2 17/22, Title 1 22/26, Callout 12/15, Subheadline 11/14,
Footnote 10/13. The caption stream is deliberately larger than Body because it is read at a glance: English
20/28 medium, Chinese 16/24 regular secondary, both scaled by `--caption-scale` (0.85–1.6, user adjustable).
Tabular numerals for times and meters.

## Controls

Desktop hit targets are 28×28 by default and never under 20×20. Every control has a visible keyboard focus
ring. Native elements first (`<button>`, `<dialog>`, `<input>`, `<select>`); custom elements only add
behaviour. Icons are a small original set drawn as inline SVG DOM (no SF Symbols files, no icon fonts),
1.5px strokes, `currentColor`, `aria-hidden`, with the button carrying `aria-label` and `title`.

## Hard technical constraints

- Pages are served with `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'`.
  No inline `<script>`, no inline `style=""` attributes in HTML, no `on*=""` attributes, no `eval`. Setting
  styles through the CSSOM (`el.style.setProperty`) is fine. ES modules load with
  `<script type="module" src="/x.js">`.
- No `innerHTML`, `outerHTML` or `insertAdjacentHTML` anywhere (transcript text is untrusted). DOM is built
  with `createElement` and `textContent`.
- No `localStorage`. `sessionStorage` only for the bearer token and view preferences.
- All files are flat in `meeting_assistant/static/` and served as `/name.ext`.
