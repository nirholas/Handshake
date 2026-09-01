// $THREE access — client helper + lock UI (Token Utility v1).
//
// One module any page imports to make the hold-to-access lever real in the UI:
//   • getAccess(feature?)   — GET /api/three/access (the gated-feature matrix or
//                             a single feature), short-cached. Reads the connected
//                             wallet (?wallet=) when one is connected, else the session.
//   • getTierPass(opts?)    — mint/reuse the tier pass, cached until ~1 min before
//                             expiry; the portable, RPC-free proof of holder tier.
//                             A connected wallet mints by signing a fresh message
//                             ({ interactive:true } only — never a surprise popup);
//                             a session user mints silently. The portable, RPC-free
//                             proof of holder tier.
//   • tierPassHeader()      — the cached pass string for the x-three-tier-pass
//                             header (sync; null when none), so a gated request can
//                             attach an eligible holder's entitlement with no await.
//   • attachTierPass(h)     — adds that header to a headers object when a pass is
//                             cached; no-op + returns it unchanged otherwise.
//   • primeTierPass()       — fetch the pass in the background (fire-and-forget).
//   • mountTierBadge(el)    — render the holder's tier chip (Bronze+), for a
//                             signed-in account OR a connected wallet; re-renders
//                             itself on wallet:changed.
//   • onGate(payload)       — open the upsell from a 402 three_hold_required body
//                             (the intent-named entry; showThreeGate is the impl).
//   • showThreeGate(gate)   — the upsell modal: Get $THREE + what you hold vs. need.
//   • renderInlineLock(el)  — a compact lock/unlock chip beside a gated control.
//
// Everything degrades to a safe locked/anonymous state on any network failure —
// the UI never throws and the server stays the only authority on eligibility.

import { safeUrl } from './safe-url.js';
import { track, trackFunnelStep, ANALYTICS_EVENTS } from './analytics.js';

const ACCESS_TTL_MS = 30_000;
// The matrix cache is keyed by identity (the connected wallet, or null for the
// session) so a wallet connect/disconnect/switch never serves the previous
// identity's access.
let _matrix = { at: 0, data: null, wallet: undefined };
let _tierPass = null; // { pass, tier, exp(ms), wallet } — wallet is the identity it was minted for (null = session)
let _tierPassInFlight = null; // de-dupe concurrent mints onto one network/signature round-trip
let _stylesInjected = false;

// The canonical holder-value surface every locked state routes to: the full tier
// ladder + the "Hold more $THREE" upgrade action (src/three-tier-page.js → /three).
const ECONOMY_URL = '/three';
// The coin's price/chart/one-click-buy page — the secondary "see the market"
// link, distinct from the upgrade surface above.
const PRICE_URL = '/three-token';

// The connected Solana wallet address (Phantom on web, the Seeker TWA wallet on
// mobile), or null when none is connected — in which case every read falls back to
// the session identity. Seeded on import and kept current by the wallet:changed
// listener below. Reading is best-effort: a wallet module hiccup degrades to session.
// The wallet module (with the @solana/web3.js + Mobile Wallet Adapter bundle behind it)
// loads on demand. The connected address it publishes is mirrored onto the nav's
// connect button (`data-address`, see updateWalletState) and broadcast on
// wallet:changed, so reading it needs no import; only the signature path below,
// a connected holder minting a pass, pulls the module in. Before this the tier
// badge, which mounts on every page, dragged ~290 KB (gzipped) of wallet code
// onto pages that never touch a wallet.
let _walletModule = null;
function loadWalletModule() {
	if (!_walletModule) _walletModule = import('./wallet.js');
	return _walletModule;
}
function readConnectedWallet() {
	try {
		if (typeof document === 'undefined') return null;
		const btn = document.getElementById('connect-wallet-btn');
		return (btn && btn.dataset.address) || null;
	} catch {
		return null;
	}
}
let _walletAddr = readConnectedWallet();

