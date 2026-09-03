/**
 * Avatar Studio — /create/studio
 *
 * Build a custom 3D avatar from a base template without needing a selfie.
 * Two modes:
 *   - Create:  /create/studio          → start from default.glb
 *   - Edit:    /create/studio?edit=ID  → reload a previously-saved avatar
 *
 * On Save, the live Three.js scene is exported via GLTFExporter (colours,
 * morphs, and accessories are already applied to the scene graph), so the
 * resulting GLB is exactly what the user saw.  No server-side bake required
 * for the model to look right — the appearance JSON is still PATCHed as
 * metadata so the avatar is re-editable later.
 *
 * Reuses the same building blocks as avatar-edit.js:
 *   - TalkScene for the 3D viewport
 *   - AccessoryManager for outfit/accessory application
 *   - renderSculptPanel from avatar-sculpt.js for face/body morphs
 *   - IdleAnimation for ambient breathing/blinking
 */

import { TalkScene } from './voice/talk-scene.js';
import { AccessoryManager } from './agent-accessories.js';
import { IdleAnimation } from './idle-animation.js';
import { renderSculptPanel, applyMorphsToRoot } from './avatar-sculpt.js';
import { applySculptToRoot, clearSculpt } from './avatar-sculpt-brush.js';
import {
	applyProportionsToRoot,
	captureProportionRest,
	PROPORTION_PARAMS,
} from './avatar-proportions.js';
import { canonicalBoneNodesFromObject } from './animation-retarget.js';
import { renderWardrobePanel } from './avatar-wardrobe.js';
import { GarmentCloset, renderClosetSection, SLOT_LABEL_ONE } from './garment-closet.js';
import { renderRigPanel } from './avatar-rig.js';
import { createWalkPanel } from './avatar-walk-panel.js';
import { playAs } from './game/play-handoff.js';
import { saveRemoteGlbToAccount, apiFetch } from './account.js';
import { captureWizardReturn, returnToWizard } from './shared/wizard-return.js';

// The /start wizard links here with ?next=; remember it so the saved avatar
// can be handed straight back into the setup flow.
captureWizardReturn();
import { uploadAvatarSnapshot } from './voice/avatar-snapshot.js';
import { optimizeAndValidateGlb } from './avatar-studio-optimize.js';
import { poseSkeletonsToBind, captureBoneTransforms, restoreBoneTransforms } from './glb-bind-pose.js';
import { openColorPopover, closeActivePopover } from './avatar-studio-colorpicker.js';
import {
	collapseAppearance,
	hydrateAppearance,
	cloneAppearance,
	appearanceEqual,
	parseEditId,
	readDraft,
	writeDraft as writeDraftStorage,
	clearDraft as clearDraftStorage,
	DRAFT_KEY,
} from './avatar-studio-utils.js';
import { log } from './shared/log.js';

const BASE_GLB_URL = '/avatars/default.glb';

// Selectable base bodies for create mode (?base=<id>). `default` is the
// stylized RPM body; `parametric` is the CC0 MakeHuman-derived base baked by
// scripts/build-parametric-base.mjs with ~120 identity morph sliders (nose,
// ears, jaw, body macros, limbs), so the Sculpt tab becomes a full character
// creator. Edit mode always reloads the avatar's own saved model instead.
const BASE_BODIES = [
	{ id: 'default', label: 'Stylized', url: BASE_GLB_URL },
	{ id: 'parametric', label: 'Parametric', url: '/avatars/parametric-base.glb' },
];
const BASE_BODY_BY_ID = new Map(BASE_BODIES.map((b) => [b.id, b]));

const MAX_HISTORY = 50;

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
// Lifecycle of the accessory catalog, read by the three accessory tabs so each
// renders its own loading / error / populated state instead of a bare "none".
let presetsState = 'loading'; // 'loading' | 'ready' | 'error'
let presetsError = '';
// Canonical bone → live node for the mounted rig, resolved once at boot and
// reused by every proportion apply so the skeleton is never re-walked mid-drag.
let boneNodes = new Map();

let workingAppearance = hydrateAppearance(null);
let savedAppearance = null; // null = unsaved / the appearance at last save
let savedName = '';        // the name at last save, so a name-only edit still saves
let editAvatarId = null;   // non-null when in edit mode (?edit=ID)

let history = [];
let historyIndex = -1;

// Additive-wardrobe controller: catalog garments skinned onto this avatar's
// skeleton at runtime (specs/GARMENT_MANIFEST.md). Created once the scene root
// exists, in both create and edit mode -- adding a garment needs a rig, not a
// saved record.
let closet = null;
// Walk-tab controller (src/avatar-walk-panel.js). Owns a second AnimationManager
// on the same rig, so proportion edits have to re-measure it too.
let walkPanel = null;
// The avatar loaded in edit mode, kept for the panels that need the record
// itself (rig status, the /walk draft handoff, "Play as this").
let editAvatar = null;
let idleDispose = null;

let previewedId = null;
let previewToken = 0;
let opQueue = Promise.resolve();
let searchQuery = '';

// ── Animate — drive the rig live with the shared canonical clip library ──────
// These names resolve against /animations/manifest.json (loaded by the scene's
// emote controller) and retarget onto the avatar's skeleton at runtime. Proof
// the avatar is fully rigged — and a customization dimension of its own: the
// chosen idle loop is what the saved avatar settles into. `loop` clips hold
// until the user picks another; one-shots play once and settle back to idle.
const EMOTES = [
	{ name: 'idle', label: 'Idle', emoji: '🧍', loop: true },
	{ name: 'av-waiting', label: 'Waiting', emoji: '⏳', loop: true },
	{ name: 'av-chilling', label: 'Chill', emoji: '😎', loop: true },
	{ name: 'wave', label: 'Wave', emoji: '👋', loop: false },
	{ name: 'av-cheering', label: 'Cheer', emoji: '🙌', loop: false },
	{ name: 'celebrate', label: 'Celebrate', emoji: '🎉', loop: false },
	{ name: 'av-arm-flex', label: 'Flex', emoji: '💪', loop: false },
	{ name: 'jump', label: 'Jump', emoji: '⬆️', loop: false },
	{ name: 'pray', label: 'Pray', emoji: '🙏', loop: false },
	{ name: 'kiss', label: 'Blow Kiss', emoji: '😘', loop: false },
	{ name: 'taunt', label: 'Taunt', emoji: '😏', loop: false },
	{ name: 'dance', label: 'Dance', emoji: '💃', loop: true },
	{ name: 'av-dance-shuffle', label: 'Shuffle', emoji: '🕺', loop: true },
	{ name: 'rumba', label: 'Rumba', emoji: '🌹', loop: true },
	{ name: 'thriller', label: 'Thriller', emoji: '🧟', loop: true },
	{ name: 'capoeira', label: 'Capoeira', emoji: '🤸', loop: true },
];
const EMOTE_BY_NAME = new Map(EMOTES.map((e) => [e.name, e]));
const DEFAULT_EMOTE = 'idle';

// Animation state. `emotesReady` flips true once the clip library loads and the
// idle clip binds to the rig; until then the Animate tab shows a loading state.
// `emotesFailed` separates "still loading" from "this attempt is over", because
// treating a failed load as perpetual loading left the tab showing skeleton
// tiles forever when the clip manifest could not be fetched.
// `currentEmote` is the looping clip the avatar rests in (one-shots settle back
// to it). `activeIdleClip` is the looping baseline that Save bakes in.
let emotesReady = false;
let emotesFailed = false;
let currentEmote = DEFAULT_EMOTE;
let activeIdleClip = DEFAULT_EMOTE;

function queueOp(fn) {
	const next = opQueue.then(fn).catch((err) => {
		log.warn('[avatar-studio] queued op failed:', err);
	});
	opQueue = next;
	return next;
}

/**
 * queueOp() swallows failures so one bad op cannot stall the chain, which left
 * callers unable to tell success from silence. This keeps the chain intact and
 * still hands the caller the outcome so it can show a real error.
 */
async function runQueued(fn) {
	let captured = null;
	await queueOp(async () => {
		try {
			await fn();
		} catch (err) {
			captured = err;
		}
	});
	return { ok: !captured, error: captured };
}

// ── Busy state ───────────────────────────────────────────────────────
// Accessory work is a network round trip plus a rig pass. Nested/overlapping
// ops are counted so the last one out is the one that clears the indicator.
let busyDepth = 0;

function beginBusy(label) {
	busyDepth++;
	$('as-panel')?.setAttribute('aria-busy', 'true');
	setStatus('spin', label);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		busyDepth = Math.max(0, busyDepth - 1);
		if (busyDepth === 0) $('as-panel')?.removeAttribute('aria-busy');
	};
}

// `editOnly` tabs need a saved avatar record behind them: rigging POSTs the
// avatar's id to the regenerate backend, so there is nothing to rig from a
// draft. The Walk tab renders in both modes (locomotion needs only the live
// rig); its handoff into /walk is what degrades, inside the panel.
const TABS = [
	{ id: 'color', label: 'Color', kinds: [], emoji: '🎨', color: true },
	{ id: 'wardrobe', label: 'Wardrobe', kinds: [], emoji: '👕', wardrobe: true },
	{ id: 'hat', label: 'Hats', kinds: ['hat'], emoji: '🎩', single: true },
	{ id: 'glasses', label: 'Glasses', kinds: ['glasses'], emoji: '🕶️', single: true },
	{ id: 'earrings', label: 'Earrings', kinds: ['earrings'], emoji: '💎', single: false },
	{ id: 'sculpt', label: 'Sculpt', kinds: [], emoji: '✨', single: true, sculpt: true },
	{ id: 'animate', label: 'Animate', kinds: [], emoji: '🎬', animate: true },
	{ id: 'walk', label: 'Walk', kinds: [], emoji: '🚶', walk: true },
	{ id: 'rig', label: 'Rig', kinds: [], emoji: '🦴', rig: true, editOnly: true },
];

function visibleTabs() {
	return TABS.filter((t) => !t.editOnly || editAvatar);
}

const KIND_EMOJI = { hat: '🎩', glasses: '🕶️', earrings: '💎' };
const KIND_LABEL = { hat: 'Hat', glasses: 'Glasses', earrings: 'Earrings' };
let activeTab = 'color';

