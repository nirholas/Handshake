/**
 * publishEditedGLB(session, opts)
 * -------------------------------
 * Turn an in-progress EditorSession into a live shareable widget:
 *   1. exportEditedGLB(session)          → Uint8Array
 *   2. POST /api/avatars/presign         → { storage_key, upload_url, headers }
 *   3. PUT  upload_url with the bytes    → R2
 *   4. POST /api/avatars                 → { avatar }
 *   5. POST /api/widgets                 → { widget }
 *
 * Transport-only: no UI, no auth redirects. On 401 any step throws
 * AuthRequiredError so the caller (task 04) can redirect to sign-in.
 */

import { exportEditedGLB } from './glb-export.js';

export const MAX_BYTES = 25 * 1024 * 1024;

// Mirrors public/studio/studio.js TYPE_DEFAULTS.turntable + BRAND_DEFAULTS.
// Kept local because public/studio/* is served verbatim (not bundled).
const TURNTABLE_DEFAULTS = Object.freeze({
	rotationSpeed: 0.5,
	autoRotate: true,
	showControls: true,
	background: '#0a0a0a',
	accent: '#ffffff',
});

export class AuthRequiredError extends Error {
	constructor() {
		super('auth required');
		this.name = 'AuthRequiredError';
	}
}

export class SizeTooLargeError extends Error {
	constructor(bytes, limit) {
		super(`${bytes} > ${limit}`);
		this.name = 'SizeTooLargeError';
		this.bytes = bytes;
		this.limit = limit;
	}
}

export class ExportFailedError extends Error {
	constructor(cause) {
		super(`export failed: ${cause?.message || cause}`);
		this.name = 'ExportFailedError';
		this.cause = cause;
	}
}

export class PublishError extends Error {
	constructor(step, status, body) {
		super(`${step} failed: ${status} ${body?.error_description || ''}`.trim());
		this.name = 'PublishError';
		this.step = step;
		this.status = status;
		this.body = body;
	}
}

export async function publishEditedGLB(
	session,
	{
		origin = location.origin,
		widgetType = 'turntable',
		widgetName,
		isPublic = true,
		config = {},
		onStep = () => {},
	} = {},
) {
	const displayName = widgetName || toDisplayName(session?.sourceName);

	// 1. Export
	onStep({ step: 'export', pct: 0 });
	let bytes;
	try {
		bytes = await exportEditedGLB(session);
	} catch (e) {
		throw new ExportFailedError(e);
	}
	if (!bytes || !bytes.byteLength) throw new ExportFailedError(new Error('empty buffer'));
	if (bytes.byteLength > MAX_BYTES) throw new SizeTooLargeError(bytes.byteLength, MAX_BYTES);
	onStep({ step: 'export', pct: 1 });

	// 2. Presign
	const presign = await postJson(
		`${origin}/api/avatars/presign`,
		{
			size_bytes: bytes.byteLength,
			content_type: 'model/gltf-binary',
		},
		'presign',
	);
	onStep({ step: 'presign', pct: 1 });

	// 3. PUT upload (no credentials — presigned URL carries its own auth).
	await putWithProgress(presign.upload_url, bytes, presign.headers || {}, (pct) =>
		onStep({ step: 'upload', pct }),
	);

	// 4. Register avatar
	const avatarRes = await postJson(
		`${origin}/api/avatars`,
		{
			name: displayName,
			slug: toSlug(session?.sourceName),
			storage_key: presign.storage_key,
			content_type: 'model/gltf-binary',
			size_bytes: bytes.byteLength,
			visibility: isPublic ? 'public' : 'unlisted',
			source: 'upload',
			source_meta: { origin: 'editor-publish' },
		},
		'register',
		(status, body) => {
			if (status === 413) throw new SizeTooLargeError(bytes.byteLength, MAX_BYTES);
		},
	);
	const avatar = avatarRes.avatar;
	onStep({ step: 'register', pct: 1 });

	// 5. Create widget
	const widgetConfig = { ...TURNTABLE_DEFAULTS, ...config };
	const widgetRes = await postJson(
		`${origin}/api/widgets`,
		{
			type: widgetType,
			name: displayName,
			avatar_id: avatar.id,
			config: widgetConfig,
			is_public: isPublic,
		},
		'widget',
	);
	const widget = widgetRes.widget;
	onStep({ step: 'widget', pct: 1 });

	const page = `${origin}/w/${widget.id}`;
	const iframe = `<iframe src="${page}" width="600" height="600" style="border:0"></iframe>`;
	const element =
		`<script type="module" src="${origin}/dist-lib/agent-3d.js"></script>\n` +
		`<agent-3d src="${origin}/api/avatars/${avatar.id}" style="width:600px;height:600px"></agent-3d>`;

	return { widget, avatar, urls: { page, iframe, element } };
}

async function postJson(url, body, step, onStatus) {
	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	} catch (e) {
		throw new PublishError(step, 0, { error_description: e?.message || String(e) });
	}
	if (res.status === 401) throw new AuthRequiredError();
	const parsed = await safeJson(res);
	if (onStatus) onStatus(res.status, parsed);
	if (!res.ok) throw new PublishError(step, res.status, parsed);
	return parsed;
}

function putWithProgress(url, bytes, headers, onProgress) {
	return new Promise((resolve, reject) => {
		onProgress(0);
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url, true);
		for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) onProgress(Math.max(0, Math.min(1, e.loaded / e.total)));
		};
		xhr.onerror = () =>
			reject(new PublishError('upload', 0, { error_description: 'network error' }));
		xhr.onabort = () => reject(new PublishError('upload', 0, { error_description: 'aborted' }));
		xhr.onload = () => {
			if (xhr.status === 401) return reject(new AuthRequiredError());
			if (xhr.status >= 200 && xhr.status < 300) {
				onProgress(1);
				return resolve();
			}
			reject(
				new PublishError('upload', xhr.status, {
					error_description: xhr.responseText || '',
				}),
			);
		};
		xhr.send(bytes);
	});
}

async function safeJson(res) {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function toDisplayName(raw) {
	const s = String(raw || 'Model')
		.replace(/\.(glb|gltf)$/i, '')
		.trim();
	return (s || 'Model').slice(0, 120);
}

function toSlug(raw) {
	let base = String(raw || 'model')
		.replace(/\.(glb|gltf)$/i, '')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-_]+|[-_]+$/g, '');
	if (!base || !/^[a-z0-9]/.test(base)) base = `model${base ? '-' + base : ''}`;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${base}-${suffix}`.slice(0, 64).replace(/[-_]+$/, '');
}
