/**
 * Avatar customizer — /avatars/:id/edit
 *
 * Live-preview outfit + accessory editor for an avatar's owner. Picks render
 * client-side via AccessoryManager so feedback is instant; on Save we PATCH
 * /api/avatars/:id with the resulting appearance JSON and the server bakes a
 * canonical GLB (see api/_lib/bake.js).
 *
 * UX model — mirrors Ready Player Me's wardrobe:
 *   • Hover a tile → that item is applied to the 3D stage immediately (preview).
 *   • Mouseleave    → revert to the committed state.
 *   • Click         → commit. Stays applied. Chip appears in the chip bar.
 *   • Chip ×        → quick-remove without hunting through tabs.
 *   • Search box    → filters the active tab's tiles by name.
 *
 * Architecture mirrors avatar-page.js — same look-and-feel, owner-gated by the
 * presence of `avatar.owner_id` in the API response (the avatars endpoint
 * strips owner_id for non-owners via stripOwnerFor).
 */

import { TalkScene } from './voice/talk-scene.js';
import { AccessoryManager } from './agent-accessories.js';
import { uploadAvatarSnapshot } from './voice/avatar-snapshot.js';
import { IdleAnimation } from './idle-animation.js';
import { renderSculptPanel } from './avatar-sculpt.js';
import { applyProportionsToRoot, captureProportionRest, normalizeProportions, proportionsEqual } from './avatar-proportions.js';
import { canonicalBoneNodesFromObject } from './animation-retarget.js';
import { sanitizeSculptDoc, sculptEqual } from './avatar-sculpt-doc.js';
import { applySculptToRoot } from './avatar-sculpt-brush.js';
import { renderWardrobePanel } from './avatar-wardrobe.js';
import { GarmentCloset, renderClosetSection } from './garment-closet.js';
import { renderRigPanel } from './avatar-rig.js';
import { createWalkPanel } from './avatar-walk-panel.js';
import { apiFetch } from './api.js';
import { playAs } from './game/play-handoff.js';
import { log } from './shared/log.js';

// ── Routing ────────────────────────────────────────────────────────────

const segments = location.pathname.split('/').filter(Boolean);
// `/avatars/:id/edit` in prod, `?id=:id` in dev.
const fromPath =
	segments[0] === 'avatars' && segments[2] === 'edit' ? segments[1] : null;
const editParams = new URLSearchParams(location.search);
const fromQuery = editParams.get('id');
const avatarId = fromPath || fromQuery || '';

// When arriving from the gallery "Equip" button, pre-apply the selected
// accessory GLB once the scene is ready. Supports hat, glasses, earrings kinds
// via ?equip-kind=hat|glasses|earrings (defaults to hat).
const equipGlb = editParams.get('equip-glb') || '';
const equipName = editParams.get('equip-name') || 'Gallery accessory';
const equipBone = editParams.get('equip-bone') || 'Head';
const equipKind = ['glasses', 'earrings'].includes(editParams.get('equip-kind') || '')
	? editParams.get('equip-kind')
	: 'hat';

