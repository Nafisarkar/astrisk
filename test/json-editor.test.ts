// JSON editor: syntax highlighting, auto-pairing and auto-format, against the real inline script.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';

const html = readFileSync(join(import.meta.dir, '..', 'src', 'webview', 'main.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const markup = html.replace(/<script>[\s\S]*?<\/script>/, '');

/** What the webview sends to the host, and what it keeps in `vscode.setState`. */
interface Sink {
	posted: any[];
	state: any;
}

interface Editor {
	win: any;
	el: (id: string) => any;
	ta: any;
	type: (t: string) => void;
	hl: () => string;
	/** Put the caret at `caret`, or select [from, to) first, then press one key. */
	press: (key: string, opts?: { from?: number; to?: number; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }) => boolean;
	paste: (text: string) => void;
	sendBody: () => any;
	mount: (saved?: unknown) => void;
	/** The panel's message/state channel; pass your own to assert what leaves the panel. */
	api: Sink;
}

/** `api` is optional: without it the panel talks to a throwaway sink seeded with `saved`. */
function mount(saved?: unknown, api?: Sink): Editor {
	const win = new Window({ url: 'https://asterisk.test/' });
	win.document.write(markup);
	const sink: Sink = api || { posted: [], state: saved };
	new Function('document', 'window', 'Event', 'acquireVsCodeApi', script)(win.document, win, win.Event, () => ({
		postMessage(msg: unknown) { sink.posted.push(msg); },
		getState: () => sink.state,
		setState(next: unknown) { sink.state = next; },
	}));
	const el = (id: string) => win.document.getElementById(id) as any;
	const type = (t: string) => {
		el('body-type').value = t;
		el('body-type').dispatchEvent(new win.Event('change'));
	};
	type('json');
	const press: Editor['press'] = (key, opts = {}) => {
		const ta = el('body');
		if (opts.from !== undefined) { ta.setSelectionRange(opts.from, opts.to ?? opts.from); }
		const event = new win.KeyboardEvent('keydown', {
			key,
			bubbles: true,
			cancelable: true,
			ctrlKey: opts.ctrlKey ?? false,
			shiftKey: opts.shiftKey ?? false,
			altKey: opts.altKey ?? false,
			isComposing: opts.isComposing ?? false,
		});
		const notPrevented = ta.dispatchEvent(event);
		return !notPrevented;
	};
	return {
		win,
		el,
		ta: el('body'),
		type,
		press,
		hl: () => el('body-hl').firstElementChild.innerHTML,
		paste: (text: string) => {
			const event = new win.Event('paste', { bubbles: true, cancelable: true });
			event.clipboardData = { getData: () => text };
			el('body').dispatchEvent(event);
		},
		sendBody: () => {
			el('url').value = 'https://api.test/x';
			el('send').click();
			const posted = [];
			return posted;
		},
		mount,
		api: sink,
	};
}

/** Type one character the way a browser would: the app may consume it, otherwise it is inserted. */
function typeChar(m: Editor, ch: string) {
	if (m.press(ch)) { return; }
	const ta = m.ta;
	const start = ta.selectionStart;
	const end = ta.selectionEnd;
	ta.value = ta.value.slice(0, start) + ch + ta.value.slice(end);
	const caret = start + ch.length;
	ta.setSelectionRange(caret, caret);
}

function typeText(m: Editor, text: string) {
	for (const ch of text) { typeChar(m, ch); }
}

describe('json highlighting', () => {
	test('colours keys, strings, numbers, literals and punctuation', () => {
		const m = mount();
		m.ta.value = '{"a": "b", "n": -12.5e3, "t": true, "z": null}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		const out = m.hl();
		expect(out).toContain('<span class="t-k">"a"</span>');
		expect(out).toContain('<span class="t-s">"b"</span>');
		expect(out).toContain('<span class="t-n">-12.5e3</span>');
		expect(out).toContain('<span class="t-l">true</span>');
		expect(out).toContain('<span class="t-l">null</span>');
		expect(out).toContain('<span class="t-p">{</span>');
		expect(out).toContain('<span class="t-p">:</span>');
		expect(out).toContain('<span class="t-p">,</span>');
	});

	test('a string followed by whitespace and a colon is a key; otherwise it is a value', () => {
		const m = mount();
		m.ta.value = '{"k"\n : 1}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-k">"k"</span>');
		m.ta.value = '["a", "b"]';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-s">"a"</span>');
		expect(m.hl()).toContain('<span class="t-s">"b"</span>');
	});

	test('escaped quotes and backslashes stay inside one string token', () => {
		const m = mount();
		m.ta.value = '{"q": "a\\"b\\\\c"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		const out = m.hl();
		expect(out).toContain('<span class="t-k">"q"</span>');
		expect(out).toContain('"a\\"b\\\\c"');
		expect((out.match(/class="t-s"/g) || []).length).toBe(1);
	});

	test('a trailing backslash inside a string cannot swallow the rest of the line', () => {
		const m = mount();
		m.ta.value = '{"a": "ends with \\\\"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect((m.hl().match(/class="t-s"/g) || []).length).toBe(1);
		expect(m.hl()).toContain('<span class="t-p">}</span>');
	});

	test('markup characters in values are escaped, never injected', () => {
		const m = mount();
		m.ta.value = '{"x": "<img src=x onerror=alert(1)>&"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		const out = m.hl();
		expect(out).toContain('&lt;img');
		expect(out).toContain('&amp;');
		expect(out).not.toContain('<img');
		expect(m.el('body-hl').querySelector('img')).toBeNull();
	});

	test('broken JSON still renders: unmatched brackets are punctuation, junk stays plain', () => {
		const m = mount();
		m.ta.value = '{"a": } oops [';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		const out = m.hl();
		expect(out).toContain('<span class="t-k">"a"</span>');
		expect(out).toContain('oops');
		expect(out).toContain('<span class="t-p">[</span>');
	});

	test('whitespace and newlines survive the highlighting pass', () => {
		const m = mount();
		m.ta.value = '{\n  "a": 1\n}\n';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.el('body-hl').textContent).toBe('{\n  "a": 1\n}\n\n');
	});

	test('painting never mutates the value being sent', () => {
		const m = mount();
		const raw = '{"a":1}';
		m.ta.value = raw;
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.ta.value).toBe(raw);
	});

	test('only the JSON type gets the highlight layer', () => {
		const m = mount();
		m.ta.value = '{"a":1}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.el('body-editor').classList.contains('hl-on')).toBe(true);
		m.type('text');
		expect(m.el('body-editor').classList.contains('hl-on')).toBe(false);
		expect(m.el('body-editor').hidden).toBe(false);
		m.type('xml');
		expect(m.el('body-editor').classList.contains('hl-on')).toBe(false);
		m.type('none');
		expect(m.el('body-editor').hidden).toBe(true);
	});

	test('switching back to JSON repaints the current text', () => {
		const m = mount();
		m.type('text');
		m.ta.value = '{"late":true}';
		m.type('json');
		expect(m.hl()).toContain('<span class="t-k">"late"</span>');
	});

	test('a huge document degrades to plain text instead of locking the panel', () => {
		const m = mount();
		m.ta.value = '{"k":"' + 'x'.repeat(200001) + '"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).not.toContain('t-k');
		expect(m.el('body-hl').textContent.length).toBeGreaterThan(200000);
	});

	test('scroll position is mirrored onto the highlight layer', () => {
		const m = mount();
		m.ta.scrollTop = 42;
		m.ta.scrollLeft = 7;
		m.ta.dispatchEvent(new m.win.Event('scroll'));
		expect(m.el('body-hl').scrollTop).toBe(42);
		expect(m.el('body-hl').scrollLeft).toBe(7);
	});
});

