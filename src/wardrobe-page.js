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
// A poll can blip (edge restart, offline tab). The job record is durable, so we
// retry rather than orphan it, but not forever: after this many consecutive
// failures we hand the form back to the user instead of leaving it disabled.
const MAX_POLL_FAILURES = 6;
const JOB_KEY = 'twx_wardrobe_job';

const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let allGarments = [];
// Card elements, parallel to allGarments. Filtering toggles these in place
// rather than re-rendering the grid: a rebuild would drop any <model-viewer>
// the user opened, restart 59 image loads on every keystroke, and throw
// keyboard focus back to <body>.
let cardEls = [];
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
		renderGrid();
	} catch (err) {
		loading.hidden = true;
		grid.hidden = true;
		errorBox.hidden = false;
		// The localized sentence stays in the DOM untouched (i18n owns it); the
		// machine-readable cause goes in its own node so a later locale pass
		// cannot overwrite the only actionable half of this state.
		$('error-detail').textContent =
			`Cause: ${err?.message || err}. The catalog is a public feed, so this is almost always a network blip.`;
	}
}

function wireToolbar() {
	const search = $('search');
	search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); applyFilter(); });
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
		applyFilter();
		search.focus();
	});
}

function renderChips() {
	const grouped = bySlot(allGarments);
	const chips = ['all', ...GARMENT_SLOTS.filter((s) => grouped.has(s))];
	if (!chips.includes(activeSlot)) activeSlot = 'all';
	$('chips').innerHTML = chips.map((slot) => `
		<button type="button" class="wd-chip" data-slot="${slot}" aria-pressed="false">
			${slot === 'all' ? 'Everything' : esc(SLOT_LABELS[slot] || slot)}
		</button>
	`).join('');
	$('chips').querySelectorAll('.wd-chip').forEach((chip) => {
		chip.addEventListener('click', () => {
			activeSlot = chip.dataset.slot;
			syncChips();
			applyFilter();
		});
	});
	syncChips();
}

// Reflect the active slot without replacing the buttons, so the chip a keyboard
// user just pressed Enter on still holds focus afterwards.
function syncChips() {
	$('chips').querySelectorAll('.wd-chip').forEach((chip) => {
		const on = chip.dataset.slot === activeSlot;
		chip.classList.toggle('is-active', on);
		chip.setAttribute('aria-pressed', String(on));
	});
}

function matchesFilter(g) {
	if (activeSlot !== 'all' && g.slot !== activeSlot) return false;
	if (!query) return true;
	return `${g.name} ${g.slot} ${g.id}`.toLowerCase().includes(query);
}

function cardHtml(g) {
	const thumb = g.preview?.thumbnail;
	const modelUri = g.model?.uri || '';
	const version = g.version || 1;
	return `
	<article class="wd-card${g.id === highlightId ? ' is-new' : ''}" data-id="${esc(g.id)}" data-slot="${esc(g.slot)}">
		<div class="wd-thumb" data-thumb>
			${thumb
				? `<img src="${esc(thumb)}" alt="${esc(g.name)}" loading="lazy" />`
				: '<span class="wd-thumb-fallback" aria-hidden="true">◆</span>'}
			<span class="wd-pill">${esc(g.slot)}</span>
			${modelUri
				? `<button type="button" class="wd-3d" data-view3d="${esc(modelUri)}"
					aria-label="View ${esc(g.name)} in 3D" title="View in 3D">3D</button>`
				: ''}
		</div>
		<div class="wd-body">
			<h3 class="wd-name" title="${esc(g.name)}">${esc(g.name)}</h3>
			<p class="wd-meta">v${version} · ${esc(g.license || '')}${g.source?.kind === 'generated' ? ' · generated' : ''}</p>
			<div class="wd-actions">
				<a class="wd-btn wd-btn--primary" href="/a/me" title="Open one of your avatars in the editor, Wardrobe tab">Dress your avatar</a>
			</div>
		</div>
	</article>`;
}

