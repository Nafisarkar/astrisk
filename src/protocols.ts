// WebSocket + SSE clients — no vscode imports. Transports are injectable so both can be
// exercised in tests without a browser or a host.

/** An unterminated event bigger than this is treated as an error instead of buffered forever. */
const MAX_PENDING_EVENT = 1_000_000;

export interface SseEvent {
	event: string;
	data: string;
	id?: string;
	retry?: number;
}

/**
 * Parse one stream chunk into complete events, returning the unfinished tail.
 * Implements the text/event-stream dispatch rules: fields split on the first colon, one optional
 * leading space stripped, multiple `data:` lines joined with \n, blank line dispatches, comment
 * lines (`:`) and events with no data ignored, CRLF or a bare CR tolerated, `id` sticky across
 * events, and one leading BOM dropped.
 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
	// A BOM at the very start would otherwise become part of the first field name.
	if (buffer.charCodeAt(0) === 0xfeff) {buffer = buffer.slice(1);}
	// Hold a trailing CR back: it may be the first half of a CRLF that lands in the next chunk.
	const held = buffer.endsWith('\r') ? '\r' : '';
	const normalized = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
	const blocks = normalized.split('\n\n');
	const rest = blocks.pop() ?? '';
	const events: SseEvent[] = [];
	let lastId: string | undefined;

	for (const block of blocks) {
		if (!block.trim()) {continue;}
		let event = 'message';
		const data: string[] = [];
		let id: string | undefined;
		let retry: number | undefined;

		for (const line of block.split('\n')) {
			if (!line || line.startsWith(':')) {continue;}
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) {value = value.slice(1);}
			if (field === 'event') {event = value;} else if (field === 'data') {data.push(value);} else if (field === 'id') {id = value;} else if (field === 'retry') {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {retry = parsed;}
			}
		}

		// spec: the last event id is sticky — an event without an `id` field inherits it
		if (id !== undefined) {lastId = id;} else if (lastId !== undefined) {id = lastId;}
		if (!data.length) {continue;}
		const dispatched: SseEvent = { event, data: data.join('\n') };
		if (id !== undefined) {dispatched.id = id;}
		if (retry !== undefined) {dispatched.retry = retry;}
		events.push(dispatched);
	}

	return { events, rest: rest + held };
}

export interface SseOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	/** Called once the server has accepted the stream (status 200 + body). */
	onOpen?: () => void;
	onEvent: (event: SseEvent) => void;
	onError?: (message: string) => void;
	onClose?: () => void;
}

export interface SseHandle {
	close(): void;
	/** Resolves when the stream ends (by close, server hangup or error). */
	done: Promise<void>;
}

/** Open an SSE stream and dispatch parsed events until closed. Never throws. */
export function openSse(url: string, options: SseOptions): SseHandle {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	let closed = false;
	let finished = false;
	const message = (e: unknown) => String((e as any)?.message ?? e);

	const done = (async () => {
		const doFetch = options.fetchImpl ?? fetch;
		let response: Response;
		try {
			response = await doFetch(url, {
				headers: { accept: 'text/event-stream', ...(options.headers ?? {}) },
				signal,
			});
		} catch (e: unknown) {
			if (!closed) {options.onError?.(`SSE: cannot connect — ${message(e)}`);}
			return;
		}

		if (!response.ok) {
			if (closed) {return;}
			options.onError?.(`SSE: ${url} returned ${response.status} ${response.statusText}`);
			return;
		}
		if (closed) {return;}
		if (!response.body) {
			options.onError?.('SSE: response has no body to stream');
			return;
		}
		if (closed) {return;}
		options.onOpen?.();

		// the id buffer is stream-level, so it sticks across chunks too
		let lastId: string | undefined;
		const dispatch = (event: SseEvent) => {
			if (closed) {return;}
			if (event.id === undefined) {if (lastId !== undefined) {event.id = lastId;}} else {lastId = event.id;}
			options.onEvent(event);
		};

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { done: finished, value } = await reader.read();
				if (finished || closed) {break;}
				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > MAX_PENDING_EVENT) {
					// a server that never sends the blank-line terminator must not grow the host heap
					throw new Error(`event data exceeded ${Math.round(MAX_PENDING_EVENT / 1024)} KB without a terminator`);
				}
				const parsed = parseSseChunk(buffer);
				buffer = parsed.rest;
				for (const event of parsed.events) {dispatch(event);}
			}
			// a final block without the trailing blank line still counts
			const tail = parseSseChunk(buffer + '\n\n');
			for (const event of tail.events) {dispatch(event);}
		} catch (e: unknown) {
			if (!closed) {options.onError?.(`SSE: stream failed — ${message(e)}`);}
		} finally {
			finished = true;
			if (!closed) {options.onClose?.();}
		}
	})();

	return {
		close() {
			closed = true;
			controller.abort();
			// Only report a close the stream did not already report itself.
			if (!finished) {options.onClose?.();}
		},
		done,
	};
}

