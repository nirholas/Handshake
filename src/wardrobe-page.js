// /wardrobe — the public garment catalog + the generator lane.
//
// Two jobs on one page:
//   1. Browse every published wearable (live catalog the closet uses:
//      src/garment-catalog.js → gs://three-ws-garments). Search, filter by
//      slot, inspect the 3D asset inline, jump into the editor to wear it.
//   2. Generate a new wearable from a text prompt through the public
//      POST /api/garment-forge proxy, watching the real pipeline stages
//      (image → mesh → compose → rig → extract → validate → publish). A
//      finished piece is already live in the catalog, so the grid refreshes
//      itself and highlights the new tile.
//
// No mocks anywhere: the grid is the production catalog, the generator is the
// production worker, and a piece shown here is wearable in /avatar-edit now.

import { loadCatalog, bySlot } from './garment-catalog.js';
import { GARMENT_SLOTS } from './garment-taxonomy.js';

const SLOT_LABELS = {
	top: 'Tops', bottom: 'Bottoms', footwear: 'Footwear', outerwear: 'Outerwear',
	hair: 'Hair', headwear: 'Headwear', glasses: 'Glasses', accessory: 'Accessories',
};
const STAGES = ['image', 'mesh', 'compose', 'rig', 'extract', 'validate', 'publish'];
const POLL_MS = 10_000;
const JOB_KEY = 'twx_wardrobe_job';

const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let allGarments = [];
let activeSlot = 'all';
let query = '';
let highlightId = null;

async function boot() {
	wireToolbar();
	wireGenerator();
	await refresh();
	resumePendingJob();
}

async function refresh({ force = false } = {}) {
	const loading = $('loading');
	const errorBox = $('error');
	const grid = $('grid');
	try {
		const catalog = await loadCatalog({ force });
		allGarments = catalog.garments;
		loading.hidden = true;
		errorBox.hidden = true;
		renderChips();
		render();
	} catch (err) {
		loading.hidden = true;
		grid.hidden = true;
		errorBox.hidden = false;
		$('error-msg').textContent = `The catalog did not load (${err?.message || err}). It is a public feed, so this is almost always a network blip.`;
	}
}

function wireToolbar() {
	const search = $('search');
	search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
	document.addEventListener('keydown', (e) => {
		if (e.key === '/' && document.activeElement !== search && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
			e.preventDefault();
			search.focus();
		}
	});
	$('retry').addEventListener('click', () => {
		$('error').hidden = true;
		$('loading').hidden = false;
		refresh({ force: true });
	});
	$('clear-search').addEventListener('click', () => {
		search.value = '';
		query = '';
		render();
	});
}

function renderChips() {
	const grouped = bySlot(allGarments);
	const chips = ['all', ...GARMENT_SLOTS.filter((s) => grouped.has(s))];
	$('chips').innerHTML = chips.map((slot) => `
		<button type="button" class="wd-chip${slot === activeSlot ? ' is-active' : ''}" data-slot="${slot}"
			aria-pressed="${slot === activeSlot}">
			${slot === 'all' ? 'Everything' : esc(SLOT_LABELS[slot] || slot)}
		</button>
	`).join('');
	$('chips').querySelectorAll('.wd-chip').forEach((chip) => {
		chip.addEventListener('click', () => {
			activeSlot = chip.dataset.slot;
			renderChips();
			render();
		});
	});
}

function visibleGarments() {
	return allGarments.filter((g) => {
		if (activeSlot !== 'all' && g.slot !== activeSlot) return false;
		if (!query) return true;
		return `${g.name} ${g.slot} ${g.id}`.toLowerCase().includes(query);
	});
}

