/**
 * Selfie Modal — reusable full-screen selfie capture component.
 *
 * Drop this into any page to let users create or update an avatar from a
 * selfie. Uses the face-quality engine for real-time 468-point wireframe,
 * head-pose estimation, blur/lighting/centering quality gates.
 *
 * Usage:
 *   import { openSelfieModal } from '/src/selfie-modal.js';
 *   const result = await openSelfieModal();
 *   if (result) console.log('Avatar ID:', result.avatarId);
 *
 * Options:
 *   existingAvatarId — if set, updates this avatar instead of creating new
 *   bodyType — 'male' | 'female' (default 'male')
 *   avatarType — 'v1' | 'v2' (default 'v1')
 *   slot — 'frontal' | 'left' | 'right' (default 'frontal')
 */

import { createQualitySession, preload, SLOT_PRESETS } from './face-quality.js';

const RECONSTRUCT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const MAX_DIM = 1024;
const JPEG_QUALITY = 0.88;

let _activeModal = null;

/**
 * Open a selfie capture modal.
 * @param {{
 *   existingAvatarId?: string,
 *   bodyType?: 'male' | 'female',
 *   avatarType?: 'v1' | 'v2',
 *   multiAngle?: boolean,
 * }} [opts]
 * @returns {Promise<{ avatarId: string } | null>}
 */
export async function openSelfieModal(opts = {}) {
	if (_activeModal) return null;
	preload();

	return new Promise((resolve) => {
		const modal = new SelfieModal({
			...opts,
			onDone: (result) => {
				modal.destroy();
				_activeModal = null;
				resolve(result);
			},
			onCancel: () => {
				modal.destroy();
				_activeModal = null;
				resolve(null);
			},
		});
		_activeModal = modal;
		modal.mount();
	});
}

class SelfieModal {
	constructor(opts) {
		this.opts = opts;
		this.bodyType = opts.bodyType || 'male';
		this.avatarType = opts.avatarType || 'v1';
		this.multiAngle = opts.multiAngle !== false;
		this.existingAvatarId = opts.existingAvatarId || null;
		this.photos = { frontal: null, left: null, right: null };
		this.currentSlot = 'frontal';
		this.phase = 'capture';
		this.stream = null;
		this.session = null;
		this.root = null;
	}

	mount() {
		this.root = document.createElement('div');
		this.root.className = 'sfm-root';
		this.root.innerHTML = this._html();
		document.body.appendChild(this.root);
		this._injectStyles();
		requestAnimationFrame(() => this.root.classList.add('sfm-open'));
		this._wire();
		this._startCamera();
	}

	destroy() {
		this._stopCamera();
		if (this.root) {
			this.root.classList.remove('sfm-open');
			setTimeout(() => this.root?.remove(), 200);
		}
	}