// The standalone /avatar-edit landing is retired (creation-consolidation C4):
// the customizer is an in-flow step of an avatar, not a destination. The bare
// path 301s to /avatars in vercel.json; the legacy ?id= form still renders here
// so old links and bookmarks keep working, and gets rewritten to the canonical
// /avatars/:id/edit URL in place — replaceState, not a navigation, so nothing
// reloads and the equip handoff params survive.
if (fromQuery && !fromPath && typeof history.replaceState === 'function') {
	const rest = new URLSearchParams(editParams);
	rest.delete('id');
	const qs = rest.toString();
	history.replaceState(
		{},
		'',
		`/avatars/${encodeURIComponent(fromQuery)}/edit${qs ? `?${qs}` : ''}`,
	);
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

// ── State ──────────────────────────────────────────────────────────────

let avatar = null;
let presets = []; // from /accessories/presets.json
let presetsById = new Map();
let scene = null;
let accessoryManager = null;
// Canonical bone → live node for the mounted rig, resolved once at boot so the
// proportion sliders never re-walk the skeleton mid-drag.
let boneNodes = new Map();
let idle = null;
let idleDispose = null;
let walkPreview = null;

// Appearance state — `current` reflects what the server has, `working` is what
// the UI has committed (locally) and will save. We're dirty when they differ.
// `previewedId` is what's *temporarily* applied on hover, never persisted.
let currentAppearance = null;
let workingAppearance = { outfit: null, accessories: [], morphs: {}, colors: {}, hidden: [], garments: [] };
// Additive-wardrobe controller (catalog garments skinned onto this avatar's
// skeleton at runtime). Created once the scene root exists.
let closet = null;
let previewedId = null;

// Monotonic token guards async preset loads from out-of-order arrivals when
// the user hover-skims many tiles. Only the latest hover applies its result.
let previewToken = 0;

// Serializes every accessoryManager mutation so two GLB loads can't race for
// the same single-slot kind (the manager's slot-clear is synchronous at call
// entry; without serialization, two in-flight loads can both attach). Commits
// run unconditionally; hovers/leaves token-skip if they were superseded by the
// time they reach the head of the chain.
let opQueue = Promise.resolve();
function queueOp(fn) {
	const next = opQueue.then(fn).catch((err) => {
		log.warn('[avatar-edit] queued op failed:', err);
	});
	opQueue = next;
	return next;
}

let searchQuery = '';

// Tab definitions: which preset kind goes on which tab.
const TABS = [
	{ id: 'wardrobe', label: 'Wardrobe', kinds: [], wardrobe: true },
	{ id: 'hat', label: 'Hats', kinds: ['hat'], emoji: '🎩', single: true },
	{ id: 'glasses', label: 'Glasses', kinds: ['glasses'], emoji: '🕶️', single: true },
	{ id: 'earrings', label: 'Earrings', kinds: ['earrings'], emoji: '💎', single: false },
	{ id: 'sculpt', label: 'Sculpt', kinds: [], emoji: '✨', single: true, sculpt: true },
	{ id: 'rig', label: 'Animate', kinds: [], emoji: '🦴', rig: true },
	{ id: 'walk', label: 'Walk', kinds: [], emoji: '🚶', walk: true },
];
const KIND_EMOJI = {
	outfit: '👕',
	hat: '🎩',
	glasses: '🕶️',
	earrings: '💎',
};
const KIND_LABEL = {
	outfit: 'Outfit',
	hat: 'Hat',
	glasses: 'Glasses',
	earrings: 'Earrings',
};
let activeTab = 'wardrobe';

// ── Init ───────────────────────────────────────────────────────────────

if (!avatarId) {
	$('ae-shell').innerHTML = `<div class="ae-error">No avatar specified.</div>`;
} else {
	init().catch((err) => {
		log.error('[avatar-edit] init', err);
		$('ae-shell').innerHTML = `<div class="ae-error">${esc(err.message || 'Failed to load')}</div>`;
	});
}

async function init() {
	avatar = await fetchAvatar(avatarId);
	if (!avatar.owner_id) {
		// owner_id is stripped from the API response for non-owners.
		$('ae-shell').innerHTML = `<div class="ae-error">You don't own this avatar.</div>`;
		return;
	}
	if (!avatar.model_url) {
		$('ae-shell').innerHTML = `<div class="ae-error">This avatar has no GLB to customize.</div>`;
		return;
	}

	$('ae-title').textContent = `Customize · ${avatar.name}`;
	$('ae-back').href = `/avatars/${encodeURIComponent(avatar.id)}`;
	// Owner is editing → surface the agent-wallet panel (create / manage) inline.
	const actions = $('ae-actions');
	if (actions) {
		if (customElements.get('avatar-actions')) actions.avatar = avatar;
		else actions.setAttribute('avatar-id', avatar.id);
	}
	// This avatar already has a baked GLB, so it's playable right now — light up
	// the handoff into /play.
	$('ae-play').disabled = false;

	currentAppearance = normalizeAppearance(avatar.appearance);
	workingAppearance = clone(currentAppearance);

	// Boot the 3D stage in parallel with the presets fetch. The wardrobe panel
	// renders as soon as presets arrive so the user can browse while the GLB
	// streams in. Hover/click interactions gate on accessoryManager being
	// ready — until then they set a "loading" status.
	const scenePromise = bootScene();

	presets = await fetchPresets();
	presetsById = new Map(presets.map((p) => [p.id, p]));

	renderTabs();
	renderChips();
	renderActivePanel();
	bindHeader();

	await scenePromise;

	// Gallery equip: pre-apply the accessory GLB from the query param and dirty
	// the state so the Save button activates. A toast tells the user what happened.
	if (equipGlb && accessoryManager) {
		const syntheticPreset = {
			id: `gallery:${btoa(equipGlb).replace(/[^a-z0-9]/gi, '').slice(0, 32)}`,
			kind: equipKind,
			name: equipName,
			glbUrl: equipGlb,
			attachBone: equipBone,
		};
		await queueOp(() => accessoryManager.applyPreset(syntheticPreset));
		if (!workingAppearance.accessories.includes(syntheticPreset.id)) {
			workingAppearance = {
				...workingAppearance,
				accessories: [...workingAppearance.accessories, syntheticPreset.id],
			};
		}
		updateDirtyState();
		renderActivePanel();
		showEquipToast(equipName);
	}
}

function showEquipToast(name) {
	const toast = document.createElement('div');
	toast.className = 'ae-equip-toast';
	toast.textContent = `"${name}" added — save to keep it on your avatar.`;
	document.body.appendChild(toast);
	requestAnimationFrame(() => toast.classList.add('is-visible'));
	setTimeout(() => {
		toast.classList.remove('is-visible');
		toast.addEventListener('transitionend', () => toast.remove(), { once: true });
	}, 4500);
}

/**
 * Push the working skeleton-space build onto the live rig and re-measure the
 * clip stack so root motion matches the new hip height (see
 * src/avatar-proportions.js). No-op before the scene mounts.
 */
function applyProportions() {
	if (!scene?.root) return;
	applyProportionsToRoot(scene.root, workingAppearance.proportions, { boneMap: boneNodes });
	scene.getEmoteController()?.remeasureRig?.();
	// The walk preview owns a second AnimationManager on the same rig, so it has
	// its own stale hip scale to fix.
	walkPreview?.remeasureProportions();
}

async function bootScene() {
	// IMPORTANT: load the BASE GLB, not the baked one. The customizer applies
	// appearance on the client; loading the already-baked URL would stack
	// outfits.
	scene = new TalkScene();
	try {
		await scene.mount({
			container: $('ae-stage'),
			glbUrl: avatar.base_model_url || avatar.model_url,
		});
		$('ae-loading')?.remove();

		// Capture the bind-pose skeleton before anything animates it, every
		// proportion edit is applied from this rest state, so a capture taken
		// mid-clip would bake that frame in as "rest" and the body would drift.
		boneNodes = canonicalBoneNodesFromObject(scene.root);
		captureProportionRest(scene.root, { boneMap: boneNodes });
		applyProportions();

		accessoryManager = new AccessoryManager({
			content: scene.root,
			invalidate: () => {},
		});
		await accessoryManager.hydrateFromAppearance(currentAppearance);

		// Additive wardrobe: re-attach saved catalog garments onto the live
		// skeleton. Unknown/retired garments degrade to "not worn" inside
		// hydrate rather than failing the whole boot.
		const baseUrl = avatar.base_model_url || avatar.model_url || '';
		closet = new GarmentCloset({
			getRoot: () => scene?.root || null,
			getWorking: () => workingAppearance,
			// The parametric base ships a baked UV region mask, giving worn
			// garments pixel-exact skin occlusion. Other bodies use bone-cull.
			regionMaskUrl: baseUrl.includes('parametric-base')
				? '/avatars/parametric-base.regions.png'
				: null,
			onDirty: () => updateDirtyState(),
			onChanged: () => renderChips(),
		});
		// Racks render as soon as the closet exists — the catalog browse must not
		// wait behind re-downloading a saved outfit (hydrate below marks tiles
		// worn as each piece lands, via onChanged re-renders).
		renderActivePanel();
		await closet.hydrate(currentAppearance.garments);

		// Ambient idle layer — breathing, micro-saccades, blink, weight shift.
		// Static preview here (no AgentProtocol); IdleAnimation's no-op stub
		// covers the SPEAK / LOOK_AT subscriptions. Seeded by avatar id so two
		// previews on the same page don't sync up.
		idle = new IdleAnimation({
			getRoot: () => scene.root,
			seed: avatar.id || 'avatar-edit',
		});
		idleDispose = scene.addOnTick((dt) => idle.update(dt));
	} catch (err) {
		const loadingEl = $('ae-loading');
		if (loadingEl) loadingEl.textContent = `Could not load GLB: ${err.message}`;
		// The tabs still rendered — user can browse the catalog, just no live
		// 3D preview. Save is still gated on dirty state below.
	}
}

// ── API ────────────────────────────────────────────────────────────────

async function fetchAvatar(id) {
	const r = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Avatar not found (${r.status})`);
	}
	return (await r.json()).avatar;
}

async function fetchPresets() {
	const r = await fetch('/accessories/presets.json');
	if (!r.ok) throw new Error(`Could not load presets (${r.status})`);
	return r.json();
}

async function saveAppearance() {
	setStatus('spin', 'Saving and baking…');
	// apiFetch, not raw fetch: mutations need the single-use CSRF token it
	// auto-carries; a raw PATCH 403s against api/_lib/csrf.js enforcement.
	const r = await apiFetch(`/api/avatars/${encodeURIComponent(avatar.id)}`, {
		method: 'PATCH',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ appearance: collapseAppearance(workingAppearance) }),
	});
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Save failed (${r.status})`);
	}
	const updated = (await r.json()).avatar;
	avatar = updated;
	currentAppearance = normalizeAppearance(updated.appearance);
	workingAppearance = clone(currentAppearance);
	if (updated.bake_error) {
		setStatus('err', `Saved, but bake failed: ${updated.bake_error}`);
	} else if (updated.baked) {
		setStatus('ok', 'Saved · baked GLB ready');
	} else {
		setStatus('ok', 'Saved');
	}
	updateDirtyState();

	// Best-effort: snapshot the current frame and upload as the avatar's
	// thumbnail. Auto-tagging runs server-side as part of the call. We don't
	// await this on the critical Save path — if it fails the user already sees
	// "Saved" and the existing OG fallback still serves a card.
	queueMicrotask(async () => {
		try {
			await uploadAvatarSnapshot({ avatarId: avatar.id, scene });
		} catch (err) {
			log.warn('[avatar-edit] snapshot upload failed:', err?.message);
		}
	});
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderTabs() {
	const el = $('ae-tabs');
	el.innerHTML = TABS.map(
		(t) => `
			<button class="ae-tab${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}" role="tab">
				${t.label}
			</button>
		`,
	).join('');
	el.querySelectorAll('.ae-tab').forEach((btn) => {
		btn.addEventListener('click', () => {
			activeTab = btn.dataset.tab;
			searchQuery = '';
			el.querySelectorAll('.ae-tab').forEach((b) => b.classList.toggle('active', b === btn));
			renderActivePanel();
		});
	});
}

