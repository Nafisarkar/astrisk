# asterisk — Feature Checklist

API client for VS Code / VSCodium. Local-first, workspace-file storage, no accounts.
Target: parity with Thunder Client's core, lighter than Postman.

**Legend:** `[ ]` planned · `[~]` in progress · `[x]` done + tested

---

## M1 · Skeleton — DONE
Round-trip a request and see the response. Nothing else works until this does.

- [x] Webview panel opens via command `asterisk.open`
- [x] Method selector: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- [x] URL input, Enter to send
- [x] Headers editor — add / edit / remove rows
- [x] Body textarea (raw)
- [x] Send stays clickable while in flight (`aria-busy` + `aria-disabled`), so a second send supersedes the first
- [x] Response: status badge (green 2xx / yellow 3xx / red 4xx-5xx)
- [x] Response: status text, timing (ms), size (B/KB/MB)
- [x] Response: headers tab
- [x] Response: body pane, JSON auto-pretty-printed
- [x] Error display: invalid URL, timeout, network failure
- [x] Request state preserved when panel is hidden and shown again
- [x] `{{var}}` substitution in URL, headers, body
- [x] Test: 200 OK, body + headers asserted
- [x] Test: 4xx and 5xx surfaced, not thrown
- [x] Test: timeout fires correctly
- [x] Test: invalid URL rejected before fetch
- [x] Test: network failure (bad host) returns error, no crash
- [x] Test: GET/HEAD/DELETE send no body
- [ ] Manual: F5 in VSCodium, send real request

**Verified:** `bun test` (unit/DOM) and `bun x vscode-test` (in-host), plus a live round-trip against `Bun.serve`.

---

## M2 · Body types — DONE
- [x] JSON (with pretty-print toggle)
- [x] Form URL-encoded (key/value grid)
- [x] Multipart form-data (with file picker)
- [x] Raw text / XML / HTML
- [x] Binary / file upload
- [x] Content-Type set automatically per body type
- [x] Test: each body type serializes correctly to the wire

**Verified:** `bun test` (unit/DOM) and `bun x vscode-test` (in-host).

Known ceilings: multipart text fields get CRLF line endings (HTML form-data algorithm); files are read whole into memory before sending; a hand-set `Content-Type` is ignored for multipart because fetch owns the boundary.

## M3 · Collections — DONE
- [x] Sidebar tree view in Explorer
- [x] Save current request to collection
- [x] Create / rename / delete collections
- [x] Folders, nested drag-and-drop
- [x] Open saved request into panel
- [x] Persist to `.asterisk/` in workspace as JSON
- [x] Test: create → save → reload → identical payload
- [x] Test: rename/delete updates files on disk

**Verified:** `bun test` — the counts live in the suite, not here, because a number in prose rots: run it.

Layout is the tree: `<workspace>/.asterisk/<collection>/<folder>/<request>.json`, one request per file, pretty-printed for clean Git diffs. Name collisions get a counter; renames move files; delete removes directories recursively.

Known ceilings: collections use the first workspace folder only; Save overwrites in place when the request was opened from a collection, otherwise it prompts for collection + name.

## M4 · Environments — DONE
- [x] Multiple named environments
- [x] `{{var}}` substitution everywhere (URL, headers, body, auth)
- [x] Environment switcher in panel
- [x] Path variables `:id` in URL
- [x] System variables — `{{$uuid}}`, `{{$timestamp}}`, `{{$randomInt}}`
- [x] Test: var resolution incl. missing var left literal

Stored in `.asterisk/.environments.json` (hidden from the collections tree, diffs cleanly). Switcher in the panel header; rename/delete via commands; hand edits are picked up by a file watcher. Vars resolve in URLs, headers, bodies, form fields, multipart field names, and auth fields; system vars are recomputed per send.

Known ceilings: flat maps only (no var-references-var); path vars come from the active environment; `{{var}}` inside a *header name* is not substituted.

## M5 · Auth — DONE
- [x] Bearer token
- [x] Basic (user/password)
- [x] API key (header or query)
- [x] OAuth 2.0 — client credentials
- [x] OAuth 2.0 — authorization code
- [x] Auto token refresh
- [x] Test: header injected correctly per auth type

Auth is per request (Auth tab, persisted into the saved request). OAuth2 authorization code uses a loopback listener on `http://localhost:8765/callback` (default, overridable) and `vscode.env.openExternal`; tokens and refresh tokens are cached in memory and refreshed automatically.

Known ceilings: token cache is in-memory (a reload means one extra token fetch); client secrets saved into a collection are plain text — use `{{var}}` placeholders that point at an environment instead.

## M6 · History — DONE
- [x] Auto-log every sent request
- [x] Replay from history
- [x] Search / filter
- [x] Clear history
- [x] Test: history entry written on send

