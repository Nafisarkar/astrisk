// Webview smoke tests: run the real inline script against a real DOM (happy-dom).
// ponytail: DOM harness rather than a hand-rolled stub — the page is the thing under test.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';

const html = readFileSync(join(import.meta.dir, '..', 'src', 'webview', 'main.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const markup = html.replace(/<script>[\s\S]*?<\/script>/, '');

interface Mounted {
	win: Window;
	doc: Document;
	posted: any[];
	state: () => any;
	el: (id: string) => any;
	send: () => any;
	setType: (t: string) => void;
	message: (data: any) => void;
}

function mount(saved?: unknown): Mounted {
	const win = new Window({ url: 'https://asterisk.test/' });
	win.document.write(markup);

	const posted: any[] = [];
	let state: any = saved;
	const api = {
		postMessage: (m: any) => posted.push(m),
		getState: () => state,
		setState: (s: any) => (state = s),
	};

	new Function('document', 'window', 'acquireVsCodeApi', script)(win.document, win, () => api);

	const el = (id: string) => win.document.getElementById(id) as any;
	const m: Mounted = {
		win,
		doc: win.document as unknown as Document,
		posted,
		state: () => state,
		el,
		setType: (t: string) => {
			el('body-type').value = t;
			el('body-type').dispatchEvent(new win.Event('change'));
		},
		message: (data: any) => win.dispatchEvent(new (win as any).MessageEvent('message', { data })),
		send: () => {
			el('url').value = 'https://api.test/x';
				posted.length = 0;
			el('send').click();
			return posted.find((p) => p.type === 'send')?.request;
		},
	};
	return m;
}

function addKv(m: Mounted, container: string, key: string, value: string) {
	const row = m.doc.querySelector(`#${container} .kv-row`) as any;
	row.querySelector('.hk').value = key;
	row.querySelector('.hv').value = value;
	// typing fires input, which is what persists state
	row.querySelector('.hk').dispatchEvent(new m.win.Event('input', { bubbles: true }));
	row.querySelector('.hv').dispatchEvent(new m.win.Event('input', { bubbles: true }));
	return row;
}

describe('body pane — type switching', () => {
	test('defaults to no body: raw editor hidden, no Content-Type hint', () => {
		const m = mount();
		expect(m.el('body-type').value).toBe('none');
		expect(m.el('body').hidden).toBe(true);
		expect(m.el('ct-hint').textContent).toBe('');
	});

	test.each([
		['json', 'application/json'],
		['text', 'text/plain'],
		['xml', 'application/xml'],
		['html', 'text/html'],
	])('%s shows the raw editor and hints %s', (type, hint) => {
		const m = mount();
		m.setType(type);
		expect(m.el('ct-hint').textContent).toContain(hint);
		expect(m.el('body').hidden).toBe(false);
		expect(m.doc.getElementById('urlencoded-pane')!.classList.contains('active')).toBe(false);
		expect(m.doc.getElementById('binary-pane')!.classList.contains('active')).toBe(false);
	});

	test.each([
		['urlencoded', 'application/x-www-form-urlencoded', 'urlencoded-pane'],
		['binary', 'application/octet-stream', 'binary-pane'],
	])('%s hides the raw editor and hints %s', (type, hint, pane) => {
		const m = mount();
		m.setType(type);
		expect(m.el('ct-hint').textContent).toContain(hint);
		expect(m.el('body').hidden).toBe(true);
		expect(m.doc.getElementById(pane)!.classList.contains('active')).toBe(true);
	});

	test('multipart shows grids, not the raw editor', () => {
		const m = mount();
		m.setType('multipart');
		expect(m.el('body').hidden).toBe(true);
		expect(m.doc.getElementById('multipart-pane')!.classList.contains('active')).toBe(true);
		expect(m.el('ct-hint').textContent).toContain('multipart/form-data');
	});

	test('switching away clears the invalid-JSON badge', () => {
		const m = mount();
		m.setType('json');
		m.el('body').value = '{oops';
		m.el('body').dispatchEvent(new m.win.Event('blur'));
		expect(m.el('json-bad').hidden).toBe(false);
		m.setType('text');
		expect(m.el('json-bad').hidden).toBe(true);
	});
});

describe('json pretty-print toggle', () => {
	test('reformats valid JSON on blur when enabled', () => {
		const m = mount();
		m.setType('json');
		m.el('body').value = '{"a":1,"b":[2,3]}';
		m.el('body').dispatchEvent(new m.win.Event('blur'));
		expect(m.el('body').value).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('leaves text alone and flags bad JSON', () => {
		const m = mount();
		m.setType('json');
		m.el('body').value = '{"a":}';
		m.el('body').dispatchEvent(new m.win.Event('blur'));
		expect(m.el('body').value).toBe('{"a":}');
		expect(m.el('json-bad').hidden).toBe(false);
	});

	test('toggle off means no reformatting', () => {
		const m = mount();
		m.setType('json');
		m.el('pretty-toggle').checked = false;
		m.el('body').value = '{"a":1}';
		m.el('body').dispatchEvent(new m.win.Event('blur'));
		expect(m.el('body').value).toBe('{"a":1}');
	});

	test('does not touch non-JSON body types', () => {
		const m = mount();
		m.setType('text');
		m.el('body').value = '  keep   spacing  ';
		m.el('body').dispatchEvent(new m.win.Event('blur'));
		expect(m.el('body').value).toBe('  keep   spacing  ');
	});
});

describe('outgoing payload', () => {
	test('raw JSON', () => {
		const m = mount();
		m.setType('json');
		m.el('body').value = '{"a":1}';
		expect(m.send().body).toEqual({ type: 'raw', format: 'json', content: '{"a":1}' });
	});

	test('empty raw editor sends no body at all', () => {
		const m = mount();
		m.setType('json');
		m.el('body').value = '   ';
		expect(m.send().body).toEqual({ type: 'none' });
	});

	test('none sends no body', () => {
		const m = mount();
		expect(m.send().body).toEqual({ type: 'none' });
	});

	test('urlencoded grid, blank keys dropped, values kept verbatim', () => {
		const m = mount();
		m.setType('urlencoded');
		m.el('add-urlencoded').click();
		m.el('add-urlencoded').click();
		m.el('add-urlencoded').click();
		const rows = m.doc.querySelectorAll('#urlencoded-rows .kv-row');
		(rows[0].querySelector('.hk') as any).value = 'a b';
		(rows[0].querySelector('.hv') as any).value = '1+1';
		(rows[1].querySelector('.hk') as any).value = '   ';
		(rows[1].querySelector('.hv') as any).value = 'ghost';
		(rows[2].querySelector('.hk') as any).value = 'empty';
		(rows[2].querySelector('.hv') as any).value = '';
		expect(m.send().body).toEqual({ type: 'urlencoded', fields: [{ key: 'a b', value: '1+1' }, { key: 'empty', value: '' }] });
	});

	test('urlencoded with no rows sends no body', () => {
		const m = mount();
		m.setType('urlencoded');
		expect(m.send().body).toEqual({ type: 'none' });
	});

	test('multipart fields + picked file', () => {
		const m = mount();
		m.setType('multipart');
		m.el('add-mp').click();
		addKv(m, 'mp-rows', 'name', 'Ada');

		m.el('add-mp-file').click();
		const fileRow = m.doc.querySelector('#mp-files .file-row') as any;
		(fileRow.querySelector('.hk') as any).value = 'doc';
		(fileRow.querySelector('.pick') as any).click();

		const pick = m.posted.find((p) => p.type === 'pickFile');
		expect(pick).toBeTruthy();
		m.message({ type: 'filePicked', id: pick.id, path: '/tmp/hello.txt', name: 'hello.txt' });
		expect(fileRow.querySelector('.fname').textContent).toBe('hello.txt');

		expect(m.send().body).toEqual({
			type: 'multipart',
			fields: [{ key: 'name', value: 'Ada' }],
			files: [{ key: 'doc', path: '/tmp/hello.txt' }],
		});
	});

	test('multipart rows with a key but no file are dropped', () => {
		const m = mount();
		m.setType('multipart');
		m.el('add-mp-file').click();
		(m.doc.querySelector('#mp-files .file-row .hk') as any).value = 'doc';
		expect(m.send().body).toEqual({ type: 'none' });
	});

	test('binary needs a picked file', () => {
		const m = mount();
		m.setType('binary');
		expect(m.send().body).toEqual({ type: 'none' });

		m.el('pick-binary').click();
		const pick = m.posted.find((p) => p.type === 'pickFile');
		m.message({ type: 'filePicked', id: pick.id, path: '/tmp/blob.bin', name: 'blob.bin' });
		expect(m.el('binary-name').textContent).toBe('blob.bin');
		expect(m.send().body).toEqual({ type: 'binary', path: '/tmp/blob.bin' });
	});

	test('cancelled file dialog leaves the picker empty and does not throw', () => {
		const m = mount();
		m.setType('binary');
		m.el('pick-binary').click();
		const pick = m.posted.find((p) => p.type === 'pickFile');
		expect(() => m.message({ type: 'filePicked', id: pick.id })).not.toThrow();
		expect(m.el('binary-name').textContent).toBe('No file selected');
		expect(m.send().body).toEqual({ type: 'none' });
	});

	test('headers are trimmed and blank names dropped', () => {
		const m = mount();
		const row = m.doc.querySelector('#headers .kv-row') as any;
		(row.querySelector('.hk') as any).value = '  X-Test  ';
		(row.querySelector('.hv') as any).value = '  value  ';
		m.el('add-header').click();
		const rows = m.doc.querySelectorAll('#headers .kv-row');
		(rows[1].querySelector('.hk') as any).value = '  ';
		expect(m.send().headers).toEqual({ 'X-Test': 'value' });
	});
});

describe('state round-trip', () => {
	test('saved state restores every body type exactly once', () => {
		const source = mount();
		source.setType('multipart');
		source.el('add-mp').click();
		addKv(source, 'mp-rows', 'a', '1');
		source.el('add-mp-file').click();
		const row = source.doc.querySelector('#mp-files .file-row') as any;
		(row.querySelector('.hk') as any).value = 'doc';
		(row.querySelector('.pick') as any).click();
		source.message({ type: 'filePicked', id: source.posted.find((p) => p.type === 'pickFile').id, path: '/tmp/a.txt', name: 'a.txt' });

		const snapshot = source.state();
		const restored = mount(JSON.parse(JSON.stringify(snapshot)));

		expect(restored.el('body-type').value).toBe('multipart');
		expect(restored.doc.querySelectorAll('#mp-rows .kv-row')).toHaveLength(1);
		expect(restored.doc.querySelectorAll('#mp-files .file-row')).toHaveLength(1);
		expect((restored.doc.querySelector('#mp-rows .hk') as any).value).toBe('a');
		expect(restored.doc.querySelector('#mp-files .fname')!.textContent).toBe('a.txt');
		expect(restored.send().body).toEqual({ type: 'multipart', fields: [{ key: 'a', value: '1' }], files: [{ key: 'doc', path: '/tmp/a.txt' }] });
	});

	test('binary selection survives a remount', () => {
		const source = mount();
		source.setType('binary');
		source.el('pick-binary').click();
		source.message({ type: 'filePicked', id: source.posted.find((p) => p.type === 'pickFile').id, path: '/tmp/b.bin', name: 'b.bin' });

		const restored = mount(JSON.parse(JSON.stringify(source.state())));
		expect(restored.el('binary-name').textContent).toBe('b.bin');
		expect(restored.send().body).toEqual({ type: 'binary', path: '/tmp/b.bin' });
	});

	test('urlencoded rows survive a remount', () => {
		const source = mount();
		source.setType('urlencoded');
		source.el('add-urlencoded').click();
		addKv(source, 'urlencoded-rows', 'k', 'v');
		const restored = mount(JSON.parse(JSON.stringify(source.state())));
		expect(restored.doc.querySelectorAll('#urlencoded-rows .kv-row')).toHaveLength(1);
		expect(restored.send().body).toEqual({ type: 'urlencoded', fields: [{ key: 'k', value: 'v' }] });
	});

	test('legacy M1 state (bare body string, no bodyType) migrates to raw text', () => {
		const restored = mount({ method: 'POST', url: 'https://api.test/x', headers: [['X', '1']], body: 'plain' });
		expect(restored.el('body-type').value).toBe('text');
		expect(restored.el('body').value).toBe('plain');
		expect(restored.el('url').value).toBe('https://api.test/x');
		expect(restored.doc.querySelectorAll('#headers .kv-row')).toHaveLength(1);
	});

	test('fresh mount has exactly one header row after storing nothing', () => {
		const m = mount();
		expect(m.doc.querySelectorAll('#headers .kv-row')).toHaveLength(1);
	});
});

describe('response rendering', () => {
	test('renders status, timing, pretty JSON, and escapes error text', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{"a":1}', timeMs: 12, size: 7 },
		});
		expect(m.el('status').textContent).toContain('200 OK');
		expect(m.el('status').textContent).toContain('12 ms');
		expect(m.el('body-out').textContent).toBe('{\n  "a": 1\n}');
		expect(m.el('send').disabled).toBe(false);

		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', timeMs: 1, size: 0, error: '<script>x</script>' } });
		expect(m.el('status').innerHTML).not.toContain('<script>');
		expect(m.el('status').textContent).toContain('<script>x</script>');
	});
});

describe('collections: load a saved request', () => {
	const loaded = (m: Mounted, request: any) => m.message({ type: 'load', request });
	const current = (m: Mounted) => {
		m.posted.length = 0;
		m.el('save').click();
		return m.posted.find((p) => p.type === 'save')?.request;
	};

	test('announces readiness on mount so the host can deliver a queued request', () => {
		const m = mount();
		expect(m.posted.some((p) => p.type === 'ready')).toBe(true);
	});

	test('raw JSON request fills method, url, headers, and body', () => {
		const m = mount();
		loaded(m, {
			method: 'PUT',
			url: 'https://api.test/users/1',
			headers: { 'X-Token': 'abc' },
			body: { type: 'raw', format: 'json', content: '{"a":1}' },
			auth: { type: 'none' },
		});
		expect(m.el('method').value).toBe('PUT');
		expect(m.el('url').value).toBe('https://api.test/users/1');
		expect(m.el('body-type').value).toBe('json');
		expect(m.el('body').value).toBe('{"a":1}');
		expect(m.el('ct-hint').textContent).toContain('application/json');
		expect((m.doc.querySelector('#headers .hk') as any).value).toBe('X-Token');
		expect((m.doc.querySelector('#headers .hv') as any).value).toBe('abc');
		// and it saves back byte-identical
		expect(current(m)).toEqual({
			method: 'PUT',
			url: 'https://api.test/users/1',
			headers: { 'X-Token': 'abc' },
			body: { type: 'raw', format: 'json', content: '{"a":1}' },
			auth: { type: 'none' },
		});
	});

	test('urlencoded request restores its field grid', () => {
		const m = mount();
		loaded(m, { method: 'POST', url: 'https://x.test', body: { type: 'urlencoded', fields: [{ key: 'a', value: '1' }, { key: 'b c', value: '2' }] } });
		expect(m.el('body-type').value).toBe('urlencoded');
		expect(m.doc.querySelectorAll('#urlencoded-rows .kv-row')).toHaveLength(2);
		expect(current(m).body).toEqual({ type: 'urlencoded', fields: [{ key: 'a', value: '1' }, { key: 'b c', value: '2' }] });
	});

	test('multipart request restores fields and file rows with their paths', () => {
		const m = mount();
		loaded(m, {
			method: 'POST',
			url: 'https://x.test/upload',
			body: { type: 'multipart', fields: [{ key: 'tag', value: 'v1' }], files: [{ key: 'doc', path: 'C:/tmp/hello.txt' }] },
		});
		expect(m.doc.querySelectorAll('#mp-files .file-row')).toHaveLength(1);
		expect(m.doc.querySelector('#mp-files .fname')!.textContent).toBe('hello.txt');
		expect(current(m).body).toEqual({
			type: 'multipart',
			fields: [{ key: 'tag', value: 'v1' }],
			files: [{ key: 'doc', path: 'C:/tmp/hello.txt' }],
		});
	});

	test('binary request restores the picked file', () => {
		const m = mount();
		loaded(m, { method: 'POST', url: 'https://x.test/blob', body: { type: 'binary', path: '/tmp/a.bin' } });
		expect(m.el('binary-name').textContent).toBe('a.bin');
		expect(m.el('body-type').value).toBe('binary');
		expect(current(m).body).toEqual({ type: 'binary', path: '/tmp/a.bin' });
	});

	test('request with no body clears any previous editor state', () => {
		const m = mount();
		loaded(m, { method: 'GET', url: 'https://x.test/a', body: { type: 'urlencoded', fields: [{ key: 'a', value: '1' }] } });
		loaded(m, { method: 'GET', url: 'https://x.test/b' });
		expect(m.el('body-type').value).toBe('none');
		expect(m.el('body').value).toBe('');
		expect(m.doc.querySelectorAll('#urlencoded-rows .kv-row')).toHaveLength(0);
		expect(m.doc.querySelectorAll('#mp-files .file-row')).toHaveLength(0);
		expect(current(m).body).toEqual({ type: 'none' });
	});

	test('loading a second request replaces the first headers instead of appending', () => {
		const m = mount();
		loaded(m, { method: 'GET', url: 'https://x.test/a', headers: { A: '1' } });
		loaded(m, { method: 'GET', url: 'https://x.test/b', headers: { B: '2' } });
		expect(m.doc.querySelectorAll('#headers .kv-row')).toHaveLength(1);
		expect((m.doc.querySelector('#headers .hk') as any).value).toBe('B');
	});

	test('the host can ask for a save snapshot of the current editor', () => {
		const m = mount();
		m.setType('json');
		m.el('body').value = '{"live":true}';
		m.el('url').value = 'https://x.test/live';
		m.posted.length = 0;
		m.message({ type: 'requestSnapshot' });
		const save = m.posted.find((p) => p.type === 'save')?.request;
		expect(save).toEqual({
			method: 'GET',
			url: 'https://x.test/live',
			headers: {},
			body: { type: 'raw', format: 'json', content: '{"live":true}' },
			auth: { type: 'none' },
		});
	});
});

describe('environments switcher', () => {
	test('starts with only "No environment" and the new-environment entry', () => {
		const m = mount();
		const labels = [...m.el('env').options].map((o: any) => o.textContent);
		expect(labels).toEqual(['No environment', '+ New environment…']);
		expect(m.el('env').value).toBe('');
	});

	test('renders environments from the host and selects the active one', () => {
		const m = mount();
		m.message({ type: 'envs', active: 'prod', names: ['dev', 'prod'] });
		const labels = [...m.el('env').options].map((o: any) => o.textContent);
		expect(labels).toEqual(['No environment', 'dev', 'prod', '+ New environment…']);
		expect(m.el('env').value).toBe('prod');
	});

	test('unknown active falls back to no environment', () => {
		const m = mount();
		m.message({ type: 'envs', active: 'gone', names: ['dev'] });
		expect(m.el('env').value).toBe('');
	});

	test('picking an environment posts setEnv', () => {
		const m = mount();
		m.message({ type: 'envs', active: 'dev', names: ['dev', 'prod'] });
		m.posted.length = 0;
		m.el('env').value = 'prod';
		m.el('env').dispatchEvent(new m.win.Event('change'));
		expect(m.posted.find((p) => p.type === 'setEnv')).toEqual({ type: 'setEnv', name: 'prod' });
	});

	test('picking "new environment" posts a create request and keeps the old selection', () => {
		const m = mount();
		m.message({ type: 'envs', active: 'dev', names: ['dev'] });
		m.posted.length = 0;
		m.el('env').value = '__new__';
		m.el('env').dispatchEvent(new m.win.Event('change'));
		expect(m.posted.find((p) => p.type === 'setEnv')).toEqual({ type: 'setEnv', name: '__new__' });
		expect(m.el('env').value).toBe('dev');
	});

	test('clearing the selection posts an empty name', () => {
		const m = mount();
		m.message({ type: 'envs', active: 'dev', names: ['dev'] });
		m.posted.length = 0;
		m.el('env').value = '';
		m.el('env').dispatchEvent(new m.win.Event('change'));
		expect(m.posted.find((p) => p.type === 'setEnv')).toEqual({ type: 'setEnv', name: '' });
	});
});

describe('auth tab', () => {
	const current = (m: Mounted) => {
		m.posted.length = 0;
		m.el('save').click();
		return m.posted.find((p) => p.type === 'save')?.request;
	};

	test('defaults to no auth and hides every auth pane', () => {
		const m = mount();
		expect(m.el('auth-type').value).toBe('none');
		expect(m.el('auth-hint').textContent).toBe('');
		for (const id of ['auth-bearer', 'auth-basic', 'auth-apikey', 'auth-cc', 'auth-ac']) {
			expect(m.doc.getElementById(id)!.classList.contains('active')).toBe(false);
		}
	});

	test.each([
		['bearer', 'auth-bearer', 'Authorization: Bearer'],
		['basic', 'auth-basic', 'Basic'],
		['apikey', 'auth-apikey', 'header or query'],
		['oauth2-cc', 'auth-cc', 'cached'],
		['oauth2-ac', 'auth-ac', 'Browser'],
	])('%s shows its pane and hint', (type, pane, hint) => {
		const m = mount();
		m.el('auth-type').value = type;
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		expect(m.doc.getElementById(pane)!.classList.contains('active')).toBe(true);
		expect(m.el('auth-hint').textContent.toLowerCase()).toContain(hint.toLowerCase());
	});

	test('bearer token is collected, and blank means none', () => {
		const m = mount();
		m.el('auth-type').value = 'bearer';
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		expect(current(m).auth).toEqual({ type: 'none' });
		m.el('bearer-token').value = '{{token}}';
		expect(current(m).auth).toEqual({ type: 'bearer', token: '{{token}}' });
	});

	test('basic auth keeps password even when the username is empty', () => {
		const m = mount();
		m.el('auth-type').value = 'basic';
		m.el('basic-pass').value = 'secret';
		expect(current(m).auth).toEqual({ type: 'basic', username: '', password: 'secret' });
	});

	test('api key needs a name and remembers header vs query', () => {
		const m = mount();
		m.el('auth-type').value = 'apikey';
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		expect(current(m).auth).toEqual({ type: 'none' });
		m.el('apikey-name').value = ' X-Api-Key ';
		m.el('apikey-value').value = 'abc';
		m.el('apikey-in').value = 'query';
		expect(current(m).auth).toEqual({ type: 'apikey', key: 'X-Api-Key', value: 'abc', in: 'query' });
	});

	test('oauth2 client credentials needs token url + client id', () => {
		const m = mount();
		m.el('auth-type').value = 'oauth2-cc';
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		expect(current(m).auth).toEqual({ type: 'none' });
		m.el('cc-url').value = 'https://idp.test/token';
		m.el('cc-id').value = 'client';
		m.el('cc-secret').value = 'shh';
		expect(current(m).auth).toEqual({
			type: 'oauth2-cc',
			tokenUrl: 'https://idp.test/token',
			clientId: 'client',
			clientSecret: 'shh',
			scope: undefined,
		});
	});

	test('oauth2 authorization code collects all four urls/ids plus redirect override', () => {
		const m = mount();
		m.el('auth-type').value = 'oauth2-ac';
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		m.el('ac-auth-url').value = 'https://idp.test/authorize';
		m.el('ac-url').value = 'https://idp.test/token';
		m.el('ac-id').value = 'client';
		m.el('ac-secret').value = 'shh';
		m.el('ac-scope').value = 'read write';
		m.el('ac-redirect').value = 'http://localhost:9000/cb';
		expect(current(m).auth).toEqual({
			type: 'oauth2-ac',
			authUrl: 'https://idp.test/authorize',
			tokenUrl: 'https://idp.test/token',
			clientId: 'client',
			clientSecret: 'shh',
			scope: 'read write',
			redirectUri: 'http://localhost:9000/cb',
		});
	});

	test('loading a saved request fills the auth tab, including oauth', () => {
		const m = mount();
		m.message({
			type: 'load',
			request: {
				method: 'GET',
				url: 'https://x.test',
				auth: { type: 'oauth2-cc', tokenUrl: 'https://idp.test/t', clientId: 'c', clientSecret: 's', scope: 'a' },
			},
		});
		expect(m.el('auth-type').value).toBe('oauth2-cc');
		expect(m.el('cc-url').value).toBe('https://idp.test/t');
		expect(m.el('cc-id').value).toBe('c');
		expect(m.el('cc-secret').value).toBe('s');
		expect(m.el('cc-scope').value).toBe('a');
		expect(m.doc.getElementById('auth-cc')!.classList.contains('active')).toBe(true);
		expect(current(m).auth).toEqual({ type: 'oauth2-cc', tokenUrl: 'https://idp.test/t', clientId: 'c', clientSecret: 's', scope: 'a' });
	});

	test('switching auth type hides the previous pane', () => {
		const m = mount();
		m.el('auth-type').value = 'bearer';
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		m.el('auth-type').value = 'basic';
		m.el('auth-type').dispatchEvent(new m.win.Event('change'));
		expect(m.doc.getElementById('auth-bearer')!.classList.contains('active')).toBe(false);
		expect(m.doc.getElementById('auth-basic')!.classList.contains('active')).toBe(true);
	});
});

describe('code snippets pane', () => {
	test('opening the Code tab asks the host for a cURL snippet', () => {
		const m = mount();
		m.posted.length = 0;
		(m.doc.querySelector('.tab[data-pane="code"]') as any).click();
		const ask = m.posted.find((p) => p.type === 'snippet');
		expect(ask).toBeTruthy();
		expect(ask.lang).toBe('curl');
		expect(ask.request.method).toBe('GET');
	});

	test('switching language re-asks with the new language', () => {
		const m = mount();
		m.el('snippet-lang').value = 'python';
		m.posted.length = 0;
		m.el('snippet-lang').dispatchEvent(new m.win.Event('change'));
		expect(m.posted.find((p) => p.type === 'snippet').lang).toBe('python');
	});

	test('the generated snippet is rendered verbatim and copying posts the text', () => {
		const m = mount();
		m.message({ type: 'snippet', text: 'curl -X GET "https://x"\n' });
		expect(m.el('snippet-out').textContent).toBe('curl -X GET "https://x"\n');
		m.posted.length = 0;
		m.el('snippet-copy').click();
		expect(m.posted.find((p) => p.type === 'copy')).toEqual({ type: 'copy', text: 'curl -X GET "https://x"\n' });
	});

	test('copying an empty snippet posts nothing', () => {
		const m = mount();
		m.posted.length = 0;
		m.el('snippet-copy').click();
		expect(m.posted.some((p) => p.type === 'copy')).toBe(false);
	});

	test('a failed generation shows the host message instead of blowing up', () => {
		const m = mount();
		m.message({ type: 'snippet', text: '// Cannot generate snippet: boom' });
		expect(m.el('snippet-out').textContent).toContain('boom');
	});
});

describe('response extras', () => {
	const search = async (m: Mounted, query: string) => {
		m.el('res-search').value = query;
		m.el('res-search').dispatchEvent(new m.win.Event('input'));
		// the panel debounces typing
		await Bun.sleep(160);
	};

	const respond = (m: Mounted, body: string, extra: any = {}) =>
		m.message({
			type: 'response',
			response: {
				ok: true,
				status: 200,
				statusText: 'OK',
				headers: { 'content-type': 'application/json' },
				body,
				sentUrl: 'https://x.test/a',
				timeMs: 130,
				ttfbMs: 30,
				size: body.length,
				...extra,
			},
		});

	test('status shows the timing breakdown and content type', () => {
		const m = mount();
		respond(m, '{"a":1}');
		const text = m.el('status').textContent;
		expect(text).toContain('130 ms');
		expect(m.el('status').querySelector('.metric')!.getAttribute('title')).toContain('30 ms time to first byte');
		expect(m.el('status').querySelector('.metric')!.getAttribute('title')).toContain('100 ms download');
		expect(text).toContain('application/json');
	});

	test('tree tab is hidden for a non-JSON body', () => {
		const m = mount();
		respond(m, 'not json', { headers: { 'content-type': 'text/plain' } });
		expect(m.el('rtree-tab').hidden).toBe(true);
	});

	test('tree renders nested JSON with native details elements', () => {
		const m = mount();
		respond(m, '{"user":{"name":"ada","tags":["a","b"]},"n":1}');
		expect(m.el('rtree-tab').hidden).toBe(false);
		(m.doc.querySelector('#res-tabs .tab[data-rpane="rtree"]') as any).click();
		const tree = m.el('tree-out');
		expect(tree.textContent).toContain('user');
		expect(tree.textContent).toContain('ada');
		expect(tree.querySelectorAll('details').length).toBeGreaterThanOrEqual(2);
		expect(tree.textContent).toContain('[2]');
	});

	test('tree survives null, empty objects and arrays', () => {
		const m = mount();
		respond(m, '{"a":null,"b":{},"c":[]}');
		(m.doc.querySelector('#res-tabs .tab[data-rpane="rtree"]') as any).click();
		expect(m.el('tree-out').textContent).toContain('null');
		expect(m.el('tree-out').textContent).toContain('{0}');
		expect(m.el('tree-out').textContent).toContain('[0]');
	});

	test('tree truncates a huge response instead of hanging', () => {
		const m = mount();
		const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ i })));
		respond(m, big);
		(m.doc.querySelector('#res-tabs .tab[data-rpane="rtree"]') as any).click();
		expect(m.el('tree-out').textContent).toContain('truncated');
	});

	test('search highlights literal matches and counts them', async () => {
		const m = mount();
		respond(m, '{"a":"needle","b":"needle"}');
		await search(m, 'needle');
		expect(m.el('body-out').querySelectorAll('mark').length).toBe(2);
		expect(m.el('res-count').textContent).toBe('2 matches');
	});

	test('search is case-insensitive and reports zero matches', async () => {
		const m = mount();
		respond(m, '{"a":"NEEDLE"}');
		await search(m, 'needle');
		expect(m.el('res-count').textContent).toBe('1 match');
		await search(m, 'absent');
		expect(m.el('res-count').textContent).toBe('no matches');
	});

	test('search treats regex characters literally and never injects markup', async () => {
		const m = mount();
		respond(m, '{"a":"<b>$&.*","b":"<b>$&.*"}');
		await search(m, '<b>$&.*');
		expect(m.el('body-out').querySelectorAll('mark').length).toBe(2);
		expect(m.el('body-out').querySelectorAll('b').length).toBe(0);
	});

	test('clearing the search restores the plain body', async () => {
		const m = mount();
		respond(m, '{"a":"needle"}');
		await search(m, 'needle');
		await search(m, '');
		expect(m.el('body-out').querySelectorAll('mark').length).toBe(0);
		expect(m.el('body-out').textContent).toContain('needle');
		expect(m.el('res-count').textContent).toBe('');
	});

	test('copy body and copy headers post the clipboard text', () => {
		const m = mount();
		respond(m, '{"a":1}', { headers: { 'content-type': 'application/json', 'x-extra': 'v' } });
		m.posted.length = 0;
		m.el('copy-body').click();
		m.el('copy-hdrs').click();
		const copies = m.posted.filter((p) => p.type === 'copy').map((p) => p.text);
		expect(copies[0]).toBe('{\n  "a": 1\n}');
		expect(copies[1]).toContain('content-type: application/json');
		expect(copies[1]).toContain('x-extra: v');
	});

	test('save posts the body and a suggested file name', () => {
		const m = mount();
		respond(m, '{"a":1}');
		m.posted.length = 0;
		m.el('save-body').click();
		expect(m.posted.find((p) => p.type === 'saveResponse')).toEqual({ type: 'saveResponse', body: '{"a":1}', name: 'response.json' });
	});

	test('save suggests the right extension per content type', async () => {
		const cases: [string, string][] = [
			['application/json', 'response.json'],
			['text/html', 'response.html'],
			['application/xml', 'response.xml'],
			['text/plain', 'response.txt'],
			['', 'response.txt'],
		];
		for (const [type, expected] of cases) {
			const m = mount();
			respond(m, 'x', { headers: { 'content-type': type } });
			m.posted.length = 0;
			m.el('save-body').click();
			expect(m.posted.find((p) => p.type === 'saveResponse').name).toBe(expected);
		}
	});

	test('an error keeps the previous response on screen and adds a recovery hint', () => {
		const m = mount();
		respond(m, '{"a":1}');
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'Request timed out after 30000ms' } });
		// the old body is still there (dimmed) so it can still be copied
		expect(m.el('body-out').textContent).toContain('"a": 1');
		expect(m.el('stale-banner').hidden).toBe(false);
		expect(m.el('status').textContent).toContain('timed out');
		expect(m.el('status').textContent).toContain('retry');
		m.posted.length = 0;
		m.el('copy-body').click();
		expect(m.posted.find((p) => p.type === 'copy')?.text).toContain('"a": 1');
	});

	test('an error with no previous response says what to do next', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'Invalid URL: "x" — must start with http:// or https://' } });
		expect(m.el('status').textContent).toContain('fix the method/URL');
		expect(m.el('stale-banner').hidden).toBe(true);
	});
});