function renderActivePanel() {
	const tab = TABS.find((t) => t.id === activeTab);
	const panel = $('ae-panel');

	// Leaving the Walk tab tears down locomotion and restores the static stage.
	// Idempotent, so it's safe to call on every render regardless of source tab.
	if (activeTab !== 'walk') exitWalkMode();

	if (tab.walk) {
		renderWalkPanel(panel);
		return;
	}

	// Wardrobe tab: recolour + show/hide the avatar's own garment layers. Shares
	// the studio's layer engine (src/avatar-wardrobe.js); changes apply live via
	// the AccessoryManager and persist in appearance.colors / appearance.hidden.
	if (tab.wardrobe) {
		renderWardrobePanel({
			container: panel,
			root: scene?.root || null,
			working: workingAppearance,
			applyLayers: (layers) => accessoryManager?.applyLayers(layers),
			onDirty: () => {
				renderChips();
				updateDirtyState();
			},
		});
		// The closet (additive catalog garments) renders beneath the layer
		// cards. It exists even for models with no built-in layers — being able
		// to ADD a garment is exactly what a layerless avatar needs.
		const closetMount = document.createElement('div');
		closetMount.id = 'ae-closet';
		panel.appendChild(closetMount);
		if (closet) {
			renderClosetSection({ container: closetMount, closet });
		} else {
			closetMount.innerHTML = '<div class="gc-loading">Closet opens when the avatar finishes loading…</div>';
		}
		return;
	}

	// Sculpt tab gets its own UI — morph sliders, not a tile grid. The face-
	// capture modal lives inside that module, so the avatar-edit shell doesn't
	// need to know anything about MediaPipe loading or webcam plumbing.
	if (tab.sculpt) {
		if (!scene?.root) {
			panel.innerHTML = `<div class="ae-empty">Waiting for avatar to load…</div>`;
			return;
		}
		renderSculptPanel({
			container: panel,
			root: scene.root,
			working: workingAppearance,
			onDirty: () => {
				renderChips();
				updateDirtyState();
			},
			// A proportion edit moves the hips, which invalidates the hip-track
			// rescale every loaded clip was retargeted with. Re-measure or the
			// walk preview foot-slides on the new legs.
			onRigChanged: () => {
				scene?.getEmoteController()?.remeasureRig?.();
				walkPreview?.remeasureProportions();
			},
		});
		return;
	}

	// Animate tab: rig status + one-click auto-rig. Turns a static mesh into an
	// animation-ready avatar via the regenerate(mode:'rerig') backend. Rigging is
	// non-destructive — it mints a new sibling avatar — so on success we hand the
	// owner straight into that new avatar's editor.
	if (tab.rig) {
		renderRigPanel({
			container: panel,
			avatar,
			onRigged: (newAvatar) => {
				if (!newAvatar?.id) return;
				location.href = `/avatars/${encodeURIComponent(newAvatar.id)}/edit`;
			},
		});
		return;
	}

	const q = searchQuery.trim().toLowerCase();
	const items = presets.filter(
		(p) => tab.kinds.includes(p.kind) && (!q || p.name.toLowerCase().includes(q)),
	);

	const searchHtml = `
		<div class="ae-search-wrap">
			<input class="ae-search" id="ae-search" type="search"
			       placeholder="Search ${esc(tab.label.toLowerCase())}…"
			       value="${esc(searchQuery)}" autocomplete="off" />
		</div>`;

	if (items.length === 0 && q) {
		panel.innerHTML = searchHtml + `<div class="ae-empty">No matches for “${esc(searchQuery)}”.</div>`;
		bindSearch();
		return;
	}

	// Render a "None" tile first (only when no search is active) so users can
	// clear the current pick without scrolling. Hidden during search to avoid
	// the confusing "None" matching every empty query.
	const tiles = [];
	if (!q) {
		tiles.push(`
			<button class="ae-tile ae-tile-none${tileSelected(tab, null) ? ' selected' : ''}"
			        type="button" data-id="" data-kind="${tab.id}">
				<div class="ae-tile-preview" aria-hidden="true">∅</div>
				<div class="ae-tile-name">None</div>
				<div class="ae-tile-kind">remove</div>
			</button>
		`);
	}
	for (const p of items) {
		const previewing = previewedId === p.id;
		const selected = tileSelected(tab, p.id);
		tiles.push(`
			<button class="ae-tile${selected ? ' selected' : ''}${previewing ? ' previewing' : ''}"
			        type="button" data-id="${esc(p.id)}" data-kind="${tab.id}">
				<div class="ae-tile-preview" aria-hidden="true">
					${tilePreviewMarkup(p)}
				</div>
				<div class="ae-tile-name">${esc(p.name)}</div>
				<div class="ae-tile-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</div>
			</button>
		`);
	}

	panel.innerHTML = searchHtml + `<div class="ae-grid">${tiles.join('')}</div>`;
	bindSearch();
	bindTiles(panel, tab);
}