// A wallet connect/disconnect/switch changes who the caller is, so the cached access
// matrix and tier pass are now for the wrong identity. Drop both and re-track the
// address so the next read reflects the wallet in hand. Registered at import time —
// before any mountTierBadge() call — so it always runs ahead of the per-badge
// re-render listeners those mounts add: they then read an already-invalidated cache
// and fetch fresh for the new identity.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
	window.addEventListener('wallet:changed', (e) => {
		const next =
			e?.detail && Object.prototype.hasOwnProperty.call(e.detail, 'address')
				? e.detail.address || null
				: readConnectedWallet();
		if (next === _walletAddr) return;
		_walletAddr = next;
		_matrix = { at: 0, data: null, wallet: undefined };
		_tierPass = null;
		_tierPassInFlight = null;
	});
}

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// The canonical message a connected wallet signs to mint a tier pass without an
// account. MUST stay byte-identical to the server validator (checkTierPassMessage in
// api/three/[action].js — it requires the 'three.ws' domain, the wallet, and a fresh
// `Issued At:`) and to tests/three-tier-public.test.js: the server reconstructs and
// verifies the signature over these exact bytes, so any drift breaks every mint.
function buildTierPassMessage(wallet, issuedAt) {
	return [
		'three.ws — verify wallet to unlock $THREE holder perks.',
		'',
		`Wallet: ${wallet}`,
		`Issued At: ${issuedAt}`,
		'',
		'Signing is free and does not move funds.',
	].join('\n');
}

// base64url → JSON (the tier-pass payload is the part before the first '.').
function decodePassExpMs(pass) {
	try {
		let b = String(pass).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
		while (b.length % 4) b += '=';
		const json = JSON.parse(atob(b));
		const exp = Number(json.exp) || 0;
		return exp > 0 ? exp * 1000 : 0;
	} catch {
		return 0;
	}
}

// ── Data ──────────────────────────────────────────────────────────────────────

/**
 * Fetch the access matrix (no arg) or a single feature's access.
 * Returns null on failure so callers render a safe locked state.
 * Matrix shape: { signed_in, wallet_linked, tier:{level,id,label,held_usd}, features:[…] }
 * Feature shape: { signed_in, wallet_linked, tier, access:{…} }
 */
export async function getAccess(feature, { fresh = false } = {}) {
	const wallet = _walletAddr;
	if (
		!fresh &&
		!feature &&
		_matrix.data &&
		_matrix.wallet === wallet &&
		Date.now() - _matrix.at < ACCESS_TTL_MS
	) {
		return _matrix.data;
	}
	// A connected wallet reads its own on-chain tier via ?wallet=; with no wallet the
	// request carries only the session cookie and the server reads the linked account.
	const params = new URLSearchParams();
	if (feature) params.set('feature', feature);
	if (wallet) params.set('wallet', wallet);
	const qs = params.toString();
	const url = qs ? `/api/three/access?${qs}` : '/api/three/access';
	try {
		const r = await fetch(url, { credentials: 'include' });
		if (!r.ok) return null;
		const data = await r.json();
		if (!feature) _matrix = { at: Date.now(), data, wallet };
		return data;
	} catch {
		return null;
	}
}

/**
 * Mint (or reuse) the signed $THREE tier pass. Cached until ~1 min before expiry.
 * Split by identity:
 *   • A connected wallet mints via the signature path — sign a fresh, domain-bound
 *     message and POST { wallet, message, signature }. The wallet popup only fires on
 *     an INTERACTIVE call (a user gesture); a background `primeTierPass()` for a
 *     connected wallet returns the cached pass or null, never a surprise prompt.
 *   • No connected wallet → the session POST (silent), unchanged for signed-in users.
 * Concurrent mints de-dupe onto one in-flight promise. Returns null when the caller
 * is anonymous / has no linked wallet (the endpoint 401/403s) or on any failure —
 * the caller simply proceeds with no pass attached.
 * @param {{ interactive?: boolean }} [opts]
 */
