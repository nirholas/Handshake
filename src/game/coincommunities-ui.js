// Coin Communities UI layer — lobby + in-world chrome.
//
// Two surfaces:
//   1. Lobby: live pump.fun coin grid (each coin = a community to enter) + a
//      zero-friction avatar picker (presets, or paste your own avatar / 3D
//      agent GLB URL or three.ws avatar id).
//   2. In-world HUD: coin banner + online count, chat, emote tray, leave.
//
// The 3D scene (coincommunities.js) owns WebGL + projected name labels; this
// module owns the 2D chrome and calls back through the handlers passed in.

import { renderAvatarThumb } from './avatar-thumb.js';
import { resolveAvatarUrl } from './avatar-rig.js';
import { validateGlb, uploadGlb } from './avatar-upload.js';

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

const fmtMc = (n) => {
	if (!n || !isFinite(n)) return null;
	if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
	if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
	return '$' + Math.round(n);
};

const DEFAULT_AVATAR = '/avatars/default.glb';

export class CommunityUI {
	/**
	 * @param {object} h handlers: { onEnter(coin), onLeave(), onChat(text), onEmote(name) }
	 */
	constructor(h) {
		this.h = h;
		this.coins = [];
		this.featured = null;      // pinned official town (e.g. the $THREE flagship)
		this.searchResults = [];   // live pump.fun search hits beyond the trending grid
		this.searching = false;
		this._searchSeq = 0;       // guards against out-of-order async search responses
		this._searchTimer = null;
		this.avatar = localStorage.getItem('cc-avatar') || DEFAULT_AVATAR;
		this._buildLobby();
		this._buildHud();
	}

