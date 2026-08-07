// Game-Ready export — the one-click engine-ready output for the forge result
// view. Layered onto the live model (forge.js dispatches `forge:model-ready`),
// it drives the real /api/forge-gameready route to retopologize the current mesh
// to a poly budget and deliver a textured GLB + an FBX for Unity/Unreal in one
// job.
//
//   • Quad — field-aligned QuadriFlow retopology: clean edge loops that deform
//            well for rigging & animation.
//   • Tri  — silhouette-preserving low-poly with the source texture re-unwrapped
//            and re-baked onto the new mesh.
//
// The panel proves its value the way game devs screenshot it: the before→after
// poly delta and a live wireframe of the retopologized mesh. Nothing fakes
// progress — it polls the job; the wireframe is the real returned GLB.
//
// Charging: the export runs the remesh GPU worker (real cost), so it's a $THREE
// holder perk with a one-time pay-per-export path — the same hold-or-pay model as
// High-tier generation. A verified holder exports free; a non-holder is offered the
// designed $THREE pay modal and the export retries with the settled proof. The
// price is whatever the server gate quotes — never hardcoded here.

import { payForConsumption } from './forge-pay.js';
import { attachTierPass, getAccess, getTierPass } from '../three-access.js';

const resultPanel = document.getElementById('state-result');
const viewer = document.getElementById('viewer');
const viewerShell = document.getElementById('viewer-shell');
const triggerBtn = document.getElementById('forge-gameready-btn');

