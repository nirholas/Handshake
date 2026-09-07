// @ts-check
// Object storage (Cloudflare R2) credential + reachability sensor.
//
// Why this exists: on 2026-09-07 the bucket credential stopped verifying and
// EVERY signed operation began failing with `SignatureDoesNotMatch`: the forge
// could not park a reference image, so text→3D returned a 502 for every user on
// every surface, and /cdn/* answered `upstream_error` for every avatar,
// thumbnail and GLB on the site. Production healthz reported `forge_generation:
// ok, 89% success` throughout, because the outcome sensor reads rows in
// forge_creations and this failure happens BEFORE the row is written: a total
// outage looked exactly like a quiet hour. Nothing else in the platform holds a
// signal for "our storage credential is rejected", so it went unseen for hours
// and was reported by users, not by us.
//
// The probe is a signed, read-only ListObjectsV2 capped at one key. It touches
// no object in particular (so it cannot be fooled by a deleted canary), it costs
// one Class-B operation, and it exercises the exact thing that broke: the
// signature. A rejected credential fails the same way for reads and writes, so
// one read proves both.
//
// Verdicts:
//   unknown  : storage isn't configured on this deployment (local/dev): neutral.
//   ok       : the bucket answered a signed request.
//   down     : the credential was rejected, or the endpoint is unreachable.
//   degraded : the bucket answered, but slowly enough to hurt every asset read.

import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2, objectStorageConfigured, isStorageInfrastructureError } from '../r2.js';
import { env } from '../env.js';

const PROBE_TIMEOUT_MS = 3_000;
// R2 normally answers a one-key list in well under 200ms from Cloud Run. A
// second is already slow enough that every gallery page feels it, so it is worth
// surfacing before it becomes an outage.
const SLOW_MS = 1_000;

/**
 * Classify a probe outcome. Pure, so the thresholds and the credential-vs-latency
 * distinction are unit-testable without a bucket.
 * @param {{ configured: boolean, ok?: boolean, latencyMs?: number, error?: unknown }} probe
 * @returns {{ status: 'ok'|'degraded'|'down'|'unknown', detail: string, hint?: string }}
 */
export function classifyObjectStorageProbe(probe) {
	if (!probe?.configured) {
		return { status: 'unknown', detail: 'object storage not configured on this deployment' };
	}
	if (probe.ok) {
		const ms = Math.round(Number(probe.latencyMs) || 0);
		if (ms >= SLOW_MS) {
			return {
				status: 'degraded',
				detail: `bucket reachable but slow (signed list ${ms}ms)`,
				hint: 'Every avatar, thumbnail and generated GLB is read through this bucket. Check the R2 endpoint region and Cloud Run egress before it turns into read timeouts.',
			};
		}
		return { status: 'ok', detail: `signed read ok (${ms}ms)` };
	}
	const err = /** @type {any} */ (probe.error);
	const message = String(err?.message || err || 'unknown error');
	// The compact code lives in name/Code and the sentence in message, so read
	// both: `SignatureDoesNotMatch` never appears in the text a user or a log
	// line sees (see isStorageInfrastructureError in ../r2.js).
	const rejected = /signaturedoesnotmatch|does not match the signature|invalidaccesskeyid|access denied|forbidden/i.test(
		[err?.name, err?.Code, message].filter(Boolean).join(' '),
	);
	return {
		status: 'down',
		detail: rejected
			? `bucket rejected our credential: ${message.slice(0, 160)}`
			: `bucket unreachable: ${message.slice(0, 160)}`,
		hint: rejected
			? 'The credential is wrong, not the code, and NO lane failover routes around it: the forge cannot park a reference image, uploads cannot land, and /cdn falls back to the rate-limited public bucket domain. `SignatureDoesNotMatch` with a working access key id means the SECRET is wrong: on Cloudflare R2 the secret access key is the token\'s SHA-256 digest, not the API token value, and a trailing newline in the stored secret fails identically (env.js trims it, so a padded value can only come from a store that is read elsewhere). Re-set S3_SECRET_ACCESS_KEY on the Cloud Run service and redeploy nothing else.'
			: 'The bucket endpoint is unreachable from Cloud Run. Check S3_ENDPOINT and Cloudflare R2 status; reads fail over to the public bucket domain meanwhile, writes do not fail over at all.',
	};
}

/**
 * Run the signed probe and classify it. Never throws.
 * @returns {Promise<{ name: 'object_storage', label: string, status: string, detail: string, hint?: string, metrics?: object }>}
 */
export async function gatherObjectStorageHealth() {
	const base = { name: /** @type {const} */ ('object_storage'), label: 'Object storage (Cloudflare R2)' };
	if (!objectStorageConfigured()) {
		const v = classifyObjectStorageProbe({ configured: false });
		return { ...base, status: v.status, detail: v.detail };
	}
	const started = Date.now();
	try {
		await r2.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, MaxKeys: 1 }), {
			abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const latencyMs = Date.now() - started;
		const v = classifyObjectStorageProbe({ configured: true, ok: true, latencyMs });
		return { ...base, status: v.status, detail: v.detail, ...(v.hint ? { hint: v.hint } : {}), metrics: { latencyMs } };
	} catch (err) {
		const latencyMs = Date.now() - started;
		const v = classifyObjectStorageProbe({ configured: true, ok: false, latencyMs, error: err });
		return {
			...base,
			status: v.status,
			detail: v.detail,
			...(v.hint ? { hint: v.hint } : {}),
			metrics: { latencyMs, credentialFault: isStorageInfrastructureError(err) },
		};
	}
}