	// ---------------------------------------------------------------- lobby
	_buildLobby() {
		this.searchInput = el('input', { type: 'text', placeholder: 'Search any pump.fun coin…', oninput: () => this._onSearchInput() });
		this.grid = el('div', { class: 'cc-grid' });

		// Your display name — the label peers see above your avatar and in chat.
		// Persisted so it sticks across sessions; broadcast live if changed in-world.
		this.nameInput = el('input', {
			type: 'text', maxlength: '24', class: 'cc-name-input', id: 'cc-name-input',
			placeholder: 'Pick a name', 'aria-label': 'Your display name',
			value: localStorage.getItem('cc-name') || '',
			onchange: () => this._commitName(),
			onkeydown: (e) => { if (e.key === 'Enter') { this._commitName(); this.nameInput.blur(); } e.stopPropagation(); },
		});

		this.presetRow = el('div', { class: 'cc-avatar-presets' });
		this.customInput = el('input', {
			type: 'text',
			placeholder: 'Paste avatar / 3D agent GLB URL or avatar id',
			value: /^https?:|^\//.test(this.avatar) && this.avatar !== DEFAULT_AVATAR ? this.avatar : '',
			onchange: () => { this._setAvatar(this.customInput.value.trim() || DEFAULT_AVATAR, true); },
		});

		// Bring-your-own avatar: drop a .glb on the bar or pick one. It's validated,
		// uploaded to storage, then broadcast by its public URL so peers see it too.
		this.uploadFile = el('input', {
			type: 'file', accept: '.glb,model/gltf-binary', class: 'cc-upload-file',
			onchange: (e) => { const f = e.target.files?.[0]; if (f) this._handleGlbFile(f); e.target.value = ''; },
		});
		this.uploadBtn = el('label', { class: 'cc-upload-btn', title: 'Upload a .glb avatar from your device' }, [
			el('span', { class: 'cc-upload-ico', text: '⬆' }),
			el('span', { class: 'cc-upload-text', text: 'Upload .glb' }),
			this.uploadFile,
		]);

		// Browse the full avatar library (your own + the public gallery) with live
		// 3D previews, instead of pasting a URL. Reuses the platform-wide
		// AvatarGalleryPicker, lazy-loaded so the lobby bundle stays lean.
		this.galleryBtn = el('button', {
			type: 'button', class: 'cc-gallery-btn',
			title: 'Browse your avatars and the public gallery',
			onclick: () => this._openGallery(),
		}, [
			el('span', { class: 'cc-gallery-ico', text: '🖼' }),
			el('span', { class: 'cc-gallery-text', text: 'Browse gallery' }),
		]);
		this.uploadStatus = el('div', { class: 'cc-upload-status', role: 'status', 'aria-live': 'polite', hidden: true });

		this.lobby = el('div', { id: 'cc-lobby' }, [
			el('div', { class: 'cc-lobby-inner' }, [
				el('div', { class: 'cc-lobby-head' }, [
					el('div', { class: 'cc-brand' }, [
						el('a', { class: 'cc-brand-logo', href: '/', 'aria-label': 'three.ws home', title: 'three.ws', html: '<svg viewBox="0 0 32 32" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M11.013 1.011a16 16 0 0 0-3.96 1.39C2.79 4.531.213 8.757.012 13.564c-.16 3.933 1.31 7.62 4.117 10.357l.736.715-.16.46c-.084.249-.13.504-.138.761 0 1.358 1.448 2.218 2.638 1.567.535-.292.879-.748 1.043-1.384.084-.331.092-.462.07-.882-.02-.43-.04-.535-.18-.83-.246-.52-.567-.86-1.087-1.153l-.297-.167.106-.32c.18-.543.79-1.717 1.181-2.276 1.91-2.729 5.066-4.395 8.4-4.434l.43-.005.012-1.19c.006-.654.024-1.19.04-1.19s.252.197.526.438c.71.624 2.296 1.95 2.785 2.328.23.178.41.34.4.36-.01.02-.214.156-.453.303-.926.57-2.265 1.65-3.13 2.524l-.27.273.012 1.064.013 1.064.32.027c1.327.114 2.598.685 3.578 1.607.21.198.39.343.4.323.04-.073.276-1.327.346-1.84.296-2.169-.094-4.317-1.129-6.16l-.19-.34.246-.45c.811-1.485 1.291-3.063 1.456-4.776.04-.42.046-.488.111-.488.111 0 1.327.715 1.94 1.143 2.953 2.057 4.96 5.241 5.579 8.856.21 1.22.234 1.585.234 3.063 0 1.485-.024 1.844-.234 3.064-.811 4.736-4.06 8.732-8.51 10.474-1.04.407-2.504.78-3.578.91l-.32.04v2.395l.41-.046c2.014-.226 4.222-.93 5.98-1.91 4.84-2.688 8.058-7.464 8.696-12.897.105-.892.105-3.063 0-3.956-.638-5.433-3.856-10.21-8.697-12.898C24.083.99 21.875.285 19.86.06 19.322 0 19.27 0 15.752.006c-3.346.006-4.234.02-4.74.105Z"/></svg>' }),
						el('div', {}, [
							el('div', { class: 'cc-brand-title', text: 'Coin Communities' }),
							el('div', { class: 'cc-brand-sub', text: 'Every coin is a 3D world. Drop in and hang out.' }),
						]),
					]),
					el('div', { class: 'cc-search' }, [el('span', { text: '🔎' }), this.searchInput]),
					el('a', { class: 'cc-adventure', href: '/game', title: 'Isometric MMO — gather, fight, level up' }, [
						el('span', { class: 'cc-adventure-ico', text: '⚔️' }),
						el('span', { html: 'Adventure mode<small>Gather · fight · level up</small>' }),
					]),
				]),
				this.avatarBar = el('div', { class: 'cc-avatar-bar' }, [
					el('div', { class: 'cc-name-row' }, [
						el('label', { class: 'cc-name-label', for: 'cc-name-input', text: 'Your name' }),
						this.nameInput,
					]),
					el('div', { class: 'cc-avatar-label', html: 'Your avatar<small>Pick one, browse the gallery, paste a URL, or drop your own .glb</small>' }),
					this.presetRow,
					el('div', { class: 'cc-avatar-custom' }, [this.customInput, this.galleryBtn, this.uploadBtn]),
						this.uploadStatus,
						el('div', { class: 'cc-avatar-dropmsg', text: 'Drop .glb to use as your avatar' }),
				]),
				el('p', { class: 'cc-section-title', text: 'Live communities' }),
				this.grid,
			]),
		]);
		document.body.appendChild(this.lobby);

		this._wireGlbDrop();
		this._renderPresets();
		this.setCoinsLoading();
	}

