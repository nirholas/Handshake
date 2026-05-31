/**
 * Avatar wardrobe — layered garment editor for /create/studio and /avatars/:id/edit
 *
 * Modern rigged avatars (Ready Player Me / Wolf3D, Avaturn, most Blender/Mixamo
 * exports) are NOT a single welded mesh — the body, hair, and garments ship as
 * separate skinned meshes that share one skeleton, each with its own named,
 * texture-backed material. That makes two real operations possible:
 *
 *   1. Recolour a layer — multiply its material(s) by a chosen colour. White /
 *      "default" leaves the authored texture untouched; a tint reads as dyed
 *      fabric, not a flat fill (glTF baseColorFactor semantics).
 *   2. Strip to the base body — hide the garment meshes to expose the base
 *      mannequin, then dress it back up one layer at a time.
 *
 * This module is the single source of truth for that layer taxonomy. It detects
 * which slots a loaded GLB actually exposes (no invented controls — same
 * contract as the sculpt panel), renders the Wardrobe panel, and exports the
 * pure helpers AccessoryManager uses to push slot state onto the live scene.
 *
 * Slot state round-trips through appearance:
 *   appearance.colors = { skin:'#rrggbb', hair, outfit, … }   // per-slot tint
 *   appearance.hidden = ['outfit', 'glasses', …]              // hidden slots
 * It survives the same save → validate → server-bake → viewer path as
 * accessories/morphs. Keep slot ids + the material/mesh patterns below in sync
 * with api/_lib/bake.js (baker) and api/_lib/accessories.js (validation).
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Slot taxonomy. `materials` lists exact material names for the avatars we ship
 * (Wolf3D = Ready Player Me, avaturn_* = Avaturn); `match` is a name fallback so
 * arbitrary user-uploaded GLBs in the editor still resolve. A mesh joins a slot
 * if any of its materials matches by exact name OR regex (on material or mesh
 * name). `strip` slots are the ones "Start minimal" hides — hair and skin stay.
 * ────────────────────────────────────────────────────────────────────────── */

export const WARDROBE_SLOTS = [
	{
		id: 'skin',
		label: 'Skin tone',
		materials: ['Wolf3D_Skin', 'Wolf3D_Body', 'avaturn_body_material'],
		match: /(^|[_-])(skin|body)(?![a-z])/i,
		palette: 'skin',
		removable: false,
		strip: false,
	},
	{
		id: 'hair',
		label: 'Hair',
		materials: ['Wolf3D_Hair', 'avaturn_hair_0_material'],
		match: /hair/i,
		palette: 'hair',
		removable: true,
		strip: false,
	},
	{
		id: 'outfit',
		label: 'Outfit',
		materials: [
			'Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Outfit_Footwear',
			'avaturn_look_0_material', 'avaturn_shoes_0_material',
		],
		match: /outfit|shirt|jacket|hoodie|sweater|dress|pants|trouser|jeans|skirt|shorts|footwear|shoe|boot|sneaker|(^|[_-])(top|bottom|look)(?![a-z])/i,
		palette: 'garment',
		removable: true,
		strip: true,
	},
	{
		id: 'glasses',
		label: 'Glasses',
		materials: ['Wolf3D_Glasses'],
		match: /glass|eyewear|spectacle/i,
		palette: null,
		removable: true,
		strip: true,
	},
];

export const WARDROBE_SLOT_IDS = WARDROBE_SLOTS.map((s) => s.id);
const SLOT_BY_ID = new Map(WARDROBE_SLOTS.map((s) => [s.id, s]));

/* Curated palettes. The leading `null` swatch clears the tint (authored colour).
 * Tints multiply the base-colour texture, so they read as a recolour. */
export const PALETTES = {
	skin: [null, '#ffe9d6', '#f3c1a3', '#e0a878', '#c08552', '#9c6b44', '#6f4a32', '#4a2f20'],
	hair: [null, '#0e0e0e', '#3b2417', '#6b4423', '#9a6a3a', '#c89b5a', '#d8b34a', '#b8b8b8', '#e2604a', '#9b5cc0', '#4a86d6'],
	garment: [null, '#222831', '#f2f2f2', '#1e3a5f', '#7a1f2b', '#1f6b3a', '#c08a1e', '#6b3fa0', '#d4577e', '#3b6ea5', '#101010'],
};

export const HEX_RE = /^#[0-9a-f]{6}$/i;