// ── Color customization ──────────────────────────────────────────────
const COLOR_SLOTS = [
	{
		id: 'skin',
		label: 'Skin tone',
		materials: ['Wolf3D_Skin', 'Wolf3D_Body', 'Parametric_Body'],
		swatches: ['#ffe9d6', '#f3c1a3', '#e0a878', '#c08552', '#9c6b44', '#6f4a32', '#4a2f20'],
	},
	{
		id: 'hair',
		label: 'Hair',
		materials: ['Wolf3D_Hair'],
		swatches: ['#0e0e0e', '#3b2417', '#6b4423', '#9a6a3a', '#c89b5a', '#d8b34a', '#b8b8b8', '#e2604a', '#9b5cc0', '#4a86d6'],
	},
	{
		id: 'outfit',
		label: 'Outfit',
		materials: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Outfit_Footwear'],
		swatches: ['#222831', '#f2f2f2', '#1e3a5f', '#7a1f2b', '#1f6b3a', '#c08a1e', '#6b3fa0', '#d4577e', '#3b6ea5', '#101010'],
	},
];
const COLOR_SLOT_BY_ID = new Map(COLOR_SLOTS.map((s) => [s.id, s]));
const HEX_RE = /^#[0-9a-f]{6}$/i;
const BODY_TYPE = 'feminine';

// ── Looks — one-tap palettes that theme skin + hair + outfit together ──
// Every hue is drawn from the per-slot swatch palettes above, so a Look always
// lands on real, coherent material colors. Applied as a single history step.
const LOOKS = [
	{ id: 'noir', name: 'Noir', colors: { skin: '#e0a878', hair: '#0e0e0e', outfit: '#101010' } },
	{ id: 'sunset', name: 'Sunset', colors: { skin: '#f3c1a3', hair: '#6b4423', outfit: '#c08a1e' } },
	{ id: 'arctic', name: 'Arctic', colors: { skin: '#ffe9d6', hair: '#b8b8b8', outfit: '#3b6ea5' } },
	{ id: 'cyber', name: 'Cyber', colors: { skin: '#c08552', hair: '#9b5cc0', outfit: '#1e3a5f' } },
	{ id: 'rose', name: 'Rosé', colors: { skin: '#f3c1a3', hair: '#3b2417', outfit: '#d4577e' } },
	{ id: 'forest', name: 'Forest', colors: { skin: '#9c6b44', hair: '#3b2417', outfit: '#1f6b3a' } },
	{ id: 'mono', name: 'Mono', colors: { skin: '#e0a878', hair: '#b8b8b8', outfit: '#f2f2f2' } },
	{ id: 'ember', name: 'Ember', colors: { skin: '#9c6b44', hair: '#0e0e0e', outfit: '#7a1f2b' } },
];

// ── Garment layers (show/hide) ───────────────────────────────────────
const LAYER_SLOTS = [
	{ id: 'outfit', label: 'Outfit', materials: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Outfit_Footwear'], strip: true },
	{ id: 'glasses', label: 'Glasses', materials: ['Wolf3D_Glasses'], strip: true },
	{ id: 'hair', label: 'Hair', materials: ['Wolf3D_Hair'], strip: false },
];
const EYE_ON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// ── Init ─────────────────────────────────────────────────────────────

init().catch((err) => {
	log.error('[avatar-studio] init', err);
	// Only tear the shell down when there is nothing usable behind it. Once the
	// avatar has mounted, wiping the shell would destroy a working 3D stage (and
	// leave its render loop ticking on a detached container) over a failure the
	// user could otherwise ignore, so that case reports into the status bar.
	if (scene?.root) {
		setStatus('err', `Something went wrong: ${err?.message || 'Unknown error'}. Reload to start clean.`);
		return;
	}
	renderStageError($('as-shell'), 'Avatar Studio couldn’t load. Check your connection and try again.');
});

// Render an actionable error (Retry + Back) into a container, replacing whatever
// loading/spinner content was there. Used by both the top-level init failure and
// the in-stage base-avatar load failure so neither is a silent dead end.
function renderStageError(container, message) {
	if (!container) return;
	container.innerHTML =
		`<div class="as-error" role="alert">` +
		`<p>${esc(message)}</p>` +
		`<div class="as-error-actions">` +
		`<button type="button" data-as-retry>Retry</button>` +
		`<a href="/create">Back to Create</a>` +
		`</div></div>`;
	container.querySelector('[data-as-retry]')?.addEventListener('click', () => location.reload());
}

async function init() {
	const params = new URLSearchParams(location.search);
	editAvatarId = parseEditId(params);

	if (editAvatarId) {
		try {
			editAvatar = await fetchEditAvatar(editAvatarId);
		} catch (err) {
			setStatus('err', `Could not load avatar: ${err.message}`);
		}
	}

	if (editAvatar) {
		workingAppearance = hydrateAppearance(editAvatar.appearance);
		savedAppearance = cloneAppearance(workingAppearance);
		savedName = editAvatar.name || '';
		const nameEl = $('as-name');
		if (nameEl) nameEl.value = savedName;
		const titleEl = document.querySelector('.as-bar-title');
		if (titleEl) titleEl.textContent = 'Edit Avatar';
		const backEl = $('as-back');
		if (backEl) backEl.href = `/avatars/${encodeURIComponent(editAvatarId)}`;
		// Editing an existing avatar → surface its agent-wallet panel.
		mountAvatarWallet(editAvatar);
	} else {
		// Offer to restore a saved draft (only in create mode, not edit)
		maybeSuggestDraft();
	}

	// History starts at the hydrated initial state
	pushHistory();

	const baseBody = BASE_BODY_BY_ID.get(params.get('base')) || BASE_BODIES[0];
	bindBaseSwitch(baseBody, !!editAvatar);

	const glbUrl = editAvatar
		? (editAvatar.base_model_url || editAvatar.model_url || BASE_GLB_URL)
		: baseBody.url;

	const scenePromise = bootScene(glbUrl, editAvatar);

	// Paint and wire the whole rail before anything is fetched. The header
	// buttons and the tab bar ship in the initial HTML, so gating them on a
	// network round trip left real controls on screen that silently did
	// nothing (and an empty tab bar) for the length of that request.
	renderTabs();
	renderChips();
	renderActivePanel();
	bindHeader();
	bindKeyboard();

	// The accessory catalog powers three of the accessory tabs. A catalog outage
	// degrades those tabs to a retryable error; it must not take down colors,
	// wardrobe, sculpt, animate, walk or save, none of which need it.
	const presetsPromise = loadPresets();

	await scenePromise;
	await presetsPromise;
	if (scene?.root) {
		applyAllColors();
		applyAllLayers();
	}
	await applyEquipHandoff(params);
	renderActivePanel();
	updateDirtyState();
}

// Gallery "Equip" handoff: /avatar-studio?equip-glb=<url>&equip-kind=hat pre-
// applies an accessory GLB that is not in the presets catalog and dirties the
// state so Save lights up. Same contract the avatar editor honours, so a
// gallery tile can hand off to either editor.
const EQUIP_KINDS = ['hat', 'glasses', 'earrings'];

async function applyEquipHandoff(params) {
	const glbUrl = params.get('equip-glb') || '';
	if (!glbUrl || !accessoryManager) return;
	const kind = EQUIP_KINDS.includes(params.get('equip-kind') || '')
		? params.get('equip-kind')
		: 'hat';
	const name = params.get('equip-name') || 'Gallery accessory';
	const preset = {
		id: `gallery:${btoa(glbUrl).replace(/[^a-z0-9]/gi, '').slice(0, 32)}`,
		kind,
		name,
		glbUrl,
		attachBone: params.get('equip-bone') || 'Head',
	};
	const { ok } = await runQueued(() => accessoryManager.applyPreset(preset));
	if (!ok) {
		setStatus('err', `Could not load "${name}". Everything else is ready.`);
		return;
	}
	if (!workingAppearance.accessories.includes(preset.id)) {
		workingAppearance.accessories = [...workingAppearance.accessories, preset.id];
	}
	// The synthetic preset is not in the catalog, so register it for the chip
	// bar and the tile-selected checks that read presetsById.
	presetsById.set(preset.id, preset);
	pushHistory();
	renderChips();
	updateDirtyState();
	setStatus('ok', `"${name}" added. Save to keep it on your avatar.`);
}

async function fetchEditAvatar(id) {
	const res = await apiFetch(`/api/avatars/${encodeURIComponent(id)}`);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.message || `Failed to load avatar (${res.status})`);
	}
	const { avatar } = await res.json();
	return avatar;
}

// Base body switcher (create mode only): reloading the studio with ?base=<id>
// is the correct way to swap the template, because every panel binds to the
// loaded scene graph. Edit mode hides it: a saved avatar owns its base.
function bindBaseSwitch(activeBase, isEdit) {
	const el = $('as-base-switch');
	if (!el) return;
	if (isEdit) {
		el.style.display = 'none';
		return;
	}
	el.querySelectorAll('[data-base]').forEach((btn) => {
		const selected = btn.dataset.base === activeBase.id;
		btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
		btn.classList.toggle('active', selected);
		btn.addEventListener('click', () => {
			if (btn.dataset.base === activeBase.id) return;
			if (isDirtyNow() && !confirm('Switch base body? Unsaved changes will be lost.')) return;
			const url = new URL(location.href);
			url.searchParams.set('base', btn.dataset.base);
			location.href = url.toString();
		});
	});
}

// The name a save would persist right now (the field, or the default).
function currentName() {
	return ($('as-name')?.value || '').trim() || 'My Avatar';
}

// Same dirty predicate updateDirtyState() renders from.
function isDirtyNow() {
	if (savedAppearance === null) return collapseAppearance(workingAppearance) !== null;
	if (editAvatarId && currentName() !== savedName) return true;
	return !appearanceEqual(workingAppearance, savedAppearance);
}

// Surface the avatar's agent-wallet panel (create / manage) in the studio rail.
function mountAvatarWallet(avatar) {
	const el = $('as-actions');
	if (!el || !avatar?.id) return;
	el.style.display = 'block';
	if (customElements.get('avatar-actions')) el.avatar = avatar;
	else el.setAttribute('avatar-id', avatar.id);
}

// ── Draft autosave ───────────────────────────────────────────────────

let _draftTimer = null;
function scheduleDraftSave() {
	clearTimeout(_draftTimer);
	_draftTimer = setTimeout(() => {
		if (editAvatarId) return;
		writeDraftStorage(localStorage, collapseAppearance(workingAppearance), ($('as-name')?.value || '').trim());
	}, 2000);
}

function clearDraft() {
	clearDraftStorage(localStorage);
}

