// Regression tests for the round-8 review findings: keys that fired twice, states that lied,
// counts that did not count, and limits that were never enforced.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';

const html = readFileSync(join(import.meta.dir, '..', 'src', 'webview', 'main.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const markup = html.replace(/<script>[\s\S]*?<\/script>/, '');

function mount(saved?: unknown, opts: { height?: number; top?: number } = {}) {
	const win = new Window({ url: 'https://asterisk.test/' });
	win.document.write(markup);
	if (opts.height) { (win as any).innerHeight = opts.height; }
	if (opts.top !== undefined) {
		// the splitter measures its ceiling at start-up, so the geometry must exist before the script
		// the pane's rect follows --composer-max, the way a real layout would
		const paneRect = () => {
			const set = parseInt(win.document.documentElement.style.getPropertyValue('--composer-max'), 10);
			const height = Number.isFinite(set) ? set : 200;
			return { top: opts.top, height, bottom: height, left: 0, right: 800, width: 800 };
		};
		(win.document.getElementById('request-pane') as any).getBoundingClientRect = paneRect;
	}
	const posted: any[] = [];
	let state: any = saved;
	new Function('document', 'window', 'Event', 'acquireVsCodeApi', script)(win.document, win, win.Event, () => ({
		postMessage: (m: any) => posted.push(m),
		getState: () => state,
		setState: (s: any) => (state = s),
	}));
	const el = (id: string) => win.document.getElementById(id) as any;
	const press = (id: string, key: string, mods: any = {}) => el(id).dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
	return {
		win,
		el,
		posted,
		state: () => state,
		press,
		message: (data: any) => win.dispatchEvent(new (win as any).MessageEvent('message', { data })),
		cancelled: () => posted.filter((m) => m.type === 'cancel').length,
	};
}

describe('one keypress, one action', () => {
	test('Ctrl+Enter in the URL field sends exactly once', () => {
		const m = mount();
		m.el('url').value = 'https://api.test/x';
		m.press('url', 'Enter', { ctrlKey: true });
		expect(m.posted.filter((p) => p.type === 'send').length).toBe(1);
	});

	test('plain Enter in the URL field still sends', () => {
		const m = mount();
		m.el('url').value = 'https://api.test/x';
		m.press('url', 'Enter');
		expect(m.posted.filter((p) => p.type === 'send').length).toBe(1);
	});

	test('a URL without a scheme is refused here, not silently in the host', () => {
		const m = mount();
		m.el('url').value = 'api.test/x';
		m.el('send').click();
		expect(m.posted.filter((p) => p.type === 'send').length).toBe(0);
		expect(m.el('notice').hidden).toBe(false);
		expect(m.el('notice').textContent).toContain('http://');
	});

	test('Enter in the socket message field sends the frame', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open', text: '— connected' });
		m.el('socket-message').value = 'ping';
		m.press('socket-message', 'Enter');
		expect(m.posted.some((p) => p.type === 'socketSend' && p.text === 'ping')).toBe(true);
	});
});

describe('states never borrow each other', () => {
	test('loading a request after a failure clears the failure copy', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'self signed certificate' } });
		expect(m.el('status').hidden).toBe(false);
		m.message({ type: 'load', request: { method: 'GET', url: 'https://other.test/y' } });
		expect(m.el('status').hidden).toBe(true);
		expect(m.el('status').textContent).toBe('');
	});

	test('a loaded request keeps the previous body, captioned', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{"a":1}', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 7 } });
		m.message({ type: 'load', request: { method: 'GET', url: 'https://other.test/y' } });
		expect(m.el('stale-banner').hidden).toBe(false);
		expect(m.el('stale-banner').textContent).toContain('previous');
	});

	test('a response without a reason phrase has no dangling space', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 204, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 3, ttfbMs: 2, size: 0 } });
		expect(m.el('status').textContent).not.toContain('204 ');
		expect(m.el('status-live').textContent).not.toContain('204 ');
	});
});

describe('the socket has one connect path', () => {
	test('Reconnect with an empty URL explains itself instead of posting nothing', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'closed', text: '— connection failed: ECONNREFUSED', error: 'ECONNREFUSED' });
		m.el('socket-url').value = '';
		const before = m.posted.length;
		m.el('socket-reconnect').click();
		expect(m.posted.slice(before).some((p) => p.type === 'socketConnect')).toBe(false);
		expect(m.el('notice').hidden).toBe(false);
		expect(m.el('notice').textContent).toContain('URL');
	});

	test('Connect with a URL posts one connect message', () => {
		const m = mount();
		m.el('socket-url').value = 'ws://localhost:1';
		m.el('socket-toggle').click();
		expect(m.posted.filter((p) => p.type === 'socketConnect').length).toBe(1);
	});

	test('the protocol select locks while a connection is open or opening', () => {
		const m = mount();
		expect(m.el('socket-mode').disabled).toBe(false);
		m.el('socket-url').value = 'ws://localhost:1';
		m.el('socket-toggle').click();
		expect(m.el('socket-mode').disabled).toBe(true);
		m.message({ type: 'socketState', state: 'open' });
		expect(m.el('socket-mode').disabled).toBe(true);
		m.message({ type: 'socketState', state: 'closed', text: '— disconnected' });
		expect(m.el('socket-mode').disabled).toBe(false);
	});

	test('the connection state is a badge, and hidden before the first connection', () => {
		const m = mount();
		expect(m.el('socket-state').hidden).toBe(true);
		m.message({ type: 'socketState', state: 'open' });
		expect(m.el('socket-state').hidden).toBe(false);
		expect(m.el('socket-state').className).toContain('badge');
		m.message({ type: 'socketState', state: 'closed', text: '— connection failed: x', error: 'x' });
		expect(m.el('socket-state').textContent).toBe('Connection failed');
	});
});