	// Make the avatar bar a drop target for a local .glb. Only reacts to file
	// drags so a stray text/element drag never lights it up.
	_wireGlbDrop() {
		const bar = this.avatarBar;
		const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
		const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
		bar.addEventListener('dragenter', (e) => { stop(e); if (hasFiles(e)) bar.classList.add('cc-drag'); });
		bar.addEventListener('dragover', (e) => { stop(e); if (hasFiles(e)) { e.dataTransfer.dropEffect = 'copy'; bar.classList.add('cc-drag'); } });
		bar.addEventListener('dragleave', (e) => { stop(e); if (!bar.contains(e.relatedTarget)) bar.classList.remove('cc-drag'); });
		bar.addEventListener('drop', (e) => {
			stop(e);
			bar.classList.remove('cc-drag');
			const files = [...(e.dataTransfer?.files || [])];
			const glb = files.find((f) => f.name.toLowerCase().endsWith('.glb')) || files[0];
			if (glb) this._handleGlbFile(glb);
		});
	}

	// Validate → upload → adopt a dropped/selected .glb as the player's avatar.
	async _handleGlbFile(file) {
		if (this._uploading) return;
		this._uploading = true;
		this._setUploadState('working', 'Checking your model…');
		try {
			await validateGlb(file);
			this._setUploadState('working', 'Uploading… 0%');
			const url = await uploadGlb(file, (p) => this._setUploadState('working', `Uploading… ${Math.round(p * 100)}%`));
			this._addUploadedAvatar(url, file.name);
			this._setUploadState('done', `“${file.name}” is now your avatar.`);
		} catch (err) {
			this._setUploadState('error', err?.message || 'Upload failed.');
		} finally {
			this._uploading = false;
		}
	}

	_setUploadState(state, msg) {
		this.uploadStatus.hidden = false;
		this.uploadStatus.setAttribute('data-state', state);
		this.uploadStatus.textContent = msg;
		this.uploadBtn.classList.toggle('cc-busy', state === 'working');
		clearTimeout(this._uploadStatusTimer);
		if (state === 'done' || state === 'error') {
			const ttl = state === 'done' ? 4000 : 7000;
			this._uploadStatusTimer = setTimeout(() => { this.uploadStatus.hidden = true; }, ttl);
		}
	}

	// Surface the uploaded avatar as its own selected chip (replacing any prior
	// upload chip) and make it the active avatar.
	_addUploadedAvatar(url, name) {
		if (this._uploadChip?.isConnected) this._uploadChip.remove();
		const chip = el('button', {
			class: 'cc-avatar-chip cc-avatar-loading cc-avatar-upload',
			title: name || 'Your uploaded avatar', 'aria-label': name || 'Your uploaded avatar',
			onclick: () => this._setAvatar(url, false),
		}, [el('span', { class: 'cc-avatar-glyph', text: '🧑‍🎨' })]);
		chip._url = url;
		this._uploadChip = chip;
		this.presetRow.insertBefore(chip, this.presetRow.firstChild);
		this._renderChipPreview(chip, { url, label: name || 'Your avatar' });
		this._setAvatar(url, false);
	}