function maybeSuggestDraft() {
	const draft = readDraft(localStorage);
	if (!draft?.appearance) return;
	const ageMins = (Date.now() - draft.ts) / 60000;

	const bar = document.createElement('div');
	bar.id = 'as-draft-bar';
	bar.innerHTML = `
		<span>You have unsaved work from ${ageMins < 60 ? `${Math.round(ageMins)}m ago` : `${Math.round(ageMins/60)}h ago`}.</span>
		<button class="as-draft-btn" id="as-draft-restore">Restore</button>
		<button class="as-draft-btn as-draft-dismiss" id="as-draft-dismiss">Dismiss</button>
	`;
	$('as-shell').prepend(bar);

	$('as-draft-restore').addEventListener('click', () => {
		bar.remove();
		workingAppearance = hydrateAppearance(draft.appearance);
		const nameEl = $('as-name');
		if (nameEl && draft.name) nameEl.value = draft.name;
		if (scene?.root) {
			applyAllColors();
			applyAllLayers();
			applyMorphsToRoot(scene.root, workingAppearance.morphs);
			applyProportions();
			applySculpt();
			if (accessoryManager) accessoryManager.hydrateFromAppearance(workingAppearance);
		}
		pushHistory();
		renderChips();
		renderActivePanel();
		updateDirtyState();
		setStatus('ok', 'Draft restored.');
	});
	$('as-draft-dismiss').addEventListener('click', () => { bar.remove(); clearDraft(); });
}

// ── History (undo / redo) ────────────────────────────────────────────

function pushHistory() {
	// drop any "future" when a new action is taken
	history = history.slice(0, historyIndex + 1);
	history.push(cloneAppearance(workingAppearance));
	if (history.length > MAX_HISTORY) history.shift();
	historyIndex = history.length - 1;
	updateUndoRedoBtns();
}

function undoAppearance() {
	if (historyIndex <= 0) return;
	historyIndex--;
	applyHistoryState(history[historyIndex]);
}

function redoAppearance() {
	if (historyIndex >= history.length - 1) return;
	historyIndex++;
	applyHistoryState(history[historyIndex]);
}

// Every history step is stamped, so a step superseded while its accessories were
// still loading neither hydrates the rig from the newer step's appearance nor
// repaints the UI over it. Previously the queued thunk read the shared
// `workingAppearance` at execution time, so two quick undo/redo presses could
// leave the rig and the panel showing different states.
let historyToken = 0;

async function applyHistoryState(state) {
	const token = ++historyToken;
	const target = cloneAppearance(state);
	workingAppearance = target;
	// The index moved synchronously, so the buttons must too: gating them behind
	// the accessory fetch left Undo looking dead right after it was pressed.
	updateUndoRedoBtns();
	// Undo/redo also pay the accessory fetch, so they get the same busy feedback
	// a tile click does rather than appearing to do nothing for seconds.
	const done = beginBusy('Applying…');
	if (accessoryManager) {
		await runQueued(() => accessoryManager.hydrateFromAppearance(target));
	}
	// Catalog garments live on the rig, not in the appearance-driven accessory
	// manager, so undo/redo has to re-dress the closet explicitly or a stepped-
	// over garment stays on the body while the record says it is off.
	if (closet && token === historyToken) {
		closet.clear();
		await closet.hydrate(target.garments);
	}
	done();
	if (token !== historyToken) return;

	if (scene?.root) {
		applyAllColors();
		applyAllLayers();
		applyMorphsToRoot(scene.root, workingAppearance.morphs);
		applyProportions();
		applySculpt();
	}
	renderChips();
	renderActivePanel();
	updateUndoRedoBtns();
	updateDirtyState();
	scheduleDraftSave();
	setStatusDefault();
}

function updateUndoRedoBtns() {
	const u = $('as-undo');
	const r = $('as-redo');
	if (u) u.disabled = historyIndex <= 0;
	if (r) r.disabled = historyIndex >= history.length - 1;
}

// ── Dirty state ──────────────────────────────────────────────────────

function updateDirtyState() {
	const isDirty = isDirtyNow();

	const titleEl = document.querySelector('.as-bar-title');
	if (titleEl) {
		const base = editAvatarId ? 'Edit Avatar' : 'Avatar Studio';
		titleEl.textContent = isDirty ? `${base} ·` : base;
	}

}

// ── Randomise ────────────────────────────────────────────────────────

async function randomizeAppearance() {
	// Pick one random swatch per color slot
	for (const slot of COLOR_SLOTS) {
		const swatch = slot.swatches[Math.floor(Math.random() * slot.swatches.length)];
		workingAppearance.colors[slot.id] = swatch.toLowerCase();
		applySlotColor(slot, swatch);
	}

	// Clear existing accessories, add one hat + one glasses from presets
	const hats = presets.filter((p) => p.kind === 'hat');
	const glasses = presets.filter((p) => p.kind === 'glasses');
	if (accessoryManager) {
		for (const id of [...workingAppearance.accessories]) accessoryManager.removePreset(id);
	}
	workingAppearance.accessories = [];

	// Skeleton-space build. Randomising the whole declared range produces
	// caricatures, so each parameter gets a gentle draw around neutral, enough
	// that two random avatars read as different people, not different species.
	workingAppearance.proportions = {};
	for (const param of PROPORTION_PARAMS) {
		const spread = (Math.min(param.max - 1, 1 - param.min)) * 0.55;
		const ratio = 1 + (Math.random() * 2 - 1) * spread;
		workingAppearance.proportions[param.id] = Math.round(ratio * 1000) / 1000;
	}
	applyProportions();

	const pick = (arr) => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
	const hat = pick(hats);
	const glass = pick(glasses);
	const toApply = [hat, glass].filter(Boolean);

	// Record an accessory only once it is actually on the rig. Listing it up
	// front meant a failed fetch left a chip for something the avatar was not
	// wearing, which then got saved into the appearance record. Each apply is
	// independent so one failure cannot drop the other.
	const failed = [];
	if (accessoryManager && toApply.length) {
		const done = beginBusy('Randomising…');
		for (const p of toApply) {
			const { ok } = await runQueued(() => accessoryManager.applyPreset(p));
			if (ok) workingAppearance.accessories.push(p.id);
			else failed.push(p.name);
		}
		done();
	}

	pushHistory();
	renderChips();
	renderActivePanel();
	updateDirtyState();
	scheduleDraftSave();
	setStatus(
		failed.length ? 'err' : 'ok',
		failed.length
			? `Randomised, but ${failed.join(' and ')} couldn’t load. Everything else applied.`
			: 'Randomised! Click Save when happy.',
	);
}

// ── Proportions (skeleton-space build) ───────────────────────────────

/**
 * Push `workingAppearance.proportions` onto the live rig and re-measure the
 * animation stack.
 *
 * The re-measure is not optional bookkeeping: a clip's hip translation is
 * authored around one hip height and rescaled onto the rig at bind time, so
 * lengthening the legs without re-measuring leaves the root travelling the old
 * distance while longer legs cover more ground, and the walk foot-slides.
 * `applyProportionsToRoot` leaves the rig at rest, which is exactly the state
 * `remeasureRig` needs to read.
 */
function applyProportions() {
	if (!scene?.root) return;
	applyProportionsToRoot(scene.root, workingAppearance.proportions, { boneMap: boneNodes });
	scene.getEmoteController()?.remeasureRig?.();
	// The walk preview owns a second AnimationManager on the same rig, so it has
	// its own stale hip scale to fix.
	walkPanel?.remeasureProportions();
}

/**
 * Replay `workingAppearance.sculpt` onto the live mesh.
 *
 * Called wherever the whole appearance is restored (boot, draft restore, undo,
 * revert) rather than folded into applyProportions(), which fires on every
 * slider frame: rewriting a 15k-vertex delta array 60 times a second would be
 * wasted work, and it would stamp on a free-sculpt stroke that is mid-drag.
 */
function applySculpt() {
	if (!scene?.root) return;
	if (workingAppearance.sculpt) applySculptToRoot(scene.root, workingAppearance.sculpt);
	else clearSculpt(scene.root);
}

// ── Boot scene ────────────────────────────────────────────────────────

async function bootScene(glbUrl, editAvatar) {
	scene = new TalkScene();
	try {
		await scene.mount({
			container: $('as-stage'),
			glbUrl,
		});
		$('as-loading')?.remove();

		// Capture the skeleton's bind pose BEFORE anything can animate it. Every
		// proportion edit is applied from this rest state, so a capture taken
		// after the idle clip starts would bake a mid-stride frame in as "rest"
		// and the body would drift with every slider drag.
		boneNodes = canonicalBoneNodesFromObject(scene.root);
		captureProportionRest(scene.root, { boneMap: boneNodes });

		accessoryManager = new AccessoryManager({
			content: scene.root,
			invalidate: () => {},
		});

		// In edit mode, replay accessories from saved appearance
		if (editAvatar?.appearance) {
			await accessoryManager.hydrateFromAppearance(workingAppearance);
		}

		// Skeleton-space build (Proportions sliders). Applied before the clip
		// library binds so the first retarget already measures the real hip
		// height and root motion matches the legs.
		applyProportions();

		idle = new IdleAnimation({
			getRoot: () => scene.root,
			seed: editAvatar?.id || 'avatar-studio',
		});
		// Held rather than discarded: the Walk tab has to silence this layer
		// while a retargeted clip owns the skeleton, or the two fight per frame.
		idleDispose = scene.addOnTick((dt) => idle.update(dt));

		// Additive wardrobe. Unknown or retired garments degrade to "not worn"
		// inside hydrate rather than failing the whole boot.
		closet = new GarmentCloset({
			getRoot: () => scene?.root || null,
			getWorking: () => workingAppearance,
			// The parametric base ships a baked UV region mask, giving worn
			// garments pixel-exact skin occlusion. Other bodies use bone-cull.
			regionMaskUrl: glbUrl.includes('parametric-base')
				? '/avatars/parametric-base.regions.png'
				: null,
			onDirty: () => {
				pushHistory();
				updateDirtyState();
				scheduleDraftSave();
			},
			onChanged: () => renderChips(),
		});
		// Racks render as soon as the closet exists: browsing the catalog must not
		// wait behind re-downloading a saved outfit.
		if (activeTab === 'wardrobe') renderActivePanel();
		// Re-dressing a saved outfit is a catalog fetch plus a GLB download per
		// piece, which measured ~18s on a cold cache. Awaiting it here held the
		// whole boot tail behind it: the avatar stayed in its bind pose (the idle
		// clip loads below) and the status line still read like create mode. So
		// it runs alongside instead, and each piece repaints the racks and chips
		// as it lands through the closet's own onChanged. Every mutation the user
		// can make in the meantime is serialized behind the same queue.
		closet.hydrate(workingAppearance.garments).catch((err) => {
			log.warn('[avatar-studio] closet hydrate failed', err?.message);
			setStatus('err', 'Could not re-dress this avatar. Open Wardrobe to retry the closet.');
		});

		// Bring the rig to life: load the clip library and settle the avatar into
		// a looping idle so it leaves its bind T-pose. The clip drives the whole
		// skeleton (breathing included), so the procedural idle layer is narrowed
		// to blinking only — otherwise it would overwrite the clip's spine/head
		// rotations back to the T-pose rest each frame (it runs after the mixer).
		startIdleClip();

		setStatus('', editAvatar
			? 'Loaded your saved avatar. Make changes and save to update it.'
			: 'Choose a style below to get started.');
	} catch (err) {
		log.error('[avatar-studio] bootScene', err);
		// The loading placeholder is removed the moment the model mounts, and
		// several steps after that can still throw. Targeting only the removed
		// placeholder made those failures render nowhere at all, leaving the user
		// on a silent, half-built stage, so fall back to the stage container.
		renderStageError(
			$('as-loading') || $('as-stage'),
			'We couldn’t load the avatar. Check your connection and try again.',
		);
	}
}

