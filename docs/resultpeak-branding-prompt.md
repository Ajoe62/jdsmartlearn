# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to adopt the shared ilumo brand
system that JDSmartLearn has already implemented, so the two products read as
one family.

**Ordering: none. JDSmartLearn has already shipped its side, and nothing about
it depends on ResultPeak.** This is presentation only — no Firestore
collection, security rule, index, custom claim, or shared document is touched on
either side. ResultPeak can take this whenever it suits, in one pass or screen
by screen, without coordinating a release.

The one thing that matters is that both repos read the **same** spec file rather
than copying values out of each other. Bring `docs/ilumo-brand.md` across from
the JDSmartLearn repo and treat it as the source of truth.

---

## Context

You are working in **ResultPeak**, a school exam and results platform, live on
Firebase project `resultpilot-ddf7c` (Spark plan), with a paying school running
real exams on it.

A sibling product, **JDSmartLearn** (an LMS), runs inside the *same* Firebase
project. Both are products of **Ilumotech**. Until now they looked like
unrelated pieces of software: JDSmartLearn ran a pine-green and brass palette,
and ResultPeak has its own. A teacher who uses both in the same morning has no
reason to believe they came from the same company.

JDSmartLearn has now adopted a shared brand system built from the ilumo logo, and
this task brings ResultPeak onto the same system.

The brand architecture is **endorsed**, not master-brand: **ResultPeak keeps its
own name and leads with it.** The ilumo *mark* is shared unchanged; the wordmark
stays per product; a small "an Ilumotech product" line is the only ilumo
presence. Do not rename the product, and do not put "ilumo" ahead of "ResultPeak"
anywhere.

## Hard constraints

- **A paying school is running live exams in this project.** This task changes
  colours, type, spacing and components. It must not change exam behaviour,
  scoring, result computation, or any query.
- **No schema, rules, or index changes.** If you find yourself editing
  `firestore.rules`, `firestore.indexes.json`, a security rule, or a Firestore
  query, you have left the scope of this task. Stop and say so.
- **No new runtime dependency.** No CSS framework swap, no icon package, no
  `clsx`, no `tailwind-merge`. If a helper is needed, write the four lines.
- **Do not change any user-facing wording** except where this document says to.
  Rebranding is not a licence to reword the product.
- Keep whatever accessibility behaviour already exists. Do not regress focus
  states, labels, or keyboard handling in the course of restyling.

## The invariants

1. **ResultPeak's name and identity survive.** Endorsed architecture. The
   product name is what a user reads first, on every screen.
2. **The mark is shared and unmodified.** Same geometry, same colours, same
   proportions as JDSmartLearn uses. Copy the SVG files; do not redraw them.
3. **`docs/ilumo-brand.md` is the source of truth for both repos.** When a value
   here and a value in that file disagree, that file wins. If ResultPeak needs a
   token the spec does not have, add it to the spec — do not define a local one.
4. **The wordmark is never SVG `<text>`.** It is live HTML text in the display
   face. An SVG font-family stack substitutes a different font on every device,
   which is exactly what made JDSmartLearn's old logo look improvised.
