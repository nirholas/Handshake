// Regression tests for the open-redirect guards (security audit 2026-07-23:
// unvalidated ?next= / ?return= params on the auth and paywall pages allowed
// attacker-controlled post-login redirects and javascript: hrefs).
//
// Two layers:
//   1. Behavior tests for the canonical guards in src/safe-next.js.
//   2. Drift tests asserting the inline copies shipped in the public pages
//      (which cannot import /src at runtime) stay byte-identical to the
//      canonical functions.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { safeNext, safeNavUrl } from '../src/safe-next.js';

describe('safeNext', () => {
	it('allows same-origin relative paths', () => {
		expect(safeNext('/dashboard')).toBe('/dashboard');
		expect(safeNext('/create')).toBe('/create');
		expect(safeNext('/dashboard/embed-policy?agent=abc#top')).toBe(
			'/dashboard/embed-policy?agent=abc#top',
		);
		expect(safeNext('/extension/auth-callback')).toBe('/extension/auth-callback');
		expect(safeNext('/%2f%2fevil.com')).toBe('/%2f%2fevil.com'); // stays a path
	});

	it('rejects absolute and protocol-relative URLs', () => {
		expect(safeNext('https://evil.com')).toBe('/dashboard');
		expect(safeNext('http://evil.com')).toBe('/dashboard');
		expect(safeNext('//evil.com')).toBe('/dashboard');
		expect(safeNext('///evil.com')).toBe('/dashboard');
		expect(safeNext('javascript:alert(1)')).toBe('/dashboard');
		expect(safeNext('data:text/html,x')).toBe('/dashboard');
	});

	it('rejects backslash normalization tricks', () => {
		expect(safeNext('/\\evil.com')).toBe('/dashboard');
		expect(safeNext('/\\/evil.com')).toBe('/dashboard');
		expect(safeNext('\\evil.com')).toBe('/dashboard');
	});

	it('rejects control characters', () => {
		expect(safeNext('/\tlogin')).toBe('/dashboard');
		expect(safeNext('/dash\nboard')).toBe('/dashboard');
		expect(safeNext('/dashboard')).toBe('/dashboard');
	});

	it('rejects empty and non-string input', () => {
		expect(safeNext('')).toBe('/dashboard');
		expect(safeNext(null)).toBe('/dashboard');
		expect(safeNext(undefined)).toBe('/dashboard');
		expect(safeNext(42)).toBe('/dashboard');
	});

	it('honors a custom fallback', () => {
		expect(safeNext('https://evil.com', '/create')).toBe('/create');
		expect(safeNext(null, '/dashboard/')).toBe('/dashboard/');
	});
});

describe('safeNavUrl', () => {
	it('allows same-origin relative paths', () => {
		expect(safeNavUrl('/')).toBe('/');
		expect(safeNavUrl('/pay/receipt?id=1')).toBe('/pay/receipt?id=1');
	});

	it('allows absolute http(s) URLs', () => {
		expect(safeNavUrl('https://example.com/resource')).toBe('https://example.com/resource');
		expect(safeNavUrl('http://example.com')).toBe('http://example.com/');
	});

	it('blocks script-capable and opaque schemes', () => {
		expect(safeNavUrl('javascript:alert(1)')).toBe('/');
		expect(safeNavUrl('JaVaScRiPt:alert(1)')).toBe('/');
		expect(safeNavUrl('  javascript:alert(1)')).toBe('/');
		expect(safeNavUrl('data:text/html,<script>alert(1)</script>')).toBe('/');
		expect(safeNavUrl('vbscript:msgbox(1)')).toBe('/');
		expect(safeNavUrl('file:///etc/passwd')).toBe('/');
	});

	it('blocks protocol-relative and backslash tricks', () => {
		expect(safeNavUrl('//evil.com')).toBe('/');
		expect(safeNavUrl('/\\evil.com')).toBe('/');
		expect(safeNavUrl('https:\\evil.com')).toBe('/');
	});

	it('falls back on empty, non-string, and unparseable input', () => {
		expect(safeNavUrl('')).toBe('/');
		expect(safeNavUrl(null)).toBe('/');
		expect(safeNavUrl('not a url')).toBe('/');
	});
});

// ── Inline-copy drift guard ──────────────────────────────────────────────────

const canonical = readFileSync(new URL('../src/safe-next.js', import.meta.url), 'utf8');

function canonicalSource(exportName) {
	const match = canonical.match(new RegExp(`export function ${exportName}[\\s\\S]*?\\n}`));
	if (!match) throw new Error(`canonical source for ${exportName} not found`);
	return match[0].replace('export function', 'function');
}

const copies = [
	['public/login.html', ['safeNext']],
	['public/register.html', ['safeNext']],
	['public/wallet-login.js', ['safeNext']],
	['public/wallet-connect-demo.html', ['safeNext']],
	['public/paywall.js', ['safeNavUrl']],
];

describe('inline copies stay in sync with src/safe-next.js', () => {
	for (const [file, fns] of copies) {
		for (const fn of fns) {
			it(`${file} carries the canonical ${fn}`, () => {
				const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
				expect(text.includes(canonicalSource(fn))).toBe(true);
			});
		}
	}
});
