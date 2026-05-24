/**
 * app-next overlay — UX preview layer for /app-next demo.
 *
 * Boots after /src/app.js (the real production viewer + agent system) and
 * adds the new UX surface:
 *   1. Stage polish — transparent canvas so the CSS floor-glow shows through.
 *   2. Camera idle drift — gentle auto-rotate that pauses on interaction.
 *   3. "Try X" rotating invitation pill (driven by the real animation manifest).
 *   4. Compact animation picker sheet with search + grid (replaces the strip).
 *   5. Single-hierarchy action bar: Animations, Upload, Save / Sign-in.
 *   6. Header menus (explore + auth) with open/close + outside-click dismiss.
 *   7. Keyboard shortcuts: A (animations), U (upload), Esc (close sheet).
 *   8. First-visit hint shown once per browser.
 *
 * This file deliberately does NOT touch any other surface — same /src/app.js
 * bootstraps the viewer, same animation manifest, same auth APIs.
 */

import { getMe, readAuthHint, saveRemoteGlbToAccount } from './account.js';

const STORAGE_HINT_KEY = 'nxt:first-hint-dismissed';
const TRY_ROTATE_MS = 8000;

// Curated subset for the rotating "Try X" prompt — these clips look great as
// 2-second teasers and crossfade cleanly back to idle. Names match the entries
// in /public/animations/manifest.json.
const TRY_PICKS = [
	{ name: 'av-waving', icon: '👋', label: 'Wave' },
	{ name: 'av-superhero-jump', icon: '🦸', label: 'Superhero jump' },
	{ name: 'boxer-dance', icon: '🥊', label: 'Boxer dance' },
	{ name: 'av-brag-and-clap', icon: '👏', label: 'Brag & clap' },
	{ name: 'facepalm', icon: '🤦', label: 'Facepalm' },
	{ name: 'av-flex-arm', icon: '💪', label: 'Flex' },
	{ name: 'covereyes', icon: '🙈', label: 'Cover eyes' },
	{ name: 'av-walk-crouching', icon: '🚶', label: 'Sneak walk' },
];

// Animation defs ship with an `icon` field that's usually right, but a few
// common ones are missing or have wrong glyphs — patch them here so the grid
// always reads cleanly. Fallback chain: icon override → manifest icon → ✨.
const ICON_OVERRIDES = {
	idle: '🧍',
	lookdown: '👀',
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

document.addEventListener('DOMContentLoaded', boot);

function boot() {
	console.info('[nxt] boot');
	wireExploreMenu();
	wireUserMenu();
	wireFirstHint();
	wireKeyboardShortcuts();
	wirePrimaryCTA();
	wireAnimationSheet();

	// The viewer is created asynchronously by App. Poll briefly until it's
	// ready, then attach stage polish + start the Try pill rotation.
	waitForViewer().then((viewer) => {
		if (!viewer) {
			console.warn('[nxt] viewer never appeared — stage polish skipped');
			return;
		}
		console.info('[nxt] viewer ready');
		polishStage(viewer);
		startTryPillRotation(viewer);
		startCameraDrift(viewer);
	});

	// Auth state can resolve before or after viewer; refresh CTA when ready.
	refreshAuthState();
	// Refresh once more when other tabs sign in/out.
	window.addEventListener('storage', (e) => {
		if (e.key === 'nxt-auth-touch' || e.key?.startsWith('auth')) refreshAuthState();
	});
}

// ── Viewer wait ───────────────────────────────────────────────────────────

function waitForViewer(timeoutMs = 15000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			const v = window.VIEWER?.viewer;
			if (v && v.scene && v.renderer && v.controls) return resolve(v);
			if (Date.now() - started > timeoutMs) return resolve(null);
			setTimeout(tick, 120);
		};
		tick();
	});
}

// ── Stage polish ──────────────────────────────────────────────────────────

function polishStage(viewer) {
	// Make the canvas transparent so the CSS radial floor-glow + vignette
	// (rendered behind via the same stacking context) show through. The viewer
	// owns its own transparentBg state — flipping it directly survives any
	// subsequent updateBackground() call (saved scene prefs, brand sync, etc).
	try {
		viewer.state.transparentBg = true;
		viewer.updateBackground();
	} catch (err) {
		console.warn('[nxt] could not set transparent canvas', err);
	}
}

// ── Camera idle drift ─────────────────────────────────────────────────────

