// In-world avatar switcher (/play). The lobby's avatar bar is unreachable once
// a world is entered (it lives inside the hidden lobby DOM), so this panel puts
// the whole avatar toolset behind the HUD's Avatar button and the V hotkey:
// your saved three.ws avatars, community quick picks, the shared gallery
// picker, a paste-a-URL/id field, a .glb/.vrm upload, and the full in-app
// creator. Every pick routes through one handler the scene owns
// (`onPick(value, meta)` in coincommunities.js `_applyAvatarSwap`), which
// rebuilds the local rig and broadcasts the change so peers re-render it live.
// The panel never touches the rig or the network itself, so it stays a pure
// view that can be torn down with the world.
//
// Server side already supports mid-session swaps: WalkRoom's `avatar` message
// (rate-limited, host-allow-listed via multiplayer/src/avatar-url.js) updates
// the Player schema field every peer's RemotePlayer.setAvatar reacts to.

import { log } from '../shared/log.js';

function el(tag, attrs = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'dataset') Object.assign(n.dataset, v);
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
		else if (v === true) n.setAttribute(k, '');
		else n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) {
		if (c == null || c === false) continue;
		n.append(c.nodeType ? c : document.createTextNode(String(c)));
	}
	return n;
}

const DEFAULT_AVATAR = '/avatars/default.glb';

export class AvatarSwitcher {
	/**
	 * @param {HTMLElement} host container the panel renders into
	 * @param {object} h handlers:
	 *   current():string                      the active cc-avatar value (id/url/sentinel)
	 *   onPick(value, {label}):Promise<{ok:boolean, reason?:string, downgraded?:boolean}>
	 */
	constructor(host, h = {}) {
		this.host = host;
		this.h = h;
		this.root = null;
		this._picking = false;
		this._mineLoaded = false;
		this._quickLoaded = false;
	}

	mount() {
		if (!this.root) this._build();
		if (!this.root.isConnected) this.host.appendChild(this.root);
		if (!this._mineLoaded) this._renderMine();
		if (!this._quickLoaded) this._renderQuick();
		this._markActive(this.h.current?.() || '');
	}

	unmount() {
		this.root?.remove();
	}

	dispose() {
		this.unmount();
		this._creator?.dispose?.();
		this._creator = null;
		this.root = null;
	}

