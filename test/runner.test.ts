import { describe, expect, test } from 'bun:test';
import { parseCsv, runItems, type RunItem } from '../src/runner';
import type { HttpResponse } from '../src/http';

const ok = (status = 200, body = '{"ok":true}'): HttpResponse => ({
	ok: status < 400,
	status,
	statusText: status === 200 ? 'OK' : 'Error',
	headers: { 'content-type': 'application/json' },
	body,
	sentUrl: '',
	timeMs: 5,
	ttfbMs: 2,
	size: body.length,
});

const item = (name: string, extra: Partial<RunItem> = {}): RunItem => ({
	name,
	request: { method: 'GET', url: `https://api.test/${name}` },
	...extra,
});

describe('parseCsv', () => {
	test('header + rows', () => {
		expect(parseCsv('id,name\n1,ada\n2,grace')).toEqual([
			{ id: '1', name: 'ada' },
			{ id: '2', name: 'grace' },
		]);
	});

	test('CRLF and a trailing newline', () => {
		expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([{ a: '1', b: '2' }]);
	});

	test('quoted fields with commas, quotes and newlines', () => {
		expect(parseCsv('a,b\n"x,y","he said ""hi""\nnext"')).toEqual([{ a: 'x,y', b: 'he said "hi"\nnext' }]);
	});

	test('blank lines before the header are skipped, blank body rows are kept', () => {
		expect(parseCsv('\n\na\n1\n')).toEqual([{ a: '1' }]);
		expect(parseCsv('a\n1\n\n   \n2\n')).toEqual([{ a: '1' }, { a: '' }, { a: '   ' }, { a: '2' }]);
	});

	test('missing values become empty strings', () => {
		expect(parseCsv('a,b\n1')).toEqual([{ a: '1', b: '' }]);
	});

	test('headers are trimmed and empty headers dropped', () => {
		expect(parseCsv(' a , ,c\n1,2,3')).toEqual([{ a: '1', c: '3' }]);
	});

	test('empty input is no rows', () => {
		expect(parseCsv('')).toEqual([]);
		expect(parseCsv('  \n  ')).toEqual([]);
	});

	test('unicode values survive', () => {
		expect(parseCsv('name\n"héllo 世界"')).toEqual([{ name: 'héllo 世界' }]);
	});

	test('a lone quote in the middle of a field is literal', () => {
		expect(parseCsv('a\nab"cd')).toEqual([{ a: 'ab"cd' }]);
	});
});

describe('runItems', () => {
	test('runs every item in order and reports each row', async () => {
		const seen: string[] = [];
		const rows: string[] = [];
		const results = await runItems([item('one'), item('two')], {
			send: async (req) => {
				seen.push(req.url);
				return ok();
			},
			onRow: (row) => rows.push(row.name),
		});
		expect(seen).toEqual(['https://api.test/one', 'https://api.test/two']);
		expect(rows).toEqual(['one', 'two']);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.passed)).toBe(true);
	});

	test('a transport error is a failed row, not a throw', async () => {
		const results = await runItems([item('boom')], {
			send: async () => ({ ...ok(0, ''), ok: false, status: 0, error: 'network down' }),
		});
		expect(results[0].passed).toBe(false);
		expect(results[0].error).toBe('network down');
	});

	test('a thrown send is caught into the row', async () => {
		const results = await runItems([item('throws')], {
			send: async () => {
				throw new Error('kaput');
			},
		});
		expect(results[0].passed).toBe(false);
		expect(results[0].error).toBe('kaput');
	});

	test('an HTTP error status fails the row', async () => {
		const results = await runItems([item('bad')], { send: async () => ok(500) });
		expect(results[0].status).toBe(500);
		expect(results[0].passed).toBe(false);
	});

	test('stopOnFailure halts the whole run', async () => {
		const seen: string[] = [];
		const results = await runItems([item('a'), item('b'), item('c')], {
			send: async (req) => {
				seen.push(req.url);
				return req.url.endsWith('b') ? ok(500) : ok();
			},
			stopOnFailure: true,
		});
		expect(seen).toHaveLength(2);
		expect(results.map((r) => r.name)).toEqual(['a', 'b']);
	});

	test('without stopOnFailure everything still runs', async () => {
		const results = await runItems([item('a'), item('b')], { send: async () => ok(500) });
		expect(results).toHaveLength(2);
	});

	test('a failing assertion fails the row but keeps the response', async () => {
		const results = await runItems([item('assert', { test: 'expect(response.status).to.equal(201);' })], { send: async () => ok(200) });
		expect(results[0].status).toBe(200);
		expect(results[0].passed).toBe(false);
		expect(results[0].assertions[0].passed).toBe(false);
	});

	test('passing assertions keep the row green', async () => {
		const results = await runItems([item('assert', { test: 'expect(response.status).to.equal(200);' })], { send: async () => ok(200) });
		expect(results[0].passed).toBe(true);
		expect(results[0].assertions).toHaveLength(1);
	});

	test('a broken test script fails the row with the error', async () => {
		const results = await runItems([item('bad-script', { test: 'nope(' })], { send: async () => ok() });
		expect(results[0].passed).toBe(false);
		expect(results[0].error).toBeTruthy();
	});

	test('a pre-request script can rewrite the request before sending', async () => {
		const seen: string[] = [];
		await runItems([item('pre', { preRequest: 'request.url = request.url + "?scripted=1";' })], {
			send: async (req) => {
				seen.push(req.url);
				return ok();
			},
		});
		expect(seen[0]).toBe('https://api.test/pre?scripted=1');
	});

	test('a broken pre-request script skips the send', async () => {
		let sent = 0;
		const results = await runItems([item('bad-pre', { preRequest: 'not js(' })], {
			send: async () => {
				sent++;
				return ok();
			},
		});
		expect(sent).toBe(0);
		expect(results[0].passed).toBe(false);
		expect(results[0].error).toContain('Pre-request script');
	});

	test('CSV data runs one full pass per row with merged vars', async () => {
		const seen: string[] = [];
		const results = await runItems([item('users')], {
			vars: { base: 'https://api.test' },
			data: [{ id: '1' }, { id: '2' }],
			send: async (req, vars) => {
				seen.push(`${vars.base}|${vars.id}`);
				return ok();
			},
		});
		expect(seen).toEqual(['https://api.test|1', 'https://api.test|2']);
		expect(results.map((r) => r.iteration)).toEqual([1, 2]);
		expect(results[1].data).toEqual({ id: '2' });
	});

	test('iterations are capped', async () => {
		const results = await runItems([item('a')], {
			data: Array.from({ length: 50 }, (_, i) => ({ i: String(i) })),
			maxIterations: 3,
			send: async () => ok(),
		});
		expect(results).toHaveLength(3);
	});

	test('stopOnFailure inside CSV iterations stops the whole matrix', async () => {
		const results = await runItems([item('a'), item('b')], {
			data: [{ id: '1' }, { id: '2' }],
			stopOnFailure: true,
			send: async (_req, vars) => (vars.id === '2' ? ok(500) : ok()),
		});
		expect(results).toHaveLength(3);
		expect(results.at(-1)!.passed).toBe(false);
	});
});