// ── Walk preview ─────────────────────────────────────────────────────

// Same control the avatar editor mounts (src/avatar-walk-panel.js). In edit
// mode the "Open in Walk page" handoff stashes the *unsaved* look as a draft so
// the walk page renders the stage, not the last save. In create mode there is
// no avatar record to presign a base GLB from, so the panel says so instead of
// offering a button that would 400.
function getWalkPanel() {
	if (walkPanel) return walkPanel;
	if (!scene?.root) return null;
	walkPanel = createWalkPanel({
		getScene: () => scene,
		getStageEl: () => $('as-stage'),
		buttonClass: 'as-btn',
		emptyClass: 'as-empty',
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
		openWalkUrl: editAvatar ? buildWalkDraftUrl : null,
		saveHint: 'Save this avatar to open it in the full Walk page.',
	});
	return walkPanel;
}

function renderWalkPanel(panel) {
	const p = getWalkPanel();
	if (!p) {
		panel.innerHTML = `<div class="as-empty">Waiting for avatar to load...</div>`;
		return;
	}
	p.render(panel);
}

async function buildWalkDraftUrl(env) {
	const draftId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`)
		.replace(/[^a-z0-9]/gi, '')
		.slice(0, 40);
	const r = await apiFetch(`/api/avatars/draft/${encodeURIComponent(draftId)}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			avatar_id: editAvatar.id,
			appearance: collapseAppearance(workingAppearance),
		}),
	});
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error_description || `Could not save draft (${r.status})`);
	}
	return `/walk?avatar=${encodeURIComponent(draftId)}&preview=true&env=${encodeURIComponent(env)}`;
}

// ── Animate — live rig playback ──────────────────────────────────────

/**
 * Load the emote library and settle the avatar into its idle loop. On success
 * the procedural idle layer drops to blink-only so it stops fighting the clip;
 * on failure (manifest 404 / rig can't bind) the avatar keeps the full
 * procedural idle (breathing + blink) so it's never a dead T-pose either way.
 */
async function startIdleClip() {
	const emotes = scene?.getEmoteController?.();
	if (!emotes) {
		emotesFailed = true;
		if (activeTab === 'animate') renderActivePanel();
		return;
	}
	// A retry re-enters here, so clear the previous verdict and let the tab show
	// its loading state again rather than the stale error.
	emotesFailed = false;
	if (activeTab === 'animate') renderActivePanel();
	try {
		const ok = await emotes.loadManifest();
		if (ok && (await scene.playEmote(DEFAULT_EMOTE))) {
			emotesReady = true;
			currentEmote = DEFAULT_EMOTE;
			activeIdleClip = DEFAULT_EMOTE;
			idle?.setChannels({ breathing: false, saccade: false, weightShift: false, blink: true });
		} else {
			emotesFailed = true;
		}
	} catch (err) {
		emotesFailed = true;
		log.warn('[avatar-studio] idle clip unavailable; using procedural idle', err?.message);
	}
	if (activeTab === 'animate') renderActivePanel();
}

/**
 * Play an emote on the live rig. Looping clips become the new resting state
 * (and the idle baked into Save); one-shots play once and settle back to the
 * current idle so the avatar never freezes on a final frame.
 */
async function playEmote(name) {
	if (!emotesReady || !scene) return;
	const def = EMOTE_BY_NAME.get(name);
	if (!def) return;
	try {
		if (def.loop) {
			await scene.playEmote(name);
			currentEmote = name;
			activeIdleClip = name;
		} else {
			currentEmote = name;
			await scene.playEmoteOnce(name, { settleTo: activeIdleClip });
		}
	} catch (err) {
		log.warn(`[avatar-studio] emote "${name}" failed:`, err?.message);
	}
	if (activeTab === 'animate') markActiveEmote();
}

// ── Fetch presets ────────────────────────────────────────────────────

async function fetchPresets() {
	const r = await fetch('/accessories/presets.json');
	if (!r.ok) throw new Error(`Could not load presets (${r.status})`);
	const list = await r.json();
	if (!Array.isArray(list)) throw new Error('Accessory catalog is malformed.');
	return list;
}

/**
 * Load the accessory catalog into module state without ever throwing. The three
 * accessory tabs read `presetsState` to choose between their loading, error and
 * populated renders; every other surface keeps working regardless of outcome.
 */
async function loadPresets() {
	presetsState = 'loading';
	if (TABS.find((t) => t.id === activeTab)?.kinds.length) renderActivePanel();
	try {
		presets = await fetchPresets();
		presetsById = new Map(presets.map((p) => [p.id, p]));
		presetsState = 'ready';
		presetsError = '';
	} catch (err) {
		log.warn('[avatar-studio] accessory catalog unavailable:', err?.message);
		presets = [];
		presetsById = new Map();
		presetsState = 'error';
		presetsError = err?.message || 'Unknown error';
	}
	renderChips();
	renderActivePanel();
}

/** Retry the catalog after a failure, from the error state's Retry button. */
async function retryPresets() {
	if (presetsState === 'loading') return;
	await loadPresets();
}

// ── Rendering ────────────────────────────────────────────────────────

function renderTabs() {
	const el = $('as-tabs');
	el.innerHTML = visibleTabs().map((t) => {
		const active = t.id === activeTab;
		// The icon carries the tab on narrow viewports, where the word label is
		// hidden. `aria-label` is unconditional so the button keeps its name in
		// that layout instead of announcing an emoji (or nothing at all).
		return `
			<button class="as-tab${active ? ' active' : ''}" data-tab="${t.id}" role="tab"
			        id="as-tab-${t.id}" aria-selected="${active ? 'true' : 'false'}"
			        aria-controls="as-panel" tabindex="${active ? '0' : '-1'}"
			        aria-label="${esc(t.label)}" title="${esc(t.label)}">
				<span class="as-tab-icon" aria-hidden="true">${t.emoji}</span>
				<span class="as-tab-label">${t.label}</span>
			</button>`;
	}).join('');

	const tabs = [...el.querySelectorAll('.as-tab')];
	const selectTab = (btn, { focus = false } = {}) => {
		if (!btn || btn.dataset.tab === activeTab) {
			if (focus) btn?.focus();
			return;
		}
		activeTab = btn.dataset.tab;
		searchQuery = '';
		tabs.forEach((b) => {
			const on = b === btn;
			b.classList.toggle('active', on);
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			b.tabIndex = on ? 0 : -1;
		});
		if (focus) btn.focus();
		renderActivePanel();
	};

	tabs.forEach((btn, i) => {
		btn.addEventListener('click', () => selectTab(btn));
		btn.addEventListener('keydown', (e) => {
			let target = null;
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = tabs[(i + 1) % tabs.length];
			else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = tabs[(i - 1 + tabs.length) % tabs.length];
			else if (e.key === 'Home') target = tabs[0];
			else if (e.key === 'End') target = tabs[tabs.length - 1];
			else return;
			e.preventDefault();
			selectTab(target, { focus: true });
		});
	});
}

/**
 * The stage handed to the sculpt panel's free-sculpt brush. Returning null
 * (no scene yet) simply means the Free Sculpt group is not rendered, which is
 * the correct outcome: a brush with no canvas is a dead control.
 *
 * `setPaused` freezes clip playback AND the procedural idle. The brush caches
 * the skinned world positions of every vertex at pointer-down, so a breathing
 * chest under a live drag would make every stroke after the first land a few
 * millimetres off the pixel the user aimed at.
 */
let idleChannelsBeforeSculpt = null;

function sculptViewport() {
	if (!scene?.camera || !scene?.renderer?.domElement) return null;
	return {
		camera: scene.camera,
		domElement: scene.renderer.domElement,
		controls: scene.controls || null,
		setPaused: (paused) => {
			scene.setRigPaused?.(paused);
			if (!idle) return;
			if (paused) {
				idleChannelsBeforeSculpt = idleChannelsBeforeSculpt || idle.getChannels?.() || null;
				idle.setChannels({ breathing: false, saccade: false, blink: false, weightShift: false });
			} else if (idleChannelsBeforeSculpt) {
				idle.setChannels(idleChannelsBeforeSculpt);
				idleChannelsBeforeSculpt = null;
			}
		},
	};
}

