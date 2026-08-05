// chapters.js: the tour's navigation panel. A 264-stop tour needs a map, so
// this panel lays the whole curriculum out as chapters → stops in a
// registry-style listing (bold title, one-line summary of what the guide says,
// and the page path underneath), marks the stop you're on, and lets you jump to
// any of them. It doubles as the settings surface: switch tracks, change the
// narration voice, set the playback speed, and search across titles, paths, and
// narration. Docked, it slides in from the left; on desktop you can also drag
// it by its header to float it anywhere on screen (the position is remembered),
// which drops the scrim so the tour stays visible and clickable behind it.
// It is pure UI — every action forwards to a handler the director supplies, and
// the director calls setActive()/setTrack()/setVoice()/setSpeed() to keep it in
// sync. Open/close is fully keyboard- and screen-reader-friendly.

import { createAvatarPicker } from '../../walk-sdk/src/picker.js';

const Z_PANEL = 2147483450;
const POS_KEY = 'tws:tour:menu-pos';
const OPEN_KEY = 'tws:tour:menu-open';

// A curated client-side slice of the platform voice catalog (api/_lib/tts-voices.js).
// Kept small so the menu stays scannable; every id here renders on both the free
// Magpie lane and the OpenAI backstop.
const VOICES = [
	{ id: 'nova', name: 'Nova' },
	{ id: 'alloy', name: 'Alloy' },
	{ id: 'echo', name: 'Echo' },
	{ id: 'fable', name: 'Fable' },
	{ id: 'onyx', name: 'Onyx' },
	{ id: 'sage', name: 'Sage' },
	{ id: 'shimmer', name: 'Shimmer' },
];

const SPEEDS = [0.75, 1, 1.25, 1.5];

export class ChapterPanel {
	constructor(curriculum, handlers, avatarConfig = {}) {
		this.curriculum = curriculum;
		this.handlers = handlers; // { onJump(abs), onTrack, onVoice, onSpeed, onAvatar, onClose }
		// The avatar roster the guide can wear, plus who it's wearing now.
		this.avatars = avatarConfig.avatars || [];
		this.currentAvatarId = avatarConfig.currentId || null;
		this.assetBase = avatarConfig.assetBase || '';
		this.docsUrl = avatarConfig.docsUrl || null;
		this.open = false;
		this.floating = false;
		this.activeAbs = 0;
		this._query = '';
		this._pos = null;
		// Search matches title, path, and narration; lowercased once, not per keystroke.
		this._searchIndex = (curriculum.stops || []).map((s) =>
			`${s.title || ''} ${s.path || ''} ${s.narration || ''}`.toLowerCase(),
		);
		this._chapterCount = (curriculum.sections || []).filter((section) =>
			(curriculum.stops || []).some((s) => s.section === section.id),
		).length;
		this._onKey = this._onKey.bind(this);
		this._onResize = this._onResize.bind(this);
		ensureStyles();
		this._build();
		// A floating map that was open when the tour navigated to the next stop
		// reopens itself in the same spot, so the companion survives page loads.
		// Focus stays with the page: a self-restoring panel must not steal it.
		if (this._readPos() && this._dragAllowed() && readSession(OPEN_KEY)) {
			this.show({ focus: false });
		}
	}