function startCameraDrift(viewer) {
	if (!viewer.controls) return;

	let userInteracted = false;
	let resumeTimer = null;

	const enableDrift = () => {
		// Mirror viewer.state so updateDisplay() doesn't undo us later.
		viewer.state.autoRotate = true;
		viewer.controls.autoRotate = true;
		viewer.controls.autoRotateSpeed = 0.35; // very slow — alive, not spinning
		viewer.invalidate?.();
	};

	const pauseDrift = () => {
		viewer.state.autoRotate = false;
		viewer.controls.autoRotate = false;
		userInteracted = true;
		clearTimeout(resumeTimer);
		// Resume after 10s of no interaction
		resumeTimer = setTimeout(() => {
			if (userInteracted) {
				userInteracted = false;
				enableDrift();
			}
		}, 10000);
	};

	enableDrift();
	viewer.controls.addEventListener('start', pauseDrift);
}

// ── Try pill ──────────────────────────────────────────────────────────────

function startTryPillRotation(viewer) {
	const pill = document.getElementById('nxt-try-pill');
	const iconEl = document.getElementById('nxt-try-pill-icon');
	const nameEl = document.getElementById('nxt-try-pill-name');
	const btn = document.getElementById('nxt-try-pill-btn');
	const nextBtn = document.getElementById('nxt-try-pill-next');
	if (!pill || !btn) return;

	let order = TRY_PICKS.slice();
	let cursor = Math.floor(Math.random() * order.length);
	let intervalId = null;

	const render = () => {
		const pick = order[cursor % order.length];
		iconEl.textContent = pick.icon;
		nameEl.textContent = pick.label;
		pill.dataset.clip = pick.name;
	};

	const advance = () => {
		cursor = (cursor + 1) % order.length;
		render();
	};

	// Wait until at least one clip is loadable before showing the pill.
	pollForClips(viewer).then((defs) => {
		console.info('[nxt] pollForClips resolved, defs=', defs?.length || 0);
		// Filter picks down to clips that exist in this avatar's manifest.
		const available = new Set(getAvailableClipNames(viewer));
		if (available.size > 0) {
			order = TRY_PICKS.filter((p) => available.has(p.name));
			if (order.length === 0) order = TRY_PICKS.slice(); // fall back
		}
		console.info('[nxt] try pill picks count=', order.length);
		cursor = Math.floor(Math.random() * order.length);
		render();
		pill.hidden = false;
		intervalId = setInterval(advance, TRY_ROTATE_MS);
	});

	btn.addEventListener('click', () => {
		const pick = order[cursor % order.length];
		playClip(viewer, pick.name);
		// Pause rotation after explicit try — let the user enjoy what they picked
		clearInterval(intervalId);
		intervalId = null;
		// Resume after 12s if no further interaction
		setTimeout(() => {
			if (!intervalId) intervalId = setInterval(advance, TRY_ROTATE_MS);
		}, 12000);
	});

	nextBtn.addEventListener('click', advance);
}

function pollForClips(viewer, timeoutMs = 12000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			const defs = viewer.animationManager?.getAnimationDefs?.() || [];
			if (defs.length > 0) return resolve(defs);
			if (Date.now() - started > timeoutMs) return resolve([]);
			setTimeout(tick, 300);
		};
		tick();
	});
}

function getAvailableClipNames(viewer) {
	const defs = viewer.animationManager?.getAnimationDefs?.() || [];
	return defs.map((d) => d.name);
}

function playClip(viewer, name) {
	const mgr = viewer.animationManager;
	if (!mgr) return;

	const defs = mgr.getAnimationDefs();
	const def = defs.find((d) => d.name === name);
	if (!def) return;

	// ensureLoaded fetches the JSON clip if not yet cached, then play() runs it.
	mgr.ensureLoaded(name)
		.then(() => mgr.play(name))
		.catch((err) => console.warn('[app-next] clip play failed', name, err));
}

// ── Animation sheet ───────────────────────────────────────────────────────

