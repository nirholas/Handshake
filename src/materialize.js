// /materialize: the surface where a generated model becomes a real object.
//
// One screen, no wizard. Pick a model, watch it get measured, choose what it is
// made of and how big it is, see the price move as you decide, put it on your
// desk at true size in AR, and pay in USDC on Solana.
//
// Two rules shape every line below:
//
//   1. No price is computed here. Every amount on this page arrives from
//      POST /api/print/quote already decided by the quote engine, and this file
//      only chooses how to say it. The same applies to what is printable: the
//      server measures the mesh, and the slider ends and material cards are
//      rendered from what it measured, so the UI can never promise something
//      checkout will refuse.
//   2. Every state is drawn. Nothing picked, loading, a mesh that cannot be
//      read, a material that cannot take this model, a price still settling, a
//      payment waiting on a phone, and the moment it lands.
//
// The pure parts (scale drawing, slider maths, itemization rows, timeline) live
// in src/materialize-lib.js and are unit-tested.

import {
	SHIPPING_COUNTRIES,
	arScaleAttribute,
	clampHeight,
	defaultHeight,
	formatLeadTime,
	formatMm,
	formatUsdc,
	printabilityView,
	quoteRows,
	rejectionView,
	scaleReference,
	sliderBounds,
	validateShipping,
} from './materialize-lib.js';

const $ = (id) => document.getElementById(id);

// Long enough that dragging the size slider produces one request per pause
// rather than one per pixel, short enough that the price feels live.
const QUOTE_DEBOUNCE_MS = 260;
const CONFIRM_POLL_MS = 4000;
const CONFIRM_TIMEOUT_MS = 15 * 60 * 1000;

const state = {
	catalog: null,
	user: null,
	source: null, // { url, creationId, label }
	report: null,
	fits: [],
	materialId: null,
	finishId: null,
	heightMm: null,
	quantity: 1,
	country: 'US',
	hollow: false,
	quote: null,
	token: null,
	rejection: null,
	prepared: null,
	quoting: false,
	quoteSeq: 0,
};

// ── plumbing ────────────────────────────────────────────────────────────────

function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, options = {}) {
	const res = await fetch(path, { credentials: 'include', ...options });
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const err = new Error(body?.message || body?.error || `Request failed (${res.status})`);
		err.status = res.status;
		err.code = body?.code || body?.error || null;
		err.body = body;
		throw err;
	}
	return body;
}

async function csrfToken() {
	const body = await api('/api/csrf-token');
	return body?.token || body?.csrfToken || null;
}

/** The anonymous browser handle /forge already mints, so uploads land under a stable prefix. */
function forgeClientKey() {
	const KEY = 'threews_forge_client';
	try {
		let value = localStorage.getItem(KEY);
		if (!value) {
			value = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, '');
			localStorage.setItem(KEY, value);
		}
		return value;
	} catch {
		return 'anonymous';
	}
}

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
	wireStatic();

	const params = new URLSearchParams(location.search);
	const creationId = params.get('creation');
	const glbUrl = params.get('glb');

	// The catalog is what every control is built from, so nothing renders until
	// it lands. A failure here is the one case where the page has nothing to say.
	try {
		state.catalog = await api('/api/print/catalog');
	} catch (err) {
		showLoadError(`The price list could not be loaded, so nothing can be quoted right now. ${esc(err.message)}`);
		return;
	}

	fillCountries();
	loadViewer(); // resolve session + creations rail in the background
	whoAmI();

	if (creationId) selectSource({ creationId, label: 'your creation' });
	else if (glbUrl) selectSource({ url: glbUrl, label: 'a linked model' });
}

function wireStatic() {
	$('mz-browse')?.addEventListener('click', () => $('mz-file').click());
	$('mz-file')?.addEventListener('change', (e) => {
		const file = e.target.files?.[0];
		if (file) uploadAndSelect(file);
	});

	const drop = $('mz-drop');
	if (drop) {
		for (const type of ['dragenter', 'dragover']) {
			drop.addEventListener(type, (e) => {
				e.preventDefault();
				drop.classList.add('is-over');
			});
		}
		for (const type of ['dragleave', 'drop']) {
			drop.addEventListener(type, (e) => {
				e.preventDefault();
				drop.classList.remove('is-over');
			});
		}
		drop.addEventListener('drop', (e) => {
			const file = e.dataTransfer?.files?.[0];
			if (file) uploadAndSelect(file);
		});
	}

	$('mz-url-form')?.addEventListener('submit', (e) => {
		e.preventDefault();
		const url = $('mz-url').value.trim();
		if (url) selectSource({ url, label: 'a linked model' });
	});

	$('mz-change')?.addEventListener('click', () => {
		state.source = null;
		state.report = null;
		state.quote = null;
		state.prepared = null;
		$('mz-studio').hidden = true;
		$('mz-picker').hidden = false;
		history.replaceState(null, '', '/materialize');
		$('mz-drop')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	});

	$('mz-size')?.addEventListener('input', () => {
		state.heightMm = Number($('mz-size').value);
		renderSizeReadout();
		scheduleQuote();
	});
	$('mz-qty')?.addEventListener('change', () => {
		const n = Math.max(1, Math.min(500, Math.round(Number($('mz-qty').value) || 1)));
		$('mz-qty').value = String(n);
		state.quantity = n;
		scheduleQuote();
	});
	$('mz-country')?.addEventListener('change', () => {
		state.country = $('mz-country').value;
		try {
			localStorage.setItem('mz_country', state.country);
		} catch {
			// A browser with storage disabled simply re-picks the default each visit.
		}
		scheduleQuote();
	});
	$('mz-hollow')?.addEventListener('change', () => {
		state.hollow = $('mz-hollow').checked;
		state.prepared = null;
		scheduleQuote();
	});
	$('mz-finish')?.addEventListener('change', () => {
		state.finishId = $('mz-finish').value;
		scheduleQuote();
	});
	$('mz-repair')?.addEventListener('click', runRepair);
	$('mz-ar-btn')?.addEventListener('click', () => $('mz-viewer')?.activateAR?.());

	$('mz-sheet-close')?.addEventListener('click', closeSheet);
	$('mz-sheet')?.addEventListener('click', (e) => {
		if (e.target === $('mz-sheet')) closeSheet();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('mz-sheet').hidden) closeSheet();
	});
}

