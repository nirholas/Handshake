// Analytics — PostHog identity + a typed, documented event taxonomy.
//
// The snippet injected by vite.config.js auto-captures pageviews, clicks and
// session replays anonymously. This module adds:
//   1. Identity      — identifyUser() / resetIdentity() (call after auth resolves).
//   2. Event catalog  — ANALYTICS_EVENTS: the single source of truth for every
//                       product-meaningful event name + its documented props.
//   3. track()        — a validating facade. Unknown events are rejected (and
//                       surfaced in dev) so the taxonomy can't silently drift.
//   4. Funnels        — trackFunnelStep() for ordered conversion journeys
//                       (landing → connect-wallet → action → success).
//   5. Errors         — trackError() to capture handled boundary failures with
//                       context, so reliability shows up alongside behaviour.
//
// Privacy: never pass raw wallet addresses or other PII as props — use
// shortWallet() to truncate. Every call is a no-op when window.posthog isn't
// loaded (embed pages, ad-blockers) so callers can fire-and-forget and analytics
// can never break the app.

// ─────────────────────────────────────────────────────────────────────────────
// Event taxonomy — the documented catalog. Keys are stable event names sent to
// PostHog; comments describe the props each event should carry. Group by journey.
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYTICS_EVENTS = Object.freeze({
	// ── Acquisition ──────────────────────────────────────────────────────────
	/** Landing/home surfaced. props: { referrer?, utm_source?, path? } */
	LANDING_VIEWED: 'landing_viewed',
	/** A primary CTA was clicked. props: { cta: string, location: string } */
	CTA_CLICKED: 'cta_clicked',

	// ── Activation ───────────────────────────────────────────────────────────
	/** Wallet connect initiated. props: { provider?: string } */
	WALLET_CONNECT_STARTED: 'wallet_connect_started',
	/** Wallet connected. props: { provider?, wallet_short?, chain? } */
	WALLET_CONNECT_SUCCEEDED: 'wallet_connect_succeeded',
	/** Wallet connect failed. props: { provider?, reason? } */
	WALLET_CONNECT_FAILED: 'wallet_connect_failed',
	/** An agent was created. props: { agent_id?, source? } */
	AGENT_CREATED: 'agent_created',
	/** A recorded voice sample was cloned onto the agent. props: { agent_id?, billing?, source? } */
	VOICE_CLONE_BOUND: 'agent_voice_clone_bound',
	/** First embed/snippet generated for an agent. props: { agent_id?, embed_kind? } */
	EMBED_GENERATED: 'embed_generated',

	// ── $THREE holder funnel (ordered — see FUNNELS.three) ───────────────────
	/** $THREE token page viewed. props: { price_usd? } */
	TOKEN_PAGE_VIEWED: 'token_page_viewed',
	/** Buy/swap intent clicked. props: { source? } */
	TOKEN_BUY_CLICKED: 'token_buy_clicked',
	/** A swap quote was shown. props: { amount_usd?, out_amount? } */
	TOKEN_QUOTE_SHOWN: 'token_quote_shown',
	/** Swap submitted/confirmed by the user. props: { amount_usd? } */
	TOKEN_SWAP_CONFIRMED: 'token_swap_confirmed',
	/** Swap settled successfully. props: { amount_usd?, tx_short? } */
	TOKEN_SWAP_SUCCEEDED: 'token_swap_succeeded',

	// ── Upgrade / paywall funnel (ordered — see FUNNELS.upgrade) ─────────────
	/** A holder-gate / paywall upsell was shown at a free-lane limit. props:
	 *  { feature?, required_tier?, held_tier?, reason?, has_pay_per_use?, pay_per_use_usd? } */
	UPGRADE_GATE_SHOWN: 'upgrade_gate_shown',
	/** User chose the "Get $THREE" path from the gate. props: { feature?, required_tier? } */
	UPGRADE_GET_THREE_CLICKED: 'upgrade_get_three_clicked',
	/** User chose the contextual "Pay per use" path from the gate. props:
	 *  { feature?, action?, pay_per_use_usd? } */
	UPGRADE_PAY_PER_USE_CLICKED: 'upgrade_pay_per_use_clicked',
	/** The gated action completed after a gate was shown — the conversion. props:
	 *  { feature?, path: 'hold'|'pay_per_use', usd? } */
	UPGRADE_CONVERTED: 'upgrade_converted',

	// ── Engagement ───────────────────────────────────────────────────────────
	/** Marketplace search/filter used. props: { query_len?, filters? } */
	MARKETPLACE_SEARCHED: 'marketplace_searched',
	/** An agent profile was opened. props: { agent_id? } */
	AGENT_PROFILE_VIEWED: 'agent_profile_viewed',
	/** Visualizer/dashboard surface opened. props: { surface: string } — name
	 *  surfaces as `category:name` (e.g. 'dashboard:monetize', 'visualizer:galaxy')
	 *  so insights group cleanly across surfaces. */
	SURFACE_OPENED: 'surface_opened',

	// ── Creator monetization funnel (ordered — see FUNNELS.creator) ──────────
	/** Creator dashboard opened / "become a creator" intent. props: { agent_count?, has_prices? } */
	CREATOR_ONBOARDING_STARTED: 'creator_onboarding_started',
	/** A skill price (or pricing rule) was saved. props: { agent_id?, skill?, price_usdc?, gate_type?, is_first? } */
	CREATOR_PRICE_SET: 'creator_price_set',
	/** A payout wallet was configured for an agent. props: { agent_id?, network? } */
	CREATOR_PAYOUT_CONFIGURED: 'creator_payout_configured',
	/** The creator's first observed sale surfaced in the dashboard. props: { agent_id?, revenue_usd? } */
	CREATOR_FIRST_SALE: 'creator_first_sale',

	// ── Share (this module's own instrumentation surface) ────────────────────
	/** Share card flow opened. props: { kind: string, entity_id? } */
	SHARE_CARD_OPENED: 'share_card_opened',
	/** A share action fired. props: { kind, channel: 'copy'|'download'|'native'|'x', entity_id? } */
	SHARE_CARD_ACTION: 'share_card_action',

	// ── Errors ───────────────────────────────────────────────────────────────
	/** A handled error at a boundary. props: { context, message, code?, status? } */
	ERROR_OCCURRED: 'error_occurred',
});

