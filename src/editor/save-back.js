import { exportEditedGLB } from './glb-export.js';
import { apiFetch } from '../api.js';

const MAX_BYTES = 25 * 1024 * 1024;

export class SaveError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'SaveError';
		this.code = code;
	}
}

/**
 * Export the current editor session and persist it back to the saved avatar.
 * @param {EditorSession} session
 * @param {{ avatarId: string, onStep?: (s: {step: string, pct: number}) => void }} opts
 * @returns {Promise<{ok: true, avatar: object}>}
 */
export async function saveEditedAvatar(session, { avatarId, onStep = () => {} } = {}) {
	// 1. Export
	onStep({ step: 'export', pct: 0 });
	let bytes;
	try {
		bytes = await exportEditedGLB(session);
	} catch (e) {
		throw new SaveError('server', 'GLB export failed: ' + (e?.message || e));
	}
	if (!bytes?.byteLength) throw new SaveError('server', 'Empty GLB buffer');
	if (bytes.byteLength > MAX_BYTES)
		throw new SaveError('oversize', `GLB too large (${bytes.byteLength} bytes)`);
	onStep({ step: 'export', pct: 1 });

	// 2. Presign
	onStep({ step: 'presign', pct: 0 });
	let presign;
	try {
		const res = await fetch('/api/avatars/presign', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				size_bytes: bytes.byteLength,
				content_type: 'model/gltf-binary',
			}),
		});
		if (res.status === 401) throw new SaveError('auth', 'Not signed in');
		if (!res.ok) {
			const b = await res.json().catch(() => ({}));
			throw new SaveError('server', b?.error_description || `Presign failed (${res.status})`);
		}
		presign = await res.json();
	} catch (e) {
		if (e instanceof SaveError) throw e;
		throw new SaveError('network', e?.message || 'Network error during presign');
	}
	onStep({ step: 'presign', pct: 1 });

	// 3. Upload
	await new Promise((resolve, reject) => {
		onStep({ step: 'upload', pct: 0 });
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', presign.upload_url, true);
		for (const [k, v] of Object.entries(presign.headers || {})) xhr.setRequestHeader(k, v);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable)
				onStep({ step: 'upload', pct: Math.max(0, Math.min(1, e.loaded / e.total)) });
		};
		xhr.onerror = () => reject(new SaveError('network', 'Upload network error'));
		xhr.onabort = () => reject(new SaveError('network', 'Upload aborted'));
		xhr.onload = () => {
			if (xhr.status === 401) return reject(new SaveError('auth', 'Not signed in'));
			if (xhr.status >= 200 && xhr.status < 300) {
				onStep({ step: 'upload', pct: 1 });
				return resolve();
			}
			reject(new SaveError('server', `Upload failed (${xhr.status})`));
		};
		xhr.send(bytes);
	});

	// 4. PATCH avatar — derive non-signed URL by stripping presign query params
	onStep({ step: 'patch', pct: 0 });
	const parsed = new URL(presign.upload_url);
	const glbUrl = parsed.origin + parsed.pathname;
	let patchRes;
	try {
		// allowAnonymous: a 401 here must surface as SaveError('auth'), not a
		// redirect, so the editor can show its own sign-in prompt.
		const res = await apiFetch(`/api/avatars/${avatarId}`, {
			method: 'PATCH',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ glbUrl, storage_key: presign.storage_key }),
			allowAnonymous: true,
		});
		if (res.status === 401) throw new SaveError('auth', 'Not signed in');
		if (!res.ok) {
			const b = await res.json().catch(() => ({}));
			throw new SaveError('server', b?.error_description || `Patch failed (${res.status})`);
		}
		patchRes = await res.json();
	} catch (e) {
		if (e instanceof SaveError) throw e;
		throw new SaveError('network', e?.message || 'Network error during patch');
	}
	onStep({ step: 'patch', pct: 1 });

	return { ok: true, avatar: patchRes.avatar ?? patchRes };
}
