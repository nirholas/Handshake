// Forge — Conversational iteration (browser client).
//
// "Make the helmet red", "add a cape", "give it bigger ears" — a free-text
// instruction against the model on screen, via POST /api/forge-iterate. That
// endpoint shares its core (composeRefinement + version lineage) with the
// MCP `refine_model` tool, so this is the exact same free iteration path
// agents get, wired to the plain /forge page (previously Studio-only).
//
// Distinct from:
//   - #refine (forge.js)      → re-runs the SAME prompt at a HIGHER quality tier
//   - #refine-locally / forge-refine.js → local deterministic geometry ops
//     (weld/smooth/decimate), no network call
//   - forge-stylize.js        → geometric filters (voxel/brick/voronoi)
//   - forge-materials.js      → PBR material re-skin only
// This module is the only one that changes the SHAPE of the model based on a
// natural-language instruction.
//
// Self-contained: builds its own button + panel off `forge:model-ready`, and
// forwards the same x-forge-client identity forge.js uses so an iteration
// lands in the same anonymous gallery/lineage as its parent.

const POLL_INTERVAL_MS = 2500;
const MAX_POLL_MS = 5 * 60 * 1000;

const actions = document.querySelector('#state-result .result-bar .actions');
const resultBar = document.getElementById('state-result');
const viewer = document.getElementById('viewer');

