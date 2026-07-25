// Garment closet — the additive half of the wardrobe.
//
// src/avatar-wardrobe.js is subtractive: it recolours or hides garment layers
// already baked into the avatar's GLB. This module is what lets the user put
// ON something the avatar was never generated with: it renders a catalog rack
// per slot, and on click runs the full attach flow —
//
//     fetch GLB → verify sha256 against the manifest → parse → attachGarment
//     (skin rebind onto the avatar's skeleton) → applySkinOcclusion
//
// — with per-slot eviction, occlusion re-union on every change, and a
// `working.garments` array the editor persists exactly like colors/hidden.
//
// The GLTFLoader import is dynamic so browsing the editor without opening the
// closet never pays for the loader.

import {
	attachGarment,
	detachSlot,
	applySkinOcclusion,
	restoreSkin,
	findAvatarSkeleton,
	supportsWardrobe,
	GARMENT_SLOTS,
} from './avatar-garment.js';
import { loadCatalog, bySlot, verifyModelBytes } from './garment-catalog.js';
import { log } from './shared/log.js';

const SLOT_LABELS = {
	top: 'Tops', bottom: 'Bottoms', footwear: 'Footwear', outerwear: 'Outerwear',
	hair: 'Hair', headwear: 'Headwear', glasses: 'Glasses', accessory: 'Accessories',
};

/**
 * Controller for one avatar's attached garments. Owns the scene-side state;
 * the persisted state is the `working.garments` array of `{slot, id}` refs.
 */
export class GarmentCloset {
	/**
	 * @param {object} opts
	 * @param {() => object|null} opts.getRoot   live avatar scene root
	 * @param {object} opts.working              workingAppearance (mutated: .garments)
	 * @param {() => void} [opts.onDirty]
	 * @param {() => void} [opts.onChanged]      re-render hook (state text, chips)
	 */
	constructor({ getRoot, working, onDirty, onChanged }) {
		this.getRoot = getRoot;
		this.working = working;
		this.working.garments = Array.isArray(working.garments) ? working.garments : [];
		this.onDirty = onDirty || (() => {});
		this.onChanged = onChanged || (() => {});
		// slot → { manifest, result } for what is live in the scene right now
		this._attached = new Map();
		this._loader = null;
		// Serialize attach/detach so two clicks can't race one slot.
		this._queue = Promise.resolve();
		this._glbCache = new Map(); // manifest uri → ArrayBuffer promise
	}

	async _getLoader() {
		if (!this._loader) {
			const [{ GLTFLoader }, { getMeshoptDecoder }] = await Promise.all([
				import('three/addons/loaders/GLTFLoader.js'),
				import('./viewer/internal.js'),
			]);
			this._loader = new GLTFLoader();
			this._loader.setMeshoptDecoder(await getMeshoptDecoder());
		}
		return this._loader;
	}

	_enqueue(fn) {
		this._queue = this._queue.then(fn, fn);
		return this._queue;
	}

	/** Manifests currently attached, keyed by slot. */
	attached() {
		return new Map(this._attached);
	}

	/**
	 * Attach `manifest`, evicting whatever holds its slot. Resolves to the
	 * attachGarment result (ok:false results carry a user-actionable reason).
	 */
	attach(manifest) {
		return this._enqueue(async () => {
			const root = this.getRoot();
			if (!root) return { ok: false, reason: 'avatar not loaded yet' };
			if (!supportsWardrobe(root)) {
				return { ok: false, reason: 'this model has no humanoid skeleton to dress' };
			}

			const bytes = await this._fetchModel(manifest);
			if (!(await verifyModelBytes(bytes, manifest))) {
				this._glbCache.delete(manifest.model.uri);
				return { ok: false, reason: 'downloaded file failed its integrity check' };
			}

			const loader = await this._getLoader();
			const gltf = await loader.parseAsync(bytes.slice(0), '');

			// Evict the incumbent only after the replacement parsed — a failed
			// download must never leave the slot empty.
			this._detachNow(manifest.slot);

			const result = attachGarment(root, gltf.scene, {
				slot: manifest.slot,
				rigidBone: manifest.rig?.attachBone || 'Head',
			});
			if (!result.ok) {
				log('garment-closet', `attach ${manifest.id} refused: ${result.reason}`);
				this._reoccludeAll();
				return result;
			}

			this._attached.set(manifest.slot, { manifest, result });
			this._syncWorking();
			this._reoccludeAll();
			this.onDirty();
			this.onChanged();
			return result;
		});
	}

	/** Take off whatever occupies `slot`. */
	detach(slot) {
		return this._enqueue(async () => {
			this._detachNow(slot);
			this._syncWorking();
			this._reoccludeAll();
			this.onDirty();
			this.onChanged();
		});
	}

