import { describe, expect, test } from 'bun:test';
import { fromCurl, importOpenApi, importPostman, toCurl } from '../src/curl';
import type { SavedRequest } from '../src/store';

const URL_BASE = 'https://api.example.com';

const get: SavedRequest = { method: 'GET', url: `${URL_BASE}/users` };

const postJson: SavedRequest = {
	method: 'POST',
	url: `${URL_BASE}/users`,
	headers: { 'Content-Type': 'application/json' },
	body: { type: 'raw', format: 'json', content: '{"name":"Ada","tags":["a","b"]}' },
};

const postForm: SavedRequest = {
	method: 'POST',
	url: `${URL_BASE}/login`,
	body: { type: 'urlencoded', fields: [{ key: 'user', value: 'ada' }, { key: 'note', value: 'два слова' }] },
};

const multipart: SavedRequest = {
	method: 'POST',
	url: `${URL_BASE}/upload`,
	body: { type: 'multipart', fields: [{ key: 'note', value: 'hi' }], files: [{ key: 'upload', path: '/tmp/my file.txt' }] },
};

const binary: SavedRequest = {
	method: 'PUT',
	url: `${URL_BASE}/blob`,
	body: { type: 'binary', path: '/tmp/a b.bin' },
};

const basicAuth: SavedRequest = {
	method: 'GET',
	url: `${URL_BASE}/me`,
	auth: { type: 'basic', username: 'ada', password: 'p:a:ss' },
};

const customHeaders: SavedRequest = {
	method: 'GET',
	url: `${URL_BASE}/users`,
	headers: { 'X-Token': 'abc', Accept: 'application/json' },
};

const apikeyHeader: SavedRequest = {
	method: 'GET',
	url: `${URL_BASE}/users`,
	auth: { type: 'apikey', key: 'X-Api-Key', value: 's3cret', in: 'header' },
};

const apikeyQuery: SavedRequest = {
	method: 'GET',
	url: `${URL_BASE}/users`,
	auth: { type: 'apikey', key: 'api_key', value: 's3cret', in: 'query' },
};

const quoted: SavedRequest = {
	method: 'POST',
	url: `${URL_BASE}/notes?q=O'Brien`,
	headers: { 'X-Author': "O'Brien" },
	body: { type: 'raw', format: 'json', content: JSON.stringify({ name: "O'Brien", text: "it's \"fine\"" }) },
};

const unicode: SavedRequest = {
	method: 'POST',
	url: 'https://例え.jp/パス?q=ü',
	headers: { 'X-名': 'välue' },
	body: { type: 'raw', format: 'json', content: '{"ключ":"значение"}' },
};