History view in the activity bar (newest first, 200-entry cap), replay by clicking an entry, "Search History…" filters method/url/status/body, clear with confirmation. Stored in extension workspace storage (`.asterisk` is never touched, so history is not committed). Secrets are redacted before writing: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and anything matching token/secret/password/apikey are replaced with `••••`, and secret query params (`token`, `access_token`, `api_key`, `password`, `sig`, …) are redacted in URLs. Replay drops redacted headers instead of sending `••••`.

Bodies are redacted too: JSON bodies lose the values of secret-looking keys (recursively), plain-text bodies lose `key: value` secrets, everything else is clamped to 8 KB. Replay drops redacted headers *and* redacted query params, and does not restore auth (re-apply it in the Auth tab).

Known ceilings: a secret hidden in an opaque non-key-value body (e.g. base64 in a binary-ish payload) is not detected; replay sends the stored body as typed, not re-resolved `{{vars}}`, and does not carry the request's scripts (replay is the wire request, not the saved definition).

## M7 · Import / Export — DONE
- [x] Import cURL
- [x] Import Postman v2.1 collection
- [x] Import OpenAPI 3.x (generate requests)
- [x] Export to cURL
- [x] Test: round-trip cURL → request → cURL

`Import cURL from Clipboard` loads a pasted command into the panel (no file juggling). Postman collections and OpenAPI documents are imported from a file picker into a new collection (folders from Postman item nesting / OpenAPI tags; `{param}` becomes `:param`). `Copy as cURL` puts the current request on the clipboard.

Known ceilings: Postman variables, pre-request scripts and tests are not imported; OpenAPI generates one request per operation with example bodies only when the spec has an example (no synthesized bodies, no schema fuzzing); multipart/binary bodies in cURL use `@path` references, so the path must exist locally.

## M8 · Code snippets — DONE
- [x] cURL, JS fetch, Python requests, Go
- [x] Copy to clipboard
- [x] Test: generated snippets are syntactically valid

Code tab in the panel: pick a language, get the snippet for the current editor, copy it. cURL reuses the exporter (so `import cURL` round-trips through it); JS output is parse-checked with `new AsyncFunction`; Python and Go are structural-checked. Escaping is covered for quotes, backslashes, CRLF, tabs, unicode and emoji.

Known ceilings: multipart/binary cannot be inlined — fetch emits a TODO comment, Python opens the file, Go leaves a `mime/multipart` TODO; Python `json=` inlines the JSON literal verbatim (so `true/false/null` stay as JSON, not `True/False/None`).

## M9 · Response extras — DONE
- [x] JSON tree viewer (collapsible)
- [x] Search within response
- [x] Copy body / headers
- [x] Save response to file
- [x] Response size + timing breakdown

Tree tab (native `<details>`, node-capped at 2 000 so a giant payload cannot freeze the panel), literal case-insensitive search with match count and `<mark>` highlighting, copy body (as displayed) / copy headers, Save… via the native save dialog, and a status line with total / ttfb / download / size / content-type.

Known ceilings: tree and search work on the JSON/text body only (no tree filtering); search skips highlighting above 1 MB (the count still tells you whether it matched) and its case folding is simple lowercase (an `İ` can misplace a highlight); the body is parsed once per response, so a multi-MB JSON costs one parse before the node cap applies.

## M10 · Scripting + tests — DONE
- [x] Pre-request JS
- [x] Post-response JS
- [x] Assertions — `expect(res.status).to.equal(200)`
- [x] Pass/fail badges per request
- [x] Scope: request / folder / collection
- [x] Test: assertions fail loudly on wrong status

Scripts tab holds a pre-request and a test script, saved with the request. Folder and collection scope come from a `.scripts.json` next to them (`{ "preRequest": …, "test": … }`), inheriting outermost-first. The sandbox is `node:vm` with a whitelisted context (no `require`, `process`, `fetch`, timers), a 2 s default timeout, and a chai-flavoured `expect` (`equal/eql/above/below/at.least/at.most/include/match/be.true|false|null|undefined/a/length` + `.not`). `vars` mutations are written back to the active environment; a failing assertion is reported, not thrown; a broken pre-request script blocks the send.

Sandbox notes: everything a script can touch is created *inside* the vm realm (the payload crosses as JSON text, helpers are compiled in that realm), so the classic `expect.constructor('return process')()` escape only reaches the sandbox's own `Function`. `vm` is still a speed bump, not a jail — treat scripts in collections you did not write as code you are running. Env writes are explicit: a script must call `setEnv(key, value)` (nothing is persisted just because `vars` changed), and with auth configured the send is refused if a pre-request script changes the request origin. Ceilings: `response.body` is text only, and scripts cannot read files or make requests.

## M11 · Collection runner — DONE
- [x] Run whole collection sequentially
- [x] Result table — pass/fail/time per request
- [x] CSV data file for parameterized runs
- [x] Stop on first failure (toggle)

