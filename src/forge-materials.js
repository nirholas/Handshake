// Forge — Material restyle panel (browser client).
//
// Re-skins the current model's PBR materials without touching its geometry:
// "make it chrome", "wooden", "cyberpunk neon" — a free-text instruction goes
// to POST /api/material-studio?action=restyle, which has IBM Granite propose
// PBR factors and re-exports the GLB server-side. Same backing endpoint the
// paid `restyle_material` MCP tool calls, so results here are the exact same
// pipeline agents get. Synchronous (no poll loop needed).
//
// Self-contained: builds its own button + panel off `forge:model-ready`, same
// pattern as forge-stylize.js and forge-rig.js.

const PRESET_CHIPS = [
	{ label: 'Chrome', instruction: 'make it polished chrome' },
	{ label: 'Brushed gold', instruction: 'make it brushed gold metal' },
	{ label: 'Weathered wood', instruction: 'make it weathered natural wood' },
	{ label: 'Cyberpunk neon', instruction: 'make it glossy black with cyberpunk neon accent trim' },
	{ label: 'Marble', instruction: 'make it polished white marble' },
	{ label: 'Rusted metal', instruction: 'make it rusted, worn metal' },
];

const actions = document.querySelector('#state-result .result-bar .actions');
const resultBar = document.getElementById('state-result');
const viewer = document.getElementById('viewer');

if (actions && resultBar && viewer) {
	injectStyles();

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'btn btn-ghost';
	btn.id = 'forge-materials-btn';
	btn.setAttribute('aria-expanded', 'false');
	btn.title = 'Restyle this model’s materials (AI PBR re-skin, keeps the same shape)';
	btn.innerHTML = `
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M12 19l7-7 3 3-7 7-3-3z" />
			<path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
			<path d="M2 2l7.586 7.586" />
			<circle cx="11" cy="11" r="2" />
		</svg>
		Restyle materials`;

	const rigBtn = document.getElementById('forge-rig-btn');
	const arBtn = document.getElementById('forge-irl-btn') || document.getElementById('forge-ar-btn');
	const anchorAfter = rigBtn || arBtn;
	if (anchorAfter && anchorAfter.parentNode === actions) {
		anchorAfter.after(btn);
	} else {
		actions.appendChild(btn);
	}

	const panel = document.createElement('div');
	panel.className = 'materials-panel is-hidden';
	panel.id = 'materials-panel';
	panel.innerHTML = `
		<div class="materials-head">
			<h3>Restyle materials</h3>
			<p class="materials-sub">Keeps the same mesh, re-skins the surface. Pick a preset or describe your own.</p>
		</div>
		<div class="materials-chips" id="materials-chips" role="group" aria-label="Material presets"></div>
		<form class="materials-form" id="materials-form">
			<input
				type="text"
				id="materials-instruction"
				maxlength="300"
				placeholder="Describe a material, e.g. &quot;make it iridescent soap-bubble glass&quot;"
				aria-label="Describe a material"
			/>
			<button type="submit" class="btn" id="materials-apply">Apply</button>
		</form>
		<div class="materials-actions is-hidden" id="materials-result-actions">
			<a class="btn btn-ghost" id="materials-download" download>Download restyled GLB</a>
			<button type="button" class="btn btn-ghost" id="materials-revert">Revert to original</button>
		</div>
		<div class="materials-status" id="materials-status" role="status" aria-live="polite"></div>
	`;
	resultBar.after(panel);

	const chipsHost = panel.querySelector('#materials-chips');
	for (const p of PRESET_CHIPS) {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'materials-chip';
		chip.textContent = p.label;
		chip.addEventListener('click', () => {
			panel.querySelector('#materials-instruction').value = p.instruction;
			runRestyle(p.instruction);
		});
		chipsHost.appendChild(chip);
	}

	const form = panel.querySelector('#materials-form');
	const input = panel.querySelector('#materials-instruction');
	const status = panel.querySelector('#materials-status');
	const resultActions = panel.querySelector('#materials-result-actions');
	const downloadLink = panel.querySelector('#materials-download');
	const revertBtn = panel.querySelector('#materials-revert');
	const applyBtn = panel.querySelector('#materials-apply');

	let originalGlbUrl = '';
	let originalLabel = '';
	let lastRestyledUrl = '';
	let busy = false;

	function setStatus(text, kind = '') {
		status.textContent = text || '';
		status.dataset.kind = kind;
	}

	function setBusy(next) {
		busy = next;
		applyBtn.disabled = next;
		input.disabled = next;
		for (const chip of chipsHost.querySelectorAll('.materials-chip')) chip.disabled = next;
	}

	async function runRestyle(instruction) {
		const text = (instruction || '').trim();
		if (!text || busy || !originalGlbUrl) return;
		setBusy(true);
		setStatus('Restyling materials…', 'busy');
		try {
			const res = await fetch('/api/material-studio?action=restyle', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ glb_url: lastRestyledUrl || originalGlbUrl, instruction: text }),
			});
			const data = await res.json().catch(() => ({}));
			if (res.status === 429) {
				const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 10;
				setStatus(`Restyle is busy right now. Try again in about ${secs}s.`, 'error');
				return;
			}
			if (!res.ok || !data.glbUrl) {
				setStatus(data.message || `Restyle failed (${res.status}). Try a shorter, clearer description.`, 'error');
				return;
			}
			lastRestyledUrl = data.glbUrl;
			viewer.setAttribute('src', data.glbUrl);
			viewer.setAttribute('alt', `${originalLabel} — restyled: ${text}`);
			const safeLabel = (originalLabel || 'forge').replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/^-|-$/g, '') || 'forge';
			downloadLink.href = data.glbUrl;
			downloadLink.setAttribute('download', `${safeLabel}-restyled.glb`);
			resultActions.classList.remove('is-hidden');
			setStatus(`Applied: "${text}". Try another description, or revert.`, 'done');
		} catch {
			setStatus('Network hiccup — the model is unchanged. Try again.', 'error');
		} finally {
			setBusy(false);
		}
	}

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		runRestyle(input.value);
	});

	revertBtn.addEventListener('click', () => {
		lastRestyledUrl = '';
		viewer.setAttribute('src', originalGlbUrl);
		viewer.setAttribute('alt', originalLabel || '3D model');
		resultActions.classList.add('is-hidden');
		setStatus('Showing the original materials.', '');
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
		lastRestyledUrl = '';
		resultActions.classList.add('is-hidden');
		setStatus('', '');
		input.value = '';
		panel.classList.add('is-hidden');
		btn.setAttribute('aria-expanded', 'false');
	}

	document.addEventListener('forge:model-ready', (e) => {
		onNewSource(e.detail?.glbUrl, e.detail?.label);
	});

	const srcObserver = new MutationObserver(() => {
		const url = viewer.getAttribute('src');
		if (!url || url === originalGlbUrl || url === lastRestyledUrl) return;
		onNewSource(url, document.getElementById('result-label')?.textContent?.trim() || '');
	});
	srcObserver.observe(viewer, { attributes: true, attributeFilter: ['src'] });

	if (viewer.getAttribute('src')) {
		onNewSource(viewer.getAttribute('src'), document.getElementById('result-label')?.textContent?.trim() || '');
	}
}

