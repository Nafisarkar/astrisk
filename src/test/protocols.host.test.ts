import * as assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { openSse } from '../protocols';

// M12 on the real host runtime: SSE streaming over Node's fetch/ReadableStream.
suite('Asterisk M12 — SSE on the host runtime', () => {
	let server: Server;
	let base = '';

	suiteSetup(async () => {
		server = createServer((req, res) => {
			if (req.url === '/plain') {
				res.writeHead(500).end('nope');
				return;
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			const chunks = ['data: first', '\n\n', 'event: update\ndata: second\n\n', 'data: tail'];
			let i = 0;
			const timer = setInterval(() => {
				if (i >= chunks.length) {
					clearInterval(timer);
					res.end();
					return;
				}
				res.write(chunks[i++]);
			}, 5);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		base = `http://127.0.0.1:${port}`;
	});

	suiteTeardown(() => new Promise<void>((resolve) => server.close(() => resolve())));

	test('streams split events and a final partial block', async () => {
		const events: { event: string; data: string }[] = [];
		await openSse(base + '/events', { onEvent: (e) => events.push({ event: e.event, data: e.data }) }).done;
		assert.deepEqual(events, [
			{ event: 'message', data: 'first' },
			{ event: 'update', data: 'second' },
			{ event: 'message', data: 'tail' },
		]);
	});

	test('an HTTP error is reported, not thrown', async () => {
		const errors: string[] = [];
		await openSse(base + '/plain', {
			onEvent: () => {},
			onError: (e) => errors.push(e),
		}).done;
		assert.ok(errors[0].includes('500'), errors.join(','));
	});

	test('close() stops the stream', async () => {
		let closes = 0;
		const handle = openSse(base + '/events', { onEvent: () => {}, onClose: () => closes++ });
		handle.close();
		await handle.done;
		assert.equal(closes, 1);
	});
});
