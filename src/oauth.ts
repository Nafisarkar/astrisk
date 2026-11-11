// Loopback OAuth2 redirect receiver. No vscode imports: the browser opener is injected,
// so this is testable under bun against a real HTTP listener.
import { createServer, type Server } from 'node:http';

export interface LoopbackOptions {
	/** Fixed port so the authorize URL and the token exchange agree on redirect_uri. */
	port?: number;
	/** Opens the consent page; the usual implementation is vscode.env.openExternal. */
	open: (url: string) => Promise<unknown>;
	/** Give up after this long and resolve null. */
	timeoutMs?: number;
	/** Reported when the loopback port cannot be bound (e.g. another window is authorizing). */
	onError?: (message: string) => void;
}

export interface LoopbackAuthorizer {
	authorize(url: string): Promise<string | null>;
	dispose(): void;
}

const SUCCESS_PAGE = '<!doctype html><meta charset="utf-8"><title>Asterisk</title><p>Authorization complete — you can close this tab.</p>';

/** Wait for the browser to hit the loopback port with `?code=…` and hand back that full URL. */
export function loopbackAuthorizer(opts: LoopbackOptions): LoopbackAuthorizer {
	const port = opts.port ?? 8765;
	const timeoutMs = opts.timeoutMs ?? 120_000;
	let server: Server | undefined;
	let settle: ((url: string | null) => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Consume the pending waiter: clear its timer and resolve it exactly once. */
	const finish = (value: string | null) => {
		const done = settle;
		settle = undefined;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		done?.(value);
	};

	const start = async () => {
		if (server) {return;}
		server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', `http://localhost:${port}`);
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE);
			const arrived = url.searchParams.has('code') || url.searchParams.has('error') || url.searchParams.has('error_description');
			if (settle && arrived) {finish(url.toString());}
		});
		await new Promise<void>((resolve, reject) => {
			// No host argument: bind both stacks so `http://localhost:port` works whether the browser
			// resolves localhost to 127.0.0.1 or ::1. The listener is short-lived and state-checked.
			server!.once('error', reject);
			server!.listen(port, () => resolve());
		});
	};

	return {
		async authorize(url: string): Promise<string | null> {
			try {
				await start();
			} catch (e: any) {
				// port taken / listener failed — no browser round-trip is possible
				opts.onError?.(
					e?.code === 'EADDRINUSE'
						? `OAuth: port ${port} is busy (another authorization in progress?) — close it and retry.`
						: `OAuth: cannot listen on port ${port} — ${e?.message ?? e}`
				);
				return null;
			}

			const arrived = new Promise<string | null>((resolve) => {
				// A second authorize() replaces this one: let the older caller finish with null.
				finish(null);
				settle = resolve;
				timer = setTimeout(() => finish(null), timeoutMs);
			});

			try {
				await opts.open(url);
			} catch {
				finish(null);
				return null;
			}
			return arrived;
		},
		dispose() {
			finish(null);
			server?.close();
			server = undefined;
		},
	};
}