function injectStyles() {
	if (document.getElementById('forge-materials-styles')) return;
	const style = document.createElement('style');
	style.id = 'forge-materials-styles';
	style.textContent = `
		.materials-panel {
			margin: 0 var(--space-md, 1rem) var(--space-md, 1rem);
			padding: 0.9rem 1rem;
			border: 1px solid var(--stroke);
			border-radius: var(--radius-sm, 8px);
			background: var(--surface, rgba(255,255,255,0.03));
		}
		.materials-panel.is-hidden { display: none; }
		.materials-head h3 { margin: 0 0 0.15rem; font-size: var(--text-md, 1rem); }
		.materials-sub { margin: 0 0 0.7rem; font-size: var(--text-sm, 0.85rem); color: var(--ink-dim); }
		.materials-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.7rem; }
		.materials-chip {
			padding: 0.35rem 0.7rem;
			border: 1px solid var(--stroke);
			border-radius: 999px;
			background: transparent;
			color: var(--ink);
			font-size: var(--text-xs, 0.78rem);
			cursor: pointer;
		}
		.materials-chip:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
		.materials-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
		.materials-chip:disabled { opacity: 0.5; cursor: progress; }
		.materials-form { display: flex; gap: 0.5rem; }
		.materials-form input {
			flex: 1;
			padding: 0.5rem 0.7rem;
			border: 1px solid var(--stroke);
			border-radius: var(--radius-sm, 8px);
			background: transparent;
			color: var(--ink);
			font-size: var(--text-sm, 0.85rem);
		}
		.materials-form input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
		.materials-actions { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
		.materials-status { margin-top: 0.5rem; font-size: var(--text-xs, 0.8rem); color: var(--ink-dim); min-height: 1em; }
		.materials-status[data-kind='error'] { color: var(--danger); }
		.materials-status[data-kind='done'] { color: var(--success); }
	`;
	document.head.appendChild(style);
}