describe('toCurl', () => {
	test('always spells the method out, even for GET', () => {
		expect(toCurl(get)).toBe(`curl -X GET '${URL_BASE}/users'`);
	});

	test('HEAD is explicit too', () => {
		expect(toCurl({ method: 'HEAD', url: `${URL_BASE}/ping` })).toBe(`curl -X HEAD '${URL_BASE}/ping'`);
	});

	test('one -H per header, in insertion order', () => {
		expect(toCurl(customHeaders)).toBe(
			`curl -X GET -H 'X-Token: abc' -H 'Accept: application/json' '${URL_BASE}/users'`
		);
	});

	test('raw body becomes --data-raw', () => {
		expect(toCurl(postJson)).toBe(
			`curl -X POST -H 'Content-Type: application/json' --data-raw '{"name":"Ada","tags":["a","b"]}' '${URL_BASE}/users'`
		);
	});

	test('urlencoded body becomes one --data-urlencode per field', () => {
		expect(toCurl(postForm)).toBe(
			`curl -X POST --data-urlencode 'user=ada' --data-urlencode 'note=два слова' '${URL_BASE}/login'`
		);
	});

	test('multipart uses --form-string for fields and -F k=@path for files', () => {
		expect(toCurl(multipart)).toBe(
			`curl -X POST --form-string 'note=hi' -F 'upload=@/tmp/my file.txt' '${URL_BASE}/upload'`
		);
	});

	test('binary body uses --data-binary @path', () => {
		expect(toCurl(binary)).toBe(`curl -X PUT --data-binary '@/tmp/a b.bin' '${URL_BASE}/blob'`);
	});

	test('basic auth uses -u with the first colon preserved inside the password', () => {
		expect(toCurl(basicAuth)).toBe(`curl -X GET -u 'ada:p:a:ss' '${URL_BASE}/me'`);
	});

	test('bearer auth becomes an Authorization header', () => {
		const cmd = toCurl({ method: 'GET', url: `${URL_BASE}/me`, auth: { type: 'bearer', token: 'tok' } });
		expect(cmd).toBe(`curl -X GET -H 'Authorization: Bearer tok' '${URL_BASE}/me'`);
	});

	test('bearer replaces a stored Authorization header instead of duplicating it', () => {
		const cmd = toCurl({
			method: 'GET',
			url: `${URL_BASE}/me`,
			headers: { authorization: 'Bearer stale' },
			auth: { type: 'bearer', token: 'fresh' },
		});
		expect(cmd).toBe(`curl -X GET -H 'Authorization: Bearer fresh' '${URL_BASE}/me'`);
	});

	test('apikey in header becomes a header', () => {
		expect(toCurl(apikeyHeader)).toBe(`curl -X GET -H 'X-Api-Key: s3cret' '${URL_BASE}/users'`);
	});

	test('apikey in query appends to the URL', () => {
		expect(toCurl(apikeyQuery)).toBe(`curl -X GET '${URL_BASE}/users?api_key=s3cret'`);
	});

	test('apikey in query reuses an existing query string', () => {
		const cmd = toCurl({
			method: 'GET',
			url: `${URL_BASE}/users?page=2`,
			auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' },
		});
		expect(cmd).toBe(`curl -X GET '${URL_BASE}/users?page=2&k=v'`);
	});

	test("a single quote inside a value becomes '\\''", () => {
		expect(toCurl(quoted)).toContain("O'\\''Brien");
	});

	test('output is a single line with no backslashes', () => {
		const cmd = toCurl(postJson);
		expect(cmd).not.toContain('\n');
		expect(cmd).not.toContain('\\');
	});

	test('auth none adds nothing', () => {
		expect(toCurl({ ...get, auth: { type: 'none' } })).toBe(toCurl(get));
	});
});