const _eventValues = new Set(Object.values(ANALYTICS_EVENTS));

/**
 * Ordered conversion funnels. Each is a list of event names from
 * ANALYTICS_EVENTS; trackFunnelStep() tags events with their funnel + step index
 * so PostHog funnel insights line up without per-call configuration.
 */
export const FUNNELS = Object.freeze({
	activation: [
		ANALYTICS_EVENTS.LANDING_VIEWED,
		ANALYTICS_EVENTS.WALLET_CONNECT_STARTED,
		ANALYTICS_EVENTS.WALLET_CONNECT_SUCCEEDED,
		ANALYTICS_EVENTS.AGENT_CREATED,
	],
	three: [
		ANALYTICS_EVENTS.TOKEN_PAGE_VIEWED,
		ANALYTICS_EVENTS.TOKEN_BUY_CLICKED,
		ANALYTICS_EVENTS.TOKEN_QUOTE_SHOWN,
		ANALYTICS_EVENTS.TOKEN_SWAP_CONFIRMED,
		ANALYTICS_EVENTS.TOKEN_SWAP_SUCCEEDED,
	],
	// Supply-side proof: a creator lands on the dashboard, sets a price, wires a
	// payout wallet, and earns. Each step is the lever that turns a viewer into a
	// paid creator — the flywheel three.ws optimizes for.
	creator: [
		ANALYTICS_EVENTS.CREATOR_ONBOARDING_STARTED,
		ANALYTICS_EVENTS.CREATOR_PRICE_SET,
		ANALYTICS_EVENTS.CREATOR_PAYOUT_CONFIGURED,
		ANALYTICS_EVENTS.CREATOR_FIRST_SALE,
	],
	// Contextual upgrade moment at a free-lane limit → conversion. This array is
	// the primary "hold" path (acquire $THREE, whose acquisition tail is the
	// `three` funnel). The alternate "pay per use" branch is its own catalog event
	// (UPGRADE_PAY_PER_USE_CLICKED) — both branches terminate at UPGRADE_CONVERTED
	// when the gated action finally completes, so conversion is measurable for each.
	upgrade: [
		ANALYTICS_EVENTS.UPGRADE_GATE_SHOWN,
		ANALYTICS_EVENTS.UPGRADE_GET_THREE_CLICKED,
		ANALYTICS_EVENTS.UPGRADE_CONVERTED,
	],
});

// ─────────────────────────────────────────────────────────────────────────────
// PostHog plumbing
// ─────────────────────────────────────────────────────────────────────────────

function ph() {
	if (typeof window === 'undefined') return null;
	if (window.__posthog_blocked) return null;
	const p = window.posthog;
	if (!p || typeof p.capture !== 'function') return null;
	return p;
}

const _isDev =
	typeof import.meta !== 'undefined' && import.meta.env ? Boolean(import.meta.env.DEV) : false;