// ── Walk preview ─────────────────────────────────────────────────────────

// The panel itself lives in src/avatar-walk-panel.js so Avatar Studio mounts
// the identical control. This editor supplies the scene, the ambient-idle
// pause/resume hooks, and the draft handoff into /walk.
function getWalkPreview() {
	if (walkPreview) return walkPreview;
	if (!scene?.root) return null;
	walkPreview = createWalkPanel({
		getScene: () => scene,
		getStageEl: () => $('ae-stage'),
		// The editor's ambient idle layer writes bone rotations every frame; pause
		// it while a retargeted walk clip owns the skeleton, resume on exit.
		pauseAmbient: () => {
			if (idleDispose) {
				idleDispose();
				idleDispose = null;
			}
		},
		resumeAmbient: () => {
			if (idle && scene && !idleDispose) {
				idleDispose = scene.addOnTick((dt) => idle.update(dt));
			}
		},
		openWalkUrl: buildWalkDraftUrl,
	});
	return walkPreview;
}

function renderWalkPanel(panel) {
	const preview = getWalkPreview();
	if (!preview) {
		panel.innerHTML = `<div class="ae-empty">Waiting for avatar to load...</div>`;
		return;
	}
	preview.render(panel);
}

function exitWalkMode() {
	walkPreview?.exit();
}