5. **Fill-only colours never carry text.** `accent` (#3E9BFF) is 2.86:1 on white
   and `success` (#5FE9B2) is 1.52:1. Both are fills. Text uses `accentText` /
   `successText`. This is the rule people break first.

## Task 1 — Bring the spec and the assets across

Copy from the JDSmartLearn repo, unchanged:

- `docs/ilumo-brand.md` — the spec. Read it fully before writing any code.
- `public/logo-mark.svg`, `public/logo-icon.svg`, `public/logo-mono.svg`
- `src/app/icon.svg` (or wherever ResultPeak's favicon lives)

Do not re-derive the mark's geometry. If ResultPeak's framework differs, port the
markup, not the numbers.

## Task 2 — The token layer

Define the palette from section 3 of the spec, with the same **semantic** names —
`brand`, `brandHover`, `brandSoft`, `brandRing`, `accent`, `accentText`,
`accentSoft`, `success`, `successText`, `successSoft`, `ink`, `muted`, `line`,
`lineStrong`, `lineInput`, `surface`, `canvas`, `warn`, `warnSoft`, `danger`,
`dangerSoft`.

Semantic names, not colour names, in both repos. `bg-brand` survives a palette
change; `bg-indigo` becomes a lie the first time the brand moves.

Two values that will look wrong and are not:

- **`lineInput` (#7E8796) is much darker than a typical input border.** WCAG
  1.4.11 requires 3:1 on the boundary that identifies a control, and a hairline
  grey is about 1.5:1. It also has to survive direct sunlight on a cheap screen.
- **`warn` and `danger` sit outside the logo palette on purpose.** A warning
  that borrowed a brand colour would stop reading as a warning.

Then find and remove every off-palette colour — in JDSmartLearn this meant
Tailwind's built-in `amber-700`, `green-800`, `red-700` scattered through a few
components. Map them onto `warn`, `successText`, `danger`.

## Task 3 — Type

Display face **Outfit**, self-hosted, headings and numerals only. Body text stays
on the system stack.

In Next.js this is `next/font/google`, with no `weight` array — Outfit is
variable, so omitting it ships one file declared `font-weight: 100 900` instead
of a static instance per weight. Measured cost in JDSmartLearn: **32 KB**, one
file, and next/font also generates a metric-matched fallback from local Arial so
the swap causes no layout shift.

Body copy stays on the system stack because a webfont for body text delays the
only thing the user came for. Do not "finish the job" by moving body onto Outfit.

Use the type scale in section 4 of the spec, including the negative tracking at
display sizes. Numbers that sit in a column — scores, marks, positions, and
ResultPeak has many — take the `.tabular` class so digits do not jitter between
rows. This will be a visible improvement on every result sheet.

## Task 4 — Primitives

Build the small set in section 6 of the spec: `Button`, `Card`, `Badge`,
`Callout`, `Field`, `EmptyState`, `PageHeader`, `Wordmark`, `AppHeader`.

If ResultPeak already has equivalents, **re-skin those rather than adding a
second set.** Two button components is worse than an unbranded one.

Keep them free of hooks and of `"use client"` if ResultPeak is on the App Router,
so the same component works in a server tree and a client tree.

The status ladder in section 6 — grey, blue tint, solid blue, mint — should map
onto whatever states ResultPeak already shows. Mint means done. Solid blue means
this is the thing waiting on you. Only one thing per screen wears solid blue.

## Task 5 — Apply it

Redesign the screens that carry the product; let the rest inherit the primitives.
For ResultPeak that is likely the sign-in, the admin dashboard, the results
sheet, and the report card. Use judgement: pick the four or five a school
actually looks at.

**The report card and any printed output need care.** Check them on paper, not
just on screen. `logo-mono.svg` exists for exactly this. Mint on a monochrome
laser printer is a pale grey smudge, so a printed status must not depend on
colour alone.

## Task 6 — Verification

Copy `scripts/check-contrast.ts` and `scripts/check-tokens.ts` from the
JDSmartLearn repo and wire them up as `npm run check:brand`.

The second one matters more than it looks. **Tailwind class names are not
typechecked**, so a stale `bg-oldtoken` after a rename emits no CSS at all — the
element renders transparent and the build passes clean. Nothing else in the
toolchain catches it. It also enforces the fill-only rule from invariant 5.

Adjust the pair list in `check-contrast.ts` to the pairs ResultPeak actually
uses. Do not delete a pair to make it pass.

## Definition of done

- [ ] `docs/ilumo-brand.md` is in the repo, and no colour value is defined
      anywhere that contradicts it
- [ ] The shared mark renders on every screen; the wordmark is live text
- [ ] "ResultPeak" leads; "an Ilumotech product" appears once, quietly
- [ ] No off-palette colour left in the codebase
- [ ] `npm run check:brand` passes
- [ ] No change to `firestore.rules`, `firestore.indexes.json`, any query, or any
      exam or scoring behaviour
- [ ] No new runtime dependency
- [ ] The report card is checked on paper, in monochrome
- [ ] Works at 360px

## What JDSmartLearn does after this ships

Nothing. The two sides are independent by construction.

The only ongoing obligation is shared: **`docs/ilumo-brand.md` must stay
identical in both repos.** If either side changes a token, it changes the spec
first and copies the file across. A palette that drifts between two products is
worse than two products that never matched, because the difference reads as a
bug rather than a choice.