/* ────────────────────────────────────────────────────────────────────────── *
 * Detection — pure, shared with AccessoryManager and (by mirror) the baker
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve, for the loaded scene root, which slots are present and the concrete
 * meshes + materials each one controls.
 * @returns {Map<string, { meshes: Set<object>, materials: Set<object> }>}
 */
export function collectSlotTargets(root) {
	const out = new Map();
	root?.traverse?.((obj) => {
		if (!obj.isMesh || !obj.geometry) return;
		const mats = materialsOf(obj);
		const def = slotDefFor(obj, mats);
		if (!def) return;
		if (!out.has(def.id)) out.set(def.id, { meshes: new Set(), materials: new Set() });
		const entry = out.get(def.id);
		entry.meshes.add(obj);
		for (const m of mats) entry.materials.add(m);
	});
	return out;
}

function slotDefFor(mesh, mats) {
	const meshName = mesh.name || '';
	const matNames = mats.map((m) => m?.name || '');
	for (const def of WARDROBE_SLOTS) {
		if (matNames.some((n) => def.materials.includes(n))) return def;
		if (def.match.test(meshName) || matNames.some((n) => def.match.test(n))) return def;
	}
	return null;
}

function materialsOf(mesh) {
	if (Array.isArray(mesh.material)) return mesh.material.filter(Boolean);
	return mesh.material ? [mesh.material] : [];
}

/** Ordered list of slots present on this model. Drives the panel. */
export function discoverSlots(root) {
	const targets = collectSlotTargets(root);
	return WARDROBE_SLOTS.filter((def) => targets.has(def.id)).map((def) => ({ def }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Panel
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {object} opts.root        three.js scene root (slot discovery)
 * @param {object} opts.working     workingAppearance — we mutate .colors & .hidden
 * @param {(layers:{colors:object,hidden:string[]})=>void} opts.applyLayers
 * @param {()=>void} opts.onDirty
 */
export function renderWardrobePanel({ container, root, working, applyLayers, onDirty }) {
	injectCss();
	working.colors = working.colors || {};
	working.hidden = Array.isArray(working.hidden) ? working.hidden : [];

	if (!root) {
		container.innerHTML = `<div class="aw-empty">Waiting for the avatar to load…</div>`;
		return;
	}

	const slots = discoverSlots(root);
	if (!slots.length) {
		container.innerHTML = `
			<div class="aw-empty">
				This model doesn't expose separate garment meshes, so there are no
				layers to recolour or remove. Re-import through
				<a href="/create" style="color:inherit">/create</a> for a layered avatar.
			</div>`;
		return;
	}

	const stripSlots = slots.filter((s) => s.def.strip);
	const anyDressed = stripSlots.some((s) => !working.hidden.includes(s.def.id));
	const anyHidden = stripSlots.some((s) => working.hidden.includes(s.def.id));

	container.innerHTML = `
		<p class="aw-note">
			This avatar is built from separate layers. Hide a layer to strip back to
			the base body, then dress it up — recolour each piece and stack
			accessories on top.
		</p>
		<div class="aw-bulk">
			<button class="aw-bulk-btn" type="button" id="aw-strip" ${anyDressed ? '' : 'disabled'}>
				<span aria-hidden="true">◍</span> Start minimal
			</button>
			<button class="aw-bulk-btn" type="button" id="aw-dress" ${anyHidden ? '' : 'disabled'}>
				<span aria-hidden="true">✦</span> Dress fully
			</button>
		</div>
		<div class="aw-list">
			${slots.map((s) => slotCardHtml(s.def, working)).join('')}
		</div>
	`;

	wirePanel(container, root, working, applyLayers, onDirty);
}

function slotCardHtml(def, working) {
	const hidden = working.hidden.includes(def.id);
	const color = working.colors[def.id] || null;
	const palette = def.palette ? PALETTES[def.palette] : null;

	const toggle = def.removable
		? `<button class="aw-eye" type="button" data-slot="${def.id}" role="switch"
		        aria-checked="${hidden ? 'false' : 'true'}" aria-label="${escAttr(def.label)} visible">
			${hidden ? eyeOff() : eyeOn()}
		   </button>`
		: '';

	const swatches = palette
		? `<div class="aw-swatches" data-slot="${def.id}" role="group" aria-label="${escAttr(def.label)} colour">
			${palette.map((c) => swatchHtml(def.id, c, color)).join('')}
			${customSwatchHtml(def.id, color, palette)}
		   </div>`
		: '';

	return `
		<div class="aw-card${hidden ? ' aw-card-off' : ''}" data-slot-card="${def.id}">
			<div class="aw-card-head">
				<span class="aw-card-name">${escHtml(def.label)}</span>
				<span class="aw-card-state" data-state="${def.id}">${hidden ? 'Hidden' : 'On'}</span>
				${toggle}
			</div>
			${swatches}
		</div>
	`;
}

function swatchHtml(slotId, color, current) {
	const isDefault = color === null;
	const selected = isDefault ? !current : current?.toLowerCase() === color.toLowerCase();
	const style = isDefault
		? 'background:repeating-conic-gradient(#3a3a3a 0deg 90deg,#2a2a2a 90deg 180deg) 0 0/10px 10px'
		: `background:${color}`;
	return `
		<button class="aw-swatch${selected ? ' selected' : ''}${isDefault ? ' aw-swatch-default' : ''}"
		        type="button" data-slot="${slotId}" data-color="${isDefault ? '' : escAttr(color)}"
		        style="${style}" title="${isDefault ? 'Default (original)' : escAttr(color)}"
		        aria-label="${isDefault ? 'Default colour' : escAttr(color)}"
		        aria-pressed="${selected}"></button>
	`;
}

function customSwatchHtml(slotId, current, palette) {
	const inPalette = !current || palette.some((c) => c && c.toLowerCase() === current.toLowerCase());
	const selected = !!current && !inPalette;
	return `
		<label class="aw-swatch aw-swatch-custom${selected ? ' selected' : ''}"
		       title="Custom colour" aria-label="Custom colour">
			<input type="color" data-slot="${slotId}" value="${escAttr(current || '#888888')}" />
			<span aria-hidden="true">+</span>
		</label>
	`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Wiring — targeted DOM updates so the native colour picker keeps focus
 * ────────────────────────────────────────────────────────────────────────── */

function wirePanel(container, root, working, applyLayers, onDirty) {
	const commit = () => {
		applyLayers({ colors: working.colors, hidden: working.hidden });
		onDirty?.();
	};

	container.querySelectorAll('.aw-eye[data-slot]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.slot;
			const nowHidden = btn.getAttribute('aria-checked') === 'true'; // on → hide
			setHidden(working, id, nowHidden);
			reflectVisibility(container, id, nowHidden);
			commit();
		});
	});

	container.querySelectorAll('.aw-swatch[data-slot]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.slot;
			setColor(working, id, btn.dataset.color || null);
			reflectColor(container, id, btn.dataset.color || null);
			commit();
		});
	});

	container.querySelectorAll('input[type="color"][data-slot]').forEach((input) => {
		input.addEventListener('input', () => {
			const id = input.dataset.slot;
			setColor(working, id, input.value);
			reflectColor(container, id, input.value);
			commit();
		});
	});

	container.querySelector('#aw-strip')?.addEventListener('click', () => {
		for (const s of discoverSlots(root)) if (s.def.strip) setHidden(working, s.def.id, true);
		commit();
		renderWardrobePanel({ container, root, working, applyLayers, onDirty });
	});
	container.querySelector('#aw-dress')?.addEventListener('click', () => {
		for (const s of discoverSlots(root)) if (s.def.strip) setHidden(working, s.def.id, false);
		commit();
		renderWardrobePanel({ container, root, working, applyLayers, onDirty });
	});
}