if (actions && resultBar && viewer) {
	injectStyles();

	const CLIENT_ID = (() => {
		const KEY = 'forge:cid';
		try {
			let id = localStorage.getItem(KEY);
			if (!id) {
				id =
					crypto?.randomUUID?.() ||
					`c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
				localStorage.setItem(KEY, id);
			}
			return id;
		} catch {
			return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		}
	})();

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'btn btn-ghost';
	btn.id = 'forge-iterate-btn';
	btn.setAttribute('aria-expanded', 'false');
	btn.title = 'Describe a change to iterate on this exact model ("make it metallic", "add a hat")';
	btn.innerHTML = `
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		</svg>
		Iterate`;

	const materialsBtn = document.getElementById('forge-materials-btn');
	const rigBtn = document.getElementById('forge-rig-btn');
	const anchorAfter = materialsBtn || rigBtn || document.getElementById('forge-ar-btn');
	if (anchorAfter && anchorAfter.parentNode === actions) {
		anchorAfter.after(btn);
	} else {
		actions.appendChild(btn);
	}

	const panel = document.createElement('div');
	panel.className = 'iterate-panel is-hidden';
	panel.id = 'iterate-panel';
	panel.innerHTML = `
		<div class="iterate-head">
			<h3>Iterate on this model</h3>
			<p class="iterate-sub">Describe a change. Each iteration is a new version you can keep going from — nothing overwrites the model you have now.</p>
		</div>
		<div class="iterate-lineage is-hidden" id="iterate-lineage" role="group" aria-label="Version history"></div>
		<form class="iterate-form" id="iterate-form">
			<input
				type="text"
				id="iterate-instruction"
				maxlength="300"
				placeholder="e.g. &quot;make the helmet red&quot;, &quot;add a small backpack&quot;"
				aria-label="Describe a change"
			/>
			<button type="submit" class="btn" id="iterate-apply">Iterate</button>
		</form>
		<div class="iterate-status" id="iterate-status" role="status" aria-live="polite"></div>
	`;
	resultBar.after(panel);

	const form = panel.querySelector('#iterate-form');
	const input = panel.querySelector('#iterate-instruction');
	const status = panel.querySelector('#iterate-status');
	const applyBtn = panel.querySelector('#iterate-apply');
	const lineageHost = panel.querySelector('#iterate-lineage');

	let originalGlbUrl = '';
	let originalLabel = '';
	let originalPrompt = '';
	let currentGlbUrl = '';
	let lineage = null; // [{glbUrl, instruction?, ...}] from the last response
	let activeIndex = -1;
	let busy = false;
	let runToken = 0;

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	function setStatus(text, kind = '') {
		status.textContent = text || '';
		status.dataset.kind = kind;
	}

	function setBusy(next) {
		busy = next;
		applyBtn.disabled = next;
		input.disabled = next;
	}

	function renderLineage() {
		if (!Array.isArray(lineage) || lineage.length < 2) {
			lineageHost.classList.add('is-hidden');
			lineageHost.innerHTML = '';
			return;
		}
		lineageHost.classList.remove('is-hidden');
		lineageHost.innerHTML = lineage
			.map((v, i) => {
				const label = i === 0 ? 'Original' : v.instruction || `v${i + 1}`;
				return `<button type="button" class="iterate-version${i === activeIndex ? ' is-active' : ''}" data-index="${i}" title="${label}">${i === 0 ? 'v0' : `v${i}`}</button>`;
			})
			.join('');
		lineageHost.querySelectorAll('.iterate-version').forEach((b) => {
			b.addEventListener('click', () => jumpTo(Number(b.dataset.index)));
		});
	}

	function jumpTo(index) {
		if (!Array.isArray(lineage) || !lineage[index]) return;
		activeIndex = index;
		const v = lineage[index];
		currentGlbUrl = v.glbUrl;
		viewer.setAttribute('src', v.glbUrl);
		viewer.setAttribute('alt', `${originalLabel} — ${index === 0 ? 'original' : v.instruction}`);
		renderLineage();
		setStatus(index === 0 ? 'Showing the original.' : `Showing: "${v.instruction}"`, '');
	}

	async function runIterate(instruction) {
		const text = (instruction || '').trim();
		if (!text || busy || !currentGlbUrl) return;
		const token = ++runToken;
		setBusy(true);
		setStatus('Iterating…', 'busy');
		try {
			const res = await fetch('/api/forge-iterate', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forge-client': CLIENT_ID },
				body: JSON.stringify({
					glb_url: currentGlbUrl,
					instruction: text,
					parent_prompt: originalPrompt || originalLabel,
					parent_lineage: Array.isArray(lineage) ? lineage : undefined,
					parent_index: activeIndex >= 0 ? activeIndex : undefined,
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (token !== runToken) return;
			if (res.status === 429) {
				const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 15;
				setStatus(`Iteration is busy right now. Try again in about ${secs}s.`, 'error');
				return;
			}
			if (!res.ok || !data.glbUrl) {
				setStatus(data.message || `Iteration failed (${res.status}). Try a smaller, clearer change.`, 'error');
				return;
			}
			currentGlbUrl = data.glbUrl;
			lineage = Array.isArray(data.lineage) ? data.lineage : lineage;
			activeIndex = Number.isInteger(data.activeIndex) ? data.activeIndex : (lineage?.length || 1) - 1;
			viewer.setAttribute('src', data.glbUrl);
			viewer.setAttribute('alt', `${originalLabel} — ${text}`);
			renderLineage();
			input.value = '';
			setStatus(`Applied: "${text}". Keep iterating, or jump back to an earlier version above.`, 'done');
		} catch {
			if (token !== runToken) return;
			setStatus('Network hiccup — the model is unchanged. Try again.', 'error');
		} finally {
			if (token === runToken) setBusy(false);
		}
	}

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		runIterate(input.value);
	});

	btn.addEventListener('click', () => {
		const willShow = panel.classList.contains('is-hidden');
		panel.classList.toggle('is-hidden', !willShow);
		btn.setAttribute('aria-expanded', String(willShow));
		if (willShow) input.focus();
	});

	function onNewSource(glbUrl, label) {
		if (!glbUrl || glbUrl === originalGlbUrl) return;
		originalGlbUrl = glbUrl;
		originalLabel = label || '';
		originalPrompt = label || '';
		currentGlbUrl = glbUrl;
		lineage = null;
		activeIndex = -1;
		runToken++;
		setStatus('', '');
		input.value = '';
		renderLineage();
		panel.classList.add('is-hidden');
		btn.setAttribute('aria-expanded', 'false');
		setBusy(false);
	}

	document.addEventListener('forge:model-ready', (e) => {
		onNewSource(e.detail?.glbUrl, e.detail?.label);
	});

	// Ignore our own lineage-jump / iterate swaps; only a genuinely new source
	// model (fresh generation, gallery open) should reset the panel.
	const srcObserver = new MutationObserver(() => {
		const url = viewer.getAttribute('src');
		if (!url || url === originalGlbUrl || url === currentGlbUrl) return;
		if (Array.isArray(lineage) && lineage.some((v) => v.glbUrl === url)) return;
		onNewSource(url, document.getElementById('result-label')?.textContent?.trim() || '');
	});
	srcObserver.observe(viewer, { attributes: true, attributeFilter: ['src'] });

	if (viewer.getAttribute('src')) {
		onNewSource(viewer.getAttribute('src'), document.getElementById('result-label')?.textContent?.trim() || '');
	}
}

function injectStyles() {
	if (document.getElementById('forge-iterate-styles')) return;
	const style = document.createElement('style');
	style.id = 'forge-iterate-styles';
	style.textContent = `
		.iterate-panel {
			margin: 0 var(--space-md, 1rem) var(--space-md, 1rem);
			padding: 0.9rem 1rem;
			border: 1px solid var(--stroke);
			border-radius: var(--radius-sm, 8px);
			background: var(--surface, rgba(255,255,255,0.03));
		}
		.iterate-panel.is-hidden { display: none; }
		.iterate-head h3 { margin: 0 0 0.15rem; font-size: var(--text-md, 1rem); }
		.iterate-sub { margin: 0 0 0.7rem; font-size: var(--text-sm, 0.85rem); color: var(--ink-dim); }
		.iterate-lineage { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.7rem; }
		.iterate-lineage.is-hidden { display: none; }
		.iterate-version {
			padding: 0.25rem 0.6rem;
			border: 1px solid var(--stroke);
			border-radius: 999px;
			background: transparent;
			color: var(--ink-dim);
			font-size: var(--text-xs, 0.75rem);
			cursor: pointer;
		}
		.iterate-version.is-active { border-color: var(--accent); color: var(--accent); }
		.iterate-version:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
		.iterate-form { display: flex; gap: 0.5rem; }
		.iterate-form input {
			flex: 1;
			padding: 0.5rem 0.7rem;
			border: 1px solid var(--stroke);
			border-radius: var(--radius-sm, 8px);
			background: transparent;
			color: var(--ink);
			font-size: var(--text-sm, 0.85rem);
		}
		.iterate-form input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
		.iterate-status { margin-top: 0.5rem; font-size: var(--text-xs, 0.8rem); color: var(--ink-dim); min-height: 1em; }
		.iterate-status[data-kind='error'] { color: var(--danger); }
		.iterate-status[data-kind='done'] { color: var(--success); }
	`;
	document.head.appendChild(style);
}