describe('scripts tab', () => {
	const current = (m: Mounted) => {
		m.posted.length = 0;
		m.el('save').click();
		return m.posted.find((p) => p.type === 'save')?.request;
	};

	test('scripts travel with the request, and blank ones are omitted', () => {
		const m = mount();
		expect(current(m).preRequest).toBeUndefined();
		m.el('pre-script').value = 'request.headers.X = "1";';
		m.el('test-script').value = 'expect(1).to.equal(1);';
		const request = current(m);
		expect(request.preRequest).toBe('request.headers.X = "1";');
		expect(request.test).toBe('expect(1).to.equal(1);');
	});

	test('loading a saved request restores both scripts', () => {
		const m = mount();
		m.message({
			type: 'load',
			request: { method: 'GET', url: 'https://x.test', preRequest: 'vars.a = "1";', test: 'expect(true).to.be.true;' },
		});
		expect(m.el('pre-script').value).toBe('vars.a = "1";');
		expect(m.el('test-script').value).toBe('expect(true).to.be.true;');
	});

	test('loading a request without scripts clears the previous ones', () => {
		const m = mount();
		m.el('pre-script').value = 'old';
		m.el('test-script').value = 'old';
		m.message({ type: 'load', request: { method: 'GET', url: 'https://x.test' } });
		expect(m.el('pre-script').value).toBe('');
		expect(m.el('test-script').value).toBe('');
	});

	test('passing assertions show a green count', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 },
			script: { logs: [], assertions: [{ name: 'a', passed: true }, { name: 'b', passed: true }] },
		});
		expect(m.el('script-results').textContent).toContain('2 assertions passed');
		expect(m.el('script-results').querySelector('.badge')!.className).toContain('ok');
	});

	test('failures show a red count and the failing assertion', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 },
			script: { logs: [], assertions: [{ name: 'expect(response.status).to.equal(201)', passed: false, message: '200 !== 201' }] },
		});
		const text = m.el('script-results').textContent;
		expect(text).toContain('1 of 1 assertions failed');
		expect(text).toContain('expect(response.status).to.equal(201)');
		expect(text).toContain('200 !== 201');
	});

	test('a script error is shown even when there are no assertions', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 },
			script: { logs: [], assertions: [], error: 'Unexpected identifier' },
		});
		expect(m.el('script-results').textContent).toContain('Script error');
		expect(m.el('script-results').textContent).toContain('Unexpected identifier');
	});

	test('logs are collapsed behind a details element', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 },
			script: { logs: ['one', 'two'], assertions: [] },
		});
		const details = m.el('script-results').querySelector('details')!;
		expect(details.textContent).toContain('logs (2)');
		expect(details.textContent).toContain('one');
	});

	test('a response without script results clears the strip', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 },
			script: { logs: [], assertions: [{ name: 'a', passed: true }] },
		});
		expect(m.el('script-results').textContent).not.toBe('');
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'x' } });
		expect(m.el('script-results').textContent).toBe('');
	});
});

