# Design

<!-- impeccable:design-schema 1 -->

The built world of `docs/index.html`, recorded after the fact. Product truth lives in `PRODUCT.md`; the surface strategy lives in `.impeccable/surfaces/landing.md`.

## World

A dark ground with one lit region. `#080a0e` everywhere; the hero is a soft blue field built from four large radial stops blurred once, an inline-SVG grain plate at 9% in `overlay`, and a vignette. Nothing else glows, nothing moves, no canvas, no shader. Below the hero the page turns into a hairline spec sheet: rules at `rgba(255,255,255,.09)`, square corners, and only the two physical objects — the storage card and the panel screenshot — carrying a 14px radius.

## Colour

Three inks, no grey ramp:

| role | value | where |
|---|---|---|
| ground | `#080a0e` | page, all surfaces |
| ink | `#e8edf5` | display, commands, tree; at .78/.70/.62 for secondary text |
| field blue | `#4daafc` | the hero field, mono labels, step numbers, focus ring, copy confirmation |

Blue is a *region* (the hero) and a *label voice* (11px tracked caps) — never a button fill except the Send button inside the screenshot, which belongs to the product.

## Type

- **Display:** Redaction 50 400, self-hosted, Latin subset, inlined as woff2 base64 (~9KB base64). This is the *dithered* cut of the Redaction family — the stair-stepped edges are the typeface, not a rasterisation failure. It replaced Instrument Serif and, before that, Bodoni Moda (rejected: hairlines pair to nothing on a dark field).
- **Mono:** JetBrains Mono 400, ASCII subset, inlined (~21KB base64). Carries the install command.
- **Body / UI:** system sans stack, first name `Inter` (never fetched; resolves to the platform UI face, which is what the extension itself renders in).
- Both faces are inlined data URIs: the page still makes zero external requests.
- Display tracking is `-0.015em` (serifs need far less negative tracking than the sans it replaced). Body measure 46–54ch, hero lede 54ch.

## Type scale

`h1 clamp(2.9rem, 6.4vw, 5.9rem)` · brand 13px mono · links 12.5px · command 11.5px · section h2s are `.sr-only`; visible section heads are the mono `.tag` · lede `clamp(16px,1.22vw,18.5px)` · lattice values 13px mono · commands 13px mono.

## Structure

One screen: a topbar holding the brand lockup on the left and the Star-on-GitHub link on the right, then `hero` at `100svh`, centred, nothing else below it — the page does not scroll. The battery of spec sections (storage tree, install sequence, capability lattice, beta rule, panel render, footer) was cut on request; the install action they carried now lives in the hero as one ink-filled pill that copies the command.

## Brand

The lockup is the mark (the eight-armed asterisk, `icon.svg`, blue `#4daafc`) plus the word `asterisk` set lowercase in JetBrains Mono at 13px, top-left. It sits in the topbar rather than a fixed rail so it survives at every width. The same glyph is the favicon, so the tab and the page agree.

## Motion

The h1, then the action, settling in on load (`rise`, 520ms, staggered 90ms). That is the whole animation budget — the field is static. Under `prefers-reduced-motion: reduce` both animations are `none` and transitions drop to 1ms.

## Weight

The page is one file of ~42KB uncompressed, ~13KB gzipped: 30KB of that is the two inlined font subsets, ~5KB is CSS, ~2KB is the copy script, the rest is markup. No framework, no CDN, no analytics, no build step, no network request after the document.

## Known ceilings

- The copy controls stay visible with JS off (`<noscript>` only neutralises the cursor) so the commands remain selectable text.
- The hero eyebrow is a tracked-caps kicker, which craft-floor bans. The user's pinned reference includes one, so the ban does not apply to this axis.
- Both actions are underlined text and nothing else: `Install the VSIX` in the hero (16px, underlines to blue on hover, swaps to `Copied` and stays blue for 1.6s) and `Star on GitHub` in the topbar (13.5px). Solid fills and capsule borders were tried and both read as chrome bolted onto a field; a rule under the words carries the same affordance at a twentieth of the weight.
