// GET /api/features.json — machine-readable manifest of every public surface
// on three.ws, generated from data/pages.json by scripts/build-page-index.mjs.
//
// Consumed by the dashboard "What's New" widget, third-party integrations, and
// our own tooling. Served from the bundled static manifest (no DB hit) so it's
// cheap and always matches what the human /sitemap + llms.txt show.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cors, json, method, wrap, error } from './_lib/http.js';

async function loadManifest() {
	const candidates = [
		path.join(process.cwd(), 'public', 'features.json'),
		path.join(process.cwd(), 'data', 'pages.json'),
	];
	for (const file of candidates) {
		try {
			return JSON.parse(await readFile(file, 'utf8'));
		} catch {
			// try next
		}
	}
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const manifest = await loadManifest();
	if (!manifest) {
		return error(res, 503, 'manifest_unavailable', 'feature manifest not built');
	}

	// Optional ?category= and ?audience= filters for lightweight querying.
	const url = new URL(req.url, 'http://x');
	const category = url.searchParams.get('category');
	const audience = url.searchParams.get('audience');

	let sections = manifest.sections || [];
	if (category) sections = sections.filter((s) => s.id === category);
	if (audience) {
		sections = sections
			.map((s) => ({
				...s,
				pages: (s.pages || []).filter((p) => (p.audience || []).includes(audience)),
			}))
			.filter((s) => s.pages.length > 0);
	}

	return json(
		res,
		200,
		{ ...manifest, sections },
		{ 'cache-control': 'public, s-maxage=600, stale-while-revalidate=86400' },
	);
});
