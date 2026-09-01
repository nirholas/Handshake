/**
 * /drops - the generative 3D collection index and launcher.
 *
 * Two jobs on one page: list the live collections, and let a signed-in creator
 * define and roll a new one. The launcher is a real form over
 * POST /api/drops/create; the trait-layer builder below is the only part with
 * meaningful state, and it is kept as a plain array of {name, options[]} that is
 * serialized on submit rather than a reactive model, because the server
 * normalizes and validates the same shape anyway.
 */

const grid = document.getElementById('dr-grid');
const stateEl = document.getElementById('dr-state');
const countEl = document.getElementById('dr-count');
const form = document.getElementById('dr-launcher');
const toggle = document.getElementById('dr-launch-toggle');
const layersEl = document.getElementById('dr-layers');
const noteEl = document.getElementById('dr-form-note');

// A first-run layer set, so the builder opens on something a creator can edit
// rather than an empty box that gives no hint of the shape expected.
const STARTER_LAYERS = [
	{ name: 'Species', options: [{ value: 'Fox', weight: 60 }, { value: 'Wolf', weight: 30 }, { value: 'Dragon', weight: 10 }] },
	{ name: 'Outfit', options: [{ value: 'Bomber jacket', weight: 50 }, { value: 'Lab coat', weight: 50 }] },
	{ name: 'Aura', options: [{ value: 'None', weight: 70 }, { value: 'Ember', weight: 20 }, { value: 'Frost', weight: 10 }] },
];

let layers = STARTER_LAYERS.map((l) => ({ name: l.name, options: l.options.map((o) => ({ ...o })) }));

/* ── list ─────────────────────────────────────────────────────────────── */

function skeletons(n = 6) {
	grid.innerHTML = '';
	for (let i = 0; i < n; i++) {
		const div = document.createElement('div');
		div.className = 'dr-skeleton';
		grid.appendChild(div);
	}
}

async function loadDrops() {
	skeletons();
	stateEl.innerHTML = '';
	try {
		const res = await fetch('/api/drops/list?limit=24', { headers: { accept: 'application/json' } });
		if (res.status === 503) return renderUnavailable();
		if (!res.ok) throw new Error(`the collection index returned ${res.status}`);
		const data = await res.json();
		renderDrops(Array.isArray(data.drops) ? data.drops : []);
	} catch (err) {
		renderError(err?.message || 'could not reach the collection index');
	} finally {
		grid.setAttribute('aria-busy', 'false');
	}
}

function renderDrops(drops) {
	grid.innerHTML = '';
	countEl.textContent = drops.length ? `${drops.length} collection${drops.length === 1 ? '' : 's'}` : '';

	if (!drops.length) {
		stateEl.innerHTML = '';
		const empty = document.createElement('div');
		empty.className = 'dr-empty';
		empty.innerHTML = `
			<h3>No collections launched yet</h3>
			<p>
				Be the first. Pick a style, define a few trait layers, and roll a supply.
				The whole collection exists the moment you submit; art is forged per item as it reveals.
			</p>`;
		const cta = document.createElement('button');
		cta.type = 'button';
		cta.className = 'dr-btn dr-btn-primary';
		cta.textContent = 'Launch a collection';
		cta.addEventListener('click', () => openLauncher(true));
		empty.appendChild(cta);
		stateEl.appendChild(empty);
		return;
	}

	for (const drop of drops) grid.appendChild(cardFor(drop));
}

