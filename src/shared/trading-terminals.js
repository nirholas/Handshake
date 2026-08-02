// Trading-terminal links, and the one place our referral codes live.
//
// Every "trade this token on X" link in the product routes through here so the
// codes are set once instead of being pasted into each widget. Imported by both
// the browser bundles (src/widgets, src/dashboard-next) and the API layer
// (api/_lib/crypto-trending.js), so this file stays dependency-free.
//
// Which terminals accept a referral on a token deep link, per their own docs:
//
//   GMGN  yes. https://docs.gmgn.ai/index/referral-link documents
//         `gmgn.ai/{chain}/token/{code}_{contract}` and
//         `gmgn.ai/{chain}/address/{code}_{wallet}`, so the deep link and the
//         referral travel together and nothing is given up.
//   Axiom no. The documented referral form is `axiom.trade/@{handle}` only.
//   Padre no. The documented referral form is `trade.padre.gg/rk/{code}` only.
//   FOMO  no. The documented referral form is `fomo.family/r/{username}` only.
//
// For the three that cannot combine the two, the token deep link WINS: a person
// clicking "Padre" next to a specific coin wants that coin, not a signup page.
// Their referral codes are surfaced through referralUrl() on signup-intent
// surfaces instead. Do NOT "fix" this by inventing a `?ref=` query parameter.
// None of the three document one, an undocumented guess silently earns nothing,
// and a wrong parameter can break the destination page.

/** Referral codes / handles, by terminal. Change a code here and it changes everywhere. */
export const REFERRAL_CODES = {
	gmgn: 'nichxbt',
	axiom: 'nich',
	padre: 'nichxbt',
	fomo: 'nichxbt',
};

/**
 * GMGN chain slug. GMGN serves a token page per chain under its own slug, and
 * the smart-money feed surfaces Solana, Ethereum, Base and BNB Chain, so an
 * unknown-chain fallback to `sol` must not swallow the other three: that would
 * point an Ethereum token at a Solana URL that cannot resolve. Pass through the
 * slugs GMGN documents and default only genuinely unknown input to Solana.
 */
const GMGN_CHAINS = new Set(['sol', 'eth', 'base', 'bsc', 'tron', 'blast']);
function gmgnChain(chain) {
	const slug = String(chain || '').trim().toLowerCase();
	return GMGN_CHAINS.has(slug) ? slug : 'sol';
}

/**
 * GMGN token page, referral embedded per GMGN's documented
 * `{chain}/token/{code}_{contract}` form.
 */
export function gmgnTokenUrl(mint, chain = 'sol') {
	return `https://gmgn.ai/${gmgnChain(chain)}/token/${REFERRAL_CODES.gmgn}_${encodeURIComponent(mint)}`;
}

/**
 * GMGN wallet page, referral embedded per GMGN's documented
 * `{chain}/address/{code}_{wallet}` form.
 */
export function gmgnAddressUrl(address, chain = 'sol') {
	return `https://gmgn.ai/${gmgnChain(chain)}/address/${REFERRAL_CODES.gmgn}_${encodeURIComponent(address)}`;
}

/** Axiom token page. No documented referral form for deep links (see header). */
export function axiomTokenUrl(mint) {
	return `https://axiom.trade/meme/${encodeURIComponent(mint)}`;
}

/** Padre token page. No documented referral form for deep links (see header). */
export function padreTokenUrl(mint) {
	return `https://trade.padre.gg/trade/solana/${encodeURIComponent(mint)}`;
}

/** FOMO token page. No documented referral form for deep links (see header). */
export function fomoTokenUrl(mint) {
	return `https://fomo.family/token/${encodeURIComponent(mint)}`;
}

/**
 * The bare referral link for a terminal, for surfaces where signing up (not
 * viewing one token) is the intent. Each of these gives the person who follows
 * it a fee discount on that terminal, which is why they are worth showing.
 *
 * @param {'gmgn'|'axiom'|'padre'|'fomo'} platform
 * @returns {string|null} null for an unknown platform
 */
export function referralUrl(platform) {
	const code = REFERRAL_CODES[platform];
	if (!code) return null;
	if (platform === 'gmgn') return `https://gmgn.ai/r/${code}`;
	if (platform === 'axiom') return `https://axiom.trade/@${code}`;
	if (platform === 'padre') return `https://trade.padre.gg/rk/${code}`;
	return `https://fomo.family/r/${code}`;
}

/** Display names, by terminal key. */
export const TERMINAL_LABELS = {
	gmgn: 'GMGN',
	axiom: 'Axiom',
	padre: 'Padre',
	fomo: 'FOMO',
};

/**
 * The terminals whose referral cannot ride along on a token deep link, so the
 * only way to offer it is a separate signup link. GMGN is deliberately absent:
 * gmgnTokenUrl() and gmgnAddressUrl() already carry the code, so listing it
 * again would be a duplicate link to the same place.
 *
 * Following one of these earns the person who clicks it a fee discount on that
 * terminal, which is the reason it is worth surfacing at all.
 *
 * @returns {{ key: string, label: string, url: string }[]}
 */
export function referralOffers() {
	return ['axiom', 'padre', 'fomo'].map((key) => ({
		key,
		label: TERMINAL_LABELS[key],
		url: referralUrl(key),
	}));
}

/**
 * Token deep links for every terminal we link, in display order.
 * @returns {{ key: string, label: string, short: string, url: string }[]}
 */
export function terminalLinks(mint) {
	return [
		{ key: 'axiom', label: 'Axiom', short: 'AXI', url: axiomTokenUrl(mint) },
		{ key: 'gmgn', label: 'GMGN', short: 'GMG', url: gmgnTokenUrl(mint) },
		{ key: 'padre', label: 'Padre', short: 'PDR', url: padreTokenUrl(mint) },
		{ key: 'fomo', label: 'FOMO', short: 'FMO', url: fomoTokenUrl(mint) },
	];
}
