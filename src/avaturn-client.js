/**
 * Avaturn client bridge — session creation + GLB retrieval via hidden iframe.
 *
 * Typical usage:
 *
 *   import { createAvaturnSession, awaitAvatarGLB, blobToDataUrl } from './avaturn-client.js';
 *
 *   const frontDataUrl = await blobToDataUrl(frontBlob);
 *   const leftDataUrl  = await blobToDataUrl(leftBlob);
 *   const rightDataUrl = await blobToDataUrl(rightBlob);
 *
 *   const { sessionUrl, expiresAt } = await createAvaturnSession({
 *       front: frontDataUrl, left: leftDataUrl, right: rightDataUrl,
 *   });
 *
 *   const { glbBytes, thumbnailUrl, metadata } = await awaitAvatarGLB({
 *       sessionUrl,
 *       onProgress: ({ step, pct }) => console.log(step, pct),
 *       signal: abortController.signal,
 *   });
 */

import { consumeCsrfToken } from './api.js';

const SESSION_ENDPOINT = '/api/onboarding/avaturn-session';
const OVERALL_TIMEOUT_MS = 120_000;
// Reject immediately if session expires within this many ms.
const EXPIRY_GRACE_MS = 10_000;

// ── Error ────────────────────────────────────────────────────────────────────

export class AvaturnError extends Error {
	/**
	 * @param {string} message
	 * @param {'quota'|'auth'|'session-expired'|'network'|'timeout'|'not-configured'} code
	 */
	constructor(message, code) {
		super(message);
		this.name = 'AvaturnError';
		this.code = code;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a Blob to a base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(/** @type {string} */ (reader.result));
		reader.onerror = () => reject(new AvaturnError('blobToDataUrl failed', 'network'));
		reader.readAsDataURL(blob);
	});
}

// ── Session creation ─────────────────────────────────────────────────────────

/**
 * Exchange three selfie data URLs for an Avaturn session URL.
 *
 * @param {{ front: string, left: string, right: string }} photos
 *   Base64 JPEG data URLs (use blobToDataUrl to convert Blobs).
 * @returns {Promise<{ sessionUrl: string, expiresAt: string | null }>}
 */
export async function createAvaturnSession({ front, left, right }) {
	let res;
	// The endpoint is a cookie-session mutation, so it carries the double-submit
	// CSRF check (api/_lib/csrf.js). apiFetch() would attach the token for us but
	// it also redirects the page to /login on a 401, which would swallow the
	// 'auth' AvaturnError callers below depend on; consumeCsrfToken() is the
	// documented escape hatch for exactly that case. A null token (signed out)
	// still goes out and comes back as the 401 this client already handles.
	const csrfToken = await consumeCsrfToken().catch(() => null);
	try {
		res = await fetch(SESSION_ENDPOINT, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'content-type': 'application/json',
				...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
			},
			// API schema field is 'frontal'; caller-facing param is 'front' for brevity.
			body: JSON.stringify({ photos: { frontal: front, left, right } }),
		});
	} catch (err) {
		throw new AvaturnError(`network error: ${err?.message}`, 'network');
	}

	if (!res.ok) {
		const payload = await res.json().catch(() => ({}));
		const code = payload?.error;
		// 501 not_configured = the avatar editor key is absent in this environment.
		// Surface a distinct code so callers can skip the editor step gracefully
		// rather than treating it as an auth failure the user could act on.
		if (res.status === 501 || code === 'not_configured')
			throw new AvaturnError(
				payload?.error_description || 'avatar editor is not available right now',
				'not-configured',
			);
		if (res.status === 401 || res.status === 403)
			throw new AvaturnError(payload?.error_description || 'unauthorized', 'auth');
		if (res.status === 429)
			throw new AvaturnError(payload?.error_description || 'rate limited', 'quota');
		throw new AvaturnError(payload?.error_description || `http ${res.status}`, 'network');
	}

	const data = await res.json();
	if (!data?.session_url) throw new AvaturnError('server returned no session_url', 'network');

	return { sessionUrl: data.session_url, expiresAt: data.expires_at ?? null };
}

// ── GLB retrieval via hidden iframe ──────────────────────────────────────────

/**
 * Mount a hidden Avaturn iframe, wait for the avatar to be exported, fetch the GLB.
 *
 * @param {{
 *   sessionUrl: string,
 *   onProgress?: (evt: { step: 'iframe-load'|'avatar-gen'|'glb-fetch', pct: number }) => void,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ glbBytes: ArrayBuffer, thumbnailUrl?: string, metadata?: object }>}
 */
