// three.ws Avatar Creator — the in-app modal that opens either the
//   • three.ws Studio iframe (in-browser builder), or
//   • three.ws Selfie SDK (photo-to-avatar editor),
// and resolves the user's chosen avatar as a GLB Blob.
//
// Provider names ("characterstudio", "avaturn") only appear in internal
// postMessage payloads and import paths — every user-visible surface reads
// "three.ws". Ready Player Me was retired upstream after the 2026
// acquisition; this module no longer references it.

import { AvaturnSDK } from '@avaturn/sdk';
import { log } from './shared/log.js';

function getStudioUrl() {
	// Explicit override wins in any environment (e.g. a standalone studio dev
	// server on :5173 during character-studio development).
	try {
		if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CHARACTER_STUDIO_URL) {
			return String(import.meta.env.VITE_CHARACTER_STUDIO_URL)
				.trim()
				.replace(/\/$/, '');
		}
	} catch (_) {}
	// Default: the trait builder is served SAME-ORIGIN from the static
	// character-studio build (Vite dev middleware in dev, the
	// copy-avatar-studio step into dist/avatar-studio in prod, see
	// vite.config.js). Point at its index file explicitly: the bare
	// /avatar-studio path is routed to the native sculpting page, which has no
	// postMessage export contract. Resolving to the live origin keeps this
	// correct on every deployment and avoids a dead localhost fallback in
	// production. The value must stay absolute: it's used as an iframe src and
	// parsed with `new URL(studioUrl).origin` for postMessage validation.
	if (typeof location !== 'undefined' && location.origin) {
		return `${location.origin}/avatar-studio/index.html`;
	}
	return 'https://three.ws/avatar-studio/index.html';
}

export class AvatarCreator {
	/**
	 * @param {Element} containerEl - Parent element to mount the modal into
	 * @param {function(Blob, {provider:string, sourceUrl?:string|null}): void} onExport - Called with the exported GLB Blob and provenance
	 * @param {object} [opts]
	 * @param {string} [opts.studioUrl] - Override the three.ws Studio URL
	 */
	constructor(containerEl, onExport, opts = {}) {
		this.container = containerEl;
		this.onExport = onExport;
		this.studioUrl = opts.studioUrl || getStudioUrl();

		this.modal = null;
		this.iframe = null;
		this.sdk = null;
		this._onMessage = null;
		this._onKeyDown = null;
		this._provider = null;
	}

	/**
	 * Opens the three.ws Avatar Creator modal.
	 * @param {string} [sessionUrl] - When provided, opens the three.ws Selfie editor in edit mode.
	 *                                When omitted, opens three.ws Studio.
	 */
	async open(sessionUrl) {
		if (this.modal) return;
		if (sessionUrl) {
			this._provider = 'three-ws-selfie';
			await this._openSelfie(sessionUrl);
		} else {
			this._provider = 'three-ws-studio';
			this._buildModal(true);
			this._onMessage = (e) => this._handleStudioMessage(e);
			window.addEventListener('message', this._onMessage);
			this.iframe.src = this.studioUrl;
		}
	}

	/**
	 * Opens the default three.ws Selfie editor (no session URL required).
	 */
	async openDefaultEditor() {
		if (this.modal) return;
		this._provider = 'three-ws-selfie';
		await this._openSelfie();
	}

	async _openSelfie(url) {
		this._buildModal(false);
		try {
			this.sdk = new AvaturnSDK();
			await this.sdk.init(this.modal.querySelector('.avatar-creator-container'), {
				iframeClassName: 'avatar-creator-iframe',
				url,
			});

			const loading = this.modal?.querySelector('.avatar-creator-loading');
			if (loading) loading.style.display = 'none';

			this.sdk.on('export', async (data) => {
				const glbUrl = data?.url;
				if (!glbUrl) return;
				try {
					let blob;
					if (data.urlType === 'dataURL') {
						const res = await fetch(glbUrl);
						blob = await res.blob();
					} else {
						const res = await fetch(glbUrl);
						if (!res.ok) throw new Error(`GLB fetch failed: ${res.status}`);
						blob = await res.blob();
					}
					const glbBlob = blob.type
						? blob
						: new Blob([await blob.arrayBuffer()], { type: 'model/gltf-binary' });
					this._fireExport(glbBlob, { sourceUrl: data.urlType === 'dataURL' ? null : glbUrl });
				} catch (err) {
					log.error('[three.ws Avatar Creator] failed to fetch selfie GLB:', err);
				}
			});
		} catch (err) {
			log.error('[three.ws Avatar Creator] Failed to initialize selfie SDK:', err);
			this._showError('Failed to load the avatar creator. Please try again.');
		}
	}