function renderActivePanel() {
	// A re-render replaces the swatch DOM the popover is anchored to; close it
	// first so it never points at a detached node.
	closeActivePopover();
	const tabs = visibleTabs();
	let tab = tabs.find((t) => t.id === activeTab);
	if (!tab) {
		tab = tabs[0];
		activeTab = tab.id;
	}
	const panel = $('as-panel');
	panel.setAttribute('aria-labelledby', `as-tab-${activeTab}`);

	// Leaving the Walk tab tears locomotion down and restores the static stage.
	// Idempotent, so it is safe on every render regardless of the source tab.
	if (activeTab !== 'walk') walkPanel?.exit();

	if (tab.color) {
		renderColorPanel(panel);
		return;
	}

	if (tab.walk) {
		renderWalkPanel(panel);
		return;
	}

	// Wardrobe: recolour and show/hide the avatar's own baked garment layers
	// (src/avatar-wardrobe.js resolves them on arbitrary GLBs by mesh/material
	// shape, not a hardcoded name list), plus the closet of additive catalog
	// garments skinned onto the live skeleton with occlusion masking.
	if (tab.wardrobe) {
		if (!scene?.root) {
			panel.innerHTML = `<div class="as-empty">Waiting for avatar to load...</div>`;
			return;
		}
		renderWardrobePanel({
			container: panel,
			root: scene.root,
			working: workingAppearance,
			applyLayers: (layers) => accessoryManager?.applyLayers(layers),
			onDirty: () => {
				pushHistory();
				renderChips();
				updateDirtyState();
				scheduleDraftSave();
			},
		});
		// The closet renders beneath the layer cards. It exists even for models
		// with no built-in layers: being able to ADD a garment is exactly what a
		// layerless avatar needs.
		const closetMount = document.createElement('div');
		closetMount.className = 'as-closet-mount';
		panel.appendChild(closetMount);
		if (closet) {
			renderClosetSection({ container: closetMount, closet });
		} else {
			closetMount.innerHTML = '<div class="gc-loading">Closet opens when the avatar finishes loading...</div>';
		}
		return;
	}

	// Rig: rig status plus one-click auto-rig. Non-destructive (it mints a new
	// sibling avatar), so on success we hand the owner into that new avatar's
	// Studio session rather than silently swapping the model under them.
	if (tab.rig) {
		renderRigPanel({
			container: panel,
			avatar: editAvatar,
			buttonClass: 'as-btn',
			onRigged: (newAvatar) => {
				if (!newAvatar?.id) return;
				location.href = `/avatar-studio?edit=${encodeURIComponent(newAvatar.id)}`;
			},
		});
		return;
	}



	if (tab.sculpt) {
		if (!scene?.root) {
			panel.innerHTML = `<div class="as-empty">Waiting for avatar to load…</div>`;
			return;
		}
		renderSculptPanel({
			container: panel,
			root: scene.root,
			working: workingAppearance,
			viewport: sculptViewport(),
			onDirty: () => {
				pushHistory();
				renderChips();
				updateDirtyState();
				scheduleDraftSave();
			},
			// Debounced by the panel: rebuilding every bound action on each
			// slider frame would stutter the drag.
			onRigChanged: () => {
				scene?.getEmoteController()?.remeasureRig?.();
				walkPanel?.remeasureProportions();
			},
		});
		return;
	}

	if (tab.animate) {
		renderAnimatePanel(panel);
		return;
	}

	// The catalog is a separate fetch from the model, so these tabs own their
	// own loading and failure renders rather than inheriting the stage's.
	if (presetsState === 'loading') {
		panel.innerHTML = `
			<div class="as-animate-intro">Loading ${esc(tab.label.toLowerCase())}…</div>
			<div class="as-grid">${'<div class="as-tile as-skeleton" aria-hidden="true"></div>'.repeat(6)}</div>`;
		return;
	}
	if (presetsState === 'error') {
		panel.innerHTML =
			`<div class="as-error" role="alert" style="padding:48px 16px;">` +
			`<p>We couldn’t load the ${esc(tab.label.toLowerCase())} catalog.<br />` +
			`<span style="font-size:12px;">${esc(presetsError)}</span></p>` +
			`<div class="as-error-actions">` +
			`<button type="button" id="as-presets-retry">Retry</button>` +
			`</div>` +
			`<p style="font-size:12px;margin-top:18px;">Colors, sculpt and animation still work, and you can save your avatar without accessories.</p>` +
			`</div>`;
		$('as-presets-retry')?.addEventListener('click', () => retryPresets());
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
			       aria-label="Search ${esc(tab.label.toLowerCase())}"
			       value="${esc(searchQuery)}" autocomplete="off" />
		</div>`;

	if (items.length === 0) {
		const emptyMsg = q
			? `No matches for "${esc(searchQuery)}".`
			: `No ${esc(tab.label.toLowerCase())} available yet.`;
		const clearBtn = q
			? `<button class="as-empty-action" id="as-clear-search">Clear search</button>`
			: '';
		panel.innerHTML = searchHtml + `<div class="as-empty">${emptyMsg}${clearBtn}</div>`;
		bindSearch();
		$('as-clear-search')?.addEventListener('click', () => {
			searchQuery = '';
			renderActivePanel();
		});
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
		     data-fallback="remove" />
	`;
}

// ── Animate panel ────────────────────────────────────────────────────

function renderAnimatePanel(panel) {
	if (!scene?.root) {
		panel.innerHTML = `<div class="as-empty">Waiting for avatar to load…</div>`;
		return;
	}
	if (!emotesReady && emotesFailed) {
		// The avatar is still breathing and blinking on the procedural idle, so
		// say what is actually missing and offer the one action that can fix it.
		panel.innerHTML = `
			<div class="as-empty" role="alert">
				The motion library did not load, so the clips are unavailable right now.
				Your avatar is still animated and still safe to save.
				<button class="as-empty-action" type="button" data-as-retry-emotes>Try again</button>
			</div>`;
		panel
			.querySelector('[data-as-retry-emotes]')
			?.addEventListener('click', () => startIdleClip());
		return;
	}
	if (!emotesReady) {
		panel.innerHTML = `
			<div class="as-animate-intro">Loading the motion library…</div>
			<div class="as-grid as-anim-grid">${EMOTES.map(() =>
				`<div class="as-tile as-skeleton" aria-hidden="true"></div>`,
			).join('')}</div>`;
		return;
	}

	const tiles = EMOTES.map((e) => {
		const active = currentEmote === e.name;
		return `
			<button class="as-tile as-anim-tile${active ? ' selected' : ''}" type="button"
			        data-emote="${esc(e.name)}" aria-pressed="${active ? 'true' : 'false'}"
			        title="${esc(e.label)}">
				<div class="as-tile-preview" aria-hidden="true">${e.emoji}</div>
				<div class="as-tile-name">${esc(e.label)}</div>
				<div class="as-tile-kind">${e.loop ? 'loop' : 'play once'}</div>
			</button>`;
	}).join('');

	panel.innerHTML = `
		<div class="as-animate-intro">Drive the rig live. A looping motion becomes your avatar's resting idle when you save.</div>
		<div class="as-grid as-anim-grid">${tiles}</div>`;

	panel.querySelectorAll('[data-emote]').forEach((btn) => {
		btn.addEventListener('click', () => playEmote(btn.dataset.emote));
	});
}

/** Refresh the pressed/selected state of the emote tiles without a full re-render. */
function markActiveEmote() {
	const panel = $('as-panel');
	if (!panel) return;
	panel.querySelectorAll('[data-emote]').forEach((btn) => {
		const on = btn.dataset.emote === currentEmote;
		btn.classList.toggle('selected', on);
		btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	});
}

// ── Color panel ──────────────────────────────────────────────────────

// A color slot is live only when the loaded base actually carries one of its
// materials (the parametric base has skin but no hair/outfit meshes). Hiding
// dead slots beats rendering swatches that do nothing.
function slotPresent(slot) {
	if (!scene?.root) return true; // pre-load: keep the panel populated
	const names = new Set(slot.materials);
	let found = false;
	scene.root.traverse((obj) => {
		if (found || !obj.isMesh) return;
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
		if (mats.some((m) => m && names.has(m.name))) found = true;
	});
	return found;
}

function renderColorPanel(panel) {
	const ready = !!scene?.root;
	const groups = COLOR_SLOTS.filter(slotPresent).map((slot) => {
		const current = workingAppearance.colors[slot.id] || null;
		const presetMatch = current && slot.swatches.some((h) => h.toLowerCase() === current);
		const swatches = slot.swatches
			.map((hex) => {
				const pressed = current === hex.toLowerCase();
				return `<button class="as-swatch" type="button" role="radio"
					aria-checked="${pressed ? 'true' : 'false'}" aria-pressed="${pressed ? 'true' : 'false'}"
					aria-label="${esc(slot.label)} ${esc(hex)}" data-slot="${slot.id}" data-hex="${esc(hex)}"
					style="background:${esc(hex)}"></button>`;
			})
			.join('');
		const noneSel = !current;
		const customSel = current && !presetMatch;
		return `
			<div class="as-color-group" data-group="${slot.id}">
				<div class="as-color-head">
					<span class="as-color-title">${esc(slot.label)}</span>
					<span class="as-color-current">
						<span class="dot" data-current-dot style="background:${esc(current || '#ffffff')}"></span>
						<span data-current-label>${current ? esc(current.toUpperCase()) : 'Default'}</span>
					</span>
				</div>
				<div class="as-swatches" role="radiogroup" aria-label="${esc(slot.label)} color">
					<button class="as-swatch as-swatch-default" type="button" role="radio"
						aria-checked="${noneSel ? 'true' : 'false'}" aria-pressed="${noneSel ? 'true' : 'false'}"
						aria-label="${esc(slot.label)} default" data-slot="${slot.id}" data-hex=""
						title="Default"></button>
					${swatches}
					<label class="as-swatch as-swatch-custom" data-custom-slot="${slot.id}"
						role="button" tabindex="0" aria-haspopup="dialog"
						aria-label="${esc(slot.label)} custom color" title="Full-spectrum picker"
						${customSel ? 'style="border-color:var(--accent);box-shadow:0 0 0 2px var(--accent),0 0 0 4px rgba(0,0,0,0.6)"' : ''}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
						<input type="color" data-slot="${slot.id}" value="${esc(current || '#ffffff')}" tabindex="-1" aria-hidden="true" />
					</label>
				</div>
			</div>`;
	}).join('');

	ensureLayerCss();
	ensureColorExtrasCss();
	panel.innerHTML = `
		${looksBlockHtml()}
		${layersBlockHtml()}
		<p class="ae-sculpt-note" style="margin-top:16px;">Tint skin, hair and outfit. Tap the rainbow chip for the full-spectrum picker. Colors bake into your saved avatar.</p>
		${groups}
		${ready ? '' : '<div class="as-empty" style="padding-top:8px;">Waiting for avatar to load…</div>'}`;

	bindColorPanel(panel);
	bindLayersBlock(panel);
	bindLooksBlock(panel);
}

// ── Layers (show/hide) ───────────────────────────────────────────────

function layersBlockHtml() {
	// Only offer layers the loaded base actually has meshes for (the
	// parametric base ships bare: no outfit/glasses/hair to hide).
	const slots = LAYER_SLOTS.filter(slotPresent);
	if (!slots.length) return '';
	const anyStripVisible = slots.some((s) => s.strip && !workingAppearance.hidden.includes(s.id));
	const anyHidden = slots.some((s) => workingAppearance.hidden.includes(s.id));
	const toggles = slots.map((slot) => {
		const hidden = workingAppearance.hidden.includes(slot.id);
		return `<button class="as-layer${hidden ? ' off' : ''}" type="button" role="switch"
			aria-checked="${hidden ? 'false' : 'true'}" data-layer="${slot.id}"
			aria-label="${esc(slot.label)} ${hidden ? 'hidden — click to show' : 'visible — click to hide'}">
			<span class="as-layer-eye" aria-hidden="true">${hidden ? EYE_OFF : EYE_ON}</span>${esc(slot.label)}</button>`;
	}).join('');
	return `
		<div class="as-layers">
			<div class="as-layers-head">
				<span class="as-color-title">Layers</span>
				<div class="as-layers-bulk">
					<button class="as-layers-btn" type="button" id="as-strip" ${anyStripVisible ? '' : 'disabled'}>Start minimal</button>
					<button class="as-layers-btn" type="button" id="as-dress" ${anyHidden ? '' : 'disabled'}>Dress fully</button>
				</div>
			</div>
			<p class="as-layers-note">Hide a layer to strip back to the base body, then build the look up.</p>
			<div class="as-layer-row">${toggles}</div>
		</div>`;
}

function bindLayersBlock(panel) {
	panel.querySelectorAll('.as-layer[data-layer]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const nowHidden = btn.getAttribute('aria-checked') === 'true';
			setLayerHidden(btn.dataset.layer, nowHidden);
		});
	});
	panel.querySelector('#as-strip')?.addEventListener('click', stripToBase);
	panel.querySelector('#as-dress')?.addEventListener('click', dressFully);
}