// Mint an unguessable draft id and stash the *current* (unsaved) look so the
// walk page renders exactly what's on the editor stage, not the last save.
async function buildWalkDraftUrl(env) {
	const draftId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`)
		.replace(/[^a-z0-9]/gi, '')
		.slice(0, 40);
	const r = await apiFetch(`/api/avatars/draft/${encodeURIComponent(draftId)}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			avatar_id: avatar.id,
			appearance: collapseAppearance(workingAppearance),
		}),
	});
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Could not save draft (${r.status})`);
	}
	return `/walk?avatar=${encodeURIComponent(draftId)}&preview=true&env=${encodeURIComponent(env)}`;
}

function tilePreviewMarkup(preset) {
	const emoji = KIND_EMOJI[preset.kind] || '◇';
	if (!preset.thumbnail) return emoji;
	// Render the emoji underneath as a graceful fallback. The <img> sits on
	// top when it loads; if the file 404s, onerror strips the <img> and the
	// emoji is what the user sees. Avoids broken-image icons while the
	// thumbnail pipeline catches up to the presets.json declarations.
	return `
		<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${emoji}</span>
		<img src="${esc(preset.thumbnail)}" alt="" loading="lazy"
		     style="position:absolute;inset:0;"
		     data-fallback="remove" />
	`;
}

function bindSearch() {
	const input = $('ae-search');
	if (!input) return;
	input.addEventListener('input', (e) => {
		searchQuery = e.target.value;
		renderActivePanel();
		// Re-focus to keep typing fluid after the re-render.
		const next = $('ae-search');
		if (next) {
			next.focus();
			next.setSelectionRange(searchQuery.length, searchQuery.length);
		}
	});
}

function bindTiles(panel, tab) {
	panel.querySelectorAll('.ae-tile').forEach((btn) => {
		const presetId = btn.dataset.id;
		btn.addEventListener('click', () => onTileClick(tab, presetId));
		// Hover-to-try-on lives only on real items (not the "None" tile —
		// removing on hover and re-applying on leave would just churn for no
		// information value).
		if (!presetId) return;
		btn.addEventListener('mouseenter', () => onTileHover(tab, presetId));
		btn.addEventListener('mouseleave', () => onTileLeave());
		// Touch / keyboard analogs: focus previews, blur reverts.
		btn.addEventListener('focus', () => onTileHover(tab, presetId));
		btn.addEventListener('blur', () => onTileLeave());
	});
}

function renderChips() {
	const el = $('ae-chips');
	const picks = [];
	if (workingAppearance.outfit) picks.push(workingAppearance.outfit);
	for (const id of workingAppearance.accessories) picks.push(id);

	el.innerHTML = picks
		.map((id) => {
			const p = presetsById.get(id);
			if (!p) return '';
			return `
				<span class="ae-chip" data-id="${esc(id)}">
					<span class="ae-chip-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
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
	// Accessory kinds (hat/glasses/earrings) live in the accessories array.
	const matching = workingAppearance.accessories.filter((id) => {
		const preset = presetsById.get(id);
		return preset && tab.kinds.includes(preset.kind);
	});
	if (!presetId) return matching.length === 0;
	return matching.includes(presetId);
}

