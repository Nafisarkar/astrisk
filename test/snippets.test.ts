import { describe, expect, test } from 'bun:test';
import { fromCurl, toCurl } from '../src/curl';
import { snippet } from '../src/snippets';
import type { SnippetLang } from '../src/snippets';
import type { SavedRequest } from '../src/store';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as FunctionConstructor;
const BASE = 'https://api.example.com';

const get: SavedRequest = { method: 'GET', url: `${BASE}/users` };

const noBody: SavedRequest = { method: 'DELETE', url: `${BASE}/users/1`, body: { type: 'none' } };

const postJson: SavedRequest = {
	method: 'POST',
	url: `${BASE}/users`,
	headers: { 'Content-Type': 'application/json' },
	body: { type: 'raw', format: 'json', content: '{"name":"Ada","tags":["a","b"]}' },
};

const postText: SavedRequest = {
	method: 'POST',
	url: `${BASE}/echo`,
	body: { type: 'raw', format: 'text', content: 'plain words' },
};

const postXml: SavedRequest = {
	method: 'POST',
	url: `${BASE}/xml`,
	body: { type: 'raw', format: 'xml', content: '<a x="1">t</a>' },
};

const postHtml: SavedRequest = {
	method: 'POST',
	url: `${BASE}/html`,
	body: { type: 'raw', format: 'html', content: '<!doctype html><p>hi</p>' },
};

const postForm: SavedRequest = {
	method: 'POST',
	url: `${BASE}/login`,
	body: { type: 'urlencoded', fields: [{ key: 'user', value: 'ada' }, { key: 'note', value: 'два слова' }] },
};

const multipart: SavedRequest = {
	method: 'POST',
	url: `${BASE}/upload`,
	body: { type: 'multipart', fields: [{ key: 'note', value: 'hi' }], files: [{ key: 'upload', path: '/tmp/my file.txt' }] },
};

const multipartFieldsOnly: SavedRequest = {
	method: 'POST',
	url: `${BASE}/upload`,
	body: { type: 'multipart', fields: [{ key: 'note', value: 'hi' }] },
};

const binary: SavedRequest = {
	method: 'PUT',
	url: `${BASE}/blob`,
	body: { type: 'binary', path: '/tmp/a b.bin' },
};

const basicAuth: SavedRequest = { method: 'GET', url: `${BASE}/me`, auth: { type: 'basic', username: 'ada', password: 'p:a:ss' } };

/** Everything an escaper can trip over, in one request. */
const hostile: SavedRequest = {
	method: 'POST',
	url: `${BASE}/q?a="b"&c=\\d`,
	headers: {
		'X-Quote': 'he said "hi" \\ done',
		'X-Dollar': '${notAVar} `tick` $HOME',
		'X-Uni': 'héllo 😀 世界',
	},
	body: {
		type: 'raw',
		format: 'text',
		content: 'quote " apostrophe \' backslash \\ dollar $ tick ` brace ${x} tab\there\r\nnext line 😀',
	},
};

const ALL: [string, SavedRequest][] = [
	['get', get],
	['none', noBody],
	['json', postJson],
	['text', postText],
	['xml', postXml],
	['html', postHtml],
	['urlencoded', postForm],
	['multipart', multipart],
	['multipart-fields', multipartFieldsOnly],
	['binary', binary],
	['auth', basicAuth],
	['hostile', hostile],
];

const LANGS: SnippetLang[] = ['curl', 'fetch', 'python', 'go'];