function setLayerHidden(slotId, hidden) {
	const slot = LAYER_SLOTS.find((s) => s.id === slotId);
	if (!slot) return;
	const i = workingAppearance.hidden.indexOf(slotId);
	if (hidden && i < 0) workingAppearance.hidden.push(slotId);
	else if (!hidden && i >= 0) workingAppearance.hidden.splice(i, 1);
	applyLayerVisibility(slot, hidden);
	if (activeTab === 'color') renderActivePanel();
	pushHistory();
	renderChips();
	updateDirtyState();
	scheduleDraftSave();
	setStatus('', `${slot.label} ${hidden ? 'hidden' : 'shown'}.`);
}

function stripToBase() {
	for (const slot of LAYER_SLOTS) {
		if (!slot.strip) continue;
		if (!workingAppearance.hidden.includes(slot.id)) workingAppearance.hidden.push(slot.id);
		applyLayerVisibility(slot, true);
	}
	if (activeTab === 'color') renderActivePanel();
	pushHistory();
	renderChips();
	updateDirtyState();
	scheduleDraftSave();
	setStatus('', 'Stripped to the base body. Add layers back to dress it up.');
}

function dressFully() {
	for (const slot of LAYER_SLOTS) applyLayerVisibility(slot, false);
	workingAppearance.hidden = [];
	if (activeTab === 'color') renderActivePanel();
	pushHistory();
	renderChips();
	updateDirtyState();
	scheduleDraftSave();
	setStatus('', 'All layers shown.');
}

function applyLayerVisibility(slot, hidden) {
	if (!scene?.root) return;
	const names = new Set(slot.materials);
	scene.root.traverse((obj) => {
		if (!obj.isMesh) return;
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
		if (mats.some((m) => m && names.has(m.name))) obj.visible = !hidden;
	});
}

function applyAllLayers() {
	for (const slot of LAYER_SLOTS) {
		applyLayerVisibility(slot, workingAppearance.hidden.includes(slot.id));
	}
}

// The guard is the injected node itself, not a module-scoped `let`. init() now
// paints the rail before its first await, so this runs while the module body is
// still evaluating and any binding declared below here would still be in its
// temporal dead zone: a `let` flag threw a ReferenceError that took the whole
// page down to its error state.
function ensureLayerCss() {
	if (document.getElementById('as-layer-css')) return;
	const style = document.createElement('style');
	style.id = 'as-layer-css';
	style.textContent = `
		.as-layers { border: 1px solid var(--border, #1f1f1f); border-radius: 12px; background: var(--panel, #111); padding: 12px 14px; }
		.as-layers-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
		.as-layers-bulk { display: flex; gap: 6px; }
		.as-layers-btn { background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a); color: var(--text-2, #a1a1aa); font: 600 11px/1 inherit; padding: 6px 10px; border-radius: 7px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
		.as-layers-btn:hover:not([disabled]) { color: var(--text, #fafafa); border-color: var(--text-3, #71717a); background: rgba(255,255,255,.03); }
		.as-layers-btn[disabled] { opacity: .4; cursor: default; pointer-events: none; }
		.as-layers-note { font-size: 11px; color: var(--text-3, #71717a); line-height: 1.5; margin: 8px 0 12px; }
		.as-layer-row { display: flex; flex-wrap: wrap; gap: 8px; }
		.as-layer { display: inline-flex; align-items: center; gap: 7px; background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a); color: var(--text, #fafafa); font: 500 12px/1 inherit; padding: 8px 12px; border-radius: 999px; cursor: pointer; transition: color .15s, border-color .15s, opacity .15s; }
		.as-layer:hover { border-color: var(--text-3, #71717a); }
		.as-layer .as-layer-eye { display: inline-flex; color: var(--text-2, #a1a1aa); }
		.as-layer.off { color: var(--text-3, #71717a); border-style: dashed; }
		.as-layer.off .as-layer-eye { color: var(--text-3, #555); }
	`;
	document.head.appendChild(style);
}

function bindColorPanel(panel) {
	panel.querySelectorAll('.as-swatch[data-slot]').forEach((btn) => {
		btn.addEventListener('click', () => setSlotColor(btn.dataset.slot, btn.dataset.hex || null));
	});
	// Native OS picker stays wired as a fallback for the advanced popover.
	panel.querySelectorAll('input[type="color"][data-slot]').forEach((input) => {
		const slot = input.dataset.slot;
		input.addEventListener('input', () => liveSlotColor(slot, input.value));
		input.addEventListener('change', () => setSlotColor(slot, input.value));
	});
	// Rainbow chip → full-spectrum iro.js popover (wheel + hex + eyedropper).
	panel.querySelectorAll('.as-swatch-custom[data-custom-slot]').forEach((label) => {
		const slot = label.dataset.customSlot;
		label.addEventListener('click', (e) => { e.preventDefault(); openCustomPicker(slot, label); });
		label.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCustomPicker(slot, label); }
		});
	});
}

// Open the advanced color picker for a slot. A whole open→drag→close session
// collapses to a single undo step: soft updates apply live while open, and one
// history entry is pushed on close only if the color actually changed.
function openCustomPicker(slotId, anchorEl) {
	const slot = COLOR_SLOT_BY_ID.get(slotId);
	if (!slot) return;
	const sessionStart = workingAppearance.colors[slotId] || null;
	openColorPopover({
		anchorEl,
		title: slot.label,
		current: sessionStart || '#ffffff',
		onInput: (hex) => liveSlotColor(slotId, hex),
		onChange: (hex) => softSetSlotColor(slotId, hex),
		onClose: () => endColorSession(slotId, sessionStart),
	}).catch((err) => {
		// iro failed to even open → fall back to the native OS color dialog.
		log.warn('[avatar-studio] color popover failed, using native picker', err);
		const input = anchorEl.querySelector('input[type="color"]');
		if (input) { try { input.showPicker(); } catch { input.click(); } }
	});
}

function softSetSlotColor(slotId, hex) {
	const slot = COLOR_SLOT_BY_ID.get(slotId);
	if (!slot || !HEX_RE.test(hex)) return;
	workingAppearance.colors[slotId] = hex.toLowerCase();
	applySlotColor(slot, hex);
	liveSlotColor(slotId, hex); // keep the group's current dot/label in sync
	renderChips();
	updateDirtyState();
	scheduleDraftSave();
}

function endColorSession(slotId, sessionStart) {
	const now = workingAppearance.colors[slotId] || null;
	if (now !== sessionStart) pushHistory();
	if (activeTab === 'color') renderActivePanel();
	updateDirtyState();
}

// ── Looks (one-tap palettes) ─────────────────────────────────────────

function looksBlockHtml() {
	const cards = LOOKS.map((look) => {
		const active = COLOR_SLOTS.every(
			(s) => (workingAppearance.colors[s.id] || null) === (look.colors[s.id] || null),
		);
		const grad = `linear-gradient(135deg, ${look.colors.skin} 0 34%, ${look.colors.hair} 34% 67%, ${look.colors.outfit} 67% 100%)`;
		return `<button class="as-look${active ? ' active' : ''}" type="button"
			data-look="${esc(look.id)}" aria-pressed="${active ? 'true' : 'false'}" title="${esc(look.name)} look">
			<span class="as-look-sw" style="background:${grad}"></span>
			<span class="as-look-name">${esc(look.name)}</span>
		</button>`;
	}).join('');
	return `
		<div class="as-looks">
			<div class="as-looks-head">
				<span class="as-color-title">Looks</span>
				<span class="as-looks-hint">One-tap palettes</span>
			</div>
			<div class="as-looks-row">${cards}</div>
		</div>`;
}

function bindLooksBlock(panel) {
	panel.querySelectorAll('.as-look[data-look]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const look = LOOKS.find((l) => l.id === btn.dataset.look);
			if (look) applyLook(look);
		});
	});
}

function applyLook(look) {
	for (const slot of COLOR_SLOTS) {
		const hex = look.colors[slot.id];
		if (!hex) continue;
		workingAppearance.colors[slot.id] = hex.toLowerCase();
		applySlotColor(slot, hex);
	}
	pushHistory();
	renderChips();
	if (activeTab === 'color') renderActivePanel();
	updateDirtyState();
	scheduleDraftSave();
	setStatus('ok', `Applied the ${look.name} look.`);
}

