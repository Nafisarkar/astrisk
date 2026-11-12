# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Single static HTML file in `docs/`, inline CSS and vanilla JS, no build step, no framework, no CDN or webfont. Deployed by GitHub Pages from `master` / `/docs` to <https://nafisarkar.github.io/astrisk/>.

## Users

Developers who already live in an editor and are choosing an HTTP client — the moment of evaluation is a README, a marketplace listing, or this page, usually in a browser tab next to VS Code. They arrive skeptical: they have been burned by a Postman account, a synced cloud collection, or a client that owns their data. Their job on this page is to decide, in under a minute, whether to install.

## Product Purpose

Asterisk is a local-first HTTP client that runs as a VS Code extension. Requests, collections, environments and history live in the workspace as plain files. Success means a developer installs it and stops needing a separate API client application.

## Positioning

The state *is* the repository. One pretty-printed JSON file per request inside `.asterisk/`, so an API change is a code review diff, collections survive the tool that made them, and there is nothing to sync, sign into, or export. Neighbouring clients cannot truthfully copy this: their storage model is the business model.

## Operating Context

Used inside VS Code / VSCodium, alongside source files and a terminal. Collections are folders in the repo; the panel opens with a keybinding (`Ctrl+Alt+A`); requests are replayed from history. Installation is `code --install-extension Nafisarkar.asterisk --pre-release`, or `bun install && bun x vsce package` then `code --install-extension asterisk-0.1.0.vsix` from source.

## Capabilities and Constraints

Confirmed, from `README.md` and `FEATURES.md`: any method and body type (JSON, text, form, multipart, binary); Bearer, Basic, API key and OAuth 2.0 with refresh; `{{variables}}`, environments, `:path` params, system vars; JSON tree, find, timings, save response; collections and history as files; sandboxed pre-request and test scripts with assertions; sequential collection runner with CSV rows and stop-on-first-failure; WebSocket and SSE; cURL / Postman v2.1 / OpenAPI 3.x import, cURL / fetch / Python / Go export. Zero runtime dependencies. MIT. No telemetry, no account.

Published to the Visual Studio Marketplace as a pre-release under publisher `nafisarkar`; there are no customers, no pricing, no benchmarks and no testimonials, and none of these may be invented. Version is `0.1.1`; the release artefact is the vsix built by `.github/workflows/publish.yml`.

## Brand Commitments

Name is lowercase `asterisk`, mark is the 8-spoke asterisk in `media/icon.svg`. Accent blue `#4daafc` from `docs/banner-dark.svg`; the wordmark's tone is plain, technical, and unsentimental — no hype verbs. Binding constraint from the user for this surface: keep the VS Code-adjacent dark world but take a braver composition, let the blue own whole regions rather than acting as an accent, and use a ported `GhostFibers` (React Bits) WebGL fibre field as the page background.

## Evidence on Hand

- `docs/panel-dark.png` — real 1000×712 render of the request panel, dark theme.
- `docs/banner-dark.svg` / `banner-light.svg` — the identity banner, mark and wordmark.
- `README.md`, `FEATURES.md`, `CHANGELOG.md` — the authoritative feature and gap record; ceilings are documented honestly and must stay honest on the page.

## Product Principles

1. The repository is the interface. Show the files, not a feature list.
2. Prove, don't promise: a real screenshot of the panel outranks any adjective.
3. Local-first means it must work with the network off — the page obeys the same rule, no external requests.
4. State the ceilings. A page that hides what the beta cannot do reads like every other launch page.

## Accessibility & Inclusion

Body text ≥4.5:1 against its surface, keyboard focus always visible, every claim readable without the WebGL background (it is decorative, `aria-hidden`, and stops under `prefers-reduced-motion`).