	_html() {
		return `
			<div class="sfm-backdrop"></div>
			<div class="sfm-panel">
				<div class="sfm-header">
					<button type="button" class="sfm-close" data-sfm-close aria-label="Close">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
					<div class="sfm-title" data-sfm-title>Take a selfie</div>
					<div class="sfm-slot-label" data-sfm-slot-label>Front-facing</div>
				</div>
				<div class="sfm-stage" data-sfm-stage>
					<video class="sfm-video" data-sfm-video autoplay playsinline muted></video>
					<canvas class="sfm-canvas" data-sfm-canvas></canvas>
					<img class="sfm-preview-img" data-sfm-preview hidden />
					<div class="sfm-badges" data-sfm-badges></div>
					<div class="sfm-hint" data-sfm-hint>Loading face mesh...</div>
				</div>
				<div class="sfm-captures" data-sfm-captures>
					<div class="sfm-thumb sfm-thumb-active" data-sfm-thumb="frontal">
						<span class="sfm-thumb-label">Front</span>
					</div>
					${this.multiAngle ? `
					<div class="sfm-thumb" data-sfm-thumb="left">
						<span class="sfm-thumb-label">Left</span>
					</div>
					<div class="sfm-thumb" data-sfm-thumb="right">
						<span class="sfm-thumb-label">Right</span>
					</div>
					` : ''}
				</div>
				<div class="sfm-bar" data-sfm-bar>
					<div class="sfm-bar-live" data-sfm-bar-live>
						<button type="button" class="sfm-btn sfm-btn-ghost" data-sfm-cancel>Cancel</button>
						<button type="button" class="sfm-shutter" data-sfm-shutter disabled aria-label="Capture">
							<span class="sfm-shutter-ring"></span>
						</button>
						<button type="button" class="sfm-btn sfm-btn-ghost" data-sfm-upload-alt>Upload</button>
					</div>
					<div class="sfm-bar-review" data-sfm-bar-review hidden>
						<button type="button" class="sfm-btn sfm-btn-ghost" data-sfm-retake>Retake</button>
						<button type="button" class="sfm-btn sfm-btn-primary" data-sfm-accept>Use this</button>
					</div>
					<div class="sfm-bar-submit" data-sfm-bar-submit hidden>
						<div class="sfm-opts">
							<div class="sfm-opt-group">
								<span class="sfm-opt-label">Body</span>
								<div class="sfm-toggle" data-sfm-body-toggle>
									<button type="button" class="sfm-toggle-btn ${this.bodyType === 'male' ? 'active' : ''}" data-sfm-body="male">Masc</button>
									<button type="button" class="sfm-toggle-btn ${this.bodyType === 'female' ? 'active' : ''}" data-sfm-body="female">Femme</button>
								</div>
							</div>
							<div class="sfm-opt-group">
								<span class="sfm-opt-label">Style</span>
								<div class="sfm-toggle" data-sfm-style-toggle>
									<button type="button" class="sfm-toggle-btn ${this.avatarType === 'v1' ? 'active' : ''}" data-sfm-style="v1">Photoreal</button>
									<button type="button" class="sfm-toggle-btn ${this.avatarType === 'v2' ? 'active' : ''}" data-sfm-style="v2">Stylized</button>
								</div>
							</div>
						</div>
						<button type="button" class="sfm-btn sfm-btn-primary sfm-btn-full" data-sfm-submit>
							Build my avatar
						</button>
					</div>
					<div class="sfm-bar-building" data-sfm-bar-building hidden>
						<div class="sfm-build-spinner"></div>
						<div class="sfm-build-label" data-sfm-build-label>Submitting...</div>
					</div>
				</div>
				<input type="file" data-sfm-file-input accept="image/jpeg,image/png,image/webp" hidden />
			</div>
		`;
	}

	_wire() {
		const $ = (sel) => this.root.querySelector(sel);
		const $$ = (sel) => this.root.querySelectorAll(sel);

		$('[data-sfm-close]').addEventListener('click', () => this.opts.onCancel());
		$('.sfm-backdrop').addEventListener('click', () => this.opts.onCancel());
		$('[data-sfm-cancel]').addEventListener('click', () => this.opts.onCancel());

		$('[data-sfm-shutter]').addEventListener('click', () => this._capture());
		$('[data-sfm-retake]').addEventListener('click', () => this._retake());
		$('[data-sfm-accept]').addEventListener('click', () => this._acceptPhoto());
		$('[data-sfm-submit]').addEventListener('click', () => this._submit());

		$('[data-sfm-upload-alt]').addEventListener('click', () => {
			$('[data-sfm-file-input]').click();
		});
		$('[data-sfm-file-input]').addEventListener('change', (e) => {
			const file = e.target.files?.[0];
			if (file) this._handleUpload(file);
			e.target.value = '';
		});

		$$('[data-sfm-thumb]').forEach((thumb) => {
			thumb.addEventListener('click', () => {
				const slot = thumb.dataset.sfmThumb;
				if (this.phase === 'submit') {
					this._switchToSlot(slot);
				}
			});
		});

		$$('[data-sfm-body]').forEach((btn) => {
			btn.addEventListener('click', () => {
				this.bodyType = btn.dataset.sfmBody;
				$$('[data-sfm-body]').forEach((b) => b.classList.toggle('active', b === btn));
			});
		});
		$$('[data-sfm-style]').forEach((btn) => {
			btn.addEventListener('click', () => {
				this.avatarType = btn.dataset.sfmStyle;
				$$('[data-sfm-style]').forEach((b) => b.classList.toggle('active', b === btn));
			});
		});

		document.addEventListener('keydown', this._onKey = (e) => {
			if (e.key === 'Escape') this.opts.onCancel();
		});
	}

