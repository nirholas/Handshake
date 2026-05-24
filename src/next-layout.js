/**
 * Next-layout controller for the /app viewer.
 *
 * Mounts the alternate "Next" chrome — bottom command dock with a scrubbable
 * timeline, right-side Controls drawer that hosts the dat.GUI panel, and a
 * single corner-anchored Share popover that collapses the four owner-action
 * buttons (Save / Widget / Deploy / Profile) plus Upload + Create. The layout
 * is toggled via body[data-layout='next'] (see app.js _applyViewerLayout).
 *
 * Playback is driven through viewer.animationManager — the same path the
 * existing AnimationPanel uses — so manifest-loaded clips, lazy fetches,
 * crossfades, and the onChange callback work identically. The Controls
 * drawer physically relocates the dat.GUI .gui-wrap into a drawer body so
 * every camera/lighting/material knob keeps working through its original
 * onChange handlers; no re-implementation.
 *
 * Borrows three concrete patterns from current best-in-class viewers:
 *   - Sketchfab-style single bottom bar with a real scrubbable timeline
 *   - Babylon-Sandbox-style full-page drop + floating gear → drawer (Khronos)
 *   - Google model-viewer-style auto-rotate-on-idle + a hand swipe prompt
 *     that disappears after the first interaction
 */

import { LoopOnce, LoopRepeat } from 'three';

const STORAGE_KEY_INTERACTED = '3dagent:viewer-interacted';
const POLL_INTERVAL_MS = 100;
const POLL_MAX_MS = 15000;

const ICON_FALLBACK = {
	idle: '🧍',
	breathing: '🧍',
	standing: '🧍',
	walking: '🚶',
	walk: '🚶',
	running: '🏃',
	run: '🏃',
	waving: '👋',
	wave: '👋',
	dancing: '💃',
	dance: '💃',
	sitting: '🪑',
	sit: '🪑',
	jumping: '🦘',
	jump: '🦘',
	talking: '🗣️',
	talk: '🗣️',
	clapping: '👏',
	clap: '👏',
	punching: '👊',
	punch: '👊',
	kicking: '🦵',
	kick: '🦵',
	covereyes: '🙈',
	facepalm: '🤦',
	'av-waving': '👋',
	'av-superhero-jump': '🦸',
	'boxer-dance': '🥊',
	'av-brag-and-clap': '👏',
	'av-flex-arm': '💪',
	'av-walk-crouching': '🚶',
	'av-idle-breath': '🧘',
	'av-waiting': '🕰️',
};

export class NextLayout {
	constructor(app) {
		this.app = app;
		this.viewer = null;
		this.loop = true;
		this.rafId = 0;
		this.driverAttached = false;
		this._guiMoved = false;
		this._idleTimer = 0;
		this._mounted = false;
		this._defsRendered = false;
		this._currentName = null;
	}

	mount() {
		if (this._mounted) return;
		this._mounted = true;

		this.root = document.getElementById('next-chrome');
		if (!this.root) return;

		this._cacheEls();
		this._wireDock();
		this._wireGrid();
		this._wireDrawer();
		this._wireSharePopover();
		this._wireFullscreen();
		this._wirePromptDismiss();
		this._wireLayoutObserver();
		this._wireViewerWhenReady();
		this._wireShareItemMirroring();

		this._applyLayoutChange();
	}

	// ── element cache ────────────────────────────────────────────────────────