function wireAnimationSheet() {
	const btn = document.getElementById('nxt-anim-btn');
	const sheet = document.getElementById('nxt-anim-sheet');
	const closeBtn = document.getElementById('nxt-anim-sheet-close');
	const search = document.getElementById('nxt-anim-search');
	const grid = document.getElementById('nxt-anim-grid');
	if (!btn || !sheet || !grid) return;

	let rendered = false;

	const open = () => {
		sheet.hidden = false;
		sheet.setAttribute('aria-hidden', 'false');
		btn.setAttribute('aria-expanded', 'true');
		if (!rendered) {
			renderGrid().then(() => {
				rendered = true;
			});
		}
		setTimeout(() => search?.focus(), 60);
	};

	const close = () => {
		sheet.hidden = true;
		sheet.setAttribute('aria-hidden', 'true');
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', () => {
		if (sheet.hidden) open();
		else close();
	});

	closeBtn?.addEventListener('click', close);

	// Esc closes; outside click closes.
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !sheet.hidden) close();
	});

	document.addEventListener('pointerdown', (e) => {
		if (sheet.hidden) return;
		if (sheet.contains(e.target) || btn.contains(e.target)) return;
		close();
	});

	search?.addEventListener('input', filterGrid);

	async function renderGrid() {
		const viewer = await waitForViewer();
		if (!viewer) {
			grid.innerHTML =
				'<div class="nxt-anim-empty">Viewer not ready — reload to try again.</div>';
			return;
		}
		await pollForClips(viewer);
		const defs = viewer.animationManager.getAnimationDefs();
		if (!defs || defs.length === 0) {
			grid.innerHTML =
				'<div class="nxt-anim-empty">This avatar has no animations.</div>';
			return;
		}

		grid.innerHTML = '';
		const activeName = viewer.animationManager.currentName;
		for (const def of defs) {
			const card = document.createElement('button');
			card.type = 'button';
			card.className = 'nxt-anim-card';
			card.dataset.name = def.name;
			card.setAttribute('aria-pressed', activeName === def.name ? 'true' : 'false');
			const icon = ICON_OVERRIDES[def.name] || def.icon || '✨';
			const label = def.label || prettify(def.name);
			card.innerHTML =
				`<span class="nxt-anim-card__icon">${escHtml(icon)}</span>` +
				`<span>${escHtml(label)}</span>`;
			card.addEventListener('click', () => {
				playClip(viewer, def.name);
				// Sync aria-pressed across all cards
				grid.querySelectorAll('.nxt-anim-card').forEach((c) => {
					c.setAttribute('aria-pressed', c.dataset.name === def.name ? 'true' : 'false');
				});
			});
			grid.appendChild(card);
		}

		// Keep card pressed-state in sync when clip changes from elsewhere
		// (try-pill, keyboard shortcut, programmatic). Chain through any prior
		// onChange handler so we don't clobber a subscriber the production
		// viewer (or another overlay) may have installed.
		const prevOnChange = viewer.animationManager.onChange;
		viewer.animationManager.onChange = (...args) => {
			try { prevOnChange?.(...args); } catch (e) { console.warn('[nxt] prior onChange threw', e); }
			const current = viewer.animationManager.currentName;
			grid.querySelectorAll('.nxt-anim-card').forEach((c) => {
				c.setAttribute('aria-pressed', c.dataset.name === current ? 'true' : 'false');
			});
		};
	}

	function filterGrid() {
		const q = (search?.value || '').trim().toLowerCase();
		const cards = grid.querySelectorAll('.nxt-anim-card');
		let visible = 0;
		cards.forEach((c) => {
			const hay = (c.textContent + ' ' + c.dataset.name).toLowerCase();
			const match = !q || hay.includes(q);
			c.style.display = match ? '' : 'none';
			if (match) visible++;
		});
		// Remove any prior "no matches" hint
		grid.querySelectorAll('.nxt-anim-empty[data-search]').forEach((n) => n.remove());
		if (visible === 0) {
			const empty = document.createElement('div');
			empty.className = 'nxt-anim-empty';
			empty.dataset.search = '1';
			empty.textContent = `No clips matching "${q}".`;
			grid.appendChild(empty);
		}
	}
}

// ── Header menus ──────────────────────────────────────────────────────────

function wireExploreMenu() {
	const btn = document.getElementById('nxt-more-btn');
	const menu = document.getElementById('nxt-more-menu');
	if (!btn || !menu) return;

	const close = () => {
		menu.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (menu.hidden) {
			menu.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
		} else {
			close();
		}
	});

	document.addEventListener('pointerdown', (e) => {
		if (menu.hidden) return;
		if (menu.contains(e.target) || btn.contains(e.target)) return;
		close();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !menu.hidden) close();
	});
}

function wireUserMenu() {
	const btn = document.getElementById('nav-user-btn');
	const menu = document.getElementById('nav-user-menu');
	if (!btn || !menu) return;

	const close = () => {
		menu.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (menu.hidden) {
			menu.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
		} else {
			close();
		}
	});

	document.addEventListener('pointerdown', (e) => {
		if (menu.hidden) return;
		if (menu.contains(e.target) || btn.contains(e.target)) return;
		close();
	});
}

// ── Auth state + primary CTA ──────────────────────────────────────────────