describe('fromCurl', () => {
	test('bare URL defaults to GET', () => {
		expect(fromCurl('curl https://api.example.com/users')).toEqual({ method: 'GET', url: `${URL_BASE}/users` });
	});

	test('-X sets the method', () => {
		expect(fromCurl('curl -X delete https://x.dev/a').method).toBe('DELETE');
	});

	test('--request=VALUE inline form sets the method', () => {
		expect(fromCurl(`curl --request=PATCH '${URL_BASE}/a'`).method).toBe('PATCH');
	});

	test('-d without -X becomes POST', () => {
		expect(fromCurl("curl 'https://x.dev' -d 'hello'")).toEqual({
			method: 'POST',
			url: 'https://x.dev',
			body: { type: 'raw', format: 'text', content: 'hello' },
		});
	});

	test('JSON -d is detected as format json', () => {
		const req = fromCurl(`curl 'https://x.dev' -d '{"a":1}'`);
		expect(req.body).toEqual({ type: 'raw', format: 'json', content: '{"a":1}' });
	});

	test('XML and HTML payloads are detected', () => {
		expect(fromCurl("curl 'https://x.dev' -d '<note>x</note>'").body).toEqual({
			type: 'raw',
			format: 'xml',
			content: '<note>x</note>',
		});
		expect(fromCurl("curl 'https://x.dev' -d '<!DOCTYPE html><html></html>'").body).toEqual({
			type: 'raw',
			format: 'html',
			content: '<!DOCTYPE html><html></html>',
		});
	});

	test('several -H flags accumulate, case preserved', () => {
		const req = fromCurl("curl -H 'X-A: 1' -H 'Accept: application/json' https://x.dev");
		expect(req.headers).toEqual({ 'X-A': '1', Accept: 'application/json' });
	});

	test('a repeated header keeps the last value', () => {
		const req = fromCurl("curl -H 'X-A: 1' -H 'X-A: 2' https://x.dev");
		expect(req.headers).toEqual({ 'X-A': '2' });
	});

	test('--data-urlencode accumulates into a urlencoded body', () => {
		const req = fromCurl("curl 'https://x.dev' --data-urlencode 'a=1' --data-urlencode 'b=two words'");
		expect(req).toEqual({
			method: 'POST',
			url: 'https://x.dev',
			body: { type: 'urlencoded', fields: [{ key: 'a', value: '1' }, { key: 'b', value: 'two words' }] },
		});
	});

	test('--data-binary @path becomes a binary body', () => {
		const req = fromCurl("curl -X PUT --data-binary '@/tmp/a b.bin' https://x.dev");
		expect(req.body).toEqual({ type: 'binary', path: '/tmp/a b.bin' });
	});

	test('-F splits fields from files', () => {
		const req = fromCurl("curl -F 'note=hi' -F 'upload=@/tmp/my file.txt' https://x.dev");
		expect(req.method).toBe('POST');
		expect(req.body).toEqual({
			type: 'multipart',
			fields: [{ key: 'note', value: 'hi' }],
			files: [{ key: 'upload', path: '/tmp/my file.txt' }],
		});
	});

	test('-u splits on the first colon only', () => {
		expect(fromCurl("curl -u 'ada:p:a:ss' https://x.dev").auth).toEqual({
			type: 'basic',
			username: 'ada',
			password: 'p:a:ss',
		});
	});

	test('-u without a colon means an empty password', () => {
		expect(fromCurl('curl -u ada https://x.dev').auth).toEqual({ type: 'basic', username: 'ada', password: '' });
	});

	test('-b becomes a Cookie header, repeated -b joins with "; "', () => {
		const req = fromCurl("curl -b 'a=1' -b 'b=2' https://x.dev");
		expect(req.headers).toEqual({ Cookie: 'a=1; b=2' });
	});

	test('--url supplies the URL', () => {
		expect(fromCurl('curl -X GET --url https://x.dev/a').url).toBe('https://x.dev/a');
	});

	test('ignored flags do not derail parsing', () => {
		const req = fromCurl('curl --compressed -sS -k -L -i -v https://x.dev/a');
		expect(req).toEqual({ method: 'GET', url: 'https://x.dev/a' });
	});

	test('value-taking flags swallow their value', () => {
		const req = fromCurl("curl -o out.json -A 'ua/1' https://x.dev/a");
		expect(req.url).toBe('https://x.dev/a');
	});

	test('backslash line continuations are joined', () => {
		const req = fromCurl("curl \\\n  -X POST \\\n  -H 'X-A: 1' \\\n  'https://x.dev/a'");
		expect(req).toEqual({ method: 'POST', url: 'https://x.dev/a', headers: { 'X-A': '1' } });
	});

	test('Windows ^ continuations are joined', () => {
		const req = fromCurl("curl -X POST ^\n  -H 'X-A: 1' ^\n  'https://x.dev/a'");
		expect(req).toEqual({ method: 'POST', url: 'https://x.dev/a', headers: { 'X-A': '1' } });
	});

	test('PowerShell backtick continuations are joined', () => {
		const req = fromCurl("curl -X POST `\n  'https://x.dev/a'");
		expect(req).toEqual({ method: 'POST', url: 'https://x.dev/a' });
	});

	test("handles shell-escaped apostrophes ('\\'')", () => {
		const req = fromCurl("curl -X POST --data-raw '{\"name\":\"O'\\''Brien\"}' https://x.dev");
		expect(req.body).toEqual({ type: 'raw', format: 'json', content: '{"name":"O\'Brien"}' });
	});

	test('double-quoted arguments work too', () => {
		const req = fromCurl('curl -X POST -H "X-A: a b" "https://x.dev/a"');
		expect(req.headers).toEqual({ 'X-A': 'a b' });
		expect(req.url).toBe('https://x.dev/a');
	});

	test('--data-raw keeps JSON with apostrophes and newlines verbatim', () => {
		const body = '{\n  "text": "it\'s fine"\n}';
		const req = fromCurl(`curl -X POST --data-raw '${body.split("'").join("'\\''")}' https://x.dev`);
		expect(req.body).toEqual({ type: 'raw', format: 'json', content: body });
	});

	test('throws when there is no curl and no URL', () => {
		expect(() => fromCurl('hello world')).toThrow(/no "curl" and no URL/);
	});

	test('throws on empty input', () => {
		expect(() => fromCurl('   ')).toThrow(/empty/);
	});

	test('throws on an unsupported method', () => {
		expect(() => fromCurl('curl -X TRACE https://x.dev')).toThrow(/Unsupported HTTP method "TRACE"/);
	});

	test('throws when curl has no URL', () => {
		expect(() => fromCurl('curl -X GET')).toThrow(/no URL/);
	});
});

