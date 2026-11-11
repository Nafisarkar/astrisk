import { describe, expect, test } from 'bun:test';
import { createSocketSlot, openSse, openWebSocket, parseSseChunk, type SseEvent } from '../src/protocols';

describe('parseSseChunk', () => {
	test('a plain data event', () => {
		expect(parseSseChunk('data: hello\n\n')).toEqual({ events: [{ event: 'message', data: 'hello' }], rest: '' });
	});

	test('an incomplete block is returned as rest', () => {
		const parsed = parseSseChunk('data: half');
		expect(parsed.events).toEqual([]);
		expect(parsed.rest).toBe('data: half');
	});

	test('two complete events and one pending', () => {
		const parsed = parseSseChunk('data: one\n\ndata: two\n\ndata: thr');
		expect(parsed.events.map((e) => e.data)).toEqual(['one', 'two']);
		expect(parsed.rest).toBe('data: thr');
	});

	test('multi-line data is joined with newlines', () => {
		expect(parseSseChunk('data: a\ndata: b\n\n').events[0].data).toBe('a\nb');
	});

	test('named events, ids and retry are captured', () => {
		expect(parseSseChunk('event: ping\nid: 7\nretry: 1500\ndata: {}\n\n').events[0]).toEqual({
			event: 'ping',
			id: '7',
			retry: 1500,
			data: '{}',
		});
	});

	test('an event with no data is not dispatched', () => {
		expect(parseSseChunk('event: ping\n\n').events).toEqual([]);
	});

	test('comments are ignored', () => {
		expect(parseSseChunk(': keepalive\n\ndata: x\n\n').events).toEqual([{ event: 'message', data: 'x' }]);
	});

	test('CRLF line endings work', () => {
		expect(parseSseChunk('data: a\r\n\r\n').events).toEqual([{ event: 'message', data: 'a' }]);
	});

	test('a field value with no leading space is kept', () => {
		expect(parseSseChunk('data:x\n\n').events[0].data).toBe('x');
	});

	test('values keep internal colons', () => {
		expect(parseSseChunk('data: {"url":"http://x"}\n\n').events[0].data).toBe('{"url":"http://x"}');
	});

	test('a non-numeric retry is ignored', () => {
		expect(parseSseChunk('retry: soon\ndata: x\n\n').events[0].retry).toBeUndefined();
	});

	test('a bare data line with no colon yields an empty payload event', () => {
		expect(parseSseChunk('data\n\n').events).toEqual([{ event: 'message', data: '' }]);
	});

	test('unicode payloads survive', () => {
		expect(parseSseChunk('data: héllo 世界 🚀\n\n').events[0].data).toBe('héllo 世界 🚀');
	});

	test('a bare CR terminates a line', () => {
		// the final CR needs one more byte to prove it is not half of a CRLF (see the CRLF split test)
		expect(parseSseChunk('data: a\rdata: b\r\r\n').events).toEqual([{ event: 'message', data: 'a\nb' }]);
	});

	test('a leading BOM is dropped', () => {
		expect(parseSseChunk('\uFEFFdata: hello\n\n').events).toEqual([{ event: 'message', data: 'hello' }]);
	});

	test('a BOM arriving alone in the first chunk is not carried into the field name', () => {
		const first = parseSseChunk('\uFEFF');
		expect(first).toEqual({ events: [], rest: '' });
		expect(parseSseChunk(first.rest + 'data: x\n\n').events).toEqual([{ event: 'message', data: 'x' }]);
	});

	test('a trailing CR is held back so a split CRLF does not invent a blank line', () => {
		const first = parseSseChunk('data: a\r');
		expect(first.events).toEqual([]);
		const second = parseSseChunk(first.rest + '\ndata: b\r\n\r\n');
		expect(second.events).toEqual([{ event: 'message', data: 'a\nb' }]);
	});

	test('an id is sticky across events', () => {
		expect(parseSseChunk('id: 7\ndata: a\n\ndata: b\n\n').events).toEqual([
			{ event: 'message', id: '7', data: 'a' },
			{ event: 'message', id: '7', data: 'b' },
		]);
	});

	test('a later id replaces the sticky one', () => {
		expect(parseSseChunk('id: 1\ndata: a\n\nid: 2\ndata: b\n\n').events.map((e) => e.id)).toEqual(['1', '2']);
	});

	test('CR, CRLF and LF give the same events for every chunk split', () => {
		const stream = 'data: one\r\n\r\ndata: two\rdata: three\r\n\r\n';
		const whole = parseSseChunk(stream);
		expect(whole.events.map((e) => e.data)).toEqual(['one', 'two\nthree']);
		for (let cut = 0; cut <= stream.length; cut++) {
			const first = parseSseChunk(stream.slice(0, cut));
			const second = parseSseChunk(first.rest + stream.slice(cut));
			expect([...first.events, ...second.events].map((e) => e.data)).toEqual(whole.events.map((e) => e.data));
		}
	});
});

