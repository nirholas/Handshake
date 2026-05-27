/**
 * Avatar Studio Demo — standalone avatar customization without Avaturn.
 *
 * Wires TalkScene (Three.js renderer), AccessoryManager (outfit/accessory
 * presets), IdleAnimation (breathing/blink/saccade/weight shift), and the
 * sculpt system (ARKit-52 sliders + face-type blend wheel) into a single
 * self-contained page. No auth, no database — pure client-side.
 */

import { TalkScene } from './voice/talk-scene.js';
import { AccessoryManager } from './agent-accessories.js';
import { IdleAnimation } from './idle-animation.js';
import {
	discoverMorphs,
	applyMorphsToRoot,
	renderSculptPanel,
} from './avatar-sculpt.js';

const BASE_GLB = '/avatars/default.glb';
const PRESETS_URL = '/accessories/presets.json';

let scene = null;
let accessoryMgr = null;
let idle = null;
let presets = [];
let activeTab = 'outfit';
let appearance = { outfit: null, accessories: [], morphs: {} };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
	const presetsRes = await fetch(PRESETS_URL);
	if (!presetsRes.ok) throw new Error(`Failed to load presets: ${presetsRes.status}`);
	const [presetsData] = await Promise.all([
		presetsRes.json(),
		mountScene(),
	]);
	presets = presetsData;

	wireAccessoryManager();
	wireIdleAnimation();
	wireTabNav();
	wireCameraPresets();
	wireAnimationSelect();
	wireExport();
	wireResetAll();
	wirePresetInteraction();

	renderActiveTab();
	renderChips();
	setStatus('Ready — customize your avatar');
}

// ── Scene mount ───────────────────────────────────────────────────────────────

async function mountScene() {
	const container = $('#as-viewport');
	scene = new TalkScene();
	await scene.mount({ container, glbUrl: BASE_GLB, cameraPreset: 'full' });
	$('#as-viewport-loader')?.classList.add('hidden');
}

// ── AccessoryManager adapter ──────────────────────────────────────────────────

function wireAccessoryManager() {
	const viewerAdapter = {
		get content() { return scene.root; },
		invalidate() {},
	};
	accessoryMgr = new AccessoryManager(viewerAdapter);
}

// ── Idle animation ────────────────────────────────────────────────────────────

function wireIdleAnimation() {
	idle = new IdleAnimation({
		getRoot: () => scene.root,
		seed: 'studio-demo',
	});
	scene.addOnTick((dt) => idle.update(dt));
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function wireTabNav() {
	$('#as-tabs').addEventListener('click', (e) => {
		const tab = e.target.closest('[data-tab]');
		if (!tab) return;
		activeTab = tab.dataset.tab;
		$$('.as-tab').forEach((t) => {
			const isActive = t.dataset.tab === activeTab;
			t.classList.toggle('active', isActive);
			t.setAttribute('aria-selected', isActive);
		});
		renderActiveTab();
	});
}

// ── Camera presets ────────────────────────────────────────────────────────────

function wireCameraPresets() {
	$('#as-cam-bar').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-preset]');
		if (!btn) return;
		$$('.as-cam-btn').forEach((b) => b.classList.remove('active'));
		btn.classList.add('active');
		scene.setCameraPreset(btn.dataset.preset);
	});
}

// ── Animation select ──────────────────────────────────────────────────────────

async function wireAnimationSelect() {
	const select = $('#as-anim-select');
	const emotes = scene.getEmoteController();
	if (!emotes) return;

	try {
		await emotes.loadManifest();
	} catch {
		return;
	}

	const defs = emotes.getAllDefs();
	for (const def of defs) {
		const opt = document.createElement('option');
		opt.value = def.name;
		opt.textContent = def.label || def.name;
		select.appendChild(opt);
	}

	select.addEventListener('change', () => {
		const val = select.value;
		if (!val) return;
		scene.playEmote(val);
		select.value = '';
	});
}

// ── Export GLB ─────────────────────────────────────────────────────────────────