describe('socket tab', () => {
	test('connect posts mode and url, then waits for the host to say open', () => {
		const m = mount();
		m.el('socket-url').value = 'wss://api.test/live';
		m.posted.length = 0;
		m.el('socket-toggle').click();
		expect(m.posted.find((p) => p.type === 'socketConnect')).toEqual({ type: 'socketConnect', mode: 'ws', url: 'wss://api.test/live' });
		// a connect in flight stays abortable: the button reads Cancel, not a disabled "Connecting…"
		expect(m.el('socket-toggle').textContent).toBe('Cancel');
		expect(m.el('socket-toggle').disabled).toBe(false);
		expect(m.el('socket-send-row').hidden).toBe(true);
		m.message({ type: 'socketState', state: 'closed', error: 'refused' });
		expect(m.el('socket-toggle').textContent).toBe('Connect');
	});

	test('an empty url does not connect', () => {
		const m = mount();
		m.posted.length = 0;
		m.el('socket-url').value = '   ';
		m.el('socket-toggle').click();
		expect(m.posted.some((p) => p.type === 'socketConnect')).toBe(false);
	});

	test('open state flips the button and reveals the send row for websockets', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		expect(m.el('socket-toggle').textContent).toBe('Disconnect');
		expect(m.el('socket-send-row').hidden).toBe(false);
		expect(m.el('socket-log').textContent).toContain('connected');
	});

	test('sse never shows the send row', () => {
		const m = mount();
		m.el('socket-mode').value = 'sse';
		m.message({ type: 'socketState', state: 'open' });
		expect(m.el('socket-send-row').hidden).toBe(true);
	});

	test('disconnect posts socketClose', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		m.posted.length = 0;
		m.el('socket-toggle').click();
		expect(m.posted).toEqual([{ type: 'socketClose' }]);
		expect(m.el('socket-toggle').textContent).toBe('Connect');
	});

	test('incoming and outgoing messages are logged with direction', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		m.message({ type: 'socketMessage', direction: 'in', text: 'hello' });
		m.el('socket-message').value = 'ping';
		m.el('socket-send').click();
		const log = m.el('socket-log').textContent;
		expect(log).toContain('← hello');
		expect(log).toContain('→ ping');
		expect(m.posted.find((p) => p.type === 'socketSend')).toEqual({ type: 'socketSend', text: 'ping' });
		expect(m.el('socket-message').value).toBe('');
	});

	test('sending while closed posts nothing', () => {
		const m = mount();
		m.el('socket-message').value = 'nope';
		m.posted.length = 0;
		m.el('socket-send').click();
		expect(m.posted.some((p) => p.type === 'socketSend')).toBe(false);
	});

	test('an error is shown and the socket is marked closed', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		m.message({ type: 'socketState', state: 'closed', error: 'connection refused' });
		expect(m.el('socket-log').textContent).toContain('connection refused');
		expect(m.el('socket-toggle').textContent).toBe('Connect');
	});

	test('connecting again clears the previous log', () => {
		const m = mount();
		m.message({ type: 'socketMessage', direction: 'in', text: 'old' });
		m.el('socket-url').value = 'ws://x';
		m.el('socket-toggle').click();
		expect(m.el('socket-log').textContent).toBe('');
	});
});