function reflectVisibility(container, slotId, hidden) {
	const card = container.querySelector(`[data-slot-card="${cssEscape(slotId)}"]`);
	const eye = container.querySelector(`.aw-eye[data-slot="${cssEscape(slotId)}"]`);
	const state = container.querySelector(`[data-state="${cssEscape(slotId)}"]`);
	card?.classList.toggle('aw-card-off', hidden);
	if (eye) {
		eye.setAttribute('aria-checked', hidden ? 'false' : 'true');
		eye.innerHTML = hidden ? eyeOff() : eyeOn();
	}
	if (state) state.textContent = hidden ? 'Hidden' : 'On';
	const strip = container.querySelector('#aw-strip');
	const dress = container.querySelector('#aw-dress');
	if (strip) strip.disabled = !container.querySelector('.aw-eye[aria-checked="true"]');
	if (dress) dress.disabled = !container.querySelector('.aw-eye[aria-checked="false"]');
}

function reflectColor(container, slotId, color) {
	const group = container.querySelector(`.aw-swatches[data-slot="${cssEscape(slotId)}"]`);
	if (!group) return;
	const norm = color ? color.toLowerCase() : null;
	let matched = false;
	group.querySelectorAll('.aw-swatch[data-color]').forEach((sw) => {
		const c = sw.dataset.color ? sw.dataset.color.toLowerCase() : null;
		const sel = c === norm;
		if (sel) matched = true;
		sw.classList.toggle('selected', sel);
		sw.setAttribute('aria-pressed', String(sel));
	});
	group.querySelector('.aw-swatch-custom')?.classList.toggle('selected', !!norm && !matched);
}