	_build() {
		const root = document.createElement('div');
		root.className = 'tws-tour-menu';
		root.innerHTML = `
			<div class="tws-tour-menu__scrim" data-act="close"></div>
			<aside class="tws-tour-menu__panel" role="dialog" aria-modal="false" aria-label="Tour chapters and settings" tabindex="-1">
				<div class="tws-tour-menu__head">
					<div class="tws-tour-menu__title">Tour map <span class="tws-tour-menu__badge"></span></div>
					<button class="tws-tour-menu__hbtn" data-act="dock" aria-label="Dock the panel back to the side" title="Dock back to the side" hidden>⇤</button>
					<button class="tws-tour-menu__hbtn tws-tour-menu__x" data-act="close" aria-label="Close menu" title="Close">✕</button>
				</div>
				<div class="tws-tour-menu__settings">
					<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl">Track</span>
						<div class="tws-tour-seg" data-group="track" role="radiogroup" aria-label="Tour length"></div>
					</label>
					<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl">Speed</span>
						<div class="tws-tour-seg" data-group="speed" role="radiogroup" aria-label="Playback speed"></div>
					</label>
					<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl" id="tws-tour-voice-lbl">Voice</span>
						<select class="tws-tour-menu__select" data-act="voice" aria-labelledby="tws-tour-voice-lbl"></select>
					</label>
					${
						this.avatars.length
							? `<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl">Guide</span>
						<button type="button" class="tws-tour-menu__avatar" data-act="avatar" aria-haspopup="dialog" aria-label="Change the guide avatar">
							<span class="tws-tour-menu__avatar-orb" aria-hidden="true"></span>
							<span class="tws-tour-menu__avatar-name">Avatar</span>
							<span class="tws-tour-menu__avatar-chev" aria-hidden="true">▾</span>
						</button>
					</label>`
							: ''
					}
				</div>
				<div class="tws-tour-menu__search">
					<input type="search" class="tws-tour-menu__input" placeholder="Search features, pages, or narration…" aria-label="Search tour stops" autocomplete="off" spellcheck="false" />
					<p class="tws-tour-menu__countline" aria-live="polite"></p>
				</div>
				<nav class="tws-tour-menu__list" aria-label="Tour chapters"></nav>
			</aside>`;
		document.body.appendChild(root);
		this.root = root;
		this.panel = root.querySelector('.tws-tour-menu__panel');
		this.head = root.querySelector('.tws-tour-menu__head');
		this.badgeEl = root.querySelector('.tws-tour-menu__badge');
		this.dockBtn = root.querySelector('[data-act="dock"]');
		this.listEl = root.querySelector('.tws-tour-menu__list');
		this.countLine = root.querySelector('.tws-tour-menu__countline');
		this.trackSeg = root.querySelector('[data-group="track"]');
		this.speedSeg = root.querySelector('[data-group="speed"]');
		this.voiceSel = root.querySelector('[data-act="voice"]');
		this.avatarBtn = root.querySelector('[data-act="avatar"]');
		this.searchInput = root.querySelector('.tws-tour-menu__input');

		this.badgeEl.textContent = String((this.curriculum.stops || []).length);
		this._buildSegments();
		this._buildVoices();
		this._renderAvatarBtn();
		this._buildList();
		this._initDrag();
		window.addEventListener('resize', this._onResize);

		root.addEventListener('click', (e) => {
			if (e.target.closest('[data-act="dock"]')) {
				this._dock();
				return;
			}
			if (e.target.closest('[data-act="close"]')) this.close();
		});
		this.trackSeg.addEventListener('click', (e) => {
			const id = e.target.closest('[data-val]')?.dataset.val;
			if (id) this.handlers.onTrack?.(id);
		});
		this.speedSeg.addEventListener('click', (e) => {
			const v = e.target.closest('[data-val]')?.dataset.val;
			if (v) this.handlers.onSpeed?.(Number(v));
		});
		this.voiceSel.addEventListener('change', () => this.handlers.onVoice?.(this.voiceSel.value));
		this.avatarBtn?.addEventListener('click', () => this._openAvatarPicker());
		this.searchInput.addEventListener('input', () => {
			this._query = this.searchInput.value.trim().toLowerCase();
			this._buildList();
		});
		this.listEl.addEventListener('click', (e) => {
			const abs = e.target.closest('[data-abs]')?.dataset.abs;
			if (abs != null) {
				this.handlers.onJump?.(Number(abs));
				// A floating map is a companion you jump around from; only the
				// docked drawer (which covers the page behind a scrim) self-closes.
				if (!this.floating) this.close();
			}
		});
	}

