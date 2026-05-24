/**
 * Next-layout controller for the /app viewer.
 *
 * Mounts the alternate "Next" chrome — bottom command dock with a scrubbable
 * timeline, right-side Controls drawer that hosts the dat.GUI panel, and a
 * single corner-anchored Share popover that collapses the four owner-action
 * buttons (Save / Widget / Deploy / Profile) plus Upload + Create. The layout
 * is toggled via body[data-layout='next'] (see app.js _applyViewerLayout).
 *
 * Wiring is direct: clip selection drives viewer.mixer.clipAction() and
 * playback state is read/written on the same AnimationAction the dock
 * exposes. The Controls drawer physically relocates the existing
 * viewer .gui-wrap DOM into a drawer body so dat.GUI continues to drive
 * camera/lighting/material state through its original onChange handlers —
 * no re-implementation, just a presentational reparent.
 *
 * Pulls in three concrete patterns from current best-in-class viewers:
 *   - Sketchfab-style single bottom bar with a real scrubbable timeline
 *   - Babylon-Sandbox-style invisible full-page drag-drop with a tiny
 *     floating gear that opens the controls drawer (Khronos drawer body)
 *   - Google model-viewer-style auto-rotate-on-idle + a hand swipe prompt
 *     that disappears after the first interaction
 */

import { LoopOnce, LoopRepeat } from 'three';

const STORAGE_KEY_INTERACTED = '3dagent:viewer-interacted';
const POLL_INTERVAL_MS = 100;
const POLL_MAX_MS = 15000;

export class NextLayout {
	constructor(app) {
		this.app = app;
		this.viewer = null;
		this.action = null;
		this.clipIdx = -1;
		this.loop = true;
		this.rafId = 0;
		this.driverAttached = false;
		this._guiMoved = false;
		this._idleTimer = 0;
		this._mounted = false;
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
		await this._waitForClips(viewer);
		this._renderClipGrid();
		this._selectClipByIdx(0, { autoplay: false });
		this._attachDriver();
		this._armIdleAutoRotate();
	}