describe('polish round: states, a11y, layout', () => {
	const respond = (m: Mounted, body: string, extra: any = {}) =>
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body, sentUrl: '', timeMs: 12, ttfbMs: 2, size: 7, ...extra },
		});

	test('a failed request keeps the old body and says it is the previous one', () => {
		const m = mount();
		respond(m, '{"a":1}');
		expect(m.el('stale-banner').hidden).toBe(true);
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'boom' } });
		expect(m.el('stale-banner').hidden).toBe(false);
		expect(m.el('body-out').textContent).toContain('"a": 1');
		// and it clears on the next success
		respond(m, '{"b":2}');
		expect(m.el('stale-banner').hidden).toBe(true);
	});

	test('sending shows a progress bar and an aria-busy send button', () => {
		const m = mount();
		m.posted.length = 0;
		m.el('url').value = 'https://x.test';
		m.el('send').click();
		expect(m.el('send-progress').hidden).toBe(false);
		expect(m.el('send').getAttribute('aria-busy')).toBe('true');
		respond(m, '{}');
		expect(m.el('send-progress').hidden).toBe(true);
		expect(m.el('send').getAttribute('aria-busy')).toBeNull();
	});

	test('cancel is a neutral icon, not a destructive one', () => {
		const m = mount();
		expect(m.el('cancel').className).toBe('icon');
	});

	test('tabs follow the roving-tabindex model and react to arrow keys', () => {
		const m = mount();
		const tabs = [...m.doc.querySelectorAll('.tab[data-pane]')] as any[];
		expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
		expect(tabs.every((t) => t.getAttribute('aria-controls'))).toBe(true);
		tabs[0].focus();
		tabs[0].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(tabs[1].classList.contains('active')).toBe(true);
		expect(tabs[1].tabIndex).toBe(0);
		expect(tabs[0].tabIndex).toBe(-1);
	});

	test('End and Home jump to the last and first tab', () => {
		const m = mount();
		const tabs = [...m.doc.querySelectorAll('.tab[data-pane]')] as any[];
		tabs[0].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		expect(tabs[tabs.length - 1].classList.contains('active')).toBe(true);
		tabs[tabs.length - 1].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		expect(tabs[0].classList.contains('active')).toBe(true);
	});

	test('the splitter reports the rendered pane height and remembers arrow-key resizing', () => {
		const m = mount();
		const handle = m.el('splitter');
		expect(handle.getAttribute('role')).toBe('separator');
		expect(handle.hasAttribute('aria-valuenow')).toBe(true);
		expect(handle.getAttribute('aria-valuetext')).toContain('pixels');
		// happy-dom has no layout, so the height reads 0; the important part is that the drag/keys
		// write --composer-max and the value follows the ceiling, not a hardcoded 420
		handle.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		// 0 (no layout in happy-dom) + 16 px step, clamped to the 120 px floor
		expect(m.doc.documentElement.style.getPropertyValue('--composer-max')).toBe('120px');
	});

	test('the prettify toggle only exists for JSON bodies', () => {
		const m = mount();
		m.setType('json');
		expect(m.el('pretty-wrap').hidden).toBe(false);
		m.setType('text');
		expect(m.el('pretty-wrap').hidden).toBe(true);
	});

	test('the first failing assertion is readable on the status line', () => {
		const m = mount();
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0 },
			script: { logs: [], assertions: [{ name: 'expect(response.status).to.equal(201)', passed: false, message: 'expected 200 to equal 201' }] },
		});
		expect(m.el('status').textContent).toContain('1 failed');
		expect(m.el('status').textContent).toContain('expected 200 to equal 201');
	});

	test('a socket that closed offers a reconnect and says so', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		expect(m.el('socket-reconnect').hidden).toBe(true);
		m.message({ type: 'socketState', state: 'closed', error: 'reset' });
		expect(m.el('socket-reconnect').hidden).toBe(false);
		// the failure reason is announced, not only written to the (silent) log
		expect(m.el('socket-state').textContent).toBe('connection failed');
	});
});

