/**
 * Fork a trade: the one-tap "do what they just did" action.
 *
 * A leaderboard says who is good. A ghost-copy replay says what their edge
 * would have done to your budget. Neither one lets you act. Fork closes that
 * gap everywhere a coin is rendered: one tap opens the real pump.fun trade
 * panel (src/game/coin-buy.js) for that exact mint, pre-filled with the size
 * being forked, and the user's own wallet signs it. Nothing here custodies,
 * delegates, or auto-executes: the fork is a pre-filled intent, the human is
 * still the signer.
 *
 * Three pieces, so any surface can adopt it in a few lines:
 *
 *   forkButton(...)      → markup for template-rendered surfaces (innerHTML)
 *   mountForkLinks(root) → one delegated listener for every [data-fork-mint]
 *   initFork()           → the above, plus the ?fork=<mint> deep link
 *
 * The deep link is what makes a fork travel. Any shared artifact (a PnL card, a
 * Telegram post, an X reply) can carry `?fork=<mint>&fork_size=<sol>` back to a
 * page that calls initFork(), and the trade panel opens on arrival with the
 * referrer's code already parked by /referral-capture.js. That is the whole
 * viral unit: not "follow me", but "do what I just did, right now".
 *
 * The heavy Solana + pump SDKs live behind a dynamic import, so a page that
 * merely renders fork buttons never pays for them until one is clicked.
 */

import { toast } from './shared/toast.js';

export const FORK_PARAM = 'fork';
export const FORK_SIZE_PARAM = 'fork_size';

// A forked size arrives from a link a stranger wrote, so it is clamped before
// it is ever shown as an amount. The user still reviews and signs, but a link
// must not be able to pre-fill a life-changing number and hope for a fat
// finger. Forks are "match their conviction", not "wire your net worth".
export const MAX_FORK_SOL = 10;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** @param {unknown} v @returns {boolean} true when v looks like a base58 mint. */
export function isMint(v) {
	return typeof v === 'string' && MINT_RE.test(v);
}

/**
 * Coerce an untrusted fork size into a usable SOL amount.
 * @param {unknown} raw
 * @returns {number|null} a positive amount capped at MAX_FORK_SOL, else null.
 */
export function clampForkSize(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return null;
	// Four decimals is the finest size the trade panel quotes in; rounding here
	// stops 0.30000000000000004 landing in the amount input.
	return Number(Math.min(n, MAX_FORK_SOL).toFixed(4));
}

/**
 * Build the fork query string for a trade.
 * @param {{mint:string, size?:number|string}} trade
 * @param {string} [base] path the link should land on (default: this page).
 * @returns {string} e.g. `/trades?fork=<mint>&fork_size=0.5`
 */
export function forkPath(trade, base) {
	if (!isMint(trade?.mint)) return '';
	const path = base || location.pathname;
	const q = new URLSearchParams();
	q.set(FORK_PARAM, trade.mint);
	const size = clampForkSize(trade.size);
	if (size != null) q.set(FORK_SIZE_PARAM, String(size));
	return `${path}?${q}`;
}

// The viewer's referral code, fetched once per page. Signed-out visitors have
// none, which is not an error: they simply share a bare fork link.
let refCodeP = null;
function referralCode() {
	if (!refCodeP) {
		refCodeP = fetch('/api/users/referrals', { credentials: 'include', headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : null))
			.then((card) => card?.referral_code || card?.code || card?.referralCode || null)
			.catch(() => null);
	}
	return refCodeP;
}

/**
 * The absolute, shareable fork URL, carrying the sharer's referral code when
 * they have one so the loop pays whoever spread it.
 * @param {{mint:string, size?:number|string}} trade
 * @param {{base?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function forkShareUrl(trade, { base } = {}) {
	const path = forkPath(trade, base);
	if (!path) return '';
	const url = new URL(path, location.origin);
	const ref = await referralCode();
	if (ref) url.searchParams.set('ref', ref);
	return url.toString();
}

/**
 * Open the real trade panel for a coin, pre-filled with the forked size.
 * @param {{mint:string, symbol?:string, name?:string, image?:string, size?:number|string}} trade
 * @returns {Promise<boolean>} false when the panel could not be loaded.
 */