function fillCountries() {
	const select = $('mz-country');
	if (!select) return;
	let saved = 'US';
	try {
		saved = localStorage.getItem('mz_country') || 'US';
	} catch {
		saved = 'US';
	}
	state.country = SHIPPING_COUNTRIES.some((c) => c.code === saved) ? saved : 'US';
	select.innerHTML = SHIPPING_COUNTRIES.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('');
	select.value = state.country;
}

async function whoAmI() {
	try {
		const body = await api('/api/auth/me');
		state.user = body?.user || body || null;
	} catch {
		state.user = null;
	}
	loadRail();
}

// ── the creations rail ──────────────────────────────────────────────────────

async function loadRail() {
	const rail = $('mz-rail');
	if (!rail) return;
	const username = state.user?.username;
	if (!username) {
		rail.innerHTML = `<p class="mz-rail-empty">Sign in and your own creations appear here, ready to print. Or <a href="/create" style="color:inherit">generate one now</a>, or drop a file on the left.</p>`;
		return;
	}
	try {
		const body = await api(`/api/users/${encodeURIComponent(username)}/creations?type=model`);
		const items = (body?.creations || body?.items || []).filter((c) => c.glb_url || c.model_url);
		if (!items.length) {
			rail.innerHTML = `<p class="mz-rail-empty">Nothing forged yet. <a href="/create" style="color:inherit">Make your first model</a> and it will show up here.</p>`;
			return;
		}
		rail.innerHTML = items
			.slice(0, 12)
			.map((c) => {
				const poster = c.preview_image_url || c.thumbnail_url || '';
				const label = esc((c.prompt || c.title || 'Untitled').slice(0, 70));
				return `<button type="button" class="mz-rail-card" data-creation="${esc(c.id)}" title="${label}">
					${poster ? `<img src="${esc(poster)}" alt="" loading="lazy" />` : ''}
					<figcaption>${label}</figcaption>
				</button>`;
			})
			.join('');
		for (const card of rail.querySelectorAll('[data-creation]')) {
			card.addEventListener('click', () => selectSource({ creationId: card.dataset.creation, label: 'your creation' }));
		}
	} catch {
		rail.innerHTML = `<p class="mz-rail-empty">Your creations could not be loaded just now. Paste a model URL or drop a file on the left, and try this panel again shortly.</p>`;
	}
}

// ── choosing a model ────────────────────────────────────────────────────────

async function uploadAndSelect(file) {
	if (!/\.glb$/i.test(file.name)) {
		showLoadError('That is not a .glb. Export a self-contained glTF binary and try again.');
		return;
	}
	showLoadError(null);
	const drop = $('mz-drop');
	drop?.setAttribute('aria-busy', 'true');
	try {
		const slot = await api('/api/print/upload', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': forgeClientKey() },
			body: JSON.stringify({ content_type: 'model/gltf-binary', size_bytes: file.size }),
		});
		const put = await fetch(slot.upload_url, { method: 'PUT', headers: slot.headers, body: file });
		if (!put.ok) throw new Error(`Upload failed (${put.status})`);
		selectSource({ url: slot.public_url, label: file.name });
	} catch (err) {
		showLoadError(`${esc(err.message)} You can still paste a public .glb URL instead.`);
	} finally {
		drop?.removeAttribute('aria-busy');
	}
}

async function selectSource(source) {
	showLoadError(null);
	state.source = source;
	state.report = null;
	state.quote = null;
	state.token = null;
	state.rejection = null;
	state.prepared = null;

	$('mz-picker').hidden = true;
	$('mz-studio').hidden = false;
	setStageBusy('Measuring the mesh…');
	$('mz-source-note').textContent = source.label ? `Printing ${source.label}` : '';

	const url = new URL(location.href);
	url.search = source.creationId ? `?creation=${source.creationId}` : source.url ? `?glb=${encodeURIComponent(source.url)}` : '';
	history.replaceState(null, '', url.pathname + url.search);

	try {
		const body = await api('/api/print/quote', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(source.creationId ? { creationId: source.creationId } : { glbUrl: source.url }),
		});
		state.report = body.report;
		state.fits = body.fits || [];
		state.source = { ...source, url: body.sourceUrl, creation: body.creation || null };
		showModel(body.sourceUrl);
		renderPrintability();
		renderMaterials();
		pickInitialMaterial();
		setStageBusy(null);
	} catch (err) {
		setStageBusy(null);
		$('mz-studio').hidden = true;
		$('mz-picker').hidden = false;
		showLoadError(describeLoadFailure(err));
	}
}

