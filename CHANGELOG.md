# Changelog

All notable changes to **asterisk** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html); pre-1.0 means the minor
number may break things, and until 1.0 every entry is a candidate for change.

## [0.2.0] — 2026-11-13

First stable release, so installing no longer needs `--pre-release`.

- Also on Open VSX, which is what VSCodium and other Open VSX editors install
  from.
- Publishing is credential-free end to end: both registries trade a GitHub OIDC
  token for a short-lived publishing credential, and the version's minor number
  picks the channel — odd is pre-release, even is stable.
- Comment pass over `src`: the box-drawn section banners are plain labels now,
  and three comments that restated a signature or ran three lines around one
  fact are down to what they were carrying.
- Fixed a doc block in `scopes.ts` that documented `collectScopeScripts` while
  sitting above `insideRoot`, so the wrong function wore it.

## [0.1.3] — 2026-11-13

- Removed art nothing referenced: the light banner and panel, the unused badge
  mark, and the agent scratch directory that was shipping inside the vsix.
- The stale npm lockfile is gone; `bun.lock` replaces it and CI installs with
  `--frozen-lockfile`, so a tag build resolves the same tree every time.
- `media/icon-512.png` stays: it is the master the 128 px icon is rendered from.

## [0.1.2] — 2026-11-13

- First Open VSX release, so VSCodium and other Open VSX editors can install it.
- `.vscodeignore` now keeps stray JSON scratch files out of the package: 0.1.1
  on Open VSX shipped a 588 KB `tree.json` that had been sitting in the repo
  root.

## [0.1.1] — 2026-11-12

- The extension icon has transparent corners; it was a white-backed square.
- README: the banner is a single absolute-URL image, since the marketplace
  strips `<picture>` and cannot load repo-relative paths; a real panel
  screenshot replaces the claims it used to describe.

## [0.1.0] — 2026-01-31

First beta, published to the Marketplace on the pre-release channel. Every advertised feature is implemented and tested; the deliberate gaps
are listed in [FEATURES.md](FEATURES.md).

### Added

**Requests**

- Any method, header grid with duplicate-name detection, and typed bodies: raw JSON/text/XML/HTML,
  form URL-encoded, multipart form-data, and binary upload.
- The JSON body editor highlights syntax with the host's own token colours, pairs `{}`, `[]` and
  quotes, wraps a selection, steps over a closer that is already there, deletes an empty pair on
  Backspace, keeps the indent on Enter, and formats with <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>,
  on paste of valid JSON, and on blur while the Prettify toggle is on. Formatting refuses to run
  when it would lose information (integers past 2^53, duplicate keys, `1e400`), because a blur is
  not a licence to rewrite a payload.
- Per-type body editors: raw textarea with a pretty-print toggle, key/value grids, native file
  picking. Files are read from disk at send time, so request state stays small and re-openable.
- Automatic `Content-Type` per body type (a user-supplied value always wins; multipart always lets
  `fetch` set the boundary).
- `asterisk.timeoutMs` setting (default 30000).

**Collections**

- Disk-backed tree in the activity bar (`.asterisk/<collection>/<folder>/<request>.json`) with
  create, rename, delete, nested drag-and-drop, and click-to-open.
- Save from the panel into a collection, overwriting in place when the request came from one.
- Sidebar welcome views link both **New Collection** and **Open the client**.

**Environments and auth**

- Named environments in `.asterisk/.environments.json` with a panel switcher, rename/delete
  commands, `{{var}}` substitution everywhere including auth and multipart parts, `:path`
  variables on saved requests, and `{{$uuid}}` / `{{$timestamp}}` / `{{$randomInt}}`.
- Auth: Bearer, Basic, API key (header or query), OAuth 2.0 client-credentials and
  authorization-code with loopback redirect; in-memory token cache with automatic refresh and no
  credential forwarding across a cross-host redirect.

**Responses**

- Collapsible JSON tree, in-response search with highlighting, copy body/headers, save to file, and
  a total / TTFB / download / size breakdown.

**History, import, snippets**

- History view with auto-logged sends, replay, search, clear, and secret redaction before anything
  hits disk.
- Import/export: cURL from the clipboard, Postman v2.1, OpenAPI 3.x/Swagger 2.0, and copy-as-cURL.
- Generated snippets: cURL, JavaScript `fetch`, Python `requests`, Go.

**Scripting and the runner**