async function sseServer(chunks: string[]) {
	const server = Bun.serve({
		port: 0,
		fetch() {
			const body = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of chunks) {controller.enqueue(encoder.encode(chunk));}
					controller.close();
				},
			});
			return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
		},
	});
	return { server, url: `http://localhost:${server.port}/events` };
}

describe('openSse', () => {
	test('streams events from a real server, splitting mid-event', async () => {
		const { server, url } = await sseServer(['data: he', 'llo\n\n', 'event: bye\ndata: see ya\n\n']);
		try {
			const events: SseEvent[] = [];
			const handle = openSse(url, { onEvent: (e) => events.push(e) });
			await handle.done;
			expect(events).toEqual([
				{ event: 'message', data: 'hello' },
				{ event: 'bye', data: 'see ya' },
			]);
		} finally {
			server.stop(true);
		}
	});

	test('a 500 becomes an onError message, not a throw', async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 500 }) });
		try {
			const errors: string[] = [];
			await openSse(`http://localhost:${server.port}/x`, { onEvent: () => {}, onError: (e) => errors.push(e) }).done;
			expect(errors[0]).toContain('500');
		} finally {
			server.stop(true);
		}
	});

	test('an unreachable host becomes an onError message', async () => {
		const errors: string[] = [];
		await openSse('http://localhost:1/x', { onEvent: () => {}, onError: (e) => errors.push(e) }).done;
		expect(errors[0]).toContain('cannot connect');
	});

	test('close() aborts and reports close once', async () => {
		const { server, url } = await sseServer(['data: a\n\n']);
		let closes = 0;
		try {
			const handle = openSse(url, { onEvent: () => {}, onClose: () => closes++ });
			handle.close();
			await handle.done;
			await Bun.sleep(10);
			expect(closes).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	test('sends the accept header and a caller header', async () => {
		let seenAccept = '';
		let seenCustom = '';
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				seenAccept = String(req.headers.get('accept') ?? '');
				seenCustom = String(req.headers.get('x-test') ?? '');
				return new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } });
			},
		});
		try {
			await openSse(`http://localhost:${server.port}/e`, { headers: { 'X-Test': 'v' }, onEvent: () => {} }).done;
			expect(seenAccept).toBe('text/event-stream');
			expect(seenCustom).toBe('v');
		} finally {
			server.stop(true);
		}
	});

	test('a final event without a trailing blank line still dispatches', async () => {
		const { server, url } = await sseServer(['data: tail']);
		try {
			const events: SseEvent[] = [];
			await openSse(url, { onEvent: (e) => events.push(e) }).done;
			expect(events).toEqual([{ event: 'message', data: 'tail' }]);
		} finally {
			server.stop(true);
		}
	});

	test('the event id is sticky across chunks', async () => {
		const { server, url } = await sseServer(['id: 42\ndata: one\n\n', 'data: two\n\n']);
		try {
			const events: SseEvent[] = [];
			await openSse(url, { onEvent: (e) => events.push(e) }).done;
			expect(events.map((e) => e.id)).toEqual(['42', '42']);
		} finally {
			server.stop(true);
		}
	});
});