	_cacheEls() {
		this.els = {
			prompt: document.getElementById('next-prompt'),
			corner: document.getElementById('next-corner'),
			shareBtn: document.getElementById('next-share-btn'),
			shareMenu: document.getElementById('next-share-menu'),
			shareSave: document.getElementById('next-share-save'),
			shareWidget: document.getElementById('next-share-widget'),
			shareDeploy: document.getElementById('next-share-deploy'),
			shareProfile: document.getElementById('next-share-profile'),
			shareUpload: document.getElementById('next-share-upload'),
			controlsBtn: document.getElementById('next-controls-btn'),
			fullscreenBtn: document.getElementById('next-fullscreen-btn'),
			drawer: document.getElementById('next-drawer'),
			drawerClose: document.getElementById('next-drawer-close'),
			drawerBody: document.getElementById('next-drawer-body'),
			dock: document.getElementById('next-dock'),
			clipBtn: document.getElementById('next-dock-clip'),
			clipName: document.getElementById('next-dock-clip-name'),
			playBtn: document.getElementById('next-dock-play'),
			scrubInput: document.getElementById('next-dock-scrub-input'),
			scrubFill: document.getElementById('next-dock-scrub-fill'),
			time: document.getElementById('next-dock-time'),
			loopBtn: document.getElementById('next-dock-loop'),
			grid: document.getElementById('next-grid'),
		};
	}

	// ── viewer wiring ────────────────────────────────────────────────────────

	async _wireViewerWhenReady() {
		const viewer = await this._waitForViewer();
		if (!viewer) return;
		this.viewer = viewer;
		// Subscribe and attach the rAF driver immediately. The driver re-renders
		// the grid when defs arrive later, so it's fine if defs aren't ready yet.
		this._subscribeOnChange();
		this._attachDriver();
		this._armIdleAutoRotate();
		// Best-effort: wait briefly for defs, then render once explicitly.
		await this._waitForDefs(viewer);
		this._renderClipGrid();
		this._onManagerChange(viewer.animationManager.currentName);
	}

	_waitForViewer() {
		return new Promise((resolve) => {
			const start = Date.now();
			const poll = () => {
				if (this.app.viewer && this.app.viewer.controls && this.app.viewer.animationManager) {
					resolve(this.app.viewer);
					return;
				}
				if (Date.now() - start > POLL_MAX_MS) {
					resolve(null);
					return;
				}
				setTimeout(poll, POLL_INTERVAL_MS);
			};
			poll();
		});
	}

	_waitForDefs(viewer) {
		return new Promise((resolve) => {
			const start = Date.now();
			const poll = () => {
				const defs = viewer.animationManager?.getAnimationDefs();
				if (defs && defs.length > 0) {
					resolve(defs);
					return;
				}
				// Fall back to the GLB's built-in clips if no manifest exists.
				if (viewer.clips?.length && viewer.mixer && Date.now() - start > 3000) {
					resolve(this._defsFromClips(viewer.clips));
					return;
				}
				if (Date.now() - start > POLL_MAX_MS) {
					resolve(this._defsFromClips(viewer.clips || []));
					return;
				}
				setTimeout(poll, POLL_INTERVAL_MS);
			};
			poll();
		});
	}

	_defsFromClips(clips) {
		// Synthesize defs from GLB-built-in clips so the dock has something to
		// show even on avatars without a manifest. Playback for these goes
		// through viewer.mixer directly (see _playClipDef).
		return clips.map((clip) => ({
			name: clip.name,
			label: _stripIdx(clip.name),
			__builtin: clip,
		}));
	}

	// ── animation playback ───────────────────────────────────────────────────