	_buildSegments() {
		const tracks = this.curriculum.tracks?.length
			? this.curriculum.tracks
			: [{ id: 'full', title: 'Full' }];
		this.trackSeg.innerHTML = tracks
			.map(
				(t) =>
					`<button class="tws-tour-seg__btn" data-val="${t.id}" role="radio" aria-checked="false" title="${esc(t.description || '')}">${esc(t.title.replace(/ tour| highlights/i, ''))}${t.estimatedMinutes ? ` · ~${t.estimatedMinutes}m` : ''}</button>`,
			)
			.join('');
		this.speedSeg.innerHTML = SPEEDS.map(
			(s) =>
				`<button class="tws-tour-seg__btn" data-val="${s}" role="radio" aria-checked="false">${String(s).replace(/\.?0+$/, '')}×</button>`,
		).join('');
	}

	_buildVoices() {
		this.voiceSel.innerHTML = VOICES.map(
			(v) => `<option value="${v.id}">${esc(v.name)}</option>`,
		).join('');
	}

	// ── Guide avatar picker ─────────────────────────────────────────────────────
	// Reuses the Walk SDK's avatar picker so the tour offers the exact same cast a
	// visitor can pick anywhere else. The picker is responsibility-free — it just
	// fires onSelect; we persist + hot-swap through the director's onAvatar handler.
	_renderAvatarBtn() {
		if (!this.avatarBtn) return;
		const orb = this.avatarBtn.querySelector('.tws-tour-menu__avatar-orb');
		const name = this.avatarBtn.querySelector('.tws-tour-menu__avatar-name');
		const entry = this.avatars.find((a) => a.id === this.currentAvatarId);
		if (entry) {
			name.textContent = entry.name;
			if (entry.accent) orb.style.setProperty('--wp-accent', entry.accent);
			if (entry.thumb) {
				orb.style.backgroundImage = `url('${this.assetBase}${entry.thumb}')`;
				orb.textContent = '';
			} else {
				orb.style.backgroundImage = 'none';
				orb.textContent = entry.emoji || '🧍';
			}
		} else {
			// A user-generated avatar that isn't in the static roster.
			name.textContent = 'Your avatar';
			orb.style.backgroundImage = 'none';
			orb.textContent = '✨';
		}
	}

	_openAvatarPicker() {
		if (!this.avatars.length) return;
		if (!this._picker) {
			this._picker = createAvatarPicker({
				avatars: this.avatars,
				currentId: this.currentAvatarId,
				assetBase: this.assetBase,
				docsUrl: this.docsUrl,
				// Float above the playback bar, clear of the left-docked menu.
				anchor: { right: 16, bottom: 92 },
				onSelect: (entry) => this._onAvatarPicked(entry),
			});
		}
		this._picker.setCurrent(this.currentAvatarId);
		// The menu scrim sits above the picker, so step the menu aside to reveal it.
		this.close();
		this._picker.show();
	}

	_onAvatarPicked(entry) {
		this.currentAvatarId = entry.id;
		this._renderAvatarBtn();
		this.handlers.onAvatar?.(entry);
	}

	// Director-driven sync: reflect an avatar change that happened elsewhere.
	setAvatarCurrent(id) {
		this.currentAvatarId = id;
		this._renderAvatarBtn();
		this._picker?.setCurrent(id);
	}