let _lastDistinctId = null;

/**
 * Tie subsequent events to a stable user.
 * @param {{ id: string, username?: string, email?: string, display_name?: string, created_at?: string }} user
 */
export function identifyUser(user) {
	if (!user?.id) return;
	const p = ph();
	if (!p || typeof p.identify !== 'function') return;
	// Avoid re-identifying on every getMe() call (most pages call it on load).
	if (_lastDistinctId === user.id) return;
	_lastDistinctId = user.id;
	try {
		p.identify(String(user.id), {
			username: user.username || undefined,
			email: user.email || undefined,
			name: user.display_name || user.username || undefined,
			created_at: user.created_at || undefined,
		});
	} catch {
		/* swallow — analytics must never break the app */
	}
}

/** Wipe the cookie-stored distinct_id so the next visit isn't tied to the user. */
export function resetIdentity() {
	_lastDistinctId = null;
	const p = ph();
	if (!p || typeof p.reset !== 'function') return;
	try {
		p.reset();
	} catch {
		/* swallow */
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// track() — the validating facade every call site uses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture a product-meaningful event. Reserve for actions in the catalog above —
 * most behaviour is already auto-captured. Unknown event names are rejected so
 * the taxonomy can't silently drift; in dev the rejection is logged.
 *
 * @param {string} event — must be a value from ANALYTICS_EVENTS.
 * @param {Record<string, any>} [props]
 * @returns {boolean} whether the event was accepted + sent.
 */
export function track(event, props = {}) {
	if (!_eventValues.has(event)) {
		if (_isDev && typeof console !== 'undefined') {
			console.warn(
				`[analytics] rejected unknown event "${event}" — add it to ANALYTICS_EVENTS in src/analytics.js`,
			);
		}
		return false;
	}
	const p = ph();
	if (!p) return false;
	try {
		p.capture(event, sanitizeProps(props));
		return true;
	} catch {
		/* swallow — analytics must never break the app */
		return false;
	}
}

/**
 * Track one step of a named conversion funnel. Stamps the event with
 * `funnel` + `funnel_step` (1-based) so funnel insights align in PostHog.
 *
 * @param {keyof typeof FUNNELS} funnel
 * @param {string} event — must belong to FUNNELS[funnel].
 * @param {Record<string, any>} [props]
 * @returns {boolean}
 */
export function trackFunnelStep(funnel, event, props = {}) {
	const steps = FUNNELS[funnel];
	if (!steps) {
		if (_isDev && typeof console !== 'undefined') {
			console.warn(`[analytics] unknown funnel "${funnel}"`);
		}
		return false;
	}
	const idx = steps.indexOf(event);
	if (idx < 0) {
		if (_isDev && typeof console !== 'undefined') {
			console.warn(`[analytics] event "${event}" is not a step of funnel "${funnel}"`);
		}
		return false;
	}
	return track(event, { ...props, funnel, funnel_step: idx + 1 });
}

/**
 * Capture a handled error at a boundary (network, user input, parse) with
 * enough context to triage without leaking internals. Errors are non-fatal to
 * the app — this is observability, not control flow.
 *
 * @param {string} context — where it happened, e.g. 'share_card.generate'.
 * @param {unknown} err — the caught error / value.
 * @param {Record<string, any>} [extra] — additional safe context.
 */
export function trackError(context, err, extra = {}) {
	const message =
		err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? 'unknown');
	const code = err && typeof err === 'object' ? err.code : undefined;
	const status = err && typeof err === 'object' ? err.status : undefined;
	return track(ANALYTICS_EVENTS.ERROR_OCCURRED, {
		context,
		message: String(message).slice(0, 300),
		...(code != null ? { code: String(code) } : {}),
		...(status != null ? { status: Number(status) } : {}),
		...extra,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate a wallet address for analytics props so a raw public key never lands
 * in an event payload: "FeMb…Jpump".
 * @param {string} addr
 * @returns {string}
 */
export function shortWallet(addr) {
	const s = String(addr || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

// Defensive: strip obvious full-length wallet/PII shapes from props so a careless
// call site can't leak a raw address. Values are kept otherwise as-is.
const _BASE58_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const _EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
function sanitizeProps(props) {
	if (!props || typeof props !== 'object') return {};
	const out = {};
	for (const [k, v] of Object.entries(props)) {
		if (v == null) continue;
		if (typeof v === 'string' && (_BASE58_WALLET.test(v) || _EVM_ADDRESS.test(v))) {
			out[k] = shortWallet(v);
		} else {
			out[k] = v;
		}
	}
	return out;
}