async function refreshAuthState() {
	const signinEl = document.getElementById('nav-sign-in');
	const userWrap = document.getElementById('nav-user-wrap');
	const userLabel = document.getElementById('nav-user-label');
	const profileLink = document.getElementById('nav-my-profile-link');
	const primary = document.getElementById('nxt-primary');
	const primaryLabel = document.getElementById('nxt-primary-label');

	// readAuthHint is a synchronous local-storage lookup — useful for the first
	// paint before getMe() resolves. We always confirm with the real API.
	const hint = readAuthHint?.();
	if (hint?.username && userLabel) {
		userLabel.textContent = hint.username;
	}

	let me = null;
	try {
		me = await getMe();
	} catch {
		me = null;
	}

	if (me?.username) {
		if (signinEl) signinEl.hidden = true;
		if (userWrap) userWrap.hidden = false;
		if (userLabel) userLabel.textContent = me.username;
		if (profileLink) profileLink.href = `/profile/${encodeURIComponent(me.username)}`;
		if (primaryLabel) primaryLabel.textContent = 'Save to account';
		if (primary) primary.dataset.mode = 'save';
	} else {
		if (signinEl) signinEl.hidden = false;
		if (userWrap) userWrap.hidden = true;
		if (primaryLabel) primaryLabel.textContent = 'Sign in to save';
		if (primary) primary.dataset.mode = 'signin';
	}
}

function wirePrimaryCTA() {
	const primary = document.getElementById('nxt-primary');
	const primaryLabel = document.getElementById('nxt-primary-label');
	if (!primary) return;

	// Held outside the closure so a rapid second save can clear the prior
	// "Saved ✓ → Save to account" revert before it fires.
	let revertTimer = null;

	primary.addEventListener('click', async () => {
		const mode = primary.dataset.mode || 'signin';
		if (mode !== 'save') {
			location.href = '/login?return=' + encodeURIComponent(location.pathname);
			return;
		}

		// Save the current model to the signed-in user's account.
		const viewer = window.VIEWER?.viewer;
		const app = window.VIEWER?.app;
		const url = app?._currentModelUrl;
		if (!viewer || !url) {
			toast('Nothing to save yet — load a model first.');
			return;
		}

		const original = 'Save to account';
		if (revertTimer) {
			clearTimeout(revertTimer);
			revertTimer = null;
		}
		if (primaryLabel) primaryLabel.textContent = 'Saving…';
		primary.disabled = true;
		try {
			const res = await saveRemoteGlbToAccount(url, {
				name: app?._currentModelName || 'Avatar',
			});
			if (res?.ok && res.id) {
				if (primaryLabel) primaryLabel.textContent = 'Saved ✓';
				toast(`Saved to your account.`, `/avatars/${res.id}`);
			} else {
				throw new Error(res?.error || 'save failed');
			}
		} catch (err) {
			console.warn('[app-next] save failed', err);
			if (primaryLabel) primaryLabel.textContent = original;
			toast('Save failed — try again.');
		} finally {
			revertTimer = setTimeout(() => {
				revertTimer = null;
				if (primaryLabel && primaryLabel.textContent === 'Saved ✓') {
					primaryLabel.textContent = original;
				}
				primary.disabled = false;
			}, 2400);
		}
	});
}

function toast(message, href) {
	const el = document.createElement('div');
	el.className = 'save-toast';
	el.style.zIndex = 9999;
	el.innerHTML = href
		? `${escHtml(message)} <a href="${escHtml(href)}">View →</a>`
		: escHtml(message);
	document.body.appendChild(el);
	setTimeout(() => el.remove(), 4200);
}

// ── First-visit hint ──────────────────────────────────────────────────────

function wireFirstHint() {
	const hint = document.getElementById('nxt-first-hint');
	const close = document.getElementById('nxt-first-hint-close');
	if (!hint || !close) return;
	try {
		if (localStorage.getItem(STORAGE_HINT_KEY) === '1') return;
	} catch {}
	hint.hidden = false;
	const dismiss = () => {
		hint.hidden = true;
		try {
			localStorage.setItem(STORAGE_HINT_KEY, '1');
		} catch {}
	};
	close.addEventListener('click', dismiss);
	setTimeout(dismiss, 14000);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

function wireKeyboardShortcuts() {
	document.addEventListener('keydown', (e) => {
		if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === 'a' || e.key === 'A') {
			e.preventDefault();
			document.getElementById('nxt-anim-btn')?.click();
		} else if (e.key === 'u' || e.key === 'U') {
			e.preventDefault();
			document.getElementById('file-input')?.click();
		}
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	})[ch]);
}

function prettify(name) {
	return String(name)
		.replace(/^av-/, '')
		.replace(/[-_]/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
