# Design

<!-- impeccable:design-schema 1 -->

The built world of `docs/index.html`, recorded after the fact. Product truth lives in `PRODUCT.md`; the surface strategy lives in `.impeccable/surfaces/landing.md`.

## World

A dark instrument panel with one lit region. The ground is `#080a0e`; the hero is a soft blue luminous field (four large radial stops, blurred once, then the fibre canvas over them at 32% in `screen` blend). Nothing else glows. Below the hero the page turns into a hairline spec sheet: rules at `rgba(255,255,255,.09)`, square corners, and only the two physical objects — the storage card and the panel screenshot — carrying a 14px radius.

## Colour

Three inks, no grey ramp:

| role | value | where |
|---|---|---|
| ground | `#080a0e` | page, all surfaces |
| ink | `#e8edf5` | display, commands, tree; at .78/.70/.62 for secondary text |
| field blue | `#4daafc` | the hero field, mono labels, step numbers, focus ring, copy confirmation |

Blue is a *region* (the hero) and a *label voice* (11px tracked caps) — never a button fill except the Send button inside the screenshot, which belongs to the product.

## Type

- **Display:** Bodoni Moda 400, self-hosted, subset to ASCII and inlined as woff2 base64 (`@font-face` at the top of the stylesheet, ~41KB base64). It is the only downloaded face and it is not downloaded — no request leaves the page.
- **Body / UI:** system sans stack, first name `Inter` (never fetched; resolves to the platform UI face, which is what the extension itself renders in).
- **Data:** system mono stack for every label, command, path, tree and the eyebrow. Uppercase mono labels are 11px at 0.14em tracking; the hero's eyebrow is 11px at 0.34em.
- Display tracking is `-0.015em` (serifs need far less negative tracking than the sans it replaced). Body measure 46–54ch, hero lede 54ch.

## Type scale

`h1 clamp(2.6rem, 5.5vw, 5rem)` · section h2s are `.sr-only`; visible section heads are the mono `.tag` · lede `clamp(16px,1.22vw,18.5px)` · lattice values 13px mono · commands 13px mono.

## Structure

`hero` (100svh, centred) → `repo` (storage tree + gated install sequence, two columns) → `capabilities` (six cells, 3/2/1) → `beta` rule → `proof` (panel render + closing install row) → `footer`.

## Motion

One authored moment: the hero copy, then the pill, settling in on load (`rise`, 520ms, staggered 70/140ms). The fibre field drifts continuously at 56 threads. Everything stops under `prefers-reduced-motion: reduce` — the engine renders exactly one frame and never starts its loop; the page's own animations are `none`.

## Known ceilings

- `panel-dark.png` is 1000×712 rendered at ~982 CSS px: 51% density at DPR 2. A 2× asset is the fix and is not shipped.
- The copy-button border sits at 1.22:1 against the ground. WCAG 1.4.11 is satisfied by the 6.73:1 glyph that names the control, not by the border; thickening it would break the hairline system.
- The copy controls stay visible with JS off (`<noscript>` only neutralises the cursor) so the commands remain selectable text.
- The hero eyebrow is a tracked-caps kicker, which craft-floor bans. The user's pinned reference includes one, so the ban does not apply to this axis.