	_buildList() {
		const { sections, stops } = this.curriculum;
		const q = this._query;
		const rows = [];
		let shown = 0;
		for (const section of sections) {
			const items = stops
				.map((s, abs) => ({ s, abs }))
				.filter(({ s }) => s.section === section.id)
				.filter(({ abs }) => !q || this._searchIndex[abs].includes(q));
			if (!items.length) continue;
			shown += items.length;
			rows.push(
				`<div class="tws-tour-chap"><span class="tws-tour-chap__t">${esc(section.title)}</span><span class="tws-tour-chap__n">${items.length}</span></div>`,
			);
			for (const { s, abs } of items) {
				const blurb = stopBlurb(s);
				rows.push(
					`<button class="tws-tour-stop${abs === this.activeAbs ? ' is-current' : ''}" data-abs="${abs}" aria-current="${abs === this.activeAbs ? 'true' : 'false'}">
						<span class="tws-tour-stop__row">
							<span class="tws-tour-stop__dot"${s.highlight ? ' data-hl="1"' : ''}></span>
							<span class="tws-tour-stop__title">${esc(s.title)}</span>
							${s.highlight ? '<span class="tws-tour-stop__star" title="In the Quick highlights">★</span>' : ''}
						</span>
						${blurb ? `<span class="tws-tour-stop__desc">${esc(blurb)}</span>` : ''}
						<span class="tws-tour-stop__meta">${esc(s.path || '')}</span>
					</button>`,
				);
			}
		}
		const total = stops.length;
		this.countLine.textContent = q
			? `${shown} of ${total} stops match`
			: `${total} stops · ${this._chapterCount} chapters`;
		this.listEl.innerHTML =
			rows.join('') ||
			`<div class="tws-tour-menu__empty">No features match “${esc(this._query)}”.</div>`;
	}

	// ── Director-driven sync ────────────────────────────────────────────────────
	setActive(abs) {
		this.activeAbs = abs;
		this.listEl.querySelectorAll('.tws-tour-stop').forEach((el) => {
			const on = Number(el.dataset.abs) === abs;
			el.classList.toggle('is-current', on);
			el.setAttribute('aria-current', on ? 'true' : 'false');
		});
		if (this.open) this._scrollToActive();
	}

	setTrack(track) {
		this._mark(this.trackSeg, track);
	}
	setSpeed(speed) {
		this._mark(this.speedSeg, String(speed));
	}
	setVoice(voice) {
		this.voiceSel.value = voice;
	}

	_mark(seg, val) {
		seg.querySelectorAll('.tws-tour-seg__btn').forEach((b) => {
			const on = b.dataset.val === val;
			b.classList.toggle('is-on', on);
			b.setAttribute('aria-checked', on ? 'true' : 'false');
		});
	}

	// ── Floating / drag ─────────────────────────────────────────────────────────
	// Desktop-only: grab the header to tear the drawer off into a floating panel
	// you can park anywhere. The scrim disappears so the page (and the tour) stays
	// interactive behind it, and the spot is remembered across pages and sessions.
	// The ⇤ button, small screens, and coarse pointers all fall back to the drawer.
	_dragAllowed() {
		try {
			return !window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
		} catch (_) {
			return false;
		}
	}

	_initDrag() {
		this.head.addEventListener('pointerdown', (e) => {
			if (!this._dragAllowed()) return;
			if (e.button !== 0 || e.target.closest('button')) return;
			e.preventDefault();
			const rect = this.panel.getBoundingClientRect();
			const startX = e.clientX;
			const startY = e.clientY;
			const offX = startX - rect.left;
			const offY = startY - rect.top;
			let dragging = false;
			const onMove = (ev) => {
				if (!dragging) {
					// A 5px threshold keeps plain clicks on the header from tearing off.
					if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
					dragging = true;
					this._enterFloating();
					this.head.classList.add('is-dragging');
				}
				this._placeAt(ev.clientX - offX, ev.clientY - offY);
			};
			const onUp = () => {
				document.removeEventListener('pointermove', onMove);
				document.removeEventListener('pointerup', onUp);
				document.removeEventListener('pointercancel', onUp);
				this.head.classList.remove('is-dragging');
				if (dragging) this._savePos();
			};
			document.addEventListener('pointermove', onMove);
			document.addEventListener('pointerup', onUp);
			document.addEventListener('pointercancel', onUp);
		});
	}

	_enterFloating() {
		if (this.floating) return;
		this.floating = true;
		this.root.classList.add('is-floating');
		this.dockBtn.hidden = false;
	}