// Build every card once per catalog load. Filtering never touches this.
function renderGrid() {
	const grid = $('grid');
	grid.innerHTML = allGarments.map(cardHtml).join('');
	cardEls = [...grid.children];
	grid.querySelectorAll('[data-view3d]').forEach((btn) => {
		btn.addEventListener('click', () => swapInViewer(btn));
	});
	applyFilter();
	if (highlightId) {
		const i = allGarments.findIndex((g) => g.id === highlightId);
		if (i >= 0) cardEls[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
}

function applyFilter() {
	let shown = 0;
	allGarments.forEach((g, i) => {
		const visible = matchesFilter(g);
		if (visible) shown++;
		const el = cardEls[i];
		if (el) el.hidden = !visible;
	});
	$('count').textContent = `${shown} of ${allGarments.length} pieces`;
	$('empty').hidden = allGarments.length !== 0;
	$('empty-search').hidden = !(allGarments.length > 0 && shown === 0);
	$('grid').hidden = shown === 0;
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
			// Storage is a resume convenience, not a requirement: a sandboxed
			// webview that refuses it still gets a live poll for this session.
			try {
				localStorage.setItem(JOB_KEY, JSON.stringify({ job: body.job_id, prompt, slot: slotSel.value }));
			} catch { /* storage unavailable */ }
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

async function pollJob(jobId, failures = 0) {
	try {
		const r = await fetch(`/api/garment-forge?job=${encodeURIComponent(jobId)}`);
		const body = await r.json().catch(() => ({}));
		// A job the forge no longer knows about is terminal, not a blip. Treating
		// it as transient used to keep the saved id in storage forever, so the
		// generator came back disabled on every later visit to this page.
		if (r.status === 404 || body.error === 'job_not_found') {
			forgetJob();
			renderStages(null, false);
			setGenStatus('err', 'That job is no longer on the forge (finished jobs are cleared after a while). Nothing is pending, so describe a piece and forge it again.');
			return;
		}
		if (!r.ok) throw new Error(body.message || body.error || `poll failed (${r.status})`);

		if (body.status === 'done') {
			forgetJob();
			renderStages('publish', true);
			setGenStatus('ok', 'Published. Your piece is live in the catalog below and wearable in the editor right now.');
			highlightId = body.garment_id || null;
			await refresh({ force: true });
			return;
		}
		if (body.status === 'failed' || body.error) {
			forgetJob();
			renderStages(null, false);
			setGenStatus('err', `Generation failed: ${body.error || 'unknown error'}. Nothing was published; try a simpler description.`);
			return;
		}
		renderStages(body.stage, false);
		setGenStatus('spin', `Working: ${body.stage || 'queued'}… about 7 minutes end to end.`);
		setTimeout(() => pollJob(jobId), POLL_MS);
	} catch (err) {
		// Transient poll failure: keep the saved job and keep polling, because the
		// worker's job state is durable and a blip must never orphan a generation.
		// After MAX_POLL_FAILURES in a row we stop and hand the form back rather
		// than leave the user staring at a disabled generator.
		const next = failures + 1;
		if (next >= MAX_POLL_FAILURES) {
			setGenBusy(false);
			setGenStatus('err', `Lost contact with the forge (${String(err.message || err).slice(0, 80)}). Your job is still saved: reload this page to pick it back up, or forge something new.`);
			return;
		}
		setGenStatus('spin', `Reconnecting (${String(err.message || err).slice(0, 60)})…`);
		setTimeout(() => pollJob(jobId, next), POLL_MS * 2);
	}
}

// Clear the resumable job and unlock the generator. Every terminal path goes
// through here so the two can never drift apart.
function forgetJob() {
	try { localStorage.removeItem(JOB_KEY); } catch { /* storage unavailable */ }
	setGenBusy(false);
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