/** A fetch that stays pending until the test resolves it. */
function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('openSse: close() is final', () => {
	test('a 200 arriving after close() reports nothing but one close', async () => {
		const deferred = deferredResponse();
		const calls: string[] = [];
		const handle = openSse('http://api.test/events', {
			fetchImpl: (() => deferred.promise) as unknown as typeof fetch,
			onOpen: () => calls.push('open'),
			onEvent: () => calls.push('event'),
			onError: (e) => calls.push('error:' + e),
			onClose: () => calls.push('close'),
		});
		handle.close();
		deferred.resolve(new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } }));
		await handle.done;
		await Bun.sleep(10);
		expect(calls).toEqual(['close']);
	});

	test('a 500 arriving after close() reports nothing but one close', async () => {
		const deferred = deferredResponse();
		const calls: string[] = [];
		const handle = openSse('http://api.test/events', {
			fetchImpl: (() => deferred.promise) as unknown as typeof fetch,
			onOpen: () => calls.push('open'),
			onEvent: () => calls.push('event'),
			onError: (e) => calls.push('error:' + e),
			onClose: () => calls.push('close'),
		});
		handle.close();
		deferred.resolve(new Response('no', { status: 500 }));
		await handle.done;
		await Bun.sleep(10);
		expect(calls).toEqual(['close']);
	});

	test('a 200 without a body arriving after close() stays silent', async () => {
		const deferred = deferredResponse();
		const calls: string[] = [];
		const handle = openSse('http://api.test/events', {
			fetchImpl: (() => deferred.promise) as unknown as typeof fetch,
			onOpen: () => calls.push('open'),
			onEvent: () => calls.push('event'),
			onError: (e) => calls.push('error:' + e),
			onClose: () => calls.push('close'),
		});
		handle.close();
		deferred.resolve(new Response(null, { status: 200 }));
		await handle.done;
		await Bun.sleep(10);
		expect(calls).toEqual(['close']);
	});
});

class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = 0;
	sent: string[] = [];
	closed: { code?: number; reason?: string } | undefined;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(
		public url: string,
		public protocols?: string[]
	) {
		FakeSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(code?: number, reason?: string) {
		this.closed = { code, reason };
		this.readyState = 3;
	}

	open() {
		this.readyState = 1;
		this.onopen?.();
	}

	emit(data: unknown) {
		this.onmessage?.({ data });
	}

	hangup(code = 1000, reason = 'bye') {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

describe('openWebSocket', () => {
	test('reports open, messages and close, and sends only while open', () => {
		FakeSocket.instances = [];
		const events: string[] = [];
		const handle = openWebSocket('wss://api.test/socket', {
			WebSocketImpl: FakeSocket as any,
			onOpen: () => events.push('open'),
			onMessage: (data) => events.push('msg:' + data),
			onClose: (code, reason) => events.push(`close:${code}:${reason}`),
		});
		const socket = FakeSocket.instances[0];
		expect(socket.url).toBe('wss://api.test/socket');
		expect(handle.send('too early')).toBe(false);
		socket.open();
		expect(handle.send('hi')).toBe(true);
		socket.emit('hello');
		socket.emit(42);
		socket.hangup(1001, 'going away');
		expect(events).toEqual(['open', 'msg:hello', 'msg:[binary message]', 'close:1001:going away']);
		expect(socket.sent).toEqual(['hi']);
		expect(handle.state()).toBe(3);
	});

	test('binary frames are described by size, not stringified', () => {
		FakeSocket.instances = [];
		const events: string[] = [];
		openWebSocket('wss://api.test/socket', {
			WebSocketImpl: FakeSocket as any,
			onMessage: (data) => events.push(data),
		});
		const socket = FakeSocket.instances[0];
		socket.open();
		socket.emit(new Blob(['abc']));
		socket.emit(new Uint8Array(4));
		socket.emit(new ArrayBuffer(16));
		socket.emit({});
		socket.emit(null);
		expect(events).toEqual([
			'[binary message, 3 bytes]',
			'[binary message, 4 bytes]',
			'[binary message, 16 bytes]',
			'[binary message]',
			'[binary message]',
		]);
	});

	test('close() forwards code and reason', () => {
		FakeSocket.instances = [];
		const handle = openWebSocket('wss://x', { WebSocketImpl: FakeSocket as any });
		handle.close(4000, 'done');
		expect(FakeSocket.instances[0].closed).toEqual({ code: 4000, reason: 'done' });
	});

	test('protocols are forwarded', () => {
		FakeSocket.instances = [];
		openWebSocket('wss://x', { WebSocketImpl: FakeSocket as any, protocols: ['graphql-ws'] });
		expect(FakeSocket.instances[0].protocols).toEqual(['graphql-ws']);
	});

	test('a throwing constructor is an error, not an exception', () => {
		const errors: string[] = [];
		class Broken {
			constructor() {
				throw new Error('nope');
			}
		}
		const handle = openWebSocket('wss://x', { WebSocketImpl: Broken as any, onError: (e) => errors.push(e) });
		expect(errors[0]).toContain('cannot connect');
		expect(handle.send('x')).toBe(false);
	});

	test('socket errors surface as onError', () => {
		FakeSocket.instances = [];
		const errors: string[] = [];
		openWebSocket('wss://x', { WebSocketImpl: FakeSocket as any, onError: (e) => errors.push(e) });
		FakeSocket.instances[0].onerror?.();
		expect(errors).toEqual(['WebSocket: connection error']);
	});

	test('works against a real WebSocket server', async () => {
		const server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
			},
			websocket: {
				message(ws, message) {
					ws.send(`echo:${message}`);
				},
			},
		});
		try {
			const received: string[] = [];
			const opened = new Promise<void>((resolve) => {
				const handle = openWebSocket(`ws://localhost:${server.port}/ws`, {
					onOpen: () => resolve(),
					onMessage: (data) => received.push(data),
				});
				void handle;
			});
			await opened;
			const handle = openWebSocket(`ws://localhost:${server.port}/ws`, { onMessage: (data) => received.push(data) });
			await Bun.sleep(60);
			expect(handle.send('ping')).toBe(true);
			await Bun.sleep(120);
			expect(received).toContain('echo:ping');
			handle.close();
		} finally {
			server.stop(true);
		}
	});
});

