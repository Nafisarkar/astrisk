import { describe, expect, test } from 'bun:test';
import {
	runScript,
	type ScriptContext,
	type ScriptOutcome,
	type ScriptRequest,
	type ScriptResponse,
} from '../src/scripting';

const baseReq = (): ScriptRequest => ({
	method: 'GET',
	url: 'https://api.test/users/1',
	headers: { accept: 'application/json', 'x-old': 'yes' },
});

const baseRes = (): ScriptResponse => ({
	status: 200,
	statusText: 'OK',
	headers: { 'content-type': 'application/json' },
	body: '{"id":1,"name":"ada"}',
	timeMs: 12,
	size: 25,
});

const makeCtx = (over: Partial<ScriptContext> = {}): ScriptContext => ({ request: baseReq(), vars: { token: 'abc' }, ...over });

const pre = (code: string, ctx: ScriptContext = makeCtx()): ScriptOutcome => runScript(code, ctx, 'pre');
const post = (code: string, ctx: ScriptContext = makeCtx({ response: baseRes() })): ScriptOutcome => runScript(code, ctx, 'post');

/** The one assertion the script produced, or a loud failure. */
const only = (o: ScriptOutcome) => {
	expect(o.assertions).toHaveLength(1);
	return o.assertions[0];
};

describe('sandbox basics', () => {
	test('empty script: no assertions, no error, no logs', () => {
		const o = pre('');
		expect(o.error).toBeUndefined();
		expect(o.assertions).toEqual([]);
		expect(o.logs).toEqual([]);
	});

	test('comment-only script is a no-op', () => {
		const o = pre('// nothing to see here');
		expect(o.error).toBeUndefined();
		expect(o.assertions).toEqual([]);
	});

	test('console.log collects one line', () => {
		expect(pre("console.log('hello')").logs).toEqual(['hello']);
	});

	test('all four console methods log', () => {
		const o = pre("console.log('a'); console.info('b'); console.warn('c'); console.error('d');");
		expect(o.logs).toEqual(['a', 'b', 'c', 'd']);
		expect(o.error).toBeUndefined();
	});

	test('console args are joined with spaces and stringified', () => {
		const o = pre("console.log('n', 5, true, null, undefined);");
		expect(o.logs).toEqual(['n 5 true null undefined']);
	});

	test('json, math and date are available', () => {
		const o = pre("console.log(JSON.stringify({a:1}), Math.max(1,9), typeof Date.now());");
		expect(o.logs).toEqual(['{"a":1} 9 number']);
	});

	test('uri helpers and parsing helpers are available', () => {
		const o = pre("console.log(encodeURIComponent('a b'), parseInt('42px'), isNaN(NaN));");
		expect(o.logs).toEqual(['a%20b 42 true']);
	});

	test('require is undefined inside the sandbox', () => {
		const o = pre('console.log(typeof require)');
		expect(o.logs).toEqual(['undefined']);
		expect(o.error).toBeUndefined();
	});

	test('fetch and setTimeout are undefined inside the sandbox', () => {
		const o = pre('console.log(typeof fetch, typeof setTimeout, typeof importScripts)');
		expect(o.logs).toEqual(['undefined undefined undefined']);
	});

	test('touching process fails as an error, not a host crash', () => {
		const o = pre("process.exit(1)");
		expect(o.error).toContain('process is not defined');
	});

	test('reading require by name fails as an error', () => {
		expect(pre("require('node:fs')").error).toContain('require is not defined');
	});

	test('syntax error reports the message without a stack dump', () => {
		const o = pre('var =');
		expect(o.error).toBeDefined();
		expect(o.error).not.toContain('    at ');
		expect(o.assertions).toEqual([]);
	});

	test('a thrown Error lands in error', () => {
		const o = pre("throw new Error('boom')");
		expect(o.error).toBe('boom');
	});

	test('a thrown string lands in error', () => {
		const o = pre("throw 'plain string'");
		expect(o.error).toBe('plain string');
	});

	test('a runtime TypeError lands in error', () => {
		const o = pre('null.x');
		expect(o.error).toBeDefined();
		expect(o.error).not.toContain('\n');
	});

	test('infinite loop times out instead of hanging', () => {
		const start = Date.now();
		const o = runScript('while (true) {}', makeCtx(), 'pre', { timeoutMs: 50 });
		expect(o.error).toContain('timed out');
		expect(Date.now() - start).toBeLessThan(2000);
	});

	test('timeout message names the budget', () => {
		expect(runScript('while (true) {}', makeCtx(), 'pre', { timeoutMs: 50 }).error).toBe('Script timed out after 50ms');
	});

	test('logs written before a throw survive', () => {
		const o = pre("console.log('before'); throw new Error('nope')");
		expect(o.logs).toEqual(['before']);
		expect(o.error).toBe('nope');
	});

	test('unicode survives logs and assertions', () => {
		const o = pre("console.log('héllo 🌍'); expect('héllo').to.equal('héllo'); expect('🌍').to.include('🌍');");
		expect(o.logs).toEqual(['héllo 🌍']);
		expect(o.assertions.map((a) => a.passed)).toEqual([true, true]);
	});

	test('same input gives the same outcome twice', () => {
		const code = "console.log('x'); expect(1).to.equal(1); vars.k = 'v'";
		const a = pre(code);
		const b = pre(code);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test('wrong runtime phase produces a readable error', () => {
		const o = runScript('', makeCtx(), 'sideways' as unknown as 'pre');
		expect(o.error).toContain('Unknown script phase');
		expect(o.error).toContain('sideways');
	});

	test('post without a response is a readable error', () => {
		const o = runScript('', { request: baseReq(), vars: {} }, 'post');
		expect(o.error).toContain('needs a response');
	});
});

describe('expect: equality', () => {
	test('equal passes on identical values', () => {
		const o = pre('expect(1).to.equal(1)');
		expect(only(o).passed).toBe(true);
		expect(o.error).toBeUndefined();
	});

	test('equal names the assertion', () => {
		expect(only(pre('expect(1).to.equal(1)')).name).toBe('expect(1).to.equal(1)');
	});

	test('equal fails on different values without setting error', () => {
		const o = pre('expect(200).to.equal(201)');
		const a = only(o);
		expect(a.passed).toBe(false);
		expect(a.message).toContain('200');
		expect(o.error).toBeUndefined();
	});

	test('equal is type-strict', () => {
		expect(only(pre("expect('200').to.equal(200)")).passed).toBe(false);
	});

	test('equal goes deep for objects', () => {
		expect(only(pre("expect({a:1,b:[2,{c:3}]}).to.equal({a:1,b:[2,{c:3}]})")).passed).toBe(true);
	});

	test('equal fails on object key mismatch', () => {
		expect(only(pre('expect({a:1}).to.equal({a:2})')).passed).toBe(false);
	});

	test('eql does deep equality on arrays', () => {
		expect(only(pre('expect([1,[2,3]]).to.eql([1,[2,3]])')).passed).toBe(true);
	});

	test('eql fails on different lengths', () => {
		expect(only(pre('expect([1,2]).to.eql([1,2,3])')).passed).toBe(false);
	});

	test('eql sees null vs undefined as different', () => {
		expect(only(pre('expect(null).to.eql(undefined)')).passed).toBe(false);
	});
});

describe('expect: comparisons', () => {
	test('above passes', () => {
		expect(only(pre('expect(5).to.be.above(4)')).passed).toBe(true);
	});

	test('above fails at the boundary', () => {
		expect(only(pre('expect(5).to.be.above(5)')).passed).toBe(false);
	});

	test('below passes', () => {
		expect(only(pre('expect(5).to.be.below(6)')).passed).toBe(true);
	});

	test('below fails at the boundary', () => {
		expect(only(pre('expect(5).to.be.below(5)')).passed).toBe(false);
	});

	test('at.least passes on equality', () => {
		expect(only(pre('expect(5).to.be.at.least(5)')).passed).toBe(true);
	});

	test('at.least fails below', () => {
		expect(only(pre('expect(4).to.be.at.least(5)')).passed).toBe(false);
	});

	test('at.most passes on equality', () => {
		expect(only(pre('expect(5).to.be.at.most(5)')).passed).toBe(true);
	});

	test('at.most fails above', () => {
		expect(only(pre('expect(6).to.be.at.most(5)')).passed).toBe(false);
	});

	test('comparison names read like the call', () => {
		expect(only(pre('expect(1).to.be.at.least(1)')).name).toBe('expect(1).to.be.at.least(1)');
	});
});

describe('expect: include, match, type, length', () => {
	test('include works on strings', () => {
		expect(only(pre("expect('abc123').to.include('c1')")).passed).toBe(true);
	});

	test('include fails on a missing substring', () => {
		expect(only(pre("expect('abc').to.include('zz')")).passed).toBe(false);
	});

	test('include works on arrays', () => {
		expect(only(pre("expect(['a','b']).to.include('b')")).passed).toBe(true);
	});

	test('include goes deep on array members', () => {
		expect(only(pre('expect([{id:1},{id:2}]).to.include({id:2})')).passed).toBe(true);
	});

	test('include fails on arrays without the member', () => {
		expect(only(pre("expect(['a']).to.include('b')")).passed).toBe(false);
	});

	test('match passes with a regex literal', () => {
		expect(only(pre('expect("abc123").to.match(/^abc\\d+$/)')).passed).toBe(true);
	});

	test('match fails with a regex literal', () => {
		expect(only(pre('expect("abc").to.match(/^\\d+$/)')).passed).toBe(false);
	});

	test('match accepts a string pattern', () => {
		expect(only(pre("expect('v1.2.3').to.match('^v\\\\d')")).passed).toBe(true);
	});

	test('a("string") passes', () => {
		expect(only(pre("expect('x').to.be.a('string')")).passed).toBe(true);
	});

	test('a("number") fails on a string', () => {
		expect(only(pre("expect('5').to.be.a('number')")).passed).toBe(false);
	});

	test('a("array") passes on arrays', () => {
		expect(only(pre("expect([1]).to.be.a('array')")).passed).toBe(true);
	});

	test('a("object") passes on plain objects', () => {
		expect(only(pre("expect({}).to.be.a('object')")).passed).toBe(true);
	});

	test('have.length passes', () => {
		expect(only(pre("expect([1,2,3]).to.have.length(3)")).passed).toBe(true);
	});

	test('have.length works on strings', () => {
		expect(only(pre("expect('abcd').to.have.length(4)")).passed).toBe(true);
	});

	test('have.length fails on a mismatch', () => {
		expect(only(pre('expect([1]).to.have.length(2)')).passed).toBe(false);
	});
});

describe('expect: booleans and nullish', () => {
	test('be.true passes', () => {
		expect(only(pre('expect(true).to.be.true')).passed).toBe(true);
	});

	test('be.true fails on a truthy non-boolean', () => {
		expect(only(pre("expect('yes').to.be.true")).passed).toBe(false);
	});

	test('be.false passes', () => {
		expect(only(pre('expect(false).to.be.false')).passed).toBe(true);
	});

	test('be.false fails', () => {
		expect(only(pre('expect(0).to.be.false')).passed).toBe(false);
	});

	test('be.null passes', () => {
		expect(only(pre('expect(null).to.be.null')).passed).toBe(true);
	});

	test('be.null fails on undefined', () => {
		expect(only(pre('expect(undefined).to.be.null')).passed).toBe(false);
	});

	test('be.undefined passes', () => {
		expect(only(pre('expect(undefined).to.be.undefined')).passed).toBe(true);
	});

	test('be.undefined fails on null', () => {
		expect(only(pre('expect(null).to.be.undefined')).passed).toBe(false);
	});
});

describe('expect: .not variants', () => {
	test('.not.equal passes on different values', () => {
		expect(only(pre('expect(1).to.not.equal(2)')).passed).toBe(true);
	});

	test('.not.equal fails on equal values', () => {
		expect(only(pre('expect(1).to.not.equal(1)')).passed).toBe(false);
	});

	test('.not.eql passes on different objects', () => {
		expect(only(pre('expect({a:1}).to.not.eql({a:2})')).passed).toBe(true);
	});

	test('.not.above passes below the bound', () => {
		expect(only(pre('expect(1).to.not.be.above(5)')).passed).toBe(true);
	});

	test('.not.below passes above the bound', () => {
		expect(only(pre('expect(9).to.not.be.below(5)')).passed).toBe(true);
	});

	test('.not.at.least fails at the bound', () => {
		expect(only(pre('expect(5).to.not.be.at.least(5)')).passed).toBe(false);
	});

	test('.not.at.most fails at the bound', () => {
		expect(only(pre('expect(5).to.not.be.at.most(5)')).passed).toBe(false);
	});

	test('.not.include passes on a missing substring', () => {
		expect(only(pre("expect('abc').to.not.include('zz')")).passed).toBe(true);
	});

	test('.not.include fails on a present substring', () => {
		expect(only(pre("expect('abc').to.not.include('b')")).passed).toBe(false);
	});

	test('.not.match passes on a non-match', () => {
		expect(only(pre('expect("abc").to.not.match(/^\\d+$/)')).passed).toBe(true);
	});

	test('.not.be.true passes on false', () => {
		expect(only(pre('expect(false).to.not.be.true')).passed).toBe(true);
	});

	test('.not.be.null passes on a value', () => {
		expect(only(pre('expect(0).to.not.be.null')).passed).toBe(true);
	});

	test('.not.be.undefined passes on a value', () => {
		expect(only(pre("expect('').to.not.be.undefined")).passed).toBe(true);
	});

	test('.not.be.a passes on another type', () => {
		expect(only(pre("expect(5).to.not.be.a('string')")).passed).toBe(true);
	});

	test('.not.have.length passes on a different length', () => {
		expect(only(pre('expect([1]).to.not.have.length(2)')).passed).toBe(true);
	});

	test('.not.have.length fails on the same length', () => {
		expect(only(pre('expect([1]).to.not.have.length(1)')).passed).toBe(false);
	});

	test('.not.equal is named with the negation', () => {
		expect(only(pre('expect(1).to.not.equal(2)')).name).toBe('expect(1).to.not.equal(2)');
	});
});

describe('assertion flow', () => {
	test('a failure stops the rest of the script', () => {
		const o = pre("expect(1).to.equal(2); vars.after = 'ran'; console.log('nope');");
		expect(o.assertions).toHaveLength(1);
		expect(o.vars.after).toBeUndefined();
		expect(o.logs).toEqual([]);
	});

	test('two passes are both recorded', () => {
		const o = pre("expect(1).to.equal(1); expect('a').to.include('a');");
		expect(o.assertions.map((a) => a.passed)).toEqual([true, true]);
	});

	test('a pass then a failure keeps both, in order', () => {
		const o = pre("expect(1).to.equal(1); expect('a').to.equal('b');");
		expect(o.assertions.map((a) => a.passed)).toEqual([true, false]);
		expect(o.assertions[1].message).toContain('"a"');
	});

	test('a passing assertion has no message', () => {
		expect(only(pre('expect(1).to.equal(1)')).message).toBeUndefined();
	});
});

describe('request and vars', () => {
	test('a pre script can rewrite the url', () => {
		expect(pre("request.url = 'https://api.test/users/2'").request.url).toBe('https://api.test/users/2');
	});

	test('a pre script can add a header', () => {
		const o = pre("request.headers['x-added'] = 'yes'");
		expect(o.request.headers['x-added']).toBe('yes');
		expect(o.request.headers.accept).toBe('application/json');
	});

	test('a pre script can delete a header', () => {
		const o = pre("delete request.headers['x-old']");
		expect(o.request.headers['x-old']).toBeUndefined();
		expect(o.request.headers.accept).toBe('application/json');
	});

	test('a pre script can set the body', () => {
		expect(pre("request.body = JSON.stringify({a:1})").request.body).toBe('{"a":1}');
	});

	test('a pre script sees the method and vars-spliced values', () => {
		const o = pre("console.log(request.method, vars.token)");
		expect(o.logs).toEqual(['GET abc']);
	});

	test('vars mutations persist into the outcome', () => {
		expect(pre("vars.foo = 'bar'").vars.foo).toBe('bar');
	});

	test('vars keep their original entries', () => {
		expect(pre("vars.foo = 'bar'").vars.token).toBe('abc');
	});

	test('post scripts see the response and leave the request alone', () => {
		const o = post("request.url = 'https://changed.test'; console.log(response.status, response.statusText);");
		expect(o.logs).toEqual(['200 OK']);
		expect(o.request.url).toBe('https://api.test/users/1');
	});

	test('post scripts can read the response body', () => {
		expect(post('expect(JSON.parse(response.body).id).to.equal(1)').assertions[0].passed).toBe(true);
	});

	test('response is undefined for phase pre', () => {
		expect(pre('console.log(typeof response)').logs).toEqual(['undefined']);
	});

	test('response is absent from the pre sandbox (touching it throws)', () => {
		expect(pre('response.status').error).toContain('response is not defined');
	});

	test('post scripts can mutate vars', () => {
		expect(post("vars.id = String(JSON.parse(response.body).id)").vars.id).toBe('1');
	});

	test('caller request is not mutated by the script', () => {
		const ctx = makeCtx();
		const before = JSON.stringify(ctx.request);
		pre("request.url = 'https://evil.test'; request.headers['x-new'] = '1'; delete request.headers.accept;", ctx);
		expect(JSON.stringify(ctx.request)).toBe(before);
	});

	test('caller vars are not mutated by the script', () => {
		const ctx = makeCtx();
		pre("vars.foo = 'bar'; delete vars.token;", ctx);
		expect(ctx.vars).toEqual({ token: 'abc' });
	});

	test('outcome request is a fresh object each run', () => {
		const ctx = makeCtx();
		const a = pre('', ctx);
		const b = pre('', ctx);
		expect(a.request).not.toBe(b.request);
		expect(a.vars).not.toBe(b.vars);
		expect(a.request).not.toBe(ctx.request);
	});
});

describe('sandbox escaping (security)', () => {
	const ctx = { request: { method: 'GET', url: 'https://api.test/x', headers: {} }, vars: { a: '1' } };
	const pre = (code: string) => runScript(code, ctx, 'pre', { timeoutMs: 500 });

	test.each([
		'__in.constructor.constructor("return process")()',
		'request.constructor.constructor("return process")()',
		'vars.constructor.constructor("return process")()',
		'console.log.constructor("return process")()',
		'expect.constructor("return process")()',
		'this.constructor.constructor("return process")()',
		'JSON.constructor("return process")()',
	])('%s cannot reach the host process', (attempt) => {
		const outcome = pre(`expect(typeof (${attempt})).to.equal("undefined");`);
		// either it is undefined (isolated) or the script errored — never a live host process
		const reached = outcome.error === undefined && outcome.assertions.some((a) => !a.passed);
		expect(reached).toBe(false);
	});

	test('the host realm is not reachable through a callback the script was handed', () => {
		const outcome = pre('vars.a = "2"; expect(typeof vars.constructor).to.equal("function");');
		expect(outcome.error).toBeUndefined();
	});

	test('setEnv is the only way to persist a variable', () => {
		const outcome = pre('vars.temp = "x"; setEnv("token", "abc"); setEnv("gone", null);');
		expect(outcome.vars.temp).toBe('x');
		expect(outcome.envChanges).toEqual({ token: 'abc', gone: null });
	});

	test('a script that never calls setEnv writes nothing', () => {
		expect(pre('vars.a = "changed";').envChanges).toEqual({});
	});

	test.each(['__proto__', 'constructor', 'prototype'])('setEnv refuses the reserved key %s', (key) => {
		const outcome = pre(`setEnv(${JSON.stringify(key)}, 'x');`);
		expect(outcome.error).toContain('reserved key');
		expect(outcome.envChanges).toEqual({});
	});

	test('a refused key does not pollute prototypes on the host', () => {
		pre("setEnv('__proto__', 'polluted');");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test('user code cannot replace the snapshot reader', () => {
		const outcome = pre(
			"vars.kept = 'yes'; setEnv('a', '1'); __snapshot = function () { return JSON.stringify({ logs: [], assertions: [], envChanges: {}, request: {}, vars: {} }); };"
		);
		expect(outcome.vars.kept).toBe('yes');
		expect(outcome.envChanges).toEqual({ a: '1' });
	});

	test('the reader binding itself is immutable', () => {
		const outcome = pre("__read = function () { return '{}'; };");
		expect(outcome.error).toBeDefined();
		expect(outcome.error).not.toContain('    at ');
	});
});

describe('sandbox payload survives String.replace metacharacters', () => {
	// `String.replace` expands these in a replacement string; passing user data as one used to
	// corrupt it ($& became the marker, a backtick injected the rest of the prelude).
	const PAYLOADS = ['$&', '$$', '$`', "$'", '$1', '$&$&', 'a$&b$$c$`d$\'e$1f', '`${process.exit(1)}`'];

	test.each(PAYLOADS)('the body %s reaches the script byte-exact', (payload) => {
		const outcome = runScript('', { request: { method: 'POST', url: 'https://api.test/x', headers: {}, body: payload }, vars: { v: payload } }, 'pre');
		expect(outcome.error).toBeUndefined();
		expect(outcome.request.body).toBe(payload);
		expect(outcome.vars.v).toBe(payload);
	});

	test('a script still runs with a metacharacter in the payload', () => {
		const outcome = runScript(
			'console.log(request.body); expect(request.body).to.equal(vars.v);',
			{ request: { method: 'POST', url: 'https://api.test/x', headers: {}, body: "$&$`$'" }, vars: { v: "$&$`$'" } },
			'pre'
		);
		expect(outcome.error).toBeUndefined();
		expect(outcome.logs).toEqual(["$&$`$'"]);
		expect(outcome.assertions.map((a) => a.passed)).toEqual([true]);
	});
});