	_renderClipGrid() {
		if (this._defsRendered) return;
		const grid = this.els.grid;
		if (!grid || !this.viewer) return;
		const defs = this._currentDefs();
		grid.innerHTML = '';
		const frag = document.createDocumentFragment();
		defs.forEach((def) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'next-grid__item';
			btn.dataset.name = def.name;
			btn.setAttribute('role', 'option');
			btn.setAttribute('aria-selected', 'false');
			btn.title = def.label || def.name;
			const icon = document.createElement('span');
			icon.className = 'next-grid__icon';
			icon.textContent = def.icon || ICON_FALLBACK[def.name.toLowerCase()] || '▶';
			const label = document.createElement('span');
			label.className = 'next-grid__label';
			label.textContent = def.label || def.name;
			btn.appendChild(icon);
			btn.appendChild(label);
			btn.addEventListener('click', () => {
				this._playClipDef(def);
				this._toggleGrid(false);
			});
			frag.appendChild(btn);
		});
		grid.appendChild(frag);
		this._defsRendered = true;
	}

	_currentDefs() {
		const mgr = this.viewer?.animationManager;
		const manifest = mgr?.getAnimationDefs() || [];
		if (manifest.length > 0) return manifest;
		return this._defsFromClips(this.viewer?.clips || []);
	}

	async _playClipDef(def) {
		const viewer = this.viewer;
		if (!viewer) return;
		if (def.__builtin) {
			this._playBuiltinClip(def.__builtin);
			return;
		}
		await viewer.animationManager.crossfadeTo(def.name, 0.2);
		// onChange fires from inside crossfadeTo; UI updates land in _onManagerChange.
	}

	_playBuiltinClip(clip) {
		const viewer = this.viewer;
		if (!viewer?.mixer) return;
		viewer.mixer.stopAllAction();
		const action = viewer.mixer.clipAction(clip);
		action.reset();
		action.enabled = true;
		action.setEffectiveTimeScale(1);
		action.setEffectiveWeight(1);
		this._applyLoop(action);
		action.play();
		this._currentName = clip.name;
		this._updateClipName(_stripIdx(clip.name));
		this._updatePlayBtn();
		this._updateGridHighlight();
		viewer.invalidate();
	}

	_subscribeOnChange() {
		const mgr = this.viewer?.animationManager;
		if (!mgr) return;
		const prev = mgr.onChange;
		mgr.onChange = (name) => {
			try {
				prev?.(name);
			} catch {
				/* keep our handler running even if a downstream listener throws */
			}
			this._onManagerChange(name);
		};
	}

	_onManagerChange(name) {
		this._currentName = name;
		const def = this._currentDefs().find((d) => d.name === name);
		this._updateClipName(def?.label || (name ? _stripIdx(name) : '—'));
		this._updatePlayBtn();
		this._updateGridHighlight();
		// Re-apply loop preference on the new action.
		const action = this._currentAction();
		if (action) this._applyLoop(action);
	}

	_currentAction() {
		const viewer = this.viewer;
		if (!viewer) return null;
		const mgr = viewer.animationManager;
		if (mgr?.currentAction) return mgr.currentAction;
		// Fallback: built-in clip path uses viewer.mixer directly.
		if (this._currentName && viewer.mixer && viewer.clips) {
			const clip = viewer.clips.find((c) => c.name === this._currentName);
			if (clip) return viewer.mixer.clipAction(clip);
		}
		return null;
	}

	_applyLoop(action) {
		if (!action) return;
		action.setLoop(this.loop ? LoopRepeat : LoopOnce, this.loop ? Infinity : 1);
		action.clampWhenFinished = !this.loop;
	}

	_attachDriver() {
		if (this.driverAttached) return;
		this.driverAttached = true;
		let lastDefsLen = -1;
		let lastName = '__init__';
		const tick = () => {
			this.rafId = requestAnimationFrame(tick);
			// Re-render the grid when new defs arrive after first mount.
			const defs = this._currentDefs();
			if (defs.length !== lastDefsLen) {
				lastDefsLen = defs.length;
				this._defsRendered = false;
				this._renderClipGrid();
				// Refresh the clip-name label too in case it was '—' before defs landed.
				const cur = this.viewer?.animationManager?.currentName ?? this._currentName;
				const def = defs.find((d) => d.name === cur);
				if (def) this._updateClipName(def.label || _stripIdx(cur));
			}
			// Mirror manager's currentName even if onChange fired before subscription.
			const liveName = this.viewer?.animationManager?.currentName ?? null;
			if (liveName !== lastName) {
				lastName = liveName;
				this._onManagerChange(liveName);
			}
			this._updateScrubAndTime();
		};
		this.rafId = requestAnimationFrame(tick);
	}

	_updateClipName(text) {
		if (!this.els.clipName) return;
		this.els.clipName.textContent = text || '—';
	}

	_updatePlayBtn() {
		const btn = this.els.playBtn;
		if (!btn) return;
		const a = this._currentAction();
		const playing = Boolean(a && !a.paused && a.isRunning());
		btn.setAttribute('aria-pressed', String(playing));
		btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
		btn.classList.toggle('next-dock__play--playing', playing);
	}

	_updateScrubAndTime() {
		const a = this._currentAction();
		const scrubInput = this.els.scrubInput;
		const scrubFill = this.els.scrubFill;
		const time = this.els.time;
		if (!a) {
			if (scrubInput && document.activeElement !== scrubInput) scrubInput.value = '0';
			if (scrubFill) scrubFill.style.width = '0%';
			if (time) time.textContent = '0:00 / 0:00';
			return;
		}
		const duration = a.getClip().duration || 0;
		const t = duration ? a.time % duration : 0;
		const pct = duration ? (t / duration) * 1000 : 0;
		if (scrubInput && document.activeElement !== scrubInput) {
			scrubInput.value = String(Math.round(pct));
		}
		if (scrubFill) scrubFill.style.width = `${(pct / 1000) * 100}%`;
		if (time) time.textContent = `${_fmtTime(t)} / ${_fmtTime(duration)}`;
	}

	_updateGridHighlight() {
		const grid = this.els.grid;
		if (!grid) return;
		grid.querySelectorAll('.next-grid__item').forEach((btn) => {
			const active = btn.dataset.name === this._currentName;
			btn.classList.toggle('next-grid__item--active', active);
			btn.setAttribute('aria-selected', String(active));
		});
	}

	// ── dock wiring ──────────────────────────────────────────────────────────

	_wireDock() {
		this.els.clipBtn?.addEventListener('click', () => {
			this._toggleGrid();
		});

		this.els.playBtn?.addEventListener('click', () => {
			const a = this._currentAction();
			if (!a) {
				// Nothing playing yet — auto-play the first available def.
				const defs = this._currentDefs();
				if (defs[0]) this._playClipDef(defs[0]);
				return;
			}
			if (a.paused || !a.isRunning()) {
				const duration = a.getClip().duration || 0;
				if (!this.loop && duration && a.time >= duration - 0.01) {
					a.reset();
					this._applyLoop(a);
				}
				a.paused = false;
				if (!a.isRunning()) a.play();
			} else {
				a.paused = true;
			}
			this._updatePlayBtn();
			this.viewer?.invalidate();
		});

		const scrub = this.els.scrubInput;
		if (scrub) {
			const onScrub = () => {
				const a = this._currentAction();
				if (!a) return;
				const duration = a.getClip().duration || 0;
				const pct = Number(scrub.value) / 1000;
				a.time = Math.max(0, Math.min(duration, pct * duration));
				// Tick the mixer with dt=0 so the new pose lands even while paused.
				this.viewer?.mixer?.update(0);
				this.viewer?.animationManager?.mixer?.update(0);
				this._updateScrubAndTime();
				this.viewer?.invalidate();
			};
			scrub.addEventListener('input', onScrub);
			scrub.addEventListener('change', onScrub);
		}

		this.els.loopBtn?.addEventListener('click', () => {
			this.loop = !this.loop;
			this.els.loopBtn.setAttribute('aria-pressed', String(this.loop));
			this.els.loopBtn.classList.toggle('next-dock__loop--off', !this.loop);
			const a = this._currentAction();
			if (a) this._applyLoop(a);
		});
	}

	_wireGrid() {
		document.addEventListener('click', (e) => {
			const grid = this.els.grid;
			const btn = this.els.clipBtn;
			if (!grid || grid.hidden) return;
			if (grid.contains(e.target) || btn?.contains(e.target)) return;
			this._toggleGrid(false);
		});
	}

	_toggleGrid(force) {
		const grid = this.els.grid;
		const btn = this.els.clipBtn;
		if (!grid || !btn) return;
		const open = typeof force === 'boolean' ? force : grid.hidden;
		grid.hidden = !open;
		btn.setAttribute('aria-expanded', String(open));
		btn.classList.toggle('next-dock__clip--open', open);
	}

	// ── drawer (Controls) ────────────────────────────────────────────────────

	_wireDrawer() {
		this.els.controlsBtn?.addEventListener('click', () => this._toggleDrawer());
		this.els.drawerClose?.addEventListener('click', () => this._toggleDrawer(false));
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && this._drawerIsOpen()) this._toggleDrawer(false);
		});
	}

	_drawerIsOpen() {
		return this.els.drawer?.classList.contains('next-drawer--open');
	}

	_toggleDrawer(force) {
		const drawer = this.els.drawer;
		const btn = this.els.controlsBtn;
		if (!drawer || !btn) return;
		const open = typeof force === 'boolean' ? force : !this._drawerIsOpen();
		drawer.classList.toggle('next-drawer--open', open);
		drawer.setAttribute('aria-hidden', String(!open));
		btn.setAttribute('aria-expanded', String(open));
		btn.classList.toggle('next-icon-btn--active', open);
		if (open) this._mountGuiIntoDrawer();
	}

	_mountGuiIntoDrawer() {
		if (this._guiMoved) return;
		const wrap = document.querySelector('.gui-wrap');
		const body = this.els.drawerBody;
		if (!wrap || !body) return;
		wrap.classList.remove('gui-wrap--hidden');
		body.appendChild(wrap);
		this._guiMoved = true;
	}

	// ── share popover ────────────────────────────────────────────────────────

	_wireSharePopover() {
		this.els.shareBtn?.addEventListener('click', (e) => {
			e.stopPropagation();
			this._toggleShare();
		});
		document.addEventListener('click', (e) => {
			const menu = this.els.shareMenu;
			const btn = this.els.shareBtn;
			if (!menu || menu.hidden) return;
			if (menu.contains(e.target) || btn?.contains(e.target)) return;
			this._toggleShare(false);
		});

		this.els.shareSave?.addEventListener('click', () => {
			document.getElementById('save-to-account-btn')?.click();
			this._toggleShare(false);
		});

		this.els.shareUpload?.addEventListener('click', () => {
			document.getElementById('file-input')?.click();
			this._toggleShare(false);
		});
	}

	_wireShareItemMirroring() {
		const map = [
			{ src: 'save-to-account-btn', dst: this.els.shareSave, type: 'btn' },
			{ src: 'make-widget-btn', dst: this.els.shareWidget, type: 'link' },
			{ src: 'deploy-onchain-btn', dst: this.els.shareDeploy, type: 'link' },
			{ src: 'view-public-profile-btn', dst: this.els.shareProfile, type: 'link' },
		];
		for (const { src, dst, type } of map) {
			const srcEl = document.getElementById(src);
			if (!srcEl || !dst) continue;
			const sync = () => {
				const hidden = srcEl.hidden || srcEl.hasAttribute('hidden');
				dst.hidden = hidden;
				if (type === 'link') {
					const href = srcEl.getAttribute('href');
					if (href) dst.setAttribute('href', href);
					else dst.removeAttribute('href');
					if (srcEl.target) dst.setAttribute('target', srcEl.target);
				}
				const label = srcEl.querySelector('[data-state-label]') || srcEl.querySelector('span');
				if (label && dst.querySelector('span')) {
					dst.querySelector('span').textContent = label.textContent.trim();
				}
				const isDeployed = srcEl.classList.contains('is-deployed');
				dst.classList.toggle('next-share-menu__item--success', isDeployed);
				this._updateShareDot();
			};
			sync();
			const mo = new MutationObserver(sync);
			mo.observe(srcEl, {
				attributes: true,
				attributeFilter: ['hidden', 'href', 'class', 'target'],
				childList: true,
				subtree: true,
				characterData: true,
			});
		}
		this._updateShareDot();
	}

	_updateShareDot() {
		const btn = this.els.shareBtn;
		if (!btn) return;
		const items = [this.els.shareSave, this.els.shareWidget, this.els.shareDeploy, this.els.shareProfile];
		const any = items.some((el) => el && !el.hidden);
		btn.classList.toggle('next-icon-btn--has-actions', any);
	}

	_toggleShare(force) {
		const menu = this.els.shareMenu;
		const btn = this.els.shareBtn;
		if (!menu || !btn) return;
		const open = typeof force === 'boolean' ? force : menu.hidden;
		menu.hidden = !open;
		btn.setAttribute('aria-expanded', String(open));
		btn.classList.toggle('next-icon-btn--active', open);
		if (open) this._updateShareDot();
	}

	// ── fullscreen ───────────────────────────────────────────────────────────

	_wireFullscreen() {
		this.els.fullscreenBtn?.addEventListener('click', () => {
			const el = document.documentElement;
			if (document.fullscreenElement) {
				document.exitFullscreen().catch(() => {});
			} else if (el.requestFullscreen) {
				el.requestFullscreen().catch(() => {});
			}
		});
	}

	// ── interaction prompt + idle auto-rotate ────────────────────────────────

	_wirePromptDismiss() {
		const prompt = this.els.prompt;
		if (!prompt) return;
		const seen = (() => {
			try {
				return localStorage.getItem(STORAGE_KEY_INTERACTED) === 'true';
			} catch {
				return false;
			}
		})();
		if (seen) {
			prompt.remove();
			return;
		}
		const dismiss = () => {
			prompt.classList.add('next-prompt--out');
			setTimeout(() => prompt.remove(), 500);
			try {
				localStorage.setItem(STORAGE_KEY_INTERACTED, 'true');
			} catch {
				/* ignore */
			}
			window.removeEventListener('pointerdown', dismiss);
			window.removeEventListener('wheel', dismiss);
			window.removeEventListener('keydown', dismiss);
		};
		window.addEventListener('pointerdown', dismiss, { once: true });
		window.addEventListener('wheel', dismiss, { once: true, passive: true });
		window.addEventListener('keydown', dismiss, { once: true });
	}

	_armIdleAutoRotate() {
		const viewer = this.viewer;
		if (!viewer?.controls) return;
		const resetIdle = () => {
			if (!viewer.controls) return;
			viewer.controls.autoRotate = false;
			viewer.invalidate();
			clearTimeout(this._idleTimer);
			this._idleTimer = setTimeout(() => {
				if (document.body.dataset.layout !== 'next') return;
				viewer.controls.autoRotate = true;
				viewer.controls.autoRotateSpeed = 0.6;
				viewer.invalidate();
			}, 4000);
		};
		viewer.controls.addEventListener('start', resetIdle);
		viewer.controls.addEventListener('end', resetIdle);
		resetIdle();
	}

	// ── layout toggle observer ───────────────────────────────────────────────

	_wireLayoutObserver() {
		const mo = new MutationObserver(() => this._applyLayoutChange());
		mo.observe(document.body, { attributes: true, attributeFilter: ['data-layout'] });
	}

	_applyLayoutChange() {
		const next = document.body.dataset.layout === 'next';
		this.root?.setAttribute('aria-hidden', String(!next));
		if (next) {
			this._mountGuiIntoDrawer();
			// If clips loaded after first mount, ensure grid reflects the latest defs.
			this._defsRendered = false;
			this._renderClipGrid();
		} else if (this._guiMoved) {
			const wrap = document.querySelector('.gui-wrap');
			const viewerEl = document.getElementById('viewer-container');
			if (wrap && viewerEl) {
				wrap.classList.add('gui-wrap--hidden');
				viewerEl.appendChild(wrap);
				this._guiMoved = false;
			}
		}
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

function _stripIdx(name) {
	const m = /^\d+\.\s*(.*)$/.exec(name);
	return m ? m[1] : name;
}

function _fmtTime(s) {
	const total = Math.max(0, Math.floor(s));
	const m = Math.floor(total / 60);
	const sec = total % 60;
	return `${m}:${String(sec).padStart(2, '0')}`;
}
