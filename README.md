<picture>
	<source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.png">
	<source media="(prefers-color-scheme: light)" srcset="docs/banner-light.png">
	<img src="docs/banner-light.png" alt="asterisk — a local-first HTTP client for VS Code" width="100%">
</picture>

<p align="center">
	<a href="CHANGELOG.md"><img src="https://img.shields.io/badge/0.1_beta-0078d4" alt="0.1 beta"></a>
	<a href="test"><img src="https://img.shields.io/badge/tests-1047_passing-2ea043" alt="1016 tests passing"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/runtime_deps-0-2ea043" alt="zero runtime dependencies"></a>
	<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6e7681" alt="MIT licence"></a>
</p>

<p align="center"><strong>API testing inside VS Code. No account, no cloud, no telemetry.</strong></p>

<p align="center"><a href="https://nafisarkar.github.io/astrisk/">nafisarkar.github.io/astrisk</a> — what it looks like, and how to install it.</p>

```bash
code --install-extension nafisarkar.asterisk
```

Or build it yourself: `bun install && bun x vsce package`, then
`code --install-extension asterisk-0.1.0.vsix`.

## Features

- Any method, any body — JSON, text, form, multipart, binary
- Bearer, Basic, API key, OAuth 2.0 with refresh
- `{{variables}}`, environments, `:path` params
- JSON tree, find, timings, save the response
- Collections and history as files — drag, rename, replay
- Scripts with assertions; CSV runner with stop-on-failure
- WebSocket, SSE, and cURL / Postman / OpenAPI import-export

## Use

<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> opens the client. Paste a URL, <kbd>Enter</kbd> sends, <kbd>Ctrl</kbd>+<kbd>S</kbd> saves it into a collection. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends from anywhere, <kbd>Esc</kbd> cancels.

## Storage

```
repo/.asterisk/
├── .environments.json      # named environments, active one
└── My Collection/          # a collection is a folder
    └── users/list.json     # a request is a file
```

## Scripts

```js
// test script — response is { status, statusText, headers, body, timeMs, size }
expect(response.status).to.equal(200);
expect(JSON.parse(response.body).items).to.have.length(2);
```

Sandboxed: you get `request`, `vars` and `setEnv`, not `process`, `require` or the network.

<details>
<summary>Develop</summary>

```bash
bun install && bun test    # unit + DOM suite
bun run test               # in a real VS Code host
bun x vsce package         # build the .vsix
```

`bun test` fails if the shipped webview has drifted from the source one. Gaps and milestones live in [FEATURES.md](FEATURES.md).
</details>

<p align="center"><sub>MIT licence · 0.1 beta</sub></p>