export async function getTierPass({ interactive = false } = {}) {
	const now = Date.now();
	const wallet = _walletAddr;

	// Serve a still-valid pass, but only if it was minted for the identity in hand
	// (a wallet change clears it — this is the belt-and-suspenders check).
	if (_tierPass && _tierPass.wallet === wallet && _tierPass.exp - 60_000 > now) {
		return _tierPass;
	}

	// A connected wallet must sign to mint — do that only on an interactive call so a
	// background prime never pops the wallet's signature dialog.
	if (wallet && !interactive) return null;

	// De-dupe concurrent mints (e.g. an interactive Generate click racing a prime).
	if (_tierPassInFlight) return _tierPassInFlight;
	_tierPassInFlight = (wallet ? mintWalletTierPass(wallet) : mintSessionTierPass()).finally(() => {
		_tierPassInFlight = null;
	});
	return _tierPassInFlight;
}

// Mint a pass for a connected wallet by signing the canonical message. Never throws;
// degrades to null on a declined signature, a disconnect mid-flight, or a rejected
// POST. Only adopts the result as the live cache when the connected identity hasn't
// changed mid-mint, so a wallet switch can't leave a stale pass on the header.
async function mintWalletTierPass(wallet) {
	try {
		const { getConnectedWallet } = await loadWalletModule();
		const provider = getConnectedWallet();
		if (!provider?.signMessage) return null;
		const message = buildTierPassMessage(wallet, new Date().toISOString());
		const encoded = new TextEncoder().encode(message);
		const signed = await provider.signMessage(encoded, 'utf8');
		const sigBytes = signed?.signature ?? signed;
		const bs58 = (await import('bs58')).default;
		const signature = bs58.encode(sigBytes);
		const r = await fetch('/api/three/tier-pass', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ wallet, message, signature }),
		});
		if (!r.ok) return null;
		const data = await r.json().catch(() => null);
		if (!data?.pass) return null;
		const expMs = decodePassExpMs(data.pass) || Date.now() + 9 * 60_000;
		const entry = { pass: data.pass, tier: data.tier || null, exp: expMs, wallet };
		if (_walletAddr === wallet) _tierPass = entry;
		return entry;
	} catch {
		return null;
	}
}

// Mint a pass for the signed-in session (no body → getSessionUser server-side). The
// original v1 path, kept byte-for-byte so signed-in users are unaffected.
async function mintSessionTierPass() {
	try {
		const r = await fetch('/api/three/tier-pass', { method: 'POST', credentials: 'include' });
		if (!r.ok) return null;
		const data = await r.json().catch(() => null);
		if (!data?.pass) return null;
		const expMs = decodePassExpMs(data.pass) || Date.now() + 9 * 60_000;
		const entry = { pass: data.pass, tier: data.tier || null, exp: expMs, wallet: null };
		if (_walletAddr === null) _tierPass = entry;
		return entry;
	} catch {
		return null;
	}
}

/** The cached pass string for the x-three-tier-pass header, or null. Synchronous. */
export function tierPassHeader() {
	return _tierPass && _tierPass.exp - 60_000 > Date.now() ? _tierPass.pass : null;
}

/**
 * Attach the cached $THREE tier pass to a request headers object so an eligible
 * holder's entitlement rides along on a gated call. Synchronous and side-effect
 * free when no valid pass is cached — the request simply proceeds at the base
 * entitlement and the server stays the authority. Returns the same object for
 * chaining: `fetch(url, { headers: attachTierPass({ 'content-type': '…' }) })`.
 */
export function attachTierPass(headers = {}) {
	const pass = tierPassHeader();
	if (pass) headers['x-three-tier-pass'] = pass;
	return headers;
}

/**
 * Fetch the pass in the background so it's ready when a gated request fires. Always
 * non-interactive: a signed-in session mints silently, while a connected wallet is
 * left for the next interactive getTierPass({ interactive:true }) so priming never
 * pops the wallet's signature dialog.
 */
export function primeTierPass() {
	getTierPass();
}

// ── Tier badge ─────────────────────────────────────────────────────────────────

// Bind the wallet:changed re-render once per element so repeat mounts don't stack
// listeners. WeakSet lets a removed element be GC'd without leaking.
const _badgeBound = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

/**
 * Render the holder's tier chip into `target` — for a signed-in account OR a
 * connected wallet. Hides it for anonymous visitors and non-holders. Re-renders
 * itself on wallet:changed so a freshly-connected holder sees their tier (and a
 * disconnect clears it) without a reload.
 */