describe('round trip', () => {
	test('GET', () => {
		expect(fromCurl(toCurl(get))).toEqual(get);
	});

	test('GET with a URL that has no query', () => {
		const req: SavedRequest = { method: 'GET', url: `${URL_BASE}/health` };
		expect(fromCurl(toCurl(req))).toEqual(req);
	});

	test('POST + JSON', () => {
		expect(fromCurl(toCurl(postJson))).toEqual(postJson);
	});

	test('POST + urlencoded', () => {
		expect(fromCurl(toCurl(postForm))).toEqual(postForm);
	});

	test('multipart with a file path (spaces included)', () => {
		expect(fromCurl(toCurl(multipart))).toEqual(multipart);
	});

	test('multipart with files only', () => {
		const req: SavedRequest = {
			method: 'POST',
			url: `${URL_BASE}/upload`,
			body: { type: 'multipart', files: [{ key: 'f', path: 'C:\\tmp\\a.bin' }] },
		};
		expect(fromCurl(toCurl(req))).toEqual(req);
	});

	test('binary', () => {
		expect(fromCurl(toCurl(binary))).toEqual(binary);
	});

	test('basic auth with a colon in the password', () => {
		expect(fromCurl(toCurl(basicAuth))).toEqual(basicAuth);
	});

	test('custom headers', () => {
		expect(fromCurl(toCurl(customHeaders))).toEqual(customHeaders);
	});

	test('unicode URL, header name and body', () => {
		expect(fromCurl(toCurl(unicode))).toEqual(unicode);
	});

	test('apostrophes in URL, header and body', () => {
		expect(fromCurl(toCurl(quoted))).toEqual(quoted);
	});

	test('apikey in header survives as the equivalent header', () => {
		const back = fromCurl(toCurl(apikeyHeader));
		expect(back.headers).toEqual({ 'X-Api-Key': 's3cret' });
		expect(back.url).toBe(apikeyHeader.url);
	});

	test('apikey in query survives as the equivalent query param', () => {
		const back = fromCurl(toCurl(apikeyQuery));
		expect(back.url).toBe(`${URL_BASE}/users?api_key=s3cret`);
	});
});

