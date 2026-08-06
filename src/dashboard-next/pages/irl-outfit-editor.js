// Remote Outfit editor (C6) — re-skin a placed agent for every nearby viewer.
//
// Opens from a "My IRL Agents" card. Loads the pin's BASE avatar GLB into a live
// preview and renders the SAME wardrobe machinery the studio uses
// (src/avatar-wardrobe.js): recolour / hide the garment layers the GLB actually
// exposes, plus toggle bone-attached accessories. On Save it PATCHes
// /api/irl/pins { id, avatar_manifest }; the server bakes a new GLB onto the
// base, bumps avatar_version, and every nearby viewer's poll swaps to the new
// look (D1 makes it instant once it lands).
//
// The preview always loads `avatar_base_url ?? avatar_url` — the exact base the
// server bakes onto — so what the owner sees here is byte-for-byte what nearby
// viewers will get. The heavy 3D stack (Three.js via TalkScene + the
// AccessoryManager) is dynamically imported the first time the editor opens, so
// the dashboard's initial bundle stays light.

import { patch } from '../api.js';
import { skeletonHTML, errorStateHTML, emptyStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';

// Bone-attached presets the owner can stack (hats/glasses/earrings). Morph-based
// "outfit" presets need targets only some rigs expose, so the wardrobe panel's
// recolour/hide of the avatar's own garments is the reliable outfit control here.
const ACCESSORY_KINDS = ['hat', 'glasses', 'earrings'];

// Normalize a pin's stored manifest into the working shape the editor mutates.
function seedManifest(manifest) {
	const m = manifest && typeof manifest === 'object' ? manifest : {};
	return {
		colors: { ...(m.colors || {}) },
		hidden: Array.isArray(m.hidden) ? [...m.hidden] : [],
		accessories: Array.isArray(m.accessories) ? [...m.accessories] : [],
	};
}

// Drop empty branches so a cleared look serializes to {} (which bakes back to the
// bare base server-side) — mirrors avatar-edit's collapseAppearance.
function collapseManifest(working) {
	const out = {};
	if (working.colors && Object.keys(working.colors).length) out.colors = working.colors;
	if (working.hidden && working.hidden.length) out.hidden = working.hidden;
	if (working.accessories && working.accessories.length) out.accessories = working.accessories;
	return out;
}

/**
 * Open the remote Outfit editor for one placed agent.
 * @param {object} opts
 * @param {object} opts.pin    the card's pin row (needs id, avatar_url, avatar_base_url, avatar_manifest, avatar_name)
 * @param {(updated:object)=>void} [opts.onSaved] called with the PATCH response pin after a successful save
 */
export async function openOutfitEditor({ pin, onSaved }) {
	ensureStateKitStyles();
	injectStyles();

	const baseUrl = pin.avatar_base_url || pin.avatar_url || null;
	const working = seedManifest(pin.avatar_manifest);

	// ── Modal shell ──────────────────────────────────────────────────────────
	const root = makeNode(`<div class="oe-root" role="presentation">
		<div class="oe-back"></div>
		<div class="oe-modal" role="dialog" aria-modal="true" aria-label="Change outfit">
			<div class="oe-head">
				<div class="oe-titles">
					<div class="oe-title">Change outfit</div>
					<div class="oe-sub">${esc(pin.avatar_name || 'Placed agent')} · updates for everyone nearby</div>
				</div>
				<button class="oe-x" data-close type="button" aria-label="Close">×</button>
			</div>
			<div class="oe-body">
				<div class="oe-stage" data-stage>
					<div class="oe-stage-skel" data-stage-skel><span class="oe-spin" aria-hidden="true"></span><span>Loading avatar…</span></div>
				</div>
				<div class="oe-panel" data-panel>${skeletonHTML(3, 'row')}</div>
			</div>
			<div class="oe-foot">
				<div class="oe-foot-msg" data-msg></div>
				<div class="oe-foot-actions">
					<button class="oe-btn" data-close type="button">Cancel</button>
					<button class="oe-btn primary" data-save type="button" disabled>Apply outfit</button>
				</div>
			</div>
		</div>
	</div>`);

	document.body.appendChild(root);
	document.body.style.overflow = 'hidden';

	const stageEl = root.querySelector('[data-stage]');
	const panelEl = root.querySelector('[data-panel]');
	const saveBtn = root.querySelector('[data-save]');
	const msgEl   = root.querySelector('[data-msg]');

	let scene = null;
	let accessoryManager = null;
	let idleDispose = null;
	let presets = [];
	let closed = false;
	let saving = false;

	const setMsg = (text, kind = '') => {
		msgEl.textContent = text || '';
		msgEl.className = `oe-foot-msg${kind ? ' ' + kind : ''}`;
	};
	// Any change (recolour, hide, accessory toggle) makes the look saveable.
	const setDirty = () => {
		if (!saving) { saveBtn.disabled = false; setMsg(''); }
	};

	// ── Teardown ─────────────────────────────────────────────────────────────
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener('keydown', onKey, true);
		try { idleDispose?.(); } catch { /* tick may already be detached */ }
		try { scene?.unmount(); } catch { /* renderer may not have mounted */ }
		root.remove();
		document.body.style.overflow = '';
	};
	const onKey = (ev) => { if (ev.key === 'Escape' && !saving) close(); };
	document.addEventListener('keydown', onKey, true);
	root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!saving) close(); }));
	root.querySelector('.oe-back').addEventListener('click', () => { if (!saving) close(); });
	setTimeout(() => root.querySelector('[data-close]')?.focus(), 0);

	// No avatar to dress at all → designed empty state, no 3D load.
	if (!baseUrl) {
		stageEl.innerHTML = `<div class="oe-stage-empty">This agent has no 3D avatar to dress.</div>`;
		panelEl.innerHTML = emptyStateHTML({
			compact: true,
			title: 'No avatar attached',
			body: 'Re-place this agent with a 3D avatar, or attach one from the avatars dashboard, to customize its outfit.',
		});
		return;
	}

	// ── Boot the live preview + wardrobe ──────────────────────────────────────
	try {
		const [{ TalkScene }, { AccessoryManager }, wardrobe] = await Promise.all([
			import('../../voice/talk-scene.js'),
			import('../../agent-accessories.js'),
			import('../../avatar-wardrobe.js'),
		]);
		if (closed) return;

		scene = new TalkScene();
		await scene.mount({ container: stageEl, glbUrl: baseUrl });
		if (closed) { try { scene.unmount(); } catch { /* closed mid-load */ } return; }
		root.querySelector('[data-stage-skel]')?.remove();

		accessoryManager = new AccessoryManager({ content: scene.root, invalidate: () => {} });
		// Seed the preview from the pin's current look (colours/hidden/accessories).
		await accessoryManager.hydrateFromAppearance(collapseManifest(working));

		// Gentle auto-spin so the owner can read the whole avatar without dragging —
		// suppressed when the viewer prefers reduced motion (they can still orbit by drag).
		const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		idleDispose = reduceMotion
			? null
			: (scene.addOnTick?.((dt) => { if (scene?.root) scene.root.rotation.y += dt * 0.35; }) || null);

		// Wardrobe controls — only the slots THIS GLB exposes (same detection
		// contract as the studio). Empty state handled inside renderWardrobePanel.
		wardrobe.renderWardrobePanel({
			container: panelEl,
			root: scene.root,
			working,
			applyLayers: (layers) => accessoryManager?.applyLayers(layers),
			onDirty: setDirty,
		});

		// Accessories ("swap") — bone-attached presets toggled on top of the layers.
		await mountAccessories();
	} catch (err) {
		if (closed) return;
		root.querySelector('[data-stage-skel]')?.remove();
		stageEl.innerHTML = `<div class="oe-stage-empty">Preview unavailable</div>`;
		panelEl.innerHTML = errorStateHTML({
			title: "Couldn't load the avatar",
			body: esc(err?.message || 'Check your connection and try again.'),
		});
		attachRetry(panelEl, () => { close(); openOutfitEditor({ pin, onSaved }); });
		return;
	}

	// ── Accessories picker ─────────────────────────────────────────────────────
	async function mountAccessories() {
		let host = root.querySelector('[data-acc]');
		if (!host) {
			host = makeNode(`<div class="oe-acc" data-acc>
				<div class="oe-acc-h">Accessories</div>
				<div class="oe-acc-grid" data-acc-grid></div>
			</div>`);
			panelEl.appendChild(host);
		}
		const grid = host.querySelector('[data-acc-grid]');
		try {
			const r = await fetch('/accessories/presets.json');
			presets = r.ok ? await r.json() : [];
		} catch { presets = []; }
		const items = presets.filter((p) => ACCESSORY_KINDS.includes(p.kind) && p.glbUrl);
		if (!items.length) { host.remove(); return; }

		const active = new Set(working.accessories);
		grid.innerHTML = items.map((p) => {
			const on = active.has(p.id);
			return `<button class="oe-acc-item${on ? ' on' : ''}" type="button" data-acc-id="${esc(p.id)}" aria-pressed="${on}" title="${esc(p.name)}">
				${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy" data-fallback="invisible" />` : '<span class="oe-acc-ph" aria-hidden="true">✦</span>'}
				<span class="oe-acc-name">${esc(p.name)}</span>
			</button>`;
		}).join('');

		grid.addEventListener('click', async (e) => {
			const btn = e.target.closest('[data-acc-id]');
			if (!btn || saving) return;
			const id = btn.dataset.accId;
			const preset = items.find((p) => p.id === id);
			if (!preset) return;
			const wasOn = btn.getAttribute('aria-pressed') === 'true';
			btn.setAttribute('aria-pressed', String(!wasOn));
			btn.classList.toggle('on', !wasOn);
			try {
				if (wasOn) {
					accessoryManager?.removePreset(id);
					working.accessories = working.accessories.filter((x) => x !== id);
				} else {
					await accessoryManager?.applyPreset(preset);
					if (!working.accessories.includes(id)) working.accessories.push(id);
				}
				setDirty();
			} catch {
				// Roll the toggle back if the GLB couldn't load.
				btn.setAttribute('aria-pressed', String(wasOn));
				btn.classList.toggle('on', wasOn);
			}
		});
	}

	// ── Save → PATCH → bake → propagate ────────────────────────────────────────
	saveBtn.addEventListener('click', async () => {
		if (saving) return;
		saving = true;
		saveBtn.disabled = true;
		saveBtn.textContent = 'Applying outfit…';
		setMsg('Baking the new look…');
		try {
			// Real async — the server bakes a GLB and stores it before responding.
			const res = await patch('/api/irl/pins', { id: pin.id, avatar_manifest: collapseManifest(working) });
			const updated = res?.pin;
			if (!updated) throw new Error('Save failed');
			// Reflect the new state back onto the pin so a second edit re-bakes from
			// the right base and the card preview can refresh.
			pin.avatar_url = updated.avatar_url;
			pin.avatar_manifest = updated.avatar_manifest ?? collapseManifest(working);
			pin.avatar_version = updated.avatar_version;
			saveBtn.textContent = 'Applied ✓';
			setMsg('Saved — nearby viewers will see the new look shortly.', 'ok');
			onSaved?.(updated);
			setTimeout(() => { if (!closed) close(); }, 1100);
		} catch (err) {
			saving = false;
			saveBtn.disabled = false;
			saveBtn.textContent = 'Retry';
			const m = err?.status === 403 ? 'Only the owner can change this agent.'
				: err?.status === 502 ? "The avatar couldn't be baked. Try again."
				: (err?.message || 'Could not save. Try again.');
			setMsg(m, 'err');
		}
	});
}

// ── DOM + style helpers ──────────────────────────────────────────────────────

function makeNode(html) {
	const t = document.createElement('template');
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'oe-css';
	style.textContent = `
		.oe-root { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 16px; }
		.oe-back { position: absolute; inset: 0; background: rgba(0,0,0,.62); backdrop-filter: blur(2px); animation: oe-fade .16s ease; }
		.oe-modal { position: relative; width: min(880px, 100%); max-height: min(90vh, 760px); display: flex; flex-direction: column; background: var(--nxt-panel, var(--nxt-bg-1, #0d0f15)); border: 1px solid var(--nxt-stroke, #23262f); border-radius: var(--nxt-radius, 14px); box-shadow: 0 24px 64px rgba(0,0,0,.5); animation: oe-rise .2s cubic-bezier(.2,.7,.3,1); overflow: hidden; }
		.oe-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--nxt-stroke, #23262f); }
		.oe-title { font-size: 16px; font-weight: 700; color: var(--nxt-ink, #f4f5f7); }
		.oe-sub { font-size: 12px; color: var(--nxt-ink-faint, #8a8f9c); margin-top: 2px; }
		.oe-x { background: none; border: none; color: var(--nxt-ink-faint, #8a8f9c); font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 8px; transition: color .14s; }
		.oe-x:hover, .oe-x:focus-visible { color: var(--nxt-ink, #f4f5f7); }
		.oe-x:focus-visible { outline: 2px solid var(--nxt-accent, #6ea8fe); outline-offset: 2px; }
		.oe-body { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 0; flex: 1; min-height: 0; }
		.oe-stage { position: relative; min-height: 320px; background: radial-gradient(120% 120% at 50% 10%, #161a26 0%, #0a0c12 70%); border-right: 1px solid var(--nxt-stroke, #23262f); overflow: hidden; }
		.oe-stage canvas { display: block; width: 100%; height: 100%; }
		.oe-stage-skel { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--nxt-ink-faint, #8a8f9c); font-size: 13px; }
		.oe-stage-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: var(--nxt-ink-faint, #8a8f9c); font-size: 13px; line-height: 1.5; }
		.oe-spin { width: 26px; height: 26px; border-radius: 50%; border: 3px solid color-mix(in srgb, var(--nxt-accent, #6ea8fe) 30%, transparent); border-top-color: var(--nxt-accent, #6ea8fe); animation: oe-spin .8s linear infinite; }
		.oe-panel { padding: 16px 18px; overflow-y: auto; }
		.oe-acc { margin-top: 18px; border-top: 1px solid var(--nxt-line, var(--nxt-stroke, #23262f)); padding-top: 14px; }
		.oe-acc-h { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--nxt-ink-faint, #8a8f9c); margin-bottom: 10px; }
		.oe-acc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 8px; }
		.oe-acc-item { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 6px; border-radius: 10px; border: 1px solid var(--nxt-stroke, #23262f); background: var(--nxt-bg-2, #14171f); color: var(--nxt-ink-dim, #c5c9d3); cursor: pointer; transition: border-color .14s, background .14s, transform .1s; }
		.oe-acc-item:hover { border-color: var(--nxt-stroke-strong, #353a47); transform: translateY(-1px); }
		.oe-acc-item:active { transform: translateY(0); }
		.oe-acc-item:focus-visible { outline: 2px solid var(--nxt-accent, #6ea8fe); outline-offset: 2px; }
		.oe-acc-item.on { border-color: var(--nxt-accent, #6ea8fe); background: color-mix(in srgb, var(--nxt-accent, #6ea8fe) 12%, var(--nxt-bg-2, #14171f)); }
		.oe-acc-item img { width: 40px; height: 40px; object-fit: contain; }
		.oe-acc-ph { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; font-size: 18px; color: var(--nxt-ink-faint, #8a8f9c); }
		.oe-acc-name { font-size: 11px; line-height: 1.2; text-align: center; }
		.oe-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--nxt-stroke, #23262f); }
		.oe-foot-msg { font-size: 12px; color: var(--nxt-ink-faint, #8a8f9c); flex: 1; min-width: 0; }
		.oe-foot-msg.ok { color: var(--nxt-success, #4ade80); }
		.oe-foot-msg.err { color: var(--nxt-danger, #f87171); }
		.oe-foot-actions { display: flex; gap: 8px; flex-shrink: 0; }
		.oe-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--nxt-radius-sm, 9px); border: 1px solid var(--nxt-stroke, #23262f); background: var(--nxt-bg-2, #14171f); color: var(--nxt-ink, #f4f5f7); cursor: pointer; font-size: 13px; font-weight: 600; transition: border-color .14s, transform .12s, opacity .14s; }
		.oe-btn:hover:not(:disabled) { border-color: var(--nxt-stroke-strong, #353a47); transform: translateY(-1px); }
		.oe-btn:active:not(:disabled) { transform: translateY(0); }
		.oe-btn:focus-visible { outline: 2px solid var(--nxt-accent, #6ea8fe); outline-offset: 2px; }
		.oe-btn.primary { background: var(--nxt-accent, #6ea8fe); color: #061018; border-color: transparent; }
		.oe-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--nxt-accent, #6ea8fe) 88%, #fff); }
		.oe-btn:disabled { opacity: .5; cursor: default; }
		@keyframes oe-fade { from { opacity: 0; } to { opacity: 1; } }
		@keyframes oe-rise { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: none; } }
		@keyframes oe-spin { to { transform: rotate(360deg); } }
		@media (max-width: 680px) {
			.oe-body { grid-template-columns: 1fr; }
			.oe-stage { min-height: 240px; border-right: none; border-bottom: 1px solid var(--nxt-stroke, #23262f); }
			.oe-modal { max-height: 92vh; }
		}
		@media (prefers-reduced-motion: reduce) {
			.oe-back, .oe-modal { animation: none; }
		}
	`;
	document.head.appendChild(style);
}