	_waitForViewer() {
		return new Promise((resolve) => {
			const start = Date.now();
			const poll = () => {
				if (this.app.viewer && this.app.viewer.controls) {
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

	_waitForClips(viewer) {
		return new Promise((resolve) => {
			const start = Date.now();
			const poll = () => {
				if (viewer.clips?.length && viewer.mixer) {
					resolve(viewer.clips.slice());
					return;
				}
				if (Date.now() - start > POLL_MAX_MS) {
					resolve([]);
					return;
				}
				setTimeout(poll, POLL_INTERVAL_MS);
			};
			poll();
		});
	}

	// ── animation playback ───────────────────────────────────────────────────

	_renderClipGrid() {
		const grid = this.els.grid;
		if (!grid || !this.viewer?.clips) return;
		grid.innerHTML = '';
		const clips = this.viewer.clips;
		const frag = document.createDocumentFragment();
		clips.forEach((clip, i) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'next-grid__item';
			btn.dataset.idx = String(i);
			btn.setAttribute('role', 'option');
			btn.setAttribute('aria-selected', 'false');
			btn.title = _stripIdx(clip.name);
			const label = document.createElement('span');
			label.className = 'next-grid__label';
			label.textContent = _stripIdx(clip.name);
			btn.appendChild(label);
			btn.addEventListener('click', () => {
				this._selectClipByIdx(i, { autoplay: true });
				this._toggleGrid(false);
			});
			frag.appendChild(btn);
		});
		grid.appendChild(frag);
	}

	_selectClipByIdx(idx, { autoplay }) {
		const viewer = this.viewer;
		if (!viewer?.mixer || !viewer.clips || idx < 0 || idx >= viewer.clips.length) return;
		this._stopAll();
		const clip = viewer.clips[idx];
		const action = viewer.mixer.clipAction(clip);
		action.reset();
		action.enabled = true;
		action.setEffectiveTimeScale(1);
		action.setEffectiveWeight(1);
		this._applyLoop(action);
		if (autoplay) action.play();
		else action.paused = true;
		this.action = action;
		this.clipIdx = idx;
		if (viewer.state?.actionStates) {
			for (const k of Object.keys(viewer.state.actionStates)) {
				viewer.state.actionStates[k] = false;
			}
			viewer.state.actionStates[clip.name] = autoplay;
		}
		this._updateClipName();
		this._updatePlayBtn();
		this._updateScrubAndTime();
		this._updateGridHighlight();
		viewer.invalidate();
	}

	_stopAll() {
		const viewer = this.viewer;
		if (!viewer?.mixer) return;
		viewer.mixer.stopAllAction();
		if (viewer.state?.actionStates) {
			for (const k of Object.keys(viewer.state.actionStates)) viewer.state.actionStates[k] = false;
		}
	}

	_applyLoop(action) {
		action.setLoop(this.loop ? LoopRepeat : LoopOnce, this.loop ? Infinity : 1);
		action.clampWhenFinished = !this.loop;
	}

	_attachDriver() {
		if (this.driverAttached) return;
		this.driverAttached = true;
		const tick = () => {
			this.rafId = requestAnimationFrame(tick);
			this._updateScrubAndTime();
		};
		this.rafId = requestAnimationFrame(tick);
	}

	_updateClipName() {
		if (!this.els.clipName) return;
		const clip = this.viewer?.clips?.[this.clipIdx];
		this.els.clipName.textContent = clip ? _stripIdx(clip.name) : '—';
	}

	_updatePlayBtn() {
		const btn = this.els.playBtn;
		if (!btn) return;
		const playing = Boolean(this.action && !this.action.paused);
		btn.setAttribute('aria-pressed', String(playing));
		btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
		btn.classList.toggle('next-dock__play--playing', playing);
	}

	_updateScrubAndTime() {
		const a = this.action;
		const scrubInput = this.els.scrubInput;
		const scrubFill = this.els.scrubFill;
		const time = this.els.time;
		if (!a) {
			if (scrubInput) scrubInput.value = '0';
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
			const active = Number(btn.dataset.idx) === this.clipIdx;
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
			if (!this.action) return;
			if (this.action.paused) {
				const duration = this.action.getClip().duration || 0;
				// If we're at the end of a one-shot clip, rewind before playing.
				if (!this.loop && duration && this.action.time >= duration - 0.01) {
					this.action.reset();
					this._applyLoop(this.action);
				}
				this.action.paused = false;
				if (!this.action.isRunning()) this.action.play();
			} else {
				this.action.paused = true;
			}
			this._updatePlayBtn();
			this.viewer?.invalidate();
		});

		const scrub = this.els.scrubInput;
		if (scrub) {
			const onScrub = () => {
				if (!this.action) return;
				const duration = this.action.getClip().duration || 0;
				const pct = Number(scrub.value) / 1000;
				this.action.time = Math.max(0, Math.min(duration, pct * duration));
				if (this.action.paused) {
					// Manually advance so the mixer applies the new time even
					// while paused. dt=0 still triggers a pose update.
					this.viewer?.mixer?.update(0);
				}
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
			if (this.action) this._applyLoop(this.action);
		});
	}

	_wireGrid() {
		// Close grid on outside click.
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

		// Wire Save → fire the original button's click handler.
		this.els.shareSave?.addEventListener('click', () => {
			document.getElementById('save-to-account-btn')?.click();
			this._toggleShare(false);
		});

		// Upload → trigger the existing #file-input picker (SimpleDropzone listens to it).
		this.els.shareUpload?.addEventListener('click', () => {
			document.getElementById('file-input')?.click();
			this._toggleShare(false);
		});
	}

	_wireShareItemMirroring() {
		// The original action buttons toggle hidden + update href dynamically
		// based on auth/state. Mirror those changes onto the Share popover's
		// items so they reflect the same set of available actions.
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
		// Reflect available actions count on the corner button (subtle dot).
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
		} else if (this._guiMoved) {
			// Return the dat.GUI panel back to the viewer container so the
			// Classic .gui-toggle keeps working when the user flips back.
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