describe('pre-request vars reach the rest of the run', () => {
	test('the mutated value is passed to the send instead of the caller vars', async () => {
		const seen: string[] = [];
		await runItems([{ name: 'swap', request: { method: 'GET', url: 'https://api.test/{{token}}' }, preRequest: "vars.token = 'new';" }], {
			vars: { token: 'old' },
			send: async (req, vars) => {
				seen.push(req.url.replace('{{token}}', vars.token ?? ''));
				return ok();
			},
		});
		expect(seen).toEqual(['https://api.test/new']);
	});

	test('a second item in the same iteration sees the write', async () => {
		const seen: string[] = [];
		await runItems([item('one', { preRequest: "vars.token = 'new';" }), item('two')], {
			vars: { token: 'old' },
			send: async (req, vars) => {
				seen.push(`${req.url} ${vars.token}`);
				return ok();
			},
		});
		expect(seen).toEqual(['https://api.test/one new', 'https://api.test/two new']);
	});

	test('the caller vars object is never mutated', async () => {
		const vars = { token: 'old' };
		await runItems([item('one', { preRequest: "vars.token = 'new'; vars.extra = 'x';" })], { vars, send: async () => ok() });
		expect(vars).toEqual({ token: 'old' });
	});

	test('a pre-request write does not leak into the next CSV iteration', async () => {
		const seen: string[] = [];
		await runItems([item('one', { preRequest: "vars.token = vars.token + '!';" })], {
			vars: { token: 'orig' },
			data: [{ id: '1' }, { id: '2' }],
			send: async (_req, vars) => {
				seen.push(vars.token ?? '');
				return ok();
			},
		});
		expect(seen).toEqual(['orig!', 'orig!']);
	});
});

describe('row reporting is best-effort', () => {
	test('a throwing onRow does not abort the run', async () => {
		const delivered: string[] = [];
		const results = await runItems([item('a'), item('b')], {
			send: async () => ok(),
			onRow: (row) => {
				if (row.name === 'a') {throw new Error('ui blew up');}
				delivered.push(row.name);
			},
		});
		expect(results.map((r) => r.name)).toEqual(['a', 'b']);
		expect(delivered).toEqual(['b']);
	});
});

describe('hardening found in audit', () => {
	test('a blank line between two data rows is a row with one empty field', () => {
		expect(parseCsv('name\r\n\r\nbob\r\n')).toEqual([{ name: '' }, { name: 'bob' }]);
		expect(parseCsv('name\nada\n\nbob')).toEqual([{ name: 'ada' }, { name: '' }, { name: 'bob' }]);
	});

	test('a fully blank file still yields no rows', () => {
		expect(parseCsv('')).toEqual([]);
		expect(parseCsv('  \n  ')).toEqual([]);
		expect(parseCsv('\r\n\r\n')).toEqual([]);
	});

	test('a BOM before the first header is stripped', () => {
		expect(parseCsv('\uFEFF"id",name\n1,ada')).toEqual([{ id: '1', name: 'ada' }]);
	});

	test('a header-only CSV has no rows', () => {
		expect(parseCsv('id,name\n')).toEqual([]);
	});

	test('an escaped quote at the very end of the input survives', () => {
		expect(parseCsv('a\n"x"""')).toEqual([{ a: 'x"' }]);
	});

	test('a quoted field containing CRLF keeps it', () => {
		expect(parseCsv('a\n"one\r\ntwo"')).toEqual([{ a: 'one\r\ntwo' }]);
	});
});