export async function mountTierBadge(target) {
	const el = typeof target === 'string' ? document.querySelector(target) : target;
	if (!el) return;
	injectStyles();
	// The module-level wallet:changed listener has already invalidated the matrix by
	// the time this per-element listener fires, so the re-mount's getAccess() fetches
	// fresh for the new identity.
	if (_badgeBound && typeof window !== 'undefined' && !_badgeBound.has(el)) {
		_badgeBound.add(el);
		window.addEventListener('wallet:changed', () => {
			mountTierBadge(el);
		});
	}
	const data = await getAccess();
	// Show the chip for any real holder (Bronze+) — whether the tier was resolved from
	// a signed-in account or a connected wallet's on-chain holdings, the tier is real.
	// Anonymous visitors and non-holders (Member, level 0) hold no $THREE, so the green
	// holder chip would read as a false signal — they get the upsell on /three instead.
	if (!data || !data.tier || (Number(data.tier.level) || 0) < 1) {
		el.hidden = true;
		el.innerHTML = '';
		return;
	}
	el.hidden = false;
	const t = data.tier;
	const held =
		t.held_usd > 0
			? ` · $${Number(t.held_usd).toLocaleString('en-US', { maximumFractionDigits: 0 })} held`
			: '';
	// Icon + label are separate spans so the nav can collapse the chip to just the ◆ on
	// the tightest viewports (≤520px) without losing the link or its accessible name.
	el.innerHTML =
		`<a class="tg-badge tg-tier-${escapeHtml(t.id)}" href="${ECONOMY_URL}" ` +
		`aria-label="Your $THREE tier: ${escapeHtml(t.label)}" ` +
		`title="Your $THREE holder tier — what it unlocks${held}">` +
		`<span class="tg-tier-mark" aria-hidden="true">◆</span>` +
		`<span class="tg-tier-label">${escapeHtml(t.label)}</span></a>`;
}

// ── Inline lock chip (beside a gated control) ─────────────────────────────────

/**
 * Render a compact lock/unlock chip into `target` from a single-feature access
 * payload (the `.access` object from getAccess(feature)). Null clears it.
 */
export function renderInlineLock(target, access) {
	const el = typeof target === 'string' ? document.querySelector(target) : target;
	if (!el) return;
	injectStyles();
	if (!access) {
		el.innerHTML = '';
		el.hidden = true;
		return;
	}
	el.hidden = false;
	if (access.eligible) {
		el.innerHTML = `<span class="tg-chip tg-chip--ok" role="status">✓ Unlocked · ${escapeHtml(access.held?.label || 'Holder')}</span>`;
		return;
	}
	const req = access.required?.label || 'a higher tier';
	el.innerHTML =
		`<span class="tg-chip tg-chip--lock"><span class="tg-lock" aria-hidden="true">🔒</span> ${escapeHtml(req)} holder perk` +
		` · <a href="${ECONOMY_URL}">Get $THREE →</a></span>`;
}

// ── High-level holder-value API (the documented one-import surface) ────────────
// renderTierBadge / requireTier / gateAffordance are the named, stable entry
// points other surfaces import. They are thin wrappers over the data + UI helpers
// above so there is exactly ONE client holder gate — these add ergonomics, not a
// second implementation. The canonical upgrade destination is ECONOMY_URL (/three).

/**
 * Render a tier chip for an ALREADY-resolved tier object (synchronous) — the
 * companion to {@link mountTierBadge}, which fetches the tier itself. Hides the
 * chip for non-holders (Member / level 0) so it never reads as a false signal.
 * @param {Element|string} target
 * @param {{ id?:string, label?:string, level?:number, held_usd?:number }|null} tier
 */