describe('polish round: menu keyboard model', () => {
	test('opening the menu focuses the first item, arrows rove, Escape returns focus', () => {
		const m = mount();
		m.el('more').click();
		const items = [...m.el('more-menu').querySelectorAll('[role="menuitem"]')] as any[];
		expect(m.el('more-menu').hidden).toBe(false);
		expect(m.doc.activeElement).toBe(items[0]);
		items[0].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(m.doc.activeElement).toBe(items[1]);
		items[1].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		expect(m.doc.activeElement).toBe(items[items.length - 1]);
		items[items.length - 1].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(m.doc.activeElement).toBe(items[0]);
		m.doc.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(m.el('more-menu').hidden).toBe(true);
		expect(m.doc.activeElement).toBe(m.el('more'));
	});
});

describe('polish round: response panes, cancel, hints', () => {
	const respond = (m: Mounted, extra: any = {}) =>
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{"a":1}', sentUrl: '', timeMs: 12, ttfbMs: 2, size: 7, ...extra },
		});

	test('a new response resets the pane to Body — never two visible panes', () => {
		const m = mount();
		respond(m);
		m.el('rtab-hdrs').click();
		expect(m.el('res-hdrs').hidden).toBe(false);
		respond(m);
		const visible = ['body-out', 'tree-out', 'res-hdrs'].filter((id) => !m.el(id).hidden);
		expect(visible).toEqual(['body-out']);
		expect(m.el('rtab-body').getAttribute('aria-selected')).toBe('true');
		expect(m.el('rtab-hdrs').getAttribute('aria-selected')).toBe('false');
	});

	test('a response tablist is a real tablist: only tabs inside, panes are tabpanels', () => {
		const m = mount();
		const list = m.doc.querySelector('.response-tabs')!;
		expect(list.getAttribute('role')).toBe('tablist');
		expect(list.querySelector('input')).toBeNull();
		for (const tab of [...list.querySelectorAll('[role="tab"]')]) {
			const target = m.doc.getElementById(tab.getAttribute('aria-controls')!);
			expect(target?.getAttribute('role')).toBe('tabpanel');
		}
		expect(m.el('rtab-body').tabIndex).toBe(0);
		expect(m.el('rtree-tab').tabIndex).toBe(-1);
	});

	test('pressing Cancel reports cancellation and captions the older body', () => {
		const m = mount();
		respond(m);
		m.el('url').value = 'https://x.test';
		m.el('send').click();
		m.el('cancel').click();
		expect(m.posted.some((p) => p.type === 'cancel')).toBe(true);
		expect(m.el('status').textContent).toContain('cancelled');
		expect(m.el('status').textContent).not.toContain('Failed');
		// the body on screen belongs to the earlier request, so it is captioned
		expect(m.el('stale-banner').hidden).toBe(false);
		expect(m.el('stale-banner').textContent).toContain('cancelled');
	});

	test('loading another request captions the previous response instead of silently inheriting it', () => {
		const m = mount();
		respond(m);
		expect(m.el('stale-banner').hidden).toBe(true);
		m.message({ type: 'load', request: { method: 'POST', url: 'https://other.test', headers: {}, body: { type: 'none' } } });
		expect(m.el('stale-banner').hidden).toBe(false);
		expect(m.el('stale-banner').textContent).toContain('loaded another request');
		// the status numbers belong to the request that produced them
		expect(m.el('status').hidden).toBe(true);
	});

	test('the splitter remembers its height: persist() merges instead of replacing the state', () => {
		const m = mount({ composerMax: 300, method: 'PUT' });
		m.el('url').value = 'https://x.test';
		m.el('url').dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.state().composerMax).toBe(300);
	});

	test('one Escape closes the menu and does not also cancel a request', () => {
		const m = mount();
		m.el('url').value = 'https://x.test';
		m.el('send').click();
		m.posted.length = 0;
		m.el('more').click();
		// real keydown events are cancelable, and preventDefault is what arbitrates the two handlers
		m.doc.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(m.el('more-menu').hidden).toBe(true);
		expect(m.posted.some((p) => p.type === 'cancel')).toBe(false);
	});

	test('choosing an environment does not mark the request dirty', () => {
		const m = mount();
		const env = m.el('env');
		env.value = 'prod';
		env.dispatchEvent(new m.win.Event('change', { bubbles: true }));
		expect(m.el('dirty-dot').hidden).toBe(true);
	});

	test('a first-run failure replaces the empty-state card', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'Invalid URL: "x"' } });
		expect(m.el('empty-state').hidden).toBe(true);
		expect(m.el('stale-banner').hidden).toBe(true);
	});

	test('an in-flight send is dimmed but still activatable, so a second send can supersede it', () => {
		const m = mount();
		m.el('url').value = 'https://x.test';
		m.el('send').click();
		expect(m.el('send').hidden).toBe(false);
		expect(m.el('send').disabled).toBe(false);
		expect(m.el('send').getAttribute('aria-disabled')).toBe('true');
		m.posted.length = 0;
		m.el('send').click();
		expect(m.posted.filter((p) => p.type === 'send')).toHaveLength(1);
	});

	test('find-in-body is disabled off the Body tab', () => {
		const m = mount();
		respond(m);
		expect(m.el('res-search').readOnly).toBe(false);
		m.el('rtab-hdrs').click();
		expect(m.el('res-search').readOnly).toBe(true);
		m.el('rtab-body').click();
		expect(m.el('res-search').readOnly).toBe(false);
	});

	test('a non-2xx response says what to do next', () => {
		const m = mount();
		respond(m, { status: 401, statusText: 'Unauthorized' });
		expect(m.el('status-detail').textContent).toContain('Auth tab');
		respond(m, { status: 500, statusText: 'Server Error' });
		expect(m.el('status-detail').textContent).toContain('retry');
	});

	test('the menu maps to real command ids', () => {
		const m = mount();
		m.posted.length = 0;
		m.el('more').click();
		(m.el('more-menu').querySelector('[data-action="new-collection"]') as any).click();
		(m.el('more').click(), m.el('more-menu').querySelector('[data-action="edit-envs"]'));
		m.el('more').click();
		(m.el('more-menu').querySelector('[data-action="edit-envs"]') as any).click();
		const commands = m.posted.filter((p) => p.type === 'command').map((p) => p.command);
		expect(commands).toEqual(['asterisk.newCollection', 'asterisk.envs.edit']);
	});
});