// Same DOM-node guard as ensureLayerCss, and for the same reason: this runs
// while the module is still evaluating, so a flag declared here is in its
// temporal dead zone at the only moment it is read.
function ensureColorExtrasCss() {
	if (document.getElementById('as-color-extras-css')) return;
	const style = document.createElement('style');
	style.id = 'as-color-extras-css';
	style.textContent = `
		.as-looks { margin-bottom: 18px; }
		.as-looks-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 10px; }
		.as-looks-hint { font-size: 11px; color: var(--text-3, #71717a); }
		.as-looks-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 8px; }
		.as-look { display: flex; flex-direction: column; align-items: center; gap: 6px; background: var(--panel, #111); border: 1px solid var(--border, #1f1f1f); border-radius: 11px; padding: 8px 6px 7px; cursor: pointer; font-family: inherit; transition: border-color .15s, transform .12s, background .15s; }
		.as-look:hover { border-color: var(--text-3, #71717a); transform: translateY(-1px); background: rgba(255,255,255,.03); }
		.as-look:focus-visible { outline: none; border-color: var(--accent, #fff); box-shadow: 0 0 0 2px var(--accent, #fff); }
		.as-look.active { border-color: var(--accent, #fff); background: rgba(255,255,255,.05); }
		.as-look-sw { width: 100%; aspect-ratio: 1/1; border-radius: 8px; border: 1px solid rgba(255,255,255,.12); }
		.as-look-name { font-size: 11px; font-weight: 600; color: var(--text-2, #a1a1aa); }
		.as-look.active .as-look-name { color: var(--text, #fafafa); }
		.as-swatch-custom[role="button"] { display: inline-flex; align-items: center; justify-content: center; }
		.as-swatch-custom:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent, #fff); }
	`;
	document.head.appendChild(style);
}

function setSlotColor(slotId, hex) {
	const slot = COLOR_SLOT_BY_ID.get(slotId);
	if (!slot) return;
	if (hex && HEX_RE.test(hex)) {
		workingAppearance.colors[slotId] = hex.toLowerCase();
	} else {
		delete workingAppearance.colors[slotId];
	}
	applySlotColor(slot, workingAppearance.colors[slotId] || null);
	if (activeTab === 'color') renderActivePanel();
	pushHistory();
	renderChips();
	updateDirtyState();
	scheduleDraftSave();
	const c = workingAppearance.colors[slotId];
	setStatus('', c ? `${slot.label} → ${c.toUpperCase()}` : `${slot.label} reset to default.`);
}

function liveSlotColor(slotId, hex) {
	const slot = COLOR_SLOT_BY_ID.get(slotId);
	if (!slot || !HEX_RE.test(hex)) return;
	applySlotColor(slot, hex);
	const group = document.querySelector(`.as-color-group[data-group="${cssEscape(slotId)}"]`);
	if (!group) return;
	const dot = group.querySelector('[data-current-dot]');
	const label = group.querySelector('[data-current-label]');
	if (dot) dot.style.background = hex;
	if (label) label.textContent = hex.toUpperCase();
}

function applySlotColor(slot, hex) {
	if (!scene?.root) return;
	const names = new Set(slot.materials);
	scene.root.traverse((obj) => {
		if (!obj.isMesh) return;
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
		for (const m of mats) {
			if (!m || !m.color || !names.has(m.name)) continue;
			// "Default" restores the material's authored color. On textured RPM
			// bases that's white (factor x texture = skin); on factor-colored
			// bases like the parametric body, white would bleach it.
			if (m.userData.origColor === undefined) m.userData.origColor = `#${m.color.getHexString()}`;
			m.color.set(hex || m.userData.origColor);
		}
	});
}

function applyAllColors() {
	for (const slot of COLOR_SLOTS) {
		applySlotColor(slot, workingAppearance.colors[slot.id] || null);
	}
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
	const parts = [];

	for (const id of workingAppearance.accessories) {
		const p = presetsById.get(id);
		if (!p) continue;
		parts.push(`
			<span class="as-chip" data-id="${esc(id)}">
				<span class="as-chip-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
				<span>${esc(p.name)}</span>
				<button type="button" aria-label="Remove ${esc(p.name)}" data-remove="${esc(id)}">×</button>
			</span>`);
	}

	for (const slot of COLOR_SLOTS) {
		const hex = workingAppearance.colors[slot.id];
		if (!hex) continue;
		parts.push(`
			<span class="as-chip" data-color="${slot.id}">
				<span class="as-chip-dot" style="background:${esc(hex)}"></span>
				<span class="as-chip-kind">${esc(slot.label)}</span>
				<button type="button" aria-label="Reset ${esc(slot.label)}" data-reset-color="${slot.id}">×</button>
			</span>`);
	}

	for (const slot of LAYER_SLOTS) {
		if (!workingAppearance.hidden.includes(slot.id)) continue;
		parts.push(`
			<span class="as-chip" data-hidden="${slot.id}">
				<span class="as-chip-kind">${esc(slot.label)}</span>
				<span>hidden</span>
				<button type="button" aria-label="Show ${esc(slot.label)}" data-show-layer="${slot.id}">×</button>
			</span>`);
	}

	// Worn catalog garments. Read from the closet rather than
	// `workingAppearance.garments` so a chip only ever names a piece that is
	// actually on the rig (hydrate drops retired ids).
	for (const [slot, entry] of closet?.attached() || []) {
		const name = entry?.manifest?.name;
		if (!name) continue;
		parts.push(`
			<span class="as-chip" data-garment="${esc(slot)}">
				<span class="as-chip-kind">${esc(SLOT_LABEL_ONE[slot] || slot)}</span>
				<span>${esc(name)}</span>
				<button type="button" aria-label="Take off ${esc(name)}" data-takeoff="${esc(slot)}">×</button>
			</span>`);
	}

	el.innerHTML = parts.join('');

	// detach() emits onDirty + onChanged, which re-runs this render and refreshes
	// the closet racks through their own subscription, so nothing else to do here.
	el.querySelectorAll('button[data-takeoff]').forEach((btn) => {
		btn.addEventListener('click', () => closet?.detach(btn.dataset.takeoff));
	});

	el.querySelectorAll('button[data-remove]').forEach((btn) => {
		btn.addEventListener('click', () => removeCommitted(btn.dataset.remove));
	});
	el.querySelectorAll('button[data-reset-color]').forEach((btn) => {
		btn.addEventListener('click', () => setSlotColor(btn.dataset.resetColor, null));
	});
	el.querySelectorAll('button[data-show-layer]').forEach((btn) => {
		btn.addEventListener('click', () => setLayerHidden(btn.dataset.showLayer, false));
	});
}

function tileSelected(tab, presetId) {
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
	return workingAppearance.accessories.includes(presetId);
}

function committedIdForKind(kind) {
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

	const preset = presetId ? presetsById.get(presetId) : null;
	const label = preset ? preset.name : `${tab.label.toLowerCase()}`;
	// Fetching and rigging an accessory GLB takes seconds on a slow link. Without
	// this the tile click looked like it did nothing at all until the model
	// popped in, and a failed fetch was completely silent.
	const done = beginBusy(presetId ? `Putting on ${label}…` : `Removing ${label}…`);
	const { ok, error } = await runQueued(() => applyAccessory(tab, presetId || null));
	done();

	pushHistory();
	renderActivePanel();
	renderChips();
	updateDirtyState();
	scheduleDraftSave();

	if (!ok) {
		setStatus('err', `Couldn’t load ${label}: ${error?.message || 'Unknown error'}. Tap it again to retry.`);
		return;
	}
	setStatus('ok', presetId ? `${label} on.` : `${label} removed.`);
}

async function removeCommitted(id) {
	const preset = presetsById.get(id);
	if (!preset) return;
	previewedId = null;
	previewToken++;
	const done = beginBusy(`Removing ${preset.name}…`);
	await runQueued(async () => {
		accessoryManager?.removePreset(id);
	});
	done();
	workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
	pushHistory();
	renderActivePanel();
	renderChips();
	updateDirtyState();
	scheduleDraftSave();
	setStatus('ok', `${preset.name} removed.`);
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

// ── Header / keyboard ────────────────────────────────────────────────

function bindHeader() {
	$('as-save').addEventListener('click', () => saveAvatar());
	$('as-reset').addEventListener('click', () => resetAll());
	bindPlayAs();
	// A renamed avatar is an unsaved change too, so keep the dirty marker honest.
	$('as-name')?.addEventListener('input', () => updateDirtyState());
	$('as-randomize')?.addEventListener('click', () => randomizeAppearance());
	$('as-undo')?.addEventListener('click', () => undoAppearance());
	$('as-redo')?.addEventListener('click', () => redoAppearance());
}

// "Play as this": drop straight into /play wearing the avatar on the stage.
// Only offered in edit mode, where there is a saved record for /play to load;
// a create-mode draft has nothing to hand over until Save mints one. Unsaved
// edits are committed first, so /play never renders a stale look.
function bindPlayAs() {
	const btn = $('as-play');
	if (!btn) return;
	if (!editAvatar) return;
	btn.hidden = false;
	btn.addEventListener('click', async () => {
		btn.disabled = true;
		try {
			if (isDirtyNow()) {
				// The PATCH directly, not saveAvatar(): the full save path ends in a
				// success toast and a redirect to the avatar page, which would race
				// the handoff into /play.
				setStatus('spin', 'Saving your look before you play...');
				await patchEditedAvatar(editAvatarId, currentName(), collapseAppearance(workingAppearance));
				savedAppearance = cloneAppearance(workingAppearance);
				updateDirtyState();
			}
			setStatus('spin', 'Entering /play...');
			await playAs({ id: editAvatar.id, name: currentName(), dest: '/play' });
		} catch (err) {
			setStatus('err', err.message);
			btn.disabled = false;
		}
	});
}

function bindKeyboard() {
	document.addEventListener('keydown', (e) => {
		const mod = e.metaKey || e.ctrlKey;
		if (!mod) return;
		if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoAppearance(); }
		else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redoAppearance(); }
		else if (e.key === 's') { e.preventDefault(); saveAvatar(); }
	});
}

async function resetAll() {
	previewedId = null;
	previewToken++;
	await queueOp(async () => {
		const wasIds = [...workingAppearance.accessories].filter(Boolean);
		if (accessoryManager) {
			for (const id of wasIds) accessoryManager.removePreset(id);
		}
		// Reset clears what Studio controls, which now includes the closet. The
		// baked `outfit` preset id has no Studio UI, so it is not Studio's to
		// throw away and rides through untouched.
		workingAppearance = {
			...hydrateAppearance(null),
			outfit: workingAppearance.outfit ?? null,
		};
		closet?.clear();
		if (scene?.root) {
			applyMorphsToRoot(scene.root, {});
			applyProportions();
			applyAllColors();
			applyAllLayers();
		}
		if (accessoryManager) await accessoryManager.hydrateFromAppearance(workingAppearance);
	});
	pushHistory();
	renderChips();
	renderActivePanel();
	updateDirtyState();
	scheduleDraftSave();
	setStatus('', 'Reset to default.');
}

