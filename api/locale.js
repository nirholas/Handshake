// GET /api/locale?code=<locale>&ns=<a,b,c>
// ----------------------------------------
// Serves a SLICE of a locale catalog: only the top-level namespaces a page
// actually uses, instead of the whole thing.
//
// Why this exists. The catalogs under public/locales are one file per language
// covering every page on the site: 585 top-level sections, 1.8 MB of JSON for
// English and more for scripts that encode wider (203 MB across 84 languages).
// src/i18n.js used to fetch that entire file on every page load, and a visitor
// on a non-default language fetched two (the target, plus English as the
// fallback). On /play that was 453 KB gzipped and 1.8 MB of JSON.parse on the
// critical path, for a page whose own copy is a single 1 KB section.
//
// The slice is namespace-granular because that is how the keys are already
// shaped: every data-i18n key is a dot path whose first segment names its
// section ("play.meta_description", "nav.docs"), so the client reads the set it
// needs straight off the DOM and asks for those. A /play load drops from 1.8 MB
// to roughly 20 KB.
//
// Everything here is a public read of a committed static file, so the response
// is CDN-cacheable and the origin sees one request per (locale, namespace-set)
// per deploy. Deploys purge the CDN (npm run deploy:gcp:purge-cdn), which is
// what makes the long s-maxage safe.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cors, error, method, wrap } from './_lib/http.js';

// Vite copies publicDir into dist/, so the container has both. dist/ is the
// deployed artifact and is checked first; public/ keeps `vite dev` and tests
// working without a build.
const LOCALE_DIRS = ['dist/locales', 'public/locales'];

// A namespace name is a top-level catalog key. The extractor
// (scripts/i18n-extract.mjs) derives them from page paths, so they are plain
// identifiers.
const NS_RE = /^[a-z0-9_]+$/i;
// One page asking for more than this is not a page, it is a scrape of the whole
// catalog one request at a time. The busiest real page uses well under 20.
const MAX_NS = 60;

function readLocaleFile(name) {
	for (const dir of LOCALE_DIRS) {
		try {
			return readFileSync(resolve(process.cwd(), dir, name), 'utf8');
		} catch {
			/* try the next root */
		}
	}
	return null;
}

// The manifest is the allowlist for `code`. Reading it, rather than pattern
// matching the parameter, is what makes path traversal structurally impossible:
// a code that is not a published locale never reaches the filesystem.
let _codes = null;
function allowedCodes() {
	if (_codes) return _codes;
	const raw = readLocaleFile('manifest.json');
	if (!raw) return new Set(['en']); // no manifest: still serve the source language
	try {
		const parsed = JSON.parse(raw);
		_codes = new Set((parsed.locales || []).map((l) => l.code).filter(Boolean));
	} catch {
		_codes = new Set(['en']);
	}
	if (!_codes.size) _codes = new Set(['en']);
	return _codes;
}

// Parsing a catalog costs tens of milliseconds and tens of megabytes of heap, so
// exactly one stays resident: the last language asked for. Traffic to a single
// instance is dominated by one or two languages, and the slice cache below
// absorbs the rest without ever reparsing.
let _parsed = { code: null, catalog: null };
function catalogFor(code) {
	if (_parsed.code === code) return _parsed.catalog;
	const raw = readLocaleFile(`${code}.json`);
	if (!raw) return null;
	let catalog;
	try {
		catalog = JSON.parse(raw);
	} catch {
		return null;
	}
	_parsed = { code, catalog };
	return catalog;
}

// Rendered slices, keyed by the normalized (code, namespaces) pair. Bounded by
// eviction of the oldest entry, which is a true LRU here because a Map iterates
// in insertion order and every hit reinserts.
const SLICE_LIMIT = 300;
const _slices = new Map();

/** Normalize a raw `ns` parameter: drop junk, dedupe, sort. */
export function normalizeNamespaces(raw) {
	return [...new Set(
		String(raw || '')
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s && NS_RE.test(s)),
	)].sort();
}

/** Serialized slice of `code`'s catalog for `names`, or null if unreadable. */
export function sliceFor(code, names) {
	const key = `${code}|${names.join(',')}`;
	const hit = _slices.get(key);
	if (hit !== undefined) {
		_slices.delete(key);
		_slices.set(key, hit);
		return hit;
	}
	const catalog = catalogFor(code);
	if (!catalog) return null;
	const out = {};
	// A namespace the catalog does not carry is omitted, not nulled: the client
	// falls back to the default locale for those keys, and an absent key and an
	// empty section mean the same thing to it.
	for (const n of names) if (catalog[n] !== undefined) out[n] = catalog[n];
	const body = JSON.stringify(out);
	if (_slices.size >= SLICE_LIMIT) _slices.delete(_slices.keys().next().value);
	_slices.set(key, body);
	return body;
}

export default wrap(async (req, res) => {
	cors(req, res, { origins: '*', methods: 'GET,OPTIONS' });
	if (!method(req, res, ['GET', 'OPTIONS'])) return;

	const url = new URL(req.url, 'http://localhost');
	const code = (url.searchParams.get('code') || '').trim();
	if (!allowedCodes().has(code)) {
		return error(res, 400, 'unknown_locale', `"${code}" is not a published locale. See /locales/manifest.json.`);
	}

	// Normalize before anything else touches it, so every caller asking for the
	// same sections hits the same cache entry here AND the same CDN object,
	// however they happened to order the list.
	const names = normalizeNamespaces(url.searchParams.get('ns'));
	if (!names.length) {
		return error(res, 400, 'missing_ns', 'Pass ?ns=a,b,c with the catalog sections you need.');
	}
	if (names.length > MAX_NS) {
		return error(res, 400, 'too_many_ns', `Ask for at most ${MAX_NS} sections per request; got ${names.length}.`);
	}

	const body = sliceFor(code, names);
	if (body === null) {
		// The manifest advertises this locale but its file is missing or corrupt.
		// That is a build problem, not a client one.
		return error(res, 503, 'catalog_unavailable', `The "${code}" catalog could not be read.`);
	}

	res.setHeader('cache-control', 'public, max-age=600, s-maxage=86400, stale-while-revalidate=604800');
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('x-content-type-options', 'nosniff');
	res.end(body);
});
