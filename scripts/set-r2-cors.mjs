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
 *   node scripts/set-r2-cors.mjs --probe       # measure the LIVE policy from outside (no credentials at all)
 *   node scripts/set-r2-cors.mjs --probe --site=https://staging.example  # probe another deployment
 *   node scripts/set-r2-cors.mjs --probe --key=thumb/x.png               # read a specific object
 *   node scripts/set-r2-cors.mjs --get         # read the live policy (needs an admin token)
 *   node scripts/set-r2-cors.mjs --dry-run     # print the policy, don't push
 *   node scripts/set-r2-cors.mjs               # apply (idempotent, needs an admin token)
 *
 * Where the credentials come from:
 *   - `.env` / `.env.local` hold S3_ENDPOINT, S3_ACCESS_KEY_ID,
 *     S3_SECRET_ACCESS_KEY, S3_BUCKET. The token normally checked in here is
 *     "Object Read & Write" scoped, which is NOT enough for Get/PutBucketCors.
 *     Put an "Admin Read & Write" R2 token in `.env.local` as
 *     R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY to use --get or to apply.
 *   - --probe needs NONE of them. With no credentials it discovers the public
 *     host from a live listing endpoint and the presigned-upload host from the
 *     auth-free /api/forge-upload, which is exactly what a browser sees.
 *   - Production runtime values live on the Cloud Run service, where credentials
 *     are Secret Manager references rather than literals; read one with
 *     `node scripts/read-service-env.mjs '^S3_' `. Those are the same
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
// Assign through this, never `process.env.X ||= y` directly: assigning an
// absent value to process.env stores the STRING "undefined", which is truthy.
// That silently defeated every "is storage configured?" check below. On a
// machine with no R2 vars the script skipped its own skip-gate and went on to
// call the bucket API with the literal credentials "undefined".
function aliasEnv(name, value) {
	if (!process.env[name] && value) process.env[name] = value;
}
aliasEnv('S3_ENDPOINT', process.env.R2_ENDPOINT || fallbackEndpointFromAccount(process.env.R2_ACCOUNT_ID));
aliasEnv('S3_ACCESS_KEY_ID', process.env.R2_ACCESS_KEY_ID);
aliasEnv('S3_SECRET_ACCESS_KEY', process.env.R2_SECRET_ACCESS_KEY);
aliasEnv('S3_BUCKET', process.env.R2_BUCKET);

const flag = (name) => process.argv.includes(name);
const argValue = (name) => {
	const hit = process.argv.find((a) => a.startsWith(`${name}=`));
	return hit ? hit.slice(name.length + 1) : null;
};

const required = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'];
const missing = required.filter((k) => !process.env[k]);
const hasBucketCreds = missing.length === 0;

// --probe and --dry-run are exempt from this gate on purpose: neither calls the
// bucket API. --probe measures the policy the way a browser experiences it, over
// public HTTP, sourcing both of its URLs from the live site (see probe() below),
// and --dry-run only prints POLICY. Requiring credentials here would make the
// one command that verifies this policy unrunnable exactly where it is needed
// most: a fresh clone, or a machine whose keys have rotated out.
if (missing.length && !flag('--probe') && !flag('--dry-run')) {
	// Deploy-time invocation: missing env is not a deploy failure. Local-dev
	// invocation: surface the hint. Either way, exit 0 so a CI step can chain.
	console.log(`[set-r2-cors] skipped, missing env: ${missing.join(', ')}`);
	console.log("[set-r2-cors] (local: drop R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET in .env.local. Production values: node scripts/read-service-env.mjs '^S3_')");
	console.log('[set-r2-cors] (to measure the LIVE policy without any bucket credentials: node scripts/set-r2-cors.mjs --probe)');
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

// Built on first use, never at import: --probe runs with no credentials at all
// and must not construct a client around an undefined endpoint.
let _s3;
function s3client() {
	if (!_s3) {
		_s3 = new S3Client({
			region: 'auto',
			endpoint: process.env.S3_ENDPOINT,
			credentials: {
				accessKeyId: process.env.S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
			},
		});
	}
	return _s3;
}

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
	console.log('Would apply to bucket:', Bucket || '(S3_BUCKET unset in this environment)');
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
	await s3client().send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: POLICY }));
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
	const site = (argValue('--site') || 'https://three.ws').replace(/\/$/, '');

	// Both probe URLs, with the live site as the fallback source for each. The
	// site is the browser's own view of the bucket, so a machine with no bucket
	// credentials at all still measures the real policy.
	const readUrl = (await probeReadUrl(publicHost, site)) || null;
	if (!readUrl) {
		console.error('--probe could not find a public object to read.');
		console.error('Pass one with --key=<object key> (needs S3_PUBLIC_DOMAIN), or check that');
		console.error(`${site} is reachable and still serves r2.dev asset URLs.`);
		return false;
	}

	const writeUrl = await probeWriteUrl(site);
	if (!writeUrl) {
		console.error('--probe could not determine the presigned-upload host.');
		console.error(`Set S3_ENDPOINT + S3_BUCKET, or check that ${site}/api/forge-upload is reachable.`);
		return false;
	}

	console.log(`Probing ${Bucket || hostLabel(writeUrl)} (read: ${readUrl})\n`);
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

