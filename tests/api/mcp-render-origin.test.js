// api/_mcp/render.js and api/_mcp/origin.js — the two shared helpers behind
// every MCP tool that emits viewer HTML or an absolute link.
//
// render.js builds an HTML document from caller-supplied values, so its whole
// job is escaping: attribute values are one hazard, but the CSS ones are worse
// because they land inside a <style> declaration where HTML escaping does not
// stop a `;}` breakout. renderModelViewerHtml re-runs the sanitizers itself, so
// these tests hold that line for a caller that forgets them entirely.
//
// origin.js resolves the site origin used to build absolute URLs. It is the
// only place in the MCP tools allowed to guess, so both its precedence order
// and its refusal to invent an origin are pinned here.

import { describe, it, expect, afterEach } from 'vitest';

const {
	renderModelViewerHtml,
	formatAvatarList,
	safeCssValue,
	safeCssLength,
	safeHttpsUrl,
} = await import('../../api/_mcp/render.js');
const { resolveOrigin } = await import('../../api/_mcp/origin.js');

const ORIGIN_VARS = ['APP_ORIGIN', 'PUBLIC_ORIGIN', 'PUBLIC_APP_ORIGIN', 'VERCEL_URL'];
const SAVED = Object.fromEntries(ORIGIN_VARS.map((k) => [k, process.env[k]]));

function clearOriginEnv() {
	for (const k of ORIGIN_VARS) delete process.env[k];
}

afterEach(() => {
	for (const k of ORIGIN_VARS) {
		if (SAVED[k] === undefined) delete process.env[k];
		else process.env[k] = SAVED[k];
	}
});

// ── CSS + URL sanitizers ────────────────────────────────────────────────────
describe('render.js sanitizers', () => {
	it('passes ordinary CSS values and rejects anything that could close the rule', () => {
		expect(safeCssValue('transparent', 'fallback')).toBe('transparent');
		expect(safeCssValue('#0b0c10', 'fallback')).toBe('#0b0c10');
		expect(safeCssValue('rgb(11, 12, 16)', 'fallback')).toBe('rgb(11, 12, 16)');
		// A breakout attempt falls back rather than being partially escaped.
		expect(safeCssValue('red;}body{display:none', 'fallback')).toBe('fallback');
		expect(safeCssValue('url("javascript:alert(1)")', 'fallback')).toBe('fallback');
		expect(safeCssValue('a'.repeat(121), 'fallback')).toBe('fallback');
		expect(safeCssValue('', 'fallback')).toBe('fallback');
	});

	// Parens and slashes are legal in gradients, so the character class alone
	// still let a background smuggle in an external fetch: a beacon that leaks
	// every viewer's IP and referrer to whoever supplied the value.
	it('rejects url() even when every character is otherwise allowed', () => {
		expect(safeCssValue('url(//beacon.example/p.png)', 'transparent')).toBe('transparent');
		expect(safeCssValue('URL (//beacon.example/p.png)', 'transparent')).toBe('transparent');
		expect(safeCssValue('linear-gradient(#0b0c10, #6a5cff)', 'transparent')).toBe(
			'linear-gradient(#0b0c10, #6a5cff)',
		);
	});

	it('is idempotent, so re-sanitizing an already-clean value is a no-op', () => {
		for (const value of ['transparent', '#6a5cff', '0deg 80deg 2m', 'rgb(1, 2, 3)']) {
			expect(safeCssValue(safeCssValue(value, 'x'), 'x')).toBe(value);
		}
		for (const value of ['480px', '100%', '12.5rem', 'auto']) {
			expect(safeCssLength(safeCssLength(value, 'x'), 'x')).toBe(value);
		}
	});

	it('accepts only real CSS lengths', () => {
		expect(safeCssLength('480px', '1px')).toBe('480px');
		expect(safeCssLength('100%', '1px')).toBe('100%');
		expect(safeCssLength('auto', '1px')).toBe('auto');
		expect(safeCssLength('480px;}html{x:y', '1px')).toBe('1px');
		expect(safeCssLength('calc(100% - 10px)', '1px')).toBe('1px');
	});

	it('accepts only https posters, dropping script-bearing schemes', () => {
		expect(safeHttpsUrl('https://three.ws/p.png')).toBe('https://three.ws/p.png');
		expect(safeHttpsUrl('http://three.ws/p.png')).toBeUndefined();
		expect(safeHttpsUrl('javascript:alert(1)')).toBeUndefined();
		expect(safeHttpsUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
		expect(safeHttpsUrl('not a url')).toBeUndefined();
		expect(safeHttpsUrl(undefined)).toBeUndefined();
	});
});

// ── renderModelViewerHtml ───────────────────────────────────────────────────
describe('renderModelViewerHtml', () => {
	const BASE = {
		src: 'https://cdn.three.ws/a.glb',
		name: 'Nova',
		background: 'transparent',
		height: '480px',
		width: '100%',
		autoRotate: true,
		ar: true,
	};

	it('renders a complete viewer document with the caller-supplied model', () => {
		const html = renderModelViewerHtml(BASE);
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain('src="https://cdn.three.ws/a.glb"');
		expect(html).toContain('<title>Nova</title>');
		expect(html).toContain('alt="Nova"');
		expect(html).toContain('auto-rotate');
		expect(html).toContain('ar-modes="webxr scene-viewer quick-look"');
		expect(html).toContain('background:transparent');
		expect(html).toContain('width:100%;height:480px');
		// No AR link unless an arHref was supplied.
		expect(html).not.toContain('View in your space');
	});

	it('omits the optional attributes the caller left out', () => {
		const html = renderModelViewerHtml({ ...BASE, autoRotate: false, ar: false });
		expect(html).not.toContain('auto-rotate');
		expect(html).not.toContain('ar-modes');
		expect(html).not.toContain('poster=');
		expect(html).not.toContain('camera-orbit=');
	});

	it('renders the AR link when an arHref is supplied', () => {
		const html = renderModelViewerHtml({ ...BASE, arHref: 'https://three.ws/api/ar?u=x' });
		expect(html).toContain('href="https://three.ws/api/ar?u=x"');
		expect(html).toContain('View in your space');
		expect(html).toContain('rel="noopener"');
	});

	// The failure path that matters: a caller that skipped safeCssValue /
	// safeHttpsUrl must still not be able to escape the <style> declaration or
	// smuggle a script URL into an attribute.
	it('neutralizes unsanitized CSS and poster input from a forgetful caller', () => {
		const html = renderModelViewerHtml({
			...BASE,
			background: 'red;}body{background:url(https://evil.test/x)}',
			height: '480px;}*{display:none',
			width: '100%"><script>alert(1)</script>',
			cameraOrbit: '0deg 80deg 2m;}html{x:y}',
			poster: 'javascript:alert(1)',
		});
		expect(html).not.toContain('evil.test');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).not.toContain('javascript:alert(1)');
		expect(html).not.toContain('poster=');
		expect(html).not.toContain('camera-orbit=');
		// Fell back to the safe defaults instead.
		expect(html).toContain('background:transparent');
		expect(html).toContain('width:100%;height:480px');
	});

	it('escapes HTML metacharacters in the avatar name', () => {
		const html = renderModelViewerHtml({ ...BASE, name: '<img src=x onerror=alert(1)>' });
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});
});

