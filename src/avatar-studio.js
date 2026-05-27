/**
 * Avatar Studio — /create/studio
 *
 * Build a custom 3D avatar from a base template without needing a selfie.
 * Loads the base GLB, lets the user sculpt face/body morphs, pick outfits
 * and accessories, then saves the result to their account (upload base GLB +
 * create avatar record + PATCH appearance for server-side bake).
 *
 * Reuses the same building blocks as avatar-edit.js:
 *   - TalkScene for the 3D viewport
 *   - AccessoryManager for outfit/accessory application
 *   - renderSculptPanel from avatar-sculpt.js for face/body morphs
 *   - IdleAnimation for ambient breathing/blinking
 *
 * The save flow mirrors create.js → create-review.js: upload the base GLB
 * via presign + direct R2 PUT, create the avatar record, then PATCH it with
 * the appearance JSON so the server bakes a canonical GLB.
 */

import { TalkScene } from './voice/talk-scene.js';
import { AccessoryManager } from './agent-accessories.js';
import { IdleAnimation } from './idle-animation.js';
import { renderSculptPanel, applyMorphsToRoot } from './avatar-sculpt.js';
import { saveRemoteGlbToAccount, apiFetch } from './account.js';
import { uploadAvatarSnapshot } from './voice/avatar-snapshot.js';

const BASE_GLB_URL = '/avatars/default.glb';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

// ── State ────────────────────────────────────────────────────────────

let scene = null;
let accessoryManager = null;
let idle = null;
let presets = [];
let presetsById = new Map();

let workingAppearance = { outfit: null, accessories: [], morphs: {} };
let previewedId = null;
let previewToken = 0;
let opQueue = Promise.resolve();
let searchQuery = '';
let bodyType = 'male';

function queueOp(fn) {
	const next = opQueue.then(fn).catch((err) => {
		console.warn('[avatar-studio] queued op failed:', err);
	});
	opQueue = next;
	return next;
}

const TABS = [
	{ id: 'outfit', label: 'Outfits', kinds: ['outfit'], emoji: '👕', single: true },
	{ id: 'hat', label: 'Hats', kinds: ['hat'], emoji: '🎩', single: true },
	{ id: 'glasses', label: 'Glasses', kinds: ['glasses'], emoji: '🕶️', single: true },
	{ id: 'earrings', label: 'Earrings', kinds: ['earrings'], emoji: '💎', single: false },
	{ id: 'sculpt', label: 'Sculpt', kinds: [], emoji: '✨', single: true, sculpt: true },
];
const KIND_EMOJI = { outfit: '👕', hat: '🎩', glasses: '🕶️', earrings: '💎' };
const KIND_LABEL = { outfit: 'Outfit', hat: 'Hat', glasses: 'Glasses', earrings: 'Earrings' };
let activeTab = 'outfit';

// ── Init ─────────────────────────────────────────────────────────────

init().catch((err) => {
	console.error('[avatar-studio] init', err);
	$('as-shell').innerHTML = `<div class="as-error">${esc(err.message || 'Failed to load')}</div>`;
});

async function init() {
	const scenePromise = bootScene();

	presets = await fetchPresets();
	presetsById = new Map(presets.map((p) => [p.id, p]));

	renderTabs();
	renderChips();
	renderActivePanel();
	bindHeader();
	bindBodyType();

	await scenePromise;
}

async function bootScene() {
	scene = new TalkScene();
	try {
		await scene.mount({
			container: $('as-stage'),
			glbUrl: BASE_GLB_URL,
		});
		$('as-loading')?.remove();
		accessoryManager = new AccessoryManager({
			content: scene.root,
			invalidate: () => {},
		});

		idle = new IdleAnimation({
			getRoot: () => scene.root,
			seed: 'avatar-studio',
		});
		scene.addOnTick((dt) => idle.update(dt));

		setStatus('', 'Choose a style below to get started.');
	} catch (err) {
		const loadingEl = $('as-loading');
		if (loadingEl) loadingEl.textContent = `Could not load base avatar: ${err.message}`;
	}
}

