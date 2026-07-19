#!/usr/bin/env node
/**
 * Capture each Mixamo avatar's product thumbnail (a clean neutral-background
 * PNG of the character) and mirror it to R2 for gallery cards / OG images.
 *
 * Mixamo serves them publicly and deterministically at
 *   https://www.mixamo.com/api/v1/characters/<id>/assets/thumbnails/static.png
 * so no token is needed. We re-host on our own CDN so the gallery never
 * hot-links Mixamo (which could rate-limit or disappear) and so the images
 * live beside the GLB they preview.
 *
 * Reads public/avatars/mixamo/catalog.json, uploads to
 *   avatars/mixamo/thumbs/<slug>.png
 * and records thumb_file on each entry.
 *
 * Usage:
 *   node scripts/fetch-mixamo-avatar-thumbnails.mjs
 *   node scripts/fetch-mixamo-avatar-thumbnails.mjs --force
 *
 * Needs the S3_* (R2) creds fetch-mixamo-avatars.mjs uses.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FORCE = process.argv.includes('--force');

function loadEnvVar(key) {
	if (process.env[key]) return process.env[key].trim();
	const p = join(ROOT, '.env.local');
	if (existsSync(p)) {
		const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
		if (line) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
	}
	return null;
}

const S3_ENDPOINT = loadEnvVar('S3_ENDPOINT') ||
	(loadEnvVar('R2_ACCOUNT_ID') ? `https://${loadEnvVar('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com` : null);
const S3_ACCESS_KEY_ID = loadEnvVar('S3_ACCESS_KEY_ID') || loadEnvVar('R2_ACCESS_KEY_ID');
const S3_SECRET_ACCESS_KEY = loadEnvVar('S3_SECRET_ACCESS_KEY') || loadEnvVar('R2_SECRET_ACCESS_KEY');
const S3_BUCKET = loadEnvVar('S3_BUCKET') || loadEnvVar('R2_BUCKET') || 'test';

if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
	console.error('R2 creds missing — need S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
	process.exit(1);
}

const r2 = new S3Client({
	region: 'auto',
	endpoint: S3_ENDPOINT,
	credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

async function existsInR2(key) {
	try { await r2.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key })); return true; }
	catch { return false; }
}

const CATALOG_PATH = join(ROOT, 'public', 'avatars', 'mixamo', 'catalog.json');
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
function saveCatalog() {
	const tmp = `${CATALOG_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(catalog, null, 2));
	renameSync(tmp, CATALOG_PATH);
}

const slugFromEntry = (e) =>
	e.glb_file?.replace(/^avatars\/mixamo\/glb\//, '').replace(/\.glb$/, '') ||
	e.file?.replace(/^avatars\/mixamo\//, '').replace(/\.fbx$/, '') ||
	e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

(async () => {
	const entries = Object.values(catalog.avatars || {}).filter((a) => a.status === 'completed');
	console.log(`Capturing ${entries.length} Mixamo avatar thumbnails -> R2 ${S3_BUCKET}/avatars/mixamo/thumbs/\n`);

	let ok = 0, fail = 0, skipped = 0;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const slug = slugFromEntry(e);
		const key = `avatars/mixamo/thumbs/${slug}.png`;
		const label = `[${i + 1}/${entries.length}]`;

		if (!FORCE && e.thumb_file && await existsInR2(key)) { skipped++; continue; }

		try {
			const src = `https://www.mixamo.com/api/v1/characters/${e.id}/assets/thumbnails/static.png`;
			const res = await fetch(src, { headers: { 'X-Api-Key': 'mixamo2' } });
			if (!res.ok) throw new Error(`thumbnail HTTP ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			await r2.send(new PutObjectCommand({
				Bucket: S3_BUCKET,
				Key: key,
				Body: buf,
				ContentType: 'image/png',
				CacheControl: 'public, max-age=604800',
			}));
			e.thumb_file = key;
			e.thumb_bytes = buf.length;
			ok++;
			if (ok % 10 === 0) { saveCatalog(); console.log(`${label} ${ok} uploaded…`); }
		} catch (err) {
			fail++;
			console.warn(`${label} fail  ${e.name}: ${err.message}`);
		}
	}
	saveCatalog();
	console.log(`\nDone. Uploaded: ${ok} | Skipped: ${skipped} | Failed: ${fail}`);
})().catch((err) => { console.error(err); process.exit(1); });
