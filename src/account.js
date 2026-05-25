// Lightweight client helpers for talking to the three.ws backend from the viewer.
// Keeps the UI code in app.js/avatar-creator.js clean.

import { identifyUser, resetIdentity } from './analytics.js';

const API = ''; // same origin

// Single-use CSRF token: fetched lazily, burned by the server on consumption.
// Re-issued on the next mutating call. Matches the dashboard's pattern so any
// page using apiFetch gets CSRF-gated endpoints (PUT/PATCH/DELETE on agents,
// keys, withdrawals, marketplace, etc.) for free.
let _csrfToken = null;
async function getCsrfToken() {
	if (_csrfToken) return _csrfToken;
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) return null;
	const j = await r.json().catch(() => null);
	_csrfToken = j?.data?.token || null;
	return _csrfToken;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// Wrapped fetch that handles expired sessions centrally. A 401 response is
// treated as a session-expiry signal and redirects to /login?next=<current>
// with the URL hash preserved (SPAs lose it on a naked location.href hop).
// Pass allowAnonymous:true for endpoints where a 401 is a legitimate
// "not signed in" answer the caller wants to inspect itself (e.g. /api/auth/me).
//
// Safe-method requests retry once on transient 5xx / network failures —
// Vercel cold starts and dev-server restarts surface as 502s, and a silent
// second attempt hides the blip. Mutating methods don't retry: the body is
// already on the wire and the server may have processed it.
export async function apiFetch(path, options = {}) {
	const { allowAnonymous = false, ...init } = options;
	const method = (init.method || 'GET').toUpperCase();
	const canRetry = SAFE_METHODS.has(method);

	// Mutating same-origin requests need a CSRF token. Skip for bearer-auth
	// callers — the server exempts Authorization: Bearer requests.
	const headers = new Headers(init.headers || {});
	const hasBearer = (headers.get('authorization') || '').startsWith('Bearer ');
	if (!SAFE_METHODS.has(method) && !hasBearer) {
		const token = await getCsrfToken();
		if (token) headers.set('x-csrf-token', token);
		_csrfToken = null;
	}

	const doFetch = () =>
		fetch(path, {
			credentials: 'include',
			...init,
			headers,
		});

	// Two retries with 400ms → 1.2s backoff for safe methods. Covers a Vercel
	// cold start (~600ms) plus one transient proxy blip; non-mutating so re-
	// firing is free. Mutating methods (POST/PUT) never retry — the body is
	// already on the wire and the server may have committed it.
	let res;
	let lastErr;
	const maxAttempts = canRetry ? 3 : 1;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
		}
		try {
			res = await doFetch();
		} catch (networkErr) {
			lastErr = networkErr;
			res = undefined;
			continue;
		}
		if (canRetry && TRANSIENT_STATUSES.has(res.status)) continue;
		break;
	}
	if (!res) throw lastErr;

	if (res.status === 401 && !allowAnonymous) {
		redirectToLogin();
		const err = new Error('session expired');
		err.status = 401;
		err.redirected = true;
		throw err;
	}
	return res;
}

function redirectToLogin() {
	if (typeof location === 'undefined') return;
	// Don't loop if we're already on the login page.
	if (/^\/login(\/|$|\?)/.test(location.pathname)) return;
	const next = location.pathname + location.search + location.hash;
	location.href = '/login?next=' + encodeURIComponent(next);
}

// Optimistic auth hint — non-authoritative, used only for first-paint gating
// on the viewer. The real session cookie is HttpOnly so we can't read it
// synchronously; this hint lets us avoid a visible flash between "pending"
// and the resolved state for returning users. Always revalidated by getMe().
const AUTH_HINT_KEY = '3dagent:auth-hint';
const AUTH_HINT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7d

export function readAuthHint() {
	try {
		const raw = localStorage.getItem(AUTH_HINT_KEY);
		if (!raw) return null;
		const { authed, ts } = JSON.parse(raw);
		if (!ts || Date.now() - ts > AUTH_HINT_TTL_MS) return null;
		return authed ? 'true' : 'false';
	} catch {
		return null;
	}
}

function writeAuthHint(authed) {
	try {
		localStorage.setItem(AUTH_HINT_KEY, JSON.stringify({ authed: !!authed, ts: Date.now() }));
	} catch {
		/* quota or disabled storage */
	}
}

export function clearAuthHint() {
	try {
		localStorage.removeItem(AUTH_HINT_KEY);
	} catch {
		/* ignore */
	}
}