// ── API ──────────────────────────────────────────────────────────────

async function fetchPresets() {
	const r = await fetch('/accessories/presets.json');
	if (!r.ok) throw new Error(`Could not load presets (${r.status})`);
	return r.json();
}

// ── Rendering ────────────────────────────────────────────────────────

function renderTabs() {
	const el = $('as-tabs');
	el.innerHTML = TABS.map(
		(t) => `
			<button class="as-tab${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}" role="tab">
				${t.label}
			</button>
		`,
	).join('');
	el.querySelectorAll('.as-tab').forEach((btn) => {
		btn.addEventListener('click', () => {
			activeTab = btn.dataset.tab;
			searchQuery = '';
			el.querySelectorAll('.as-tab').forEach((b) => b.classList.toggle('active', b === btn));
			renderActivePanel();
		});
	});
}

function renderActivePanel() {
	const tab = TABS.find((t) => t.id === activeTab);
	const panel = $('as-panel');

	if (tab.sculpt) {
		if (!scene?.root) {
			panel.innerHTML = `<div class="as-empty">Waiting for avatar to load...</div>`;
			return;
		}
		renderSculptPanel({
			container: panel,
			root: scene.root,
			working: workingAppearance,
			onDirty: () => {
				renderChips();
			},
		});
		return;
	}

	const q = searchQuery.trim().toLowerCase();
	const items = presets.filter(
		(p) => tab.kinds.includes(p.kind) && (!q || p.name.toLowerCase().includes(q)),
	);

	const searchHtml = `
		<div class="as-search-wrap">
			<input class="as-search" id="as-search" type="search"
			       placeholder="Search ${esc(tab.label.toLowerCase())}..."
			       value="${esc(searchQuery)}" autocomplete="off" />
		</div>`;

	if (items.length === 0 && q) {
		panel.innerHTML = searchHtml + `<div class="as-empty">No matches for "${esc(searchQuery)}".</div>`;
		bindSearch();
		return;
	}

	const tiles = [];
	if (!q) {
		tiles.push(`
			<button class="as-tile as-tile-none${tileSelected(tab, null) ? ' selected' : ''}"
			        type="button" data-id="" data-kind="${tab.id}">
				<div class="as-tile-preview" aria-hidden="true">∅</div>
				<div class="as-tile-name">None</div>
				<div class="as-tile-kind">remove</div>
			</button>
		`);
	}
	for (const p of items) {
		const previewing = previewedId === p.id;
		const selected = tileSelected(tab, p.id);
		tiles.push(`
			<button class="as-tile${selected ? ' selected' : ''}${previewing ? ' previewing' : ''}"
			        type="button" data-id="${esc(p.id)}" data-kind="${tab.id}">
				<div class="as-tile-preview" aria-hidden="true">
					${tilePreviewMarkup(p)}
				</div>
				<div class="as-tile-name">${esc(p.name)}</div>
				<div class="as-tile-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</div>
			</button>
		`);
	}

	panel.innerHTML = searchHtml + `<div class="as-grid">${tiles.join('')}</div>`;
	bindSearch();
	bindTiles(panel, tab);
}

function tilePreviewMarkup(preset) {
	const emoji = KIND_EMOJI[preset.kind] || '◇';
	if (!preset.thumbnail) return emoji;
	return `
		<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${emoji}</span>
		<img src="${esc(preset.thumbnail)}" alt="" loading="lazy"
		     style="position:absolute;inset:0;"
		     onerror="this.remove()" />
	`;
}

function bindSearch() {
	const input = $('as-search');
	if (!input) return;
	input.addEventListener('input', (e) => {
		searchQuery = e.target.value;
		renderActivePanel();
		const next = $('as-search');
		if (next) {
			next.focus();
			next.setSelectionRange(searchQuery.length, searchQuery.length);
		}
	});
}