	// Open the platform avatar gallery (your own avatars + the public gallery)
	// with live 3D previews, and adopt the chosen one. Lazy-loaded so the picker
	// and its model-viewer dependency aren't in the lobby's critical bundle.
	async _openGallery() {
		this.galleryBtn.classList.add('cc-busy');
		try {
			const { openAvatarPicker } = await import('../avatar-gallery-picker.js');
			const selected = await openAvatarPicker({
				source: 'both',
				showModes: false,
				title: 'Choose your avatar',
				ctaLabel: 'Use this avatar',
				selectedId: this._galleryChip?._avatarId || '',
			});
			if (selected) this._adoptGalleryAvatar(selected);
		} catch (err) {
			console.warn('[coincommunities] gallery picker failed:', err?.message);
		} finally {
			this.galleryBtn.classList.remove('cc-busy');
		}
	}

	// Surface a gallery pick as its own selected chip and make it the active
	// avatar. Stores the canonical avatar id when available (so the picker can
	// pre-select it next time); the scene resolves it to a loadable URL before
	// broadcasting to peers.
	_adoptGalleryAvatar(a) {
		const value = a.id || a.model_url;
		if (!value) return;
		if (this._galleryChip?.isConnected) this._galleryChip.remove();
		const chip = el('button', {
			class: 'cc-avatar-chip cc-avatar-loading cc-avatar-gallery',
			title: a.name || 'Your avatar', 'aria-label': a.name || 'Your avatar',
			onclick: () => this._setAvatar(value, false),
		}, [
			a.thumbnail_url
				? el('img', { src: a.thumbnail_url, alt: a.name || 'Avatar', loading: 'lazy' })
				: el('span', { class: 'cc-avatar-glyph', text: '🧑' }),
		]);
		chip._url = value;
		chip._avatarId = a.id || '';
		this._galleryChip = chip;
		this.presetRow.insertBefore(chip, this.presetRow.firstChild);
		this._renderChipPreview(chip, { url: a.model_url || value, label: a.name || 'Your avatar' });
		this._setAvatar(value, false);
	}

	async _renderPresets() {
		// Default + a few real three.ws community avatars (best-effort fetch).
		const presets = [{ label: 'Default', url: DEFAULT_AVATAR, icon: '🧍' }];
		try {
			const r = await fetch('/api/explore?source=avatar&only3d=1&limit=6', { headers: { accept: 'application/json' } });
			if (r.ok) {
				const data = await r.json();
				for (const it of (data.items || [])) {
					if (it.glbUrl) presets.push({ label: it.name || 'Avatar', url: it.glbUrl, thumb: it.image });
				}
			}
		} catch { /* offline / no API — default preset still works */ }
		this.presets = presets.slice(0, 7);
		this.presetRow.textContent = '';
		for (const p of this.presets) {
			// Start with the best instantly-available fallback (API thumbnail, else
			// emoji) so the chip is never empty, then render the real model and swap
			// it in. The chip carries a loading shimmer until a preview resolves.
			const fallback = p.thumb
				? el('img', { src: p.thumb, alt: p.label, loading: 'lazy' })
				: el('span', { class: 'cc-avatar-glyph', text: p.icon || '🙂' });
			const chip = el('button', {
				class: 'cc-avatar-chip cc-avatar-loading' + (p.url === this.avatar ? ' cc-on' : ''),
				title: p.label,
				'aria-label': p.label,
				onclick: () => this._setAvatar(p.url, false),
			}, [fallback]);
			chip._url = p.url;
			this.presetRow.appendChild(chip);
			this._renderChipPreview(chip, p);
		}
	}

	// Render the real avatar model to a portrait and swap it into the chip,
	// replacing the placeholder. Leaves the fallback in place if rendering fails
	// (no WebGL, model load error) so the chip stays meaningful.
	async _renderChipPreview(chip, p) {
		let dataUrl = null;
		try {
			dataUrl = await renderAvatarThumb(await resolveAvatarUrl(p.url));
		} catch { /* keep fallback */ }
		if (!chip.isConnected) return;
		chip.classList.remove('cc-avatar-loading');
		if (!dataUrl) return;
		chip.textContent = '';
		chip.appendChild(el('img', { class: 'cc-avatar-render', src: dataUrl, alt: p.label }));
	}

