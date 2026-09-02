#!/usr/bin/env node
/**
 * Apply the canonical CORS policy to the R2 bucket backing all media.
 *
 * Why this exists: <model-viewer>, fetch(), and the avatar upload flow all
 * hit R2 from the browser. Without a CORS policy the public r2.dev host
 * returns no Access-Control-Allow-Origin header and every cross-origin
 * read (or presigned PUT) fails. Symptom: empty marketplace previews,
 * broken upload modals, console flooded with `ERR_FAILED`.
 *
 * Two rules:
 *   1. Read  — GET/HEAD of GLBs, thumbnails, posters from web origins.
 *   2. Write — PUT of presigned uploads from the same web origins.
 *
 * Usage:
 *   node scripts/set-r2-cors.mjs --probe       # measure the LIVE policy from outside (no bucket creds)
 *   node scripts/set-r2-cors.mjs --get         # read the live policy (needs an admin token)
 *   node scripts/set-r2-cors.mjs --dry-run     # print the policy, don't push
 *   node scripts/set-r2-cors.mjs               # apply (idempotent, needs an admin token)
 *
 * Where the credentials come from:
 *   - `.env` / `.env.local` hold S3_ENDPOINT, S3_ACCESS_KEY_ID,
 *     S3_SECRET_ACCESS_KEY, S3_BUCKET. The token normally checked in here is
 *     "Object Read & Write" scoped, which is enough for --probe but NOT for
 *     Get/PutBucketCors. Put an "Admin Read & Write" R2 token in `.env.local`
 *     as R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY to use --get or apply.
 *   - Production runtime values live on the Cloud Run service, readable with
 *     `gcloud run services describe three-ws-api --region us-central1
 *      --project aerial-vehicle-466722-p5 --format=yaml`. Those are the same
 *     object-scoped keys, so they do not unlock --get either.
 *   - Do NOT use `vercel env pull`: it returns empty for secret-type vars, and
 *     production has not run on Vercel since 2026-07-07.
 *
 * R2 implements the S3 PutBucketCors API verbatim, so this script also works
 * against AWS S3 and B2.
 */

import {
	S3Client,
	GetBucketCorsCommand,
	PutBucketCorsCommand,
	ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { readFileSync, existsSync } from 'node:fs';

// Lightweight .env loader so this runs standalone without dotenv as a dep.
loadDotenv('.env');
loadDotenv('.env.local');

// Accept either S3_* env names (what the API runtime uses) or R2_* names (what
// Cloudflare's dashboard hands out). The R2_* path lets you point this at any
// bucket using only the four keys from a stock R2 token — no `vercel env pull`
// required.
function fallbackEndpointFromAccount(accountId) {
	if (!accountId) return null;
	return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}
process.env.S3_ENDPOINT          ||= process.env.R2_ENDPOINT || fallbackEndpointFromAccount(process.env.R2_ACCOUNT_ID);
process.env.S3_ACCESS_KEY_ID     ||= process.env.R2_ACCESS_KEY_ID;
process.env.S3_SECRET_ACCESS_KEY ||= process.env.R2_SECRET_ACCESS_KEY;
process.env.S3_BUCKET            ||= process.env.R2_BUCKET;

const required = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
	// Deploy-time invocation: missing env is not a deploy failure. Local-dev
	// invocation: surface the hint. Either way, exit 0 so a CI step can chain.
	console.log(`[set-r2-cors] skipped, missing env: ${missing.join(', ')}`);
	console.log('[set-r2-cors] (local: drop R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET in .env.local. Production values: gcloud run services describe three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --format=yaml)');
	process.exit(0);
}

// Web origins allowed to read assets from R2 and to PUT uploads via presigned
// URLs. Keep this list authoritative — any origin not listed will be blocked
// by the browser even if the URL itself is correct.
// R2/S3 CORS supports a single `*` per origin entry. Wildcards cover ephemeral
// preview hosts (Vercel branch deploys, Codespaces port-forwards) so a new
// preview never breaks the upload flow — anything else gets blocked.
const ALLOWED_ORIGINS = [
	'https://three.ws',
	'https://www.three.ws',
	'https://3d-agent.vercel.app',
	'https://*.vercel.app',
	'https://*.app.github.dev',
	'http://localhost:3000',
	'http://localhost:5173',
];

