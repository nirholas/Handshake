// Home Forge controls — the generation-intelligence layer for the homepage
// chamber. The mini-forge (src/home-forge.js) owns the prompt bar, the pipeline
// animation, the viewer, history, and embed. This module gives that chamber the
// same brains the full /forge page runs on, without touching the beloved
// single-bar design: quality tiers (Draft/Standard/High with the real $THREE
// holder gate), a live engine picker (Auto health-routing plus every configured
// lane with its true up/down status), aspect ratio, and BYOK keys — all rendered
// from the SAME /api/forge?catalog and ?health endpoints the full page reads, so
// the two surfaces can never drift. It reuses three-access.js (the $THREE access
// matrix + tier pass), three-lock.js (the in-place frosted lock), and
// forge-pay.js (pay-per-generation) verbatim, so a homepage High generation
// behaves byte-for-byte like the full page's.
//
// Everything lives behind an "Options" disclosure the chamber keeps collapsed by
// default: a first-time visitor still sees exactly the minimal bar they always
// did. Auto stays the default engine — no backend is sent, so the server's
// health-aware router picks the live lane, preserving the mini-forge's original
// "never dead-end a visitor" behavior. A backend is sent only when the visitor
// deliberately picks one.

import {
	getAccess,
	getTierPass,
	attachTierPass,
	primeTierPass,
} from './three-access.js';
import { renderLock, lockStateFromAccess } from './three-lock.js';
import { payForHighGeneration } from './forge-pay.js';

// Short engine labels for the picker, keyed by backend id — mirrors ENGINE_LABELS
// in src/forge.js so the two pickers read identically. Free lanes carry a FREE
// pill (below), so they are named by engine like every other lane.
const ENGINE_LABELS = {
	nvidia: 'NVIDIA',
	huggingface: 'Hunyuan3D',
	trellis: 'Fast',
	trellis_selfhost: 'TRELLIS',
	meshy: 'Meshy',
	tripo: 'Tripo',
	rodin: 'Rodin',
	stability: 'Stability',
	replicate_byok: 'Replicate',
	hunyuan3d: 'Hunyuan3D',
	triposg: 'TripoSG',
};

// Where to mint a key per BYOK provider — mirrors KEY_HINTS in src/forge.js and
// the canonical registry in api/_lib/provider-keys.js. Keep in sync.
const KEY_HINTS = {
	meshy: { label: 'Meshy AI', url: 'https://www.meshy.ai/settings/api' },
	tripo: { label: 'Tripo AI', url: 'https://platform.tripo3d.ai/api-keys' },
	rodin: { label: 'Rodin (Hyper3D)', url: 'https://developer.hyper3d.ai' },
	stability: { label: 'Stability AI', url: 'https://platform.stability.ai/account/keys' },
	replicate: { label: 'Replicate', url: 'https://replicate.com/account/api-tokens' },
};

const TIER_ORDER = ['draft', 'standard', 'high'];
const ASPECTS = ['1:1', '4:3', '3:4', '16:9'];

const KEY_SVG =
	'<svg class="hfc-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m15 7 3 3"/><path d="m18 4 3 3"/></svg>';
const LOCK_PILL_SVG =
	'<svg class="hfc-lock-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/**
 * Wire the controls into the chamber. Returns a small controller the mini-forge
 * consults on every submit. Never throws — a deployment without the catalog
 * endpoint (or with the panel markup absent) yields an inert controller whose
 * getConfig() returns the mini-forge's original free-standard defaults.
 *
 * @param {object} o
 * @param {HTMLElement} o.root        the #home-forge root
 * @param {object} o.clientHeaders    { 'x-forge-client': id } — sent on catalog/health
 * @param {(html:string)=>void} [o.onLane]   called with a lane label for the HUD ("standard · auto")
 * @param {(extra:object)=>void} o.onRerun   run the current prompt again with an extra body (pay-per-use proof)
 * @param {()=>void} [o.onBlockedChange]     called when the High lock engages/clears so the bar can reflect it
 */