	async _startCamera() {
		const video = this.root.querySelector('[data-sfm-video]');
		const canvas = this.root.querySelector('[data-sfm-canvas]');
		const hint = this.root.querySelector('[data-sfm-hint]');

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1706 } },
				audio: false,
			});
			video.srcObject = this.stream;
			await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));
			await video.play();
		} catch (err) {
			hint.textContent = 'Camera unavailable. Use Upload instead.';
			hint.classList.add('sfm-hint-err');
			return;
		}

		try {
			this.session = await createQualitySession(video, canvas, {
				slot: this.currentSlot,
				onUpdate: (report) => this._onQualityUpdate(report),
			});
			this.session.start();
			hint.textContent = 'Center your face';
		} catch (err) {
			hint.textContent = 'Face mesh loading...';
			const shutter = this.root.querySelector('[data-sfm-shutter]');
			if (shutter) shutter.disabled = false;
		}
	}

	_stopCamera() {
		if (this.session) {
			this.session.stop();
			this.session = null;
		}
		if (this.stream) {
			this.stream.getTracks().forEach((t) => t.stop());
			this.stream = null;
		}
		if (this._onKey) {
			document.removeEventListener('keydown', this._onKey);
			this._onKey = null;
		}
	}

	_onQualityUpdate(report) {
		const badges = this.root.querySelector('[data-sfm-badges]');
		const hint = this.root.querySelector('[data-sfm-hint]');
		const shutter = this.root.querySelector('[data-sfm-shutter]');
		if (!badges || !hint || !shutter) return;

		const slotCfg = SLOT_PRESETS[this.currentSlot] || SLOT_PRESETS.frontal;
		const chips = [];

		if (!report.faceFound) {
			chips.push({ text: 'No face', ok: false });
			badges.innerHTML = chips.map((c) => `<span class="sfm-chip ${c.ok ? 'sfm-chip-ok' : 'sfm-chip-bad'}">${c.text}</span>`).join('');
			hint.textContent = 'Face the camera';
			hint.className = 'sfm-hint';
			shutter.disabled = true;
			return;
		}

		chips.push({ text: 'Face', ok: true });
		chips.push({ text: `Yaw ${Math.round(report.yaw)}°`, ok: report.yawOk });
		chips.push({ text: report.centered ? 'Centered' : 'Recenter', ok: report.centered });
		chips.push({ text: report.blurOk ? 'Sharp' : 'Blurry', ok: report.blurOk });

		const lumaLabel = report.luma < 40 ? 'Too dark' : report.luma > 218 ? 'Bright' : 'Lit';
		chips.push({ text: lumaLabel, ok: report.lumaOk });

		badges.innerHTML = chips.map((c) =>
			`<span class="sfm-chip ${c.ok ? 'sfm-chip-ok' : 'sfm-chip-bad'}">${c.text}</span>`
		).join('');

		shutter.disabled = !report.allPass;

		if (report.allPass) {
			hint.textContent = 'Looking good — tap to capture';
			hint.className = 'sfm-hint sfm-hint-ok';
		} else if (!report.yawOk) {
			const target = slotCfg.label;
			hint.textContent = this.currentSlot === 'frontal'
				? 'Face the camera straight on'
				: `Turn your head ${this.currentSlot} (~45°)`;
			hint.className = 'sfm-hint';
		} else if (!report.centered) {
			hint.textContent = 'Center your face';
			hint.className = 'sfm-hint';
		} else if (!report.blurOk) {
			hint.textContent = 'Hold steady — image is blurry';
			hint.className = 'sfm-hint';
		} else {
			hint.textContent = 'Adjust lighting';
			hint.className = 'sfm-hint';
		}
	}

	async _capture() {
		const video = this.root.querySelector('[data-sfm-video]');
		if (!video) return;
		const w = video.videoWidth;
		const h = video.videoHeight;
		if (!w || !h) return;

		if (this.session) this.session.stop();

		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		const ctx = c.getContext('2d');
		ctx.drawImage(video, 0, 0, w, h);

		const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
		if (!blob) return;

		this._pendingBlob = blob;
		this._showReview(blob);
	}

	_showReview(blob) {
		const preview = this.root.querySelector('[data-sfm-preview]');
		const video = this.root.querySelector('[data-sfm-video]');
		const canvas = this.root.querySelector('[data-sfm-canvas]');
		const badges = this.root.querySelector('[data-sfm-badges]');
		const hint = this.root.querySelector('[data-sfm-hint]');

		const url = URL.createObjectURL(blob);
		preview.src = url;
		preview.onload = () => URL.revokeObjectURL(url);
		preview.hidden = false;
		video.style.display = 'none';
		canvas.style.display = 'none';
		badges.innerHTML = '<span class="sfm-chip sfm-chip-ok">Captured</span>';
		hint.textContent = '';

		this._setBarMode('review');
	}

	_retake() {
		this._pendingBlob = null;
		const preview = this.root.querySelector('[data-sfm-preview]');
		const video = this.root.querySelector('[data-sfm-video]');
		const canvas = this.root.querySelector('[data-sfm-canvas]');

		preview.hidden = true;
		video.style.display = '';
		canvas.style.display = '';

		if (this.session) this.session.start();
		this._setBarMode('live');
	}

	_acceptPhoto() {
		if (!this._pendingBlob) return;
		this.photos[this.currentSlot] = this._pendingBlob;
		this._pendingBlob = null;
		this._updateThumbs();

		if (this.multiAngle && !this.photos.left && this.currentSlot === 'frontal') {
			this._switchToSlot('left');
			return;
		}
		if (this.multiAngle && !this.photos.right && this.currentSlot === 'left') {
			this._switchToSlot('right');
			return;
		}

		this._showSubmitPhase();
	}

	_switchToSlot(slot) {
		this.currentSlot = slot;
		if (this.session) this.session.setSlot(slot);

		const slotLabel = this.root.querySelector('[data-sfm-slot-label]');
		const slotCfg = SLOT_PRESETS[slot] || SLOT_PRESETS.frontal;
		if (slotLabel) slotLabel.textContent = slotCfg.label;

		this.root.querySelectorAll('[data-sfm-thumb]').forEach((t) => {
			t.classList.toggle('sfm-thumb-active', t.dataset.sfmThumb === slot);
		});

		if (this.photos[slot]) {
			this._pendingBlob = this.photos[slot];
			this._showReview(this.photos[slot]);
		} else {
			this._pendingBlob = null;
			const preview = this.root.querySelector('[data-sfm-preview]');
			const video = this.root.querySelector('[data-sfm-video]');
			const canvas = this.root.querySelector('[data-sfm-canvas]');
			preview.hidden = true;
			video.style.display = '';
			canvas.style.display = '';
			if (this.session) this.session.start();
			this._setBarMode('live');
		}
	}

	_showSubmitPhase() {
		this.phase = 'submit';
		const preview = this.root.querySelector('[data-sfm-preview]');
		const video = this.root.querySelector('[data-sfm-video]');
		const canvas = this.root.querySelector('[data-sfm-canvas]');
		const hint = this.root.querySelector('[data-sfm-hint]');
		const badges = this.root.querySelector('[data-sfm-badges]');

		if (this.photos.frontal) {
			const url = URL.createObjectURL(this.photos.frontal);
			preview.src = url;
			preview.onload = () => URL.revokeObjectURL(url);
			preview.hidden = false;
		}
		video.style.display = 'none';
		canvas.style.display = 'none';
		if (this.session) this.session.stop();

		const count = [this.photos.frontal, this.photos.left, this.photos.right].filter(Boolean).length;
		badges.innerHTML = `<span class="sfm-chip sfm-chip-ok">${count} photo${count > 1 ? 's' : ''} ready</span>`;
		hint.textContent = '';

		const title = this.root.querySelector('[data-sfm-title]');
		if (title) title.textContent = 'Build your avatar';

		this._setBarMode('submit');
	}

	_updateThumbs() {
		this.root.querySelectorAll('[data-sfm-thumb]').forEach((thumb) => {
			const slot = thumb.dataset.sfmThumb;
			const photo = this.photos[slot];
			const existing = thumb.querySelector('.sfm-thumb-img');
			if (photo && !existing) {
				const img = document.createElement('img');
				img.className = 'sfm-thumb-img';
				const url = URL.createObjectURL(photo);
				img.src = url;
				img.onload = () => URL.revokeObjectURL(url);
				thumb.insertBefore(img, thumb.firstChild);
				thumb.classList.add('sfm-thumb-filled');
			} else if (!photo && existing) {
				existing.remove();
				thumb.classList.remove('sfm-thumb-filled');
			}
		});
	}

	async _handleUpload(file) {
		if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return;
		const blob = file.slice(0, file.size, file.type);
		this._pendingBlob = blob;
		this._showReview(blob);
	}

	_setBarMode(mode) {
		const modes = ['live', 'review', 'submit', 'building'];
		modes.forEach((m) => {
			const el = this.root.querySelector(`[data-sfm-bar-${m}]`);
			if (el) el.hidden = m !== mode;
		});
	}

	async _submit() {
		if (!this.photos.frontal) return;
		const submitBtn = this.root.querySelector('[data-sfm-submit]');
		if (submitBtn) {
			submitBtn.disabled = true;
			submitBtn.textContent = 'Preparing...';
		}
		this._setBarMode('building');

		try {
			const photos = [];
			for (const slot of ['frontal', 'left', 'right']) {
				if (!this.photos[slot]) continue;
				const dataUrl = await blobToDataUrl(this.photos[slot]);
				photos.push(dataUrl);
			}

			this._setBuildLabel('Submitting to avatar engine...');
			const res = await fetch(RECONSTRUCT_ENDPOINT, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: `Selfie ${new Date().toISOString().slice(0, 10)}`,
					photos,
					visibility: 'private',
					params: { bodyType: this.bodyType, style: this.avatarType },
					...(this.existingAvatarId ? { replaceAvatarId: this.existingAvatarId } : {}),
				}),
			});

			if (res.status === 401) {
				this._setBuildLabel('Sign in required');
				const next = encodeURIComponent(location.pathname + location.search);
				window.location.assign(`/login?next=${next}`);
				return;
			}

			if (!res.ok) {
				const payload = await res.json().catch(() => ({}));
				throw new Error(payload.error_description || payload.error || `HTTP ${res.status}`);
			}

			const data = await res.json();
			if (!data.jobId) throw new Error('No job ID returned');

			this._setBuildLabel('Generating 3D mesh...');
			const avatarId = await this._pollJob(data.jobId);
			this.opts.onDone({ avatarId });
		} catch (err) {
			this._setBuildLabel(err.message || 'Failed. Try again.');
			this._setBarMode('submit');
			if (submitBtn) {
				submitBtn.disabled = false;
				submitBtn.textContent = 'Build my avatar';
			}
		}
	}

	async _pollJob(jobId) {
		const deadline = Date.now() + 8 * 60 * 1000;
		let attempt = 0;
		const labels = [
			'Generating 3D mesh...',
			'Building geometry and textures...',
			'Auto-rigging skeleton...',
			'Finishing avatar...',
		];

		while (Date.now() < deadline) {
			const interval = attempt === 0 ? 1500 : Math.min(3000 * Math.pow(1.3, Math.min(attempt, 10)), 10000);
			await new Promise((r) => setTimeout(r, interval));
			attempt++;

			this._setBuildLabel(labels[Math.min(Math.floor(attempt / 5), labels.length - 1)]);

			const r = await fetch(`${STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`, {
				credentials: 'include',
			});
			if (!r.ok) continue;
			const job = await r.json();
			if (job.status === 'done' && job.resultAvatarId) return job.resultAvatarId;
			if (job.status === 'failed') throw new Error(job.error || 'Reconstruction failed');
		}
		throw new Error('Timed out — check your dashboard in a few minutes');
	}

	_setBuildLabel(text) {
		const el = this.root.querySelector('[data-sfm-build-label]');
		if (el) el.textContent = text;
	}

	_injectStyles() {
		if (document.getElementById('sfm-styles')) return;
		const style = document.createElement('style');
		style.id = 'sfm-styles';
		style.textContent = SFM_CSS;
		document.head.appendChild(style);
	}
}