export async function getMe() {
	// /api/auth/me 401s for anonymous visitors by design — handle in place.
	const res = await apiFetch(`${API}/api/auth/me`, { allowAnonymous: true });
	if (res.status === 401) {
		writeAuthHint(false);
		resetIdentity();
		return null;
	}
	if (!res.ok) throw new Error(`auth/me failed: ${res.status}`);
	const user = (await res.json()).user;
	writeAuthHint(!!user);
	if (user) identifyUser(user);
	return user;
}

// Uploads a GLB to our R2 bucket and creates the avatar record.
// `source` may be a Blob (from CharacterStudio postMessage) or a URL string.
//
// Pass `opts.onProgress(pct)` to receive 0..100 upload-percentage callbacks
// (R2 PUT only — presign + commit are negligible by comparison).
//
// Errors carry a `.stage` ('fetch' | 'canonicalize' | 'presign' | 'upload' |
// 'commit') and may carry a `.code` for the UI to act on:
//   - 'upload_blocked'  — XHR completed with status 0 (CORS preflight or
//                         a network drop between the browser and R2).
//   - 'upload_failed'   — R2 returned a non-2xx (auth/signature/checksum).
//   - 'not_signed_in'   — propagated from apiFetch when the cookie is gone.
//
// No explicit auth pre-check: `presign` requires a session, so if the cookie
// is missing or expired apiFetch redirects to /login (and throws with
// err.redirected = true). Callers that want post-login resume should set
// their sentinel BEFORE calling — apiFetch's redirect happens synchronously.
export async function saveRemoteGlbToAccount(source, meta = {}, opts = {}) {
	const { onProgress, signal } = opts;
	const throwIfAborted = () => {
		if (signal?.aborted) {
			throw stageError('upload', 'Upload aborted', { code: 'upload_aborted' });
		}
	};
	throwIfAborted();

	// Preflight the session ourselves so the caller can set up post-login
	// resume state *before* any redirect. apiFetch's built-in 401 handler
	// would jump to /login synchronously, leaving no window to stash a
	// sentinel — we'd lose the staged blob across the round-trip.
	// Tolerate transient probe failures: a 5xx on /api/auth/me (Vercel cold
	// start, dev-proxy hiccup) shouldn't block the upload. If we're truly
	// signed out, the presign call below will 401 and apiFetch redirects.
	let me;
	try {
		me = await getMe();
	} catch (err) {
		console.warn('[account] getMe probe failed, proceeding optimistically:', err?.message);
		me = { id: null, optimistic: true };
	}
	if (me === null) throw stageError('auth', 'Not signed in', { code: 'not_signed_in' });

	let blob;
	if (source instanceof Blob) {
		blob = source;
	} else {
		try {
			const resp = await fetch(source, { mode: 'cors' });
			if (!resp.ok)
				throw stageError('fetch', `failed to fetch source GLB: ${resp.status}`);
			blob = await resp.blob();
		} catch (err) {
			if (err.stage) throw err;
			throw stageError('fetch', err.message || 'failed to fetch source GLB');
		}
	}

	// Canonicalize humanoid bone names before upload so the pre-baked Mixamo
	// animation library plays out of the box. Non-fatal — if the buffer isn't
	// a valid GLB or the rig isn't humanoid, fall through with the original.
	let retargetedBoneCount = 0;
	try {
		const { canonicalizeGLBBones } = await import('./glb-canonicalize.js');
		const buf = await blob.arrayBuffer();
		const result = canonicalizeGLBBones(buf);
		if (result.renamed > 0) {
			blob = new Blob([result.buffer], { type: 'model/gltf-binary' });
			retargetedBoneCount = result.renamed;
		}
	} catch (err) {
		console.warn('[account] canonicalize failed; uploading original', err);
	}

	const size = blob.size;
	const contentType = blob.type || 'model/gltf-binary';
	const checksum = await sha256Hex(blob);

	// Presign + direct browser→R2 PUT is the happy path: cheapest, doesn't
	// route bytes through our function. When the deploy origin isn't in the
	// bucket CORS allowlist (ephemeral Codespaces hosts, branch deploys with a
	// new hostname), the preflight fails. In that case fall through to the
	// server-side proxy upload so the save always completes regardless of
	// bucket CORS state.
	let storageKey = null;
	let presign = null;

	try {
		presign = await postJson('/api/avatars/presign', {
			size_bytes: size,
			content_type: contentType,
			checksum_sha256: checksum,
		});
	} catch (err) {
		err.stage = err.stage || 'presign';
		throw err;
	}

	try {
		await putToR2({
			url: presign.upload_url,
			blob,
			contentType,
			onProgress,
			signal,
		});
		storageKey = presign.storage_key;
	} catch (err) {
		if (err.code === 'upload_aborted') throw err;
		if (err.code !== 'upload_blocked') {
			err.stage = err.stage || 'upload';
			throw err;
		}
		console.warn('[account] direct R2 PUT blocked; retrying via server proxy');
		// Reset progress so the proxy attempt restarts visibly at 0% rather than
		// looking stuck at whatever the direct PUT reached before failing.
		onProgress?.(0);
		try {
			const proxied = await uploadViaProxy({
				blob,
				contentType,
				checksum,
				onProgress,
				signal,
			});
			storageKey = proxied.storage_key;
		} catch (proxyErr) {
			proxyErr.stage = proxyErr.stage || 'upload';
			throw proxyErr;
		}
	}

	const sourceMeta = {
		...(meta.source_meta ||
			(typeof source === 'string' ? { source_url: source } : { generator: 'characterstudio' })),
		...(retargetedBoneCount > 0 ? { retargeted_bones: retargetedBoneCount } : {}),
	};

	let created;
	try {
		created = await postJson('/api/avatars', {
			storage_key: storageKey,
			size_bytes: size,
			content_type: contentType,
			checksum_sha256: checksum,
			name: meta.name || deriveAvatarName(source, checksum),
			description: meta.description,
			visibility: meta.visibility || 'public',
			tags: meta.tags || [],
			source: meta.source || 'upload',
			source_meta: sourceMeta,
		});
	} catch (err) {
		err.stage = err.stage || 'commit';
		throw err;
	}
	const avatar = created.avatar;

	// Fire-and-forget thumbnail + auto-tag pipeline. Doesn't block the caller.
	// Uses a hidden off-screen model-viewer to render the GLB, captures a JPEG
	// poster, uploads to R2, and calls Claude Haiku for tags + description.
	captureAndTagAvatar(avatar.id, storageKey).catch((err) => {
		console.warn('[account] thumbnail/auto-tag pipeline failed silently', err?.message);
	});

	// USDZ + half-body companion generation is opt-in (the demo page at
	// /demos/usdz-ar passes generateCompanions:true). The live /create flow
	// stays untouched — those derivations run client-side and add several
	// seconds of CPU on every save, so they don't ship to all users yet.
	if (meta.generateCompanions) {
		generateAndSaveCompanions(avatar.id, blob).catch((err) => {
			console.warn('[account] usdz/halfbody pipeline failed silently', err?.message);
		});
	}

	return avatar;
}

