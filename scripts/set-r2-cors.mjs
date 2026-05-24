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
 *   # Pull production R2 creds into .env, then run.
 *   vercel env pull .env
 *   node scripts/set-r2-cors.mjs               # apply (idempotent)
 *   node scripts/set-r2-cors.mjs --get         # show what's live
 *   node scripts/set-r2-cors.mjs --dry-run     # print the policy, don't push
 *
 * Requires the same env as the API: S3_ENDPOINT, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, S3_BUCKET. R2 implements the S3 PutBucketCors
 * API verbatim, so this script also works against AWS S3 and B2.
 */

import {
	S3Client,
	GetBucketCorsCommand,
	PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { readFileSync, existsSync } from 'node:fs';

// Lightweight .env loader so this runs standalone without dotenv as a dep.
loadDotenv('.env');

const required = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
	console.error(`Missing env: ${missing.join(', ')}`);
	console.error('Hint: run `vercel env pull .env` first.');
	process.exit(1);
}

// Web origins allowed to read assets from R2 and to PUT uploads via presigned
// URLs. Keep this list authoritative — any origin not listed will be blocked
// by the browser even if the URL itself is correct.
const ALLOWED_ORIGINS = [
	'https://three.ws',
	'https://www.three.ws',
	'https://3d-agent.vercel.app',
	'http://localhost:3000',
	'http://localhost:5173',
	// GitHub Codespaces preview hosts: {name}-{port}.app.github.dev
	'https://*.app.github.dev',
];

const POLICY = {
	CORSRules: [
		{
			ID: 'public-read',
			AllowedOrigins: ALLOWED_ORIGINS,
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

if (flag('--get')) {
	const current = await getCors();
	console.log(JSON.stringify(current, null, 2));
	process.exit(0);
}

if (flag('--dry-run')) {
	console.log('Would apply to bucket:', Bucket);
	console.log(JSON.stringify(POLICY, null, 2));
	process.exit(0);
}

const before = await getCors();
await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: POLICY }));
const after = await getCors();

if (JSON.stringify(before) === JSON.stringify(after)) {
	console.log(`CORS policy on ${Bucket} unchanged (already current).`);
} else {
	console.log(`Applied CORS policy to ${Bucket}.`);
	console.log('Rules:', after.CORSRules.map((r) => `${r.ID || '(no id)'} → ${r.AllowedMethods.join(',')}`).join(' | '));
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