const POLICY = {
	CORSRules: [
		{
			ID: 'public-read',
			// Reads are world-open on purpose: the bucket is already public
			// (keyless r2.dev host), and its GLBs/posters are meant to load from
			// ANY origin — <model-viewer> embeds, Jupyter/Colab notebooks (the
			// OpenAI Cookbook tutorial runs on localhost), partner sites. CORS
			// on GET adds no protection for public objects; an allowlist here
			// only breaks legitimate embeds (2026-07-21: galleries dead in
			// Codespaces/Jupyter because the live policy predated the wildcard
			// entries below). Uploads stay origin-locked in the next rule.
			AllowedOrigins: ['*'],
			AllowedMethods: ['GET', 'HEAD'],
			AllowedHeaders: ['*'],
			ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Accept-Ranges'],
			MaxAgeSeconds: 86400,
		},
		{
			ID: 'browser-upload',
			AllowedOrigins: ALLOWED_ORIGINS,
			AllowedMethods: ['PUT'],
			AllowedHeaders: ['*'],
			ExposeHeaders: ['ETag'],
			MaxAgeSeconds: 3600,
		},
	],
};

// Origins --probe measures. Every literal from ALLOWED_ORIGINS, a concrete
// sample per wildcard entry (a wildcard is only real if a host under it passes),
// and two controls that must be read-allowed but write-denied.
const PROBE_ORIGINS = [
	...ALLOWED_ORIGINS.map((o) => o.replace('*', 'probe-cors')),
	'https://example.org',
	'http://localhost:8080',
];

// The preflight target. OPTIONS is answered from the bucket policy alone, so
// this key is never created or read.
const PROBE_WRITE_KEY = 'cors-preflight-probe.bin';

const flag = (name) => process.argv.includes(name);

const s3 = new S3Client({
	region: 'auto',
	endpoint: process.env.S3_ENDPOINT,
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
	},
});

const Bucket = process.env.S3_BUCKET;

if (flag('--probe')) {
	process.exit((await probe()) ? 0 : 1);
}

if (flag('--get')) {
	let current;
	try {
		current = await getCors();
	} catch (err) {
		if (!explainAccessDenied(err, 'reading')) throw err;
		process.exit(1);
	}
	console.log(JSON.stringify(current, null, 2));
	process.exit(0);
}

if (flag('--dry-run')) {
	console.log('Would apply to bucket:', Bucket);
	console.log(JSON.stringify(POLICY, null, 2));
	process.exit(0);
}

let before;
try {
	before = await getCors();
} catch (err) {
	if (!explainAccessDenied(err, 'reading')) throw err;
	process.exit(1);
}
try {
	await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: POLICY }));
} catch (err) {
	if (!explainAccessDenied(err, 'writing')) throw err;
	process.exit(1);
}
const after = await getCors();

if (JSON.stringify(before) === JSON.stringify(after)) {
	console.log(`CORS policy on ${Bucket} unchanged (already current).`);
} else {
	console.log(`Applied CORS policy to ${Bucket}.`);
	console.log('Rules:', after.CORSRules.map((r) => `${r.ID || '(no id)'} → ${r.AllowedMethods.join(',')}`).join(' | '));
}

// Measure the policy the bucket actually enforces, using only object-scoped
// credentials. GetBucketCors needs an admin token that most environments do
// not have, so without this the live policy is unverifiable and drift between
// POLICY above and the bucket goes unnoticed for months (it did: 2026-08-01).
//
// Two requests per origin, one per rule:
//   read  — GET on the public host; the `public-read` rule should echo every origin.
//   write — PUT preflight on the S3 endpoint; only ALLOWED_ORIGINS should get 204.
// Exits nonzero when the measurement disagrees with POLICY.
async function probe() {
	const publicHost = process.env.S3_PUBLIC_DOMAIN || process.env.R2_PUBLIC_DOMAIN;
	if (!publicHost) {
		console.error('--probe needs S3_PUBLIC_DOMAIN (the public r2.dev or custom-domain host).');
		return false;
	}

	const key = await probeKey();
	if (!key) {
		console.error('--probe could not find a public object to read. Pass one with --key=<object key>.');
		return false;
	}

	const readUrl = `${publicHost.replace(/\/$/, '')}/${encodeR2Key(key)}`;
	const writeUrl = `${process.env.S3_ENDPOINT.replace(/\/$/, '')}/${Bucket}/${PROBE_WRITE_KEY}`;

	console.log(`Probing ${Bucket} (read: ${readUrl})\n`);
	console.log(`${'ORIGIN'.padEnd(38)} ${'READ'.padEnd(6)} ${'WRITE'.padEnd(6)} EXPECTED`);

	let ok = true;
	for (const origin of PROBE_ORIGINS) {
		const [read, write] = await Promise.all([
			corsAllowed(readUrl, origin, 'GET'),
			corsAllowed(writeUrl, origin, 'PUT'),
		]);
		const wantRead = ruleAllows('public-read', origin);
		const wantWrite = ruleAllows('browser-upload', origin);
		const bad = read !== wantRead || write !== wantWrite;
		if (bad) ok = false;
		const want = `read=${wantRead ? 'yes' : 'no'} write=${wantWrite ? 'yes' : 'no'}${bad ? '  <- DRIFT' : ''}`;
		console.log(`${origin.padEnd(38)} ${(read ? 'yes' : 'no').padEnd(6)} ${(write ? 'yes' : 'no').padEnd(6)} ${want}`);
	}

	console.log('');
	if (ok) {
		console.log('Live policy matches POLICY in this script.');
	} else {
		console.log('Live policy DIFFERS from POLICY in this script. Apply it with an admin token:');
		console.log('  node scripts/set-r2-cors.mjs');
	}
	return ok;
}

