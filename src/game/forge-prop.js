// Forge-in-world: turn a text prompt (or a reference photo) into a placeable
// GLB prop without leaving /play. This module is the network half only; it
// drives the same free draft lane the /forge page uses (POST /api/forge →
// poll GET /api/forge?job=) and resolves to a durable R2-hosted GLB URL that
// the multiplayer server's asset allow-list accepts, so the finished model can
// ride the existing obj:spawn channel and appear for everyone in the world.
// The UI/placement half lives in coincommunities.js (_forgeProp) and reuses
// the uploaded-prop pipeline (world-objects.js registerUploadedProp).

import { log } from '../shared/log.js';

const SUBMIT_URL = '/api/forge';
const UPLOAD_URL = '/api/forge-upload';
const POLL_MS = 2500;
// Draft-tier generations land in ~30-60s; leave generous headroom for a cold
// GPU start (the submit response advertises 90s of cold-start alone).
const MAX_WAIT_MS = 6 * 60 * 1000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // mirrors /api/forge-upload's cap

// Same anonymous handle the /forge page keys creations to, so items forged
// in-world show up in the same gallery/history as the rest of this browser's
// forges instead of forming a disconnected second identity.
function forgeClientId() {
	const KEY = 'forge:cid';
	try {
		let id = localStorage.getItem(KEY);
		if (!id) {
			id =
				crypto?.randomUUID?.() ||
				`c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(KEY, id);
		}
		return id;
	} catch {
		return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

function headers(extra = {}) {
	return { 'x-forge-client': forgeClientId(), ...extra };
}

// A short palette-friendly display name for the forged prop.
export function forgePropName(prompt, file) {
	const base = String(prompt || '').trim() || String(file?.name || '').replace(/\.[a-z0-9]+$/i, '');
	return (base || 'Forged item').slice(0, 24);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throwIfAborted(signal) {
	if (signal?.aborted) throw new ForgeError('Forge cancelled.', { cancelled: true });
}

/** Error with user-facing message plus machine flags (rateLimited/cancelled). */
export class ForgeError extends Error {
	constructor(message, { rateLimited = false, cancelled = false } = {}) {
		super(message);
		this.name = 'ForgeError';
		this.rateLimited = rateLimited;
		this.cancelled = cancelled;
	}
}

async function readJson(res) {
	try { return await res.json(); } catch { return {}; }
}

function submitError(res, data) {
	if (res.status === 429) {
		return new ForgeError('The forge is busy right now. Give it a minute and try again.', { rateLimited: true });
	}
	const detail = typeof data?.error === 'string' && data.error.length < 200 ? data.error : '';
	return new ForgeError(detail ? `The forge refused that: ${detail}` : 'The forge could not take that request.');
}

// Push the reference image into forge storage via the presigned-PUT path the
// /forge page uses, returning a public URL /api/forge accepts in image_urls.
async function uploadReferenceImage(file, { onStatus, signal } = {}) {
	if (!IMAGE_TYPES.has(file.type)) {
		throw new ForgeError('Reference images must be a PNG, JPEG, or WebP.');
	}
	if (file.size > MAX_IMAGE_BYTES) {
		throw new ForgeError('That image is over 8 MB. Shrink it and try again.');
	}
	onStatus?.('Uploading your reference image…');
	const presign = await fetch(UPLOAD_URL, {
		method: 'POST',
		headers: headers({ 'content-type': 'application/json' }),
		body: JSON.stringify({ content_type: file.type, size_bytes: file.size }),
		signal,
	});
	const grant = await readJson(presign);
	if (!presign.ok || !grant.upload_url || !grant.public_url) {
		if (presign.status === 503) {
			throw new ForgeError('Image uploads are unavailable right now. Try a text prompt instead.');
		}
		throw submitError(presign, grant);
	}
	const put = await fetch(grant.upload_url, {
		method: grant.method || 'PUT',
		headers: grant.headers || { 'content-type': file.type },
		body: file,
		signal,
	});
	if (!put.ok) throw new ForgeError('The image upload failed. Check your connection and try again.');
	return grant.public_url;
}

function statusLine(state, etaSeconds) {
	const eta = Number.isFinite(etaSeconds) && etaSeconds > 0 ? ` (~${Math.round(etaSeconds)}s)` : '';
	return state === 'queued' ? `Forging: waiting for a slot${eta}…` : `Forging your model${eta}…`;
}

/**
 * Generate a placeable 3D prop from a prompt and/or reference image.
 * Resolves once the free draft lane finishes and the GLB has a stable URL.
 *
 * @param {object} req
 * @param {string} [req.prompt]  what to forge (3+ chars; required without a file)
 * @param {File}   [req.file]    optional reference image (png/jpeg/webp ≤ 8 MB)
 * @param {(msg: string) => void} [req.onStatus]  live progress line for the UI
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<{url: string, name: string, durable: boolean, creationId: string|null}>}
 * @throws {ForgeError} with a user-facing message on every failure path
 */
export async function forgeWorldProp({ prompt = '', file = null, onStatus, signal } = {}) {
	const text = String(prompt || '').trim();
	if (!file && text.length < 3) {
		throw new ForgeError('Describe the item in a few words (or attach a photo).');
	}

	const body = { tier: 'draft', path: 'image' };
	if (file) {
		body.image_urls = [await uploadReferenceImage(file, { onStatus, signal })];
		if (text) body.prompt = text;
	} else {
		body.prompt = text;
	}

	throwIfAborted(signal);
	onStatus?.('Sending to the forge…');
	const res = await fetch(SUBMIT_URL, {
		method: 'POST',
		headers: headers({ 'content-type': 'application/json' }),
		body: JSON.stringify(body),
		signal,
	});
	const data = await readJson(res);
	if (!res.ok) throw submitError(res, data);

	const name = forgePropName(text, file);
	if (data.status === 'done' && data.glb_url) {
		return { url: data.glb_url, name, durable: data.durable !== false, creationId: data.creation_id || null };
	}
	if (!data.job_id) throw new ForgeError('The forge did not accept that request. Try rephrasing it.');

	onStatus?.(statusLine('queued', data.eta_seconds));
	const deadline = Date.now() + MAX_WAIT_MS;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		await sleep(POLL_MS);
		throwIfAborted(signal);
		let poll;
		try {
			poll = await fetch(`${SUBMIT_URL}?job=${encodeURIComponent(data.job_id)}`, { headers: headers(), signal });
		} catch (err) {
			if (signal?.aborted) throw new ForgeError('Forge cancelled.', { cancelled: true });
			// A dropped poll is not a dropped job: the generation keeps running
			// server-side, so ride out transient network blips and poll again.
			log.warn('[forge-prop] poll transport error, retrying:', err?.message || err);
			continue;
		}
		if (poll.status === 429) { onStatus?.('Forging: easing off the status checks…'); await sleep(POLL_MS * 2); continue; }
		const job = await readJson(poll);
		if (job.status === 'done' && job.glb_url) {
			return { url: job.glb_url, name, durable: job.durable !== false, creationId: job.creation_id || null };
		}
		if (job.status === 'failed') {
			const detail = typeof job.error === 'string' && job.error.length < 200 ? job.error : '';
			throw new ForgeError(detail ? `The forge could not build that: ${detail}` : 'The forge could not build that. Try different wording.');
		}
		onStatus?.(statusLine(job.status === 'queued' ? 'queued' : 'running', job.eta_seconds));
	}
	throw new ForgeError('The forge is taking too long. Your item may still finish in the /forge gallery.');
}