export function renderTierBadge(target, tier) {
	const el = typeof target === 'string' ? document.querySelector(target) : target;
	if (!el) return;
	injectStyles();
	if (!tier || (Number(tier.level) || 0) < 1) {
		el.hidden = true;
		el.innerHTML = '';
		return;
	}
	el.hidden = false;
	const held =
		Number(tier.held_usd) > 0
			? ` · $${Number(tier.held_usd).toLocaleString('en-US', { maximumFractionDigits: 0 })} held`
			: '';
	el.innerHTML =
		`<a class="tg-badge tg-tier-${escapeHtml(tier.id || 'member')}" href="${ECONOMY_URL}" ` +
		`aria-label="Your $THREE tier: ${escapeHtml(tier.label || 'Holder')}" ` +
		`title="Your $THREE holder tier — what it unlocks${held}">` +
		`<span class="tg-tier-mark" aria-hidden="true">◆</span>` +
		`<span class="tg-tier-label">${escapeHtml(tier.label || 'Holder')}</span></a>`;
}

/**
 * Resolve whether the caller may use a gated feature. The single eligibility read
 * a surface calls before exposing an affordance.
 * @param {string} featureId  a key of GATED_FEATURES (server: three-access.js)
 * @returns {Promise<{ allowed:boolean, tier:object|null, access:object|null, upgradeUrl:string }>}
 *   `allowed` is false on a clean "insufficient tier" AND on a network failure
 *   (caller renders the locked state; the server stays the only authority on the
 *   actual action). `upgradeUrl` is the canonical /three tier surface.
 */
export async function requireTier(featureId) {
	const data = await getAccess(featureId);
	const access = data?.access || null;
	return {
		allowed: Boolean(access?.eligible),
		tier: data?.tier || null,
		access,
		upgradeUrl: ECONOMY_URL,
	};
}

/**
 * Wire a gated affordance to the shared holder gate: read the feature's access,
 * reflect locked/unlocked on the control, and (when eligible) run `onUnlock`.
 * A locked control is marked disabled + `aria-disabled` and, when `lockEl` is
 * given, gets the inline lock chip beside it (routing to /three). When access
 * can't be read (network failure) the control is LEFT enabled — the server
 * remains the authority and answers with a 402 the caller can route to onGate().
 * @param {Element|string} target
 * @param {{ featureId:string, onUnlock?:(access)=>void, lockEl?:Element|string }} opts
 * @returns {Promise<{ allowed:boolean, access:object|null, tier:object|null, upgradeUrl:string }>}
 */
export async function gateAffordance(target, { featureId, onUnlock, lockEl } = {}) {
	const el = typeof target === 'string' ? document.querySelector(target) : target;
	if (!el || !featureId) return { allowed: false, access: null, tier: null, upgradeUrl: ECONOMY_URL };
	const data = await getAccess(featureId);
	const access = data?.access || null;
	// No access payload → couldn't check; don't hard-block (fail-open), the server
	// gate is authoritative. A real payload drives the locked/unlocked affordance.
	const allowed = access ? Boolean(access.eligible) : true;

	el.classList.toggle('three-locked', !allowed);
	if ('disabled' in el) el.disabled = !allowed;
	el.setAttribute('aria-disabled', String(!allowed));

	const chip = lockEl ? (typeof lockEl === 'string' ? document.querySelector(lockEl) : lockEl) : null;
	if (chip) renderInlineLock(chip, access);

	if (allowed && typeof onUnlock === 'function') onUnlock(access);
	return { allowed, access, tier: data?.tier || null, upgradeUrl: ECONOMY_URL };
}

// ── Upsell modal (402 three_hold_required) ────────────────────────────────────

/**
 * Show the holder-gate upsell from a `three_hold_required` payload:
 *   { feature, required:{level,id,label}, held:{level,id,label,usd?}, why,
 *     get_three_url?, acquire?, usd_to_go?, pay_per_use?:{action,usd}|null, message? }
 * @param {object} gate
 * @param {{ onPayPerUse?: (pay)=>void }} [opts]  when provided AND gate.pay_per_use
 *        is present, a working "Pay per generation" button is rendered.
 */
