<p align="center">
  <img src="https://nafisarkar.github.io/astrisk/banner-dark.png" width="100%" alt="asterisk — a local-first HTTP client for VS Code">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Nafisarkar.asterisk"><img src="https://img.shields.io/badge/marketplace-0.2.0-0078d4" alt="Visual Studio Marketplace"></a>
  <a href="https://open-vsx.org/extension/nafisarkar/asterisk"><img src="https://img.shields.io/badge/open_vsx-0.2.0-a60ee5" alt="Open VSX"></a>
  <a href="test"><img src="https://img.shields.io/badge/tests-1047_passing-2ea043" alt="1047 tests passing"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/runtime_deps-0-2ea043" alt="zero runtime dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6e7681" alt="MIT licence"></a>
</p>

**API testing that lives in your repo.** Send a request from the editor, keep the
collection as files beside your code, and let a script assert on the response. No
account, no cloud, no telemetry — and no runtime dependencies.

<p align="center">
  <img src="https://nafisarkar.github.io/astrisk/panel-dark.png" width="100%" alt="The Asterisk panel: a POST with bearer auth, 200 OK in 184 ms, 214 B JSON, a green 'tests passed' chip, and the response as a tree">
</p>

## Install

```bash
code --install-extension Nafisarkar.asterisk
```

VSCodium and other Open VSX editors: `codium --install-extension nafisarkar.asterisk`.
From source: `bun install && bun x vsce package`, then
`code --install-extension asterisk-0.2.0.vsix`. Pre-release builds are opt-in
from the Extensions view.

## Why it is different

Everything you build is a file in `.asterisk/` — diffable, reviewable, and
yours after you close the editor. There is no workspace database to export, and
nothing leaves the machine.

- Any method, any body — JSON, text, form, multipart, binary
- Bearer, Basic, API key, OAuth 2.0 with refresh
- `{{variables}}`, environments, `:path` params
- JSON tree, find, timings, save the response
- Scripts with assertions; a runner that replays a collection over a CSV
- WebSocket and SSE
- cURL / Postman v2.1 / OpenAPI 3.x import; cURL / fetch / Python / Go export

## Use

`Ctrl+Alt+A` opens the client. Paste a URL, `Enter` sends, `Ctrl+S` saves it into
a collection. `Ctrl+Enter` sends from anywhere, `Esc` cancels.

```
repo/.asterisk/
├── .environments.json      # named environments, active one
└── My Collection/          # a collection is a folder
    └── users/list.json     # a request is a file
```

A test script gets the response and nothing else:

```js
// response is { status, statusText, headers, body, timeMs, size }
expect(response.status).to.equal(200);
expect(JSON.parse(response.body).items).to.have.length(2);
```

It runs sandboxed, with `request`, `vars` and `setEnv` — not `process`,
`require`, or the network.

## Develop

```bash
bun install && bun test    # unit and DOM suites
bun run test               # inside a real VS Code host
bun x vsce package         # build the .vsix
```

`bun test` fails if the shipped webview has drifted from the source one. Gaps
and milestones live in [FEATURES.md](FEATURES.md); the design rules are in
[DESIGN.md](DESIGN.md).

<p align="center"><sub>MIT licence · no telemetry · no account</sub></p>