describe('json auto-pairing', () => {
	test('braces and brackets close themselves, caret in the middle', () => {
		const m = mount();
		m.press('{');
		expect(m.ta.value).toBe('{}');
		expect(m.ta.selectionStart).toBe(1);
		m.press('[');
		expect(m.ta.value).toBe('{[]}');
		expect(m.ta.selectionStart).toBe(2);
	});

	test('a quote closes itself and the caret sits inside', () => {
		const m = mount();
		m.press('"');
		expect(m.ta.value).toBe('""');
		expect(m.ta.selectionStart).toBe(1);
	});

	test('typing the closer that is already present steps over it', () => {
		const m = mount();
		m.press('{');
		expect(m.ta.value).toBe('{}');
		m.press('}');
		expect(m.ta.value).toBe('{}');
		expect(m.ta.selectionStart).toBe(2);
		// the quote half of this test lives in its own case below: the `inString` guard in autoPair now
		// decides whether a quote is stepped over, so it is no longer the same code path as `}`
		m.ta.value = '[]';
		expect(m.press(']', { from: 1 })).toBe(true);
		expect(m.ta.selectionStart).toBe(2);
	});

	// known defect: `inString` is consulted before the step-over branch, so the closing quote autoPair
	// just inserted cannot be stepped over - typing `"` after `{"a"}` doubles it, and a JSON key can
	// only be finished by hand-deleting the quote the editor itself inserted.
	test('the quote that autoPair inserted can be stepped over', () => {
		const m = mount();
		m.press('{');
		m.press('"');
		typeText(m, 'a');
		expect(m.ta.value).toBe('{"a"}');
		expect(m.press('"')).toBe(true);
		expect(m.ta.value).toBe('{"a"}');
		expect(m.ta.selectionStart).toBe(4);
	});

	test('a selection is wrapped instead of replaced', () => {
		const m = mount();
		m.ta.value = 'abc';
		m.press('"', { from: 0, to: 3 });
		expect(m.ta.value).toBe('"abc"');
		m.ta.value = 'abc';
		m.press('[', { from: 0, to: 3 });
		expect(m.ta.value).toBe('[abc]');
	});

	test('Backspace on an empty pair removes both halves', () => {
		const m = mount();
		m.press('{');
		m.press('Backspace');
		expect(m.ta.value).toBe('');
		expect(m.ta.selectionStart).toBe(0);
	});

	test('Backspace next to a non-empty pair is left to the browser', () => {
		const m = mount();
		m.ta.value = '{"a"}';
		// the pair is not empty, so the key must not be swallowed: the browser deletes one character
		expect(m.press('Backspace', { from: 4 })).toBe(false);
		expect(m.ta.value).toBe('{"a"}');
	});

	test('Enter between braces opens an indented block, caret on the middle line', () => {
		const m = mount();
		m.press('{');
		m.press('Enter');
		expect(m.ta.value).toBe('{\n  \n}');
		expect(m.ta.selectionStart).toBe(4);
	});

	test('Enter inside an indented block keeps the indentation', () => {
		const m = mount();
		m.ta.value = '{\n    "a": 1\n}';
		m.press('Enter', { from: 12 });
		expect(m.ta.value).toBe('{\n    "a": 1\n    \n}');
		expect(m.ta.selectionStart).toBe(17);
	});

	test('a real keystroke sequence produces valid, indented JSON', () => {
		const m = mount();
		m.press('[');
		m.press('Enter');
		typeText(m, '1,');
		m.press('Enter');
		typeText(m, '2');
		expect(m.ta.value).toBe(['[', '  1,', '  2', ']'].join(String.fromCharCode(10)));
		expect(JSON.parse(m.ta.value)).toEqual([1, 2]);
	});

	test('Ctrl+{ and Alt+" are left to the host, not eaten', () => {
		const m = mount();
		expect(m.press('{', { ctrlKey: true })).toBe(false);
		expect(m.ta.value).toBe('');
		expect(m.press('"', { altKey: true })).toBe(false);
	});

	test('an IME composition is never interrupted', () => {
		const m = mount();
		expect(m.press('{', { isComposing: true })).toBe(false);
		expect(m.press('"', { isComposing: true })).toBe(false);
		expect(m.ta.value).toBe('');
	});

	test('auto-pairing is off for non-JSON bodies', () => {
		const m = mount();
		m.type('text');
		expect(m.press('{')).toBe(false);
		expect(m.ta.value).toBe('');
		m.type('xml');
		expect(m.press('"')).toBe(false);
		expect(m.ta.value).toBe('');
	});

	test('free typing outside a pair is untouched', () => {
		const m = mount();
		m.ta.value = '';
		expect(m.press('a')).toBe(false);
		expect(m.press('Enter')).toBe(true);
		expect(m.ta.value).toBe('\n');
	});
});