export function showThreeGate(gate, opts = {}) {
	injectStyles();
	if (!gate || typeof document === 'undefined') return;
	closeThreeGate(); // never stack

	const required = gate.required || { label: 'a higher tier' };
	const held = gate.held || { label: 'Member', level: 0 };
	const getUrl = gate.get_three_url || ECONOMY_URL;
	const heldUsd = Number(held.usd) || 0;
	const reason = gate.reason || (held.level > 0 ? 'insufficient_tier' : '');

	// Conversion telemetry — the gate IS the contextual upgrade moment, so this is
	// the one place every call site's upsell impression + click is measured. Props
	// carry only tier ids/labels and the offered price (no wallet/PII). track() is a
	// no-op when analytics isn't loaded and never throws, so it can't break the modal.
	const gateProps = {
		feature: gate.feature || undefined,
		required_tier: required.id || required.label || undefined,
		held_tier: held.id || held.label || undefined,
		reason: reason || undefined,
		has_pay_per_use: Boolean(gate.pay_per_use),
		pay_per_use_usd: gate.pay_per_use ? Number(gate.pay_per_use.usd) || undefined : undefined,
	};

	const sub =
		reason === 'sign_in'
			? 'Sign in and link a Solana wallet to check your tier.'
			: reason === 'link_wallet'
				? 'Link a Solana wallet to your account so we can read your $THREE.'
				: `You hold <strong>${escapeHtml(held.label)}</strong>${heldUsd > 0 ? ` (≈ $${heldUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })})` : ''}. Reach <strong>${escapeHtml(required.label)}</strong> to unlock this.`;

	const payBtn =
		gate.pay_per_use && typeof opts.onPayPerUse === 'function'
			? `<button class="tg-btn tg-btn--ghost" id="tg-pay" type="button">Pay $${Number(gate.pay_per_use.usd).toFixed(2)} per generation</button>`
			: '';

	const overlay = document.createElement('div');
	overlay.className = 'tg-overlay';
	overlay.id = 'tg-overlay';
	overlay.innerHTML = `
		<div class="tg-modal" role="dialog" aria-modal="true" aria-labelledby="tg-title" aria-describedby="tg-desc">
			<button class="tg-x" id="tg-close" type="button" aria-label="Close">✕</button>
			<div class="tg-badge-lg" aria-hidden="true">◆</div>
			<h2 class="tg-title" id="tg-title">${escapeHtml(gate.message ? required.label + ' perk' : 'Hold $THREE to unlock')}</h2>
			<p class="tg-feature">${escapeHtml(gate.label || gate.message || 'This is a $THREE holder feature.')}</p>
			<p class="tg-desc" id="tg-desc">${sub}</p>
			${gate.why ? `<p class="tg-why">${escapeHtml(gate.why)}</p>` : ''}
			<div class="tg-actions">
				<a class="tg-btn tg-btn--primary" id="tg-get" href="${escapeHtml(safeUrl(getUrl))}">Get $THREE</a>
				${payBtn}
				<a class="tg-btn tg-btn--ghost" href="${PRICE_URL}">$THREE price &amp; chart</a>
			</div>
			<p class="tg-foot">$THREE is the only coin on three.ws. Draft &amp; Standard generation stay free, forever.</p>
		</div>`;

	document.body.appendChild(overlay);
	const modal = overlay.querySelector('.tg-modal');
	const close = () => closeThreeGate();
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	overlay.querySelector('#tg-close').addEventListener('click', close);
	// Impression — step 1 of the upgrade funnel. Persist the intent so the eventual
	// conversion attributes even across a navigation to the token page and back.
	markUpgradeIntent(gateProps.feature);
	trackFunnelStep('upgrade', ANALYTICS_EVENTS.UPGRADE_GATE_SHOWN, gateProps);
	// "Get $THREE" — the hold path (step 2). Fire on click before the anchor navigates.
	const getEl = overlay.querySelector('#tg-get');
	if (getEl) {
		getEl.addEventListener('click', () => {
			trackFunnelStep('upgrade', ANALYTICS_EVENTS.UPGRADE_GET_THREE_CLICKED, {
				feature: gateProps.feature,
				required_tier: gateProps.required_tier,
			});
		});
	}
	const payEl = overlay.querySelector('#tg-pay');
	if (payEl) {
		payEl.addEventListener('click', () => {
			// The alternate "pay per use" branch — tracked as its own catalog event.
			track(ANALYTICS_EVENTS.UPGRADE_PAY_PER_USE_CLICKED, {
				feature: gateProps.feature,
				action: gate.pay_per_use?.action || undefined,
				pay_per_use_usd: gateProps.pay_per_use_usd,
			});
			close();
			opts.onPayPerUse(gate.pay_per_use);
		});
	}
	const onKey = (e) => {
		if (e.key === 'Escape') close();
	};
	overlay._onKey = onKey;
	document.addEventListener('keydown', onKey);
	requestAnimationFrame(() => {
		overlay.classList.add('tg-in');
		(overlay.querySelector('#tg-get') || modal).focus();
	});
}