Right-click a collection or folder → Run Collection. Four modes: all, stop-on-first-failure, and either of those with a CSV whose columns become `{{vars}}` for the whole run (one pass per row). Progress streams to a notification; results open in a side panel with status, pass/fail, time, assertion counts and the failure message. Broken request files are skipped rather than aborting the run.

Known ceilings: no parallelism (sequential by design), CSV is RFC4180-lite (no type coercion, no encodings other than UTF-8), and a run does not write script-set vars back to the environment (a bulk run should not mutate it 50 times).

## M12 · Protocols — DONE
- [x] WebSocket
- [x] Server-Sent Events

Socket tab: pick WebSocket or SSE, connect, watch the log. WebSocket gets a send box; SSE streams events as they arrive (`event: data` lines, multi-line payloads joined). URLs go through `{{vars}}` and `:path` substitution; message text goes through `{{vars}}` only. One live socket per panel, closed when the panel closes or you reconnect.

Known ceilings: WebSocket headers are not supported (the WebSocket spec has no API for them — use a token in the query string); no automatic reconnection for either protocol; SSE `id`/`retry` are parsed but not used for resume (no `Last-Event-ID` reconnection).

---

## Non-goals (v1)
- Cloud sync
- AI / MCP integration

## Hardening (bug-hunt rounds)

Adversarial review rounds (findings folded in below) plus a seeded property/fuzz suite (`test/fuzz.test.ts`):

- Scripting sandbox: the classic `expect.constructor('return process')()` escape is closed (helpers compiled *inside* the vm realm, payload crosses as JSON text), `$&`/`` $` `` payload corruption fixed, env writes are explicit (`setEnv`), reserved keys rejected.
- Auth cannot be redirected: a pre-request script that changes the request origin is refused when auth is configured.
- History: non-JSON body redaction is linear (was quadratic on a 1 MB token), userinfo passwords and fragment tokens are redacted, `__proto__` body keys survive.
- Paths: `sanitizeName` re-trims after the 80-char cut (Windows trailing dot/space) and never splits a surrogate pair; case-only renames work; drops onto a request land in its folder; dropping onto the current folder no longer clones.
- curl: line continuations inside quotes are preserved, multipart fields export as `--form-string` (a `@value` field no longer re-imports as a file), `;type=`/`;filename=` directives are stripped, `-H $'…'` and `-H 'X;'` parse.
- Protocols: BOM and bare-CR SSE, sticky `id`, callbacks after `close()`, binary WS frames labelled, SSE buffer capped.
- Runner: pre-request `vars` reach the request and the rest of the pass, blank CSV rows kept, `onRow` best-effort, iterations no longer silently capped, history refreshes after a run.

## UI polish (round 3)
- [x] One spacing scale (6/8/12 plus component paddings), one control height (`--ctrl-h: 26px` floor — controls render 29 px), two radii (`--radius: 3px`, `--radius-sm: 2px`); dense Operate-surface layout, no web-SaaS styling
- [x] Full tablist contract on both tab strips: `aria-selected`, roving `tabindex`, Arrow/Home/End, `aria-controls`
- [x] Splitter is a real sash: visible grip, 14px hit strip, pointer drag + arrow keys, `aria-valuemin/max/now/valuetext`, persisted in the panel state
- [x] States walked: first run (centered card with `<kbd>` hints), in flight (progress bar + `aria-busy`, non-destructive Cancel), error (previous response kept behind an explicit banner + a recovery hint), socket (log direction glyphs, disconnect line, `Reconnect` after a failure)
- [x] `asterisk.timeoutMs` setting (default 30 s) so the timeout hint points at a real knob
- [x] Light / dark / high-contrast: `--vscode-*` tokens with fallbacks only, opaque badge borders in high contrast, themed scrollbar hover/active and caret
- [x] Response search: 120 ms debounce, 1 MB cap, escaped once, match count in a live region
- [x] Evidence: 20 headless-Chrome renders of `out/webview/main.html` (the file the webview serves), generated by `F:/tmp/render.mjs` + `variant.mjs`: dark and light at 1000 px for first run, response, error, socket, scripts and in-flight; dark for the open menu; 500 px both themes for response and error; 1320 px both themes; one high-contrast pass. The harness injects the `--vscode-*` block and stubs `acquireVsCodeApi`, so the images are evidence of layout and copy, not of the packaged artifact

## Cross-cutting
- [ ] Publishable to Open VSX (`ovsx`) — `vsce package` produces a clean 26-file vsix (re-measure after each change; it grows); publishing needs the publisher account and token, so it is unverified
- [x] Zero runtime dependencies — `dependencies` is absent; every module is node builtins + `vscode` (devDeps: TypeScript/eslint/test tooling/happy-dom)
- [x] Works offline — collections, environments, history, scripts and runner are local files; only the requests you send leave the machine
- [x] Collections diff cleanly in Git — one pretty-printed JSON file per request, one directory per collection/folder, env vars in `.asterisk/.environments.json`
