#!/usr/bin/env node
/**
 * Publish the CC0 object library manifest to R2 for GET /api/objects/library.
 * Copies scripts/build-mixamo-avatar-library.mjs, for objects instead of avatars.
 *
 * Reads public/objects/polyhaven/catalog.json (+ any future object source
 * catalogs), builds one manifest entry per model with absolute CDN urls, PUTs
 *   objects/library/manifest.json
 *
 * Usage: node scripts/build-object-library.mjs [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdnUrl, publishManifest, listKeys, S3_BUCKET } from './lib/asset-r2.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const SOURCES = [
	{ catalog: join(ROOT, 'public', 'objects', 'polyhaven', 'catalog.json'), key: 'models' },
];

// The set of thumbnails that actually rendered (render-glb-thumbnails.mjs), so a
// failed poster is omitted rather than published as a 404 broken image.
const renderedThumbs = new Set(
	DRY ? [] : (await listKeys('objects/')).filter((o) => o.key.includes('/thumbs/') && o.key.endsWith('.png')).map((o) => o.key),
);

const objects = [];
for (const src of SOURCES) {
	if (!existsSync(src.catalog)) continue;
	const cat = JSON.parse(readFileSync(src.catalog, 'utf8'));
	for (const m of Object.values(cat[src.key] || {})) {
		if (m.status !== 'done' || !m.glb_file) continue;
		const thumbKey = m.thumb_file || `objects/${m.source || 'polyhaven'}/thumbs/${m.slug}.png`;
		objects.push({
			name: m.slug,
			label: m.name || m.slug,
			url: cdnUrl(m.glb_file),
			...(renderedThumbs.has(thumbKey) ? { thumb: cdnUrl(thumbKey) } : {}),
			bytes: m.glb_bytes || 0,
			categories: m.categories || [],
			tags: m.tags || [],
			license: m.license || 'CC0',
			source: m.source || 'polyhaven',
		});
	}
}
objects.sort((a, b) => a.label.localeCompare(b.label));

const manifest = { generated_at: new Date().toISOString(), total: objects.length, objects };
const MANIFEST_KEY = 'objects/library/manifest.json';

if (DRY) {
	console.log(JSON.stringify(manifest.objects.slice(0, 3), null, 2));
	console.log(`\n[dry-run] ${objects.length} objects → ${MANIFEST_KEY}`);
	process.exit(0);
}
await publishManifest(MANIFEST_KEY, manifest);
console.log(`Published ${objects.length} objects → ${S3_BUCKET}/${MANIFEST_KEY}`);
console.log(`  served by GET /api/objects/library`);
