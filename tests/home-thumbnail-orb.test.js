// Regression guard: the homepage must never synthesise an R2 thumbnail URL.
//
// The forge/avatar APIs already answer honestly — /api/explore returns
// `image: null` and /api/marketplace returns `thumbnail_url: null` when an
// avatar has no stored thumbnail (see api/explore.js `thumbnailUrl()`, which
// also drops legacy absolute `_og.png` keys). The homepage used to paper over
// that null by guessing `https://<bucket>.r2.dev/thumb/<avatarId>.png`.
//
// That object was never written for ~79% of public avatars, so R2 answered 404
// with a `text/plain` body. Chrome's Opaque Response Blocking then refused the
// response for an <img> request and logged net::ERR_BLOCKED_BY_ORB — five per
// homepage load, every visitor. The `.pg-avatar-initial` / `.mktplace-item-initial`
// placeholders are the designed fallback; a guessed URL defeats them.
//
// These are filesystem assertions on the page source, so they run without a browser.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

describe('homepage thumbnails — no fabricated R2 URLs (ORB regression)', () => {
	let home;
	beforeAll(() => {
		home = read('pages/home.html');
	});

	it('never hardcodes an r2.dev thumb/ CDN base', () => {
		// The bucket's public domain belongs in S3_PUBLIC_DOMAIN and is applied
		// server-side by r2.js publicUrl(). A client-side copy can only ever guess.
		expect(home).not.toMatch(/r2\.dev\/thumb/);
		expect(home).not.toMatch(/THUMB_CDN/);
	});

	it('does not build a thumb/<id>.png key on the client', () => {
		expect(home).not.toMatch(/['"`]\s*\+\s*id\s*\+\s*['"`]\.png/);
		expect(home).not.toMatch(/thumb\/\$\{/);
	});

	it('reads the avatar picker thumbnail straight off the explore feed', () => {
		// `image` is the field /api/explore emits; `thumbUrl` never existed on it.
		expect(home).toMatch(/thumb:\s*item\.image\s*\|\|\s*null/);
		expect(home).not.toMatch(/item\.thumbUrl/);
	});

	it('reads the marketplace thumbnail off the documented response shape', () => {
		// /api/marketplace answers { data: { items: [{ id, name, thumbnail_url }] } }.
		expect(home).toMatch(/body\.data\.items/);
		expect(home).toMatch(/item\.thumbnail_url/);
		// The pre-fix code read `data.agents || data.items || data`, which fell through
		// to the envelope object and threw on .slice() — the strip silently rendered
		// nothing behind its own .catch().
		expect(home).not.toMatch(/data\.agents\s*\|\|\s*data\.items\s*\|\|\s*data/);
	});

	it('ships an initial-letter placeholder for thumbnail-less avatars', () => {
		// Both strips must degrade to a designed placeholder, not a broken <img>.
		expect(home).toMatch(/\.pg-avatar-initial\s*\{/);
		expect(home).toMatch(/\.mktplace-item-initial\s*\{/);
	});
});
