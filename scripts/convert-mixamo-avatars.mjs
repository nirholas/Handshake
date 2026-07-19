#!/usr/bin/env node
/**
 * Convert the bulk-downloaded Mixamo avatar FBX library (produced by
 * scripts/fetch-mixamo-avatars.mjs) into web-ready binary GLB.
 *
 * The FBX live in R2 under avatars/mixamo/<slug>.fbx. This script, for each
 * catalog entry not yet converted:
 *   1. streams the FBX down from R2 to a scratch dir,
 *   2. runs FBX2glTF (skeleton + skin weights + textures preserved),
 *   3. uploads the GLB to R2 under avatars/mixamo/glb/<slug>.glb,
 *   4. records glb_file / glb_bytes on the catalog entry,
 *   5. deletes the scratch FBX + GLB.
 *
 * Resumable: entries already carrying glb_file (and present in R2) are skipped,
 * so a re-run only picks up what's missing. Concurrency is safe — FBX2glTF is a
 * spawned native binary and each job uses its own scratch files.
 *
 * Usage:
 *   node scripts/convert-mixamo-avatars.mjs
 *   node scripts/convert-mixamo-avatars.mjs --concurrency=3 --limit=10
 *   node scripts/convert-mixamo-avatars.mjs --force   # re-convert everything
 *
 * Needs the same S3_* (R2) creds fetch-mixamo-avatars.mjs uses, in .env.local
 * or the environment.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return m ? [m[1], m[2] ?? true] : [a, true];
	}),
);
const CONCURRENCY = Number(args.concurrency) || 2;
const MAX = args.limit ? Number(args.limit) : Infinity;
const FORCE = !!args.force;

// ── Env / R2 ────────────────────────────────────────────────────────────────
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
	console.error('R2 creds missing — need S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY in .env.local.');
	process.exit(1);
}

const r2 = new S3Client({
	region: 'auto',
	endpoint: S3_ENDPOINT,
	credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

async function getFromR2(key) {
	const res = await r2.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
	return Buffer.from(await res.Body.transformToByteArray());
}
async function putToR2(key, buf, contentType) {
	await r2.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buf, ContentType: contentType }));
}
async function existsInR2(key) {
	try { await r2.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key })); return true; }
	catch { return false; }
}

// ── Catalog ─────────────────────────────────────────────────────────────────
const CATALOG_PATH = join(ROOT, 'public', 'avatars', 'mixamo', 'catalog.json');
if (!existsSync(CATALOG_PATH)) {
	console.error(`No catalog at ${CATALOG_PATH} — run scripts/fetch-mixamo-avatars.mjs --download first.`);
	process.exit(1);
}
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
let dirty = false;
function saveCatalog() {
	catalog.glb_generated_at = new Date().toISOString();
	const tmp = `${CATALOG_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(catalog, null, 2));
	renameSync(tmp, CATALOG_PATH);
	dirty = false;
}

// ── Converter ───────────────────────────────────────────────────────────────
const convert = require('fbx2gltf');

function summarizeGlb(buf) {
	if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a valid binary GLB');
	const jsonLen = buf.readUInt32LE(12);
	const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
	return {
		skins: (json.skins || []).length,
		meshes: (json.meshes || []).length,
		images: (json.images || []).length,
		animations: (json.animations || []).length,
	};
}

const SCRATCH = join(tmpdir(), 'mixamo-glb-convert');
mkdirSync(SCRATCH, { recursive: true });

async function convertOne(entry, idx, total) {
	const slug = entry.file?.replace(/^avatars\/mixamo\//, '').replace(/\.fbx$/, '') ||
		entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	const fbxKey = entry.file?.startsWith('avatars/') ? entry.file : `avatars/mixamo/${slug}.fbx`;
	const glbKey = `avatars/mixamo/glb/${slug}.glb`;
	const label = `[${idx + 1}/${total}]`;

	if (!FORCE && entry.glb_file && await existsInR2(glbKey)) {
		return { skipped: true, slug };
	}

	const fbxPath = join(SCRATCH, `${slug}.fbx`);
	const glbPath = join(SCRATCH, `${slug}.glb`);
	try {
		const fbxBuf = await getFromR2(fbxKey);
		writeFileSync(fbxPath, fbxBuf);

		let written;
		try {
			written = await convert(fbxPath, glbPath, ['--khr-materials-unlit', '--pbr-metallic-roughness']);
		} catch (err) {
			const msg = Array.isArray(err) ? err.join(' ') : (err?.message || String(err));
			throw new Error(`convert: ${msg}`);
		}
		if (written && written !== glbPath && existsSync(written)) renameSync(written, glbPath);
		if (!existsSync(glbPath)) throw new Error('converter produced no output');

		const glbBuf = readFileSync(glbPath);
		const s = summarizeGlb(glbBuf);
		await putToR2(glbKey, glbBuf, 'model/gltf-binary');

		entry.glb_file = glbKey;
		entry.glb_bytes = glbBuf.length;
		entry.glb_skins = s.skins;
		entry.glb_animations = s.animations;
		entry.glb_converted_at = new Date().toISOString();
		dirty = true;

		return { slug, bytes: glbBuf.length, ...s };
	} finally {
		rmSync(fbxPath, { force: true });
		rmSync(glbPath, { force: true });
	}
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
	const entries = Object.values(catalog.avatars || {}).filter((a) => a.status === 'completed');
	console.log(`Mixamo avatar FBX -> GLB converter`);
	console.log(`   R2 bucket:   ${S3_BUCKET}`);
	console.log(`   Avatars:     ${entries.length} completed`);
	console.log(`   Concurrency: ${CONCURRENCY}${FORCE ? ' (force re-convert)' : ''}\n`);

	let ok = 0, fail = 0, skipped = 0, cursor = 0;
	const total = entries.length;
	const t0 = Date.now();

	async function worker() {
		while (cursor < entries.length && ok + fail < MAX) {
			const i = cursor++;
			const entry = entries[i];
			const label = `[${i + 1}/${total}]`;
			try {
				const r = await convertOne(entry, i, total);
				if (r.skipped) { skipped++; console.log(`${label} skip  ${r.slug} (already converted)`); continue; }
				ok++;
				console.log(`${label} done  ${r.slug} (${(r.bytes / 1024 / 1024).toFixed(1)} MB · skins:${r.skins} tex:${r.images} anim:${r.animations})`);
				if (dirty && ok % 5 === 0) saveCatalog();
			} catch (err) {
				fail++;
				console.warn(`${label} fail  ${entry.name}: ${err.message}`);
			}
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	saveCatalog();
	const mins = ((Date.now() - t0) / 60000).toFixed(1);

	console.log(`\n${'='.repeat(43)}`);
	console.log(`Converted: ${ok}`);
	console.log(`Skipped:   ${skipped}`);
	console.log(`Failed:    ${fail}`);
	console.log(`Time:      ${mins} min`);
	console.log(`GLB in R2: ${S3_BUCKET}/avatars/mixamo/glb/`);
})().catch((err) => {
	console.error('\n', err);
	process.exit(1);
});