if (resultPanel && viewer && triggerBtn) {
	const POLL_MS = 2500;
	const MAX_MS = 8 * 60 * 1000; // quad/lowpoly bakes can take a couple of minutes

	// Reuse the forge anonymous client id (set by forge.js) for rate-limit
	// fairness; harmless if absent.
	const CLIENT_HEADERS = (() => {
		try {
			const id = localStorage.getItem('forge:cid');
			return id ? { 'x-forge-client': id } : {};
		} catch {
			return {};
		}
	})();

	const PRESETS = [
		[5_000, '5k', 'mobile'],
		[15_000, '15k', 'standard'],
		[50_000, '50k', 'hero'],
	];
	const SLIDER_MIN = 1_000;
	const SLIDER_MAX = 200_000;

	const TOPO_HINTS = {
		quad: 'Field-aligned QuadriFlow retopology — clean quad-dominant edge loops that deform well for rigging & animation.',
		tri: 'Silhouette-preserving low-poly. UVs are re-unwrapped and the original texture re-baked onto the new mesh for real-time engines.',
	};

	// ── Styles ─────────────────────────────────────────────────────────────────
	if (!document.getElementById('forge-gameready-styles')) {
		const style = document.createElement('style');
		style.id = 'forge-gameready-styles';
		style.textContent = `
			.gameready { border-top: 1px solid var(--stroke); display: none; flex-direction: column; gap: var(--space-md); padding: var(--space-md); }
			.gameready[data-open='true'] { display: flex; }
			.gr-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-sm); }
			.gr-head h3 { font-family: var(--font-display); font-size: var(--text-md); font-weight: 700; margin: 0; }
			.gr-sub { font-size: var(--text-xs); color: var(--ink-dim); line-height: 1.5; margin: 0; max-width: 60ch; }
			.gr-field { display: flex; flex-direction: column; gap: 0.45rem; }
			.gr-field > span.gr-label { font-size: var(--text-xs); color: var(--ink-dim); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.04em; }
			.gr-seg { display: inline-flex; gap: 2px; background: var(--surface-1); border: 1px solid var(--stroke); border-radius: var(--radius-md); padding: 2px; }
			.gr-seg button { flex: 1 1 auto; background: transparent; border: none; color: var(--ink-dim); font-family: var(--font-mono); font-size: var(--text-xs); padding: 0.45rem 0.9rem; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s, color 0.15s; }
			.gr-seg button:hover { color: var(--ink); }
			.gr-seg button[aria-pressed='true'] { background: var(--surface-3); color: var(--ink); }
			.gr-seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
			.gr-topo-hint { font-size: var(--text-xs); color: var(--ink-dim); line-height: 1.4; min-height: 1.4em; margin: 0; }
			.gr-budget-row { display: flex; align-items: center; gap: var(--space-md); flex-wrap: wrap; }
			.gr-budget-row input[type='range'] { flex: 1 1 200px; accent-color: var(--accent); cursor: pointer; min-width: 160px; }
			.gr-budget-row input[type='range']:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
			.gr-budget-val { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--ink); font-weight: 600; min-width: 7ch; text-align: right; }
			.gr-presets { display: inline-flex; gap: 2px; background: var(--surface-1); border: 1px solid var(--stroke); border-radius: var(--radius-md); padding: 2px; }
			.gr-presets button { background: transparent; border: none; color: var(--ink-dim); font-family: var(--font-mono); font-size: var(--text-xs); padding: 0.35rem 0.6rem; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s, color 0.15s; }
			.gr-presets button:hover { color: var(--ink); }
			.gr-presets button[aria-pressed='true'] { background: var(--surface-3); color: var(--ink); }
			.gr-presets button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
			.gr-row { display: flex; gap: var(--space-md); flex-wrap: wrap; }
			.gr-row .gr-field { flex: 1 1 150px; }
			.gr-select { background: var(--surface-1); border: 1px solid var(--stroke); border-radius: var(--radius-md); color: var(--ink); font-family: var(--font-mono); font-size: var(--text-xs); padding: 0.45rem 0.6rem; }
			.gr-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
			.gr-formats { display: flex; gap: var(--space-md); flex-wrap: wrap; }
			.gr-check { display: inline-flex; align-items: center; gap: 0.45rem; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink); cursor: pointer; }
			.gr-check input { accent-color: var(--accent); width: 1rem; height: 1rem; cursor: pointer; }
			.gr-check input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
			.gr-rig { font-size: var(--text-xs); color: var(--ink-dim); line-height: 1.4; margin: 0; padding-left: 1.45rem; }
			.gr-rig.is-hidden { display: none; }
			.gr-actions { display: flex; align-items: center; gap: var(--space-md); flex-wrap: wrap; }
			.gr-status { font-size: var(--text-xs); font-family: var(--font-mono); color: var(--ink-dim); }
			.gr-status[data-kind='error'] { color: var(--danger); }
			.gr-status[data-kind='done'] { color: var(--success); }
			.gr-pay-note { font-size: var(--text-xs); color: var(--ink-dim); line-height: 1.4; margin: 0; }
			.gr-pay-note a { color: var(--accent); text-decoration: none; }
			.gr-pay-note a:hover { text-decoration: underline; }
			.gr-pay-note a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
			.gr-skeleton { display: none; height: 4px; border-radius: 2px; overflow: hidden; background: var(--surface-1); position: relative; }
			.gameready[data-busy='true'] .gr-skeleton { display: block; }
			.gr-skeleton::after { content: ''; position: absolute; inset: 0; width: 40%; border-radius: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: gr-sweep 1.1s ease-in-out infinite; }
			@keyframes gr-sweep { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
			.gr-delta { display: none; flex-wrap: wrap; align-items: center; gap: 0.5rem; font-family: var(--font-mono); font-size: var(--text-sm); }
			.gr-delta.is-shown { display: flex; }
			.gr-delta .gr-from { color: var(--ink-dim); }
			.gr-delta .gr-arrow { color: var(--ink-dim); }
			.gr-delta .gr-to { color: var(--ink); font-weight: 700; }
			.gr-delta .gr-tag { font-size: var(--text-xs); color: var(--ink-dim); border: 1px solid var(--stroke); border-radius: var(--radius-sm); padding: 0.1rem 0.45rem; }
			.gr-downloads { display: none; gap: var(--space-sm); flex-wrap: wrap; }
			.gr-downloads.is-shown { display: flex; }
			.gr-wire-toggle { margin-left: auto; }
			.gr-wire-toggle[aria-pressed='true'] { background: var(--surface-3); color: var(--ink); }
			.gr-wire-overlay { position: absolute; inset: 0; z-index: 4; display: none; background: var(--surface-0, #0b0b10); }
			.gr-wire-overlay.is-shown { display: block; }
			.gr-wire-overlay canvas { width: 100% !important; height: 100% !important; display: block; }
			.gr-wire-badge { position: absolute; top: 10px; left: 10px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-dim); background: color-mix(in srgb, var(--surface-1) 80%, transparent); border: 1px solid var(--stroke); border-radius: var(--radius-sm); padding: 0.2rem 0.5rem; pointer-events: none; }
		`;
		document.head.appendChild(style);
	}

	// ── DOM ──────────────────────────────────────────────────────────────────
	const panel = document.createElement('section');
	panel.className = 'gameready';
	panel.dataset.open = 'false';
	panel.dataset.busy = 'false';
	panel.setAttribute('aria-label', 'Game-Ready export');
	panel.innerHTML = `
		<div class="gr-head">
			<h3>Game-Ready export</h3>
		</div>
		<p class="gr-sub">Retopologize this model to a poly budget and export an engine-ready asset — a textured GLB plus an FBX for Unity &amp; Unreal — in one click.</p>
		<div class="gr-field">
			<span class="gr-label">Topology</span>
			<div class="gr-seg gr-topo" role="group" aria-label="Topology">
				<button type="button" data-topo="quad" aria-pressed="true">Quad retopo</button>
				<button type="button" data-topo="tri" aria-pressed="false">Tri low-poly</button>
			</div>
			<p class="gr-topo-hint"></p>
		</div>
		<div class="gr-field">
			<span class="gr-label">Poly budget — <span class="gr-budget-unit">target faces</span></span>
			<div class="gr-budget-row">
				<input class="gr-budget" type="range" min="${SLIDER_MIN}" max="${SLIDER_MAX}" step="1000" value="15000"
					aria-label="Poly budget (target faces)" />
				<span class="gr-budget-val" aria-live="polite">15k</span>
				<div class="gr-presets" role="group" aria-label="Poly budget presets">
					${PRESETS.map(
						([v, short, tag]) =>
							`<button type="button" data-budget="${v}" aria-pressed="false" title="${tag}">${short}</button>`,
					).join('')}
				</div>
			</div>
		</div>
		<div class="gr-row">
			<label class="gr-field">
				<span class="gr-label">Texture</span>
				<select class="gr-select gr-texsize">
					<option value="1024" selected>1024px</option>
					<option value="2048">2048px</option>
				</select>
			</label>
			<div class="gr-field">
				<span class="gr-label">Formats</span>
				<div class="gr-formats">
					<label class="gr-check"><input type="checkbox" class="gr-fmt" value="glb" checked /> GLB (preview)</label>
					<label class="gr-check"><input type="checkbox" class="gr-fmt" value="fbx" checked /> FBX</label>
				</div>
			</div>
		</div>
		<label class="gr-check gr-rig-toggle"><input type="checkbox" class="gr-rig-check" /> Preserve rig on FBX</label>
		<p class="gr-rig is-hidden">Retopology rebuilds geometry, so a retopologized FBX is a clean re-riggable mesh. Tick this only if your source is skinned and you need the existing skeleton kept — the FBX is then exported at the original topology.</p>
		<div class="gr-actions">
			<button class="btn gr-run" type="button"><span class="gr-run-label">Export game-ready</span></button>
			<button class="btn btn-ghost gr-wire-toggle" type="button" aria-pressed="false" hidden title="Show the retopologized wireframe">Wireframe</button>
			<span class="gr-status" role="status" aria-live="polite"></span>
		</div>
		<p class="gr-pay-note">$THREE holders export free — others pay once per export in $THREE. <a href="/three-token">Hold $THREE →</a></p>
		<div class="gr-skeleton" aria-hidden="true"></div>
		<div class="gr-delta" aria-live="polite"></div>
		<div class="gr-downloads"></div>
	`;
	resultPanel.appendChild(panel);

	// Wireframe overlay lives inside the viewer shell, above the model-viewer.
	const wireOverlay = document.createElement('div');
	wireOverlay.className = 'gr-wire-overlay';
	wireOverlay.innerHTML = `<span class="gr-wire-badge">Retopology wireframe</span>`;
	(viewerShell || viewer.parentElement)?.appendChild(wireOverlay);

	const topoGroup = panel.querySelector('.gr-topo');
	const topoHint = panel.querySelector('.gr-topo-hint');
	const budgetSlider = panel.querySelector('.gr-budget');
	const budgetVal = panel.querySelector('.gr-budget-val');
	const presetGroup = panel.querySelector('.gr-presets');
	const texsizeSel = panel.querySelector('.gr-texsize');
	const fmtChecks = [...panel.querySelectorAll('.gr-fmt')];
	const rigToggle = panel.querySelector('.gr-rig-toggle');
	const rigCheck = panel.querySelector('.gr-rig-check');
	const rigHint = panel.querySelector('.gr-rig');
	const runBtn = panel.querySelector('.gr-run');
	const runLabel = panel.querySelector('.gr-run-label');
	const wireBtn = panel.querySelector('.gr-wire-toggle');
	const statusEl = panel.querySelector('.gr-status');
	const deltaEl = panel.querySelector('.gr-delta');
	const downloadsEl = panel.querySelector('.gr-downloads');
	const payNote = panel.querySelector('.gr-pay-note');

	const state = {
		glbUrl: null,
		label: 'model',
		topology: 'quad',
		sourceFaces: null,
		running: false,
		pollAbort: false,
		previewUrl: null, // retopologized GLB used by the wireframe preview
		access: null, // last resolved forge.gameready access payload
	};

	// ── Helpers ────────────────────────────────────────────────────────────────
	function fmtCount(n) {
		if (!Number.isFinite(n)) return '—';
		if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
		return n.toLocaleString();
	}

	function setStatus(text, kind) {
		statusEl.textContent = text || '';
		if (kind) statusEl.dataset.kind = kind;
		else statusEl.removeAttribute('data-kind');
	}

	function setRunning(running) {
		state.running = running;
		runBtn.disabled = running;
		panel.dataset.busy = String(running);
		runLabel.textContent = running ? 'Exporting…' : 'Export game-ready';
	}

	function selectedFormats() {
		return fmtChecks.filter((c) => c.checked).map((c) => c.value);
	}

	function syncRigVisibility() {
		const fbx = fmtChecks.find((c) => c.value === 'fbx')?.checked;
		rigToggle.style.display = fbx ? 'inline-flex' : 'none';
		rigHint.classList.toggle('is-hidden', !(fbx && rigCheck.checked));
	}

	function snapPresets(value) {
		for (const b of presetGroup.querySelectorAll('button')) {
			b.setAttribute('aria-pressed', String(Number(b.dataset.budget) === value));
		}
	}

	function setBudget(value, { snap = true } = {}) {
		const v = Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, Math.round(value / 1000) * 1000));
		budgetSlider.value = String(v);
		budgetVal.textContent = fmtCount(v);
		if (snap) snapPresets(v);
	}

	// Default the budget to a fraction of the model's current size — a real
	// reduction target, not a fixed number — snapped to the nearest preset.
	function defaultBudgetFor(sourceFaces) {
		if (!Number.isFinite(sourceFaces) || sourceFaces <= 0) return 15_000;
		const target = Math.round(sourceFaces * 0.3);
		let nearest = PRESETS[0][0];
		let best = Infinity;
		for (const [v] of PRESETS) {
			const d = Math.abs(v - target);
			if (d < best) {
				best = d;
				nearest = v;
			}
		}
		// Never propose a budget above the source — that would add, not reduce.
		return Math.min(nearest, Math.max(SLIDER_MIN, Math.round(sourceFaces)));
	}

	function applyTopology(topo) {
		state.topology = topo;
		for (const b of topoGroup.querySelectorAll('button')) {
			b.setAttribute('aria-pressed', String(b.dataset.topo === topo));
		}
		topoHint.textContent = TOPO_HINTS[topo];
		panel.querySelector('.gr-budget-unit').textContent = topo === 'quad' ? 'target quads' : 'target faces';
	}

	// Count triangles in a GLB without a full 3D parse: read the JSON chunk and
	// sum each mesh primitive's index (or position) accessor count. Accurate for
	// the TRIANGLES-mode meshes forge produces; returns null if it can't tell.
	function countGlbTriangles(buffer) {
		try {
			const dv = new DataView(buffer);
			if (dv.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
			let offset = 12;
			let json = null;
			while (offset < dv.byteLength) {
				const chunkLen = dv.getUint32(offset, true);
				const chunkType = dv.getUint32(offset + 4, true);
				if (chunkType === 0x4e4f534a) {
					// 'JSON'
					json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, chunkLen)));
					break;
				}
				offset += 8 + chunkLen;
			}
			if (!json?.meshes || !json?.accessors) return null;
			let tris = 0;
			for (const mesh of json.meshes) {
				for (const prim of mesh.primitives || []) {
					if (prim.mode !== undefined && prim.mode !== 4) continue; // not TRIANGLES
					const accIdx = prim.indices !== undefined ? prim.indices : prim.attributes?.POSITION;
					const count = json.accessors[accIdx]?.count;
					if (Number.isFinite(count)) tris += Math.floor(count / 3);
				}
			}
			return tris > 0 ? tris : null;
		} catch {
			return null;
		}
	}

	async function loadSourceFaceCount(url) {
		state.sourceFaces = null;
		try {
			const res = await fetch(url);
			if (!res.ok) return;
			const buf = await res.arrayBuffer();
			const tris = countGlbTriangles(buf);
			if (tris && state.glbUrl === url) {
				state.sourceFaces = tris;
				setBudget(defaultBudgetFor(tris));
			}
		} catch {
			// Network/CORS hiccup — leave the sensible default budget in place.
		}
	}

	function safeLabel() {
		return state.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 48).replace(/^-|-$/g, '') || 'forge';
	}

	function renderDownloads(outputs) {
		downloadsEl.innerHTML = '';
		const order = ['glb', 'fbx'];
		const budget = Number(budgetSlider.value);
		for (const fmt of order) {
			const out = outputs[fmt];
			if (!out?.url) continue;
			const a = document.createElement('a');
			a.className = 'btn';
			a.href = out.url;
			a.setAttribute('download', `${safeLabel()}-${state.topology}-${fmtCount(budget)}.${fmt}`);
			a.textContent = `Download ${fmt.toUpperCase()}`;
			a.rel = 'noopener';
			downloadsEl.appendChild(a);
		}
		downloadsEl.classList.toggle('is-shown', downloadsEl.childElementCount > 0);
	}

	function renderDelta(data) {
		const after = data.face_count;
		const unit = state.topology === 'quad' ? (data.quad_ratio > 0 ? 'quads' : 'faces') : 'tris';
		const parts = [];
		if (Number.isFinite(state.sourceFaces)) {
			parts.push(`<span class="gr-from">${state.sourceFaces.toLocaleString()} tris</span><span class="gr-arrow">→</span>`);
		}
		parts.push(`<span class="gr-to">${Number.isFinite(after) ? after.toLocaleString() : '—'} ${unit}</span>`);
		if (Number.isFinite(state.sourceFaces) && Number.isFinite(after) && after > 0 && after < state.sourceFaces) {
			const pct = Math.round((1 - after / state.sourceFaces) * 100);
			parts.push(`<span class="gr-tag">−${pct}%</span>`);
		}
		if (Number.isFinite(data.quad_ratio) && data.quad_ratio > 0) {
			parts.push(`<span class="gr-tag">${Math.round(data.quad_ratio * 100)}% quad-dominant</span>`);
		}
		if (data.textured === true) parts.push('<span class="gr-tag">texture re-baked ✓</span>');
		deltaEl.innerHTML = parts.join(' ');
		deltaEl.classList.add('is-shown');
	}

	// ── Entitlement ──────────────────────────────────────────────────────────
	// Two identities can hold $THREE here, and both must clear the gate: a signed-in
	// account with a linked wallet (mints its pass silently from the session), and a
	// visitor who has only connected a wallet (proves ownership by signing a free,
	// domain-bound message). The signature dialog is raised ONLY for a wallet the
	// access read already calls eligible, so a non-holder is never asked to sign for
	// something that could not unlock anyway.
	async function resolveAccess() {
		const data = await getAccess('forge.gameready', { fresh: true });
		state.access = data?.access || null;
		renderPayNote();
		return state.access;
	}

	// Mint (or reuse) the tier proof this very request will carry. Never throws:
	// both reads degrade to null, which just means the request goes out unproven and
	// the server answers with the normal hold-or-pay 402.
	async function primeTierProof() {
		const access = await resolveAccess();
		await getTierPass({ interactive: Boolean(access?.eligible) });
	}

	// The panel's footnote, told from what the viewer actually holds instead of the
	// generic pitch. Unresolved access keeps the neutral default already in the DOM.
	function renderPayNote() {
		if (!payNote || !state.access) return;
		if (state.access.eligible) {
			payNote.innerHTML = 'Your $THREE holding covers this. Game-Ready exports are free for you.';
			return;
		}
		const usd = Number(state.access.pay_per_use?.usd) || 0;
		const price = usd > 0 ? `$${usd.toFixed(2)} per export` : 'a one-time fee';
		payNote.innerHTML = `$THREE holders export free. Without a holding it is ${price}. <a href="/three-token">Hold $THREE →</a>`;
	}

	// ── Network ──────────────────────────────────────────────────────────────
	function sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function startExport(formats, payment) {
		// Carry the holder's $THREE tier pass so an eligible holder clears the gate
		// (no payment); harmless / empty for everyone else. A non-holder attaches the
		// settled pay-per-export proof instead.
		const res = await fetch('/api/forge-gameready', {
			method: 'POST',
			headers: attachTierPass({ 'content-type': 'application/json', ...CLIENT_HEADERS }),
			body: JSON.stringify({
				mesh_url: state.glbUrl,
				topology: state.topology,
				poly_budget: Number(budgetSlider.value),
				texture_size: Number(texsizeSel.value),
				formats,
				preserve_rig: rigCheck.checked && formats.includes('fbx'),
				...(payment?.paymentId && payment?.refId
					? { payment_id: payment.paymentId, ref_id: payment.refId }
					: {}),
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 503 || data.error === 'unconfigured') {
			throw new Error('Game-Ready export is not configured on this deployment yet.');
		}
		// $THREE hold-or-pay gate, or a pay-per-export proof that didn't verify — both
		// recoverable by paying once. Tag it so run() can open the pay modal and retry.
		if (
			res.status === 402 &&
			(data.error === 'three_hold_required' ||
				data.error === 'payment_invalid' ||
				data.error === 'payment_expired')
		) {
			const e = new Error(data.message || 'Game-Ready export is a $THREE holder perk — or pay per export.');
			e.kind = 'pay_required';
			e.gate = data;
			throw e;
		}
		// Proof already spent — clear it and re-offer Pay so a retry never replays it.
		if (res.status === 409 && data.error === 'payment_already_used') {
			const e = new Error(data.message || 'That payment was already used. Pay again to export.');
			e.kind = 'pay_required';
			e.gate = data;
			throw e;
		}
		if (res.status === 429 || data.error === 'rate_limited') {
			const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 10;
			throw new Error(`The exporter is busy. Try again in about ${secs}s.`);
		}
		if (!res.ok || !data.job_id) {
			throw new Error(data.message || `The exporter returned ${res.status}.`);
		}
		return data.job_id;
	}

	// Start the export, transparently handling the $THREE hold-or-pay gate: a holder
	// passes straight through; a non-holder is offered the one-time pay modal, then
	// the export retries with the settled proof. Returns the job id, or null when the
	// user dismissed the payment. The price comes from the server gate — never
	// hardcoded — so it stays correct if the catalog price changes.
	async function startWithGate(formats) {
		// Prove the holding BEFORE the first attempt, so an eligible holder is never
		// shown a pay modal for an export their $THREE already covers.
		await primeTierProof();
		try {
			return await startExport(formats);
		} catch (err) {
			if (err.kind !== 'pay_required') throw err;
			const usd = Number(err.gate?.pay_per_use?.usd) || 0;
			if (!(usd > 0)) throw err; // hold-only with no pay path — surface the gate copy
			setStatus('Waiting for payment…');
			const paid = await payForConsumption({
				usd,
				unit: 'one Game-Ready export',
				confirm: 'One engine-ready export (retopology + PBR re-bake), paid in $THREE.',
				footnote: '$THREE is the only coin on three.ws. Draft &amp; Standard generation stay free.',
				successText: 'Payment confirmed — starting your export…',
				refPrefix: 'forge-gameready',
			});
			if (!paid?.ok) {
				setStatus('Export cancelled — no $THREE was spent.');
				return null;
			}
			return await startExport(formats, { paymentId: paid.paymentId, refId: paid.refId });
		}
	}

	async function pollExport(jobId) {
		const deadline = performance.now() + MAX_MS;
		while (!state.pollAbort && performance.now() < deadline) {
			await sleep(POLL_MS);
			if (state.pollAbort) return null;
			const res = await fetch(`/api/forge-gameready?job=${encodeURIComponent(jobId)}`, {
				headers: CLIENT_HEADERS,
			});
			const data = await res.json().catch(() => ({}));
			if (data.status === 'done' && data.outputs) return data;
			if (data.status === 'failed') throw new Error(data.error || 'Game-Ready export failed.');
			setStatus(data.status === 'running' ? 'Retopologizing & baking…' : 'Queued…');
		}
		if (state.pollAbort) return null;
		throw new Error('Export timed out. Try a lower poly budget.');
	}

	function applyResult(data) {
		const outputs = data.outputs || {};
		// GLB renders inline — swap the live viewer so the new topology shows
		// immediately and feeds the wireframe preview.
		if (outputs.glb?.url) {
			viewer.setAttribute('src', outputs.glb.url);
			state.previewUrl = outputs.glb.url;
			wireBtn.hidden = false;
			resetWireframe();
		} else {
			// FBX-only export: no inline GLB to preview, so the wireframe stays off.
			wireBtn.hidden = true;
			hideWireframe();
		}
		renderDelta(data);
		renderDownloads(outputs);
	}

	async function run() {
		if (state.running || !state.glbUrl) return;
		const formats = selectedFormats();
		if (formats.length === 0) {
			setStatus('Pick at least one format (GLB or FBX).', 'error');
			return;
		}
		state.pollAbort = false;
		setRunning(true);
		setStatus('Starting…');
		deltaEl.classList.remove('is-shown');
		downloadsEl.classList.remove('is-shown');
		try {
			const jobId = await startWithGate(formats);
			if (!jobId) return; // user dismissed the $THREE payment — already messaged
			const done = await pollExport(jobId);
			if (!done) return; // superseded by a newer model / cancelled
			applyResult(done);
			setStatus('Done — engine-ready asset is ready to download.', 'done');
		} catch (err) {
			setStatus(err.message || 'Export failed.', 'error');
		} finally {
			setRunning(false);
		}
	}

	// ── Wireframe preview (lazy three.js overlay) ──────────────────────────────
	const wire = {
		ready: false,
		loading: false,
		THREE: null,
		renderer: null,
		scene: null,
		camera: null,
		controls: null,
		group: null,
		raf: 0,
		ro: null,
		loadedUrl: null,
	};

	function sizeWireRenderer() {
		if (!wire.renderer) return;
		const w = wireOverlay.clientWidth || 1;
		const h = wireOverlay.clientHeight || 1;
		wire.renderer.setSize(w, h, false);
		wire.camera.aspect = w / h;
		wire.camera.updateProjectionMatrix();
	}

	async function ensureWireEngine() {
		if (wire.ready || wire.loading) return wire.ready;
		wire.loading = true;
		try {
			const [THREE, { GLTFLoader }, { OrbitControls }, { getMeshoptDecoder }] = await Promise.all([
				import('three'),
				import('three/addons/loaders/GLTFLoader.js'),
				import('three/addons/controls/OrbitControls.js'),
				import('../viewer/internal.js'),
			]);
			wire.THREE = THREE;
			wire.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
			wire.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
			wireOverlay.appendChild(wire.renderer.domElement);
			wire.scene = new THREE.Scene();
			wire.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
			wire.camera.position.set(0, 0, 3);
			wire.controls = new OrbitControls(wire.camera, wire.renderer.domElement);
			wire.controls.enableDamping = true;
			wire.controls.autoRotate = true;
			wire.controls.autoRotateSpeed = 1.4;
			wire.group = new THREE.Group();
			wire.scene.add(wire.group);
			wire._loader = new GLTFLoader();
			wire._loader.setMeshoptDecoder(await getMeshoptDecoder());
			sizeWireRenderer();
			wire.ro = new ResizeObserver(sizeWireRenderer);
			wire.ro.observe(wireOverlay);
			const tick = () => {
				wire.raf = requestAnimationFrame(tick);
				wire.controls.update();
				wire.renderer.render(wire.scene, wire.camera);
			};
			tick();
			wire.ready = true;
		} catch {
			wire.ready = false;
		} finally {
			wire.loading = false;
		}
		return wire.ready;
	}

	function clearWireGroup() {
		if (!wire.group) return;
		for (const child of [...wire.group.children]) {
			wire.group.remove(child);
			child.traverse?.((n) => {
				n.geometry?.dispose?.();
				if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
				else n.material?.dispose?.();
			});
		}
	}

	function frameWireModel(root) {
		const THREE = wire.THREE;
		const box = new THREE.Box3().setFromObject(root);
		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z) || 1;
		root.position.sub(center);
		const dist = maxDim * 2.2;
		wire.camera.position.set(dist * 0.6, dist * 0.3, dist);
		wire.camera.near = maxDim / 100;
		wire.camera.far = maxDim * 100;
		wire.camera.updateProjectionMatrix();
		wire.controls.target.set(0, 0, 0);
		wire.controls.update();
	}

	async function loadWireModel(url) {
		if (!(await ensureWireEngine())) return;
		if (wire.loadedUrl === url && wire.group.children.length) return;
		const THREE = wire.THREE;
		wire._loader.load(
			url,
			(gltf) => {
				clearWireGroup();
				const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c9cff';
				const wireMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent), wireframe: true });
				gltf.scene.traverse((node) => {
					if (node.isMesh) node.material = wireMat;
				});
				wire.group.add(gltf.scene);
				frameWireModel(gltf.scene);
				wire.loadedUrl = url;
			},
			undefined,
			() => {
				/* load error — keep the overlay hidden, user still has the textured viewer */
				hideWireframe();
			},
		);
	}

	function showWireframe() {
		if (!state.previewUrl) return;
		wireOverlay.classList.add('is-shown');
		wireBtn.setAttribute('aria-pressed', 'true');
		loadWireModel(state.previewUrl);
	}
	function hideWireframe() {
		wireOverlay.classList.remove('is-shown');
		wireBtn.setAttribute('aria-pressed', 'false');
	}
	function resetWireframe() {
		// A new export invalidates the previously loaded wireframe model.
		wire.loadedUrl = null;
		if (wireOverlay.classList.contains('is-shown')) showWireframe();
	}

	// ── Wiring ─────────────────────────────────────────────────────────────────
	function openPanel(open) {
		panel.dataset.open = String(open);
		triggerBtn.setAttribute('aria-expanded', String(open));
		if (open) {
			panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			// Read the viewer's entitlement while they pick settings, so the footnote
			// states their real price before they commit to the export.
			resolveAccess();
		} else hideWireframe();
	}

	// Connecting, switching, or disconnecting a wallet changes who is asking, so the
	// resolved entitlement is stale. Re-read it while the panel is on screen.
	window.addEventListener('wallet:changed', () => {
		if (panel.dataset.open === 'true') resolveAccess();
	});

	triggerBtn.addEventListener('click', () => {
		openPanel(panel.dataset.open !== 'true');
	});

	topoGroup.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-topo]');
		if (btn) applyTopology(btn.dataset.topo);
	});

	budgetSlider.addEventListener('input', () => setBudget(Number(budgetSlider.value)));

	presetGroup.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-budget]');
		if (btn) setBudget(Number(btn.dataset.budget));
	});

	for (const c of fmtChecks) c.addEventListener('change', syncRigVisibility);
	rigCheck.addEventListener('change', syncRigVisibility);

	runBtn.addEventListener('click', run);

	wireBtn.addEventListener('click', () => {
		if (wireOverlay.classList.contains('is-shown')) hideWireframe();
		else showWireframe();
	});

	// Pick up the live model whenever one is forged or loaded from the gallery.
	document.addEventListener('forge:model-ready', (e) => {
		const url = e.detail?.glbUrl;
		if (!url) return;
		state.glbUrl = url;
		state.label = e.detail?.label || 'model';
		state.previewUrl = null;
		state.pollAbort = true; // cancel any in-flight poll for the previous model
		setStatus('');
		deltaEl.classList.remove('is-shown');
		downloadsEl.classList.remove('is-shown');
		wireBtn.hidden = true;
		hideWireframe();
		openPanel(false);
		loadSourceFaceCount(url);
	});

	// Initial render.
	applyTopology('quad');
	setBudget(15_000);
	syncRigVisibility();
}