	_dock() {
		this.floating = false;
		this.root.classList.remove('is-floating');
		this.dockBtn.hidden = true;
		this.panel.style.left = '';
		this.panel.style.top = '';
		this._pos = null;
		try {
			localStorage.removeItem(POS_KEY);
		} catch (_) {}
	}

	_placeAt(x, y) {
		const w = this.panel.offsetWidth || 380;
		const h = this.panel.offsetHeight || 560;
		const nx = clamp(x, 8, Math.max(8, window.innerWidth - w - 8));
		const ny = clamp(y, 8, Math.max(8, window.innerHeight - h - 8));
		this.panel.style.left = nx + 'px';
		this.panel.style.top = ny + 'px';
		this._pos = { x: nx, y: ny };
	}

	_savePos() {
		if (!this._pos) return;
		try {
			localStorage.setItem(POS_KEY, JSON.stringify(this._pos));
		} catch (_) {}
	}

	_readPos() {
		try {
			const raw = localStorage.getItem(POS_KEY);
			if (!raw) return null;
			const pos = JSON.parse(raw);
			return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : null;
		} catch (_) {
			return null;
		}
	}

	_onResize() {
		if (!this.floating) return;
		// Viewport shrank under a floating panel (rotation, window resize):
		// fall back to the drawer on small screens, otherwise re-clamp into view.
		if (!this._dragAllowed()) {
			this._dock();
			return;
		}
		if (this._pos) this._placeAt(this._pos.x, this._pos.y);
	}

	// ── Open / close ────────────────────────────────────────────────────────────
	toggle() {
		this.open ? this.close() : this.show();
	}
	show({ focus = true } = {}) {
		if (this.open) return;
		this.open = true;
		const pos = this._readPos();
		if (pos && this._dragAllowed()) {
			this._enterFloating();
			this._placeAt(pos.x, pos.y);
		}
		this.root.classList.add('is-open');
		writeSession(OPEN_KEY, '1');
		this._scrollToActive();
		document.addEventListener('keydown', this._onKey, true);
		// Focus the search box for instant filter-and-jump.
		if (focus) requestAnimationFrame(() => this.searchInput.focus());
		this.handlers.onOpenChange?.(true);
	}
	close() {
		if (!this.open) return;
		this.open = false;
		this.root.classList.remove('is-open');
		writeSession(OPEN_KEY, null);
		document.removeEventListener('keydown', this._onKey, true);
		this.handlers.onOpenChange?.(false);
	}

	_scrollToActive() {
		const el = this.listEl.querySelector('.tws-tour-stop.is-current');
		el?.scrollIntoView({ block: 'center', behavior: 'auto' });
	}

