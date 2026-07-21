#!/usr/bin/env node
/**
 * Pull the Poly Haven CC0 model library → web GLB → R2.
 *
 * Same shape as the Mixamo pipeline (fetch → convert → R2 → catalog), just a
 * different source. Poly Haven ships multi-file glTF (.gltf + .bin + textures),
 * so the "convert" step downloads the pieces and packs them into one GLB with
 * @gltf-transform (textures inlined). Everything is CC0 — attribution-free,
 * commercial-OK.
 *
 * Resumable: catalog.json tracks per-model status; re-run only does what's missing.
 *
 * Usage:
 *   node scripts/fetch-polyhaven-objects.mjs
 *   node scripts/fetch-polyhaven-objects.mjs --concurrency=4 --limit=20 --res=1k
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { NodeIO } from '@gltf-transform/core';
import { putObject, objectExists, cdnUrl } from './lib/asset-r2.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const UA = { 'User-Agent': 'three.ws-asset-ingest/1.0' };
const API = 'https://api.polyhaven.com';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const CONCURRENCY = Number(args.concurrency) || 4;
const MAX = args.limit ? Number(args.limit) : Infinity;
const RES = args.res || '1k';
const FORCE = !!args.force;

const OUT_DIR = join(ROOT, 'public', 'objects', 'polyhaven');
const CATALOG_PATH = join(OUT_DIR, 'catalog.json');
mkdirSync(OUT_DIR, { recursive: true });
const catalog = existsSync(CATALOG_PATH) ? JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) : { generated_at: null, models: {} };
function saveCatalog() {
	catalog.generated_at = new Date().toISOString();
	writeFileSync(CATALOG_PATH + '.tmp', JSON.stringify(catalog, null, 2));
	renameSync(CATALOG_PATH + '.tmp', CATALOG_PATH);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const titleCase = (slug) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
	const res = await fetch(url, { headers: UA });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}
async function fetchBuf(url) {
	const res = await fetch(url, { headers: UA });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return Buffer.from(await res.arrayBuffer());
}

async function packOne(slug, info) {
	const glbKey = `objects/polyhaven/glb/${slug}.glb`;
	const existing = catalog.models[slug];
	if (!FORCE && existing?.status === 'done' && await objectExists(glbKey)) {
		return { skipped: true };
	}

	const files = await fetchJson(`${API}/files/${encodeURIComponent(slug)}`);
	const resNode = files?.gltf?.[RES]?.gltf || files?.gltf?.['1k']?.gltf || files?.gltf?.['2k']?.gltf;
	if (!resNode?.url) {
		catalog.models[slug] = { slug, status: 'no_gltf' };
		saveCatalog();
		throw new Error('no gltf');
	}

	const scratch = mkdtempSync(join(tmpdir(), 'ph-'));
	try {
		writeFileSync(join(scratch, 'model.gltf'), await fetchBuf(resNode.url));
		for (const [rel, dep] of Object.entries(resNode.include || {})) {
			const p = join(scratch, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, await fetchBuf(dep.url));
		}
		const io = new NodeIO();
		const doc = await io.read(join(scratch, 'model.gltf'));
		const glb = Buffer.from(await io.writeBinary(doc));

		await putObject(glbKey, glb, 'model/gltf-binary', 'public, max-age=604800');
		catalog.models[slug] = {
			slug,
			name: info.name || titleCase(slug),
			categories: info.categories || [],
			tags: info.tags || [],
			authors: Object.keys(info.authors || {}),
			glb_file: glbKey,
			glb_bytes: glb.length,
			meshes: doc.getRoot().listMeshes().length,
			textures: doc.getRoot().listTextures().length,
			license: 'CC0',
			source: 'polyhaven',
			status: 'done',
			done_at: new Date().toISOString(),
		};
		saveCatalog();
		return { bytes: glb.length };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

(async () => {
	console.log('Poly Haven CC0 object puller');
	const models = await fetchJson(`${API}/assets?t=models`);
	const entries = Object.entries(models);
	console.log(`Catalog: ${entries.length} models | resolution: ${RES}\n`);

	let ok = 0, fail = 0, skipped = 0, cursor = 0;
	async function worker() {
		while (cursor < entries.length && ok + fail < MAX) {
			const i = cursor++;
			const [slug, info] = entries[i];
			const label = `[${i + 1}/${entries.length}]`;
			try {
				const r = await packOne(slug, info);
				if (r.skipped) { skipped++; continue; }
				ok++;
				if (ok % 10 === 0) process.stdout.write(`\r  ${ok} packed, ${skipped} skipped, ${fail} failed…   `);
				await sleep(100);
			} catch (err) {
				fail++;
				console.warn(`${label} fail ${slug}: ${err.message}`);
			}
		}
	}
	const t0 = Date.now();
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	console.log(`\n\nPacked: ${ok} | Skipped: ${skipped} | Failed: ${fail} | ${((Date.now() - t0) / 60000).toFixed(1)} min`);
	console.log(`GLB in R2: objects/polyhaven/glb/  ·  ${cdnUrl('objects/polyhaven/glb/')}`);
})().catch((err) => { console.error(err); process.exit(1); });