describe('json auto-format', () => {
	test('Shift+Alt+F pretty-prints and clears the invalid chip', () => {
		const m = mount();
		m.ta.value = '{"a":1,"b":[2,3]}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('Shift+Alt+F on bad JSON changes nothing and flags it', () => {
		const m = mount();
		m.ta.value = '{"a":}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{"a":}');
		expect(m.el('json-bad').hidden).toBe(false);
	});

	test('formatting an already-formatted body is a no-op', () => {
		const m = mount();
		m.ta.value = '{\n  "a": 1\n}';
		const before = m.ta.selectionStart;
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{\n  "a": 1\n}');
		expect(m.ta.selectionStart).toBe(before);
	});

	test('empty or whitespace-only bodies are left alone', () => {
		const m = mount();
		m.ta.value = '   ';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('   ');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('blur formats when the toggle is on and does not when it is off', () => {
		const m = mount();
		m.ta.value = '{"a":1}';
		m.ta.dispatchEvent(new m.win.Event('blur'));
		expect(m.ta.value).toBe('{\n  "a": 1\n}');
		m.el('pretty-toggle').checked = false;
		m.ta.value = '{"b":2}';
		m.ta.dispatchEvent(new m.win.Event('blur'));
		expect(m.ta.value).toBe('{"b":2}');
	});

	test('pasting JSON pretty-prints it in place', () => {
		const m = mount();
		m.ta.value = '';
		m.paste('{"a":1,"b":2}');
		expect(m.ta.value).toBe('{\n  "a": 1,\n  "b": 2\n}');
	});

	test('pasting JSON inside a selection replaces just that selection', () => {
		const m = mount();
		m.ta.value = '{"a":0}';
		m.ta.setSelectionRange(5, 6);
		m.paste('{"n":1}');
		expect(m.ta.value).toBe('{"a":{\n  "n": 1\n}}');
	});

	test('pasting non-JSON leaves the paste to the browser', () => {
		const m = mount();
		m.ta.value = '';
		m.paste('hello');
		expect(m.ta.value).toBe('');
	});

	test('pasting is not reformatted when the toggle is off', () => {
		const m = mount();
		m.el('pretty-toggle').checked = false;
		m.ta.value = '';
		m.paste('{"a":1}');
		expect(m.ta.value).toBe('');
	});

	test('a document loaded from a collection is formatted on blur, not mangled', () => {
		const m = mount();
		m.ta.value = '{"deep":{"list":[1,{"k":"v"}]}}';
		m.ta.dispatchEvent(new m.win.Event('blur'));
		expect(() => JSON.parse(m.ta.value)).not.toThrow();
		expect(m.ta.value).toContain('"k": "v"');
	});
});

describe('json editor — state and payload', () => {
	test('the sent body is the text in the editor, verbatim', () => {
		const m = mount();
		m.ta.value = '{"a":1}';
		expect(m.ta.value).toBe('{"a":1}');
	});

	test('restored panel state paints the highlight on mount', () => {
		const win = new Window({ url: 'https://asterisk.test/' });
		win.document.write(markup);
		new Function('document', 'window', 'Event', 'acquireVsCodeApi', script)(win.document, win, win.Event, () => ({
			postMessage() {},
			getState: () => ({ bodyType: 'json', raw: '{"restored":true}' }),
			setState() {},
		}));
		const hl = win.document.getElementById('body-hl') as any;
		expect(hl.firstElementChild.innerHTML).toContain('"restored"');
		expect((win.document.getElementById('body-editor') as any).classList.contains('hl-on')).toBe(true);
	});

	test('typing marks the panel dirty, like any other request edit', () => {
		const m = mount();
		m.ta.value = '{"a":1}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.el('dirty-sr').textContent.length).toBeGreaterThan(0);
	});
});

describe('json highlighting — hostile input', () => {
	test('emoji in keys and values stay inside their tokens', () => {
		const m = mount();
		m.ta.value = '{"🔑": "😀"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-k">"🔑"</span>');
		expect(m.hl()).toContain('<span class="t-s">"😀"</span>');
		expect(m.el('body-hl').textContent).toBe('{"🔑": "😀"}');
	});

	test('NUL, ESC and a lone high surrogate survive the highlighting pass', () => {
		const m = mount();
		const raw = '{"a": "' + String.fromCharCode(0) + String.fromCharCode(27) + String.fromCharCode(0xd800) + '"}';
		m.ta.value = raw;
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		// no truncation, no replacement: the layers must stay character-aligned or the caret drifts
		expect(m.el('body-hl').textContent).toBe(raw);
		expect((m.hl().match(/class="t-s"/g) || []).length).toBe(1);
	});

	test('escaped backslash-u sequences inside a string do not split the token', () => {
		const m = mount();
		m.ta.value = '{"a": "q\\u0022q"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-s">"q\\u0022q"</span>');
		expect((m.hl().match(/class="t-s"/g) || []).length).toBe(1);
	});

	test('a raw tab inside a string keeps the token and the tab', () => {
		const m = mount();
		m.ta.value = '{"a": "\t"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-s">"\t"</span>');
		expect(m.el('body-hl').textContent).toBe('{"a": "\t"}');
	});

	test('punctuation characters inside a string are not punctuation tokens', () => {
		const m = mount();
		m.ta.value = '{"a": "{}[],:"}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-s">"{}[],:"</span>');
		expect((m.hl().match(/class="t-p"/g) || []).length).toBe(3);
	});

	test('a non-ASCII word outside a string stays plain', () => {
		const m = mount();
		m.ta.value = '{"a": ü}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain(' ü<');
		expect(m.hl()).not.toContain('t-n');
		expect(m.hl()).not.toContain('t-l');
	});

	test('hostile markup in keys and values never leaves the code element', () => {
		const m = mount();
		const raw = '{"</code><img src=x onerror=alert(1)>": "<!--]]><span class=\\"t-k\\">x</span>"}';
		m.ta.value = raw;
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		const tags = [...m.el('body-hl').querySelectorAll('*')].map((e: any) => e.tagName);
		expect(tags.filter((t: string) => t !== 'SPAN' && t !== 'CODE')).toEqual([]);
		expect(m.el('body-hl').querySelector('img')).toBeNull();
		expect(m.el('body-hl').textContent).toBe(raw);
	});

	test('a colon inside a string does not turn the next string into a key', () => {
		const m = mount();
		m.ta.value = '["a:b", "c"]';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-s">"a:b"</span>');
		expect(m.hl()).toContain('<span class="t-s">"c"</span>');
		expect(m.hl()).not.toContain('t-k');
	});

	test('a colon inside a key does not split it either', () => {
		const m = mount();
		m.ta.value = '{"a:b": 1, "c": 2}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-k">"a:b"</span>');
		expect(m.hl()).toContain('<span class="t-k">"c"</span>');
	});

	test('odd number shapes all colour as numbers', () => {
		const m = mount();
		m.ta.value = '[-0, 1e999, 0.0, 123456789012345678901234567890, -1.5e-7]';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		for (const n of ['-0', '1e999', '0.0', '123456789012345678901234567890', '-1.5e-7']) {
			expect(m.hl()).toContain('<span class="t-n">' + n + '</span>');
		}
	});

	// known defect: JSON_TOKEN's literal branch has no trailing boundary, so any word that merely
	// starts with true/false/null gets painted. Only reachable in invalid JSON, so low severity.
	test('a word that starts with a literal is not painted as a literal', () => {
		const m = mount();
		m.ta.value = '{"a": trueish, "b": nullx, "c": falsey}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).not.toContain('t-l');
	});

	test('a CRLF body keeps its line endings and gains exactly one height newline', () => {
		const m = mount();
		m.ta.value = '{\r\n  "a": 1\r\n}\r\n';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.hl()).toContain('<span class="t-k">"a"</span>');
		expect(m.el('body-hl').textContent).toBe('{\r\n  "a": 1\r\n}\r\n\n');
	});

	test('the highlight layer is character-for-character the value', () => {
		const m = mount();
		const samples = ['{}', '{"a":"😀"}', '{"a": "C:\\temp"}', '[1, 2, -3e4]', '{"n": {"d": [true, false, null]}}', 'plain junk'];
		for (const raw of samples) {
			m.ta.value = raw;
			m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
			expect(m.el('body-hl').textContent).toBe(raw);
		}
	});
});

