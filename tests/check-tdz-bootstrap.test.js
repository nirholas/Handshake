/**
 * scripts/check-tdz-bootstrap.mjs: the guard against a module bootstrapping
 * itself above the state it writes.
 *
 * The three cases below are the ones that actually shipped:
 *   - src/avatar-page.js  `avatar = await fetchAvatar(id)` before `let avatar`,
 *     which threw only in JavaScriptCore and took every /avatars/:id page down
 *     in Safari on iOS and macOS while Chrome stayed green.
 *   - src/three-tier-page.js  `_styled` read three frames below mount().
 *   - public/forever.js  `BTC_USD` read from a top-level render call.
 *
 * The "stays quiet" half matters just as much: a checker wired into the deploy
 * path earns its keep only if it never blocks a correct build.
 */

import { describe, it, expect } from 'vitest';
import { analyze } from '../scripts/check-tdz-bootstrap.mjs';

const names = (src) => analyze('t.js', src).map((f) => f.name).sort();

describe('check:tdz-bootstrap catches what shipped', () => {
	it('flags an assignment to a let declared below the bootstrap (the Safari-only case)', () => {
		const findings = analyze('avatar-page.js', `
			init().catch(renderError);
			async function init() {
				avatar = await fetchAvatar(id);
			}
			let avatar = null;
		`);
		expect(findings).toHaveLength(1);
		expect(findings[0].name).toBe('avatar');
		expect(findings[0].write).toBe(true);
		expect(findings[0].kind).toBe('let');
	});

	it('flags a synchronous read three calls below the bootstrap', () => {
		const findings = analyze('three-tier-page.js', `
			mount();
			function mount() { boot(); }
			function boot() { injectStyles(); }
			function injectStyles() { if (_styled) return; }
			let _styled = false;
		`);
		expect(findings.map((f) => f.name)).toEqual(['_styled']);
		expect(findings[0].write).toBe(false);
		expect(findings[0].chain).toBe('mount -> boot -> injectStyles');
	});

	it('flags a read of a const declared below the bootstrap', () => {
		expect(names(`
			renderFeeEstimate();
			function renderFeeEstimate() { return BTC_USD * 2; }
			const BTC_USD = 100;
		`)).toEqual(['BTC_USD']);
	});

	it('flags a class declared below the bootstrap', () => {
		expect(names(`
			boot();
			function boot() { return new Engine(); }
			class Engine {}
		`)).toEqual(['Engine']);
	});

	it('reports the call site and both line numbers so the fix is obvious', () => {
		const [f] = analyze('t.js', 'init();\nfunction init() { avatar = 1; }\nlet avatar;');
		expect(f).toMatchObject({ callName: 'init', callLine: 1, useLine: 2, declLine: 3 });
	});
});

describe('check:tdz-bootstrap stays quiet on correct code', () => {
	it('accepts the bootstrap moved below the declarations (the fix)', () => {
		expect(names(`
			let avatar = null;
			async function init() { avatar = await fetchAvatar(id); }
			init().catch(renderError);
		`)).toEqual([]);
	});

	it('accepts a reference that only runs after an await', () => {
		expect(names(`
			init();
			async function init() {
				const rec = await fetchAvatar(id);
				avatar = rec;
			}
			let avatar = null;
		`)).toEqual([]);
	});

	it('accepts a deferred bootstrap, because the callback runs after evaluation', () => {
		expect(names(`
			document.addEventListener('DOMContentLoaded', () => init());
			function init() { avatar = 1; }
			let avatar = null;
		`)).toEqual([]);
	});

	it('accepts var and function declarations, which are hoisted and initialized', () => {
		expect(names(`
			init();
			function init() { avatar = 1; return helper(); }
			var avatar = null;
			function helper() { return 1; }
		`)).toEqual([]);
	});

	it('does not confuse a local that shadows a module binding', () => {
		expect(names(`
			init();
			function init() { let avatar = 1; return avatar; }
			let avatar = null;
		`)).toEqual([]);
	});

	it('does not confuse a property that shares a binding name', () => {
		expect(names(`
			init();
			function init() { return rec.avatar + obj[0].avatar; }
			let avatar = null;
		`)).toEqual([]);
	});

	it('does not flag a binding declared above the bootstrap', () => {
		expect(names(`
			let avatar = null;
			init();
			function init() { avatar = 1; }
		`)).toEqual([]);
	});

	it('does not flag a body that only runs when the function is called later', () => {
		expect(names(`
			export function init() { avatar = 1; }
			let avatar = null;
		`)).toEqual([]);
	});
});

describe('the shipped browser modules stay clean', () => {
	it('reports nothing for the studio page that regressed', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../src/avatar-page.js', import.meta.url), 'utf8');
		expect(analyze('src/avatar-page.js', src)).toEqual([]);
	});
});
