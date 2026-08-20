# The ilumo brand system

The shared visual system for Ilumotech's products. JDSmartLearn implements it in
`tailwind.config.ts` and `src/app/globals.css`; ResultPeak adopts the same values through
`docs/resultpeak-branding-prompt.md`. **This file is the source of truth for both.** If a value
here and a value in a repo disagree, this file wins and the repo is wrong.

---

## 1. Brand architecture

**Endorsed.** Each product keeps its own name and leads with it. ilumo endorses rather than
replaces:

```
JDSmartLearn          ← the product name, in the display face, is what a user reads first
an Ilumotech product  ← the endorsement: small, muted, never competing with the product name
```

The **mark is shared**, unchanged, across every product. The **wordmark is per product**, set in
the display face. Nothing else varies — a teacher who uses both products should never wonder
whether they are in the same family.

**The endorsement is not a logo.** It is a line of text, set at 12px in `muted`. Do not lock it
up, box it, or give it a mark of its own.

---

## 2. The mark

Two ideas, one shape: a rounded square split diagonally between the two light brand colours,
crossed by an indigo capsule on the opposite diagonal. The capsule is the intersection — the
place where the two halves meet — which is also why indigo is the primary action colour.

Geometry, on a 64×64 grid (`public/logo-mark.svg` is the normative file):

| Element | Value |
|---|---|
| Square | `x=6 y=6 w=52 h=52 rx=15` — a 29% corner radius |
| Split | Mint fills the whole square; azure is clipped to the lower-right triangle `(64,0) (64,64) (0,64)` |
| Capsule | `x=9 y=23 w=46 h=18 rx=9`, rotated `45°` about `(32,32)` |