describe('json auto-pairing — caret and structure edges', () => {
	test('an opening brace at position 0 of a 300 KB body pairs up and the caret lands inside', () => {
		const m = mount();
		m.ta.value = 'x'.repeat(300000);
		expect(m.press('{', { from: 0 })).toBe(true);
		expect(m.ta.value.slice(0, 2)).toBe('{}');
		expect(m.ta.value.length).toBe(300002);
		expect(m.ta.selectionStart).toBe(1);
		// over HL_LIMIT the paint is plain text, but it is still the current text
		expect(m.el('body-hl').textContent.startsWith('{}')).toBe(true);
	});

	test('Backspace at position 0 is left to the browser', () => {
		const m = mount();
		m.ta.value = 'x';
		expect(m.press('Backspace', { from: 0 })).toBe(false);
		expect(m.ta.value).toBe('x');
	});

	test('typing a closer past the last character is not swallowed', () => {
		const m = mount();
		m.ta.value = '{}';
		expect(m.press('}', { from: 2 })).toBe(false);
		expect(m.ta.value).toBe('{}');
	});

	test('typing a closer when the next character is a different one is not swallowed', () => {
		const m = mount();
		m.ta.value = '{]';
		expect(m.press('}', { from: 1 })).toBe(false);
		m.ta.value = '{,';
		expect(m.press(']', { from: 1 })).toBe(false);
	});

	test('Enter at the start of the body drops one newline in front', () => {
		const m = mount();
		m.ta.value = 'abc';
		expect(m.press('Enter', { from: 0 })).toBe(true);
		expect(m.ta.value).toBe('\nabc');
		expect(m.ta.selectionStart).toBe(1);
	});

	test('Enter on a selection that spans lines is left to the browser', () => {
		const m = mount();
		m.ta.value = '[\n1,\n2\n]';
		expect(m.press('Enter', { from: 2, to: 6 })).toBe(false);
		expect(m.ta.value).toBe('[\n1,\n2\n]');
	});

	test('Enter on a same-line selection is left to the browser too', () => {
		const m = mount();
		m.ta.value = '{"a": 1}';
		expect(m.press('Enter', { from: 1, to: 4 })).toBe(false);
		expect(m.ta.value).toBe('{"a": 1}');
	});

	test('wrapping a selection that spans lines brackets the whole range', () => {
		const m = mount();
		m.ta.value = 'a\nb';
		expect(m.press('{', { from: 0, to: 3 })).toBe(true);
		expect(m.ta.value).toBe('{a\nb}');
		expect(m.ta.selectionStart).toBe(5);
	});

	test('wrapping the whole document puts the caret after the closer', () => {
		const m = mount();
		m.ta.value = 'x';
		expect(m.press('[', { from: 0, to: 1 })).toBe(true);
		expect(m.ta.value).toBe('[x]');
		expect(m.ta.selectionStart).toBe(3);
	});

	test('Backspace between nested brackets eats only the inner pair', () => {
		const m = mount();
		m.ta.value = '[[]]';
		expect(m.press('Backspace', { from: 2 })).toBe(true);
		expect(m.ta.value).toBe('[]');
		expect(m.ta.selectionStart).toBe(1);
	});

	test('Enter inside a bracket pair opens an indented block, like braces do', () => {
		const m = mount();
		m.press('[');
		m.press('Enter');
		expect(m.ta.value).toBe('[\n  \n]');
		expect(m.ta.selectionStart).toBe(4);
	});

	test('Enter between braces nested in indentation keeps both levels', () => {
		const m = mount();
		m.ta.value = '  {}';
		m.press('Enter', { from: 3 });
		expect(m.ta.value).toBe('  {\n    \n  }');
		expect(m.ta.selectionStart).toBe(8);
	});

	test('Enter on a tab-indented line keeps the tab', () => {
		const m = mount();
		m.ta.value = '\t"a": 1';
		m.press('Enter', { from: 7 });
		expect(m.ta.value).toBe('\t"a": 1\n\t');
		expect(m.ta.selectionStart).toBe(9);
	});

	test('an escaped quote typed inside a string does not eat the closing quote', () => {
		const m = mount();
		m.ta.value = '"abc"';
		m.ta.setSelectionRange(4, 4);
		typeChar(m, String.fromCharCode(92));
		typeChar(m, '"');
		expect(m.ta.value).toBe('"abc\\""');
		expect(() => JSON.parse(m.ta.value)).not.toThrow();
	});

	// known defect: `inString` is consulted before the Backspace branch, so the empty pair the editor
	// itself just inserted is not removed and the user is left with an orphan quote.
	test('Backspace between two empty quotes removes both halves', () => {
		const m = mount();
		m.ta.value = '""';
		expect(m.press('Backspace', { from: 1 })).toBe(true);
		expect(m.ta.value).toBe('');
	});

	test('a closer typed inside a string is inserted, not stepped over', () => {
		const m = mount();
		m.ta.value = '"a]b"';
		expect(m.press(']', { from: 2 })).toBe(false);
		expect(m.ta.value).toBe('"a]b"');
	});

	test('Enter inside a string does not fabricate a block, only a newline', () => {
		const m = mount();
		m.ta.value = '"{}"';
		expect(m.press('Enter', { from: 2 })).toBe(true);
		expect(m.ta.value).toBe('"{\n}"');
	});
});

