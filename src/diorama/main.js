// Diorama — the create-flow controller.
//
// This is the page's only script entry: it imports the renderer, the composer,
// the gallery, and the share sheet, then wires the DOM contract documented in
// pages/diorama.html to all of them. It drives three journeys:
//
//   • Compose  — a sentence → a live plan → meshes forged progressively, each
//                object materializing into the scene as it arrives.
//   • Deep link — ?id=<uuid> loads a saved world read-only and offers a remix.
//   • Save & share — persists a finished world, opens the share sheet, refreshes
//                the gallery, and rewrites the URL to the new permalink.
//
// Every state in the DOM contract (idle / loading / forging / ready / empty /
// error) is designed and reachable; the controller never leaves the UI stuck.

import { createDioramaRenderer } from './renderer.js';
import { mountGallery } from './gallery.js';
import { openShare } from './share.js';
import { composeWorld, forgeObject, CLIENT_ID } from './compose.js';
import {
	forgeProgress,
	isComplete,
	MAX_PROMPT_LEN,
	MOODS,
} from './schema.js';

const MOOD_LABEL = { dawn: 'Dawn', day: 'Daytime', dusk: 'Dusk', night: 'Night' };

document.addEventListener('DOMContentLoaded', init);

function init() {
	const el = collectElements();
	if (!el.stage) return;

	const renderer = createDioramaRenderer(el.stage, {});

	/** Live controller state for the world currently on the stage. */
	const state = {
		diorama: null, // the active diorama (plan → populated)
		controller: null, // AbortController for the in-flight compose
		busy: false, // compose/forge in progress
		readOnly: false, // a deep-linked saved world (no live forging)
	};

	const gallery = mountGallery({
		listEl: el.galleryList,
		emptyEl: el.emptyState,
		onOpen: (id) => openSavedWorld(id, { scroll: true }),
	});
	gallery.reload();

	// ── DOM helpers ──────────────────────────────────────────────────────────

	const show = (node) => node && (node.hidden = false);
	const hide = (node) => node && (node.hidden = true);

	function fadeOutLoader() {
		const loader = el.stageLoader;
		if (!loader || loader.hidden) return;
		loader.classList.add('is-leaving');
		const done = () => {
			loader.hidden = true;
			loader.classList.remove('is-leaving');
		};
		// Honor the CSS transition if there is one; always settle regardless.
		loader.addEventListener('transitionend', done, { once: true });
		setTimeout(done, 600);
	}

	function setHud(diorama) {
		if (!el.hud) return;
		const mood = MOODS.includes(diorama.mood) ? diorama.mood : 'day';
		if (el.hudTitle) el.hudTitle.textContent = diorama.title || 'A little world';
		if (el.hudMeta) {
			const moodLabel = MOOD_LABEL[mood] || mood;
			// A registered creator (diorama.creatorUsername, set server-side only
			// when the world was saved while signed in) gets a real link to their
			// public portfolio. Anonymous saves fall back to the plain-text handle
			// or wallet the composer captured — never a fabricated link.
			if (diorama.creatorUsername) {
				const escUser = String(diorama.creatorUsername).replace(/[&<>"']/g, (c) =>
					({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
				);
				el.hudMeta.textContent = '';
				el.hudMeta.append(document.createTextNode(`${moodLabel} · `));
				const link = document.createElement('a');
				link.href = `/u/${escUser}`;
				link.className = 'hud-author-link';
				link.textContent = `@${escUser}`;
				el.hudMeta.append(link);
			} else {
				const author = diorama.author?.handle
					? `@${diorama.author.handle.replace(/^@/, '')}`
					: diorama.author?.wallet
						? shortWallet(diorama.author.wallet)
						: '';
				el.hudMeta.textContent = [moodLabel, author].filter(Boolean).join(' · ');
			}
		}
		show(el.hud);
	}

	// Build the per-object status chips into #world-objects.
	function renderObjectChips(diorama) {
		if (!el.worldObjects) return;
		el.worldObjects.replaceChildren();
		for (const obj of diorama.objects) {
			el.worldObjects.append(buildChip(obj));
		}
	}

	function buildChip(obj) {
		const li = document.createElement('li');
		li.className = 'dio-object';
		li.dataset.id = obj.id;
		li.dataset.status = obj.status || 'pending';

		const dot = document.createElement('span');
		dot.className = 'dio-object__dot';
		dot.setAttribute('aria-hidden', 'true');

		const label = document.createElement('span');
		label.className = 'dio-object__label';
		label.textContent = obj.label || obj.prompt;

		li.append(dot, label);
		li.setAttribute('role', 'listitem');
		li.setAttribute('aria-label', `${obj.label || obj.prompt}: ${statusWord(obj.status)}`);
		return li;
	}

	function chipFor(id) {
		return el.worldObjects?.querySelector(`.dio-object[data-id="${cssEscape(id)}"]`) || null;
	}

	function setChipStatus(id, status) {
		const chip = chipFor(id);
		if (!chip) return;
		chip.dataset.status = status;
		const obj = state.diorama?.objects.find((o) => o.id === id);
		chip.setAttribute('aria-label', `${obj?.label || 'object'}: ${statusWord(status)}`);
		// Failed objects get an in-place retry affordance; clear it otherwise.
		const existing = chip.querySelector('.dio-object__retry');
		if (status === 'failed') {
			if (!existing) chip.append(buildRetry(id));
		} else if (existing) {
			existing.remove();
		}
	}

	function buildRetry(id) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'dio-object__retry';
		btn.textContent = 'Retry';
		btn.setAttribute('aria-label', 'Retry forging this object');
		btn.addEventListener('click', () => retryObject(id));
		return btn;
	}

	// Live progress bar + "n / total" count, driven by schema's forgeProgress.
	function updateProgress() {
		const d = state.diorama;
		if (!d) return;
		const total = d.objects.length;
		const ready = d.objects.filter((o) => o.status === 'ready').length;
		const settled = d.objects.filter((o) => o.status === 'ready' || o.status === 'failed').length;
		const pct = Math.round(forgeProgress(d) * 100);

		if (el.worldProgress) el.worldProgress.style.width = `${pct}%`;
		if (el.progressBar) el.progressBar.setAttribute('aria-valuenow', String(pct));
		if (el.worldCount) el.worldCount.textContent = `${ready} / ${total}`;

		if (el.statusLabel) {
			if (settled < total) {
				el.statusLabel.textContent = 'Forging your world…';
			} else if (ready === 0) {
				el.statusLabel.textContent = 'Hmm — nothing would forge. Try remixing.';
			} else if (ready < total) {
				el.statusLabel.textContent = `Your world is ready (${ready} of ${total} pieces).`;
			} else {
				el.statusLabel.textContent = 'Your world is ready ✨';
			}
		}
	}

	// ── Compose flow ──────────────────────────────────────────────────────────

	async function startCompose(rawPrompt) {
		const prompt = String(rawPrompt ?? '').slice(0, MAX_PROMPT_LEN).trim();
		if (!prompt) {
			el.input?.focus();
			return;
		}

		// Abort any compose already in flight (the user resubmitted).
		state.controller?.abort();
		const controller = new AbortController();
		state.controller = controller;
		state.busy = true;
		state.readOnly = false;
		state.lastPrompt = prompt;

		setComposeBusy(true);
		hide(el.errorState);
		hide(el.sharePanel);
		hide(el.worldActions);
		clearShareNote();
		show(el.worldStatus);
		if (el.statusLabel) el.statusLabel.textContent = 'Composing your world…';
		if (el.worldProgress) el.worldProgress.style.width = '0%';
		if (el.worldCount) el.worldCount.textContent = '';
		if (el.input) el.input.value = prompt;

		try {
			const diorama = await composeWorld(prompt, {
				signal: controller.signal,
				onPlan: (plan) => {
					if (controller.signal.aborted) return;
					state.diorama = plan;
					renderer.setDiorama(plan);
					fadeOutLoader();
					renderObjectChips(plan);
					setHud(plan);
					updateProgress();
				},
				onObject: (id, patch) => {
					if (controller.signal.aborted) return;
					handleObjectPatch(id, patch);
				},
			});
			if (controller.signal.aborted) return;
			state.diorama = diorama;
			finishWorld();
		} catch (err) {
			if (controller.signal.aborted || err?.name === 'AbortError') return;
			showError(err);
		} finally {
			if (state.controller === controller) {
				state.controller = null;
				state.busy = false;
				setComposeBusy(false);
			}
		}
	}

	// Apply a per-object patch from the composer: forging / ready / failed.
	async function handleObjectPatch(id, patch) {
		const obj = state.diorama?.objects.find((o) => o.id === id);
		if (!obj) return;

		if (patch.status === 'forging') {
			obj.status = 'forging';
			setChipStatus(id, 'forging');
			return;
		}
		if (patch.status === 'ready' && patch.glbUrl) {
			obj.glbUrl = patch.glbUrl;
			// Materialize the mesh into the scene, then flip the chip to ready.
			try {
				await renderer.materializeObject(id, patch.glbUrl);
				obj.status = 'ready';
				setChipStatus(id, 'ready');
			} catch {
				// The mesh forged but couldn't be placed — surface as failed so the
				// user can retry, and keep the renderer's own seed/failure state honest.
				obj.status = 'failed';
				renderer.markFailed(id);
				setChipStatus(id, 'failed');
			}
			updateProgress();
			return;
		}
		// failed (or ready without a url — treat as failed).
		obj.status = 'failed';
		obj.glbUrl = null;
		renderer.markFailed(id);
		setChipStatus(id, 'failed');
		updateProgress();
	}

	// Retry a single failed object in place on the live world.
	async function retryObject(id) {
		const obj = state.diorama?.objects.find((o) => o.id === id);
		if (!obj || state.readOnly) return;
		const chip = chipFor(id);
		const retryBtn = chip?.querySelector('.dio-object__retry');
		if (retryBtn) retryBtn.disabled = true;
		try {
			const result = await forgeObject(obj, {
				onObject: (objId, patch) => handleObjectPatch(objId, patch),
			});
			obj.status = result.status;
			obj.glbUrl = result.glbUrl;
		} catch {
			// AbortError only — the world was torn down; nothing to do.
		} finally {
			finishWorld();
		}
	}

	// Settle the world: final progress, reveal actions, start the auto-orbit.
	function finishWorld() {
		const d = state.diorama;
		if (!d) return;
		updateProgress();

		const anyReady = d.objects.some((o) => o.status === 'ready' && o.glbUrl);
		const allSettled = d.objects.every((o) => o.status === 'ready' || o.status === 'failed');

		if (anyReady) {
			show(el.worldActions);
			renderer.startAutoOrbit(true);
			wireWorldActions();
		}
		if (allSettled && isComplete(d) && el.statusLabel) {
			el.statusLabel.textContent = 'Your world is ready ✨';
		}
	}

	// ── World actions: remix / save / AR / download ────────────────────────────

	function wireWorldActions() {
		const ar = actBtn('ar');
		const dl = actBtn('download');
		const glbUrls = activeGlbUrls();

		// AR + download only make sense once there is at least one real mesh.
		if (glbUrls.length) {
			show(dl);
			if (arSupported()) show(ar);
			else hide(ar);
		} else {
			hide(dl);
			hide(ar);
		}
	}

	function activeGlbUrls() {
		try {
			const urls = renderer.getActiveGlbUrls?.();
			if (Array.isArray(urls) && urls.length) return urls;
		} catch {
			/* fall through to the diorama's own record */
		}
		return (state.diorama?.objects || [])
			.filter((o) => o.status === 'ready' && o.glbUrl)
			.map((o) => o.glbUrl);
	}

	function actBtn(name) {
		return el.worldActions?.querySelector(`[data-act="${name}"]`) || null;
	}

	function onActions(ev) {
		const btn = ev.target.closest('[data-act]');
		if (!btn || !el.worldActions?.contains(btn)) return;
		const act = btn.dataset.act;
		if (act === 'remix') remixWorld();
		else if (act === 'save') saveWorld(btn);
		else if (act === 'ar') openInRoom();
		else if (act === 'download') downloadWorld();
	}

	function remixWorld() {
		const prompt = state.diorama?.prompt || state.lastPrompt || el.input?.value;
		if (prompt) startCompose(prompt);
	}

	function downloadWorld() {
		const url = activeGlbUrls()[0];
		if (!url) return;
		const a = document.createElement('a');
		a.href = url;
		a.download = `${slug(state.diorama?.title || 'diorama')}.glb`;
		a.rel = 'noopener';
		document.body.append(a);
		a.click();
		a.remove();
	}

	// "View in your room": hand the first active mesh to a hidden <model-viewer>
	// with AR enabled (model-viewer is already loaded on the page), then trigger
	// its native AR session — mirrors the /forge AR handoff.
	function openInRoom() {
		const url = activeGlbUrls()[0];
		if (!url || !arSupported()) return;
		const mv = ensureArViewer();
		const launch = () => {
			try {
				mv.activateAR?.();
			} catch {
				/* the device declined the AR session; nothing to recover */
			}
		};
		if (mv.getAttribute('src') === url && mv.loaded) {
			launch();
			return;
		}
		mv.setAttribute('src', url);
		mv.setAttribute('alt', `3D model: ${state.diorama?.title || 'your world'}`);
		mv.addEventListener('load', launch, { once: true });
	}

	// ── Save & share ───────────────────────────────────────────────────────────

	async function saveWorld(btn) {
		const d = state.diorama;
		if (!d) return;
		btn.setAttribute('aria-busy', 'true');
		btn.disabled = true;
		clearShareNote();
		try {
			const res = await fetch('/api/diorama', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'save', diorama: d, clientKey: CLIENT_ID }),
			});
			const data = await res.json().catch(() => ({}));

			if (res.status === 503 && data.error === 'sharing_unavailable') {
				showShareNote(
					data.message || 'Sharing is not enabled on this deployment, but your world is fully yours to explore and download.',
				);
				return;
			}
			if (!res.ok || !data.id || !data.url) {
				showShareNote(data.message || 'Could not save this world. Try again in a moment.', true);
				return;
			}

			d.id = data.id;
			d.createdAt = data.createdAt || d.createdAt;
			openShare({ diorama: d, url: data.url });
			show(el.sharePanel);
			try {
				history.replaceState(null, '', `?id=${encodeURIComponent(data.id)}`);
			} catch {
				/* replaceState can throw in sandboxed frames — non-fatal */
			}
			gallery.reload();
		} catch (err) {
			const offline = err instanceof TypeError;
			showShareNote(
				offline
					? 'Could not reach the server to save. Check your connection and try again.'
					: 'Could not save this world. Try again in a moment.',
				true,
			);
		} finally {
			btn.removeAttribute('aria-busy');
			btn.disabled = false;
		}
	}

	// An inline note in the share region for the "sharing off" / save-error states
	// — keeps the world fully usable while explaining what happened.
	function showShareNote(message, isError = false) {
		clearShareNote();
		const note = document.createElement('p');
		note.className = 'dio-share__note';
		if (isError) note.dataset.error = 'true';
		note.setAttribute('role', 'status');
		note.textContent = message;
		note.dataset.dioNote = 'true';
		(el.sharePanel?.parentElement || el.worldActions?.parentElement || el.stage).append(note);
		show(el.sharePanel?.parentElement ? el.sharePanel : note);
	}

	function clearShareNote() {
		for (const n of document.querySelectorAll('[data-dio-note="true"]')) n.remove();
	}

	// ── Deep link: load a saved world read-only ───────────────────────────────

	async function openSavedWorld(id, { scroll = false } = {}) {
		if (!id) return;
		state.controller?.abort();
		state.busy = true;
		state.readOnly = true;
		hide(el.errorState);
		hide(el.worldActions);
		hide(el.sharePanel);
		clearShareNote();
		show(el.worldStatus);
		if (el.statusLabel) el.statusLabel.textContent = 'Loading this world…';
		if (scroll) el.stage.scrollIntoView({ behavior: 'smooth', block: 'center' });

		try {
			const res = await fetch(`/api/diorama?id=${encodeURIComponent(id)}`);
			const data = await res.json().catch(() => ({}));
			if (res.status === 404) {
				showError(
					Object.assign(new Error('That world has wandered off. It may have been removed.'), {
						code: 'not_found',
						deadLink: true,
					}),
				);
				return;
			}
			if (!res.ok || !data.diorama) {
				showError(new Error(data.message || 'Could not load that world. Try again.'));
				return;
			}

			const diorama = data.diorama;
			state.diorama = diorama;
			renderer.setDiorama(diorama);
			fadeOutLoader();
			renderObjectChips(diorama);
			setHud(diorama);

			// Materialize every already-forged object; mark the rest failed.
			for (const obj of diorama.objects) {
				if (obj.status === 'ready' && obj.glbUrl) {
					setChipStatus(obj.id, 'forging');
					try {
						await renderer.materializeObject(obj.id, obj.glbUrl);
						setChipStatus(obj.id, 'ready');
					} catch {
						obj.status = 'failed';
						renderer.markFailed(obj.id);
						setChipStatus(obj.id, 'failed');
					}
				} else {
					setChipStatus(obj.id, 'failed');
				}
			}
			updateProgress();
			if (el.statusLabel) el.statusLabel.textContent = `“${diorama.title}” — spoken into being`;

			renderer.startAutoOrbit(true);
			showRemixAffordance(diorama);
			gallery.reload();
		} catch (err) {
			showError(
				err instanceof TypeError
					? new Error('Could not reach the server. Check your connection and try again.')
					: err,
			);
		} finally {
			state.busy = false;
			state.readOnly = true;
		}
	}

	// A saved world is read-only; surface a "Remix this world" action that prefills
	// the composer with its prompt and lets the visitor spin their own version.
	function showRemixAffordance(diorama) {
		show(el.worldActions);
		// In read-only mode, only remix / AR / download apply; hide save.
		hide(actBtn('save'));
		const glbUrls = activeGlbUrls();
		const dl = actBtn('download');
		const ar = actBtn('ar');
		if (glbUrls.length) {
			show(dl);
			if (arSupported()) show(ar);
			else hide(ar);
		} else {
			hide(dl);
			hide(ar);
		}
		const remix = actBtn('remix');
		if (remix) {
			remix.textContent = '↻ Remix this world';
			if (el.input) el.input.value = diorama.prompt || '';
			state.lastPrompt = diorama.prompt || '';
		}
	}

	// ── Error state ────────────────────────────────────────────────────────────

	function showError(err) {
		hide(el.worldStatus);
		hide(el.worldActions);
		if (el.errorBody) {
			el.errorBody.textContent =
				err?.message || 'Something went wrong building that world. Try again.';
		}
		// Dead deep links get a "back to Diorama" path; everything else retries.
		if (el.retryBtn) {
			if (err?.deadLink) {
				el.retryBtn.textContent = 'Start a new world';
			} else {
				el.retryBtn.textContent = 'Try again';
			}
		}
		show(el.errorState);
		el.errorState.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	function onRetry() {
		hide(el.errorState);
		// A dead deep link clears the URL and returns to a clean composer.
		if (el.retryBtn?.textContent?.startsWith('Start')) {
			try {
				history.replaceState(null, '', location.pathname);
			} catch {
				/* non-fatal */
			}
			el.input?.focus();
			return;
		}
		const prompt = state.lastPrompt || el.input?.value;
		if (prompt) startCompose(prompt);
		else el.input?.focus();
	}

	// ── AR support / hidden viewer ─────────────────────────────────────────────

	function arSupported() {
		// model-viewer reports per-device AR capability via canActivateAR once the
		// custom element is defined; before then, allow it on mobile so the button
		// is offered where AR is most likely. Desktops simply won't activate.
		const mv = arViewer;
		if (mv && typeof mv.canActivateAR === 'boolean') return mv.canActivateAR;
		return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
	}

	let arViewer = null;
	function ensureArViewer() {
		if (arViewer) return arViewer;
		const mv = document.createElement('model-viewer');
		mv.setAttribute('ar', '');
		mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
		mv.setAttribute('camera-controls', '');
		mv.setAttribute('reveal', 'manual');
		mv.style.position = 'fixed';
		mv.style.width = '1px';
		mv.style.height = '1px';
		mv.style.left = '-9999px';
		mv.style.opacity = '0';
		mv.style.pointerEvents = 'none';
		document.body.append(mv);
		arViewer = mv;
		return mv;
	}

	// ── Compose form / examples wiring ─────────────────────────────────────────

	function setComposeBusy(busy) {
		if (!el.submit) return;
		el.submit.setAttribute('aria-busy', busy ? 'true' : 'false');
		el.submit.disabled = busy;
		if (el.input) el.input.toggleAttribute('aria-busy', busy);
	}

	el.form?.addEventListener('submit', (ev) => {
		ev.preventDefault();
		startCompose(el.input?.value);
	});

	el.examples?.addEventListener('click', (ev) => {
		const btn = ev.target.closest('button[data-prompt]');
		if (!btn) return;
		const prompt = btn.dataset.prompt || '';
		if (el.input) el.input.value = prompt;
		startCompose(prompt);
	});

	el.worldActions?.addEventListener('click', onActions);
	el.retryBtn?.addEventListener('click', onRetry);

	// ── Resize + lifecycle ─────────────────────────────────────────────────────

	const onResize = debounce(() => renderer.resize(), 150);
	window.addEventListener('resize', onResize);

	window.addEventListener(
		'pagehide',
		() => {
			state.controller?.abort();
			window.removeEventListener('resize', onResize);
			renderer.dispose();
		},
		{ once: true },
	);

	// ── Boot: deep link or idle composer ───────────────────────────────────────

	const deepId = new URLSearchParams(location.search).get('id');
	if (deepId) {
		openSavedWorld(deepId, { scroll: false });
	} else {
		// Idle: the stage loader stands, the composer waits, the gallery loads.
		el.input?.focus({ preventScroll: true });
	}
}