	_setAvatar(url, fromCustom) {
		this.avatar = url || DEFAULT_AVATAR;
		localStorage.setItem('cc-avatar', this.avatar);
		for (const chip of this.presetRow.children) chip.classList.toggle('cc-on', chip._url === this.avatar);
		if (!fromCustom) this.customInput.value = (this.avatar === DEFAULT_AVATAR || !/^https?:|^\//.test(this.avatar)) ? '' : this.avatar;
		this.h.onAvatarChange?.(this.avatar);
	}

	getAvatar() { return this.customInput.value.trim() || this.avatar; }

	setCoinsLoading() {
		this.grid.textContent = '';
		// Keep the pinned official town visible while the live grid loads, so the
		// flagship never blinks out behind the skeletons.
		if (this.featured) this.grid.appendChild(this._coinCard(this.featured, true));
		for (let i = 0; i < 8; i++) {
			this.grid.appendChild(el('div', { class: 'cc-card cc-skeleton' }, [
				el('div', { class: 'cc-card-img' }),
				el('div', { class: 'cc-card-body' }, [el('div', { class: 'cc-card-name' }), el('div', { class: 'cc-card-meta' })]),
			]));
		}
	}

	setCoins(list) { this.coins = list || []; this._renderGrid(); }

	/** Pin an official town (e.g. the $THREE flagship) to the top of the lobby. */
	setFeatured(coin) { this.featured = coin && coin.mint ? coin : null; this._renderGrid(); }

	setCoinsError(retry) {
		this.grid.textContent = '';
		this.grid.appendChild(el('div', { class: 'cc-state' }, [
			el('span', { class: 'cc-state-ico', text: '📡' }),
			el('div', { text: 'Could not load live coins right now.' }),
			el('button', { text: 'Retry', onclick: retry }),
		]));
	}

	// Debounced live search: filter the loaded trending grid instantly for
	// snappy feedback, then query all of pump.fun so any coin (not just the
	// trending 30) becomes reachable as a world.
	_onSearchInput() {
		const q = this.searchInput.value.trim();
		clearTimeout(this._searchTimer);
		if (q.length < 2) {
			this.searchResults = [];
			this.searching = false;
			this._searchSeq++; // invalidate any in-flight search
			this._renderGrid();
			return;
		}
		this._renderGrid(); // instant local filter
		this._searchTimer = setTimeout(() => this._remoteSearch(q), 280);
	}

	async _remoteSearch(query) {
		if (!this.h.onSearch) return;
		const seq = ++this._searchSeq;
		this.searching = true;
		this._renderGrid();
		let results = [];
		try {
			results = (await this.h.onSearch(query)) || [];
		} catch (err) {
			console.warn('[coincommunities] search failed:', err?.message);
		}
		if (seq !== this._searchSeq) return; // a newer query superseded this one
		this.searchResults = results;
		this.searching = false;
		this._renderGrid();
	}

	_renderGrid() {
		const q = this.searchInput.value.trim().toLowerCase();
		const matches = (c) =>
			!q || (c.name || '').toLowerCase().includes(q) || (c.symbol || '').toLowerCase().includes(q) || (c.mint || '').toLowerCase().includes(q);
		// The pinned official town leads the grid when it matches the current query,
		// and is excluded from the regular list so it never appears twice.
		const featured = this.featured && matches(this.featured) ? this.featured : null;
		// Trending matches first, then live search hits not already on screen —
		// deduped by mint so a coin never appears twice.
		const list = this.coins.filter((c) => matches(c) && c.mint !== this.featured?.mint);
		const seen = new Set(list.map((c) => c.mint));
		if (this.featured) seen.add(this.featured.mint);
		for (const c of this.searchResults) {
			if (c.mint && !seen.has(c.mint)) { seen.add(c.mint); list.push(c); }
		}
		this.grid.textContent = '';
		if (!featured && !list.length) {
			if (this.searching) { this._renderSearching(); return; }
			this.grid.appendChild(el('div', { class: 'cc-state' }, [
				el('span', { class: 'cc-state-ico', text: '🪙' }),
				el('div', { text: q ? 'No coins match — try a different name, symbol, or mint.' : 'No communities yet — be the first in!' }),
			]));
			return;
		}
		if (featured) this.grid.appendChild(this._coinCard(featured, true));
		for (const c of list) this.grid.appendChild(this._coinCard(c, false));
		// Searching beyond the trending grid while results are already showing.
		if (this.searching) this.grid.appendChild(el('div', { class: 'cc-search-more' }, [
			el('span', { class: 'cc-spinner' }), document.createTextNode('Searching all of pump.fun…'),
		]));
	}

	// Build one lobby card. The featured (official) town gets a distinct frame, an
	// OFFICIAL badge, and a "home town" call to action so it reads as the flagship.
	_coinCard(c, featured) {
		const mc = fmtMc(c.marketCap);
		const liveBadge = featured
			? el('span', { class: 'cc-card-official', title: 'Official three.ws town' }, [
				el('span', { class: 'cc-card-official-ico', text: '◇' }),
				document.createTextNode('OFFICIAL'),
			])
			: el('span', { class: 'cc-card-live' }, [el('span', { class: 'cc-dot' }), document.createTextNode('LIVE')]);
		return el('div', {
			class: 'cc-card' + (featured ? ' cc-card-featured' : ''),
			onclick: () => this.h.onEnter(c),
		}, [
			el('div', { class: 'cc-card-img', style: c.image ? `background-image:url("${c.image}")` : '' }, [liveBadge]),
			el('div', { class: 'cc-card-body' }, [
				el('div', { class: 'cc-card-name', text: c.name || 'Unnamed coin' }),
				el('div', { class: 'cc-card-meta' }, [
					el('span', { class: 'cc-card-sym', text: c.symbol ? '$' + c.symbol : '' }),
					mc ? el('span', { text: mc + ' mcap' }) : null,
				]),
				el('div', { class: 'cc-card-cta', text: featured ? 'Enter home town →' : 'Enter community →' }),
			]),
		]);
	}

	_renderSearching() {
		this.grid.appendChild(el('div', { class: 'cc-state' }, [
			el('span', { class: 'cc-spinner cc-spinner-lg' }),
			el('div', { text: 'Searching all of pump.fun…' }),
		]));
	}

	// ---------------------------------------------------------------- HUD
	_buildHud() {
		this.coinImg = el('img', { class: 'cc-coin-img', alt: '' });
		this.coinName = el('div', { class: 'cc-coin-name', text: '' });
		this.coinSym = el('span', { class: 'cc-coin-sym', text: '' });
		this.onlineCount = el('span', { text: '1 online' });
		// Buy this coin from inside its own world — the most natural action in a
		// pump.fun community. Opens the native on-chain buy modal (lazy chunk).
		this.buyBtnLabel = el('span', { class: 'cc-buy-btn-text', text: 'Buy' });
		this.buyBtn = el('button', {
			class: 'cc-buy-btn', type: 'button', title: 'Buy this coin',
			onclick: () => this.h.onBuy?.(),
		}, [el('span', { class: 'cc-buy-btn-ico', text: '⚡' }), this.buyBtnLabel]);
		const banner = el('div', { class: 'cc-coin-banner' }, [
			this.coinImg,
			el('div', { class: 'cc-coin-info' }, [
				this.coinName,
				el('div', { class: 'cc-coin-sub' }, [
					this.coinSym,
					el('span', { class: 'cc-online' }, [el('span', { class: 'cc-dot' }), this.onlineCount]),
				]),
			]),
			this.buyBtn,
		]);

		const leave = el('button', { class: 'cc-leave', onclick: () => this.h.onLeave() }, [
			el('span', { text: '←' }), document.createTextNode('Communities'),
		]);

		this.statusText = el('span', { text: 'connecting…' });
		this.pingText = el('span', { class: 'cc-ping', hidden: true });
		this.statusPill = el('div', {
			id: 'cc-status', 'data-state': 'connecting',
			onclick: () => { if (['offline', 'failed'].includes(this.statusPill.getAttribute('data-state'))) this.h.onRetry?.(); },
		}, [el('span', { class: 'cc-dot' }), this.statusText, this.pingText]);

		this.chatLog = el('div', { class: 'cc-chat-log' });
		this.chatInput = el('input', {
			type: 'text', maxlength: '200', placeholder: 'Say something…',
			onkeydown: (e) => {
				if (e.key === 'Enter') this._sendChat();
				else if (e.key === 'Escape') this.chatInput.blur();
				e.stopPropagation();
			},
		});
		this.chatUnread = el('span', { class: 'cc-chat-unread', hidden: true });
		this.chatChevron = el('span', { class: 'cc-chat-chevron', text: '▾' });
		const head = el('div', {
			class: 'cc-chat-head', role: 'button', tabindex: '0', 'aria-label': 'Toggle chat',
			onclick: () => this.toggleChat(),
			onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleChat(); } },
		}, [
			el('span', { class: 'cc-chat-title' }, [el('span', { class: 'cc-chat-ico', text: '💬' }), document.createTextNode('Chat')]),
			this.chatUnread,
			this.chatChevron,
		]);
		this.chatBody = el('div', { class: 'cc-chat-body' }, [
			this.chatLog,
			el('div', { class: 'cc-chat-input' }, [this.chatInput, el('button', { class: 'cc-chat-send', text: 'Send', onclick: () => this._sendChat() })]),
		]);
		this.chat = el('div', { id: 'cc-chat' }, [head, this.chatBody]);
		// Default: collapsed on touch (small screens), open on desktop — unless the
		// user has expressed a preference before.
		const stored = localStorage.getItem('cc-chat-min');
		this._unread = 0;
		this.toggleChat(stored != null ? stored === '1' : matchMedia('(pointer: coarse)').matches);
		const chat = this.chat;