	// ---------------------------------------------------------------- build
	_build() {
		this.status = el('div', { class: 'cc-avsw-status', role: 'status', 'aria-live': 'polite', hidden: true });

		this.mineGrid = el('div', { class: 'cc-avsw-grid', role: 'list', 'aria-label': 'Your saved avatars' });
		this.quickGrid = el('div', { class: 'cc-avsw-grid', role: 'list', 'aria-label': 'Quick picks' });

		this.pasteInput = el('input', {
			type: 'text', class: 'cc-avsw-paste-input',
			placeholder: 'Paste a .glb / .vrm URL or avatar id',
			'aria-label': 'Avatar URL or id',
			onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this._pasteApply(); } e.stopPropagation(); },
		});
		const pasteBtn = el('button', {
			type: 'button', class: 'cc-avsw-btn', text: 'Wear it',
			onclick: () => this._pasteApply(),
		});

		this.uploadFile = el('input', {
			type: 'file', accept: '.glb,.vrm,model/gltf-binary', class: 'cc-avsw-file',
			'aria-label': 'Upload a .glb or .vrm avatar',
			onchange: (e) => { const f = e.target.files?.[0]; if (f) this._upload(f); e.target.value = ''; },
		});
		const uploadBtn = el('label', { class: 'cc-avsw-btn cc-avsw-upload', title: 'Upload a .glb or .vrm from your device' }, [
			el('span', { 'aria-hidden': 'true', text: '⬆' }), ' Upload', this.uploadFile,
		]);
		const galleryBtn = el('button', {
			type: 'button', class: 'cc-avsw-btn', title: 'Browse your avatars and the public gallery with live previews',
			onclick: (e) => this._openGallery(e.currentTarget),
		}, [el('span', { 'aria-hidden': 'true', text: '🖼' }), ' Gallery']);
		const createBtn = el('button', {
			type: 'button', class: 'cc-avsw-btn cc-avsw-create', title: 'Create a brand-new avatar, from scratch or from a photo',
			onclick: (e) => this._openCreator(e.currentTarget),
		}, [el('span', { 'aria-hidden': 'true', text: '✦' }), ' Create new']);

		this.root = el('div', { class: 'cc-avsw' }, [
			this.status,
			el('div', { class: 'cc-avsw-section' }, [
				el('div', { class: 'cc-avsw-title', text: 'Your avatars' }),
				this.mineGrid,
			]),
			el('div', { class: 'cc-avsw-section' }, [
				el('div', { class: 'cc-avsw-title', text: 'Quick picks' }),
				this.quickGrid,
			]),
			el('div', { class: 'cc-avsw-section' }, [
				el('div', { class: 'cc-avsw-title', text: 'Bring your own' }),
				el('div', { class: 'cc-avsw-row' }, [this.pasteInput, pasteBtn]),
				el('div', { class: 'cc-avsw-actions' }, [createBtn, galleryBtn, uploadBtn]),
			]),
		]);
	}

	_setStatus(state, msg) {
		if (!this.status) return;
		this.status.hidden = false;
		this.status.setAttribute('data-state', state);
		this.status.textContent = msg;
		clearTimeout(this._statusTimer);
		if (state === 'done' || state === 'error') {
			this._statusTimer = setTimeout(() => { if (this.status) this.status.hidden = true; }, state === 'done' ? 4000 : 8000);
		}
	}

	// One chip per wearable option. `value` is what the scene resolves (id, URL,
	// or the guest sentinel); the thumbnail falls back to a glyph when the poster
	// is missing or dead so the chip is never an empty square.
	_chip({ value, label, thumb, glyph }) {
		const face = thumb
			? el('img', {
					class: 'cc-avsw-thumb', src: thumb, alt: '', loading: 'lazy',
					onerror: (e) => { e.target.replaceWith(el('span', { class: 'cc-avsw-glyph', 'aria-hidden': 'true', text: glyph || '🧑' })); },
				})
			: el('span', { class: 'cc-avsw-glyph', 'aria-hidden': 'true', text: glyph || '🧑' });
		const btn = el('button', {
			type: 'button', class: 'cc-avsw-chip', role: 'listitem',
			title: label, 'aria-label': `Wear ${label}`,
			onclick: (e) => this._pick(value, label, e.currentTarget),
		}, [face, el('span', { class: 'cc-avsw-chip-name', text: label })]);
		btn.dataset.value = value;
		return btn;
	}

	_markActive(value) {
		if (!this.root) return;
		for (const chip of this.root.querySelectorAll('.cc-avsw-chip')) {
			chip.classList.toggle('is-active', !!value && chip.dataset.value === value);
		}
	}

	// ---------------------------------------------------------------- pick
	async _pick(value, label, btn) {
		const v = (value || '').trim();
		if (!v || this._picking) return;
		this._picking = true;
		this.root?.classList.add('is-busy');
		btn?.classList.add('is-busy');
		this._setStatus('working', `Switching to ${label}…`);
		try {
			const res = await this.h.onPick?.(v, { label });
			if (res?.ok) {
				this._markActive(v);
				this._setStatus('done', res.downgraded
					? `Wearing a lighter stand-in for ${label} on this device.`
					: `You're now wearing ${label}.`);
			} else if (res?.reason === 'load-failed') {
				this._setStatus('error', `Couldn't load ${label}, so your current avatar is unchanged.`);
			} else if (res?.reason !== 'stale') {
				this._setStatus('error', 'That switch didn’t go through. Try again.');
			}
		} catch (err) {
			log.warn('[avatar-switcher] pick failed:', err?.message);
			this._setStatus('error', 'Avatar switch failed. Try again.');
		} finally {
			this._picking = false;
			btn?.classList.remove('is-busy');
			this.root?.classList.remove('is-busy');
		}
	}

	_pasteApply() {
		const v = this.pasteInput?.value.trim();
		if (!v) { this._setStatus('error', 'Paste a model URL or avatar id first.'); return; }
		this._pick(v, 'your pasted avatar');
	}

	// ---------------------------------------------------------------- lists
	async _renderMine() {
		this._mineLoaded = true;
		this.mineGrid.textContent = '';
		for (let i = 0; i < 3; i++) this.mineGrid.appendChild(el('div', { class: 'cc-avsw-chip cc-avsw-skel', 'aria-hidden': 'true' }));
		let block = null;
		try {
			const r = await fetch('/api/avatars/mine?limit=60', { credentials: 'include', headers: { accept: 'application/json' } });
			if (r.status === 401) {
				block = el('div', { class: 'cc-avsw-note' }, [
					el('a', { href: '/login?next=/play', class: 'cc-avsw-link', text: 'Sign in' }),
					' to wear the avatars saved to your three.ws account.',
				]);
			} else if (!r.ok) {
				throw new Error(`HTTP ${r.status}`);
			} else {
				const data = await r.json();
				const avatars = Array.isArray(data?.avatars) ? data.avatars : [];
				if (!avatars.length) {
					block = el('div', { class: 'cc-avsw-note' }, [
						'No saved avatars yet. ',
						el('a', { href: '/create', target: '_blank', rel: 'noopener', class: 'cc-avsw-link', text: 'Create one' }),
						' or use Create new below.',
					]);
				} else {
					this.mineGrid.textContent = '';
					for (const a of avatars) {
						this.mineGrid.appendChild(this._chip({
							value: a.id, label: a.name || 'Untitled avatar', thumb: a.thumb_url, glyph: '🧑',
						}));
					}
					this._markActive(this.h.current?.() || '');
					return;
				}
			}
		} catch (err) {
			log.warn('[avatar-switcher] failed to load saved avatars:', err?.message);
			block = el('div', { class: 'cc-avsw-note' }, [
				'Couldn’t load your avatars. ',
				el('button', {
					type: 'button', class: 'cc-avsw-link cc-avsw-retry', text: 'Retry',
					onclick: () => this._renderMine(),
				}),
			]);
		}
		this.mineGrid.textContent = '';
		this.mineGrid.appendChild(block);
	}

	async _renderQuick() {
		this._quickLoaded = true;
		this.quickGrid.textContent = '';
		this.quickGrid.appendChild(this._chip({ value: DEFAULT_AVATAR, label: 'Default', glyph: '🧍' }));
		try {
			const r = await fetch('/api/explore?source=avatar&only3d=1&limit=9', { headers: { accept: 'application/json' } });
			if (!r.ok) return;
			const data = await r.json();
			for (const it of (data.items || [])) {
				if (!it.glbUrl) continue;
				this.quickGrid.appendChild(this._chip({
					value: it.glbUrl, label: it.name || 'Avatar', thumb: it.image, glyph: '🙂',
				}));
			}
			this._markActive(this.h.current?.() || '');
		} catch { /* offline: the default chip still works */ }
	}

	// ---------------------------------------------------------------- bring your own
	async _upload(file) {
		if (this._picking) return;
		this._setStatus('working', 'Checking your model…');
		try {
			const { validateGlb, uploadGlb } = await import('./avatar-upload.js');
			await validateGlb(file);
			this._setStatus('working', 'Uploading… 0%');
			const url = await uploadGlb(file, (p) => this._setStatus('working', `Uploading… ${Math.round(p * 100)}%`));
			await this._pick(url, file.name || 'your upload');
		} catch (err) {
			this._setStatus('error', err?.message || 'Upload failed.');
		}
	}

	async _openGallery(btn) {
		btn?.classList.add('is-busy');
		try {
			const { openAvatarPicker } = await import('../avatar-gallery-picker.js');
			const a = await openAvatarPicker({
				source: 'both', showModes: false,
				title: 'Choose your avatar', ctaLabel: 'Wear this avatar',
			});
			if (a) await this._pick(a.id || a.model_url, a.name || 'that avatar');
		} catch (err) {
			log.warn('[avatar-switcher] gallery picker failed:', err?.message);
			this._setStatus('error', 'Couldn’t open the gallery. Try again.');
		} finally {
			btn?.classList.remove('is-busy');
		}
	}

	// The full in-app creator (design from scratch or from a photo). The exported
	// GLB is staged locally via playAs (guest sentinel), so the scene shows it
	// instantly from the local blob and uploads it in the background before
	// broadcasting the public URL to peers, the same flow the lobby uses.
	async _openCreator(btn) {
		btn?.classList.add('is-busy');
		try {
			const [{ AvatarCreator }, { playAs, GUEST_SENTINEL }] = await Promise.all([
				import('../avatar-creator.js'),
				import('./play-handoff.js'),
			]);
			this._creator?.dispose?.();
			this._creator = new AvatarCreator(document.body, async (blob, meta = {}) => {
				try {
					await playAs({ blob, source: meta.provider || 'three-ws-create', dest: null });
					await this._pick(GUEST_SENTINEL, 'your new avatar');
				} catch (err) {
					log.warn('[avatar-switcher] could not adopt created avatar:', err?.message);
					this._setStatus('error', 'Couldn’t save your new avatar. Please try again.');
				}
			});
			await this._creator.openDefaultEditor();
		} catch (err) {
			log.warn('[avatar-switcher] avatar creator failed to open:', err?.message);
			this._setStatus('error', 'Couldn’t open the avatar creator. Try uploading a .glb instead.');
		} finally {
			btn?.classList.remove('is-busy');
		}
	}
}
