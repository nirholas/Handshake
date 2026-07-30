/**
 * Side-by-side compare for two forge generations.
 *
 * The forge can produce the same prompt on several different engines, and the
 * only honest way to tell whether "TRELLIS or Hunyuan3D?" matters for a given
 * subject is to look at both meshes at the same camera angle. This module adds
 * that: a compare mode over the "Your creations" gallery, a two-pane viewer,
 * and synced camera orbit so a difference in shape reads as a difference in
 * shape rather than a difference in framing.
 *
 * It owns no data. `forge.js` hands it the creation rows it already fetched
 * from /api/forge-gallery, and hands back a click when a card is picked while
 * compare mode is active. Nothing here fabricates a model, a label, or an
 * engine name: a row with no `glb_url` is never offered for comparison.
 */

/**
 * Normalise a prompt for grouping.
 *
 * Two generations count as "the same prompt" when the text matches after case
 * and whitespace are ignored. This is deliberately strict: a near-match is a
 * different prompt, and claiming otherwise would make the engine comparison
 * dishonest.
 */
function promptKey(text) {
	return String(text || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

/**
 * Find prompts that appear on two or more DIFFERENT engines.
 *
 * Two runs of one prompt on one engine is a re-roll, which is worth looking at
 * but is not the engine comparison this feature is for, so the hint only fires
 * on a genuine A/B.
 */
export function findComparablePrompts(creations) {
	const groups = new Map();
	for (const c of creations) {
		if (!c?.glb_url || !c?.prompt) continue;
		const key = promptKey(c.prompt);
		if (!key) continue;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(c);
	}
	const out = [];
	for (const [key, rows] of groups) {
		const engines = new Set(rows.map((r) => r.backend).filter(Boolean));
		if (rows.length >= 2 && engines.size >= 2) out.push({ key, rows });
	}
	return out;
}

export function createCompare({ engineLabel }) {
	const els = {
		toggle: document.getElementById('compare-toggle'),
		hint: document.getElementById('compare-hint'),
		grid: document.getElementById('creations-grid'),
		tray: document.getElementById('compare-tray'),
		trayLabel: document.getElementById('compare-tray-label'),
		clear: document.getElementById('compare-clear'),
		open: document.getElementById('compare-open'),
		modal: document.getElementById('compare-modal'),
		modalClose: document.getElementById('compare-close'),
		panes: document.getElementById('compare-panes'),
		modalPrompt: document.getElementById('compare-prompt'),
		sync: document.getElementById('compare-sync'),
	};

	// Without the markup (an older cached page, or a trimmed build) every entry
	// point below turns into a no-op rather than throwing into the gallery.
	if (!els.toggle || !els.grid || !els.modal) {
		return { setCreations() {}, isActive: () => false, handleCardClick: () => false };
	}

	let active = false;
	let picked = [];
	let rows = [];
	let lastFocused = null;
	const viewers = [];

	const label = (c) =>
		[engineLabel?.(c.backend) || c.backend || 'Unknown engine', c.tier].filter(Boolean).join(' · ');

	function syncTray() {
		els.trayLabel.textContent =
			picked.length === 0
				? 'Pick two models to compare'
				: picked.length === 1
					? 'Pick one more'
					: `${label(picked[0])} vs ${label(picked[1])}`;
		els.open.disabled = picked.length !== 2;
	}

	function paintCards() {
		for (const card of els.grid.querySelectorAll('.creation')) {
			const id = card.dataset.creationId;
			const idx = picked.findIndex((p) => String(p.id) === String(id));
			card.querySelector('.pick')?.remove();
			if (active) {
				card.setAttribute('aria-pressed', String(idx >= 0));
			} else {
				card.removeAttribute('aria-pressed');
			}
			if (idx >= 0) {
				const badge = document.createElement('span');
				badge.className = 'pick';
				badge.textContent = String(idx + 1);
				card.appendChild(badge);
			}
		}
	}

	function setActive(next) {
		active = next;
		els.toggle.setAttribute('aria-pressed', String(active));
		els.grid.classList.toggle('is-comparing', active);
		els.tray.classList.toggle('is-hidden', !active);
		if (!active) picked = [];
		syncTray();
		paintCards();
	}

	/**
	 * Keep both viewers on one camera ANGLE so only the geometry differs.
	 *
	 * Only theta and phi are shared. Radius is deliberately not: model-viewer
	 * frames each model at its own distance, and two generations of one prompt
	 * routinely differ in scale, so copying an absolute radius across would zoom
	 * one model into its own interior. Each pane keeps the distance that frames
	 * it, and turns in lockstep with the other.
	 */
	function wireSync() {
		let echo = false;
		for (const viewer of viewers) {
			viewer.addEventListener('camera-change', () => {
				if (echo || !els.sync?.checked) return;
				const orbit = viewer.getCameraOrbit?.();
				if (!orbit) return;
				echo = true;
				for (const other of viewers) {
					if (other === viewer) continue;
					const own = other.getCameraOrbit?.();
					const radius = own ? own.radius : orbit.radius;
					other.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${radius}m`;
				}
				// Release on the next frame: the orbit we just wrote fires its own
				// camera-change on each peer, and those must not bounce back.
				requestAnimationFrame(() => {
					echo = false;
				});
			});
		}
	}

	function closeModal() {
		els.modal.classList.add('is-hidden');
		els.panes.innerHTML = '';
		viewers.length = 0;
		document.removeEventListener('keydown', onKeydown);
		lastFocused?.focus?.();
	}

	function onKeydown(e) {
		if (e.key === 'Escape') closeModal();
	}

	function openModal() {
		if (picked.length !== 2) return;
		lastFocused = document.activeElement;
		els.panes.innerHTML = '';
		viewers.length = 0;

		const samePrompt = promptKey(picked[0].prompt) === promptKey(picked[1].prompt);
		els.modalPrompt.textContent = samePrompt
			? picked[0].prompt || ''
			: `Different prompts: "${picked[0].prompt || 'untitled'}" vs "${picked[1].prompt || 'untitled'}"`;

		for (const c of picked) {
			const pane = document.createElement('div');
			pane.className = 'compare-pane';

			const viewer = document.createElement('model-viewer');
			viewer.setAttribute('src', c.glb_url);
			viewer.setAttribute('alt', `3D model: ${c.prompt || 'forged model'}`);
			viewer.setAttribute('camera-controls', '');
			viewer.setAttribute('touch-action', 'pan-y');
			viewer.setAttribute('shadow-intensity', '1');
			viewer.setAttribute('exposure', '1');
			pane.appendChild(viewer);
			viewers.push(viewer);

			const meta = document.createElement('div');
			meta.className = 'compare-pane-meta';
			const engine = document.createElement('span');
			engine.className = 'compare-pane-engine';
			engine.textContent = label(c);
			const sub = document.createElement('span');
			sub.className = 'compare-pane-sub';
			sub.textContent = [
				c.path === 'geometry' ? 'geometry-first' : c.path === 'sketch' ? 'sketch to 3D' : 'image path',
				Number(c.views_used) > 1 ? `${c.views_used} views` : null,
			]
				.filter(Boolean)
				.join(' · ');
			meta.append(engine, sub);
			pane.appendChild(meta);

			els.panes.appendChild(pane);
		}

		wireSync();
		els.modal.classList.remove('is-hidden');
		document.addEventListener('keydown', onKeydown);
		els.modalClose.focus();
	}

	els.toggle.addEventListener('click', () => setActive(!active));
	els.clear.addEventListener('click', () => {
		picked = [];
		syncTray();
		paintCards();
	});
	els.open.addEventListener('click', openModal);
	els.modalClose.addEventListener('click', closeModal);
	els.modal.addEventListener('click', (e) => {
		if (e.target === els.modal) closeModal();
	});

	return {
		isActive: () => active,

		/**
		 * Called by the gallery on every card click. Returns true when compare
		 * mode consumed the click, so the caller knows not to open the viewer.
		 */
		handleCardClick(creation) {
			if (!active) return false;
			if (!creation?.glb_url) return true;
			const at = picked.findIndex((p) => String(p.id) === String(creation.id));
			if (at >= 0) picked.splice(at, 1);
			else if (picked.length < 2) picked.push(creation);
			else picked = [picked[1], creation];
			syncTray();
			paintCards();
			return true;
		},

		/** Refresh after the gallery reloads: offer compare only when it is possible. */
		setCreations(list) {
			rows = Array.isArray(list) ? list.filter((c) => c?.glb_url) : [];
			const possible = rows.length >= 2;
			els.toggle.classList.toggle('is-hidden', !possible);
			if (!possible && active) setActive(false);

			const comparable = findComparablePrompts(rows);
			if (comparable.length > 0) {
				const engines = new Set(comparable[0].rows.map((r) => r.backend).filter(Boolean));
				els.hint.textContent = `You forged "${comparable[0].rows[0].prompt}" on ${engines.size} engines. Compare them side by side.`;
				els.hint.classList.remove('is-hidden');
			} else {
				els.hint.classList.add('is-hidden');
			}
			// Drop selections whose rows are gone after a reload.
			picked = picked.filter((p) => rows.some((r) => String(r.id) === String(p.id)));
			syncTray();
			paintCards();
		},
	};
}