	_handleStudioMessage(event) {
		try {
			const csOrigin = new URL(this.studioUrl).origin;
			if (event.origin !== csOrigin) return;
		} catch (_) {
			return;
		}

		const msg = event.data;
		// Studio iframe uses the `characterstudio` postMessage source for backwards
		// compatibility with the upstream open-source builder we forked.
		if (!msg || msg.source !== 'characterstudio' || msg.type !== 'export') return;
		if (!(msg.glb instanceof ArrayBuffer)) return;

		const blob = new Blob([msg.glb], { type: 'model/gltf-binary' });
		this._fireExport(blob);
	}

	_fireExport(blob, meta = {}) {
		if (this.onExport) {
			try {
				this.onExport(blob, { provider: this._provider, ...meta });
			} catch (err) {
				log.error('[three.ws Avatar Creator] onExport handler threw:', err);
			}
		}
		this.close();
	}

	_showError(message) {
		const loading = this.modal?.querySelector('.avatar-creator-loading');
		if (loading) {
			loading.innerHTML = `<span class="avatar-creator-error">${message}</span>`;
		}
	}

	/**
	 * @param {boolean} withIframe - true for three.ws Studio (pre-rendered iframe),
	 *                               false for three.ws Selfie SDK (SDK injects its own iframe).
	 */
	_buildModal(withIframe) {
		const title = withIframe ? 'three.ws · Create your avatar' : 'three.ws · Edit your avatar';
		this.modal = document.createElement('div');
		this.modal.className = 'avatar-creator-overlay';

		this.modal.innerHTML = `
			<div class="avatar-creator-modal">
				<div class="avatar-creator-header">
					<span class="avatar-creator-title">${title}</span>
					<button class="avatar-creator-close" aria-label="Close">&times;</button>
				</div>
				<div class="avatar-creator-body">
					<div class="avatar-creator-container">${
						withIframe
							? `<iframe
						class="avatar-creator-iframe"
						title="three.ws · Avatar Creator"
						allow="camera *; microphone *; clipboard-write"
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
					></iframe>`
							: ''
					}</div>
					<div class="avatar-creator-loading">
						<div class="spinner"></div>
						<span>Loading three.ws Avatar Creator…</span>
					</div>
				</div>
			</div>
		`;

		this.container.appendChild(this.modal);

		if (withIframe) {
			this.iframe = this.modal.querySelector('.avatar-creator-iframe');
			this.iframe.addEventListener('load', () => {
				const loading = this.modal?.querySelector('.avatar-creator-loading');
				if (loading) loading.style.display = 'none';
			});
		}

		this.modal
			.querySelector('.avatar-creator-close')
			.addEventListener('click', () => this.close());
		this.modal.addEventListener('click', (e) => {
			if (e.target === this.modal) this.close();
		});

		this._onKeyDown = (e) => {
			if (e.key === 'Escape') this.close();
		};
		document.addEventListener('keydown', this._onKeyDown);
	}

	close() {
		if (this.sdk) {
			try {
				this.sdk.destroy();
			} catch (_) {}
			this.sdk = null;
		}
		if (this._onMessage) {
			window.removeEventListener('message', this._onMessage);
			this._onMessage = null;
		}
		if (this._onKeyDown) {
			document.removeEventListener('keydown', this._onKeyDown);
			this._onKeyDown = null;
		}
		if (this.modal) {
			this.modal.remove();
			this.modal = null;
			this.iframe = null;
		}
	}

	dispose() {
		this.close();
	}
}