describe('socket slot', () => {
	function fakeHandle(name: string) {
		const closed: string[] = [];
		return {
			name,
			closed,
			send: () => true,
			state: () => 1,
			close: () => closed.push(name),
		};
	}

	test('a replaced socket is not live and cannot clear its replacement', () => {
		const slot = createSocketSlot();
		const first = fakeHandle('first');
		const second = fakeHandle('second');
		slot.open({ kind: 'ws', handle: first });
		expect(slot.isLive(first)).toBe(true);
		slot.close();
		expect(first.closed).toEqual(['first']);
		slot.open({ kind: 'ws', handle: second });
		// the old socket's late onclose: it must neither post nor drop the live handle
		expect(slot.isLive(first)).toBe(false);
		slot.release(first);
		expect(slot.get()?.handle).toBe(second);
		expect(slot.isLive(second)).toBe(true);
	});

	test('releasing the live handle clears it', () => {
		const slot = createSocketSlot();
		const only = fakeHandle('only');
		slot.open({ kind: 'sse', handle: only });
		slot.release(only);
		expect(slot.get()).toBeUndefined();
		expect(slot.isLive(only)).toBe(false);
	});

	test('a callback fired before the handle is stored is not treated as stale', () => {
		const slot = createSocketSlot();
		expect(slot.isLive(undefined)).toBe(true);
		slot.open({ kind: 'ws', handle: fakeHandle('live') });
		expect(slot.isLive(undefined)).toBe(false);
	});
});

describe('hardening found in audit', () => {
	test('an unterminated event cannot grow the buffer without bound', async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				const body = new ReadableStream({
					start(controller) {
						const chunk = 'x'.repeat(200_000);
						for (let i = 0; i < 8; i++) {controller.enqueue(new TextEncoder().encode(chunk));}
						controller.close();
					},
				});
				return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
			},
		});
		try {
			const errors: string[] = [];
			await openSse(`http://localhost:${server.port}/e`, { onEvent: () => {}, onError: (e) => errors.push(e) }).done;
			expect(errors[0]).toContain('exceeded');
		} finally {
			server.stop(true);
		}
	});

	test('onOpen fires only after the server accepts, onClose only once', async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response('data: one\n\n', { headers: { 'content-type': 'text/event-stream' } });
			},
		});
		try {
			let opens = 0;
			let closes = 0;
			const handle = openSse(`http://localhost:${server.port}/e`, {
				onOpen: () => opens++,
				onEvent: () => {},
				onClose: () => closes++,
			});
			await handle.done;
			handle.close();
			expect(opens).toBe(1);
			expect(closes).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	test('a 500 never reports open', async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 500 }) });
		try {
			let opens = 0;
			await openSse(`http://localhost:${server.port}/e`, { onOpen: () => opens++, onEvent: () => {} }).done;
			expect(opens).toBe(0);
		} finally {
			server.stop(true);
		}
	});
});
