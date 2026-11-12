import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const docs = join(import.meta.dir, '..', 'docs');
const html = readFileSync(join(docs, 'index.html'), 'utf8');
const attrValues = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

test('every local asset referenced by the page exists on disk', () => {
  const local = attrValues.filter((v) => !/^(?:https?:|mailto:|#|data:)/i.test(v));
  expect(local).toContain('icon.svg');
  for (const url of local) {
    const file = join(docs, url.split(/[?#]/)[0]);
    expect(existsSync(file)).toBe(true);
  }
});

test('no external stylesheet, script, image or frame load', () => {
  const tags = [...html.matchAll(/<(img|script|link|iframe|source)\b[^>]*>/gi)].map((m) => m[0]);
  for (const tag of tags) {
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (url) expect(url).not.toMatch(/^https?:/i);
  }
  expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  expect(html).not.toMatch(/@import/i);
});

test('exactly one h1', () => {
  expect([...html.matchAll(/<h1\b/gi)].length).toBe(1);
});

test('html declares english', () => {
  expect(html).toMatch(/<html[^>]*\blang="en"/);
});

test('no blanket transitions', () => {
  expect(html).not.toMatch(/transition:\s*all\b/i);
  expect(html).not.toMatch(/transition-property:\s*all\b/i);
});

// a dead nav anchor or a copy button pointing at a missing id both fail silently in the browser
test('in-page links and copy targets resolve', () => {
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  expect(anchors.length).toBeGreaterThan(0);
  for (const id of anchors) expect(html).toContain(`id="${id}"`);

  const targets = [...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]);
  expect(targets.length).toBeGreaterThan(0);
  for (const id of targets) expect(html).toContain(`id="${id}"`);
});

// GitHub Pages runs Jekyll unless docs/.nojekyll exists, and Liquid would eat any
// {{...}} the copy ever grows. Deleting that file is a silent content bug, not a style one.
test('jekyll is disabled so no liquid token can be eaten', () => {
  expect(existsSync(join(docs, '.nojekyll'))).toBe(true);
  if (/\{\{/.test(html)) expect(existsSync(join(docs, '.nojekyll'))).toBe(true);
});
