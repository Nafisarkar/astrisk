import { describe, expect, test } from 'bun:test';
import { loopbackAuthorizer } from '../src/oauth';

/** Reserve a port, then hand the number over to the authorizer. */
async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
	const { port } = probe;
	probe.stop(true);
	return port;
}

/** Runs the full flow: the "browser" hits the loopback listener with each path in order. */
async function runFlow(hits: string[], hits2: string[] = []) {
	const port = await freePort();
	const auth = loopbackAuthorizer({
		port,
		timeoutMs: 2000,
		open: async () => {
			for (const hit of [...hits, ...hits2]) {
				await fetch(`http://127.0.0.1:${port}${hit}`);
			}
		},
	});
	try {
		const result = await auth.authorize('https://idp.test/authorize?client_id=x&state=s1');
		return { result, port };
	} finally {
		auth.dispose();
	}
}

describe('loopbackAuthorizer', () => {
	test('returns the redirect URL once a code arrives', async () => {
		const { result } = await runFlow(['/callback?code=THE_CODE&state=s1']);
		expect(result).toContain('code=THE_CODE');
	});

	test('ignores hits without a code and keeps waiting for a real one', async () => {
		const { result } = await runFlow(['/favicon.ico', '/callback?state=s1'], ['/callback?code=LATE&state=s1']);
		expect(result).toContain('code=LATE');
	});

	test('accepts an error redirect (auth.ts decides what it means)', async () => {
		const { result } = await runFlow(['/callback?error=access_denied&state=s1']);
		expect(result).toContain('error=access_denied');
	});

	test('answers the browser with a human page', async () => {
		const port = await freePort();
		const auth = loopbackAuthorizer({ port, timeoutMs: 2000, open: async () => {} });
		try {
			const pending = auth.authorize('https://idp.test/a');
			await Bun.sleep(20);
			const res = await fetch(`http://127.0.0.1:${port}/callback?code=c`);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toContain('text/html');
			expect(await res.text()).toContain('Authorization complete');
			await pending;
		} finally {
			auth.dispose();
		}
	});

	test('resolves null on timeout', async () => {
		const port = await freePort();
		const auth = loopbackAuthorizer({ port, timeoutMs: 60, open: async () => {} });
		try {
			expect(await auth.authorize('https://idp.test/a')).toBeNull();
		} finally {
			auth.dispose();
		}
	});

	test('resolves null when the browser cannot be opened', async () => {
		const port = await freePort();
		const auth = loopbackAuthorizer({
			port,
			timeoutMs: 5000,
			open: async () => {
				throw new Error('no browser');
			},
		});
		try {
			expect(await auth.authorize('https://idp.test/a')).toBeNull();
		} finally {
			auth.dispose();
		}
	});

	test('resolves null when the port is already taken', async () => {
		const blocker = Bun.serve({ port: 0, fetch: () => new Response('') });
		const auth = loopbackAuthorizer({ port: blocker.port, timeoutMs: 2000, open: async () => {} });
		try {
			expect(await auth.authorize('https://idp.test/a')).toBeNull();
		} finally {
			auth.dispose();
			blocker.stop(true);
		}
	});

	test('is safe to dispose without authorizing, and idempotent', () => {
		const auth = loopbackAuthorizer({ port: 0, open: async () => {} });
		expect(() => {
			auth.dispose();
			auth.dispose();
		}).not.toThrow();
	});

	test('a second authorize after a success is not cancelled by the first timer', async () => {
		const port = await freePort();
		let call = 0;
		const auth = loopbackAuthorizer({
			port,
			timeoutMs: 200,
			open: async () => {
				call += 1;
				if (call === 1) {
					await fetch(`http://127.0.0.1:${port}/callback?code=one`);
					return;
				}
				// lands after the first call's timer would have fired, before this call's own
				await Bun.sleep(100);
				await fetch(`http://127.0.0.1:${port}/callback?code=two`);
			},
		});
		try {
			expect(await auth.authorize('https://idp.test/a')).toContain('code=one');
			await Bun.sleep(150);
			expect(await auth.authorize('https://idp.test/a')).toContain('code=two');
		} finally {
			auth.dispose();
		}
	});

	test('dispose while waiting resolves the pending authorize with null', async () => {
		const port = await freePort();
		const auth = loopbackAuthorizer({ port, timeoutMs: 5000, open: async () => {} });
		const pending = auth.authorize('https://idp.test/a');
		await Bun.sleep(30);
		auth.dispose();
		expect(await pending).toBeNull();
	});

	test('two concurrent authorizes both settle', async () => {
		const port = await freePort();
		const auth = loopbackAuthorizer({ port, timeoutMs: 5000, open: async () => {} });
		try {
			const first = auth.authorize('https://idp.test/a');
			await Bun.sleep(20);
			const second = auth.authorize('https://idp.test/b');
			// the replaced call settles immediately instead of hanging
			expect(await first).toBeNull();
			await fetch(`http://127.0.0.1:${port}/callback?code=late`);
			expect(await second).toContain('code=late');
		} finally {
			auth.dispose();
		}
	});
});