export async function awaitAvatarGLB({ sessionUrl, onProgress, signal }) {
	// Reject immediately if the session has effectively expired.
	const expiresAt = _expiresAtFromUrl(sessionUrl);
	if (expiresAt !== null && expiresAt - Date.now() < EXPIRY_GRACE_MS) {
		throw new AvaturnError('session has expired', 'session-expired');
	}

	const progress = onProgress ?? (() => {});
	let iframe = null;
	let timeoutId = null;
	let messageListener = null;

	const cleanup = () => {
		if (timeoutId !== null) clearTimeout(timeoutId);
		if (messageListener) window.removeEventListener('message', messageListener);
		if (iframe?.parentNode) iframe.parentNode.removeChild(iframe);
		iframe = null;
	};

	return new Promise((resolve, reject) => {
		// Abort support.
		if (signal?.aborted) {
			return reject(new DOMException('Aborted', 'AbortError'));
		}
		const onAbort = () => {
			cleanup();
			reject(new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		// Overall timeout.
		timeoutId = setTimeout(() => {
			cleanup();
			signal?.removeEventListener('abort', onAbort);
			reject(new AvaturnError('timed out waiting for avatar export', 'timeout'));
		}, OVERALL_TIMEOUT_MS);

		// Derive allowed origin from sessionUrl so we never hardcode it.
		let expectedOrigin;
		try {
			expectedOrigin = new URL(sessionUrl).origin;
		} catch {
			cleanup();
			signal?.removeEventListener('abort', onAbort);
			return reject(new AvaturnError('invalid sessionUrl', 'network'));
		}

		// Hidden iframe.
		// Avaturn's editor needs allow-popups-to-escape-sandbox in addition to the
		// base set because it may open OAuth flows in a new window.
		iframe = document.createElement('iframe');
		iframe.style.display = 'none';
		iframe.setAttribute(
			'sandbox',
			'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
		);
		iframe.setAttribute('title', 'three.ws avatar export');
		iframe.setAttribute('aria-hidden', 'true');

		// postMessage listener — scoped strictly to the iframe's origin.
		messageListener = async (event) => {
			if (event.origin !== expectedOrigin) return;

			const msg = event.data;
			if (!msg || typeof msg !== 'object') return;

			// Avaturn fires postMessage events with:
			//   { source: 'avaturn', eventType: 'avatar.exported', data: { url, urlType, avatarId, thumbnailUrl, metadata } }
			// An earlier 'avatar.ready' event signals the editor is ready.
			// Ref: Avaturn iframe messaging protocol (see https://docs.avaturn.me — iframe events section).
			if (msg.source !== 'avaturn') return;

			const eventType = msg.eventType ?? msg.type;

			if (eventType === 'avatar.ready') {
				progress({ step: 'avatar-gen', pct: 10 });
				return;
			}

			if (eventType === 'avatar.exported' || eventType === 'export') {
				const glbUrl = msg.data?.url ?? msg.url;
				if (!glbUrl) return;

				progress({ step: 'glb-fetch', pct: 60 });

				try {
					let fetchRes;
					try {
						fetchRes = await fetch(glbUrl, { signal });
					} catch (err) {
						throw new AvaturnError(`GLB fetch failed: ${err?.message}`, 'network');
					}
					if (!fetchRes.ok)
						throw new AvaturnError(`GLB fetch ${fetchRes.status}`, 'network');

					const glbBytes = await fetchRes.arrayBuffer();
					progress({ step: 'glb-fetch', pct: 100 });

					cleanup();
					signal?.removeEventListener('abort', onAbort);
					resolve({
						glbBytes,
						thumbnailUrl: msg.data?.thumbnailUrl ?? undefined,
						metadata: msg.data?.metadata ?? undefined,
					});
				} catch (err) {
					cleanup();
					signal?.removeEventListener('abort', onAbort);
					reject(
						err instanceof AvaturnError
							? err
							: new AvaturnError(err?.message ?? 'unknown', 'network'),
					);
				}
			}
		};

		window.addEventListener('message', messageListener);

		iframe.addEventListener(
			'load',
			() => {
				progress({ step: 'iframe-load', pct: 5 });
			},
			{ once: true },
		);

		document.body.appendChild(iframe);
		progress({ step: 'iframe-load', pct: 0 });
		iframe.src = sessionUrl;
	});
}

/**
 * Attempt to read an expiry timestamp encoded in the session URL's query string
 * (e.g. ?expires_at=...). Returns epoch ms or null if not present / unparseable.
 * @param {string} sessionUrl
 * @returns {number|null}
 */
function _expiresAtFromUrl(sessionUrl) {
	try {
		const param = new URL(sessionUrl).searchParams.get('expires_at');
		if (!param) return null;
		const ms = Date.parse(param);
		return isNaN(ms) ? null : ms;
	} catch {
		return null;
	}
}