function render() {
	const grid = $('grid');
	const items = visibleGarments();
	$('count').textContent = `${items.length} of ${allGarments.length} pieces`;
	$('empty').hidden = allGarments.length !== 0;
	$('empty-search').hidden = !(allGarments.length > 0 && items.length === 0);
	grid.hidden = items.length === 0;
	if (!items.length) return;

	grid.innerHTML = items.map((g) => {
		const thumb = g.preview?.thumbnail;
		const version = g.version || 1;
		return `
		<article class="wd-card${g.id === highlightId ? ' is-new' : ''}" data-id="${esc(g.id)}">
			<div class="wd-thumb" data-thumb>
				${thumb
					? `<img src="${esc(thumb)}" alt="${esc(g.name)}" loading="lazy" />`
					: '<span class="wd-thumb-fallback" aria-hidden="true">◆</span>'}
				<span class="wd-pill">${esc(g.slot)}</span>
				<button type="button" class="wd-3d" data-view3d="${esc(g.model?.uri || '')}"
					aria-label="View ${esc(g.name)} in 3D" title="View in 3D">3D</button>
			</div>
			<div class="wd-body">
				<h3 class="wd-name" title="${esc(g.name)}">${esc(g.name)}</h3>
				<p class="wd-meta">v${version} · ${esc(g.license || '')}${g.source?.kind === 'generated' ? ' · generated' : ''}</p>
				<div class="wd-actions">
					<a class="wd-btn wd-btn--primary" href="/avatars" title="Open one of your avatars in the editor, Wardrobe tab">Dress your avatar</a>
				</div>
			</div>
		</article>`;
	}).join('');

	grid.querySelectorAll('[data-view3d]').forEach((btn) => {
		btn.addEventListener('click', () => swapInViewer(btn));
	});
	if (highlightId) {
		const card = grid.querySelector(`.wd-card[data-id="${CSS.escape(highlightId)}"]`);
		card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
}

// Swap a card's static thumbnail for a live <model-viewer> on demand, so the
// grid stays light (a page of skinned GLBs would be megabytes of parsing) but
// any piece is inspectable without leaving the page.
function swapInViewer(btn) {
	const url = btn.dataset.view3d;
	if (!url) return;
	const thumbBox = btn.closest('[data-thumb]');
	if (!thumbBox || thumbBox.querySelector('model-viewer')) return;
	const mv = document.createElement('model-viewer');
	mv.className = 'wd-mv';
	mv.setAttribute('src', url);
	mv.setAttribute('camera-controls', '');
	mv.setAttribute('auto-rotate', '');
	mv.setAttribute('shadow-intensity', '0.6');
	mv.setAttribute('exposure', '0.9');
	thumbBox.querySelector('img, .wd-thumb-fallback')?.remove();
	btn.remove();
	thumbBox.prepend(mv);
}

/* ── Generator ─────────────────────────────────────────────────────────── */

function wireGenerator() {
	const form = $('gen-form');
	const slotSel = $('gen-slot');
	slotSel.innerHTML = GARMENT_SLOTS.map((s) => `<option value="${s}">${esc(SLOT_LABELS[s] || s)}</option>`).join('');
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const prompt = $('gen-prompt').value.trim();
		if (prompt.length < 3) return setGenStatus('err', 'Describe the piece in a few words first.');
		setGenBusy(true);
		setGenStatus('spin', 'Submitting to the forge…');
		try {
			const r = await fetch('/api/garment-forge', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt, slot: slotSel.value }),
			});
			const body = await r.json().catch(() => ({}));
			if (!r.ok) {
				const msg = body.message || body.error_description || body.error || `request failed (${r.status})`;
				throw new Error(msg);
			}
			localStorage.setItem(JOB_KEY, JSON.stringify({ job: body.job_id, prompt, slot: slotSel.value }));
			pollJob(body.job_id);
		} catch (err) {
			setGenBusy(false);
			setGenStatus('err', String(err.message || err));
		}
	});
}

function resumePendingJob() {
	let saved = null;
	try { saved = JSON.parse(localStorage.getItem(JOB_KEY) || 'null'); } catch { /* corrupt: ignore */ }
	if (!saved?.job) return;
	setGenBusy(true);
	setGenStatus('spin', `Resuming your ${saved.slot} job…`);
	if (saved.prompt) $('gen-prompt').value = saved.prompt;
	pollJob(saved.job);
}

async function pollJob(jobId) {
	try {
		const r = await fetch(`/api/garment-forge?job=${encodeURIComponent(jobId)}`);
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(body.message || body.error || `poll failed (${r.status})`);

		if (body.status === 'done') {
			localStorage.removeItem(JOB_KEY);
			setGenBusy(false);
			renderStages('publish', true);
			setGenStatus('ok', 'Published. Your piece is live in the catalog below and wearable in the editor right now.');
			highlightId = body.garment_id || null;
			await refresh({ force: true });
			return;
		}
		if (body.status === 'failed' || body.error) {
			localStorage.removeItem(JOB_KEY);
			setGenBusy(false);
			renderStages(null, false);
			setGenStatus('err', `Generation failed: ${body.error || 'unknown error'}. Nothing was published; try a simpler description.`);
			return;
		}
		renderStages(body.stage, false);
		setGenStatus('spin', `Working: ${body.stage || 'queued'}… about 7 minutes end to end.`);
		setTimeout(() => pollJob(jobId), POLL_MS);
	} catch (err) {
		// Transient poll failure: keep the job, keep polling. The worker's job
		// state is durable, so a blip never orphans a generation.
		setGenStatus('spin', `Reconnecting (${String(err.message || err).slice(0, 60)})…`);
		setTimeout(() => pollJob(jobId), POLL_MS * 2);
	}
}

function renderStages(current, allDone) {
	const idx = STAGES.indexOf(current);
	$('gen-stages').innerHTML = STAGES.map((s, i) => {
		const state = allDone || i < idx ? 'done' : i === idx ? 'active' : 'todo';
		return `<span class="wd-stage wd-stage--${state}">${s}</span>`;
	}).join('<span class="wd-stage-sep" aria-hidden="true">→</span>');
}

function setGenBusy(busy) {
	$('gen-submit').disabled = busy;
	$('gen-prompt').disabled = busy;
	$('gen-slot').disabled = busy;
}

function setGenStatus(kind, msg) {
	const el = $('gen-status');
	el.dataset.kind = kind;
	el.textContent = msg;
}

boot();