export async function generateAndSaveCompanions(avatarId, glbBlob) {
	const { glbBlobToUsdzBlob, glbBlobToHalfBodyBlob, glbBlobToArkitReport } = await import(
		'./usdz-pipeline.js'
	);

	// ARKit-52 conformance check — runs in the background, dispatches a
	// `three-ws:arkit-report` CustomEvent so pages can show coverage to the
	// user. Independent of usdz / halfbody passes so a failure here doesn't
	// block them.
	(async () => {
		let report;
		try {
			report = await glbBlobToArkitReport(glbBlob);
		} catch (err) {
			console.warn('[account] arkit report failed:', err?.message);
			return;
		}
		console.info(
			`[account] avatar ${avatarId} ARKit-52 coverage: ${Math.round(report.coverage * 100)}% (${report.implemented.length}/52)`,
		);
		try {
			document.dispatchEvent(
				new CustomEvent('three-ws:arkit-report', {
					detail: { avatarId, ...report },
				}),
			);
		} catch (_) {}
	})();

	// USDZ companion for iOS Quick Look. Independent of the half-body pass so
	// a failure in one doesn't poison the other.
	(async () => {
		let usdzBlob;
		try {
			usdzBlob = await glbBlobToUsdzBlob(glbBlob);
		} catch (err) {
			console.warn('[account] usdz export failed:', err?.message);
			return;
		}
		try {
			const pre = await postJson('/api/avatars/presign-usdz', {
				avatar_id: avatarId,
				size_bytes: usdzBlob.size,
			});
			const put = await fetch(pre.upload_url, {
				method: 'PUT',
				headers: { 'content-type': 'model/vnd.usdz+zip' },
				body: usdzBlob,
			});
			if (!put.ok) throw new Error(`R2 usdz upload failed: ${put.status}`);
			await apiFetch(`/api/avatars/${avatarId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ usdz_key: pre.usdz_key }),
			});
		} catch (err) {
			console.warn('[account] usdz upload/patch failed:', err?.message);
		}
	})();

	// Half-body variant for VR. Optional — not every avatar has the recognizable
	// lower-body bones we need to strip, in which case the generator throws and
	// we silently skip.
	(async () => {
		let halfBlob;
		try {
			halfBlob = await glbBlobToHalfBodyBlob(glbBlob);
		} catch (err) {
			// Expected when an avatar has no leg bones (busts, robots, non-humans).
			return;
		}
		try {
			const pre = await postJson('/api/avatars/presign-halfbody', {
				avatar_id: avatarId,
				size_bytes: halfBlob.size,
			});
			const put = await fetch(pre.upload_url, {
				method: 'PUT',
				headers: { 'content-type': 'model/gltf-binary' },
				body: halfBlob,
			});
			if (!put.ok) throw new Error(`R2 halfbody upload failed: ${put.status}`);
			await apiFetch(`/api/avatars/${avatarId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ halfbody_key: pre.halfbody_key }),
			});
		} catch (err) {
			console.warn('[account] halfbody upload/patch failed:', err?.message);
		}
	})();
}