// A key whose object is world-readable, so the read probe measures CORS rather
// than auth. Prefers a caller-supplied --key, else the first thumbnail.
async function probeKey() {
	const explicit = process.argv.find((a) => a.startsWith('--key='));
	if (explicit) return explicit.slice('--key='.length);
	try {
		const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: 'thumb/', MaxKeys: 1 }));
		return r.Contents?.[0]?.Key || null;
	} catch {
		return null;
	}
}

// True when the browser would be allowed through: a matching
// Access-Control-Allow-Origin on the actual request for GET, and a non-error
// preflight for PUT (which never touches a real object, so the key need not exist).
async function corsAllowed(url, origin, method) {
	const headers = { origin };
	// HEAD, not GET: same CORS rule, none of the bytes.
	let init = { method: 'HEAD', headers, redirect: 'manual' };
	if (method === 'PUT') {
		init = {
			method: 'OPTIONS',
			headers: { ...headers, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
		};
	}
	let res;
	try {
		res = await fetch(url, init);
	} catch {
		return false;
	}
	if (method === 'PUT' && !res.ok) return false;
	const allow = res.headers.get('access-control-allow-origin');
	return allow === '*' || allow === origin;
}

// Does POLICY's named rule cover this origin? Mirrors S3 matching: one `*` per
// entry, matched against the whole origin string.
function ruleAllows(id, origin) {
	const rule = POLICY.CORSRules.find((r) => r.ID === id);
	if (!rule) return false;
	return rule.AllowedOrigins.some((pattern) => {
		if (pattern === '*') return true;
		if (!pattern.includes('*')) return pattern === origin;
		const [head, tail] = pattern.split('*');
		return origin.startsWith(head) && origin.endsWith(tail) && origin.length >= head.length + tail.length;
	});
}

function encodeR2Key(key) {
	return key.split('/').map(encodeURIComponent).join('/');
}

async function getCors() {
	try {
		const r = await s3.send(new GetBucketCorsCommand({ Bucket }));
		return { CORSRules: r.CORSRules || [] };
	} catch (err) {
		if (err?.name === 'NoSuchCORSConfiguration' || err?.$metadata?.httpStatusCode === 404) {
			return { CORSRules: [] };
		}
		throw err;
	}
}

// Most R2 tokens are issued with "Object Read & Write" scope, which is enough
// for PutObject / GetObject but NOT for PutBucketCors / GetBucketCors. Detect
// that case and print the one-line fix instead of a stack trace.
function explainAccessDenied(err, op) {
	const status = err?.$metadata?.httpStatusCode;
	const code = err?.Code || err?.name;
	if (status !== 403 && code !== 'AccessDenied') return false;
	console.error('');
	console.error(`AccessDenied while ${op} bucket CORS on "${Bucket}".`);
	console.error('');
	console.error('The R2 token in your environment has object-level access but not');
	console.error('bucket-level CORS access. To fix:');
	console.error('  1. Open https://dash.cloudflare.com → R2 → Manage R2 API Tokens');
	console.error('  2. Create a new token with permission: "Admin Read & Write"');
	console.error('     (or at minimum: PutBucketCors + GetBucketCors)');
	console.error(`  3. Scope it to bucket "${Bucket}" only.`);
	console.error('  4. Replace R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in .env.local');
	console.error('     with the new token, then rerun:  node scripts/set-r2-cors.mjs');
	console.error('');
	return true;
}

function loadDotenv(path) {
	if (!existsSync(path)) return;
	const text = readFileSync(path, 'utf8');
	for (const line of text.split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (!m) continue;
		const [, key, rawVal] = m;
		if (process.env[key]) continue;
		let val = rawVal;
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}