function bindTiles(panel, tab) {
	panel.querySelectorAll('.as-tile').forEach((btn) => {
		const presetId = btn.dataset.id;
		btn.addEventListener('click', () => onTileClick(tab, presetId));
		if (!presetId) return;
		btn.addEventListener('mouseenter', () => onTileHover(tab, presetId));
		btn.addEventListener('mouseleave', () => onTileLeave());
		btn.addEventListener('focus', () => onTileHover(tab, presetId));
		btn.addEventListener('blur', () => onTileLeave());
	});
}

function renderChips() {
	const el = $('as-chips');
	const picks = [];
	if (workingAppearance.outfit) picks.push(workingAppearance.outfit);
	for (const id of workingAppearance.accessories) picks.push(id);

	el.innerHTML = picks
		.map((id) => {
			const p = presetsById.get(id);
			if (!p) return '';
			return `
				<span class="as-chip" data-id="${esc(id)}">
					<span class="as-chip-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
					<span>${esc(p.name)}</span>
					<button type="button" aria-label="Remove ${esc(p.name)}" data-remove="${esc(id)}">×</button>
				</span>
			`;
		})
		.join('');

	el.querySelectorAll('button[data-remove]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			await removeCommitted(btn.dataset.remove);
		});
	});
}

function tileSelected(tab, presetId) {
	if (tab.kinds.includes('outfit')) {
		return presetId
			? workingAppearance.outfit === presetId
			: !workingAppearance.outfit;
	}
	const matching = workingAppearance.accessories.filter((id) => {
		const preset = presetsById.get(id);
		return preset && tab.kinds.includes(preset.kind);
	});
	if (!presetId) return matching.length === 0;
	return matching.includes(presetId);
}

// ── Hover preview ────────────────────────────────────────────────────

function onTileHover(tab, presetId) {
	if (isCommitted(presetId)) {
		previewedId = null;
		return;
	}
	if (previewedId === presetId) return;
	previewedId = presetId;
	highlightPreviewingTile(presetId);

	const myToken = ++previewToken;
	const preset = presetsById.get(presetId);
	if (!preset) return;

	if (!accessoryManager) {
		setStatus('', `${preset.name} · waiting for avatar to load...`);
		return;
	}

	queueOp(async () => {
		if (myToken !== previewToken) return;
		await accessoryManager.applyPreset(preset);
		if (myToken === previewToken) {
			setStatus('', `Previewing ${preset.name} · click to keep`);
		}
	});
}

function onTileLeave() {
	if (!previewedId) return;
	const leavingId = previewedId;
	previewedId = null;
	const myToken = ++previewToken;
	highlightPreviewingTile(null);

	if (isCommitted(leavingId)) {
		setStatusDefault();
		return;
	}

	const preset = presetsById.get(leavingId);
	if (!preset) {
		setStatusDefault();
		return;
	}

	queueOp(async () => {
		if (myToken !== previewToken) return;
		if (!accessoryManager) {
			setStatusDefault();
			return;
		}
		accessoryManager.removePreset(leavingId);
		if (preset.kind !== 'earrings') {
			const committedInSlot = committedIdForKind(preset.kind);
			if (committedInSlot && committedInSlot !== leavingId) {
				const restore = presetsById.get(committedInSlot);
				if (restore) await accessoryManager.applyPreset(restore);
			}
		}
		if (myToken === previewToken) setStatusDefault();
	});
}

function highlightPreviewingTile(id) {
	document.querySelectorAll('.as-tile.previewing').forEach((el) => el.classList.remove('previewing'));
	if (!id) return;
	const el = document.querySelector(`.as-tile[data-id="${cssEscape(id)}"]`);
	el?.classList.add('previewing');
}