async function captureAndTagAvatar(avatarId, storageKey) {
	// Resolve the public GLB URL from the storage key.
	const glbUrl = storageKey.startsWith('http')
		? storageKey
		: `${location.origin}/api/avatars/${avatarId}?url=1`;

	// We need the actual R2 public URL. Get it from the avatar record.
	let publicGlb;
	try {
		const r = await apiFetch(`/api/avatars/${avatarId}`);
		if (!r.ok) return;
		const j = await r.json();
		publicGlb = j.avatar?.url || j.avatar?.model_url;
		if (!publicGlb) return;
	} catch { return; }

	// Render in a tiny off-screen model-viewer element.
	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', publicGlb);
	mv.setAttribute('camera-orbit', '0deg 75deg 105%');
	mv.setAttribute('exposure', '1');
	mv.setAttribute('shadow-intensity', '0.6');
	mv.setAttribute('tone-mapping', 'aces');
	mv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:512px;height:512px;opacity:0;pointer-events:none;';
	document.body.appendChild(mv);

	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('model-viewer load timeout')), 25_000);
		mv.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
		mv.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('model-viewer load error')); }, { once: true });
	});

	// Give the renderer one frame to paint.
	await new Promise((r) => requestAnimationFrame(r));
	await new Promise((r) => requestAnimationFrame(r));

	// Capture poster as JPEG blob.
	let thumbBlob;
	try {
		thumbBlob = await mv.toBlob({ mimeType: 'image/jpeg', qualityArgument: 0.82 });
	} finally {
		document.body.removeChild(mv);
	}
	if (!thumbBlob || thumbBlob.size < 500) return;

	// Get a presigned upload URL for the thumbnail.
	const presignRes = await postJson('/api/avatars/presign-thumbnail', {
		avatar_id: avatarId,
		size_bytes: thumbBlob.size,
	});

	// Upload the JPEG to R2.
	const putRes = await fetch(presignRes.upload_url, {
		method: 'PUT',
		headers: { 'content-type': 'image/jpeg' },
		body: thumbBlob,
	});
	if (!putRes.ok) throw new Error(`thumbnail R2 upload failed: ${putRes.status}`);

	// Patch the avatar to store the thumbnail_key, then auto-tag via Claude vision.
	await apiFetch(`/api/avatars/${avatarId}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ thumbnail_key: presignRes.thumb_key }),
	});

	// Auto-tag (non-fatal — Claude vision call).
	await postJson('/api/avatars/auto-tag', {
		avatar_id: avatarId,
		thumb_key: presignRes.thumb_key,
	});
}

// PUT a Blob to a presigned R2 URL via XHR so the caller can render real
// upload progress and so failures can be distinguished by cause:
//   - status 0       → preflight blocked, network drop, or signed-URL host
//                      unreachable. Almost always CORS in practice.
//   - 2xx            → success.
//   - non-2xx        → R2 returned an error (signature mismatch, expired URL,
//                      checksum failure). Body is text/xml; surface inline.
//
// onProgress is called with an integer 0..100. fetch() has no upload-progress
// hook in any browser, so XHR is the only path that works today.
function putToR2({ url, blob, contentType, onProgress, signal }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(stageError('upload', 'Upload aborted', { code: 'upload_aborted' }));
			return;
		}
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url, true);
		xhr.setRequestHeader('content-type', contentType);
		if (onProgress) {
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) {
					onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
				}
			};
			xhr.upload.onload = () => onProgress(100);
		}
		const onAbort = () => xhr.abort();
		if (signal) signal.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener('abort', onAbort);
		xhr.onload = () => {
			cleanup();
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
				return;
			}
			reject(
				stageError(
					'upload',
					`R2 upload failed: ${xhr.status} ${xhr.statusText || ''}`.trim(),
					{ code: 'upload_failed', status: xhr.status },
				),
			);
		};
		xhr.onerror = () => {
			cleanup();
			// status 0 ⇒ no HTTP response. CORS preflight failure is by far the
			// most common cause; surface a hint the UI can render.
			reject(
				stageError(
					'upload',
					'Upload was blocked before reaching R2 (likely a CORS or network issue).',
					{ code: 'upload_blocked' },
				),
			);
		};
		xhr.onabort = () => {
			cleanup();
			reject(stageError('upload', 'Upload aborted', { code: 'upload_aborted' }));
		};
		xhr.send(blob);
	});
}

// Server-side upload fallback used when a direct R2 PUT is blocked (CORS or
// network). Streams the blob to /api/avatars/upload, which PUTs it to R2
// using server-side credentials. Same auth + quota path as presign — we get
// back the storage_key to commit with /api/avatars.
//
// Uses XHR (not fetch) so onProgress works in every browser. CSRF is fetched
// from the same single-use endpoint apiFetch uses; we don't go through
// apiFetch because it can't propagate upload progress.
async function uploadViaProxy({ blob, contentType, checksum, onProgress, signal }) {
	if (signal?.aborted) {
		throw stageError('upload', 'Upload aborted', { code: 'upload_aborted' });
	}
	const csrf = await getCsrfToken();
	_csrfToken = null; // single-use, like apiFetch
	const qs = new URLSearchParams({ content_type: contentType });
	if (checksum) qs.set('sha256', checksum);
	const url = `${API}/api/avatars/upload?${qs.toString()}`;

	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', url, true);
		xhr.withCredentials = true;
		xhr.setRequestHeader('content-type', contentType);
		if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
		if (onProgress) {
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) {
					onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
				}
			};
			xhr.upload.onload = () => onProgress(100);
		}
		const onAbort = () => xhr.abort();
		if (signal) signal.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener('abort', onAbort);
		xhr.onload = () => {
			cleanup();
			if (xhr.status === 401) {
				redirectToLogin();
				reject(stageError('upload', 'session expired', { status: 401, code: 'not_signed_in' }));
				return;
			}
			let data = null;
			try {
				data = JSON.parse(xhr.responseText);
			} catch {
				/* non-JSON body */
			}
			if (xhr.status >= 200 && xhr.status < 300 && data?.storage_key) {
				resolve(data);
				return;
			}
			reject(
				stageError(
					'upload',
					data?.error_description || `proxy upload failed: ${xhr.status}`,
					{ code: data?.error || 'proxy_upload_failed', status: xhr.status },
				),
			);
		};
		xhr.onerror = () => {
			cleanup();
			reject(stageError('upload', 'proxy upload network error', { code: 'proxy_upload_failed' }));
		};
		xhr.onabort = () => {
			cleanup();
			reject(stageError('upload', 'proxy upload aborted', { code: 'upload_aborted' }));
		};
		xhr.send(blob);
	});
}

function stageError(stage, message, extras = {}) {
	const err = new Error(message);
	err.stage = stage;
	Object.assign(err, extras);
	return err;
}

async function postJson(path, body) {
	const res = await apiFetch(`${API}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = res.headers.get('content-type')?.includes('application/json')
		? await res.json()
		: null;
	if (!res.ok)
		throw Object.assign(new Error(data?.error_description || res.statusText), {
			status: res.status,
			data,
		});
	return data;
}

async function sha256Hex(blob) {
	const buf = await blob.arrayBuffer();
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

function deriveAvatarName(source, checksum) {
	if (source && typeof source === 'object' && typeof source.name === 'string') {
		const base = source.name.replace(/\.(glb|gltf)$/i, '').trim();
		if (base) return base.slice(0, 80);
	}
	if (typeof source === 'string') {
		try {
			const file = new URL(source).pathname.split('/').pop() || '';
			const base = file.replace(/\.(glb|gltf)$/i, '').trim();
			if (base) return base.slice(0, 80);
		} catch {
			/* ignore non-URL strings */
		}
	}
	return `Avatar #${checksum.slice(0, 6)}`;
}