	/**
	 * Re-attach garments from a persisted `{slot, id}` list (avatar load, or
	 * discard-changes). Unknown ids are dropped from working state and reported,
	 * so a deleted catalog entry degrades to "not worn" instead of an error loop.
	 */
	async hydrate(refs) {
		const { garments } = await loadCatalog();
		const index = new Map(garments.map((g) => [`${g.slot}/${g.id}`, g]));
		const missing = [];
		for (const ref of refs || []) {
			const manifest = index.get(`${ref.slot}/${ref.id}`);
			if (!manifest) { missing.push(ref); continue; }
			const res = await this.attach(manifest);
			if (!res.ok) missing.push(ref);
		}
		if (missing.length) {
			log('garment-closet', `hydrate dropped ${missing.length} unavailable garment(s)`);
			this._syncWorking();
		}
		return { missing };
	}

	/** Detach everything (model swap teardown). Scene-side only. */
	clear() {
		for (const slot of [...this._attached.keys()]) this._detachNow(slot);
		this._reoccludeAll();
	}

	_detachNow(slot) {
		const root = this.getRoot();
		if (root) detachSlot(root, slot);
		this._attached.delete(slot);
	}

	_syncWorking() {
		this.working.garments = [...this._attached.values()].map(({ manifest }) => ({
			slot: manifest.slot,
			id: manifest.id,
		}));
	}

	/** Recompute skin occlusion as the union of every attached garment. */
	_reoccludeAll() {
		const root = this.getRoot();
		if (!root) return;
		const body = findAvatarSkeleton(root);
		if (body?.mesh?.geometry) restoreSkin(body.mesh.geometry);
		const regions = new Set();
		for (const { manifest } of this._attached.values()) {
			for (const r of manifest.occludes || []) regions.add(r);
		}
		if (regions.size) applySkinOcclusion(root, [...regions]);
	}