export function closeThreeGate() {
	const overlay = document.getElementById('tg-overlay');
	if (!overlay) return;
	if (overlay._onKey) document.removeEventListener('keydown', overlay._onKey);
	overlay.classList.remove('tg-in');
	const remove = () => overlay.remove();
	overlay.addEventListener('transitionend', remove, { once: true });
	setTimeout(remove, 260); // fallback when transitions are disabled
}

/**
 * Open the holder-gate upsell from a `three_hold_required` 402 response body — the
 * entry point a gated request's error path calls when the server rejects a stale
 * or missing pass. The 402 payload already carries everything the modal needs
 * ({ feature, label, required, held, why, pay_per_use, reason }), so it is passed
 * straight through to {@link showThreeGate}. A thin, intent-named alias so call
 * sites read as "on gate → upsell" rather than reaching for the modal directly.
 * @param {object} payload  the parsed `three_hold_required` 402 body
 * @param {{ onPayPerUse?: (pay)=>void }} [opts]
 */
export function onGate(payload, opts) {
	return showThreeGate(payload, opts);
}

// ── Upgrade conversion tracking ────────────────────────────────────────────────
// A gate impression is the top of the upgrade funnel; the conversion is the gated
// action finally succeeding — which can happen after the user leaves to acquire
// $THREE and returns (the hold path) or pays inline (pay-per-use). We persist a
// short-lived "intent" in sessionStorage when the gate is shown so the conversion
// can be attributed even across the navigation to the token page and back.
const UPGRADE_INTENT_KEY = 'three:upgrade_intent';
const UPGRADE_INTENT_TTL_MS = 30 * 60_000; // 30 min — long enough for a swap round-trip

function markUpgradeIntent(feature) {
	try {
		sessionStorage.setItem(
			UPGRADE_INTENT_KEY,
			JSON.stringify({ feature: feature || null, at: Date.now() }),
		);
	} catch {
		/* storage unavailable (private mode / embed) — conversion just won't attribute */
	}
}

/**
 * Close the upgrade funnel when a previously-gated action completes. No-op (returns
 * false) unless a gate was shown within the TTL, so it's safe to call on every
 * success of a gateable action — it fires UPGRADE_CONVERTED at most once per gate.
 * @param {{ feature?: string, path?: 'hold'|'pay_per_use', usd?: number }} [info]
 * @returns {boolean} whether the conversion event was emitted.
 */