function wireExport() {
	$('#as-export').addEventListener('click', async () => {
		if (!scene.root) return;
		setStatus('Exporting GLB…');
		const btn = $('#as-export');
		btn.disabled = true;

		try {
			const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
			const exporter = new GLTFExporter();
			const glb = await new Promise((resolve, reject) => {
				exporter.parse(
					scene.root,
					(result) => resolve(result),
					(err) => reject(err),
					{ binary: true, animations: scene._clips || [] },
				);
			});
			const blob = new Blob([glb], { type: 'model/gltf-binary' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'avatar.glb';
			a.click();
			URL.revokeObjectURL(url);
			setStatus('Exported avatar.glb');
		} catch (err) {
			console.error('[studio] export failed:', err);
			setStatus(`Export failed: ${err.message}`);
		} finally {
			btn.disabled = false;
		}
	});
}

// ── Reset all ─────────────────────────────────────────────────────────────────

function wireResetAll() {
	$('#as-reset-all').addEventListener('click', async () => {
		for (const id of accessoryMgr.list()) {
			accessoryMgr.removePreset(id);
		}
		const allMorphs = discoverMorphs(scene.root);
		applyMorphsToRoot(scene.root, Object.fromEntries(allMorphs.map((n) => [n, 0])));
		appearance = { outfit: null, accessories: [], morphs: {} };
		renderActiveTab();
		renderChips();
		setStatus('Reset to default');
	});
}

// ── Preset interaction (event delegation) ─────────────────────────────────────
// Wired once on #as-tab-content. Hover → live preview. Click → commit.

let _hoverPreview = null;

function wirePresetInteraction() {
	const container = $('#as-tab-content');

	container.addEventListener('click', async (e) => {
		const card = e.target.closest('.as-preset-card');
		if (!card) return;
		try {
			await handlePresetClick(card);
		} catch (err) {
			console.warn('[studio] preset click failed:', err);
			setStatus(`Failed: ${err.message}`);
		}
	});

	container.addEventListener('pointerenter', async (e) => {
		const card = e.target.closest('.as-preset-card');
		if (!card) return;
		const id = card.dataset.presetId;
		const preset = presets.find((p) => p.id === id);
		if (!preset) return;
		_hoverPreview = id;
		try {
			await accessoryMgr.applyPreset(preset);
		} catch (err) {
			console.warn('[studio] hover preview failed:', err);
		}
	}, true);

	container.addEventListener('pointerleave', async (e) => {
		const card = e.target.closest('.as-preset-card');
		if (!card || !_hoverPreview) return;
		_hoverPreview = null;
		try {
			await revertToCommitted();
		} catch (err) {
			console.warn('[studio] revert failed:', err);
		}
	}, true);
}

// ── Tab rendering ─────────────────────────────────────────────────────────────

function renderActiveTab() {
	const container = $('#as-tab-content');
	if (activeTab === 'sculpt') {
		renderSculptTab(container);
	} else {
		renderPresetTab(container, activeTab);
	}
}

function renderPresetTab(container, kind) {
	const items = presets.filter((p) => p.kind === kind);
	if (!items.length) {
		container.innerHTML = '<div class="as-empty">No presets available for this category.</div>';
		return;
	}

	const iconFallback = { outfit: 'O', hat: 'H', glasses: 'G', earrings: 'E' };
	const isActive = (preset) => {
		if (preset.kind === 'outfit') return appearance.outfit === preset.id;
		return appearance.accessories.includes(preset.id);
	};

	container.innerHTML = `
		<div class="as-preset-grid">
			${items.map((p) => `
				<div class="as-preset-card ${isActive(p) ? 'active' : ''}"
				     data-preset-id="${esc(p.id)}" role="button" tabindex="0">
					<div class="as-preset-icon">
						${p.thumbnail
							? `<img src="${esc(p.thumbnail)}" alt="${esc(p.name)}" loading="lazy">`
							: `<span>${iconFallback[p.kind] || '?'}</span>`}
					</div>
					<span class="as-preset-name">${esc(p.name)}</span>
				</div>
			`).join('')}
		</div>
	`;
}

// ── Preset commit logic ───────────────────────────────────────────────────────

async function handlePresetClick(card) {
	const id = card.dataset.presetId;
	const preset = presets.find((p) => p.id === id);
	if (!preset) return;

	_hoverPreview = null;

	if (preset.kind === 'outfit') {
		if (appearance.outfit === id) {
			appearance.outfit = null;
			accessoryMgr.removePreset(id);
		} else {
			if (appearance.outfit) accessoryMgr.removePreset(appearance.outfit);
			appearance.outfit = id;
			await accessoryMgr.applyPreset(preset);
		}
	} else {
		const idx = appearance.accessories.indexOf(id);
		if (idx >= 0) {
			appearance.accessories.splice(idx, 1);
			accessoryMgr.removePreset(id);
		} else {
			const isSingle = ['hat', 'glasses'].includes(preset.kind);
			if (isSingle) {
				const existing = appearance.accessories.find((aid) => {
					const p = presets.find((pp) => pp.id === aid);
					return p && p.kind === preset.kind;
				});
				if (existing) {
					appearance.accessories = appearance.accessories.filter((a) => a !== existing);
				}
			}
			appearance.accessories.push(id);
			await accessoryMgr.applyPreset(preset);
		}
	}

	renderActiveTab();
	renderChips();
	setStatus(`${preset.name} ${isPresetActive(preset) ? 'applied' : 'removed'}`);
}

function isPresetActive(preset) {
	if (preset.kind === 'outfit') return appearance.outfit === preset.id;
	return appearance.accessories.includes(preset.id);
}

async function revertToCommitted() {
	for (const id of accessoryMgr.list()) {
		const isCommitted = id === appearance.outfit || appearance.accessories.includes(id);
		if (!isCommitted) accessoryMgr.removePreset(id);
	}

	const byId = new Map(presets.map((p) => [p.id, p]));
	const committed = [];
	if (appearance.outfit) committed.push(appearance.outfit);
	committed.push(...appearance.accessories);

	for (const id of committed) {
		if (!accessoryMgr.list().includes(id)) {
			const preset = byId.get(id);
			if (preset) await accessoryMgr.applyPreset(preset);
		}
	}
}

// ── Sculpt tab ────────────────────────────────────────────────────────────────

const AE_TO_AS_MAP = [
	['ae-sculpt-group', 'as-sculpt-group'],
	['ae-sculpt-row', 'as-sculpt-row'],
	['ae-sculpt-head', 'as-sculpt-head'],
	['ae-sculpt-rows', 'as-sculpt-rows'],
	['ae-sculpt-label', 'as-sculpt-label'],
	['ae-sculpt-name', 'as-sculpt-name'],
	['ae-sculpt-meta', 'as-sculpt-meta'],
	['ae-sculpt-value', 'as-sculpt-value'],
	['ae-sculpt-count', 'as-sculpt-count'],
	['ae-sculpt-mirror', 'as-sculpt-mirror'],
	['ae-sculpt-note', 'as-sculpt-note'],
	['ae-sculpt-capture', 'as-btn as-btn-ghost as-btn-sm'],
	['ae-sculpt-reset', 'as-btn as-btn-ghost as-btn-sm'],
	['ae-blend-canvas', 'as-blend-canvas'],
	['ae-blend-puck', 'as-blend-puck'],
	['ae-blend-label', 'as-blend-label'],
	['ae-blend-group', 'as-blend-group'],
	['ae-blend-body', 'as-sculpt-rows'],
	['ae-blend-desc', 'as-blend-desc'],
	['ae-btn', 'as-btn as-btn-ghost as-btn-sm'],
	['ae-face-backdrop', 'as-face-backdrop'],
	['ae-face-dialog', 'as-face-dialog'],
	['ae-face-close', 'as-face-close'],
	['ae-face-lede', 'as-face-lede'],
	['ae-face-stage', 'as-face-stage'],
	['ae-face-status', 'as-face-status'],
	['ae-face-actions', 'as-face-actions'],
];

function renderSculptTab(container) {
	renderSculptPanel({
		container,
		root: scene.root,
		working: appearance,
		onDirty: () => {},
	});

	for (const [aeClass, asClasses] of AE_TO_AS_MAP) {
		container.querySelectorAll(`.${aeClass}`).forEach((el) => {
			el.classList.add(...asClasses.split(' '));
		});
	}

	document.querySelectorAll(`.ae-face-backdrop`).forEach((el) => {
		for (const [aeClass, asClasses] of AE_TO_AS_MAP) {
			el.querySelectorAll(`.${aeClass}`).forEach((child) => {
				child.classList.add(...asClasses.split(' '));
			});
		}
	});
}

// ── Chips ─────────────────────────────────────────────────────────────────────

function renderChips() {
	const container = $('#as-chips');
	const chips = [];

	if (appearance.outfit) {
		const p = presets.find((pp) => pp.id === appearance.outfit);
		if (p) chips.push(chipHtml(p));
	}
	for (const id of appearance.accessories) {
		const p = presets.find((pp) => pp.id === id);
		if (p) chips.push(chipHtml(p));
	}

	container.innerHTML = chips.join('');

	container.querySelectorAll('.as-chip-remove').forEach((btn) => {
		btn.addEventListener('click', async (e) => {
			const id = e.currentTarget.dataset.presetId;
			const preset = presets.find((p) => p.id === id);
			if (!preset) return;

			if (preset.kind === 'outfit') {
				appearance.outfit = null;
			} else {
				appearance.accessories = appearance.accessories.filter((a) => a !== id);
			}
			accessoryMgr.removePreset(id);
			renderActiveTab();
			renderChips();
			setStatus(`${preset.name} removed`);
		});
	});
}

function chipHtml(preset) {
	return `
		<span class="as-chip">
			${esc(preset.name)}
			<button class="as-chip-remove" data-preset-id="${esc(preset.id)}" aria-label="Remove ${esc(preset.name)}">×</button>
		</span>
	`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(msg) {
	const el = $('#as-status');
	if (el) el.textContent = msg;
}

function esc(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ── Teardown ──────────────────────────────────────────────────────────────────

window.addEventListener('pagehide', () => {
	idle?.dispose();
	scene?.unmount();
});

// ── Init ──────────────────────────────────────────────────────────────────────

boot().catch((err) => {
	console.error('[avatar-studio] boot failed:', err);
	setStatus(`Failed to initialize: ${err.message}`);
	$('#as-viewport-loader')?.classList.add('hidden');
});