	_onKey(e) {
		// Swallow Escape here so it closes the menu instead of exiting the tour.
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			this.close();
			return;
		}
		// Trap Tab inside the open drawer so keyboard focus can't wander behind the
		// modal scrim onto the obscured page. Recomputed each press because the
		// stop list re-renders as the search filters. A floating panel has no scrim
		// and the page behind it is meant to stay usable, so no trap there.
		if (e.key === 'Tab') {
			if (this.floating) return;
			const panel = this.root?.querySelector('.tws-tour-menu__panel');
			if (!panel) return;
			const focusable = Array.from(
				panel.querySelectorAll(
					'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
				),
			).filter((el) => el.offsetParent !== null);
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (!panel.contains(active)) {
				e.preventDefault();
				first.focus();
			} else if (e.shiftKey && active === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	dispose() {
		// Dispose is a deliberate teardown (tour exit or finish), unlike a page
		// navigation mid-tour, so the self-reopen flag must not outlive it.
		writeSession(OPEN_KEY, null);
		document.removeEventListener('keydown', this._onKey, true);
		window.removeEventListener('resize', this._onResize);
		this._picker?.destroy();
		this._picker = null;
		this.root?.remove();
		this.root = null;
	}
}

function readSession(key) {
	try {
		return sessionStorage.getItem(key);
	} catch (_) {
		return null;
	}
}

function writeSession(key, value) {
	try {
		if (value == null) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, value);
	} catch (_) {}
}

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

// The narration opens with a "Here we have <title>." lead-in for the voice
// track; in a written list that reads as noise, so the summary starts at the
// substance ("Landing page. The pitch, live agent demos, …").
function stopBlurb(stop) {
	return String(stop.narration || '')
		.replace(/^Here we have [^.!?]*[.!?]\s*/, '')
		.trim();
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-menu-style';
	style.textContent = `
.tws-tour-menu{position:fixed;inset:0;z-index:${Z_PANEL};pointer-events:none;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.tws-tour-menu__scrim{position:absolute;inset:0;background:rgba(6,8,12,.5);opacity:0;transition:opacity .3s ease;pointer-events:none}
.tws-tour-menu.is-open .tws-tour-menu__scrim{opacity:1;pointer-events:auto}
.tws-tour-menu__panel{position:absolute;left:0;top:0;height:100%;width:min(380px,86vw);display:flex;flex-direction:column;background:#0e1118;border-right:1px solid rgba(122,162,255,.18);box-shadow:24px 0 60px rgba(0,0,0,.5);transform:translateX(-104%);transition:transform .34s cubic-bezier(.4,0,.2,1);pointer-events:auto;color:#e7eaf2}
.tws-tour-menu.is-open .tws-tour-menu__panel{transform:translateX(0)}
.tws-tour-menu.is-floating .tws-tour-menu__scrim{display:none}
.tws-tour-menu.is-floating .tws-tour-menu__panel{position:fixed;height:min(76vh,680px);border:1px solid rgba(122,162,255,.22);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.55);transform:translateY(10px) scale(.98);opacity:0;visibility:hidden;transition:transform .22s ease,opacity .22s ease,visibility .22s}
.tws-tour-menu.is-floating.is-open .tws-tour-menu__panel{transform:none;opacity:1;visibility:visible}
.tws-tour-menu__head{display:flex;align-items:center;gap:8px;padding:16px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
.tws-tour-menu__title{flex:1;display:flex;align-items:center;font-weight:700;font-size:16px;min-width:0}
.tws-tour-menu__badge{display:inline-flex;align-items:center;margin-left:9px;padding:3.5px 8px;border-radius:99px;background:rgba(122,162,255,.14);border:1px solid rgba(122,162,255,.3);color:#a9bcff;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.tws-tour-menu__hbtn{appearance:none;border:none;background:rgba(255,255,255,.06);color:#cfd5e2;width:30px;height:30px;border-radius:9px;cursor:pointer;font-size:13px;display:grid;place-items:center;flex:0 0 auto;transition:background .16s ease}
.tws-tour-menu__hbtn:hover{background:rgba(122,162,255,.28);color:#fff}
.tws-tour-menu__hbtn:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.tws-tour-menu__x:hover{background:rgba(220,70,70,.8);color:#fff}
@media (min-width:641px) and (pointer:fine){
	.tws-tour-menu__head{cursor:grab;user-select:none;touch-action:none}
	.tws-tour-menu__head.is-dragging{cursor:grabbing}
}
.tws-tour-menu__settings{padding:14px 18px;display:flex;flex-direction:column;gap:12px;border-bottom:1px solid rgba(255,255,255,.07)}
.tws-tour-menu__field{display:flex;align-items:center;gap:12px;justify-content:space-between}
.tws-tour-menu__lbl{font-size:12.5px;color:#9aa3b6;font-weight:600;flex:0 0 auto;width:48px}
.tws-tour-seg{display:flex;gap:4px;background:rgba(255,255,255,.05);padding:3px;border-radius:10px;flex:1}
.tws-tour-seg__btn{flex:1;appearance:none;border:none;background:transparent;color:#aeb6c6;font:600 12px/1 inherit;padding:7px 6px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .16s ease,color .16s ease}
.tws-tour-seg__btn:hover{color:#e7eaf2}
.tws-tour-seg__btn.is-on{background:linear-gradient(90deg,#7aa2ff,#9d7bff);color:#0b0e16}
.tws-tour-seg__btn:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__select{flex:1;appearance:none;background:rgba(255,255,255,.05);color:#e7eaf2;border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;font:600 13px/1 inherit;cursor:pointer}
.tws-tour-menu__select:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__avatar{flex:1;display:flex;align-items:center;gap:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:5px 10px 5px 5px;color:#e7eaf2;font:600 13px/1 inherit;cursor:pointer;transition:background .16s ease,border-color .16s ease}
.tws-tour-menu__avatar:hover{background:rgba(255,255,255,.09);border-color:rgba(122,162,255,.4)}
.tws-tour-menu__avatar:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__avatar-orb{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:14px;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.35),transparent 60%),var(--wp-accent,#7aa2ff);background-size:cover;background-position:center;box-shadow:inset 0 -4px 8px rgba(0,0,0,.25)}
.tws-tour-menu__avatar-name{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tws-tour-menu__avatar-chev{flex:0 0 auto;color:#9aa3b6;font-size:11px}
.tws-tour-menu__search{padding:12px 18px 8px}
.tws-tour-menu__input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e7eaf2;font:500 13.5px/1 inherit;padding:10px 12px}
.tws-tour-menu__input::placeholder{color:#7f8aa0}
.tws-tour-menu__input:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__countline{margin:8px 2px 0;font-size:11.5px;color:#7f8aa0;font-variant-numeric:tabular-nums}
.tws-tour-menu__list{flex:1;overflow-y:auto;padding:4px 10px 18px;scrollbar-width:thin}
.tws-tour-chap{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 8px 6px;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#7f8aa0;position:sticky;top:0;background:#0e1118;z-index:1}
.tws-tour-chap__n{font-weight:600;color:#5f697e;font-variant-numeric:tabular-nums}
.tws-tour-stop{display:flex;flex-direction:column;align-items:stretch;gap:5px;width:100%;text-align:left;appearance:none;border:none;background:transparent;color:#c4ccda;font:500 13.5px/1.35 inherit;padding:11px 8px 12px;border-radius:10px;cursor:pointer;transition:background .14s ease,color .14s ease}
.tws-tour-stop + .tws-tour-stop{border-top:1px solid rgba(255,255,255,.055)}
.tws-tour-stop:hover{background:rgba(255,255,255,.05);color:#fff}
.tws-tour-stop.is-current{background:rgba(122,162,255,.16);color:#fff}
.tws-tour-stop__row{display:flex;align-items:center;gap:10px;min-width:0}
.tws-tour-stop__dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.22)}
.tws-tour-stop__dot[data-hl="1"]{background:linear-gradient(135deg,#7aa2ff,#9d7bff)}
.tws-tour-stop.is-current .tws-tour-stop__dot{background:#7aa2ff;box-shadow:0 0 0 3px rgba(122,162,255,.3)}
.tws-tour-stop__title{flex:1;font-weight:650;font-size:14px;color:#e7eaf2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tws-tour-stop:hover .tws-tour-stop__title,.tws-tour-stop.is-current .tws-tour-stop__title{color:#fff}
.tws-tour-stop__star{flex:0 0 auto;color:#9d7bff;font-size:11px}
.tws-tour-stop__desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-clamp:2;overflow:hidden;padding-left:17px;font-size:12.5px;line-height:1.45;color:#8b93a7;font-weight:400}
.tws-tour-stop__meta{padding-left:17px;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#5f697e;word-break:break-all}
.tws-tour-menu__empty{padding:30px 14px;text-align:center;color:#7f8aa0;font-size:13px}
@media (prefers-reduced-motion:reduce){.tws-tour-menu__panel{transition:none}.tws-tour-menu__scrim{transition:none}}
`;
	document.head.appendChild(style);
}