export function trackUpgradeConverted({ feature, path, usd } = {}) {
	let intent = null;
	try {
		const raw = sessionStorage.getItem(UPGRADE_INTENT_KEY);
		if (raw) intent = JSON.parse(raw);
	} catch {
		return false;
	}
	if (!intent || !(Date.now() - Number(intent.at) < UPGRADE_INTENT_TTL_MS)) return false;
	try {
		sessionStorage.removeItem(UPGRADE_INTENT_KEY); // consume — one conversion per gate
	} catch {
		/* best-effort */
	}
	return trackFunnelStep('upgrade', ANALYTICS_EVENTS.UPGRADE_CONVERTED, {
		feature: feature || intent.feature || undefined,
		path: path || undefined,
		usd: Number(usd) > 0 ? Number(usd) : undefined,
	});
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const css = `
	.tg-badge{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 Inter,system-ui,sans-serif;
		color:#6ee7a8;border:1px solid rgba(110,231,168,.3);background:rgba(110,231,168,.07);
		border-radius:999px;padding:6px 11px;text-decoration:none;transition:.16s cubic-bezier(.22,1,.36,1);white-space:nowrap;}
	.tg-badge:hover{transform:translateY(-1px);border-color:rgba(110,231,168,.55);background:rgba(110,231,168,.12);}
	.tg-tier-gold,.tg-tier-genesis{color:#f5c451;border-color:rgba(245,196,81,.32);background:rgba(245,196,81,.08);}
	.tg-tier-silver{color:#cfd6e4;border-color:rgba(207,214,228,.3);background:rgba(207,214,228,.06);}
	.tg-chip{display:inline-flex;align-items:center;gap:6px;font:600 11.5px/1.3 Inter,system-ui,sans-serif;
		border-radius:999px;padding:5px 10px;}
	.tg-chip--lock{color:#f0d488;background:rgba(245,196,81,.1);border:1px solid rgba(245,196,81,.24);}
	.tg-chip--lock a{color:#6ee7a8;text-decoration:none;font-weight:700;}
	.tg-chip--lock a:hover{text-decoration:underline;}
	.tg-chip--ok{color:#6ee7a8;background:rgba(110,231,168,.1);border:1px solid rgba(110,231,168,.24);}
	.tg-lock{font-size:11px;}
	.tg-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
		padding:20px;background:rgba(4,4,7,.66);backdrop-filter:blur(7px);opacity:0;transition:opacity .2s ease;}
	.tg-overlay.tg-in{opacity:1;}
	.tg-modal{position:relative;width:min(440px,100%);background:linear-gradient(180deg,#0e0e13,#0a0a0e);
		border:1px solid #23232c;border-radius:20px;padding:34px 30px 26px;text-align:center;color:#f6f6f8;
		font-family:Inter,system-ui,sans-serif;box-shadow:0 30px 80px -30px rgba(0,0,0,.8);
		transform:translateY(10px) scale(.98);transition:transform .24s cubic-bezier(.22,1,.36,1);}
	.tg-overlay.tg-in .tg-modal{transform:none;}
	.tg-x{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:9px;border:1px solid #23232c;
		background:transparent;color:#9a9aa4;cursor:pointer;font-size:13px;transition:.15s;}
	.tg-x:hover{color:#f6f6f8;border-color:#34343f;}
	.tg-badge-lg{font-size:34px;color:#6ee7a8;filter:drop-shadow(0 0 14px rgba(110,231,168,.5));margin-bottom:8px;}
	.tg-title{font-size:22px;font-weight:820;letter-spacing:-.02em;margin:2px 0 8px;}
	.tg-feature{font-size:14.5px;color:#c9c9d2;margin:0 0 10px;line-height:1.45;}
	.tg-desc{font-size:13.5px;color:#9a9aa4;margin:0 0 8px;line-height:1.5;}
	.tg-desc strong{color:#f6f6f8;}
	.tg-why{font-size:12.5px;color:#80808b;margin:0 0 18px;line-height:1.5;font-style:italic;}
	.tg-actions{display:flex;flex-direction:column;gap:9px;margin-top:6px;}
	.tg-btn{display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;
		padding:12px 18px;border-radius:12px;text-decoration:none;cursor:pointer;border:1px solid #2a2a33;
		transition:.16s cubic-bezier(.22,1,.36,1);}
	.tg-btn--primary{background:#6ee7a8;color:#06120c;border-color:#6ee7a8;}
	.tg-btn--primary:hover{background:#8af0c0;transform:translateY(-1px);}
	.tg-btn--ghost{background:#0e0e13;color:#f6f6f8;}
	.tg-btn--ghost:hover{border-color:#3a3a44;transform:translateY(-1px);}
	.tg-foot{font-size:11px;color:#6a6a74;margin:16px 0 0;line-height:1.5;}
	:where(.tg-btn,.tg-badge,.tg-x):focus-visible{outline:2px solid #6ee7a8;outline-offset:2px;}
	@media (prefers-reduced-motion: reduce){
		.tg-overlay,.tg-modal,.tg-badge,.tg-btn{transition:none;}
		.tg-modal{transform:none;}
	}`;
	const el = document.createElement('style');
	el.id = 'tg-styles';
	el.textContent = css;
	document.head.appendChild(el);
}