// ── Hover preview ──────────────────────────────────────────────────────

function onTileHover(tab, presetId) {
	// Already committed in this slot — hovering is a no-op (it's literally what
	// the stage is showing already).
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

	// Before the GLB streams in, we can't render a live preview. Show a hint
	// in the status bar so the hover isn't silently inert.
	if (!accessoryManager) {
		setStatus('', `${preset.name} · waiting for avatar to load…`);
		return;
	}

	queueOp(async () => {
		// If another hover/leave/click bumped the token before our turn, skip.
		if (myToken !== previewToken) return;
		// For single-slot kinds the manager boots whatever's currently in that
		// slot — exactly the preview behavior we want. Earrings layer on top.
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
		setStatusForDirtyState();
		return;
	}

	const preset = presetsById.get(leavingId);
	if (!preset) {
		setStatusForDirtyState();
		return;
	}

	queueOp(async () => {
		if (myToken !== previewToken) return;
		if (!accessoryManager) {
			setStatusForDirtyState();
			return;
		}
		// Take the preview off.
		accessoryManager.removePreset(leavingId);
		// If we displaced a committed single-slot item to show the preview, put
		// it back. (Earrings are layered, not displaced, so nothing to restore.)
		if (preset.kind !== 'earrings') {
			const committedInSlot = committedIdForKind(preset.kind);
			if (committedInSlot && committedInSlot !== leavingId) {
				const restore = presetsById.get(committedInSlot);
				if (restore) await accessoryManager.applyPreset(restore);
			}
		}
		if (myToken === previewToken) setStatusForDirtyState();
	});
}

function highlightPreviewingTile(id) {
	document.querySelectorAll('.ae-tile.previewing').forEach((el) => el.classList.remove('previewing'));
	if (!id) return;
	const el = document.querySelector(`.ae-tile[data-id="${cssEscape(id)}"]`);
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

// ── Commit / remove ────────────────────────────────────────────────────

async function onTileClick(tab, presetId) {
	// A click commits the current hover state. The item may already be on the
	// stage from a hover, or we may be clicking without hovering (touch /
	// keyboard). Either way, route through the queue and run unconditionally:
	// commits should never be token-skipped.
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
	updateDirtyState();
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
	updateDirtyState();
}

async function applyOutfit(presetId) {
	// Manager's single-slot logic handles removal of the previous outfit when
	// applyPreset() is called for a new one. Only do an explicit remove when
	// the new pick is null (the "None" tile).
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
	// Earrings (and any future non-single kinds) allow multiples — toggle on
	// repeat-click. Single-slot kinds (hat, glasses) just replace.
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
			if (id === presetId) continue; // about to re-apply same id — manager dedupes
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

	// Non-single (earrings): clicking an already-applied preset removes it.
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

// ── Header / status ────────────────────────────────────────────────────

function bindHeader() {
	// Jump into /play as this avatar. If there are unsaved appearance edits, bake
	// them first so the world shows the look the user actually sees here, then hand
	// off the canonical avatar id (peers resolve it to the freshly-baked GLB).
	$('ae-play').addEventListener('click', async () => {
		$('ae-play').disabled = true;
		try {
			if (!$('ae-save').disabled) {
				setStatus('spin', 'Saving your look before you play…');
				await saveAppearance();
				renderChips();
				renderActivePanel();
				updateDirtyState();
			}
			setStatus('spin', 'Entering /play…');
			await playAs({ id: avatar.id, name: avatar.name, dest: '/play' });
		} catch (err) {
			setStatus('err', err.message);
			$('ae-play').disabled = false;
		}
	});
	$('ae-save').addEventListener('click', async () => {
		$('ae-save').disabled = true;
		$('ae-reset').disabled = true;
		try {
			await saveAppearance();
			renderChips();
			renderActivePanel();
		} catch (err) {
			setStatus('err', err.message);
		} finally {
			updateDirtyState();
		}
	});
	$('ae-reset').addEventListener('click', async () => {
		// Roll the live preview back to the saved appearance.
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
			workingAppearance = clone(currentAppearance);
			applyProportions();
			if (accessoryManager) await accessoryManager.hydrateFromAppearance(workingAppearance);
			if (closet) {
				closet.clear();
				await closet.hydrate(workingAppearance.garments);
			}
		});
		renderChips();
		renderActivePanel();
		updateDirtyState();
		setStatus('', 'Reverted to last saved.');
	});
}

function updateDirtyState() {
	const dirty = !appearanceEquals(workingAppearance, currentAppearance);
	$('ae-save').disabled = !dirty;
	$('ae-reset').disabled = !dirty;
	setStatusForDirtyState();
}

function setStatusForDirtyState() {
	const dirty = !appearanceEquals(workingAppearance, currentAppearance);
	if (!dirty) {
		setStatus('', 'Hover any item to try it on. Click to keep.');
	} else {
		setStatus('', 'Unsaved changes.');
	}
}

function setStatus(kind, text) {
	const el = $('ae-status');
	el.className = `ae-status${kind ? ' ' + kind : ''}`;
	el.innerHTML = kind === 'spin' ? `<span class="spin"></span>${esc(text)}` : esc(text);
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeAppearance(a) {
	if (!a) return { outfit: null, accessories: [], morphs: {}, colors: {}, hidden: [], garments: [], proportions: {} };
	return {
		outfit: a.outfit || null,
		accessories: Array.isArray(a.accessories) ? [...a.accessories] : [],
		morphs: a.morphs && typeof a.morphs === 'object' ? { ...a.morphs } : {},
		// Garment-layer state (recolour + show/hide) is owned by the studio but
		// must survive an edit here — hydrate re-applies it and collapse re-sends
		// it, so editing accessories never silently strips a studio look.
		colors: a.colors && typeof a.colors === 'object' ? { ...a.colors } : {},
		hidden: Array.isArray(a.hidden) ? [...a.hidden] : [],
		// Additive catalog garments worn by this avatar ({slot, id} refs).
		garments: Array.isArray(a.garments)
			? a.garments.filter((g) => g && g.slot && g.id).map((g) => ({ slot: g.slot, id: g.id }))
			: [],
		// Skeleton-space build (src/avatar-proportions.js). Normalized on the way
		// in so an out-of-range or hand-edited record can never drive the rig.
		proportions: normalizeProportions(a.proportions),
		sculpt: sanitizeSculptDoc(a.sculpt),
	};
}

// Drop empty fields before PATCHing so we send the smallest valid JSON and so
// "no customization" rows have appearance = null (matches isBakeable() check).
function collapseAppearance(a) {
	const out = {};
	if (a.outfit) out.outfit = a.outfit;
	if (a.accessories?.length) out.accessories = [...a.accessories];
	if (a.morphs && Object.keys(a.morphs).length) out.morphs = { ...a.morphs };
	if (a.colors && Object.keys(a.colors).length) out.colors = { ...a.colors };
	if (a.hidden?.length) out.hidden = [...a.hidden];
	if (a.garments?.length) out.garments = a.garments.map((g) => ({ slot: g.slot, id: g.id }));
	const proportions = normalizeProportions(a.proportions);
	if (Object.keys(proportions).length) out.proportions = proportions;
	const sculpt = sanitizeSculptDoc(a.sculpt);
	if (sculpt) out.sculpt = sculpt;
	return Object.keys(out).length ? out : null;
}

function clone(o) {
	return JSON.parse(JSON.stringify(o));
}

function appearanceEquals(a, b) {
	if ((a?.outfit || null) !== (b?.outfit || null)) return false;
	const sa = new Set(a?.accessories || []);
	const sb = new Set(b?.accessories || []);
	if (sa.size !== sb.size) return false;
	for (const v of sa) if (!sb.has(v)) return false;
	const ka = Object.keys(a?.morphs || {});
	const kb = Object.keys(b?.morphs || {});
	if (ka.length !== kb.length) return false;
	for (const k of ka) if ((a.morphs[k] || 0) !== (b?.morphs?.[k] || 0)) return false;
	const ca = Object.keys(a?.colors || {});
	const cb = Object.keys(b?.colors || {});
	if (ca.length !== cb.length) return false;
	for (const k of ca) if ((a.colors[k] || null) !== (b?.colors?.[k] || null)) return false;
	const ha = new Set(a?.hidden || []);
	const hb = new Set(b?.hidden || []);
	if (ha.size !== hb.size) return false;
	for (const v of ha) if (!hb.has(v)) return false;
	const ga = new Set((a?.garments || []).map((g) => `${g.slot}/${g.id}`));
	const gb = new Set((b?.garments || []).map((g) => `${g.slot}/${g.id}`));
	if (ga.size !== gb.size) return false;
	for (const v of ga) if (!gb.has(v)) return false;
	if (!proportionsEqual(a?.proportions, b?.proportions)) return false;
	if (!sculptEqual(a?.sculpt, b?.sculpt)) return false;
	return true;
}