/**
 * Turn an analyzer failure into something a person can act on. Each code is a
 * different problem with a different fix, and saying "could not analyze" for all
 * of them would be the same as saying nothing.
 */
function describeLoadFailure(err) {
	const map = {
		invalid_model: 'That file is not a readable glTF binary. Re-export it as a .glb and try again.',
		no_geometry: 'That model has no triangle geometry, so there is nothing to print. Points and curves cannot be fabricated.',
		too_large: 'That model is larger than the printer pipeline will read. Compress or decimate it first.',
		too_complex: 'That model has more triangles than the pipeline will read. Run it through /inspect to decimate it, then come back.',
		invalid_url: 'That URL cannot be fetched. It has to be a public https link to a .glb.',
		fetch_failed: 'The model could not be downloaded from that URL. Check the link is public and try again.',
		creation_not_found: 'That creation could not be found, or it is not public.',
		creation_has_no_model: 'That creation has not finished generating yet, so there is no model to print.',
	};
	return map[err.code] || `${esc(err.message)}`;
}

function showLoadError(message) {
	const box = $('mz-load-error');
	if (!box) return;
	if (!message) {
		box.hidden = true;
		box.innerHTML = '';
		return;
	}
	box.hidden = false;
	box.innerHTML = `<h3>That model could not be measured</h3><p>${message}</p>`;
}

function showStudioError(message) {
	const box = $('mz-studio-error');
	if (!box) return;
	if (!message) {
		box.hidden = true;
		box.innerHTML = '';
		return;
	}
	box.hidden = false;
	box.innerHTML = `<h3>Something went wrong</h3><p>${esc(message)}</p>`;
}

function setStageBusy(label) {
	const busy = $('mz-stage-busy');
	if (!busy) return;
	busy.hidden = !label;
	if (label) $('mz-stage-busy-label').textContent = label;
}

function loadViewer() {
	// model-viewer is a module script in the head; nothing to do here beyond
	// making sure the element exists before we set attributes on it.
	return $('mz-viewer');
}

function showModel(url) {
	const viewer = $('mz-viewer');
	if (viewer && url) viewer.setAttribute('src', url);
}

// ── printability ────────────────────────────────────────────────────────────

function renderPrintability() {
	const view = printabilityView(state.report);
	if (!view) return;

	const CIRCUMFERENCE = 2 * Math.PI * 19;
	const fill = $('mz-score-fill');
	fill.style.stroke = `var(--mz-${view.tone})`;
	fill.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
	fill.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - view.score / 100)));
	$('mz-score-num').textContent = String(view.score);
	$('mz-score-num').className = `mz-score-num tone-${view.tone}`;
	$('mz-score-label').textContent = view.label;
	$('mz-score-label').className = `mz-score-label tone-${view.tone}`;
	$('mz-score-sub').textContent = view.issues.length
		? `${view.issues.length} thing${view.issues.length === 1 ? '' : 's'} the analyzer flagged`
		: 'Nothing flagged. This mesh is print-ready as it stands.';

	$('mz-printability-meta').textContent = `${(state.report.triangles || 0).toLocaleString()} triangles · report v${state.report.version}`;

	$('mz-facts').innerHTML = view.facts
		.map(
			(f) => `<div class="mz-fact"><dt>${esc(f.label)}</dt><dd class="${f.ok ? '' : 'tone-fair'}">${esc(f.value)}</dd></div>`,
		)
		.join('');

	$('mz-issues').innerHTML = view.issues.length
		? view.issues
				.map(
					(i) => `<li class="mz-issue">
						<span class="mz-issue-dot${i.repairable ? ' is-repairable' : ''}"></span>
						<span><b>${esc(i.label)}</b> ${esc(i.detail)}</span>
					</li>`,
				)
				.join('')
		: '';

	const row = $('mz-repair-row');
	row.hidden = view.repairableCount === 0 || Boolean(state.prepared);
	$('mz-repair-note').textContent = view.repairableCount
		? `${view.repairableCount} of these can be fixed automatically.`
		: '';
	renderRepairMetrics();
}

