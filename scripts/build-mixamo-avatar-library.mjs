#!/usr/bin/env node
/**
 * Publish the Mixamo avatar library manifest to R2, so `GET /api/avatars/library`
 * can serve it (mirrors scripts/mixamo-all.mjs phase 5 for the animation library).
 *
 * Reads public/avatars/mixamo/catalog.json (produced + enriched by
 * fetch-mixamo-avatars.mjs → convert-mixamo-avatars.mjs → fetch-mixamo-avatar-thumbnails.mjs),
 * builds one manifest entry per converted avatar with absolute CDN urls, and PUTs
 *   avatars/library/manifest.json
 * to R2. The GLB + thumbnail bytes are already in R2 (this only publishes the index).
 *
 * Manifest shape (consumed verbatim by api/avatars/library.js):
 *   { generated_at, total, avatars: [ { name, label, url, thumb, bytes, skins, animations, source } ] }
 *
 * Usage:
 *   node scripts/build-mixamo-avatar-library.mjs
 *   node scripts/build-mixamo-avatar-library.mjs --dry-run   # print, don't upload
 *
 * Needs the S3_* (R2) creds fetch-mixamo-avatars.mjs uses.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

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
const S3_PUBLIC_DOMAIN = (loadEnvVar('S3_PUBLIC_DOMAIN') || '').replace(/\/+$/, '');

if (!S3_PUBLIC_DOMAIN) {
	console.error('S3_PUBLIC_DOMAIN missing — needed to build absolute CDN urls.');
	process.exit(1);
}
if (!DRY && (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY)) {
	console.error('R2 creds missing — need S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
	process.exit(1);
}

const CATALOG_PATH = join(ROOT, 'public', 'avatars', 'mixamo', 'catalog.json');
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

const slugFromEntry = (e) =>
	e.glb_file?.replace(/^avatars\/mixamo\/glb\//, '').replace(/\.glb$/, '') ||
	e.file?.replace(/^avatars\/mixamo\//, '').replace(/\.fbx$/, '') ||
	e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const cdn = (key) => `${S3_PUBLIC_DOMAIN}/${key}`;

const avatars = Object.values(catalog.avatars || {})
	.filter((e) => e.status === 'completed' && e.glb_file)
	.map((e) => ({
		name: slugFromEntry(e),
		label: e.name,
		url: cdn(e.glb_file),
		...(e.thumb_file ? { thumb: cdn(e.thumb_file) } : {}),
		bytes: e.glb_bytes || 0,
		skins: e.glb_skins ?? 1,
		animations: e.glb_animations ?? 1,
		source: 'mixamo',
	}))
	.sort((a, b) => a.label.localeCompare(b.label));

const manifest = {
	generated_at: new Date().toISOString(),
	total: avatars.length,
	source: 'mixamo',
	avatars,
};

const MANIFEST_KEY = 'avatars/library/manifest.json';

if (DRY) {
	console.log(JSON.stringify(manifest, null, 2).slice(0, 2000));
	console.log(`\n[dry-run] ${avatars.length} avatars → ${MANIFEST_KEY} (not uploaded)`);
	process.exit(0);
}

const r2 = new S3Client({
	region: 'auto',
	endpoint: S3_ENDPOINT,
	credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

await r2.send(new PutObjectCommand({
	Bucket: S3_BUCKET,
	Key: MANIFEST_KEY,
	Body: JSON.stringify(manifest),
	ContentType: 'application/json',
	CacheControl: 'public, max-age=300',
}));

console.log(`Published ${avatars.length} avatars → ${S3_BUCKET}/${MANIFEST_KEY}`);
console.log(`  first: ${avatars[0]?.label} → ${avatars[0]?.url}`);
console.log(`  served by GET /api/avatars/library`);