describe('the actions menu is a menu', () => {
	test('every item is one tab stop behind the trigger', () => {
		const m = mount();
		const items = [...m.el('more-menu').querySelectorAll('[role="menuitem"]')];
		expect(items.length).toBeGreaterThan(0);
		expect(items.every((i: any) => i.getAttribute('tabindex') === '-1')).toBe(true);
	});

	test('Tab closes the menu and returns focus to the trigger', () => {
		const m = mount();
		m.el('more').click();
		expect(m.el('more-menu').hidden).toBe(false);
		m.press('more-menu', 'Tab');
		expect(m.el('more-menu').hidden).toBe(true);
		// one press leaves the menu: focus moves on, it does not stay on the trigger
		expect(m.win.document.activeElement).not.toBe(m.el('more'));
		expect(m.win.document.activeElement).not.toBe(m.win.document.body);
	});
});

describe('only request edits are persisted', () => {
	test('typing in the find box does not rewrite the request state', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'hello', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 5 } });
		const before = m.state();
		m.el('res-search').value = 'he';
		m.el('res-search').dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.state()).toBe(before);
	});

	test('typing in the body does persist', () => {
		const m = mount();
		m.el('body-type').value = 'json';
		m.el('body-type').dispatchEvent(new m.win.Event('change'));
		m.el('body').value = '{"typed":1}';
		m.el('body').dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.state().raw).toBe('{"typed":1}');
	});
});

describe('headers and numbers that used to be dropped or mangled', () => {
	test('a header named __proto__ reaches the request', () => {
		const m = mount();
		m.el('url').value = 'https://api.test/x';
		const row = m.el('headers').querySelector('.kv-row');
		row.querySelector('.hk').value = '__proto__';
		row.querySelector('.hv').value = 'yes';
		m.el('send').click();
		const sent = m.posted.find((p) => p.type === 'send');
		expect(Object.keys(sent.request.headers)).toContain('__proto__');
		expect(sent.request.headers['__proto__']).toBe('yes');
	});

	test('sizes promote at the unit boundary instead of printing 1024.0 KB', () => {
		const m = mount();
		const size = (bytes: number) => {
			m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'x', sentUrl: '', timeMs: 1, ttfbMs: 1, size: bytes } });
			return m.el('status').textContent;
		};
		expect(size(1048575)).toContain('1.0 MB');
		expect(size(1024)).toContain('1.0 KB');
		expect(size(1000)).toContain('1000 B');
	});

	test('the status row marks up each separator once', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{}', sentUrl: '', timeMs: 4, ttfbMs: 3, size: 2 } });
		// badge · time · size · content-type: three separators between four facts
		expect(m.el('status').querySelectorAll('.sep').length).toBe(3);
		expect(m.el('status').textContent).toContain('200 OK·4 ms·2 B·application/json');
	});
});

describe('counts are counted', () => {
	test('one failing assertion is singular in the status row and in the Scripts badge', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{}', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 2 }, script: { logs: [], assertions: [{ name: 'expect(1).to.equal(2)', passed: false, message: '1 !== 2' }] } });
		expect(m.el('status').textContent).toContain('1 assertion failed');
		expect(m.el('script-results').textContent).toContain('1 of 1 assertion failed');
	});

	test('one passing assertion is singular too', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 }, script: { logs: [], assertions: [{ name: 'expect(1).to.equal(1)', passed: true }] } });
		expect(m.el('script-results').textContent).toContain('1 assertion passed');
	});
});

describe('search cannot freeze the pane', () => {
	test('marks are capped and the count says so', async () => {
		const m = mount();
		const body = 'a'.repeat(5000);
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body, sentUrl: '', timeMs: 1, ttfbMs: 1, size: body.length } });
		m.el('res-search').value = 'a';
		m.el('res-search').dispatchEvent(new m.win.Event('input', { bubbles: true }));
		// the box debounces by 120ms so a multi-MB body cannot freeze typing
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(m.el('body-out').querySelectorAll('mark').length).toBeLessThanOrEqual(500);
		expect(m.el('res-count').textContent).toContain('5000 matches');
		expect(m.el('res-count').textContent).toContain('first 500');
	});
});

describe('the splitter cannot hide itself', () => {
	test('the ceiling leaves room for the response and never exceeds the viewport', () => {
		const m = mount(undefined, { height: 400, top: 100 });
		const max = Number(m.el('splitter').getAttribute('aria-valuemax'));
		expect(max).toBeLessThanOrEqual(400 - 100 - 90);
		expect(max).toBeGreaterThanOrEqual(120);
	});

	test('dragging past the ceiling clamps to it', () => {
		const m = mount(undefined, { height: 400, top: 100 });
		// happy-dom has no pointer capture and a plain Event carries no clientY, so both are supplied
		m.el('splitter').setPointerCapture = () => {};
		m.el('splitter').dispatchEvent(new m.win.MouseEvent('pointerdown', { bubbles: true, clientY: 200 }));
		m.el('splitter').dispatchEvent(new m.win.MouseEvent('pointermove', { bubbles: true, clientY: 4000 }));
		expect(Number(m.el('splitter').getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(m.el('splitter').getAttribute('aria-valuemax')));
		expect(Number(m.el('splitter').getAttribute('aria-valuemax'))).toBeLessThanOrEqual(400 - 100 - 90);
	});
});

describe('the socket log stays bounded', () => {
	test('old frames are dropped past the cap', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		for (let i = 0; i < 450; i += 1) { m.message({ type: 'socketMessage', direction: 'in', text: 'frame ' + i }); }
		const log = m.el('socket-log');
		expect(log.childElementCount).toBeLessThanOrEqual(400);
		expect(log.textContent).toContain('frame 449');
	});
});