export async function openFork(trade) {
	if (!isMint(trade?.mint)) return false;
	try {
		const { openBuyModal } = await import('./game/coin-buy.js');
		openBuyModal(
			{ mint: trade.mint, symbol: trade.symbol, name: trade.name, image: trade.image },
			// elevate: a fork always opens on a page carrying the site nav, which
			// stacks above the modal's default /play layer.
			{ mode: 'buy', amount: clampForkSize(trade.size) ?? undefined, elevate: true },
		);
		return true;
	} catch {
		toast('Could not open the trade panel. Trade this coin on pump.fun instead.', { variant: 'error' });
		return false;
	}
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Markup for a fork button, for the surfaces that render with innerHTML.
 * DOM-built surfaces should use forkAttrs() and set the attributes directly.
 * @param {{mint:string, symbol?:string, name?:string, size?:number|string}} trade
 * @param {{label?:string, className?:string, share?:boolean, title?:string}} [opts]
 * @returns {string}
 */
export function forkButton(trade, opts = {}) {
	if (!isMint(trade?.mint)) return '';
	const size = clampForkSize(trade.size);
	const sym = trade.symbol ? `$${String(trade.symbol).toUpperCase()}` : 'this coin';
	const label = opts.label || (size != null ? `Fork ${size} SOL` : 'Fork trade');
	const aria = opts.share
		? `Share a fork link for ${sym}`
		: `Fork this trade: buy ${sym}${size != null ? ` with ${size} SOL` : ''} from your own wallet`;
	return `<button type="button" class="${esc(opts.className || 'fork-btn')}"${opts.share ? ' data-fork-share="1"' : ''}` +
		` data-fork-mint="${esc(trade.mint)}"` +
		(trade.symbol ? ` data-fork-symbol="${esc(trade.symbol)}"` : '') +
		(trade.name ? ` data-fork-name="${esc(trade.name)}"` : '') +
		(size != null ? ` data-fork-size="${esc(size)}"` : '') +
		` aria-label="${esc(aria)}"${opts.title ? ` title="${esc(opts.title)}"` : ''}>${esc(label)}</button>`;
}

/**
 * Read a fork trade off an element's data attributes.
 * @param {Element} el
 * @returns {{mint:string, symbol?:string, name?:string, image?:string, size?:number}|null}
 */
export function forkFromEl(el) {
	const mint = el?.getAttribute?.('data-fork-mint');
	if (!isMint(mint)) return null;
	return {
		mint,
		symbol: el.getAttribute('data-fork-symbol') || undefined,
		name: el.getAttribute('data-fork-name') || undefined,
		image: el.getAttribute('data-fork-image') || undefined,
		size: clampForkSize(el.getAttribute('data-fork-size')) ?? undefined,
	};
}

const mounted = new WeakSet();

/**
 * Delegate every [data-fork-mint] click inside `root` to the trade panel, and
 * every [data-fork-share] click to the share sheet. Idempotent per root, so a
 * surface that re-renders its rows can call it as often as it likes.
 * @param {Document|Element} [root]
 */
export function mountForkLinks(root = document) {
	if (mounted.has(root)) return;
	mounted.add(root);
	root.addEventListener('click', async (e) => {
		const el = e.target instanceof Element ? e.target.closest('[data-fork-mint]') : null;
		if (!el || !root.contains(el)) return;
		const trade = forkFromEl(el);
		if (!trade) return;
		e.preventDefault();
		e.stopPropagation();
		if (el.hasAttribute('data-fork-share')) {
			const url = await forkShareUrl(trade);
			if (!url) return;
			const sym = trade.symbol ? `$${String(trade.symbol).toUpperCase()}` : 'this coin';
			const { showSharePanel } = await import('./shared/share.js');
			showSharePanel({
				kind: 'fork',
				id: trade.mint,
				title: `Fork this ${sym} trade`,
				description: 'One tap opens the real pump.fun trade, pre-filled. Their wallet signs it, not ours.',
				shareText: `Forking ${sym} on three.ws${trade.size ? ` at ${trade.size} SOL` : ''}`,
				shareUrl: url,
			}, el);
			return;
		}
		await openFork(trade);
	});
}

/**
 * Consume a `?fork=<mint>` deep link: open the trade panel for it and strip the
 * fork params from the URL so a refresh (or a back-navigation) does not reopen
 * a panel the user already dismissed. Every other param, `ref` included, stays.
 * @returns {boolean} true when a fork link was present and honored.
 */
export function consumeForkLink() {
	const q = new URLSearchParams(location.search);
	const mint = q.get(FORK_PARAM);
	if (!isMint(mint)) return false;
	const size = clampForkSize(q.get(FORK_SIZE_PARAM));
	q.delete(FORK_PARAM);
	q.delete(FORK_SIZE_PARAM);
	const rest = q.toString();
	history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
	openFork({ mint, size: size ?? undefined });
	return true;
}

/**
 * Everything a page needs in one call: delegated fork buttons plus the deep
 * link. Safe to call before the rows exist, since the listener is delegated.
 * @param {{root?: Document|Element, deepLink?: boolean}} [opts]
 */
export function initFork({ root = document, deepLink = true } = {}) {
	mountForkLinks(root);
	if (deepLink) consumeForkLink();
}