**Clear space:** one capsule-width (9 units at this scale, ≈14% of the mark's width) on all
sides. **Minimum size:** 20px. Below that use `favicon.svg`, which drops the split so the shape
still reads.

**The wordmark is never drawn inside an SVG.** It is HTML text in the display face, rendered by
`src/components/ui/Wordmark.tsx`. SVG `<text>` with a font-family stack substitutes a different
font on every device, which is what made the previous logo files render inconsistently. Any new
lockup follows the same rule: SVG for the mark, live text for the words.

### Files

| File | Use |
|---|---|
| `public/logo-mark.svg` | The mark, transparent. Header, and anywhere the wordmark is set beside it. |
| `public/logo-icon.svg` | Full-bleed tile for PWA install and app icons. Maskable-safe. |
| `src/app/icon.svg` | The tab icon, simplified for 16px. This file — not one in `public/` — is what Next serves, via the App Router icon convention. |
| `public/logo-mono.svg` | One colour via `currentColor`. Print, stamps, single-colour contexts. |

---

## 3. Colour

Sampled from the mark, then adjusted until every text pair clears WCAG AA. Ratios below are
measured by `npm run check:brand`, not estimated.

### Brand — indigo

| Token | Hex | Ratio on white | Use |
|---|---|---|---|
| `brand` | `#3852D6` | 6.28 (and 6.28 reversed) | Primary buttons, active nav, focus ring |
| `brandHover` | `#2F45B8` | 7.88 | Hover, pressed |
| `brandSoft` | `#EEF1FD` | — | Tinted surfaces |
| `brandRing` | `#93A4EE` | — | Focus ring **on** a brand-filled control |

Indigo is the only brand colour that works filled *and* as text without adjustment. That is why
it carries primary actions.

### Accent — azure

| Token | Hex | Ratio on white | Use |
|---|---|---|---|
| `accent` | `#3E9BFF` | **2.86 — fill only** | Accent fills, the AI generate moment |
| `accentText` | `#0F62C4` | 5.89 | Links, info text, the "ready to review" chip |
| `accentSoft` | `#EAF4FF` | — | Info callouts |

### Success — mint

| Token | Hex | Ratio on white | Use |
|---|---|---|---|
| `success` | `#5FE9B2` | **1.52 — fill only** (11.21 under `ink`) | Published, saved, finalised |
| `successText` | `#0E7A55` | 5.34 | Success text |
| `successSoft` | `#E6FBF2` | — | Success callouts |

### Neutrals and status

| Token | Hex | Ratio on white | Use |
|---|---|---|---|
| `ink` | `#1A1C1F` | 17.08 | Body text; matches the wordmark black |
| `muted` | `#5B6470` | 6.00 | Secondary text |
| `line` / `lineStrong` | `#E4E7EC` / `#CFD4DC` | — | Decorative only: card edges, dividers, hover edges |
| `lineInput` | `#7E8796` | 3.62 (3.41 on canvas) | The border that says "this is an input" |
| `surface` / `canvas` | `#FFFFFF` / `#F7F8FA` | — | Cards, page background |

`lineInput` is deliberately darker than a hairline. WCAG 1.4.11 requires 3:1 on the boundary
that identifies a control, and `lineStrong` is 1.49:1 — it may edge a card but must never be an
input's only border. The darker value also survives direct sunlight on a cheap screen, which is
the real test in the classrooms this is built for.
| `warn` / `warnSoft` | `#B45309` / `#FEF6E7` | 5.02 | Warnings |
| `danger` / `dangerSoft` | `#B42318` / `#FEF3F2` | 6.57 | Destructive, errors |

Warning and danger sit **outside** the logo palette deliberately. A warning that borrowed a brand
colour would stop reading as a warning.

### The rule everyone breaks first

> **`accent` and `success` are the logo colours at logo brightness. They are FILLS ONLY.**
> At 2.86:1 and 1.52:1 on white they fail AA badly as text. Any text or icon on a light
> background uses `accentText` / `successText`.

If you find yourself writing `text-accent` or `text-success`, you want `text-accentText` or
`text-successText`. `npm run check:brand` fails the build on the former.

### Colour proportion

Roughly 90% neutral, 8% indigo, 2% azure and mint combined. Mint appears **only** on a
completed state. It is the reward colour; spending it on decoration is what would make the
product look ordinary.

---

## 4. Type

| | |
|---|---|
| **Display** | Outfit — headings, the wordmark, numerals. Self-hosted via `next/font`. |
| **Body** | The system stack. Zero bytes, paints on the first frame. |

Body copy stays on the system stack on purpose: on a throttled 3G connection a webfont for body
text delays the only thing a student came for. The display face is loaded with `display: swap`,
subset to latin, and cached by the service worker after first visit.

| Step | Size / leading / tracking | Use |
|---|---|---|
| `text-display` | 2.25rem / 1.1 / −0.03em | Landing headline |
| `text-title` | 1.75rem / 1.2 / −0.022em | Page `h1` |
| `text-heading` | 1.25rem / 1.3 / −0.015em | Section `h2` |
| `text-subheading` | 1.0625rem / 1.4 / −0.008em | Card titles |
| `text-eyebrow` | 0.75rem / 1rem / **+0.06em** | Uppercase labels |

Tracking tightens as size grows and opens up at eyebrow size. Default browser tracking is drawn
for body copy and reads loose at heading sizes — closing it is most of what separates set type
from default type.

Numbers that sit in a column — scores, marks, counts — take `.tabular`, which sets the display
face with `tabular-nums` so digits do not jitter between rows.

---

## 5. Elevation, radius, motion

**Elevation.** `shadow-card` for resting cards, `shadow-lift` for hover and popovers,
`shadow-brand` for the primary button. The brand shadow is indigo-tinted so the main button sits
inside the palette rather than under a grey cloud.

**Radius.** `rounded-lg` (8px) for controls, `rounded-xl` (12px) for cards, `rounded-2xl` (16px)
for feature panels, `rounded-full` for chips and pills. Never mix two radii on nested corners
without a 4px step between them.

**Motion.** Transitions are 150ms on colour and shadow only. Nothing moves on the page. Every
animation sits behind the `prefers-reduced-motion` block in `globals.css`, and the only
animation in the system is the reduced-motion-safe `animate-pulseSoft` on a "generating" chip.

---

## 6. Components

**Buttons** — `primary` (brand fill, white text, `shadow-brand`), `secondary` (surface fill,
`line` border), `ghost` (no fill), `danger` (danger text, danger border). All keep the 44px
minimum height from `globals.css`; a classroom phone is used one-handed.

**Status ladder.** Grey → blue tint → solid blue → mint, so urgency reads without reading:

| State | Treatment |
|---|---|
| Draft | `line` border, `muted` text |
| Generating | `accentSoft` fill, `accentText`, `animate-pulseSoft` |
| Ready to review | Solid `accentText` fill, white text — the call to action |
| Published / finalised | `success` fill, `ink` text |

**Callouts** — `info` (azure), `success` (mint), `warn`, `danger`. Every callout carries a left
rule in its full-strength colour and a soft fill. This replaces ad-hoc coloured paragraphs.

---

## 7. Interface writing

Unchanged from `CLAUDE.md`, restated because it is part of the brand: active voice, sentence
case, plain verbs. A button that says "Publish" produces a message that says "Published." Errors
state what happened and how to fix it. Empty states invite the next action. Never name things
after the system.

On student screens, never the word "cache" — lessons are "saved on your phone."

---

## 8. Checking

`npm run check:brand` runs two scripts and both must pass:

- `scripts/check-contrast.ts` — asserts every foreground/background pair in this document meets
  AA (4.5:1 text, 3:1 large text and UI boundaries), and that no fill-only colour is used as text.
- `scripts/check-tokens.ts` — extracts every colour utility from `src` and asserts each token
  resolves in `tailwind.config.ts`. Tailwind class names are not typechecked, so a token typo
  emits no CSS and renders transparent **without failing the build**. This is the only thing that
  catches it.