function cardFor(drop) {
	const revealed = Number(drop.revealed_count) || 0;
	const supply = Number(drop.supply) || 0;
	const pct = supply ? Math.round((revealed / supply) * 100) : 0;

	const a = document.createElement('a');
	a.className = 'dr-card';
	a.href = `/drops/${encodeURIComponent(drop.slug)}`;

	const art = document.createElement('div');
	art.className = 'dr-card-art';
	art.setAttribute('aria-hidden', 'true');
	art.textContent = drop.symbol || '3D';
	art.style.fontFamily = 'var(--font-mono)';
	art.style.letterSpacing = '0.12em';
	art.style.color = 'var(--text-muted, rgba(255,255,255,0.4))';

	const body = document.createElement('div');
	body.className = 'dr-card-body';

	const name = document.createElement('div');
	name.className = 'dr-card-name';
	name.textContent = drop.name;

	const meta = document.createElement('div');
	meta.className = 'dr-card-meta';
	meta.innerHTML = `<span>${drop.symbol}</span><span aria-hidden="true">·</span><span>${supply.toLocaleString()} supply</span>`;
	if (drop.status !== 'live') {
		const status = document.createElement('span');
		status.className = 'dr-status';
		status.textContent = drop.status;
		meta.append(document.createTextNode(' '), status);
	}

	const desc = document.createElement('p');
	desc.className = 'dr-card-desc';
	desc.textContent = drop.description || drop.style;

	const meter = document.createElement('div');
	meter.className = 'dr-meter';
	meter.setAttribute('role', 'progressbar');
	meter.setAttribute('aria-valuemin', '0');
	meter.setAttribute('aria-valuemax', String(supply));
	meter.setAttribute('aria-valuenow', String(revealed));
	meter.setAttribute('aria-label', `${revealed} of ${supply} revealed`);
	const fill = document.createElement('div');
	fill.className = 'dr-meter-fill';
	fill.style.width = `${pct}%`;
	meter.appendChild(fill);

	const foot = document.createElement('div');
	foot.className = 'dr-card-meta';
	foot.textContent = `${revealed.toLocaleString()} of ${supply.toLocaleString()} revealed`;

	body.append(name, meta, desc, meter, foot);
	a.append(art, body);
	return a;
}

function renderError(message) {
	grid.innerHTML = '';
	countEl.textContent = '';
	stateEl.innerHTML = '';
	const box = document.createElement('div');
	box.className = 'dr-error';
	const h = document.createElement('h3');
	h.textContent = 'Could not load collections';
	const p = document.createElement('p');
	p.textContent = message;
	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = 'dr-btn';
	retry.textContent = 'Try again';
	retry.addEventListener('click', loadDrops);
	box.append(h, p, retry);
	stateEl.appendChild(box);
}

function renderUnavailable() {
	grid.innerHTML = '';
	stateEl.innerHTML = '';
	const box = document.createElement('div');
	box.className = 'dr-empty';
	box.innerHTML = `
		<h3>Drops are not enabled here</h3>
		<p>This deployment has no database configured, so collections cannot be stored. The rest of the platform is unaffected.</p>`;
	stateEl.appendChild(box);
}

/* ── launcher ─────────────────────────────────────────────────────────── */

function openLauncher(open) {
	form.hidden = !open;
	toggle.setAttribute('aria-expanded', String(open));
	if (open) {
		renderLayers();
		document.getElementById('dr-name')?.focus();
		form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}
}

function renderLayers() {
	layersEl.innerHTML = '';
	layers.forEach((layer, li) => layersEl.appendChild(layerRow(layer, li)));
}

function layerRow(layer, li) {
	const wrap = document.createElement('div');
	wrap.className = 'dr-layer';

	const head = document.createElement('div');
	head.className = 'dr-layer-head';

	const nameInput = document.createElement('input');
	nameInput.className = 'dr-input';
	nameInput.value = layer.name;
	nameInput.maxLength = 40;
	nameInput.placeholder = 'Layer name (Species, Outfit, Aura)';
	nameInput.setAttribute('aria-label', `Name of trait layer ${li + 1}`);
	nameInput.addEventListener('input', () => {
		layer.name = nameInput.value;
	});

	const remove = document.createElement('button');
	remove.type = 'button';
	remove.className = 'dr-icon-btn';
	remove.textContent = '×';
	remove.title = 'Remove this layer';
	remove.setAttribute('aria-label', `Remove trait layer ${li + 1}`);
	remove.addEventListener('click', () => {
		layers.splice(li, 1);
		renderLayers();
	});

	head.append(nameInput, remove);
	wrap.appendChild(head);

	layer.options.forEach((option, oi) => wrap.appendChild(optionRow(layer, option, oi, li)));

	const add = document.createElement('button');
	add.type = 'button';
	add.className = 'dr-btn dr-btn-sm';
	add.textContent = 'Add option';
	add.addEventListener('click', () => {
		layer.options.push({ value: '', weight: 10 });
		renderLayers();
	});
	wrap.appendChild(add);

	const total = layer.options.reduce((n, o) => n + (Number(o.weight) || 0), 0);
	const hint = document.createElement('p');
	hint.className = 'dr-hint';
	hint.style.marginTop = '8px';
	hint.textContent = total
		? `Weights are relative. ${layer.options
				.filter((o) => o.value)
				.map((o) => `${o.value} ${Math.round(((Number(o.weight) || 0) / total) * 100)}%`)
				.join(', ')}`
		: 'Add at least one option with a weight above zero.';
	wrap.appendChild(hint);

	return wrap;
}