async function blobToDataUrl(blob) {
	const bitmap = await createImageBitmap(blob);
	const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
	const w = Math.round(bitmap.width * scale);
	const h = Math.round(bitmap.height * scale);
	const c = document.createElement('canvas');
	c.width = w; c.height = h;
	const ctx = c.getContext('2d');
	ctx.drawImage(bitmap, 0, 0, w, h);
	try { bitmap.close?.(); } catch (_) {}
	return c.toDataURL('image/jpeg', JPEG_QUALITY);
}

const SFM_CSS = `
.sfm-root {
	position: fixed;
	inset: 0;
	z-index: 10000;
	display: flex;
	align-items: center;
	justify-content: center;
	opacity: 0;
	transition: opacity 200ms ease;
}
.sfm-root.sfm-open { opacity: 1; }
.sfm-backdrop {
	position: absolute;
	inset: 0;
	background: rgba(0, 0, 0, 0.88);
	backdrop-filter: blur(12px);
}
.sfm-panel {
	position: relative;
	width: min(440px, 96vw);
	max-height: 94vh;
	display: flex;
	flex-direction: column;
	background: #0a0a0a;
	border: 1px solid #1a1a1a;
	border-radius: 20px;
	overflow: hidden;
	box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7);
}
.sfm-header {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 14px 16px;
	border-bottom: 1px solid #1a1a1a;
	flex-shrink: 0;
}
.sfm-close {
	background: transparent;
	border: 1px solid #2a2a2a;
	color: #888;
	width: 32px;
	height: 32px;
	border-radius: 8px;
	display: grid;
	place-items: center;
	cursor: pointer;
	transition: color 120ms, border-color 120ms;
}
.sfm-close:hover { color: #e8e8e8; border-color: #444; }
.sfm-title {
	font-size: 15px;
	font-weight: 600;
	color: #e8e8e8;
	flex: 1;
}
.sfm-slot-label {
	font-size: 12px;
	color: #888;
	letter-spacing: 0.04em;
	text-transform: uppercase;
}
.sfm-stage {
	position: relative;
	aspect-ratio: 3 / 4;
	background: #000;
	overflow: hidden;
}
.sfm-video {
	width: 100%;
	height: 100%;
	object-fit: cover;
	transform: scaleX(-1);
}
.sfm-canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	transform: scaleX(-1);
	pointer-events: none;
}
.sfm-preview-img {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	transform: scaleX(-1);
}
.sfm-badges {
	position: absolute;
	top: 10px;
	left: 10px;
	right: 10px;
	display: flex;
	gap: 5px;
	flex-wrap: wrap;
	z-index: 2;
}
.sfm-chip {
	font-size: 10.5px;
	font-weight: 600;
	padding: 3px 8px;
	border-radius: 6px;
	letter-spacing: 0.03em;
	text-transform: uppercase;
	background: rgba(0, 0, 0, 0.55);
	border: 1px solid rgba(255, 255, 255, 0.1);
	color: #888;
	backdrop-filter: blur(6px);
}
.sfm-chip-ok {
	color: #e8e8e8;
	border-color: rgba(255, 255, 255, 0.25);
	background: rgba(255, 255, 255, 0.1);
}
.sfm-chip-bad {
	color: #ff6b6b;
	border-color: rgba(255, 107, 107, 0.3);
	background: rgba(255, 107, 107, 0.08);
}
.sfm-hint {
	position: absolute;
	bottom: 12px;
	left: 0;
	right: 0;
	text-align: center;
	font-size: 13px;
	color: rgba(255, 255, 255, 0.75);
	padding: 8px 16px;
	pointer-events: none;
	text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}
.sfm-hint-ok { color: #e8e8e8; font-weight: 500; }
.sfm-hint-err { color: #ff6b6b; }

.sfm-captures {
	display: flex;
	gap: 8px;
	padding: 10px 16px;
	border-bottom: 1px solid #1a1a1a;
	justify-content: center;
	flex-shrink: 0;
}
.sfm-thumb {
	width: 52px;
	height: 52px;
	border-radius: 10px;
	border: 1.5px dashed #2a2a2a;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	position: relative;
	overflow: hidden;
	transition: border-color 120ms;
}
.sfm-thumb:hover { border-color: #444; }
.sfm-thumb-active { border-color: #e8e8e8; border-style: solid; }
.sfm-thumb-filled { border-style: solid; border-color: #2a2a2a; }
.sfm-thumb-label {
	font-size: 9.5px;
	color: #888;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}
.sfm-thumb-img {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	transform: scaleX(-1);
}

.sfm-bar {
	padding: 14px 16px;
	flex-shrink: 0;
}
.sfm-bar-live, .sfm-bar-review {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}
.sfm-bar-submit {
	display: flex;
	flex-direction: column;
	gap: 14px;
}
.sfm-bar-building {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 8px 0;
}

.sfm-btn {
	padding: 10px 16px;
	border-radius: 10px;
	font: 600 13.5px/1 -apple-system, system-ui, sans-serif;
	cursor: pointer;
	border: none;
	transition: background 120ms, color 120ms;
}
.sfm-btn-ghost {
	background: transparent;
	color: #888;
	border: 1px solid #2a2a2a;
}
.sfm-btn-ghost:hover { color: #e8e8e8; border-color: #444; }
.sfm-btn-primary {
	background: #e8e8e8;
	color: #0a0a0a;
}
.sfm-btn-primary:hover { background: #fff; }
.sfm-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.sfm-btn-full { width: 100%; text-align: center; }

.sfm-shutter {
	width: 64px;
	height: 64px;
	border-radius: 50%;
	background: #e8e8e8;
	border: none;
	cursor: pointer;
	display: grid;
	place-items: center;
	transition: opacity 120ms, transform 120ms;
	flex-shrink: 0;
}
.sfm-shutter:disabled { opacity: 0.3; cursor: not-allowed; }
.sfm-shutter:not(:disabled):active { transform: scale(0.92); }
.sfm-shutter-ring {
	width: 50px;
	height: 50px;
	border-radius: 50%;
	border: 3px solid #0a0a0a;
	display: block;
}

.sfm-opts {
	display: flex;
	gap: 16px;
	align-items: center;
}
.sfm-opt-group {
	display: flex;
	align-items: center;
	gap: 8px;
}
.sfm-opt-label {
	font-size: 11px;
	color: #888;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}
.sfm-toggle {
	display: flex;
	background: #111;
	border: 1px solid #1a1a1a;
	border-radius: 8px;
	padding: 2px;
	gap: 2px;
}
.sfm-toggle-btn {
	background: transparent;
	border: none;
	color: #888;
	font: 600 12px/1 -apple-system, system-ui, sans-serif;
	padding: 6px 10px;
	border-radius: 6px;
	cursor: pointer;
	transition: background 120ms, color 120ms;
}
.sfm-toggle-btn.active {
	background: #1a1a1a;
	color: #e8e8e8;
}
.sfm-toggle-btn:hover:not(.active) { color: #bbb; }

.sfm-build-spinner {
	width: 20px;
	height: 20px;
	border-radius: 50%;
	border: 2px solid #2a2a2a;
	border-top-color: #e8e8e8;
	animation: sfm-spin 0.8s linear infinite;
}
@keyframes sfm-spin { to { transform: rotate(360deg); } }
.sfm-build-label {
	font-size: 13.5px;
	color: #888;
}

@media (max-width: 480px) {
	.sfm-panel {
		width: 100vw;
		max-height: 100vh;
		border-radius: 0;
		height: 100vh;
	}
}
`;
