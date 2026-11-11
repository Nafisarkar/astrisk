// Environments + variables — no vscode imports so it stays unit-testable under bun.
//
// One file next to the collections: `.asterisk/.environments.json`
//   { "active": "staging", "environments": { "staging": { "name": "staging", "vars": { "token": "abc" } } } }
// Every function is pure: the input document is never mutated, a new one comes back.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeName } from './store';

export const ENV_FILE = '.environments.json';

export interface Environment { name: string; vars: Record<string, string> }
export interface EnvDocument { active?: string; environments: Record<string, Environment> }

// ponytail: env names go through store's `sanitizeName`, so `''` / `'...'` become `'untitled'`
// and control chars never reach the file. Names live in JSON keys, not paths, so this is
// stricter than needed — but it matches the rest of the app and never throws.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const envName = (input: string) => {
	const safe = sanitizeName(input);
	return RESERVED.has(safe) ? `${safe}_` : safe;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function withActive(environments: Record<string, Environment>, active: string | undefined): EnvDocument {
	return active === undefined ? { environments } : { active, environments };
}

/** `.asterisk/.environments.json`. Missing file => { environments: {} }, never throws. */
export function readEnvs(root: string): EnvDocument {
	const file = join(root, ENV_FILE);
	if (!existsSync(file)) {return { environments: {} };}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		throw new Error(`Cannot read ${ENV_FILE}: invalid JSON`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`Cannot read ${ENV_FILE}: expected a JSON object`);
	}
	if (!isPlainObject(parsed.environments)) {
		throw new Error(`Cannot read ${ENV_FILE}: "environments" must be an object`);
	}

	const environments: Record<string, Environment> = {};
	for (const [key, value] of Object.entries(parsed.environments)) {
		if (RESERVED.has(key) || !isPlainObject(value)) {continue;}
		const vars: Record<string, string> = {};
		if (isPlainObject(value.vars)) {
			for (const [k, v] of Object.entries(value.vars)) {
				if (typeof v === 'string') {vars[k] = v;}
			}
		}
		environments[key] = { name: typeof value.name === 'string' ? value.name : key, vars };
	}
	const doc: EnvDocument = { environments };
	// A hand-edited file can point at an env that no longer exists; treat that as "no environment".
	if (typeof parsed.active === 'string' && Object.hasOwn(environments, parsed.active)) {doc.active = parsed.active;}
	return doc;
}

/** Pretty JSON + trailing newline (git-friendly), creates root if needed. */
export function writeEnvs(root: string, doc: EnvDocument): void {
	mkdirSync(root, { recursive: true });
	// ponytail: 2-space pretty JSON, one var per line — same reason as writeRequest.
	writeFileSync(join(root, ENV_FILE), JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/** Vars of the active environment; {} when there is none or `active` points nowhere. */
export function activeVars(doc: EnvDocument): Record<string, string> {
	if (!doc.active) {return {};}
	const env = Object.hasOwn(doc.environments, doc.active) ? doc.environments[doc.active] : undefined;
	return env ? { ...env.vars } : {};
}

/** $uuid, $timestamp (epoch seconds), $randomInt (0..1000) — injectable clock/random for tests. */
export function systemVars(now: number = Date.now(), random: () => number = Math.random): Record<string, string> {
	return {
		$uuid: randomUUID(),
		$timestamp: String(Math.floor(now / 1000)),
		// random() is [0, 1); floor(x * 1001) covers both ends (0 -> "0", 0.9999 -> "1000").
		$randomInt: String(Math.min(1000, Math.floor(random() * 1001))),
	};
}

/** System vars, then active env vars, then `extra` (extra wins). Flat map only. */
export function requestVars(doc: EnvDocument, extra?: Record<string, string>): Record<string, string> {
	return { ...systemVars(), ...activeVars(doc), ...extra };
}

/** Add an environment (empty vars) or return the existing one untouched — never wipes vars. */
export function addEnv(doc: EnvDocument, name: string): EnvDocument {
	const n = envName(name);
	const vars = { ...(Object.hasOwn(doc.environments, n) ? doc.environments[n].vars : undefined) };
	return withActive({ ...doc.environments, [n]: { name: n, vars } }, doc.active);
}

/** Remove an environment; clears `active` if it pointed at the removed one. */
export function removeEnv(doc: EnvDocument, name: string): EnvDocument {
	const n = envName(name);
	const environments = { ...doc.environments };
	delete environments[n];
	return withActive(environments, doc.active === n ? undefined : doc.active);
}

/** Rename an environment, preserving vars; no-op if `from` is missing or `to` exists. */
export function renameEnv(doc: EnvDocument, from: string, to: string): EnvDocument {
	if (from === to || !Object.hasOwn(doc.environments, from) || Object.hasOwn(doc.environments, to)) {return doc;}
	const target = envName(to);
	if (target !== to && Object.hasOwn(doc.environments, target)) {return doc;}
	const environments: Record<string, Environment> = {};
	for (const [key, env] of Object.entries(doc.environments)) {
		environments[key === from ? target : key] = key === from ? { name: target, vars: { ...env.vars } } : { ...env, vars: { ...env.vars } };
	}
	// `active` follows the rename instead of silently dangling.
	return withActive(environments, doc.active === from ? target : doc.active);
}

/** Set one variable in an environment (creates the env if absent); '' value deletes the key. */
export function setVar(doc: EnvDocument, envNameRaw: string, key: string, value: string): EnvDocument {
	const n = envName(envNameRaw);
	const current = Object.hasOwn(doc.environments, n) ? doc.environments[n] : undefined;
	const vars = { ...current?.vars };
	if (value === '') {delete vars[key];} else {vars[key] = value;}
	return withActive({ ...doc.environments, [n]: { name: n, vars } }, doc.active);
}

/** Switch active environment; unknown name clears it. */
export function setActive(doc: EnvDocument, name: string | undefined): EnvDocument {
	const next = name !== undefined && Object.hasOwn(doc.environments, name) ? name : undefined;
	return withActive({ ...doc.environments }, next);
}
