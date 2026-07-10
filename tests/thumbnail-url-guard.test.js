// thumbnailUrl() — the one way a stored thumbnail_key becomes a URL for an <img>.
//
// A thumbnail_key only resolves to a real image when it is a relative R2 key.
// Legacy poisoned keys (absolute, origin-pointing `*_og.png`, written by the
// pre-fix avatar-OG cache) resolve to an origin that holds no object. R2/the
// origin answers 404 with a `text/plain` body, and because the request was made
// for an <img>, Chrome refuses it under Opaque Response Blocking and logs
// net::ERR_BLOCKED_BY_ORB — a console error on a page that should simply have
// shown a placeholder.
//
// Before this helper existed, ~30 read paths called bare `publicUrl(thumbnail_key)`
// and would happily publish such a key: agent cards, the marketplace, the explore
// feed, user profiles, leaderboards — and the image baked into on-chain token
// metadata. This suite pins both the helper's behaviour and the fact that no read
// path bypasses it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..');

describe('thumbnailUrl() behaviour', () => {
	let thumbnailUrl;
	beforeAll(async () => {
		// r2.js reads S3_* lazily (the client is built on first use), so importing it
		// without credentials is safe; publicUrl() only needs S3_PUBLIC_DOMAIN.
		process.env.S3_PUBLIC_DOMAIN ||= 'https://cdn.test';
		({ thumbnailUrl } = await import('../api/_lib/r2.js'));
	});

	it('returns null for a missing key so the caller renders its placeholder', () => {
		expect(thumbnailUrl(null)).toBeNull();
		expect(thumbnailUrl(undefined)).toBeNull();
		expect(thumbnailUrl('')).toBeNull();
	});

	it('drops the legacy origin-pointing *_og.png key that always 404s', () => {
		expect(thumbnailUrl('https://three.ws/avatars/michelle_og.png')).toBeNull();
		expect(thumbnailUrl('http://three.ws/avatars/selfie-girl_OG.PNG')).toBeNull();
	});

	it('resolves a relative bucket key against the CDN', () => {
		expect(thumbnailUrl('thumb/abc.png')).toBe('https://cdn.test/thumb/abc.png');
		expect(thumbnailUrl('forge/deadbeef/x-poster.webp')).toBe('https://cdn.test/forge/deadbeef/x-poster.webp');
	});

	it('percent-encodes each path segment, like publicUrl', () => {
		expect(thumbnailUrl('u/1/my thumb.png')).toBe('https://cdn.test/u/1/my%20thumb.png');
	});
});

// Walk api/ and assert nobody reintroduces a bare publicUrl() on a thumbnail key.
// The two legitimate exceptions are called out by name.
describe('no read path bypasses thumbnailUrl()', () => {
	const ALLOWED = new Set([
		// The helper itself.
		'api/_lib/r2.js',
		// Publishes a key it JUST wrote via putObject in the same function — the
		// object provably exists, and it is a log line, not an <img> src.
		'api/cron/avatar-thumbnail-render.js',
		// HEAD-checks the key before calling publicUrl (auto-tag vision fetch).
		'api/avatars/_actions.js',
	]);

	// Matches publicUrl(<anything containing thumb/Thumb>) — the bug shape.
	const BARE = /publicUrl\(\s*[A-Za-z_$][\w$?.]*(?:thumb|Thumb)[\w$]*\s*\)/;

	function walk(dir, out = []) {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p, out);
			else if (name.endsWith('.js')) out.push(p);
		}
		return out;
	}

	it('every api/ file resolves thumbnail keys through thumbnailUrl()', () => {
		const offenders = [];
		for (const file of walk(resolve(root, 'api'))) {
			const rel = file.slice(root.length + 1);
			if (ALLOWED.has(rel)) continue;
			const src = readFileSync(file, 'utf8');
			for (const [i, line] of src.split('\n').entries()) {
				if (BARE.test(line)) offenders.push(`${rel}:${i + 1} → ${line.trim()}`);
			}
		}
		expect(offenders, `use thumbnailUrl() from api/_lib/r2.js instead:\n${offenders.join('\n')}`).toEqual([]);
	});
});

// Write-side counterpart of the same invariant: a thumbnail_key is persisted only
// after its object is confirmed present.
describe('write paths confirm the object exists before persisting a key', () => {
	const read = (p) => readFileSync(resolve(root, p), 'utf8');

	it('fork.js HEAD-checks the copied thumbnail and never clones an absolute key', () => {
		const src = read('api/avatars/fork.js');
		// The fork only adopts the key it copied, and only once headObject confirms it.
		expect(src).toMatch(/if \(copiedThumb && \(await headObject\(candidate\)\)\) newThumbKey = candidate;/);
		// The old fallback cloned src.thumbnail_key — reachable only when copyObject
		// returned false, i.e. exactly when the source key was an absolute URL.
		expect(src).not.toMatch(/newThumbKey = copiedThumb \? candidate : src\.thumbnail_key/);
	});

	it('auto-tag rejects a thumb_key with no object behind it', () => {
		const src = read('api/avatars/_actions.js');
		expect(src).toMatch(/await headObject\(thumbKey\)/);
		expect(src).toMatch(/thumbnail_not_found/);
	});

	it('renderThumbnail uploads before it commits the key', () => {
		const src = read('api/_lib/avatar-thumbs.js');
		const put = src.indexOf('await putObject({ key, body: png');
		const commit = src.indexOf('UPDATE avatars SET thumbnail_key = ${key}');
		expect(put, 'putObject call not found').toBeGreaterThan(-1);
		expect(commit, 'thumbnail_key commit not found').toBeGreaterThan(-1);
		expect(put).toBeLessThan(commit);
	});

	it('forge-seed adopts only a relative preview_key', () => {
		expect(read('api/cron/forge-seed-cron.js')).toMatch(/case when fc\.preview_key !~ '\^https\?:\/\/' then fc\.preview_key end/);
	});
});