function renderRepairMetrics() {
	const list = $('mz-repair-metrics');
	const prepared = state.prepared;
	if (!list) return;
	if (!prepared) {
		list.hidden = true;
		list.innerHTML = '';
		return;
	}
	const rows = [
		['Holes closed', prepared.repair.holesFilled],
		['Duplicate vertices merged', prepared.repair.mergedVertices],
		['Sliver triangles removed', prepared.repair.degenerateRemoved + prepared.repair.duplicateRemoved],
		['Faces re-wound', prepared.repair.trianglesFlipped],
		['Printability', `${prepared.before.score} to ${prepared.after.score}`],
		['Solid volume', `${prepared.after.volume_cm3} cm3`],
	];
	if (prepared.hollow.applied) rows.push(['Hollowed', `${prepared.hollow.wallMm} mm wall, ${prepared.hollow.drainHoles} drain holes`]);
	list.hidden = false;
	list.innerHTML = rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(String(v))}</b></li>`).join('');
}

async function runRepair() {
	const button = $('mz-repair');
	button.disabled = true;
	setStageBusy('Repairing the mesh…');
	showStudioError(null);
	try {
		const prepared = await api('/api/print/prepare', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				...(state.source.creationId ? { creationId: state.source.creationId } : { glbUrl: state.source.url }),
				targetHeightMm: state.heightMm,
				materialId: state.materialId,
				hollow: state.hollow,
			}),
		});
		state.prepared = prepared;
		state.report = prepared.after;
		// The repaired solid is what gets printed, so it is what the viewer shows
		// from here on. The buyer approves the object, not the upload.
		showModel(prepared.assets.glb);
		renderPrintability();
		renderMaterials();
		scheduleQuote(0);
	} catch (err) {
		showStudioError(
			err.code === 'storage_unavailable'
				? 'Repairs cannot be written on this deployment right now, so the model is unchanged. The original can still be quoted and ordered.'
				: `The repair did not complete: ${err.message}`,
		);
		button.disabled = false;
	} finally {
		setStageBusy(null);
	}
}

// ── material, size, quote ───────────────────────────────────────────────────

function materialById(id) {
	return state.catalog?.materials?.find((m) => m.id === id) || null;
}

function fitById(id) {
	return state.fits.find((f) => f.id === id) || null;
}

function renderMaterials() {
	const wrap = $('mz-mats');
	if (!wrap || !state.catalog) return;
	wrap.innerHTML = state.catalog.materials
		.map((m) => {
			const fit = fitById(m.id);
			const blocked = fit?.blocked || null;
			const range = fit && !blocked ? `${formatMm(fit.minHeightMm)} to ${formatMm(fit.maxHeightMm)} tall` : '';
			const swatch = swatchStyle(m);
			return `<button type="button" class="mz-mat" data-material="${esc(m.id)}"
				aria-pressed="${state.materialId === m.id}" ${blocked ? 'disabled' : ''}
				title="${esc(blocked || m.blurb)}">
				<span class="mz-mat-swatch" style="${swatch}"></span>
				<span class="mz-mat-name">${esc(m.name)}</span>
				<span class="mz-mat-note">${esc(m.quoteOnRequest ? 'Quoted by an engineer' : range)}</span>
				${blocked ? `<span class="mz-mat-blocked">${esc(blocked)}</span>` : ''}
			</button>`;
		})
		.join('');
	for (const button of wrap.querySelectorAll('[data-material]')) {
		button.addEventListener('click', () => chooseMaterial(button.dataset.material));
	}
}

/** A swatch that reads as the material, built from the catalog's own descriptor. */
function swatchStyle(material) {
	const base = material.swatch?.base || '#999';
	const sheen = material.swatch?.sheen || 'matte';
	if (sheen === 'gloss') return `background: linear-gradient(135deg, #fff 0%, ${base} 42%, #7a7a7a 100%);`;
	if (sheen === 'metal') return `background: linear-gradient(120deg, #f2f4f6 0%, ${base} 30%, #55595e 58%, ${base} 82%);`;
	if (sheen === 'satin') return `background: linear-gradient(140deg, ${base} 0%, #fff2 40%, ${base} 100%);`;
	return `background: ${base};`;
}

function pickInitialMaterial() {
	const usable = state.fits.filter((f) => !f.blocked && !f.quoteOnRequest);
	// Full colour first when the model carries a texture: printing what you see is
	// the thing nobody else does, so it should be the default when it is possible.
	const colour = usable.find((f) => f.class === 'full_color');
	const first = colour || usable.find((f) => f.class === 'resin') || usable[0];
	if (!first) {
		renderQuoteBody(
			`<div class="mz-notice mz-notice-warn"><h3>No material can take this model</h3>
			<p>Every material in the catalog either needs a thicker wall than this mesh has at any printable size, or a smaller footprint than it has. A repair pass thickens thin walls and is the usual fix.</p></div>`,
		);
		return;
	}
	chooseMaterial(first.id);
}