// A world-readable object URL on the public host, so the read probe measures
// CORS rather than auth. Three sources, best first: an explicit --key, the
// bucket listing (needs credentials), and finally the live site, which hands
// out public asset URLs on the very host we want to measure.
async function probeReadUrl(publicHost, site) {
	const explicit = argValue('--key');
	if (explicit) {
		if (!publicHost) {
			console.error('--key needs S3_PUBLIC_DOMAIN to build a URL from.');
			return null;
		}
		return `${publicHost.replace(/\/$/, '')}/${encodeR2Key(explicit)}`;
	}

	if (hasBucketCreds && publicHost) {
		try {
			const r = await s3client().send(new ListObjectsV2Command({ Bucket, Prefix: 'thumb/', MaxKeys: 1 }));
			const key = r.Contents?.[0]?.Key;
			if (key) return `${publicHost.replace(/\/$/, '')}/${encodeR2Key(key)}`;
		} catch {
			// Fall through to the site: an object-scoped token that cannot list
			// is exactly the case this fallback exists for.
		}
	}

	return discoverPublicAssetUrl(site, publicHost);
}

// Scrape one public bucket URL out of a live listing endpoint. These return
// user-generated avatars, whose media resolves to the public bucket host via
// publicUrl() in api/_lib/r2.js, the same URL a third-party embed would load.
async function discoverPublicAssetUrl(site, publicHost) {
	const hostPattern = publicHost
		? escapeRegExp(publicHost.replace(/\/$/, ''))
		: 'https:\\/\\/[a-z0-9-]+\\.r2\\.dev';
	const re = new RegExp(`${hostPattern}\\/[^"'\\s\\\\]+\\.(?:glb|png|jpg|webp)`, 'i');
	for (const path of ['/api/marketplace/agents?limit=12', '/api/avatars?limit=12']) {
		try {
			const res = await fetch(`${site}${path}`, { headers: { accept: 'application/json' } });
			if (!res.ok) continue;
			const hit = (await res.text()).match(re);
			if (hit) return hit[0];
		} catch {
			continue;
		}
	}
	return null;
}

// The presigned-upload host. From env when credentials are present, else from
// the site's own auth-free presign endpoint, which returns a real upload URL on
// the exact host the browser PUTs to. Only its OPTIONS preflight is ever sent,
// so no object is created.
async function probeWriteUrl(site) {
	if (process.env.S3_ENDPOINT && Bucket) {
		return `${process.env.S3_ENDPOINT.replace(/\/$/, '')}/${Bucket}/${PROBE_WRITE_KEY}`;
	}
	try {
		const res = await fetch(`${site}/api/forge-upload`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': 'set-r2-cors-probe' },
			body: JSON.stringify({ content_type: 'image/png', size_bytes: 1024 }),
		});
		if (!res.ok) return null;
		const { upload_url: uploadUrl } = await res.json();
		if (!uploadUrl) return null;
		const u = new URL(uploadUrl);
		return `${u.origin}${u.pathname}`;
	} catch {
		return null;
	}
}

function hostLabel(url) {
	try {
		return new URL(url).hostname.split('.')[0];
	} catch {
		return 'bucket';
	}
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
		const r = await s3client().send(new GetBucketCorsCommand({ Bucket }));
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