		this.emoteTray = el('div', { id: 'cc-emotes' });

		const hint = el('div', { id: 'cc-hint', html:
			'<kbd>W A S D</kbd> / drag-joystick to move · <kbd>drag</kbd> to look · scroll zoom · <kbd>Enter</kbd> chat' });

		this.joystick = el('div', { id: 'cc-joystick' });

		this.hud = el('div', { id: 'cc-hud', hidden: true }, [banner, leave, this.statusPill, chat, this.emoteTray, hint, this.joystick]);
		document.body.appendChild(this.hud);
	}

	setEmotes(list) {
		this.emoteTray.textContent = '';
		for (const e of list) {
			this.emoteTray.appendChild(el('button', {
				class: 'cc-emote', title: e.label || e.name, text: e.icon || '🙂',
				onclick: () => this.h.onEmote(e.name),
			}));
		}
	}

	_sendChat() {
		const text = this.chatInput.value.trim();
		if (!text) return;
		this.h.onChat(text);
		this.chatInput.value = '';
	}

	enterWorld(coin) {
		this.lobby.hidden = true;
		this.hud.hidden = false;
		this.coinName.textContent = coin.name || 'Community';
		this.coinSym.textContent = coin.symbol ? '$' + coin.symbol : '';
		this.buyBtnLabel.textContent = coin.symbol ? 'Buy $' + coin.symbol.toUpperCase() : 'Buy';
		if (coin.image) { this.coinImg.src = coin.image; this.coinImg.style.display = ''; }
		else this.coinImg.style.display = 'none';
		this.chatLog.textContent = '';
		this._unread = 0;
		this.chatUnread.hidden = true;
		this.pingText.hidden = true;
	}

	showLobby() {
		this.hud.hidden = true;
		this.lobby.hidden = false;
		this._renderGrid();
	}

	setStatus(state) {
		const labels = { connecting: 'connecting…', online: 'connected', offline: 'reconnecting…', failed: 'offline — retry', idle: 'idle' };
		this.statusPill.setAttribute('data-state', state);
		this.statusText.textContent = labels[state] || state;
		// The latency readout is only meaningful while the link is live.
		if (state !== 'online') this.pingText.hidden = true;
	}

	// Show the live round-trip latency next to the status dot. Colour-coded so a
	// glance reads as healthy (green), okay (amber), or laggy (red).
	setPing(ms) {
		if (this.statusPill.getAttribute('data-state') !== 'online') return;
		this.pingText.hidden = false;
		this.pingText.textContent = `${ms}ms`;
		this.pingText.setAttribute('data-grade', ms < 90 ? 'good' : ms < 200 ? 'ok' : 'bad');
	}

	setOnline(n) { this.onlineCount.textContent = `${n} online`; }

	/** Persist the typed display name and, if connected, broadcast it live. */
	_commitName() {
		const name = this.nameInput.value.trim().slice(0, 24);
		if (name) localStorage.setItem('cc-name', name);
		this.h.onRename?.(name);
	}

	/** The chosen display name, or '' to let the caller fall back to a guest id. */
	getName() { return this.nameInput.value.trim().slice(0, 24); }

	/** Reflect a name assigned elsewhere (e.g. a generated guest id) in the field. */
	setName(name) { if (name) this.nameInput.value = name; }

	// Transient bottom-center toast for one-off notices (avatar fell back to a
	// stand-in, etc.). Self-dismisses; a new toast replaces the previous one.
	toast(msg, kind = '') {
		if (!this._toast) {
			this._toast = el('div', { id: 'cc-toast', role: 'status', 'aria-live': 'polite' });
			document.body.appendChild(this._toast);
		}
		clearTimeout(this._toastTimer);
		this._toast.textContent = msg;
		this._toast.setAttribute('data-kind', kind);
		this._toast.classList.add('cc-on');
		this._toastTimer = setTimeout(() => this._toast.classList.remove('cc-on'), 4200);
	}

	addChat({ name, text, mine }) {
		const t = new Date();
		const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
		// Stick to bottom only if the user is already near it, so reading scrollback
		// isn't yanked away when a new message lands.
		const nearBottom = this.chatLog.scrollHeight - this.chatLog.scrollTop - this.chatLog.clientHeight < 60;
		const row = el('div', { class: 'cc-chat-msg' + (mine ? ' cc-mine' : '') }, [
			el('span', { class: 'cc-chat-meta' }, [
				el('b', { text: name }),
				el('time', { text: stamp }),
			]),
			el('span', { class: 'cc-chat-text', text }),
		]);
		this.chatLog.appendChild(row);
		while (this.chatLog.children.length > 200) this.chatLog.removeChild(this.chatLog.firstChild);
		if (nearBottom || mine) this.chatLog.scrollTop = this.chatLog.scrollHeight;
		if (this._chatMin && !mine) {
			this._unread += 1;
			this.chatUnread.textContent = this._unread > 99 ? '99+' : String(this._unread);
			this.chatUnread.hidden = false;
		}
	}

	/** Collapse/expand the chat sidebar. Pass a boolean to force a state. */
	toggleChat(force) {
		this._chatMin = typeof force === 'boolean' ? force : !this._chatMin;
		this.chat.classList.toggle('cc-min', this._chatMin);
		this.chatChevron.textContent = this._chatMin ? '▴' : '▾';
		this.chat.setAttribute('aria-expanded', String(!this._chatMin));
		localStorage.setItem('cc-chat-min', this._chatMin ? '1' : '0');
		if (!this._chatMin) {
			this._unread = 0;
			this.chatUnread.hidden = true;
			this.chatLog.scrollTop = this.chatLog.scrollHeight;
		}
	}

	/** Open the sidebar (if collapsed) and put the cursor in the input. */
	focusChat() {
		if (this._chatMin) this.toggleChat(false);
		this.chatInput.focus();
	}

	get chatFocused() { return document.activeElement === this.chatInput; }
}
