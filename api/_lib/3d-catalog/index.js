// three.ws 3D API — catalog assembler.
//
// The free 3D API is a bundle of small keyless endpoints (inspect, generate, …).
// Rather than maintain one shared list that every sibling work-order would have
// to edit (and collide on), each endpoint drops ITS OWN descriptor file in this
// directory — `api/_lib/3d-catalog/<slug>.js` — and this assembler merges them.
//
// Serverless-safe enumeration: static barrel first, glob as a dev-time extra
// ---------------------------------------------------------------------------
// Vercel's function bundler only reliably ships what STATIC imports reach. A
// computed `import('./' + file)` off a `readdirSync` result is invisible to the
// tracer — the first deployed version relied on the runtime glob (plus
// vercel.json's `includeFiles` pin and a cwd fallback) and served
// `endpoints: []` in production while finding every entry locally. So the
// STATIC_ENTRIES barrel below is the production source of truth, and the
// runtime glob survives only as an additive convenience: a descriptor dropped
// in this directory appears in `npm run dev` / vitest before its import line
// lands, and fixture dirs passed by tests still assemble pure-glob.
//
// Robustness: a malformed or throwing descriptor is skipped and logged — the
// assembler NEVER throws and NEVER lets one bad entry take down the whole index.
// With zero descriptors it returns `[]`, which the `/api/3d` index renders as a
// designed "rolling out" state rather than an error.

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import diffEntry from './diff.js';
import generateEntry from './generate.js';
import inspectEntry from './inspect.js';
import printQuoteEntry from './print-quote.js';
import printPrepareEntry from './print-prepare.js';

// Static barrel — the PRODUCTION source of truth for the catalog. Vercel's
// bundler only reliably ships what static imports reach: the first deployed
// version enumerated this directory at runtime and served `endpoints: []` live
// while finding every entry locally. The directory glob below still runs, but
// only as an ADDITIVE dev-time pickup so a freshly dropped descriptor shows up
// before its import line lands.
//
// >>> Adding an endpoint: drop `api/_lib/3d-catalog/<slug>.js` AND add its
// >>> import + line here. The import is what makes it exist in production.
const STATIC_ENTRIES = [
	{ mod: diffEntry, source: 'diff.js' },
	{ mod: generateEntry, source: 'generate.js' },
	{ mod: inspectEntry, source: 'inspect.js' },
	{ mod: printQuoteEntry, source: 'print-quote.js' },
	{ mod: printPrepareEntry, source: 'print-prepare.js' },
];

// In dev/tests `import.meta.url` is this source file, so its own directory is
// the descriptor dir. In production Vercel esbuild-bundles this module INTO the
// `api/3d/*.js` handler, so `import.meta.url` resolves to `api/3d/` — full of
// route handlers, not descriptors — and the catalog would silently assemble
// empty. The basename check detects that case and falls back to the
// repo-relative descriptor path, which exists inside the lambda because
// vercel.json pins `includeFiles: "api/_lib/3d-catalog/**"` (Vercel preserves
// repo-relative layout under the function root / cwd).
const SELF = dirname(fileURLToPath(import.meta.url));
const __dirname =
	basename(SELF) === '3d-catalog' ? SELF : join(process.cwd(), 'api', '_lib', '3d-catalog');

