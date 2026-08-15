// Programmatic Avatar Creator — opens an iframe modal where the user builds
// or photographs an avatar in the three.ws Avatar Studio, listens for the
// `export` postMessage, and resolves with the GLB Blob.
//
// This is the thin client-only wrapper. Apps that already have their own
// session/auth flow are expected to:
//   1) call AvatarCreator.open()
//   2) await onExport(blob)
//   3) PUT the blob to whatever storage they like.
//
// For the hosted three.ws backend (R2 + presigned uploads + auto-tag), use
// the `saveBlob()` helper instead, which posts to three.ws's /api/avatars
// pipeline using a bearer token.

const DEFAULT_STUDIO_URL = 'https://three.ws/avatar-studio/';
const DEFAULT_THREE_WS_ORIGIN = 'https://three.ws';

export class AvatarCreator {
	/**
	 * @param {object} opts
	 * @param {HTMLElement} [opts.container] — DOM node to mount the modal into. Defaults to document.body.
	 * @param {string} [opts.studioUrl] — URL of the Avatar Studio iframe. Defaults to https://three.ws/avatar-studio/.
	 * @param {string} [opts.avaturnSessionUrl] — if provided, opens Avaturn in edit mode for that session.
	 * @param {(blob: Blob) => any} [opts.onExport] — called with the GLB Blob when the user exports.
	 * @param {() => any} [opts.onClose] — called when the user closes without exporting.
	 */
	constructor(opts = {}) {
		this.container = opts.container || (typeof document !== 'undefined' ? document.body : null);
		this.studioUrl = (opts.studioUrl || DEFAULT_STUDIO_URL).replace(/\/$/, '');
		this.avaturnSessionUrl = opts.avaturnSessionUrl || null;
		this.onExport = opts.onExport || null;
		this.onClose = opts.onClose || null;

		this._modal = null;
		this._iframe = null;
		this._onMessage = null;
		this._onKeyDown = null;
	}

	async open() {
		if (this._modal) return;
		this._buildModal();
		this._onMessage = (e) => this._handleMessage(e);
		window.addEventListener('message', this._onMessage);
		this._iframe.src = this.avaturnSessionUrl || this.studioUrl;
	}

	close() {
		if (this._onMessage) {
			window.removeEventListener('message', this._onMessage);
			this._onMessage = null;
		}
		if (this._onKeyDown) {
			document.removeEventListener('keydown', this._onKeyDown);
			this._onKeyDown = null;
		}
		if (this._modal) {
			this._modal.remove();
			this._modal = null;
			this._iframe = null;
			this.onClose?.();
		}
	}

	dispose() {
		this.close();
	}

	_buildModal() {
		this._modal = document.createElement('div');
		this._modal.style.cssText = [
			'position:fixed', 'inset:0', 'z-index:2147483646',
			'background:rgba(0,0,0,0.78)', 'display:flex',
			'align-items:center', 'justify-content:center',
		].join(';');

		const card = document.createElement('div');
		card.style.cssText = [
			'background:#111', 'border-radius:12px',
			'width:min(960px,96vw)', 'height:min(720px,92vh)',
			'position:relative', 'overflow:hidden',
		].join(';');

		this._iframe = document.createElement('iframe');
		this._iframe.title = 'Avatar Creator';
		this._iframe.allow = 'camera *; microphone *; clipboard-write';
		this._iframe.style.cssText = 'width:100%;height:100%;border:0;display:block';
		card.appendChild(this._iframe);

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.setAttribute('aria-label', 'Close');
		closeBtn.textContent = '×';
		closeBtn.style.cssText = [
			'position:absolute', 'top:8px', 'right:10px', 'z-index:1',
			'background:rgba(0,0,0,0.4)', 'color:#fff', 'border:0',
			'width:32px', 'height:32px', 'border-radius:50%',
			'font-size:20px', 'line-height:30px', 'cursor:pointer',
		].join(';');
		closeBtn.addEventListener('click', () => this.close());
		card.appendChild(closeBtn);

		this._modal.appendChild(card);
		this._modal.addEventListener('click', (e) => {
			if (e.target === this._modal) this.close();
		});

		this._onKeyDown = (e) => {
			if (e.key === 'Escape') this.close();
		};
		document.addEventListener('keydown', this._onKeyDown);

		this.container.appendChild(this._modal);
	}