export interface WsOptions {
	protocols?: string[];
	WebSocketImpl?: typeof WebSocket;
	onOpen?: () => void;
	onMessage?: (data: string) => void;
	onClose?: (code: number, reason: string) => void;
	onError?: (message: string) => void;
}

export interface WsHandle {
	/** false when the socket is not open yet — the caller can show that instead of pretending. */
	send(data: string): boolean;
	close(code?: number, reason?: string): void;
	state(): number;
}

/** The one socket a panel is currently streaming from. */
export type LiveSocket = { kind: 'ws'; handle: WsHandle } | { kind: 'sse'; handle: SseHandle };

/**
 * At most one live socket. Every callback captures its own handle and goes through `isLive` /
 * `release`, so the previous socket's late `onclose` can neither post state nor drop the handle
 * that replaced it.
 */
export function createSocketSlot() {
	let live: LiveSocket | undefined;
	return {
		get: (): LiveSocket | undefined => live,
		open(next: LiveSocket): void {
			live = next;
		},
		/** `undefined` means "the handle has not been created yet" — that callback is not stale. */
		isLive(handle: WsHandle | SseHandle | undefined): boolean {
			return live?.handle === handle;
		},
		release(handle: WsHandle | SseHandle | undefined): void {
			if (live?.handle === handle) {live = undefined;}
		},
		close(): void {
			const previous = live;
			live = undefined;
			previous?.handle.close();
		},
	};
}

/** Open a WebSocket. Headers are not supported by the spec, so none are sent. Never throws. */
export function openWebSocket(url: string, options: WsOptions = {}): WsHandle {
	const Impl = options.WebSocketImpl ?? (globalThis as any).WebSocket;
	if (!Impl) {
		options.onError?.('WebSocket is not available in this runtime');
		return { send: () => false, close: () => {}, state: () => 3 };
	}

	let socket: WebSocket;
	try {
		socket = new Impl(url, options.protocols);
	} catch (e: unknown) {
		options.onError?.(`WebSocket: cannot connect — ${String((e as any)?.message ?? e)}`);
		return { send: () => false, close: () => {}, state: () => 3 };
	}

	const text = (raw: unknown): string => {
		if (typeof raw === 'string') {return raw;}
		// Binary frames: `String(data)` would log "[object Blob]", which tells the user nothing.
		const sized = raw as { size?: unknown; byteLength?: unknown } | null | undefined;
		const size = typeof sized?.size === 'number' ? sized.size : sized?.byteLength;
		return typeof size === 'number' ? `[binary message, ${size} bytes]` : '[binary message]';
	};
	socket.onopen = () => options.onOpen?.();
	socket.onmessage = (event: MessageEvent) => options.onMessage?.(text(event.data));
	socket.onclose = (event: CloseEvent) => options.onClose?.(event.code ?? 1006, event.reason ?? '');
	socket.onerror = () => options.onError?.('WebSocket: connection error');

	return {
		send(data: string): boolean {
			if (socket.readyState !== 1) {return false;}
			socket.send(data);
			return true;
		},
		close(code?: number, reason?: string) {
			socket.close(code, reason);
		},
		state() {
			return socket.readyState;
		},
	};
}