function chooseMaterial(id) {
	const fit = fitById(id);
	if (fit?.blocked) return;
	state.materialId = id;
	state.prepared = state.prepared && state.materialId === id ? state.prepared : state.prepared;

	const material = materialById(id);
	const finishes = material?.finishes || [];
	state.finishId = (finishes.find((f) => f.default) || finishes[0])?.id || null;

	const finishRow = $('mz-finish-row');
	finishRow.hidden = finishes.length < 2;
	$('mz-finish').innerHTML = finishes
		.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}${f.fee ? ` (+${formatUsdc(f.fee)})` : ''}</option>`)
		.join('');
	if (state.finishId) $('mz-finish').value = state.finishId;
	$('mz-finish-note').textContent = material?.blurb || '';

	const hollowLabel = $('mz-hollow-label');
	hollowLabel.hidden = !fit?.hollowSupported;
	if (!fit?.hollowSupported) {
		state.hollow = false;
		$('mz-hollow').checked = false;
	}

	for (const button of $('mz-mats').querySelectorAll('[data-material]')) {
		button.setAttribute('aria-pressed', String(button.dataset.material === id));
	}

	applySliderBounds();
	scheduleQuote(0);
}

function applySliderBounds() {
	const fit = fitById(state.materialId);
	const bounds = sliderBounds(fit);
	const slider = $('mz-size');
	const panel = $('mz-size-panel');
	if (!bounds) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	slider.min = String(bounds.min);
	slider.max = String(bounds.max);
	slider.step = String(bounds.step);
	// Keep the size the buyer chose whenever the new material can hold it, so
	// comparing materials does not silently resize the object.
	state.heightMm = state.heightMm ? clampHeight(state.heightMm, bounds) : defaultHeight(bounds, state.catalog.sizePresets || []);
	slider.value = String(state.heightMm);
	$('mz-size-min').textContent = `${formatMm(bounds.min)} · ${bounds.minNote}`;
	$('mz-size-max').textContent = `${bounds.maxNote} · ${formatMm(bounds.max)}`;

	$('mz-presets').innerHTML = (state.catalog.sizePresets || [])
		.map((p) => {
			const inRange = p.heightMm >= bounds.min && p.heightMm <= bounds.max;
			return `<button type="button" class="mz-chip" data-preset="${p.heightMm}" ${inRange ? '' : 'disabled'}
				aria-pressed="${state.heightMm === p.heightMm}"
				title="${esc(inRange ? p.blurb : `${p.name} is outside what this material can print for this model`)}">
				${esc(p.name)} · ${formatMm(p.heightMm)}
			</button>`;
		})
		.join('');
	for (const chip of $('mz-presets').querySelectorAll('[data-preset]')) {
		chip.addEventListener('click', () => {
			state.heightMm = clampHeight(Number(chip.dataset.preset), bounds);
			$('mz-size').value = String(state.heightMm);
			renderSizeReadout();
			scheduleQuote(0);
		});
	}
	renderSizeReadout();
}

function renderSizeReadout() {
	$('mz-size-value').textContent = formatMm(state.heightMm);
	for (const chip of $('mz-presets').querySelectorAll('[data-preset]')) {
		chip.setAttribute('aria-pressed', String(Number(chip.dataset.preset) === state.heightMm));
	}
	drawScale();
}

// Simple, legible silhouettes. Real proportions matter more than detail here:
// the drawing's job is to answer "how big is that actually" in one glance.
const REFERENCE_ART = {
	coin: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>',
	mug: '<svg viewBox="0 0 24 40" preserveAspectRatio="none" fill="currentColor"><path d="M3 4h14v32H3z"/><path d="M17 12h3a4 4 0 0 1 0 12h-3z" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>',
	hand: '<svg viewBox="0 0 24 44" preserveAspectRatio="none" fill="currentColor"><path d="M6 20V6a2 2 0 1 1 4 0v12h1V3a2 2 0 1 1 4 0v15h1V6a2 2 0 1 1 4 0v20c0 9-4 18-9 18s-9-6-9-13V17a2 2 0 1 1 4 0z"/></svg>',
	person: '<svg viewBox="0 0 24 64" preserveAspectRatio="none" fill="currentColor"><circle cx="12" cy="7" r="6"/><path d="M6 16h12l3 20h-4l-1 28h-3l-1-20h-2l-1 20H6L5 36H1z" transform="translate(1)"/></svg>',
};

function drawScale() {
	const box = $('mz-scale');
	const caption = $('mz-scale-caption');
	if (!box || !state.heightMm || !state.catalog) return;
	const view = scaleReference(state.heightMm, state.catalog.scaleReferences || [], 190);
	if (!view) {
		box.hidden = true;
		caption.textContent = '';
		return;
	}
	box.hidden = false;
	$('mz-scale-bar').style.height = `${view.modelPx}px`;
	const ref = $('mz-scale-ref');
	ref.style.height = `${view.referencePx}px`;
	ref.innerHTML = REFERENCE_ART[view.reference.id] || REFERENCE_ART.mug;
	$('mz-scale-ref-tag').textContent = view.reference.name;
	caption.textContent = view.caption;
}

let quoteTimer = null;
function scheduleQuote(delay = QUOTE_DEBOUNCE_MS) {
	clearTimeout(quoteTimer);
	quoteTimer = setTimeout(requestQuote, delay);
}

async function requestQuote() {
	if (!state.source || !state.materialId || !state.heightMm) return;
	const seq = (state.quoteSeq += 1);
	state.quoting = true;
	$('mz-quote-meta').innerHTML = '<span class="mz-quote-busy"><span class="mz-spinner"></span>Pricing…</span>';

	try {
		const body = await api('/api/print/quote', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				...(state.source.creationId ? { creationId: state.source.creationId } : { glbUrl: state.source.url }),
				materialId: state.materialId,
				finishId: state.finishId,
				targetHeightMm: state.heightMm,
				quantity: state.quantity,
				country: state.country,
				hollow: state.hollow,
			}),
		});
		// A slower earlier request must never overwrite a newer answer.
		if (seq !== state.quoteSeq) return;
		state.quote = body.quote;
		state.token = body.token;
		state.rejection = body.rejection;
		state.fits = body.fits || state.fits;
		applyArScale();
		renderQuote(body);
	} catch (err) {
		if (seq !== state.quoteSeq) return;
		renderQuoteBody(
			`<div class="mz-notice mz-notice-error"><h3>The price could not be refreshed</h3>
			<p>${esc(err.message)}</p>
			<div class="mz-notice-actions"><button type="button" class="mz-btn" id="mz-retry-quote">Try again</button></div></div>`,
		);
		$('mz-retry-quote')?.addEventListener('click', () => scheduleQuote(0));
	} finally {
		if (seq === state.quoteSeq) {
			state.quoting = false;
			$('mz-quote-meta').textContent = state.quote ? `Quoted in ${state.quote.currency} on ${state.quote.chain}` : '';
		}
	}
}

/**
 * Put the object on the buyer's floor at the size they ordered.
 *
 * model-viewer measures AR in glTF units, one unit to the metre, and
 * ar-scale="fixed" stops the viewer resizing what it placed. The factor is the
 * quote's own scale, so what appears on the desk is the object that was priced.
 */
function applyArScale() {
	const viewer = $('mz-viewer');
	const button = $('mz-ar-btn');
	if (!viewer) return;
	const attr = arScaleAttribute(state.quote?.geometry?.scale);
	if (!attr) {
		button.hidden = true;
		return;
	}
	viewer.setAttribute('scale', attr);
	viewer.setAttribute('ar-scale', 'fixed');
	button.hidden = !(viewer.canActivateAR ?? true);
	button.title = `Places it on your floor at ${formatMm(state.heightMm)} tall, the exact size you are ordering.`;
}

function renderQuoteBody(html) {
	$('mz-quote-body').innerHTML = html;
}

function renderQuote(body) {
	if (body.rejection) {
		const view = rejectionView(body.rejection);
		renderQuoteBody(
			`<div class="mz-notice mz-notice-warn">
				<h3>${esc(view.headline)}</h3>
				${view.fixes.map((f) => `<p>${esc(f.fix)}</p>`).join('')}
				<div class="mz-notice-actions">
					${view.offerRepair ? '<button type="button" class="mz-btn" id="mz-fix-repair">Repair this model</button>' : ''}
					${view.alternatives.map((a) => `<button type="button" class="mz-btn" data-switch="${esc(a.id)}">Use ${esc(a.name)}</button>`).join('')}
				</div>
			</div>`,
		);
		$('mz-fix-repair')?.addEventListener('click', runRepair);
		for (const button of $('mz-quote-body').querySelectorAll('[data-switch]')) {
			button.addEventListener('click', () => chooseMaterial(button.dataset.switch));
		}
		return;
	}

	const quote = body.quote;
	if (!quote) return;
	const rows = quoteRows(quote);
	const holderLine = rows.find((r) => r.id === 'holder_discount');

	renderQuoteBody(
		`<ul class="mz-quote-lines">
			${rows
				.map(
					(r) => `<li class="mz-line${r.credit ? ' is-credit' : ''}">
						<span class="mz-line-label">${esc(r.label)}</span>
						<span class="mz-line-amount">${esc(r.amountText)}</span>
						${r.detail ? `<p class="mz-line-detail">${esc(r.detail)}</p>` : ''}
					</li>`,
				)
				.join('')}
		</ul>
		<div class="mz-total">
			<span class="mz-total-label">Total${quote.quoteOnRequest ? ' (estimate)' : ''}</span>
			<span class="mz-total-amount">${esc(formatUsdc(quote.total))} <span style="font-size:13px;font-weight:600;">${esc(quote.currency)}</span></span>
		</div>
		<p class="mz-total-note">${esc(formatLeadTime(quote.leadTimeDays))} · ${esc(formatMm(quote.geometry.boxMm.x, { unit: false }))} x ${esc(formatMm(quote.geometry.boxMm.y, { unit: false }))} x ${esc(formatMm(quote.geometry.boxMm.z))} boxed · ${esc(String(quote.geometry.massGramsEach))} g each</p>
		${
			quote.quoteOnRequest
				? `<div class="mz-notice mz-notice-info" style="margin-top:0.9rem;"><h3>This one is priced by hand</h3><p>Metal is quoted against the actual geometry by an engineer, not by the calculator. The number above is an estimate; ask for a firm quote and we will come back with it.</p></div>
					<a class="mz-btn mz-btn-block mz-btn-primary" style="margin-top:0.85rem;text-align:center;text-decoration:none;display:block;" href="mailto:hello@three.ws?subject=${encodeURIComponent(`Metal print quote request (${quote.material.name}, ${formatMm(state.heightMm)})`)}">Ask for a firm quote</a>`
				: `<button type="button" class="mz-btn mz-btn-primary mz-btn-block" id="mz-checkout" style="margin-top:1rem;">Order it for ${esc(formatUsdc(quote.total))} ${esc(quote.currency)}</button>
					<p class="mz-total-note">${
						holderLine
							? 'Your $THREE holder discount is already applied above.'
							: state.user
								? 'Hold $THREE and a holder discount applies here automatically.'
								: 'Sign in at checkout. Holding $THREE applies a discount to this price.'
					}</p>`
		}`,
	);
	$('mz-checkout')?.addEventListener('click', openCheckout);
}

// ── checkout ────────────────────────────────────────────────────────────────

let sheetReturnFocus = null;

function openSheet(title, subtitle, html) {
	sheetReturnFocus = document.activeElement;
	$('mz-sheet-title').textContent = title;
	$('mz-sheet-sub').textContent = subtitle;
	$('mz-sheet-body').innerHTML = html;
	$('mz-sheet').hidden = false;
	$('mz-sheet-card').querySelector('input, select, button, a')?.focus();
}

function closeSheet() {
	$('mz-sheet').hidden = true;
	$('mz-sheet-body').innerHTML = '';
	sheetReturnFocus?.focus?.();
}

function openCheckout() {
	if (!state.token) return;
	if (!state.user) {
		openSheet(
			'Sign in to order',
			'An order needs somewhere to go and someone to tell when it ships.',
			`<p style="font-size:13.5px;line-height:1.6;color:var(--mz-ink-2);margin:0 0 1rem;">
				Your quote is held for 24 hours. Sign in and you land back here with this exact price, material and size.
			</p>
			<a class="mz-btn mz-btn-primary mz-btn-block" style="text-align:center;text-decoration:none;display:block;" href="/login?next=${encodeURIComponent(location.pathname + location.search)}">Sign in and continue</a>
			<p style="font-size:12px;color:var(--mz-ink-3);margin:0.8rem 0 0;text-align:center;">No account yet? The same link creates one.</p>`,
		);
		return;
	}
	renderShippingStep({});
}

function renderShippingStep(values, errors = {}) {
	const field = (name, label, opts = {}) => {
		const invalid = errors[name] ? ' data-invalid' : '';
		const input = opts.select
			? `<select name="${name}" ${opts.required ? 'required' : ''}>${SHIPPING_COUNTRIES.map((c) => `<option value="${c.code}" ${values[name] === c.code ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
			: `<input name="${name}" type="${opts.type || 'text'}" autocomplete="${opts.autocomplete || 'off'}" value="${esc(values[name] || '')}" ${opts.required ? 'required' : ''} placeholder="${esc(opts.placeholder || '')}" />`;
		return `<label class="mz-input-label"${invalid}>${esc(label)}${input}${errors[name] ? `<span class="mz-error-text">${esc(errors[name])}</span>` : ''}</label>`;
	};

	openSheet(
		'Where should it go?',
		'We keep the minimum a courier needs, and nothing else.',
		`<form class="mz-form" id="mz-ship-form" novalidate>
			${field('name', 'Full name', { required: true, autocomplete: 'name' })}
			${field('line1', 'Street address', { required: true, autocomplete: 'address-line1' })}
			${field('line2', 'Apartment, suite, floor (optional)', { autocomplete: 'address-line2' })}
			<div class="mz-grid-2">
				${field('city', 'City', { required: true, autocomplete: 'address-level2' })}
				${field('region', 'State or region (optional)', { autocomplete: 'address-level1' })}
			</div>
			<div class="mz-grid-2">
				${field('postal_code', 'Postal code', { required: true, autocomplete: 'postal-code' })}
				${field('country', 'Country', { required: true, select: true })}
			</div>
			${field('phone', 'Phone for the courier (optional)', { type: 'tel', autocomplete: 'tel' })}
			<div class="mz-notice mz-notice-info" id="mz-ship-error" hidden role="alert"></div>
			<button type="submit" class="mz-btn mz-btn-primary mz-btn-block">Continue to payment</button>
			<p style="font-size:11.5px;color:var(--mz-ink-3);margin:0;text-align:center;">
				Changing the country re-prices shipping before you pay.
			</p>
		</form>`,
	);

	const form = $('mz-ship-form');
	form.querySelector('[name="country"]').value = values.country || state.country;
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const data = Object.fromEntries(new FormData(form).entries());
		const check = validateShipping(data);
		if (!check.valid) {
			renderShippingStep(data, check.errors);
			return;
		}
		// The quote was priced for a destination. If the buyer typed a different
		// country than the one the quote used, re-price before charging rather
		// than shipping a mismatch to the server for a 422.
		if (data.country !== state.quote.country) {
			state.country = data.country;
			$('mz-country').value = data.country;
			openSheet('Re-pricing for that destination…', 'Shipping is zone-based, so the total moves with the country.', '<div class="mz-quote-busy"><span class="mz-spinner"></span>One moment.</div>');
			await requestQuote();
			if (!state.token) {
				renderShippingStep(data, { country: 'That destination could not be priced. Pick another country.' });
				return;
			}
		}
		submitOrder(data);
	});
}

async function submitOrder(shipping) {
	openSheet('Opening your order…', 'Locking the quoted price against a signed token.', '<div class="mz-quote-busy"><span class="mz-spinner"></span>One moment.</div>');
	try {
		const token = await csrfToken();
		const result = await api('/api/print/orders', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-csrf-token': token },
			body: JSON.stringify({ token: state.token, shipping }),
		});
		renderPaymentStep(result);
	} catch (err) {
		if (err.code === 'quote_invalid') {
			openSheet(
				'That quote expired',
				'Prices are held for 24 hours so they cannot drift between the quote and the charge.',
				`<p style="font-size:13.5px;line-height:1.6;color:var(--mz-ink-2);">Nothing was charged. Refresh the price and your order continues from there.</p>
				<button type="button" class="mz-btn mz-btn-primary mz-btn-block" id="mz-refresh-quote">Refresh the price</button>`,
			);
			$('mz-refresh-quote')?.addEventListener('click', async () => {
				closeSheet();
				await requestQuote();
			});
			return;
		}
		openSheet(
			'The order could not be opened',
			'Nothing was charged.',
			`<div class="mz-notice mz-notice-error"><p>${esc(err.message)}</p></div>
			<button type="button" class="mz-btn mz-btn-block" id="mz-order-back" style="margin-top:0.9rem;">Back to the address</button>`,
		);
		$('mz-order-back')?.addEventListener('click', () => renderShippingStep(shipping));
	}
}

function renderPaymentStep(result) {
	const { order, payment } = result;
	openSheet(
		'Pay in USDC on Solana',
		'The amount is fixed by the quote you approved.',
		`<div class="mz-pay-summary">
			<div><span>Order</span><span class="mz-mono">${esc(order.id.slice(0, 8))}</span></div>
			<div><span>Lead time</span><span>${esc(formatLeadTime(order.lead_time_days))}</span></div>
			<div class="mz-pay-total"><span>Amount</span><span>${esc(payment.amount)} USDC</span></div>
		</div>
		<a class="mz-btn mz-btn-primary mz-btn-block" style="text-align:center;text-decoration:none;display:block;" href="${esc(payment.url)}">Open your wallet</a>
		<canvas class="mz-qr" id="mz-qr" width="240" height="240" aria-label="Solana Pay QR code"></canvas>
		<p style="font-size:12.5px;color:var(--mz-ink-3);text-align:center;margin:0 0 0.9rem;">
			Or scan with a Solana Pay wallet on your phone.
		</p>
		<div class="mz-quote-busy" id="mz-pay-status" style="justify-content:center;"><span class="mz-spinner"></span>Waiting for the payment to land…</div>
		<p style="font-size:11.5px;color:var(--mz-ink-3);text-align:center;margin:0.9rem 0 0;">
			This page watches the chain for you. You can also
			<a href="${esc(result.track_url)}" style="color:inherit;">follow the order</a> and come back.
		</p>`,
	);

	drawQr(payment.url);
	pollPayment(order.id, result.track_url);
}

async function drawQr(url) {
	const canvas = $('mz-qr');
	if (!canvas) return;
	try {
		const mod = await import('qrcode');
		await (mod.default ?? mod).toCanvas(canvas, url, { width: 240, margin: 1 });
	} catch {
		// Without the QR the wallet button above still completes the payment, so
		// the step stays usable rather than blocking on a failed chunk load.
		canvas.replaceWith(
			Object.assign(document.createElement('p'), {
				className: 'mz-mono',
				style: 'text-align:center;margin:0.9rem 0;',
				textContent: url,
			}),
		);
	}
}

async function pollPayment(orderId, trackUrl) {
	const started = Date.now();
	const status = $('mz-pay-status');
	while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
		await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
		if ($('mz-sheet').hidden) return;
		try {
			const body = await api(`/api/print/orders/${orderId}/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() },
			});
			if (body?.status === 'confirmed' || body?.order?.status === 'paid' || body?.order?.status === 'screening') {
				renderPaidStep(trackUrl);
				return;
			}
			if (body?.status === 'mismatch') {
				status.innerHTML = `<span class="tone-fair">A payment landed but not for the quoted amount. Our team is looking at it and will reach you at the address on the order.</span>`;
				return;
			}
		} catch (err) {
			if (err.status === 404 || err.status === 401) {
				status.innerHTML = `<span class="tone-fair">We lost track of this order in the browser. <a href="${esc(trackUrl)}" style="color:inherit;">Open its page</a> to continue.</span>`;
				return;
			}
			// A transient RPC or network blip is expected while a payment settles;
			// the loop simply tries again on the next tick.
		}
	}
	status.innerHTML = `<span>Still waiting. <a href="${esc(trackUrl)}" style="color:inherit;">Open the order page</a> and it will update there when the payment confirms.</span>`;
}

function renderPaidStep(trackUrl) {
	openSheet(
		'Paid. It goes into production.',
		'',
		`<div class="mz-success-mark">
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5" /></svg>
		</div>
		<p style="font-size:13.5px;line-height:1.6;color:var(--mz-ink-2);text-align:center;margin:0 0 1rem;">
			Your USDC settled on Solana and the order is being screened for fabrication now.
			Every step from here writes to the order's timeline, so you can watch it print and ship.
		</p>
		<p style="font-size:13px;line-height:1.6;color:var(--mz-ink-2);text-align:center;margin:0 0 1.2rem;">
			When it ships, the package carries a certificate linking the physical object back to the exact
			model it was printed from, attested on Solana.
		</p>
		<a class="mz-btn mz-btn-primary mz-btn-block" style="text-align:center;text-decoration:none;display:block;" href="${esc(trackUrl)}">Follow this order</a>`,
	);
}

boot();