- Pre-request and test scripts per request plus folder/collection scopes via `.scripts.json`, run in
  a sandboxed `vm` realm with an `expect(...)` assertion API, pass/fail badges, and explicit
  `setEnv(key, value)` writes back to the active environment.
- Collection runner: sequential runs from the tree, stop-on-first-failure, CSV-parameterized
  iterations, and a results table with each row's values.

**Protocols**

- WebSocket (connect, send, receive, close) and Server-Sent Events (streaming log) in a Socket tab.

### Fixed

- Sandbox escape via injected host helpers; `$&` and `` $` `` payload corruption in variable
  substitution; pre-request scripts able to redirect credentials.
- History: quadratic plain-text redaction, leaked userinfo passwords and fragment tokens.
- cURL: continuations inside quotes, `@`-prefixed multipart fields, `;type=` directives, `$'…'`
  quoting, `-H 'X;'`.
- Storage: 80-character names ending in `.`/space or splitting an emoji; case-only renames; drop on
  request and drop on own folder.
- Protocols: SSE BOM, bare CR, sticky `id`, close ordering, buffer cap; binary WebSocket frames;
  duplicate socket-failure logging.
- Runner: pre-request variables, blank CSV rows, the silent 100-row cap, throwing `onRow`.
- Auth: ignored `token_type`, colon-joined cache keys, `in: 'body'` API keys.
- Panel restore after a window reload threw a `ReferenceError` that killed the env list, the dirty
  marker and the `ready` handshake.
- Declining "Discard unsaved changes" still moved the save target, so the next <kbd>Ctrl</kbd>+<kbd>S</kbd>
  could overwrite a different saved request.
- A cancelled request left the previous body uncaptioned; a load mid-flight left Send busy and could
  paint a foreign body.
- Socket "Connect" was disabled while connecting with no way out of a hung connect; it now reads
  **Cancel**. A failed connection logs once and offers **Reconnect**.
- Ctrl+Enter in a socket field fired the socket *and* the HTTP request; the document shortcuts now
  honour IME composition and modifiers.
- Deleting a header, picking a file or attaching a multipart file never raised the dirty flag, so the
  host's discard guard never fired and the edit was lost on the next load.
- The response body could be pushed below the fold by an in-flow notice at the splitter's maximum,
  with no way to scroll; the ceiling now accounts for the notice.
- A duplicated header name now says what the wire does (the values are joined) and the panel joins
  them the same way instead of dropping a row.
- The Content-Type hint claimed a type for an empty body and for a GET; it qualifies both, and the
  multipart hint states that the host owns the boundary.
- The socket log yanked a reader who had scrolled up back to the bottom on every frame; a normal
  disconnect is no longer painted as a failure.
- A save from the command palette left the unsaved dot on; the tree's type column sat at the pane
  edge instead of beside its value.
- A search above the mark cap deleted the text it did not highlight, and Copy copied the damage.
- The JSON body editor coloured up to 50 KB that cost ~50 ms per keystroke; the budget is 20 KB and
  the pane says when colours are off.

### Changed

- `HttpRequest.body` is a typed `RequestBody` union instead of a bare string; `{{var}}`
  substitution applies to form fields, multipart parts and file field names.
- One send pipeline (`execute()`) shared by the panel and the runner.
- Panel rebuilt around one spacing scale (6/8/12), one control-height token (26 px floor) and two
  radii (3 px / 2 px); the splitter has a visible grip and a live `aria-valuenow`/`aria-valuemax`.
- Tabs follow the full tablist contract (roving `tabindex`, arrow/Home/End, `aria-controls`);
  `role=tree` over native `<details>` dropped; script results and the response count are live
  regions.
- In-flight requests show a progress bar and `aria-busy` instead of only swapping buttons; cancel is
  neutral, not destructive.
- A failed request keeps the previous response visible behind an explicit "Showing the previous
  response" banner instead of dimming the body text.
- Status line trimmed to four metrics (timings move into the tooltip); the first failing assertion
  is printed inline next to the results pill.

### Known limitations

See [FEATURES.md](FEATURES.md). In short: flat environment variable maps, no multi-root workspaces,
sequential runner only, WebSocket without custom headers, no SSE auto-reconnect, and the scripting
sandbox is a seatbelt against accidents rather than a jail against hostile code.

## [0.0.1]

- Initial scaffold: open a panel, send a request, see the response.
