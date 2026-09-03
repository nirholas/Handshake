// @vitest-environment jsdom
//
// Fork a trade: the one-tap "do what they just did" action shared by every
// coin surface (/trades, /ghost-copy, /radar).
//
// Two properties matter enough to pin. First, a fork size arrives inside a link
// a stranger wrote, so it must be clamped and sanitised before it is ever
// pre-filled as an amount: a link must not be able to seed a life-changing
// number and hope for a fat finger. Second, a fork link has to survive the trip
// through X or Telegram and still open the right panel on arrival, which means
// the deep link is parsed, honoured exactly once, and stripped from the URL
// without taking the referral code with it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	isMint,
	clampForkSize,
	forkPath,
	forkButton,
	forkFromEl,
	consumeForkLink,
	MAX_FORK_SOL,
	FORK_PARAM,
	FORK_SIZE_PARAM,
} from '../src/fork-trade.js';

// A synthetic, clearly-placeholder mint: never a real third-party coin.
const MINT = 'THREEsynthetic1111111111111111111111111111';

const openBuyModal = vi.fn();
vi.mock('../src/game/coin-buy.js', () => ({ openBuyModal: (...a) => openBuyModal(...a) }));

function goTo(search) {
	window.history.replaceState(null, '', `/radar${search}`);
}

describe('mint validation', () => {
	it('accepts a base58 mint and rejects everything else', () => {
		expect(isMint(MINT)).toBe(true);
		expect(isMint('')).toBe(false);
		expect(isMint(null)).toBe(false);
		expect(isMint('not a mint')).toBe(false);
		// base58 excludes 0, O, I and l, so an address carrying them is not one.
		expect(isMint('0OIl'.repeat(9))).toBe(false);
		expect(isMint(`${MINT}${MINT}`)).toBe(false);
	});
});

describe('fork size clamping', () => {
	it('keeps a sane size', () => {
		expect(clampForkSize(0.5)).toBe(0.5);
		expect(clampForkSize('1.25')).toBe(1.25);
	});

	it('caps a hostile size at the ceiling rather than pre-filling it', () => {
		expect(clampForkSize(9_999)).toBe(MAX_FORK_SOL);
		expect(clampForkSize(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_FORK_SOL);
	});

	it('rejects a size that is not a positive number', () => {
		for (const bad of [0, -1, 'abc', '', null, undefined, NaN, Infinity, {}]) {
			expect(clampForkSize(bad)).toBeNull();
		}
	});

	it('rounds to the precision the trade panel actually quotes in', () => {
		expect(clampForkSize(0.1 + 0.2)).toBe(0.3);
		expect(clampForkSize(0.123456789)).toBe(0.1235);
	});
});

describe('fork links', () => {
	it('builds a link carrying the mint and the clamped size', () => {
		const url = new URL(forkPath({ mint: MINT, size: 0.5 }, '/trades'), 'https://three.ws');
		expect(url.pathname).toBe('/trades');
		expect(url.searchParams.get(FORK_PARAM)).toBe(MINT);
		expect(url.searchParams.get(FORK_SIZE_PARAM)).toBe('0.5');
	});

	it('omits the size when there is none to carry', () => {
		const url = new URL(forkPath({ mint: MINT }, '/trades'), 'https://three.ws');
		expect(url.searchParams.has(FORK_SIZE_PARAM)).toBe(false);
	});

	it('refuses to build a link for a non-mint', () => {
		expect(forkPath({ mint: 'nope' }, '/trades')).toBe('');
	});
});

describe('fork button markup', () => {
	it('labels itself with the size it forks and escapes what it is handed', () => {
		const html = forkButton({ mint: MINT, symbol: '"><script>x</script>', size: 0.5 });
		expect(html).toContain('Fork 0.5 SOL');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('renders nothing for a row with no valid mint', () => {
		expect(forkButton({ mint: null })).toBe('');
	});

	it('round-trips through the data attributes it writes', () => {
		document.body.innerHTML = forkButton({ mint: MINT, symbol: 'TICKER', name: 'Ticker', size: 99_999 });
		const trade = forkFromEl(document.querySelector('[data-fork-mint]'));
		expect(trade).toEqual({ mint: MINT, symbol: 'TICKER', name: 'Ticker', image: undefined, size: MAX_FORK_SOL });
	});
});

describe('the ?fork= deep link', () => {
	beforeEach(() => { openBuyModal.mockClear(); });

	it('opens the trade panel at the forked size and strips only the fork params', async () => {
		goTo(`?${FORK_PARAM}=${MINT}&${FORK_SIZE_PARAM}=0.5&ref=ABC123&view=list`);
		expect(consumeForkLink()).toBe(true);
		await vi.waitFor(() => expect(openBuyModal).toHaveBeenCalledTimes(1));
		expect(openBuyModal).toHaveBeenCalledWith(
			expect.objectContaining({ mint: MINT }),
			expect.objectContaining({ mode: 'buy', amount: 0.5 }),
		);
		const after = new URL(window.location.href);
		expect(after.searchParams.has(FORK_PARAM)).toBe(false);
		expect(after.searchParams.has(FORK_SIZE_PARAM)).toBe(false);
		// The referral code is what pays whoever shared the fork, and the view is
		// the visitor's own state. Neither is ours to drop.
		expect(after.searchParams.get('ref')).toBe('ABC123');
		expect(after.searchParams.get('view')).toBe('list');
	});

	it('is honoured once, so a refresh does not reopen a dismissed panel', async () => {
		goTo(`?${FORK_PARAM}=${MINT}`);
		expect(consumeForkLink()).toBe(true);
		await vi.waitFor(() => expect(openBuyModal).toHaveBeenCalledTimes(1));
		expect(consumeForkLink()).toBe(false);
		expect(openBuyModal).toHaveBeenCalledTimes(1);
	});

	it('ignores a link whose mint is junk', () => {
		goTo('?fork=javascript:alert(1)');
		expect(consumeForkLink()).toBe(false);
		expect(openBuyModal).not.toHaveBeenCalled();
	});

	it('does nothing on a page reached without a fork link', () => {
		goTo('?view=grid');
		expect(consumeForkLink()).toBe(false);
		expect(window.location.search).toBe('?view=grid');
	});
});
