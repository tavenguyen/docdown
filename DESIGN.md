---
version: 1
name: DocDown Design System
description: "Dark developer utility UI for DocDown. Near-black surfaces, a single green accent, hairline borders, monospace metadata and restrained motion. The interface should feel like a precise local tool, not a marketing site."
---

# DocDown Design System

## Visual Theme & Atmosphere

DocDown is a local document utility. The UI should read as a calm, precise
developer tool: dark, low-glare surfaces; dense but breathable information;
one green accent reserved for action and state. Avoid decorative gradients,
illustration, oversized marketing type and purple "AI" palettes.

Reference direction: technical documentation / terminal-adjacent interfaces.
The `linear.app` DESIGN.md from `VoltAgent/awesome-design-md` (MIT) informed the
structure and restraint; DocDown uses its own green accent and utility layout.

## Color Palette & Roles

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#070b09` | Page background |
| `--surface` | `#0d120f` | Base card surface |
| `--surface-2` | `#121914` | Raised surface / hover |
| `--surface-3` | `#18211b` | Selected / pressed surface |
| `--hairline` | `#253129` | Default 1px border |
| `--hairline-strong` | `#34443a` | Emphasized border |
| `--ink` | `#f2f7f3` | Primary text |
| `--ink-muted` | `#a3b2a8` | Secondary text |
| `--ink-subtle` | `#74847a` | Metadata, placeholders |
| `--accent` | `#22c55e` | Primary action, active state |
| `--accent-hover` | `#4ade80` | Hover / focus |
| `--on-accent` | `#04150a` | Text on green |
| `--success` | `#4ade80` | Success |
| `--warning` | `#fbbf24` | Warning |
| `--danger` | `#f87171` | Error |
| `--ring` | `#86efac` | Focus ring |

Rules:

- Green is an action/accent color, not a background wash. Use it for the primary
  button, active step, status dot and small badges.
- Never use color alone to communicate state. Pair it with text or an icon.
- Body text must meet 4.5:1 contrast. Metadata must remain legible at 11px.

## Typography

- UI text: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- Labels, metadata, file sizes, part badges: `ui-monospace, SFMono-Regular,
  Menlo, Consolas, "Liberation Mono", monospace`.
- Do not fetch web fonts. The extension must work offline and under MV3 CSP.
- Display: 34–58px, weight 650–700, tight tracking (`-0.04em`).
- Section titles: 13px, weight 700.
- Body: 15–16px, line-height 1.55.
- Metadata: 10–12px, monospace, uppercase only for short labels.

## Spacing & Layout

- Scale: 4, 8, 12, 16, 20, 24, 32, 48, 64.
- Page shell: max 1120px, 16px side gutters; 10px at 375px.
- Card radius: 14–16px. Inputs/buttons: 9–12px. Badges: pill.
- Desktop workspace: content column + summary column, 16px gap.
- At ≤900px: one column, summary first.
- At 375px: no horizontal scroll; 44px minimum touch targets; buttons full width
  where appropriate.
- Sticky summary is allowed only on desktop.

## Components

### Primary button

- Green background, dark text, 46px minimum height.
- Full width in the summary panel.
- Hover brightens; disabled reduces opacity and uses `not-allowed`.
- Visible `:focus-visible` ring using `--ring`.

### Secondary / text button

- Transparent background, hairline border only on hover.
- Used for "Chọn lại", remove and other low-priority actions.

### Dropzone

- 1.5px dashed `--hairline-strong`, 13px radius, min height 176px.
- Hover/drag: green border and a very subtle green tint.
- Keyboard focus uses `:focus-within` ring.
- Contains a large label, a short instruction and an inline SVG icon.

### File row

- 1px hairline border, 11px radius.
- Part badge (mono, green border), file name (600), metadata (mono, subtle).
- Remove button is 32×32 with a clear `aria-label`; error hover only.

### Status

- Bordered inline block with a dot and text.
- `data-tone="info|success|error"` changes border/dot/text.
- `aria-live="polite"` on the text.

### Cards

- Surface gradient from `--surface-2` to `--surface`, hairline border,
  restrained shadow. No glassmorphism, no heavy blur.

### Icons

- Inline SVG only (Lucide-style 1.8–2px strokes).
- Decorative icons use `aria-hidden="true"`.
- No emoji as functional icons.

## Motion

- 150–200ms ease for hover, color and border transitions.
- One subtle entrance/translate at most; no looping animation.
- Respect `prefers-reduced-motion: reduce`.

## Do / Don't

Do:

- Keep one primary action per view.
- Use monospace for technical metadata.
- Show validation before enabling merge.
- Explain local-only processing near the action.
- Test at 375px, 768px, 1024px and 1440px.

Don't:

- Add a second saturated accent.
- Use gradients as decoration across large surfaces.
- Hide errors in color alone.
- Use `<div>` for clickable controls; use `<button>`/`<label>`.
- Add external fonts, CDNs or runtime network calls.
- Put user-controlled strings into `innerHTML`.

## Agent Prompt Guide

When changing UI in this repo:

1. Read this file and `.opencode/skills/docdown-design/SKILL.md`.
2. Reuse the tokens above; do not invent a parallel palette.
3. Keep the existing IDs and behavior in `merge.html`/`merge.js`.
4. Verify keyboard focus, 375px layout and contrast.
5. Run `node --check` and the test suite.