export function initForgeControls({ root, clientHeaders, onLane, onRerun, onBlockedChange }) {
	const els = root && {
		panel: root.querySelector('[data-hf-panel]'),
		optsToggle: root.querySelector('[data-hf-opts]'),
		tier: root.querySelector('[data-hf-tier]'),
		engine: root.querySelector('[data-hf-engine]'),
		aspectRow: root.querySelector('[data-hf-aspect-row]'),
		aspect: root.querySelector('[data-hf-aspect]'),
		byok: root.querySelector('[data-hf-byok]'),
		byokLabel: root.querySelector('[data-hf-byok-label]'),
		byokKey: root.querySelector('[data-hf-byok-key]'),
		byokHint: root.querySelector('[data-hf-byok-hint]'),
		lock: root.querySelector('[data-hf-lock]'),
		perk: root.querySelector('[data-hf-perk]'),
	};

	// Inert controller: the panel is absent (older markup) — the mini-forge keeps
	// its original fixed free-standard payload and everything still works.
	if (!els || !els.panel || !els.tier || !els.engine) {
		return {
			whenReady: Promise.resolve(false),
			getConfig: () => ({ tier: 'standard', path: 'image', backend: null, aspect_ratio: '1:1', byokKey: '' }),
			laneLabel: () => 'standard · free lane',
			async beforeSubmit(base) {
				return { ok: true, headers: { ...(base || {}), ...(clientHeaders || {}) } };
			},
			async buildHeaders(base) {
				return { ...(base || {}), ...(clientHeaders || {}) };
			},
			isBlocked: () => false,
		};
	}

	let catalog = null;
	let health = null;
	let selectedTier = 'standard';
	let selectedEngine = { id: null, path: 'image', backend: null, byok: null }; // id:null === Auto
	let byokKey = '';
	let highLocked = false;
	let highAccess = null; // last resolved forge.high access payload
	let healthRetry = 0;

	const clientHdr = clientHeaders || {};

	// ── Options disclosure ─────────────────────────────────────────────
	if (els.optsToggle) {
		els.optsToggle.addEventListener('click', () => {
			const open = els.panel.hidden;
			els.panel.hidden = !open;
			els.optsToggle.setAttribute('aria-expanded', String(open));
			els.optsToggle.classList.toggle('is-open', open);
		});
	}

	// ── Catalog + health ───────────────────────────────────────────────
	const whenReady = loadCatalog();

	async function loadCatalog() {
		try {
			const res = await fetch('/api/forge?catalog=1', { headers: clientHdr });
			catalog = await res.json().catch(() => null);
		} catch {
			catalog = null;
		}
		if (!catalog || !Array.isArray(catalog.backends)) {
			// No catalog (older deploy) — hide the Options affordance entirely; the
			// mini-forge's free-standard defaults still generate.
			if (els.optsToggle) els.optsToggle.hidden = true;
			els.panel.hidden = true;
			return false;
		}
		buildTiers();
		buildAspects();
		buildEngineButtons();
		selectTier('standard');
		loadHealth();
		reflectHighButtonAccess();
		updatePerkLine();
		emitLane();
		return true;
	}

	async function loadHealth() {
		try {
			const res = await fetch('/api/forge?health=1', { headers: clientHdr });
			const body = await res.json().catch(() => null);
			health = body && body.backends ? body : null;
		} catch {
			health = null;
		}
		if (health) {
			healthRetry = 0;
			updateEngineAvailability();
		} else if (healthRetry < 2) {
			healthRetry += 1;
			setTimeout(loadHealth, healthRetry * 30_000);
		}
	}

	// ── Tiers ──────────────────────────────────────────────────────────
	function buildTiers() {
		els.tier.innerHTML = '';
		const tiers = Array.isArray(catalog.tiers) ? catalog.tiers : [];
		for (const id of TIER_ORDER) {
			const t = tiers.find((x) => x.id === id);
			if (!t) continue;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'hf-seg-btn hfc-tier-btn';
			btn.dataset.tier = id;
			btn.setAttribute('aria-pressed', String(id === selectedTier));
			const price = id === 'high' ? `$${t.price_usdc}` : '';
			btn.title = t.blurb || t.label;
			btn.innerHTML =
				`<span class="hfc-tier-label">${t.label}</span>` +
				(id === 'high'
					? `<span class="hfc-lock" data-state="locked" title="High quality is a $THREE holder feature">${LOCK_PILL_SVG}<span class="hfc-lock-txt">$THREE</span></span>`
					: '');
			void price;
			btn.addEventListener('click', () => selectTier(id));
			els.tier.appendChild(btn);
		}
	}

	function selectTier(id) {
		if (!TIER_ORDER.includes(id)) return;
		selectedTier = id;
		for (const b of els.tier.querySelectorAll('button')) {
			b.setAttribute('aria-pressed', String(b.dataset.tier === id));
		}
		updateEngineAvailability();
		reflectHighAccess(id);
		emitLane();
	}

	// ── Aspect ratio ───────────────────────────────────────────────────
	let selectedAspect = '1:1';
	function buildAspects() {
		if (!els.aspect) return;
		els.aspect.innerHTML = '';
		for (const a of ASPECTS) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'hf-seg-btn';
			btn.dataset.aspect = a;
			btn.textContent = a;
			btn.setAttribute('aria-pressed', String(a === selectedAspect));
			btn.addEventListener('click', () => {
				selectedAspect = a;
				for (const b of els.aspect.querySelectorAll('button')) {
					b.setAttribute('aria-pressed', String(b.dataset.aspect === a));
				}
			});
			els.aspect.appendChild(btn);
		}
	}

	function updateAspectVisibility() {
		if (!els.aspectRow) return;
		// Aspect ratio only shapes the reference image an image-path lane renders;
		// geometry/sketch lanes ignore it. Auto uses the image path, so it shows.
		els.aspectRow.hidden = selectedEngine.path !== 'image';
	}

	// ── Engine picker ──────────────────────────────────────────────────
	function buildEngineButtons() {
		els.engine.innerHTML = '';
		// Auto — the mini-forge's original behavior: no backend, server health-routes.
		const auto = document.createElement('button');
		auto.type = 'button';
		auto.className = 'hfc-engine-btn hfc-engine-auto';
		auto.dataset.engine = '__auto';
		auto.dataset.path = 'image';
		auto.setAttribute('aria-pressed', String(selectedEngine.id === null));
		auto.title = 'Auto — we route to the best live lane for your prompt. Never dead-ends on a cold engine.';
		auto.setAttribute('aria-label', 'Auto — best available engine');
		auto.innerHTML = '<span class="hfc-engine-label">Auto</span><span class="hfc-auto-pill" aria-hidden="true">SMART</span>';
		auto.addEventListener('click', () => selectEngine(auto));
		els.engine.appendChild(auto);

		// Text/photo tabs hide sketch-only lanes; the homepage is text-only, so we
		// drop any lane that ONLY takes a sketch (no dead engine in the picker).
		const usable = catalog.backends.filter((b) => {
			if (!(b.configured || b.byok)) return false;
			const sketchOnly = Array.isArray(b.paths) && b.paths.every((p) => p === 'sketch');
			return !sketchOnly;
		});
		for (const b of usable) {
			const path = b.paths.includes('geometry') ? 'geometry' : 'image';
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'hfc-engine-btn';
			btn.dataset.engine = b.id;
			btn.dataset.path = path;
			btn.dataset.byok = b.byok || '';
			const short = ENGINE_LABELS[b.id] || b.label;
			btn.innerHTML =
				`<span class="hfc-engine-label">${short}</span>` +
				(b.free ? '<span class="hfc-free-pill" aria-hidden="true">FREE</span>' : '') +
				(b.byok ? KEY_SVG : '');
			const keyNote = b.byok ? ` · uses your own ${KEY_HINTS[b.byok]?.label || b.byok} key` : '';
			const freeNote = b.free ? ' · free, no API key' : '';
			btn.title = `${b.label} — ${b.blurb}${freeNote}${keyNote}`;
			btn.setAttribute('aria-label', `${b.label}${freeNote}${keyNote}`);
			btn.setAttribute('aria-pressed', String(b.id === selectedEngine.id));
			btn.addEventListener('click', () => selectEngine(btn));
			els.engine.appendChild(btn);
		}
		updateEngineAvailability();
	}

	function updateEngineAvailability() {
		if (!catalog) return;
		for (const btn of els.engine.querySelectorAll('button')) {
			if (btn.dataset.engine === '__auto') continue;
			const b = catalog.backends?.find((x) => x.id === btn.dataset.engine);
			const lane = health?.backends?.[btn.dataset.engine];
			const laneDown = Boolean(lane && (lane.status === 'down' || lane.status === 'unconfigured'));
			const laneBusy = lane && lane.status === 'degraded';
			btn.disabled = laneDown;
			btn.setAttribute('aria-disabled', String(laneDown));
			btn.dataset.health = lane ? lane.status : '';
			if (laneDown) {
				btn.title = `${b?.label || btn.dataset.engine} — temporarily unavailable: ${lane.message}`;
			} else if (b) {
				btn.title = laneBusy
					? `${b.label} — busy right now: ${lane.message}`
					: `${b.label} — ${b.blurb}`;
			}
			// If the live-picked lane just went down, fall back to Auto so the user
			// is never stranded on a dead engine.
			if (laneDown && btn.dataset.engine === selectedEngine.id) {
				const autoBtn = els.engine.querySelector('button[data-engine="__auto"]');
				if (autoBtn) selectEngine(autoBtn);
			}
		}
	}

	function selectEngine(btn) {
		if (!btn || btn.disabled) return;
		const isAuto = btn.dataset.engine === '__auto';
		selectedEngine = {
			id: isAuto ? null : btn.dataset.engine,
			path: btn.dataset.path || 'image',
			backend: isAuto ? null : btn.dataset.engine,
			byok: btn.dataset.byok || null,
		};
		for (const b of els.engine.querySelectorAll('button')) {
			b.setAttribute('aria-pressed', String(b === btn));
		}
		updateByokRow();
		updateAspectVisibility();
		// The engine decides whether High is $THREE-gated (platform) or exempt (BYOK),
		// so re-evaluate the lock whenever the engine changes under High.
		if (selectedTier === 'high') reflectHighAccess('high', { silent: true });
		emitLane();
	}

	function updateByokRow() {
		if (!els.byok) return;
		const byok = selectedEngine.byok;
		els.byok.hidden = !byok;
		if (!byok) return;
		const hint = KEY_HINTS[byok];
		const name = hint?.label || byok;
		if (els.byokLabel) els.byokLabel.textContent = `${name} key`;
		if (els.byokKey) els.byokKey.placeholder = `Your ${name} API key (kept in this browser)`;
		if (els.byokHint) {
			els.byokHint.innerHTML = hint
				? `Runs on your own ${hint.label} key. <a href="${hint.url}" target="_blank" rel="noopener">Get a key →</a>`
				: `Runs on your own ${name} key, kept in this browser.`;
		}
	}

	if (els.byokKey) {
		els.byokKey.addEventListener('input', () => {
			byokKey = els.byokKey.value.trim();
		});
	}

	// ── High-tier $THREE gate ──────────────────────────────────────────
	// The only combination the server $THREE-gates: High on a PLATFORM-keyed lane.
	// BYOK High runs on the caller's own vendor key, so it is server-exempt.
	function highTierNeedsPass() {
		return selectedTier === 'high' && !selectedEngine.byok;
	}

	function setBlocked(v) {
		if (v === highLocked) return;
		highLocked = v;
		if (typeof onBlockedChange === 'function') onBlockedChange(highLocked);
	}

	async function reflectHighAccess(tierId, { silent = false } = {}) {
		if (!els.lock) return;
		if (tierId !== 'high' || !highTierNeedsPass()) {
			setBlocked(false);
			highAccess = tierId === 'high' ? highAccess : null;
			renderLock(els.lock, { clear: true });
			els.lock.hidden = true;
			return;
		}
		let access = silent && highAccess ? highAccess : null;
		if (!access) {
			els.lock.hidden = false;
			renderLock(els.lock, { loading: true });
			const data = await getAccess('forge.high');
			if (!highTierNeedsPass()) return; // user moved off High while we fetched
			access = data?.access || null;
		}
		if (!access) {
			// Access read failed — fail open (server stays the authority) but offer a retry.
			highAccess = null;
			setBlocked(false);
			els.lock.hidden = false;
			renderLock(els.lock, { error: true, onRetry: () => reflectHighAccess('high') });
			return;
		}
		highAccess = access;
		setBlocked(!access.eligible);
		els.lock.hidden = false;
		renderLock(
			els.lock,
			lockStateFromAccess(access, {
				getThreeUrl: '/three',
				onUseFree: () => selectTier('standard'),
				useFreeLabel: 'Use Standard (free)',
				onPayPerUse: (pay) => payThenRun(pay),
			}),
		);
		applyHighPill(access);
		if (access.eligible) primeTierPass();
	}

	async function reflectHighButtonAccess() {
		const data = await getAccess('forge.high');
		const access = data?.access || null;
		if (access) highAccess = access;
		applyHighPill(access);
		if (access?.eligible) primeTierPass();
	}

	function applyHighPill(access) {
		const eligible = Boolean(access?.eligible);
		const btn = els.tier?.querySelector('button[data-tier="high"]');
		const pill = btn?.querySelector('.hfc-lock');
		if (!pill) return;
		pill.dataset.state = eligible ? 'unlocked' : 'locked';
		pill.title = eligible
			? 'Unlocked — you hold $THREE'
			: 'High quality is a $THREE holder feature';
		pill.innerHTML = eligible
			? '<span class="hfc-lock-ico" aria-hidden="true">✓</span><span class="hfc-lock-txt">$THREE</span>'
			: `${LOCK_PILL_SVG}<span class="hfc-lock-txt">$THREE</span>`;
	}

	// Pay $THREE for a single High generation, then re-run the current prompt with
	// the settled proof attached. Mirrors payThenGenerate() in src/forge.js.
	async function payThenRun(pay) {
		const usd = Number(pay?.usd) || Number(highAccess?.pay_per_use?.usd) || 0;
		if (!(usd > 0)) return;
		if (selectedTier !== 'high') selectTier('high');
		const result = await payForHighGeneration({ usd });
		if (!result?.ok) return; // cancelled or failed — the modal explained why
		if (typeof onRerun === 'function') {
			onRerun({ payment_id: result.paymentId, ref_id: result.refId });
		}
	}

	// ── Holder perk line ───────────────────────────────────────────────
	const FREE_MULT_BY_LEVEL = { 1: 2, 2: 3, 3: 5, 4: 10 };
	async function updatePerkLine() {
		if (!els.perk) return;
		const data = await getAccess();
		const level = Number(data?.tier?.level) || 0;
		els.perk.hidden = false;
		if (level >= 1) {
			const mult = FREE_MULT_BY_LEVEL[level] || 1;
			els.perk.dataset.state = 'perk';
			els.perk.innerHTML = `<span aria-hidden="true">⚡</span> Holder perk: <strong>${mult}× free quota</strong> · <a href="/three#tiers">your $THREE tier</a>`;
		} else {
			els.perk.dataset.state = 'upsell';
			els.perk.innerHTML = '<a href="/three#tiers">Hold $THREE for up to 10× free generations →</a>';
		}
	}

	// ── HUD lane label ─────────────────────────────────────────────────
	function laneLabel() {
		const engineName = selectedEngine.id
			? ENGINE_LABELS[selectedEngine.id] || selectedEngine.id
			: 'auto';
		return `${selectedTier} · ${engineName}`;
	}
	function emitLane() {
		if (typeof onLane === 'function') onLane(laneLabel());
	}

	// ── Public API the mini-forge consults ─────────────────────────────
	function getConfig() {
		return {
			tier: selectedTier,
			path: selectedEngine.path || 'image',
			backend: selectedEngine.backend, // null === Auto (omit → health routing)
			aspect_ratio: selectedAspect,
			byokKey,
		};
	}

	// Assemble the request headers for a submit: the client id, the BYOK key when a
	// BYOK lane is selected, and (for platform High) a freshly-minted $THREE tier
	// pass AWAITED so the proof rides on THIS request. No-op for anonymous callers
	// and the free tiers.
	async function buildHeaders(base = {}) {
		const headers = { ...base, ...clientHdr };
		if (byokKey && selectedEngine.byok) headers['x-forge-provider-key'] = byokKey;
		if (highTierNeedsPass()) {
			await getTierPass({ interactive: Boolean(highAccess?.eligible) });
		}
		attachTierPass(headers);
		return headers;
	}

	// Called right before a submit. Returns { ok, headers }. When platform High is
	// selected but the visitor isn't eligible, opens the gate and returns ok:false
	// so the mini-forge doesn't fire a request the server would 402.
	async function beforeSubmit(base = {}) {
		if (highTierNeedsPass() && highLocked) {
			// Ensure the lock panel is visible + open Options so the CTA is reachable.
			els.panel.hidden = false;
			if (els.optsToggle) {
				els.optsToggle.setAttribute('aria-expanded', 'true');
				els.optsToggle.classList.add('is-open');
			}
			await reflectHighAccess('high');
			return { ok: false };
		}
		return { ok: true, headers: await buildHeaders(base) };
	}

	return {
		whenReady,
		getConfig,
		laneLabel,
		beforeSubmit,
		// A pay-per-use re-run already carries a settled payment, so it bypasses the
		// gate block — the mini-forge builds its headers directly.
		buildHeaders,
		isBlocked: () => highTierNeedsPass() && highLocked,
	};
}