function optionRow(layer, option, oi, li) {
	const row = document.createElement('div');
	row.className = 'dr-option';

	const value = document.createElement('input');
	value.className = 'dr-input';
	value.value = option.value;
	value.maxLength = 60;
	value.placeholder = 'Trait value';
	value.setAttribute('aria-label', `Value of option ${oi + 1} in layer ${li + 1}`);
	value.addEventListener('input', () => {
		option.value = value.value;
	});

	const weight = document.createElement('input');
	weight.className = 'dr-input';
	weight.type = 'number';
	weight.min = '1';
	weight.step = '1';
	weight.value = String(option.weight);
	weight.setAttribute('aria-label', `Weight of option ${oi + 1} in layer ${li + 1}`);
	weight.addEventListener('input', () => {
		option.weight = Number(weight.value) || 0;
	});
	weight.addEventListener('change', renderLayers);

	const remove = document.createElement('button');
	remove.type = 'button';
	remove.className = 'dr-icon-btn';
	remove.textContent = '×';
	remove.title = 'Remove this option';
	remove.setAttribute('aria-label', `Remove option ${oi + 1} from layer ${li + 1}`);
	remove.addEventListener('click', () => {
		layer.options.splice(oi, 1);
		renderLayers();
	});

	row.append(value, weight, remove);
	return row;
}

function setNote(message, kind) {
	noteEl.textContent = message || '';
	noteEl.className = `dr-note${kind ? ` dr-note--${kind}` : ''}`;
}

async function submitDrop(event) {
	event.preventDefault();
	const submit = document.getElementById('dr-submit');

	const cleaned = layers
		.map((l) => ({
			name: String(l.name || '').trim(),
			options: l.options
				.filter((o) => String(o.value || '').trim())
				.map((o) => ({ value: String(o.value).trim(), weight: Number(o.weight) || 1 })),
		}))
		.filter((l) => l.name && l.options.length);

	if (!cleaned.length) {
		setNote('Add at least one trait layer with a named option before rolling.', 'error');
		return;
	}

	const payload = {
		name: document.getElementById('dr-name').value.trim(),
		symbol: document.getElementById('dr-symbol').value.trim().toUpperCase(),
		style: document.getElementById('dr-style').value.trim(),
		description: document.getElementById('dr-description').value.trim() || undefined,
		supply: Number(document.getElementById('dr-supply').value),
		layers: cleaned,
	};

	const combos = cleaned.reduce((n, l) => n * l.options.length, 1);
	if (combos < payload.supply) {
		setNote(
			`These layers can only produce ${combos.toLocaleString()} distinct combinations for a supply of ${payload.supply.toLocaleString()}. Duplicates are allowed, but adding options or layers gives the rarity curve more to work with.`,
			'',
		);
	} else {
		setNote('Rolling the supply...', '');
	}

	submit.disabled = true;
	try {
		const res = await fetch('/api/drops/create', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(payload),
		});
		const data = await res.json().catch(() => ({}));

		if (res.status === 401) {
			setNote('Sign in to launch a collection.', 'error');
			return;
		}
		if (!res.ok) {
			setNote(data?.message || `The launcher returned ${res.status}.`, 'error');
			return;
		}

		setNote(`Rolled ${data.drop.supply.toLocaleString()} items. Opening the collection...`, 'ok');
		window.location.href = `/drops/${encodeURIComponent(data.drop.slug)}`;
	} catch (err) {
		setNote(err?.message || 'Could not reach the launcher.', 'error');
	} finally {
		submit.disabled = false;
	}
}

/* ── wire ─────────────────────────────────────────────────────────────── */

toggle?.addEventListener('click', () => openLauncher(form.hidden));
document.getElementById('dr-cancel')?.addEventListener('click', () => openLauncher(false));
document.getElementById('dr-add-layer')?.addEventListener('click', () => {
	layers.push({ name: '', options: [{ value: '', weight: 10 }] });
	renderLayers();
});
form?.addEventListener('submit', submitDrop);

// Escape closes the launcher, matching every other overlay on the platform.
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && !form.hidden) openLauncher(false);
});

loadDrops();