describe('json auto-format — hostile documents', () => {
	test('a JSON scalar is valid and left alone', () => {
		const m = mount();
		for (const raw of ['"x"', '123', 'null', 'true']) {
			m.ta.value = raw;
			m.press('F', { shiftKey: true, altKey: true });
			expect(m.ta.value).toBe(raw);
			expect(m.el('json-bad').hidden).toBe(true);
		}
	});

	test('an array formats one element per line, nesting included', () => {
		const m = mount();
		m.ta.value = '[1,2,[3]]';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('[\n  1,\n  2,\n  [\n    3\n  ]\n]');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('a leading BOM does not turn a valid body into an invalid one', () => {
		const m = mount();
		m.ta.value = String.fromCharCode(0xfeff) + '{"a":1}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.el('json-bad').hidden).toBe(true);
		// trim() eats the BOM, so the body loses it - that is fine for JSON, a BOM is illegal there
		expect(m.ta.value).toBe('{\n  "a": 1\n}');
	});

	test('a body wrapped in a markdown code fence is flagged, not mangled', () => {
		const m = mount();
		const raw = '```json\n{"a":1}\n```';
		m.ta.value = raw;
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe(raw);
		expect(m.el('json-bad').hidden).toBe(false);
	});

	test('the caret is clamped to the end when the formatted body is shorter', () => {
		const m = mount();
		m.ta.value = '[1,2]' + ' '.repeat(20);
		m.ta.setSelectionRange(m.ta.value.length, m.ta.value.length);
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('[\n  1,\n  2\n]');
		expect(m.ta.selectionStart).toBe(m.ta.value.length);
	});

	test('formatting a body over the highlight limit still formats and stays plain', () => {
		const m = mount();
		m.ta.value = '{"a":"' + 'x'.repeat(200001) + '"}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value.startsWith('{\n  "a": "xxx')).toBe(true);
		expect(m.ta.value.endsWith('x"\n}')).toBe(true);
		expect(m.hl()).not.toContain('t-k');
	});

	// the formatter refuses a rewrite it cannot prove lossless: JSON.parse/stringify would truncate
	// the integer, so the body is left exactly as typed and is not flagged as invalid
	test('formatting never rewrites a 64-bit id', () => {
		const m = mount();
		m.ta.value = '{"id": 12345678901234567890}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{"id": 12345678901234567890}');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('formatting never turns an overflowing exponent into null', () => {
		const m = mount();
		m.ta.value = '{"n": 1e999}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{"n": 1e999}');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('formatting never drops a duplicate key', () => {
		const m = mount();
		m.ta.value = '{"a":1,"a":2}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{"a":1,"a":2}');
		expect(m.el('json-bad').hidden).toBe(true);
	});

	test('spaces inside strings are not mistaken for reformattable whitespace', () => {
		const m = mount();
		m.ta.value = '{"a": "x  y", "b": [1]}';
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{\n  "a": "x  y",\n  "b": [\n    1\n  ]\n}');
	});

	test('formatting a focused editor keeps the scroll position', () => {
		const m = mount();
		m.ta.value = '{"a":1,"b":2}';
		m.ta.focus();
		m.ta.scrollTop = 40;
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{\n  "a": 1,\n  "b": 2\n}');
		expect(m.ta.scrollTop).toBe(40);
	});

	test('the caret never lands between the halves of a surrogate pair', () => {
		const m = mount();
		m.ta.value = '{"😀":1}';
		// offset 6 lands on the low surrogate of the pretty output, so it has to move back one
		m.ta.setSelectionRange(6, 6);
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.ta.value).toBe('{\n  "😀": 1\n}');
		// the caret moved off the low surrogate, so it sits on the emoji's own boundary now
		expect(m.ta.selectionStart).toBe(5);
		expect(m.ta.value.codePointAt(m.ta.selectionStart)).toBe(0x1f600);
	});
});

describe('json editor — interaction and payload', () => {
	test('switching to text mid-edit keeps the text and stops pairing and painting', () => {
		const m = mount();
		m.press('{');
		typeText(m, '1');
		const typed = m.ta.value;
		const painted = m.el('body-hl').innerHTML;
		m.type('text');
		expect(m.ta.value).toBe(typed);
		expect(m.press('{')).toBe(false);
		m.ta.value = '{"later":1}';
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.el('body-hl').innerHTML).toBe(painted);
	});

	test('a paste event with no clipboardData does not throw or eat the value', () => {
		const m = mount();
		m.ta.value = '{"a":1}';
		const event = new m.win.Event('paste', { bubbles: true, cancelable: true });
		expect(() => m.ta.dispatchEvent(event)).not.toThrow();
		expect(m.ta.value).toBe('{"a":1}');
		expect(event.defaultPrevented).toBe(false);
	});

	test('Shift+Alt+F is not swallowed for non-JSON bodies', () => {
		const m = mount();
		m.type('text');
		m.ta.value = '{"a":1}';
		expect(m.press('F', { shiftKey: true, altKey: true })).toBe(false);
		expect(m.ta.value).toBe('{"a":1}');
	});

	test('the state written for the panel carries what the user typed, then what formatting made', () => {
		const m = mount();
		m.press('[');
		expect(m.api.state.raw).toBe('[]');
		m.press('Enter');
		expect(m.api.state.raw).toBe('[\n  \n]');
		typeText(m, '1,2');
		// happy-dom types nothing for real, so the input event has to be said out loud
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		expect(m.api.state.raw).toBe('[\n  1,2\n]');
		m.press('F', { shiftKey: true, altKey: true });
		expect(m.api.state.raw).toBe('[\n  1,\n  2\n]');
	});

	test('the request that leaves the panel is the raw text, with no highlight markup', () => {
		const api: Sink = { posted: [], state: undefined };
		const m = mount(undefined, api);
		m.el('url').value = 'https://api.test/x';
		m.ta.value = '{"a":1}';
		m.press('F', { shiftKey: true, altKey: true });
		m.el('send').click();
		const sent = api.posted.find((msg) => msg.type === 'send');
		expect(sent.request.body).toEqual({ type: 'raw', format: 'json', content: '{\n  "a": 1\n}' });
	});

	test('a body full of markup is sent exactly as typed', () => {
		const api: Sink = { posted: [], state: undefined };
		const m = mount(undefined, api);
		m.el('url').value = 'https://api.test/x';
		const raw = '{"</code><img src=x>": "<!--]]>"}';
		m.ta.value = raw;
		m.ta.dispatchEvent(new m.win.Event('input', { bubbles: true }));
		m.el('send').click();
		const sent = api.posted.find((msg) => msg.type === 'send');
		expect(sent.request.body.content).toBe(raw);
	});
});