	async _fetchModel(manifest) {
		const uri = manifest.model.uri;
		if (!this._glbCache.has(uri)) {
			const p = fetch(uri).then(async (res) => {
				if (!res.ok) throw new Error(`garment download failed: ${res.status}`);
				return res.arrayBuffer();
			});
			p.catch(() => this._glbCache.delete(uri));
			this._glbCache.set(uri, p);
		}
		return this._glbCache.get(uri);
	}
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Panel section
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Render the closet rack into `container` and wire it to `closet`.
 * Designed to sit directly under renderWardrobePanel's output.
 */
export async function renderClosetSection({ container, closet }) {
	injectCss();
	container.innerHTML = `<div class="gc-loading">Loading closet…</div>`;

	let catalog;
	try {
		catalog = await loadCatalog();
	} catch (err) {
		container.innerHTML = `
			<div class="gc-error" role="alert">
				Couldn't reach the closet.
				<button class="gc-retry" type="button">Retry</button>
			</div>`;
		container.querySelector('.gc-retry').addEventListener('click', async () => {
			try { await loadCatalog({ force: true }); } catch { /* rendered below */ }
			renderClosetSection({ container, closet });
		});
		log('garment-closet', `catalog load failed: ${err?.message || err}`);
		return;
	}

	const grouped = bySlot(catalog.garments);
	if (!catalog.garments.length) {
		container.innerHTML = `
			<div class="gc-empty">
				The closet is empty right now — new pieces land here as they're
				published. Generate your own on <a href="/forge">/forge</a>.
			</div>`;
		return;
	}

	const worn = closet.attached();
	container.innerHTML = `
		<h3 class="gc-title">Closet</h3>
		<p class="gc-note">Put on catalog pieces — they bind to this avatar's skeleton and move with every animation.</p>
		${GARMENT_SLOTS.filter((s) => grouped.has(s)).map((slot) => `
			<div class="gc-rack" data-rack="${slot}">
				<div class="gc-rack-head">
					<span class="gc-rack-name">${SLOT_LABELS[slot] || slot}</span>
					<button class="gc-takeoff" type="button" data-slot="${slot}"
						${worn.has(slot) ? '' : 'hidden'}>Take off</button>
				</div>
				<div class="gc-tiles" role="group" aria-label="${SLOT_LABELS[slot] || slot}">
					${grouped.get(slot).map((g) => tileHtml(g, worn.get(g.slot)?.manifest?.id === g.id)).join('')}
				</div>
			</div>
		`).join('')}
		<div class="gc-status" role="status" aria-live="polite"></div>
	`;

	wireSection(container, closet, catalog);
}

function tileHtml(g, isWorn) {
	const thumb = g.preview?.thumbnail
		? `<img src="${escAttr(g.preview.thumbnail)}" alt="" loading="lazy" />`
		: `<span class="gc-tile-fallback" aria-hidden="true">◆</span>`;
	return `
		<button class="gc-tile${isWorn ? ' worn' : ''}" type="button"
		        data-garment="${escAttr(g.id)}" data-slot="${escAttr(g.slot)}"
		        aria-pressed="${isWorn}" title="${escAttr(g.name)}">
			${thumb}
			<span class="gc-tile-name">${escHtml(g.name)}</span>
		</button>
	`;
}

function wireSection(container, closet, catalog) {
	const byKey = new Map(catalog.garments.map((g) => [`${g.slot}/${g.id}`, g]));
	const status = container.querySelector('.gc-status');
	const setStatus = (msg) => { if (status) status.textContent = msg || ''; };

	const refresh = () => {
		const worn = closet.attached();
		container.querySelectorAll('.gc-tile').forEach((tile) => {
			const isWorn = worn.get(tile.dataset.slot)?.manifest?.id === tile.dataset.garment;
			tile.classList.toggle('worn', isWorn);
			tile.setAttribute('aria-pressed', String(isWorn));
		});
		container.querySelectorAll('.gc-takeoff').forEach((btn) => {
			btn.hidden = !worn.has(btn.dataset.slot);
		});
	};

	container.querySelectorAll('.gc-tile').forEach((tile) => {
		tile.addEventListener('click', async () => {
			const manifest = byKey.get(`${tile.dataset.slot}/${tile.dataset.garment}`);
			if (!manifest) return;
			const worn = closet.attached().get(manifest.slot)?.manifest?.id === manifest.id;
			tile.classList.add('busy');
			setStatus(worn ? `Taking off ${manifest.name}…` : `Putting on ${manifest.name}…`);
			try {
				if (worn) {
					await closet.detach(manifest.slot);
					setStatus('');
				} else {
					const res = await closet.attach(manifest);
					setStatus(res.ok ? '' : `Couldn't wear ${manifest.name}: ${res.reason}`);
				}
			} finally {
				tile.classList.remove('busy');
				refresh();
			}
		});
	});

	container.querySelectorAll('.gc-takeoff').forEach((btn) => {
		btn.addEventListener('click', async () => {
			await closet.detach(btn.dataset.slot);
			setStatus('');
			refresh();
		});
	});
}

/* ── styles ──────────────────────────────────────────────────────────────── */

let cssInjected = false;
function injectCss() {
	if (cssInjected || typeof document === 'undefined') return;
	cssInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.gc-title { margin: 18px 0 4px; font-size: 14px; font-weight: 600; }
		.gc-note { margin: 0 0 10px; font-size: 12px; opacity: 0.65; }
		.gc-rack { margin-bottom: 14px; }
		.gc-rack-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
		.gc-rack-name { font-size: 12px; font-weight: 600; opacity: 0.8; }
		.gc-takeoff { font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.18);
			background: transparent; color: inherit; cursor: pointer; transition: background 0.15s ease; }
		.gc-takeoff:hover { background: rgba(255,255,255,0.08); }
		.gc-takeoff:focus-visible { outline: 2px solid #d4ed3a; outline-offset: 1px; }
		.gc-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; }
		.gc-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px;
			padding: 8px 6px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
			background: rgba(255,255,255,0.04); color: inherit; cursor: pointer;
			transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease; }
		.gc-tile:hover { background: rgba(255,255,255,0.09); transform: translateY(-1px); }
		.gc-tile:focus-visible { outline: 2px solid #d4ed3a; outline-offset: 1px; }
		.gc-tile.worn { border-color: #d4ed3a; background: rgba(212,237,58,0.10); }
		.gc-tile.busy { opacity: 0.55; pointer-events: none; }
		.gc-tile img { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; }
		.gc-tile-fallback { width: 56px; height: 56px; border-radius: 8px; display: grid; place-items: center;
			background: rgba(255,255,255,0.06); font-size: 20px; opacity: 0.5; }
		.gc-tile-name { font-size: 11px; line-height: 1.2; text-align: center;
			overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
		.gc-loading, .gc-empty, .gc-error { padding: 12px; font-size: 12px; opacity: 0.7; }
		.gc-error { color: #ff9d9d; opacity: 1; }
		.gc-retry { margin-left: 8px; font-size: 11px; padding: 3px 10px; border-radius: 6px;
			border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
		.gc-status { min-height: 16px; font-size: 11px; opacity: 0.75; margin-top: 4px; }
	`;
	document.head.appendChild(style);
}

function escHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}
function escAttr(s) { return escHtml(s); }