describe('importPostman', () => {
	const collection = {
		info: { name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
		item: [
			{
				name: 'Users',
				item: [
					{
						name: 'List',
						request: {
							method: 'GET',
							header: [{ key: 'Accept', value: 'application/json' }, { key: 'Skip', value: 'no', disabled: true }],
							url: { raw: `${URL_BASE}/users?page=2` },
						},
					},
					{
						name: 'Admin',
						item: [
							{
								name: 'Create',
								request: {
									method: 'POST',
									url: { protocol: 'https', host: ['api', 'example', 'com'], path: ['users'], query: [{ key: 'dry', value: '1' }] },
									body: {
										mode: 'raw',
										raw: '{"name":"Ada"}',
										options: { raw: { language: 'json' } },
									},
								},
							},
						],
					},
				],
			},
			{
				name: 'Auth',
				request: {
					method: 'GET',
					url: `${URL_BASE}/me`,
					auth: { type: 'bearer', bearer: [{ key: 'token', value: 'tok' }] },
				},
			},
			{
				name: 'Basic',
				request: {
					method: 'GET',
					url: `${URL_BASE}/me`,
					auth: { type: 'basic', basic: [{ key: 'username', value: 'ada' }, { key: 'password', value: 'pw' }] },
				},
			},
			{
				name: 'Key',
				request: {
					method: 'GET',
					url: `${URL_BASE}/me`,
					auth: {
						type: 'apikey',
						apikey: [{ key: 'key', value: 'api_key' }, { key: 'value', value: 'v1' }, { key: 'in', value: 'query' }],
					},
				},
			},
			{
				name: 'Form',
				request: {
					method: 'POST',
					url: `${URL_BASE}/login`,
					body: {
						mode: 'urlencoded',
						urlencoded: [{ key: 'user', value: 'ada' }, { key: 'gone', value: 'x', disabled: true }],
					},
				},
			},
			{
				name: 'Upload',
				request: {
					method: 'POST',
					url: `${URL_BASE}/upload`,
					body: {
						mode: 'formdata',
						formdata: [
							{ key: 'note', value: 'hi', type: 'text' },
							{ key: 'file', type: 'file', src: '/tmp/a.txt' },
						],
					},
				},
			},
			{ name: 'Broken', request: { method: 'GET', url: '' } },
			{ name: 'NoMethod', request: { method: 'FLY', url: `${URL_BASE}/x` } },
			{ name: 'Nothing' },
		],
	};

	const imported = importPostman(collection);
	const byName = (name: string) => imported.find((entry) => entry.name === name);

	test('skips malformed items instead of failing', () => {
		expect(byName('Broken')).toBeUndefined();
		expect(byName('NoMethod')).toBeUndefined();
		expect(byName('Nothing')).toBeUndefined();
	});

	test('counts the healthy item', () => {
		expect(imported.length).toBe(7);
	});

	test('top-level items carry no folder', () => {
		expect(byName('Auth')!.folder).toBeUndefined();
	});

	test('nested folders are slash-joined', () => {
		expect(byName('List')!.folder).toBe('Users');
		expect(byName('Create')!.folder).toBe('Users/Admin');
	});

	test('url.raw wins and keeps its own query', () => {
		expect(byName('List')!.request.url).toBe(`${URL_BASE}/users?page=2`);
	});

	test('url is built from protocol/host/path/query when raw is absent', () => {
		const req = byName('Create')!.request;
		expect(req.url).toBe(`${URL_BASE}/users?dry=1`);
		expect(req.method).toBe('POST');
		expect(req.body).toEqual({ type: 'raw', format: 'json', content: '{"name":"Ada"}' });
	});

	test('headers drop disabled rows', () => {
		expect(byName('List')!.request.headers).toEqual({ Accept: 'application/json' });
	});

	test('bearer auth maps over', () => {
		expect(byName('Auth')!.request.auth).toEqual({ type: 'bearer', token: 'tok' });
	});

	test('basic auth maps over', () => {
		expect(byName('Basic')!.request.auth).toEqual({ type: 'basic', username: 'ada', password: 'pw' });
	});

	test('apikey auth maps over with its location', () => {
		expect(byName('Key')!.request.auth).toEqual({ type: 'apikey', key: 'api_key', value: 'v1', in: 'query' });
	});

	test('urlencoded body maps over', () => {
		expect(byName('Form')!.request.body).toEqual({ type: 'urlencoded', fields: [{ key: 'user', value: 'ada' }] });
	});

	test('formdata body splits fields and files', () => {
		expect(byName('Upload')!.request.body).toEqual({
			type: 'multipart',
			fields: [{ key: 'note', value: 'hi' }],
			files: [{ key: 'file', path: '/tmp/a.txt' }],
		});
	});

	test('a request given as a plain string becomes a GET', () => {
		const [entry] = importPostman({ item: [{ name: 'Simple', request: `${URL_BASE}/simple` }] });
		expect(entry.request).toEqual({ method: 'GET', url: `${URL_BASE}/simple` });
	});

	test('throws for a non-object input', () => {
		expect(() => importPostman('nope')).toThrow(/expected a JSON object/);
	});

	test('throws when the item array is missing', () => {
		expect(() => importPostman({ info: { name: 'empty' } })).toThrow(/missing the "item" array/);
	});
});

describe('importOpenApi', () => {
	const doc = {
		openapi: '3.0.3',
		info: { title: 'Demo', version: '1.0.0' },
		servers: [{ url: `${URL_BASE}/v1` }],
		paths: {
			'/users/{userId}': {
				get: {
					tags: ['Users', 'Second'],
					parameters: [
						{ name: 'userId', in: 'path', required: true },
						{ name: 'X-Trace', in: 'header', example: 'abc' },
						{ name: 'verbose', in: 'query', required: true },
						{ name: 'optional', in: 'query' },
					],
				},
				post: {
					tags: ['Users'],
					requestBody: { content: { 'application/json': { example: { name: 'Ada' } } } },
				},
				delete: { deprecated: true, tags: ['Users'] },
			},
			'/health': { get: {} },
			'x-internal': { get: { tags: ['Hidden'] } },
		},
	};

	const imported = importOpenApi(doc);
	const byName = (name: string) => imported.find((entry) => entry.name === name);

	test('one entry per method, x- keys and deprecated operations skipped', () => {
		expect(imported.map((entry) => entry.name)).toEqual([
			'GET /users/{userId}',
			'POST /users/{userId}',
			'GET /health',
		]);
	});

	test('server url is prefixed and {var} becomes :var', () => {
		expect(byName('GET /users/{userId}')!.request.url).toBe(
			`${URL_BASE}/v1/users/:userId?verbose={{verbose}}`
		);
	});

	test('method and path become the name, first tag becomes the folder', () => {
		expect(byName('GET /users/{userId}')!.request.method).toBe('GET');
		expect(byName('GET /users/{userId}')!.folder).toBe('Users');
	});

	test('header parameters become headers, path/optional query parameters do not', () => {
		expect(byName('GET /users/{userId}')!.request.headers).toEqual({ 'X-Trace': 'abc' });
	});

	test('json request body comes from the media type example', () => {
		expect(byName('POST /users/{userId}')!.request.body).toEqual({
			type: 'raw',
			format: 'json',
			content: JSON.stringify({ name: 'Ada' }, null, 2),
		});
	});

	test('operations without tags or bodies stay minimal', () => {
		const req = byName('GET /health')!.request;
		expect(req).toEqual({ method: 'GET', url: `${URL_BASE}/v1/health` });
		expect(byName('GET /health')!.folder).toBeUndefined();
	});

	test('parameters shared at path level are inherited', () => {
		const shared = importOpenApi({
			openapi: '3.0.0',
			servers: [{ url: 'https://x.dev' }],
			paths: {
				'/a': {
					parameters: [{ name: 'X-Shared', in: 'header', example: 'v' }],
					get: { tags: ['A'] },
				},
			},
		});
		expect(shared[0].request.headers).toEqual({ 'X-Shared': 'v' });
	});

	test('schema.example is used when media example is absent', () => {
		const [entry] = importOpenApi({
			openapi: '3.0.0',
			servers: [{ url: 'https://x.dev' }],
			paths: {
				'/a': { post: { requestBody: { content: { 'application/json': { schema: { example: { ok: true } } } } } } },
			},
		});
		expect(entry.request.body).toEqual({ type: 'raw', format: 'json', content: JSON.stringify({ ok: true }, null, 2) });
	});

	test('OpenAPI 2.0 uses host + basePath + scheme', () => {
		const imported20 = importOpenApi({
			swagger: '2.0',
			info: { title: 'Legacy', version: '1' },
			host: 'legacy.example.com',
			basePath: '/api',
			schemes: ['http'],
			paths: {
				'/pets/{id}': {
					put: {
						tags: ['Pets'],
						parameters: [
							{ name: 'id', in: 'path', required: true },
							{ name: 'body', in: 'body', schema: { example: { name: 'Rex' } } },
						],
					},
				},
			},
		});
		expect(imported20.length).toBe(1);
		expect(imported20[0].name).toBe('PUT /pets/{id}');
		expect(imported20[0].folder).toBe('Pets');
		expect(imported20[0].request.url).toBe('http://legacy.example.com/api/pets/:id');
		expect(imported20[0].request.body).toEqual({
			type: 'raw',
			format: 'json',
			content: JSON.stringify({ name: 'Rex' }, null, 2),
		});
	});

	test('OpenAPI 2.0 defaults to https when schemes are absent', () => {
		const [entry] = importOpenApi({
			swagger: '2.0',
			host: 'legacy.example.com',
			paths: { '/ping': { get: {} } },
		});
		expect(entry.request.url).toBe('https://legacy.example.com/ping');
	});

	test('a missing trailing slash on the server does not double up', () => {
		const [entry] = importOpenApi({
			openapi: '3.0.0',
			servers: [{ url: 'https://x.dev/' }],
			paths: { '/a': { get: {} } },
		});
		expect(entry.request.url).toBe('https://x.dev/a');
	});

	test('no server leaves the path relative', () => {
		const [entry] = importOpenApi({ openapi: '3.0.0', paths: { '/a': { get: {} } } });
		expect(entry.request.url).toBe('/a');
	});

	test('throws when paths are missing', () => {
		expect(() => importOpenApi({ openapi: '3.0.0', info: {} })).toThrow(/missing the "paths"/);
	});

	test('throws for a non-object input', () => {
		expect(() => importOpenApi(null)).toThrow(/expected a JSON object/);
	});
});

describe('regressions', () => {
	test('a continuation inside single quotes is preserved literally', () => {
		expect(fromCurl("curl -X POST --data-raw 'a\\\nb' https://x.dev").body).toEqual({
			type: 'raw',
			format: 'text',
			content: 'a\\\nb',
		});
	});

	test('a continuation inside double quotes is preserved literally', () => {
		expect(fromCurl('curl -X POST --data-raw "a\\\nb" https://x.dev').body).toEqual({
			type: 'raw',
			format: 'text',
			content: 'a\\\nb',
		});
	});

	test('a continuation outside quotes still joins the line', () => {
		expect(fromCurl('curl -X POST\\\n  https://x.dev/a')).toEqual({ method: 'POST', url: 'https://x.dev/a' });
	});

	test('a multipart field starting with @ is a field, not a file', () => {
		const request: SavedRequest = {
			method: 'POST',
			url: 'https://x.dev/u',
			body: { type: 'multipart', fields: [{ key: 'note', value: '@home' }] },
		};
		const cmd = toCurl(request);
		expect(cmd).toContain("--form-string 'note=@home'");
		expect(cmd).not.toContain('-F ');
		expect(fromCurl(cmd).body).toEqual(request.body);
	});

	test('an actual file ref still exports as -F k=@path', () => {
		const request: SavedRequest = {
			method: 'POST',
			url: 'https://x.dev/u',
			body: { type: 'multipart', files: [{ key: 'f', path: '/tmp/a.txt' }] },
		};
		expect(toCurl(request)).toContain("-F 'f=@/tmp/a.txt'");
		expect(fromCurl(toCurl(request)).body).toEqual(request.body);
	});

	test('-F part directives are stripped from the value', () => {
		const body = { type: 'multipart', fields: [{ key: 'x', value: 'y' }] };
		expect(fromCurl("curl -F 'x=y;type=text/plain' https://x.dev").body).toEqual(body);
		expect(fromCurl("curl -F 'x=y;filename=a.txt' https://x.dev").body).toEqual(body);
		expect(fromCurl("curl -F 'x=y;headers=\"X-A: 1;X-B: 2\"' https://x.dev").body).toEqual(body);
	});

	test('a semicolon that is not a directive stays in the value', () => {
		expect(fromCurl("curl -F 'x=a;b' https://x.dev").body).toEqual({
			type: 'multipart',
			fields: [{ key: 'x', value: 'a;b' }],
		});
	});

	test('directives are stripped from a file part too', () => {
		expect(fromCurl("curl -F 'f=@/tmp/a.txt;type=text/plain' https://x.dev").body).toEqual({
			type: 'multipart',
			files: [{ key: 'f', path: '/tmp/a.txt' }],
		});
	});

	test("an ANSI-C $'...' header becomes exactly one header", () => {
		const req = fromCurl("curl -H $'A: b\\nc: d' https://x.dev");
		expect(req.headers).toEqual({ A: 'b\nc: d' });
		expect(Object.keys(req.headers ?? {})).toHaveLength(1);
	});

	test('a $ inside single quotes is data, not ANSI-C quoting', () => {
		expect(fromCurl("curl --data-raw '$HOME' https://x.dev").body).toEqual({
			type: 'raw',
			format: 'text',
			content: '$HOME',
		});
	});

	test("curl's `Header;` form means an empty value", () => {
		expect(fromCurl("curl -H 'X;' https://x.dev").headers).toEqual({ X: '' });
	});
});

describe('flags that used to swallow the URL', () => {
	test.each([['-K', 'cfg'], ['--config', 'cfg'], ['-E', 'cert.pem'], ['--proto', '=https']])('%s does not eat the url', (flag, value) => {
		const cmd = ['curl', flag, value, 'https://api.test/x'].filter(Boolean).join(' ');
		expect(fromCurl(cmd).url).toBe('https://api.test/x');
	});

	test('--next is a valueless flag, so the url after it is kept', () => {
		expect(fromCurl('curl --next https://api.test/x').url).toBe('https://api.test/x');
	});
});