	_handleMessage(event) {
		// Character Studio:  { source:'characterstudio', type:'export', glb: ArrayBuffer }
		// Avaturn:           { source:'avaturn', eventName:'export', data:{ url, urlType } }
		const msg = event.data;
		if (!msg || typeof msg !== 'object') return;

		// Trust check — message must come from the iframe we opened.
		try {
			const expected = new URL(this._iframe.src).origin;
			if (event.origin !== expected) return;
		} catch {
			return;
		}

		if (msg.source === 'characterstudio' && msg.type === 'export' && msg.glb instanceof ArrayBuffer) {
			this._fire(new Blob([msg.glb], { type: 'model/gltf-binary' }));
			return;
		}
		if (msg.source === 'avaturn' && msg.eventName === 'export' && msg.data?.url) {
			this._fetchAndFire(msg.data.url);
		}
	}

	async _fetchAndFire(url) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`avatar fetch failed: ${res.status}`);
			const blob = await res.blob();
			const typed = blob.type
				? blob
				: new Blob([await blob.arrayBuffer()], { type: 'model/gltf-binary' });
			this._fire(typed);
		} catch (err) {
			console.error('[@three-ws/avatar] avaturn export fetch failed:', err);
		}
	}

	_fire(blob) {
		try {
			this.onExport?.(blob);
		} catch (err) {
			console.error('[@three-ws/avatar] onExport threw:', err);
		}
		this.close();
	}
}

/**
 * Upload a freshly created GLB to a three.ws-compatible backend.
 *
 * @param {Blob} blob — GLB blob returned by AvatarCreator.
 * @param {object} opts
 * @param {string} opts.bearerToken — OAuth/API token with `avatars:write` scope.
 * @param {string} [opts.apiOrigin] — defaults to https://three.ws.
 * @param {string} [opts.name] — avatar display name.
 * @param {string} [opts.description] — optional description.
 * @param {string[]} [opts.tags] — optional tag list.
 * @param {'public'|'unlisted'|'private'} [opts.visibility] — defaults to 'public'.
 * @returns {Promise<{ id: string, url: string, slug: string }>}
 */
export async function saveBlob(blob, opts) {
	if (!opts?.bearerToken) throw new Error('saveBlob: bearerToken is required');
	const origin = (opts.apiOrigin || DEFAULT_THREE_WS_ORIGIN).replace(/\/$/, '');
	const headers = {
		authorization: `Bearer ${opts.bearerToken}`,
		'content-type': 'application/json',
	};

	const size = blob.size;
	const contentType = blob.type || 'model/gltf-binary';
	const checksum = await _sha256Hex(blob);

	const presignRes = await fetch(`${origin}/api/avatars/presign`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			size_bytes: size,
			content_type: contentType,
			checksum_sha256: checksum,
		}),
	});
	if (!presignRes.ok) throw new Error(`presign failed: ${presignRes.status}`);
	const presign = await presignRes.json();

	const put = await fetch(presign.upload_url, {
		method: 'PUT',
		headers: { 'content-type': contentType },
		body: blob,
	});
	if (!put.ok) throw new Error(`R2 upload failed: ${put.status}`);

	const createRes = await fetch(`${origin}/api/avatars`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			storage_key: presign.storage_key,
			size_bytes: size,
			content_type: contentType,
			checksum_sha256: checksum,
			name: opts.name || `Avatar ${checksum.slice(0, 6)}`,
			description: opts.description,
			visibility: opts.visibility || 'public',
			tags: opts.tags || [],
			source: opts.source || 'sdk',
			source_meta: { via: '@three-ws/avatar' },
		}),
	});
	if (!createRes.ok) throw new Error(`avatar create failed: ${createRes.status}`);
	const { avatar } = await createRes.json();

	return {
		id: avatar.id,
		url: avatar.url || avatar.model_url,
		slug: avatar.slug,
	};
}

async function _sha256Hex(blob) {
	const buf = await blob.arrayBuffer();
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