const parses = (code: string): boolean => {
	try {
		new AsyncFunction(code);
		return true;
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------------------------------------
// curl delegates
// ---------------------------------------------------------------------------------------------

describe('snippet: curl delegates to toCurl', () => {
	test('equals toCurl for a plain GET', () => {
		expect(snippet('curl', get)).toBe(toCurl(get));
	});

	test('equals toCurl for a JSON POST', () => {
		expect(snippet('curl', postJson)).toBe(toCurl(postJson));
	});

	test('equals toCurl for multipart', () => {
		expect(snippet('curl', multipart)).toBe(toCurl(multipart));
	});

	test('equals toCurl for hostile input', () => {
		expect(snippet('curl', hostile)).toBe(toCurl(hostile));
	});

	test('equals toCurl for an auth request', () => {
		expect(snippet('curl', basicAuth)).toBe(toCurl(basicAuth));
	});

	test('round-trips a plain GET through fromCurl', () => {
		const back = fromCurl(snippet('curl', get));
		expect(back.method).toBe('GET');
		expect(back.url).toBe(get.url);
		expect(back.body).toBeUndefined();
	});

	test('round-trips a JSON POST through fromCurl', () => {
		const back = fromCurl(snippet('curl', postJson));
		expect(back.method).toBe('POST');
		expect(back.url).toBe(postJson.url);
		expect(back.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(back.body).toEqual({ type: 'raw', format: 'json', content: '{"name":"Ada","tags":["a","b"]}' });
	});

	test('round-trips a urlencoded body through fromCurl', () => {
		const back = fromCurl(snippet('curl', postForm));
		expect(back.body).toEqual(postForm.body as any);
	});

	test('round-trips a binary body through fromCurl', () => {
		const back = fromCurl(snippet('curl', binary));
		expect(back.method).toBe('PUT');
		expect(back.body).toEqual({ type: 'binary', path: '/tmp/a b.bin' });
	});

	test('round-trips basic auth through fromCurl', () => {
		const back = fromCurl(snippet('curl', basicAuth));
		expect(back.auth).toEqual({ type: 'basic', username: 'ada', password: 'p:a:ss' });
	});

	test('round-trips a hostile body through fromCurl', () => {
		const back = fromCurl(snippet('curl', hostile));
		expect(back.method).toBe('POST');
		expect(back.url).toBe(hostile.url);
		expect(back.body).toEqual(hostile.body as any);
	});
});

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

describe('snippet: fetch parses', () => {
	for (const [name, request] of ALL) {
		test(`parses as a JS function body (${name})`, () => {
			expect(parses(snippet('fetch', request))).toBe(true);
		});
	}

	test('opens with a fetch call on the quoted URL', () => {
		expect(snippet('fetch', get)).toStartWith(`const res = await fetch("${BASE}/users", {`);
	});

	test('ends with the response read', () => {
		expect(snippet('fetch', get)).toEndWith('const text = await res.text();\n');
	});

	test('carries the method', () => {
		expect(snippet('fetch', postJson)).toContain('  method: "POST"');
	});

	test('inlines a raw body verbatim', () => {
		expect(snippet('fetch', postText)).toContain('  body: "plain words"');
	});

	test('adds the content type the engine would have sent', () => {
		expect(snippet('fetch', postJson)).toContain('"Content-Type": "application/json"');
		expect(snippet('fetch', postXml)).toContain('"Content-Type": "application/xml"');
		expect(snippet('fetch', postHtml)).toContain('"Content-Type": "text/html"');
		expect(snippet('fetch', postForm)).toContain('"Content-Type": "application/x-www-form-urlencoded"');
	});

	test('keeps a caller-set content type instead of adding a second one', () => {
		const request: SavedRequest = { ...postJson, headers: { 'content-type': 'application/vnd.api+json' } };
		const code = snippet('fetch', request);
		expect(code).toContain('"content-type": "application/vnd.api+json"');
		expect(code).not.toContain('"Content-Type": "application/json"');
	});

	test('renders urlencoded bodies through URLSearchParams', () => {
		const code = snippet('fetch', postForm);
		expect(code).toContain('body: new URLSearchParams({ "user": "ada", "note": "два слова" }).toString()');
	});

	test('omits the body and leaves a TODO for multipart files', () => {
		const code = snippet('fetch', multipart);
		expect(code).toContain('// TODO: attach /tmp/my file.txt manually');
		expect(code).not.toContain('body:');
	});

	test('leaves a TODO when a multipart body has no files', () => {
		expect(snippet('fetch', multipartFieldsOnly)).toContain('// TODO: send these fields as multipart FormData');
	});

	test('omits the body and leaves a TODO for binary', () => {
		const code = snippet('fetch', binary);
		expect(code).toContain('// TODO: attach /tmp/a b.bin manually');
		expect(code).not.toContain('body:');
	});

	test('emits no body at all for a body-less request', () => {
		expect(snippet('fetch', noBody)).not.toContain('body');
	});

	test('mentions auth it cannot apply', () => {
		const code = snippet('fetch', basicAuth);
		expect(code).toStartWith('// Authentication: "basic"');
		expect(parses(code)).toBe(true);
	});

	test('stays quiet when there is no auth', () => {
		expect(snippet('fetch', get)).not.toContain('Authentication:');
	});
});

// ---------------------------------------------------------------------------------------------
// python
// ---------------------------------------------------------------------------------------------

describe('snippet: python', () => {
	test('imports requests', () => {
		expect(snippet('python', get)).toStartWith('import requests\n');
	});

	test('uses requests.post for POST', () => {
		expect(snippet('python', postJson)).toContain(`response = requests.post("${BASE}/users"`);
	});

	test('uses requests.request for other methods so the shape is uniform', () => {
		expect(snippet('python', get)).toContain(`response = requests.request("GET", "${BASE}/users")`);
		expect(snippet('python', binary)).toContain('requests.request("PUT"');
	});

	test('prints the status code and the text', () => {
		const code = snippet('python', get);
		expect(code).toContain('print(response.status_code)');
		expect(code).toContain('print(response.text)');
	});

	test('renders headers as a dict', () => {
		expect(snippet('python', postJson)).toContain('headers={"Content-Type": "application/json"}');
	});

	test('uses json= for parseable JSON bodies', () => {
		expect(snippet('python', postJson)).toContain('json={"name":"Ada","tags":["a","b"]}');
	});

	test('converts JSON literals to Python instead of inlining true/false/null', () => {
		const request: SavedRequest = {
			method: 'POST',
			url: `${BASE}/flags`,
			body: { type: 'raw', format: 'json', content: '{"active":true,"x":null,"off":false}' },
		};
		const code = snippet('python', request);
		expect(code).toContain('json={"active":True,"x":None,"off":False}');

		// no bare JSON literal (outside a string) may survive in the inlined argument
		const arg = code.slice(code.indexOf('json=') + 'json='.length).split('\n')[0];
		const outsideStrings = arg.replace(/"(?:[^"\\]|\\.)*"/g, '""');
		expect(outsideStrings).not.toMatch(/\b(?:true|false|null)\b/);
	});

	test('leaves literal names alone when they sit inside a string', () => {
		const request: SavedRequest = {
			method: 'POST',
			url: `${BASE}/flags`,
			body: { type: 'raw', format: 'json', content: '{"text":"null or true"}' },
		};
		expect(snippet('python', request)).toContain('json={"text":"null or true"}');
	});

	test('uses data= for other raw text', () => {
		expect(snippet('python', postText)).toContain('data="plain words"');
	});

	test('uses a data dict for urlencoded bodies', () => {
		expect(snippet('python', postForm)).toContain('data={"user": "ada", "note": "два слова"}');
	});

	test('uses files= with open(..., "rb") for multipart', () => {
		const code = snippet('python', multipart);
		expect(code).toContain('files={"upload": open("/tmp/my file.txt", "rb")}');
		expect(code).toContain('data={"note": "hi"}');
	});

	test('flags a file-less multipart body instead of pretending', () => {
		expect(snippet('python', multipartFieldsOnly)).toContain('# TODO: send these fields as multipart');
	});

	test('uses data=open(...) for a binary body', () => {
		expect(snippet('python', binary)).toContain('data=open("/tmp/a b.bin", "rb")');
	});

	test('mentions auth it cannot apply', () => {
		expect(snippet('python', basicAuth)).toContain('# Authentication: "basic"');
	});

	test('stays quiet when there is no auth', () => {
		expect(snippet('python', get)).not.toContain('Authentication:');
	});

	test('emits no body argument for a body-less request', () => {
		const code = snippet('python', noBody);
		expect(code).not.toContain('data=');
		expect(code).not.toContain('json=');
	});
});

// ---------------------------------------------------------------------------------------------
// go
// ---------------------------------------------------------------------------------------------

describe('snippet: go', () => {
	test('is a complete program', () => {
		const code = snippet('go', get);
		expect(code).toStartWith('package main\n\nimport (');
		expect(code).toContain('func main() {');
		expect(code).toEndWith('}\n');
	});

	test('imports what the code actually uses', () => {
		const code = snippet('go', get);
		expect(code).toContain('\t"fmt"');
		expect(code).toContain('\t"io"');
		expect(code).toContain('\t"net/http"');
	});

	test('imports strings only when there is an inline body', () => {
		expect(snippet('go', postJson)).toContain('\t"strings"');
		expect(snippet('go', get)).not.toContain('"strings"');
	});

	test('reads a body with strings.NewReader', () => {
		expect(snippet('go', postJson)).toContain('strings.NewReader("{\\"name\\":\\"Ada\\",\\"tags\\":[\\"a\\",\\"b\\"]}")');
	});

	test('builds the urlencoded payload like the wire format', () => {
		expect(snippet('go', postForm)).toContain('strings.NewReader("user=ada&note=%D0%B4%D0%B2%D0%B0+%D1%81%D0%BB%D0%BE%D0%B2%D0%B0")');
	});

	test('passes nil for a body-less request', () => {
		expect(snippet('go', get)).toContain('http.NewRequest("GET", "https://api.example.com/users", nil)');
	});

	test('reads a file with os.ReadFile for a binary body', () => {
		const code = snippet('go', binary);
		expect(code).toContain('data, err := os.ReadFile("/tmp/a b.bin")');
		expect(code).toContain('bytes.NewReader(data)');
		expect(code).toContain('\t"bytes"');
		expect(code).toContain('\t"os"');
	});

	test('sets headers through req.Header.Set', () => {
		expect(snippet('go', postJson)).toContain('\treq.Header.Set("Content-Type", "application/json")');
	});

	test('sends through the default client and prints the response', () => {
		const code = snippet('go', get);
		expect(code).toContain('http.DefaultClient.Do(req)');
		expect(code).toContain('body, err := io.ReadAll(res.Body)');
		expect(code).toContain('fmt.Println(string(body))');
	});

	test('leaves a TODO for a multipart upload', () => {
		const code = snippet('go', multipart);
		expect(code).toContain('// TODO: attach /tmp/my file.txt manually');
		expect(code).toContain('mime/multipart');
		expect(code).toContain(', nil)');
	});

	test('indents its auth note inside main', () => {
		expect(snippet('go', basicAuth)).toContain('\t// Authentication: "basic"');
	});
});

// ---------------------------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------------------------

describe('snippet: escaping', () => {
	test('escapes double quotes in a fetch body', () => {
		expect(snippet('fetch', hostile)).toContain('quote \\" apostrophe');
	});

	test('escapes backslashes', () => {
		expect(snippet('fetch', hostile)).toContain('backslash \\\\');
	});

	test('writes newlines and CRLF as escapes', () => {
		const code = snippet('fetch', hostile);
		expect(code).toContain('\\r\\nnext line');
		expect(code).not.toContain('here\r\n');
	});

	test('writes tabs as escapes', () => {
		expect(snippet('fetch', hostile)).toContain('tab\\there');
	});

	test('leaves dollar and template characters inert', () => {
		const code = snippet('fetch', hostile);
		expect(code).toContain('${notAVar}');
		expect(code).toContain('brace ${x}');
		expect(parses(code)).toBe(true);
	});

	test('leaves unicode and emoji alone', () => {
		const code = snippet('fetch', hostile);
		expect(code).toContain('héllo 😀 世界');
		expect(code).toContain('next line 😀');
	});

	test('escapes quotes and backslashes in the URL', () => {
		expect(snippet('fetch', hostile)).toContain('/q?a=\\"b\\"&c=\\\\d');
	});

	test('escapes the same body for python and go', () => {
		expect(snippet('python', hostile)).toContain('quote \\" apostrophe');
		expect(snippet('go', hostile)).toContain('quote \\" apostrophe');
		expect(snippet('python', hostile)).toContain('tab\\there');
		expect(snippet('go', hostile)).toContain('\\r\\nnext line');
	});

	test('escapes quotes in header values', () => {
		expect(snippet('python', hostile)).toContain('"X-Quote": "he said \\"hi\\" \\\\ done"');
		expect(snippet('go', hostile)).toContain('req.Header.Set("X-Quote", "he said \\"hi\\" \\\\ done")');
	});

	test('handles a control character with a unicode escape', () => {
		const request: SavedRequest = { method: 'POST', url: `${BASE}/x`, body: { type: 'raw', format: 'text', content: 'a\u0000b' } };
		expect(snippet('fetch', request)).toContain('a\\u0000b');
		expect(parses(snippet('fetch', request))).toBe(true);
	});

	test('handles a 100 KB body without blowing up', () => {
		const content = `${'"\\'.repeat(50_000)}`;
		const request: SavedRequest = { method: 'POST', url: `${BASE}/big`, body: { type: 'raw', format: 'text', content } };
		const started = Date.now();
		const code = snippet('fetch', request);
		const elapsed = Date.now() - started;
		expect(code.length).toBeGreaterThan(content.length);
		expect(code.length).toBeLessThan(content.length * 3);
		expect(elapsed).toBeLessThan(2000);
		expect(parses(code)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------------------------

describe('snippet: invariants', () => {
	test('generated code ends with exactly one trailing newline', () => {
		for (const [name, request] of ALL) {
			for (const lang of ['fetch', 'python', 'go'] as SnippetLang[]) {
				const code = snippet(lang, request);
				expect(`${lang}/${name}:${code.endsWith('\n')}`).toBe(`${lang}/${name}:true`);
				expect(`${lang}/${name}:${code.endsWith('\n\n')}`).toBe(`${lang}/${name}:false`);
			}
		}
	});

	test('curl is returned verbatim, without an added newline', () => {
		expect(snippet('curl', hostile).endsWith('\n')).toBe(false);
	});

	test('is deterministic', () => {
		for (const [name, request] of ALL) {
			for (const lang of LANGS) {
				expect(`${lang}/${name}:${snippet(lang, request) === snippet(lang, request)}`).toBe(`${lang}/${name}:true`);
			}
		}
	});

	test('never leaks undefined, [object Object] or NaN', () => {
		for (const [name, request] of ALL) {
			for (const lang of LANGS) {
				const code = snippet(lang, request);
				for (const bad of ['undefined', '[object Object]', 'NaN']) {
					expect(`${lang}/${name}/${bad}:${code.includes(bad)}`).toBe(`${lang}/${name}/${bad}:false`);
				}
			}
		}
	});

	test('survives a request with missing optional fields', () => {
		// curl.ts is somebody else's contract; only these three have to tolerate holes.
		const bare = { method: 'POST', url: `${BASE}/bare`, body: { type: 'raw', format: 'json' } } as unknown as SavedRequest;
		for (const lang of ['fetch', 'python', 'go'] as SnippetLang[]) {
			const code = snippet(lang, bare);
			expect(code.includes('undefined')).toBe(false);
			expect(code.length).toBeGreaterThan(0);
		}
	});
});