describe('polish round: dirty state is scoped to the request', () => {
	test('typing in the response search does not mark the request dirty', () => {
		const m = mount();
		m.el('dirty-dot').hidden = true;
		const search = m.el('res-search');
		search.value = 'x';
		search.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.el('dirty-dot').hidden).toBe(true);
	});
});

describe('polish round 5: contracts B found broken', () => {
	const respond = (m: Mounted, extra: any = {}) =>
		m.message({
			type: 'response',
			response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{"a":1}', sentUrl: '', timeMs: 12, ttfbMs: 2, size: 7, ...extra },
		});

	test('a clean socket close also offers Reconnect', () => {
		const m = mount();
		m.message({ type: 'socketState', state: 'open' });
		m.message({ type: 'socketState', state: 'closed', text: '— closed (1000)' });
		expect(m.el('socket-reconnect').hidden).toBe(false);
		expect(m.el('socket-state').textContent).toBe('disconnected');
	});

	test('arrow keys skip the Tree tab when the body is not JSON', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'hello', sentUrl: '', timeMs: 5, ttfbMs: 1, size: 5 } });
		expect(m.el('rtree-tab').hidden).toBe(true);
		m.el('rtab-body').dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(m.el('rtab-hdrs').getAttribute('aria-selected')).toBe('true');
	});

	test('find-in-body is re-enabled by a response even after leaving Body', () => {
		const m = mount();
		respond(m);
		m.el('rtab-hdrs').click();
		expect(m.el('res-search').readOnly).toBe(true);
		respond(m);
		expect(m.el('res-search').readOnly).toBe(false);
	});

	test('search matches raw characters, not HTML entities', () => {
		const m = mount();
		respond(m, { headers: { 'content-type': 'text/html' }, body: '<p>a & b</p>' });
		m.el('res-search').value = 'amp';
		m.el('res-search').dispatchEvent(new m.win.Event('input', { bubbles: true }));
		return new Promise<void>((resolve) => setTimeout(() => {
			expect(m.el('res-count').textContent).toBe('no matches');
			resolve();
		}, 200));
	});

	test('the socket tab captions the older HTTP response', () => {
		const m = mount();
		respond(m);
		expect(m.el('context-line').hidden).toBe(true);
		m.el('tab-socket').click();
		expect(m.el('context-line').hidden).toBe(false);
	});

	test('the separator reports the request pane height, not the response offset', async () => {
		const m = mount();
		// give the pane a real height: the announced value must equal it, not the response offset
		const pane = m.el('request-pane');
		pane.getBoundingClientRect = () => ({ height: 231, top: 0, left: 0, right: 0, bottom: 231, width: 0, x: 0, y: 0, toJSON: () => ({}) });
		m.el('splitter').dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		// the announced value tracks the rendered pane (the stub never grows), while the request to
		// grow by one step lands in the CSS variable
		expect(m.el('splitter').getAttribute('aria-valuenow')).toBe('231');
		expect(m.el('splitter').getAttribute('aria-valuetext')).toContain('231 pixels');
		expect(m.doc.documentElement.style.getPropertyValue('--composer-max')).toBe('247px');
	});

	test('reduced motion is asked to stop animations on pseudo-elements too', async () => {
		const css = await Bun.file(new URL('../src/webview/main.html', import.meta.url)).text();
		expect(css).toContain('*, *::before, *::after { transition: none !important; animation: none !important; }');
	});

	test('a pre-request failure shows up in the Scripts tab, not only on the strip', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'Pre-request script: boom' } });
		expect(m.el('script-results').textContent).toContain('Pre-request script: boom');
	});

	test('TLS and DNS failures get different next steps', () => {
		const m = mount();
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'fetch failed (ENOTFOUND)' } });
		expect(m.el('status').textContent).toContain('does not resolve');
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'fetch failed (ECONNREFUSED)' } });
		expect(m.el('status').textContent).toContain('nothing is listening');
		m.message({ type: 'response', response: { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 1, ttfbMs: 1, size: 0, error: 'fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)' } });
		expect(m.el('status').textContent).toContain('certificate');
	});

	test('the dirty flag is mirrored to the host so a load can ask first', () => {
		const m = mount();
		m.posted.length = 0;
		const url = m.el('url');
		url.value = 'https://changed.test';
		url.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.posted.some((p) => p.type === 'dirty' && p.value === true)).toBe(true);
	});
});