// ── formatAvatarList ────────────────────────────────────────────────────────
describe('formatAvatarList', () => {
	const AVATARS = [
		{ name: 'Nova', slug: 'nova', id: 'a1', visibility: 'private', model_url: 'https://c/1.glb' },
		{ name: 'Rex', slug: 'rex', id: 'a2', visibility: 'public', model_url: null },
	];

	it('lists each avatar with its slug, id, and visibility', () => {
		const text = formatAvatarList(AVATARS);
		expect(text).toContain('Nova (slug: nova, id: a1)');
		expect(text).toContain('[private]');
		expect(text).toContain('https://c/1.glb');
		expect(text.split('\n')).toHaveLength(2);
	});

	it('hides visibility on the public gallery listing', () => {
		const text = formatAvatarList(AVATARS, { public: true });
		expect(text).not.toContain('[private]');
		expect(text).not.toContain('[public]');
	});

	it('tells the caller nothing matched instead of returning an empty string', () => {
		expect(formatAvatarList([])).toBe('No avatars found.');
	});
});

// ── resolveOrigin ───────────────────────────────────────────────────────────
describe('resolveOrigin', () => {
	it('prefers explicit env over the request Host header, without a trailing slash', () => {
		clearOriginEnv();
		process.env.APP_ORIGIN = 'https://three.ws/';
		expect(resolveOrigin({ headers: { host: 'preview.example' } })).toBe('https://three.ws');
	});

	it('falls back through the alternate env names', () => {
		clearOriginEnv();
		process.env.PUBLIC_ORIGIN = 'https://public.three.ws';
		expect(resolveOrigin({ headers: {} })).toBe('https://public.three.ws');

		clearOriginEnv();
		process.env.PUBLIC_APP_ORIGIN = 'https://app.three.ws';
		expect(resolveOrigin({ headers: {} })).toBe('https://app.three.ws');
	});

	it('derives https from the Host header, and http for local development', () => {
		clearOriginEnv();
		expect(resolveOrigin({ headers: { host: 'three.ws' } })).toBe('https://three.ws');
		expect(resolveOrigin({ headers: { host: 'localhost:3000' } })).toBe('http://localhost:3000');
		expect(resolveOrigin({ headers: { host: '127.0.0.1:3000' } })).toBe('http://127.0.0.1:3000');
		expect(resolveOrigin({ headers: { host: '[::1]:3000' } })).toBe('http://[::1]:3000');
	});

	// The loopback test used to be an unanchored alternation, so any remote host
	// merely CONTAINING the loopback literal was served an http:// origin and
	// every link built from it downgraded off TLS.
	it('treats a remote host that merely contains a loopback literal as https', () => {
		clearOriginEnv();
		expect(resolveOrigin({ headers: { host: 'evil-127.0.0.1.example.com' } })).toBe(
			'https://evil-127.0.0.1.example.com',
		);
		expect(resolveOrigin({ headers: { host: 'localhost.evil.example' } })).toBe(
			'https://localhost.evil.example',
		);
	});

	it('falls back to VERCEL_URL when there is no env origin and no Host', () => {
		clearOriginEnv();
		process.env.VERCEL_URL = 'three-ws.vercel.app';
		expect(resolveOrigin({ headers: {} })).toBe('https://three-ws.vercel.app');
	});

	// Failure path: guessing an origin would produce links that silently point at
	// the wrong host, so it throws instead.
	it('throws rather than invent an origin when nothing resolves', () => {
		clearOriginEnv();
		expect(() => resolveOrigin({ headers: {} })).toThrow(/cannot resolve site origin/);
		expect(() => resolveOrigin(undefined)).toThrow(/cannot resolve site origin/);
	});
});
