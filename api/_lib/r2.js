// S3-compatible storage client (works with AWS S3, Cloudflare R2, Backblaze B2, etc.)

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';

// Lazy client — S3Client constructor reads env credentials eagerly, so defer
// until first use to keep this module importable without storage configured.
let _r2;
function getR2() {
	if (!_r2) {
		_r2 = new S3Client({
			region: 'auto',
			endpoint: env.S3_ENDPOINT,
			credentials: {
				accessKeyId: env.S3_ACCESS_KEY_ID,
				secretAccessKey: env.S3_SECRET_ACCESS_KEY,
			},
			// AWS SDK v3 ≥ 3.730 adds CRC32 to every PutObject by default.
			// Browsers can't compute/send that header, so presigned PUT URLs
			// would be rejected by R2. Opt out until we add client-side CRC32.
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
		});
	}
	return _r2;
}
export const r2 = new Proxy(
	{},
	{
		get(_t, prop) {
			return getR2()[prop];
		},
	},
);

// Short-lived signed URL for direct browser upload (PUT).
export async function presignUpload({ key, contentType, checksumSha256 }) {
	// Do NOT include ContentLength in the command — that adds content-length to
	// X-Amz-SignedHeaders, which browsers omit from CORS preflights (it is a
	// "forbidden" request header). R2 would then reject the preflight, causing
	// a network-level failure before the PUT response is ever checked.
	// Size is validated server-side via headObject after upload.
	const cmd = new PutObjectCommand({
		Bucket: env.S3_BUCKET,
		Key: key,
		ContentType: contentType,
		ChecksumSHA256: checksumSha256,
	});
	return getSignedUrl(r2, cmd, { expiresIn: 300 });
}

// Signed URL for GET (used for private avatars or temporary shares).
export async function presignGet({ key, expiresIn = 600 }) {
	if (isAbsoluteUrl(key)) return key; // first-party/externally-hosted: already a public URL
	const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
	return getSignedUrl(r2, cmd, { expiresIn });
}

export async function headObject(key) {
	if (isAbsoluteUrl(key)) return null; // not a bucket object
	try {
		return await r2.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
	} catch (err) {
		if (err?.$metadata?.httpStatusCode === 404) return null;
		throw err;
	}
}

export async function deleteObject(key) {
	if (isAbsoluteUrl(key)) return; // externally-hosted asset — nothing in our bucket to delete
	await r2.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export async function putObject({ key, body, contentType, metadata = {} }) {
	await r2.send(
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: key,
			Body: body,
			ContentType: contentType,
			Metadata: metadata,
		}),
	);
}

// Server-side object copy (no download/re-upload). Used by avatar forks to
// duplicate a source GLB/thumbnail into the new owner's `u/{ownerId}/` namespace
// so the fork is a fully independent object. Returns false (and the caller can
// fall back to referencing the source URL) when the source is an absolute URL
// rather than a bucket object — those live outside our bucket and nothing needs
// copying.
export async function copyObject({ fromKey, toKey }) {
	if (isAbsoluteUrl(fromKey)) return false;
	await r2.send(
		new CopyObjectCommand({
			Bucket: env.S3_BUCKET,
			CopySource: `${env.S3_BUCKET}/${encodeR2Key(fromKey)}`,
			Key: toKey,
		}),
	);
	return true;
}

export async function getObjectBuffer(key) {
	const { Body } = await r2.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
	const chunks = [];
	for await (const chunk of Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}

// Read just the leading `length` bytes of an object via an HTTP Range request.
// Used by the rig classifier to read a GLB's glTF JSON chunk (which lives at
// the file head) without downloading the whole — potentially large — mesh.
export async function getObjectRange(key, length) {
	const { Body } = await r2.send(
		new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Range: `bytes=0-${length - 1}` }),
	);
	const chunks = [];
	for await (const chunk of Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}

// Public CDN URL for objects served via R2 custom domain / r2.dev.
//
// First-party / externally-hosted avatars store an absolute URL in their
// `storage_key` (e.g. https://three.ws/avatars/realistic-male.glb) rather than
// an R2 object key — these models live outside the bucket and are already
// fully-qualified, so they pass through untouched. Every bucket-backed key
// (the `u/{ownerId}/…` form) resolves against the CDN domain exactly as before,
// so existing avatars are unaffected.
export function publicUrl(key) {
	if (isAbsoluteUrl(key)) return key;
	return `${env.S3_PUBLIC_DOMAIN}/${encodeR2Key(key)}`;
}

function isAbsoluteUrl(key) {
	return typeof key === 'string' && /^https?:\/\//i.test(key);
}

// A thumbnail_key written by the pre-fix avatar-OG cache (it derived `_og.png`
// from an absolute storage_key, so the "key" was a full origin URL that
// publicUrl() passes through verbatim — pointing at the site instead of the R2
// CDN, where no object exists). Such keys 404; callers use this to drop or
// self-heal them rather than surface a broken image.
export function isLegacyOgThumbnailKey(thumbnailKey) {
	return /^https?:\/\/.*_og\.png$/i.test(String(thumbnailKey || ''));
}

// The ONE way to turn a stored thumbnail_key into a URL for an <img>.
//
// A thumbnail_key only resolves to a real image when it is a relative R2 key.
// Legacy poisoned keys (absolute, origin-pointing `*_og.png`) 404 — and a 404
// answered with a `text/plain` body is refused by Chrome's Opaque Response
// Blocking when it was requested as an image (net::ERR_BLOCKED_BY_ORB), so the
// browser logs an error instead of quietly showing nothing. Return null and let
// the caller render its designed placeholder.
//
// Every read path that surfaces a thumbnail to a browser must go through this,
// not bare publicUrl(). See docs/avatar-thumbnails.md.
export function thumbnailUrl(thumbnailKey) {
	if (!thumbnailKey || isLegacyOgThumbnailKey(thumbnailKey)) return null;
	return publicUrl(thumbnailKey);
}

function encodeR2Key(key) {
	return key.split('/').map(encodeURIComponent).join('/');
}