function setHidden(working, slotId, hidden) {
	if (!SLOT_BY_ID.get(slotId)?.removable) return;
	const has = working.hidden.includes(slotId);
	if (hidden && !has) working.hidden.push(slotId);
	else if (!hidden && has) working.hidden = working.hidden.filter((id) => id !== slotId);
}

function setColor(working, slotId, color) {
	if (!SLOT_BY_ID.has(slotId)) return;
	if (color && HEX_RE.test(color)) working.colors[slotId] = color.toLowerCase();
	else delete working.colors[slotId];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Icons + CSS
 * ────────────────────────────────────────────────────────────────────────── */

function eyeOn() {
	return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function eyeOff() {
	return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}

let _cssInjected = false;
function injectCss() {
	if (_cssInjected || typeof document === 'undefined') return;
	_cssInjected = true;
	const style = document.createElement('style');
	style.id = 'aw-css';
	style.textContent = `
		.aw-note { font-size: 12px; color: var(--text-3, #71717a); line-height: 1.55; margin: 0 0 14px; }
		.aw-empty { color: var(--text-3, #71717a); font-size: 13px; padding: 24px 4px; text-align: center; line-height: 1.6; }
		.aw-bulk { display: flex; gap: 8px; margin-bottom: 14px; }
		.aw-bulk-btn {
			flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
			background: var(--panel, #111); border: 1px solid var(--border-2, #2a2a2a);
			color: var(--text-2, #a1a1aa); padding: 9px 12px; border-radius: 9px; cursor: pointer;
			font: 600 12px/1 inherit; transition: color .15s, border-color .15s, background .15s;
		}
		.aw-bulk-btn:hover:not([disabled]) { color: var(--text, #fafafa); border-color: var(--text-3, #71717a); background: rgba(255,255,255,.03); }
		.aw-bulk-btn[disabled] { opacity: .4; cursor: default; pointer-events: none; }
		.aw-list { display: flex; flex-direction: column; gap: 8px; }
		.aw-card {
			border: 1px solid var(--border, #1f1f1f); border-radius: 11px; background: var(--panel, #111);
			padding: 12px 14px; transition: border-color .15s, opacity .15s;
		}
		.aw-card-off { opacity: .62; border-style: dashed; }
		.aw-card-head { display: flex; align-items: center; gap: 10px; }
		.aw-card-name { font-size: 13px; font-weight: 600; color: var(--text, #fafafa); }
		.aw-card-state {
			font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3, #71717a);
			border: 1px solid var(--border-2, #2a2a2a); border-radius: 999px; padding: 2px 7px; margin-left: auto;
		}
		.aw-eye {
			display: inline-flex; align-items: center; justify-content: center;
			width: 32px; height: 28px; border-radius: 7px; cursor: pointer;
			background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a); color: var(--text-2, #a1a1aa);
			transition: color .15s, border-color .15s;
		}
		.aw-eye:hover { color: var(--text, #fafafa); border-color: var(--text-3, #71717a); }
		.aw-eye[aria-checked="false"] { color: var(--text-3, #555); }
		.aw-card-state { margin-left: auto; }
		.aw-card-head .aw-eye { margin-left: 0; }
		.aw-swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
		.aw-swatch {
			width: 24px; height: 24px; border-radius: 7px; cursor: pointer; padding: 0;
			border: 1px solid rgba(255,255,255,.16); position: relative; transition: transform .1s, box-shadow .12s;
		}
		.aw-swatch:hover { transform: translateY(-1px); }
		.aw-swatch.selected { box-shadow: 0 0 0 2px var(--bg, #0a0a0a), 0 0 0 4px var(--accent, #fff); }
		.aw-swatch-custom {
			display: inline-flex; align-items: center; justify-content: center; overflow: hidden;
			color: var(--text-2, #a1a1aa); font-size: 15px; font-weight: 600;
			background: var(--panel-2, #161616); border-style: dashed;
		}
		.aw-swatch-custom input[type="color"] { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: 0; padding: 0; }
	`;
	document.head.appendChild(style);
}

/* ── escapes ── */
function escHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escAttr(s) { return escHtml(s); }
function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