// ── Element lookup ────────────────────────────────────────────────────────────

function collectElements() {
	const $ = (id) => document.getElementById(id);
	const stage = $('diorama-stage');
	const hud = $('stage-hud');
	const worldStatus = $('world-status');
	const worldActions = $('world-actions');
	const errorState = $('error-state');
	return {
		stage,
		stageLoader: $('stage-loader'),
		hud,
		hudTitle: hud?.querySelector('.dio-hud__title') || null,
		hudMeta: hud?.querySelector('.dio-hud__meta') || null,
		form: $('compose-form'),
		input: $('compose-input'),
		submit: $('compose-submit'),
		examples: $('compose-examples'),
		worldStatus,
		statusLabel: worldStatus?.querySelector('.dio-status__label') || null,
		worldProgress: $('world-progress'),
		progressBar: worldStatus?.querySelector('.dio-progress') || null,
		worldCount: worldStatus?.querySelector('[data-count]') || null,
		worldObjects: $('world-objects'),
		worldActions,
		sharePanel: $('share-panel'),
		errorState,
		errorBody: errorState?.querySelector('.dio-error__body') || null,
		retryBtn: errorState?.querySelector('[data-act="retry"]') || null,
		galleryList: $('gallery-list'),
		emptyState: $('empty-state'),
	};
}

// ── Small utilities ────────────────────────────────────────────────────────────

function statusWord(status) {
	switch (status) {
		case 'ready':
			return 'forged';
		case 'forging':
			return 'forging';
		case 'failed':
			return 'failed to forge';
		default:
			return 'waiting';
	}
}

function shortWallet(w) {
	const s = String(w);
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function slug(s) {
	return (
		String(s)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'diorama'
	);
}

function cssEscape(value) {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
	return String(value).replace(/["\\]/g, '\\$&');
}

function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}