function setStatusDefault() {
	setStatus('', 'Hover any item to try it on. Click to keep.');
}

function setStatus(kind, text) {
	// The rail is gone once renderStageError() has replaced the shell, and every
	// later status write would then throw on top of the failure it is reporting.
	const el = $('as-status');
	if (!el) return;
	el.className = `as-status${kind ? ' ' + kind : ''}`;
	el.innerHTML = kind === 'spin' ? `<span class="spin"></span>${esc(text)}` : esc(text);
}

// ── Save flow ─────────────────────────────────────────────────────────

// Export the live Three.js scene as a GLB blob using GLTFExporter.
// This captures colours (applied to material.color), morph weights, and
// bone-attached accessories — all already in the scene graph. No server
// bake required; what the user sees is what gets uploaded.
async function exportSceneGlb() {
	if (!scene?.root) throw new Error('Scene not ready — cannot export.');
	const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
	const exporter = new GLTFExporter();

	// GLTFExporter writes each bone's *current* local transform as the exported
	// file's rest pose, and a Studio export carries no clips, so whatever the idle
	// happened to be doing at this instant would be frozen into the saved avatar
	// forever. Export from the bind pose instead: symmetric, identical across
	// repeated saves, and the neutral every downstream consumer (retargeting,
	// garment binding, other engines) assumes.
	//
	// The mixer has to be stopped first, not just paused: processNodeAsync awaits
	// per node, so a render tick landing mid-traversal would re-animate bones the
	// exporter had not read yet and tear the pose across the skeleton.
	const emotes = scene.getEmoteController?.();
	emotes?.stopAll();
	const savedBones = captureBoneTransforms(scene.root);
	poseSkeletonsToBind(scene.root);

	try {
		const buf = await new Promise((resolve, reject) => {
			exporter.parse(
				scene.root,
				resolve,
				reject,
				{
					binary: true,
					embedImages: true,
					animations: scene._clips || [],
				},
			);
		});
		return new Blob([buf], { type: 'model/gltf-binary' });
	} finally {
		// Put the live scene back exactly as the user left it. The thumbnail is
		// captured from this scene later in finishSave(), so it keeps the relaxed
		// idle stance that the frozen-frame export was originally reaching for.
		restoreBoneTransforms(savedBones, scene.root);
		if (emotesReady) {
			scene.playEmote(activeIdleClip).catch((err) => {
				log.warn('[avatar-studio] idle resume after export failed:', err?.message);
			});
		}
	}
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
	const name = currentName();
	const saveBtn = $('as-save');
	const resetBtn = $('as-reset');
	saveBtn.disabled = true;
	resetBtn.disabled = true;

	const appearance = collapseAppearance(workingAppearance);

	// For edit mode, nudge the user if nothing changed
	if (editAvatarId && name === savedName && appearanceEqual(workingAppearance, savedAppearance)) {
		setStatus('', 'No changes to save.');
		saveBtn.disabled = false;
		resetBtn.disabled = false;
		return;
	}

	showSaveOverlay(editAvatarId ? 'Updating avatar...' : 'Exporting avatar...', 'Building your customised model');
	updateProgress(5);

	try {
		if (editAvatarId) {
			// ── Edit mode: appearance is the source of truth ─────────────
			// Everything Studio can change (colours, morphs, accessories, hidden
			// layers) is replayed server-side by the bake, and the base body cannot
			// be switched while editing, so there is no new geometry to upload.
			// Re-exporting the live scene over the record's GLB would overwrite the
			// pristine base with an already-dressed re-export, and the bake that
			// follows the appearance PATCH would then apply the same appearance a
			// second time: doubled colour multiplies and duplicated accessories on
			// top of a base the user can never get back.
			updateSaveOverlay('Saving customisation...', 'Rebuilding your model');
			updateProgress(30);
			const avatar = await patchEditedAvatar(editAvatarId, name, appearance);
			updateProgress(90);
			await finishSave(avatar);
			return;
		}

		// ── Step 1: Export the live scene as a GLB ──────────────────
		// This captures all colours, morphs, and accessories already applied
		// to the Three.js scene — no server-side bake needed.
		updateSaveOverlay('Exporting model...', 'Capturing colours and accessories');
		// Catalog garments are re-baked from the appearance record PATCHed below,
		// so the uploaded base must not already be wearing them (see
		// GarmentCloset#withGarmentsOff). The closet puts them straight back.
		const rawGlbBlob = closet
			? await closet.withGarmentsOff(() => exportSceneGlb())
			: await exportSceneGlb();
		updateProgress(15);

		// ── Step 1b: Compress + validate before upload ──────────────
		// GLTFExporter output is correct but heavy (uncompressed buffers,
		// re-embedded textures). Run the same conservative glTF-Transform passes
		// the server bake uses, then validate. Non-fatal: on any failure this
		// returns the original export untouched, so the save always completes.
		updateSaveOverlay('Optimizing model...', 'Compressing geometry for fast loads');
		const { blob: glbBlob } = await optimizeAndValidateGlb(rawGlbBlob, {
			onStatus: (sub) => updateSaveOverlay('Optimizing model...', sub),
		});
		updateProgress(20);

		// ── Step 2: Upload the GLB + create/update the DB record ────
		updateSaveOverlay('Uploading...', 'Sending to your library');

		const avatar = await saveRemoteGlbToAccount(
			glbBlob,
			{
				name,
				source: 'direct-upload',
				source_meta: { generator: 'avatar-studio', body_type: BODY_TYPE },
				visibility: 'public',
			},
			{
				onProgress: (pct) => updateProgress(20 + pct * 0.6),
			},
		);
		updateProgress(82);

		// ── Step 3: PATCH appearance for re-editability ─────────────
		// The exported GLB already has everything baked; this PATCH only stores
		// the appearance JSON as metadata so /create/studio?edit= can reload it.
		if (appearance) {
			updateSaveOverlay('Saving customisation data...');
			const patchRes = await apiFetch(`/api/avatars/${encodeURIComponent(avatar.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ appearance }),
			});
			if (!patchRes.ok) {
				// Appearance metadata failed, but the GLB is already uploaded and correct.
				// Log for debugging but don't block the save — the avatar will look right,
				// it just won't be re-editable via ?edit= until this is retried.
				const body = await patchRes.json().catch(() => ({}));
				log.warn('[avatar-studio] appearance PATCH failed (non-fatal):', body);
			}
		}
		updateProgress(92);

		await finishSave(avatar);
	} catch (err) {
		hideSaveOverlay();
		log.error('[avatar-studio] save failed:', err);

		if (err.code === 'not_signed_in' || err.stage === 'auth') {
			const next = encodeURIComponent(location.pathname + location.search);
			window.location.replace(`/login?next=${next}`);
			return;
		}

		// A dropped connection surfaces as the browser's bare "Failed to fetch",
		// which tells the user nothing they can act on. Name the cause and the
		// next move instead; every other error already carries a server message
		// worth showing, so that one only needs the retry nudge appended.
		const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
		const networkFailure =
			offline || /failed to fetch|networkerror|load failed|network request failed/i.test(err.message || '');
		setStatus(
			'err',
			networkFailure
				? 'Save failed: could not reach three.ws. Your look is still here, so check your connection and press Save again.'
				: `Save failed: ${err.message || 'Unknown error'}. Press Save to try again.`,
		);
		saveBtn.disabled = false;
		resetBtn.disabled = false;
	}
}

// Persist an edit-mode save. The record keeps its original GLB as the base and
// the server bakes `appearance` onto it, so this is a metadata-only PATCH: the
// pristine base survives every edit and the appearance is applied exactly once.
// `appearance` is null when the user cleared every customisation, which the API
// reads as "drop the baked GLB and serve the base again".
async function patchEditedAvatar(avatarId, name, appearance) {
	const res = await apiFetch(`/api/avatars/${encodeURIComponent(avatarId)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name, appearance }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		const err = new Error(body.message || `Avatar update failed (${res.status})`);
		err.code = body.error;
		throw err;
	}
	const { avatar } = await res.json();
	savedName = name;
	return avatar;
}

// Shared success tail for both save paths: thumbnail, saved-state bookkeeping,
// toast, redirect.
async function finishSave(avatar) {
	// A Studio snapshot only represents the avatar faithfully when Studio drew
	// everything it is wearing. Closet garments now ARE on the live rig, so they
	// photograph correctly; a baked `outfit` preset id still has no Studio UI and
	// is not in the scene, so overwriting the thumbnail while one is set would
	// show the avatar undressed. Leave the existing thumbnail alone in that case.
	const wearsUnrenderedLayers = !!workingAppearance.outfit;
	if (!wearsUnrenderedLayers) {
		updateSaveOverlay('Capturing thumbnail...');
		try {
			await uploadAvatarSnapshot({ avatarId: avatar.id, scene });
		} catch (err) {
			log.warn('[avatar-studio] snapshot upload failed:', err?.message);
		}
	}

	updateProgress(100);
	updateSaveOverlay('Done!', editAvatarId ? 'Avatar updated.' : 'Avatar saved to your library.');

	savedAppearance = cloneAppearance(workingAppearance);
	clearDraft();
	updateDirtyState();

	await new Promise((r) => setTimeout(r, 700));
	hideSaveOverlay();

	// Mid-wizard: skip the toast and hand the avatar straight back to /start.
	if (returnToWizard({ avatarId: avatar.id, avatarName: name, avatarThumb: avatar.thumbnail_url || '' })) return;

	// Show a save-success toast with next-step CTAs (launch a coin / view).
	// Give the user time to choose; fall back to the avatar page if they don't.
	showSaveToast(avatar.id);

	await new Promise((r) => setTimeout(r, 5000));
	window.location.href = `/avatars/${encodeURIComponent(avatar.id)}`;
}

function showSaveToast(avatarId) {
	const el = document.createElement('div');
	el.className = 'as-toast';
	// Saved avatars are real, on-chain-launchable assets — surface the coin
	// path as a first-class next step, not just "view". The ?launch=1 deep-link
	// auto-opens the launch panel on the avatar page.
	el.innerHTML = `
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="as-toast-icon" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
		<span>Saved to your library.</span>
		<a href="/avatars/${esc(avatarId)}?launch=1" class="as-toast-link" style="font-weight:600">🪙 Launch a coin →</a>
		<a href="/avatars/${esc(avatarId)}" class="as-toast-link">View avatar</a>
	`;
	document.body.appendChild(el);
	// Animate in
	requestAnimationFrame(() => el.classList.add('visible'));
}