describe('polish round 6: regressions found by review', () => {
	test('restoring saved state does not throw, posts ready, and reports dirty', () => {
		const posted: any[] = [];
		const win = new Window({ url: 'https://asterisk.test/' });
		win.document.write(markup);
		const state: any = { filePath: 'F:/coll/req.json', method: 'POST', url: 'https://x.test', headers: [['A', 'b']] };
		expect(() => new Function('document', 'window', 'acquireVsCodeApi', script)(
			win.document, win, () => ({ postMessage: (m: any) => posted.push(m), getState: () => state, setState: (s: any) => Object.assign(state, s) })
		)).not.toThrow();
		expect(posted.some((p) => p.type === 'ready')).toBe(true);
		expect(posted.some((p) => p.type === 'restorePath')).toBe(true);
		// restored edits have not been written to disk
		expect(posted.some((p) => p.type === 'dirty' && p.value === true)).toBe(true);
		expect((win.document.getElementById('header-count') as any).textContent).toBe('1');
	});

	test('the host decides cleanliness: an identity with dirty=true keeps the dot', () => {
		const m = mount();
		m.el('dirty-dot').hidden = true;
		m.message({ type: 'identity', name: 'a', path: 'F:/a.json', dirty: true });
		expect(m.el('dirty-dot').hidden).toBe(false);
		m.message({ type: 'identity', name: 'a', path: 'F:/a.json', dirty: false });
		expect(m.el('dirty-dot').hidden).toBe(true);
	});

	test('deleting a header refreshes the count', () => {
		const m = mount();
		m.el('add-header').click();
		const rows = m.el('headers').children;
		for (const [i, row] of [...rows].entries()) {
			(row.querySelector('.hk') as any).value = 'H' + i;
			(row.querySelector('.hv') as any).value = 'v';
			(row.querySelector('.hv') as any).dispatchEvent(new m.win.Event('input', { bubbles: true }));
		}
		expect(m.el('header-count').textContent).toBe('2');
		(rows[0].querySelector('.hdel') as any).click();
		expect(m.el('header-count').textContent).toBe('1');
	});

	test('duplicate header names are called out instead of silently collapsing', () => {
		const m = mount();
		const rows = m.el('headers').children;
		(rows[0].querySelector('.hk') as any).value = 'Accept';
		(rows[0].querySelector('.hv') as any).value = 'a';
		m.el('add-header').click();
		const second = m.el('headers').children[1];
		(second.querySelector('.hk') as any).value = 'accept';
		(second.querySelector('.hv') as any).value = 'b';
		(second.querySelector('.hv') as any).dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.el('header-warn').hidden).toBe(false);
	});

	test('a hung socket connect can be cancelled, not disabled', () => {
		const m = mount();
		m.el('socket-url').value = 'wss://api.test/live';
		m.el('socket-toggle').click();
		expect(m.el('socket-toggle').textContent).toBe('Cancel');
		m.posted.length = 0;
		m.el('socket-toggle').click();
		expect(m.posted.some((p) => p.type === 'socketClose')).toBe(true);
	});

	test('loading a request mid-send cancels the send and clears the busy state', () => {
		const m = mount();
		m.el('url').value = 'https://x.test';
		m.el('send').click();
		m.posted.length = 0;
		m.message({ type: 'load', request: { method: 'GET', url: 'https://other.test', headers: {}, body: { type: 'none' } } });
		expect(m.posted.some((p) => p.type === 'cancel')).toBe(true);
		expect(m.el('send').getAttribute('aria-busy')).toBeNull();
		expect(m.el('cancel').hidden).toBe(true);
	});

	test('the cancellation copy is neutral, not an error', () => {
		const m = mount();
		m.el('url').value = 'https://x.test';
		m.el('send').click();
		m.el('cancel').click();
		expect(m.el('status').querySelector('.metric')!.className).not.toContain('fail');
	});
});