// Infrastructure modules that live in this directory but are NOT catalog
// entries — the assembler itself and the OpenAPI builder. Everything else that
// is a `*.js` file is treated as an endpoint descriptor.
const NON_ENTRY = new Set(['index.js', 'openapi.js']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// A descriptor is valid only if it can answer the one question the index/OpenAPI
// generator needs of every entry: what route, which method, what does it do.
// Everything else is optional and defaulted; anything failing this is skipped.
//
// Sibling work-orders author these descriptors independently and have drifted on
// field names — one uses `slug`/`title`/`method`/`inputSchema`, another uses
// `id`/`name`/`methods`/`input`. Rather than reject a perfectly good entry over a
// naming difference, we accept BOTH conventions and canonicalize to one shape the
// index + OpenAPI generator consume. Only a genuinely unusable entry (no route,
// no name, no summary) is dropped.
function normalizeEntry(raw, source) {
	const entry = raw && typeof raw === 'object' && raw.default ? raw.default : raw;
	if (!entry || typeof entry !== 'object') return null;

	const slug = str(entry.slug) || str(entry.id);
	const path = str(entry.path);
	const summary = str(entry.summary) || str(entry.description);
	// Route + a human name + one line of what-it-does are the irreducible minimum.
	if (!slug || !path || !summary) return null;

	// Methods normalize to an uppercased array; a bad value defaults to GET so a
	// half-filled descriptor still surfaces rather than vanishing.
	const rawMethods = Array.isArray(entry.methods)
		? entry.methods
		: entry.method
			? [entry.method]
			: ['GET'];
	const methods = rawMethods
		.map((m) => String(m || '').toUpperCase().trim())
		.filter((m) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m));
	if (methods.length === 0) methods.push('GET');

	return {
		slug,
		path,
		methods,
		title: str(entry.title) || str(entry.name) || slug,
		summary,
		description: str(entry.description) || summary,
		free: entry.free !== false, // free by default — this is the free bundle
		keyless: entry.keyless !== false,
		category: str(entry.category) || '3d',
		useCase: str(entry.useCase) || str(entry.agentUseCase),
		// Accept both the flat `params`/`requestBody` (OpenAPI-ish) and the nested
		// `input` shapes; downstream generators read `inputSchema`/`outputSchema`.
		params: Array.isArray(entry.params) ? entry.params : [],
		requestBody: obj(entry.requestBody),
		input: obj(entry.input),
		inputSchema: obj(entry.inputSchema) || obj(entry.input?.schema),
		outputSchema: obj(entry.outputSchema) || obj(entry.output?.schema) || obj(entry.output),
		example: entry.example && typeof entry.example === 'object' ? entry.example : null,
		poll: obj(entry.poll),
		paidTiers: Array.isArray(entry.paidTiers) ? entry.paidTiers : [],
		rateLimit: str(entry.rateLimit) || null,
		tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
		order: Number.isFinite(entry.order) ? entry.order : 100,
		source,
	};
}

// Per-directory cache. Keyed by resolved dir so the default (production) load is
// memoized across warm serverless invocations while tests pointing at fixture
// dirs each get their own slot. `fresh:true` bypasses it.
const cache = new Map();

// loadCatalog() — merge every descriptor in `dir` (defaults to this directory).
// Skips malformed/throwing entries, dedups by route, and NEVER throws — an empty
// catalog is a valid served state.
export async function loadCatalog({ dir = __dirname, fresh = false } = {}) {
	if (!fresh && cache.has(dir)) return cache.get(dir);

	const entries = [];
	const seen = new Set();
	const staticSources = new Set();

	// The static barrel seeds the real catalog (never fixture dirs passed by
	// tests). It goes through the same normalize + dedup gauntlet as globbed
	// files — a malformed barrel entry is skipped, not fatal.
	if (dir === __dirname) {
		for (const { mod, source } of STATIC_ENTRIES) {
			staticSources.add(source);
			const normalized = normalizeEntry(mod, source);
			if (!normalized) {
				console.warn(`[3d-catalog] skipping malformed static entry: ${source}`);
				continue;
			}
			const key = `${normalized.methods.join(',')} ${normalized.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push(normalized);
		}
	}

	let files = [];
	try {
		files = readdirSync(dir).filter(
			(f) =>
				f.endsWith('.js') &&
				!NON_ENTRY.has(f) &&
				!staticSources.has(f) &&
				!f.startsWith('_') &&
				!f.startsWith('.') &&
				!f.endsWith('.test.js'),
		);
	} catch (err) {
		// Directory unreadable (expected inside the serverless bundle, where the
		// static barrel above has already populated the catalog) — never throw.
		if (entries.length === 0) {
			console.warn(`[3d-catalog] could not read catalog dir ${dir}:`, err?.message || err);
		}
		cache.set(dir, entries);
		return cache.get(dir);
	}

	for (const file of files) {
		try {
			const mod = await import(pathToFileURL(join(dir, file)).href);
			const normalized = normalizeEntry(mod.default ?? mod.entry ?? mod, file);
			if (!normalized) {
				console.warn(`[3d-catalog] skipping malformed entry: ${file}`);
				continue;
			}
			// First descriptor to claim a route+method combo wins; a duplicate is
			// dropped rather than emitting two operations for one route.
			const key = `${normalized.methods.join(',')} ${normalized.path}`;
			if (seen.has(key)) {
				console.warn(`[3d-catalog] skipping duplicate route: ${key} (${file})`);
				continue;
			}
			seen.add(key);
			entries.push(normalized);
		} catch (err) {
			// One broken descriptor must never break the whole index.
			console.warn(`[3d-catalog] failed to load entry ${file}:`, err?.message || err);
		}
	}

	entries.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
	cache.set(dir, entries);
	return cache.get(dir);
}

// Synchronous, side-effect-free normalizer export so tests can validate the
// skip-malformed contract without touching the filesystem.
export { normalizeEntry };
