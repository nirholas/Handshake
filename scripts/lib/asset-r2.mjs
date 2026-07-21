// Shared R2 client for the asset-ingestion pipelines (Mixamo, Quaternius, CMU,
// Poly Pizza, …). Every puller/converter/thumbnailer/manifest-publisher uses
// this so the credential loading and S3 wiring live in one place.
//
// Reads S3_* (with older R2_* names as a fallback) from process.env, then
// .env.local. Same names production (Cloud Run) uses.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

export function loadEnvVar(key) {
	if (process.env[key]) return process.env[key].trim();
	const p = join(ROOT, '.env.local');
	if (existsSync(p)) {
		const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
		if (line) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
	}
	return null;
}

export const S3_ENDPOINT = loadEnvVar('S3_ENDPOINT') ||
	(loadEnvVar('R2_ACCOUNT_ID') ? `https://${loadEnvVar('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com` : null);
export const S3_ACCESS_KEY_ID = loadEnvVar('S3_ACCESS_KEY_ID') || loadEnvVar('R2_ACCESS_KEY_ID');
export const S3_SECRET_ACCESS_KEY = loadEnvVar('S3_SECRET_ACCESS_KEY') || loadEnvVar('R2_SECRET_ACCESS_KEY');
export const S3_BUCKET = loadEnvVar('S3_BUCKET') || loadEnvVar('R2_BUCKET') || 'test';
export const S3_PUBLIC_DOMAIN = (loadEnvVar('S3_PUBLIC_DOMAIN') || '').replace(/\/+$/, '');

export function haveR2Creds() {
	return !!(S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);
}

let _client = null;
export function r2() {
	if (_client) return _client;
	if (!haveR2Creds()) throw new Error('R2 creds missing — need S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
	_client = new S3Client({
		region: 'auto',
		endpoint: S3_ENDPOINT,
		credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
	});
	return _client;
}

/** Absolute CDN URL for an R2 key. */
export function cdnUrl(key) {
	return `${S3_PUBLIC_DOMAIN}/${key}`;
}

export async function getObject(key) {
	const res = await r2().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
	return Buffer.from(await res.Body.transformToByteArray());
}

export async function putObject(key, body, contentType, cacheControl = 'public, max-age=86400') {
	await r2().send(new PutObjectCommand({
		Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl,
	}));
}

export async function objectExists(key) {
	try { await r2().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key })); return true; }
	catch { return false; }
}

/** List every object key under a prefix (handles pagination). */
export async function listKeys(prefix) {
	const keys = [];
	let token;
	do {
		const res = await r2().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token }));
		for (const o of res.Contents || []) keys.push({ key: o.Key, size: o.Size });
		token = res.IsTruncated ? res.NextContinuationToken : null;
	} while (token);
	return keys;
}

/**
 * Publish a library manifest to R2 (the shape /api/<...>/library endpoints read).
 * @param {string} key e.g. 'avatars/library/manifest.json' or 'objects/library/manifest.json'
 * @param {object} manifest e.g. { generated_at, total, items:[…] }
 */
export async function publishManifest(key, manifest) {
	await putObject(key, JSON.stringify(manifest), 'application/json', 'public, max-age=300');
}