function cssEscape(s) {
	return String(s).replace(/["\\]/g, '\\$&');
}

function isCommitted(presetId) {
	if (!presetId) return false;
	return (
		workingAppearance.outfit === presetId ||
		workingAppearance.accessories.includes(presetId)
	);
}

function committedIdForKind(kind) {
	if (kind === 'outfit') return workingAppearance.outfit || null;
	for (const id of workingAppearance.accessories) {
		const p = presetsById.get(id);
		if (p && p.kind === kind) return id;
	}
	return null;
}

// ── Commit / remove ──────────────────────────────────────────────────

async function onTileClick(tab, presetId) {
	previewedId = null;
	previewToken++;

	await queueOp(async () => {
		if (tab.kinds.includes('outfit')) {
			await applyOutfit(presetId || null);
		} else {
			await applyAccessory(tab, presetId || null);
		}
	});
	renderActivePanel();
	renderChips();
}

async function removeCommitted(id) {
	const preset = presetsById.get(id);
	if (!preset) return;
	previewedId = null;
	previewToken++;
	await queueOp(async () => {
		accessoryManager?.removePreset(id);
	});
	if (workingAppearance.outfit === id) {
		workingAppearance.outfit = null;
	} else {
		workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
	}
	renderActivePanel();
	renderChips();
}

async function applyOutfit(presetId) {
	if (!presetId) {
		if (workingAppearance.outfit) accessoryManager?.removePreset(workingAppearance.outfit);
		workingAppearance.outfit = null;
		return;
	}
	const preset = presetsById.get(presetId);
	if (!preset) return;
	if (accessoryManager) await accessoryManager.applyPreset(preset);
	workingAppearance.outfit = presetId;
}

async function applyAccessory(tab, presetId) {
	const inSlot = workingAppearance.accessories.filter((id) => {
		const p = presetsById.get(id);
		return p && tab.kinds.includes(p.kind);
	});

	if (!presetId) {
		for (const id of inSlot) {
			accessoryManager?.removePreset(id);
			workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
		}
		return;
	}

	if (tab.single) {
		for (const id of inSlot) {
			if (id === presetId) continue;
			accessoryManager?.removePreset(id);
			workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
		}
		const preset = presetsById.get(presetId);
		if (preset && accessoryManager) await accessoryManager.applyPreset(preset);
		if (!workingAppearance.accessories.includes(presetId)) {
			workingAppearance.accessories.push(presetId);
		}
		return;
	}

	if (inSlot.includes(presetId)) {
		accessoryManager?.removePreset(presetId);
		workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== presetId);
		return;
	}
	const preset = presetsById.get(presetId);
	if (preset && accessoryManager) await accessoryManager.applyPreset(preset);
	if (!workingAppearance.accessories.includes(presetId)) {
		workingAppearance.accessories.push(presetId);
	}
}

// ── Header / body type / status ──────────────────────────────────────

function bindHeader() {
	$('as-save').addEventListener('click', () => saveAvatar());
	$('as-reset').addEventListener('click', () => resetAll());
}

function bindBodyType() {
	const btns = document.querySelectorAll('.as-body-toggle button[data-body]');
	btns.forEach((btn) => {
		btn.addEventListener('click', () => {
			bodyType = btn.dataset.body;
			btns.forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
		});
	});
}

async function resetAll() {
	previewedId = null;
	previewToken++;
	await queueOp(async () => {
		const wasIds = [
			workingAppearance.outfit,
			...workingAppearance.accessories,
		].filter(Boolean);
		if (accessoryManager) {
			for (const id of wasIds) accessoryManager.removePreset(id);
		}
		workingAppearance = { outfit: null, accessories: [], morphs: {} };
		if (scene?.root) {
			applyMorphsToRoot(scene.root, {});
		}
		if (accessoryManager) await accessoryManager.hydrateFromAppearance(workingAppearance);
	});
	renderChips();
	renderActivePanel();
	setStatus('', 'Reset to default.');
}

function setStatusDefault() {
	setStatus('', 'Hover any item to try it on. Click to keep.');
}

function setStatus(kind, text) {
	const el = $('as-status');
	el.className = `as-status${kind ? ' ' + kind : ''}`;
	el.innerHTML = kind === 'spin' ? `<span class="spin"></span>${esc(text)}` : esc(text);
}

// ── Save flow ────────────────────────────────────────────────────────

function collapseAppearance(a) {
	const out = {};
	if (a.outfit) out.outfit = a.outfit;
	if (a.accessories?.length) out.accessories = [...a.accessories];
	if (a.morphs && Object.keys(a.morphs).length) out.morphs = { ...a.morphs };
	return Object.keys(out).length ? out : null;
}

function showSaveOverlay(label, sublabel) {
	let el = document.getElementById('as-save-overlay');
	if (!el) {
		el = document.createElement('div');
		el.id = 'as-save-overlay';
		el.className = 'as-save-overlay';
		el.innerHTML = `
			<div class="spin-lg"></div>
			<div class="as-save-label"></div>
			<div class="as-save-sublabel"></div>
			<div class="as-progress-bar"><div class="as-progress-fill" id="as-progress-fill"></div></div>
		`;
		document.body.appendChild(el);
	}
	el.querySelector('.as-save-label').textContent = label;
	el.querySelector('.as-save-sublabel').textContent = sublabel || '';
}

function updateSaveOverlay(label, sublabel) {
	const el = document.getElementById('as-save-overlay');
	if (!el) return;
	if (label) el.querySelector('.as-save-label').textContent = label;
	if (sublabel !== undefined) el.querySelector('.as-save-sublabel').textContent = sublabel;
}

function updateProgress(pct) {
	const fill = document.getElementById('as-progress-fill');
	if (fill) fill.style.width = `${Math.round(pct)}%`;
}

function hideSaveOverlay() {
	const el = document.getElementById('as-save-overlay');
	if (el) el.remove();
}

async function saveAvatar() {
	const name = ($('as-name')?.value || '').trim() || 'My Avatar';
	const saveBtn = $('as-save');
	const resetBtn = $('as-reset');
	saveBtn.disabled = true;
	resetBtn.disabled = true;
	showSaveOverlay('Uploading avatar...', 'This may take a moment');

	try {
		const glbRes = await fetch(BASE_GLB_URL);
		if (!glbRes.ok) throw new Error(`Failed to fetch base GLB: ${glbRes.status}`);
		const glbBlob = await glbRes.blob();

		updateSaveOverlay('Uploading base model...');

		const avatar = await saveRemoteGlbToAccount(
			glbBlob,
			{
				name,
				source: 'studio',
				source_meta: { generator: 'avatar-studio', body_type: bodyType },
				visibility: 'public',
			},
			{
				onProgress: (pct) => updateProgress(pct * 0.7),
			},
		);

		const appearance = collapseAppearance(workingAppearance);
		if (appearance) {
			updateSaveOverlay('Applying customizations...', 'Baking appearance into GLB');
			updateProgress(75);

			const patchRes = await apiFetch(`/api/avatars/${encodeURIComponent(avatar.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ appearance }),
			});
			if (!patchRes.ok) {
				const err = await patchRes.json().catch(() => ({}));
				console.warn('[avatar-studio] appearance PATCH failed:', err);
			}
		}

		updateProgress(90);
		updateSaveOverlay('Capturing thumbnail...');

		try {
			await uploadAvatarSnapshot({ avatarId: avatar.id, scene });
		} catch (err) {
			console.warn('[avatar-studio] snapshot upload failed:', err?.message);
		}

		updateProgress(100);
		updateSaveOverlay('Done! Redirecting...');

		await new Promise((r) => setTimeout(r, 600));

		window.location.href = `/avatars/${encodeURIComponent(avatar.id)}`;
	} catch (err) {
		hideSaveOverlay();
		console.error('[avatar-studio] save failed:', err);

		if (err.code === 'not_signed_in' || err.stage === 'auth') {
			const next = encodeURIComponent('/create/studio');
			window.location.replace(`/login?next=${next}`);
			return;
		}

		setStatus('err', `Save failed: ${err.message || 'Unknown error'}`);
		saveBtn.disabled = false;
		resetBtn.disabled = false;
	}
}
