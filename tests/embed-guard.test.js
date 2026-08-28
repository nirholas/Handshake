// @vitest-environment jsdom
//
// The coin page mounts three third-party chart terminals (TradingView,
// DexScreener, GeckoTerminal) and had no failure handling on any of them. A
// cross-origin embed tells the host page almost nothing: `load` fires even for
// the provider's own error page, and an embed an ad blocker swallows fires
// neither `load` nor `error`. So a blocked terminal left a 300px empty box with
// no text, which reads as "this site is broken".
//
// The guard is timing logic, which is exactly the kind that rots silently, so
// both halves are pinned: the deadline must not start before a lazy iframe is
// on screen (or every below-the-fold embed reports itself dead), and the
// replacement panel must always carry a way out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchEmbed, embedFallbackNode, renderEmbedFallback, DEFAULT_EMBED_TIMEOUT_MS } from '../src/shared/embed-guard.js';

// A hand-driven IntersectionObserver: the test decides when the node scrolls in.
function fakeObserver() {
	const state = { observed: [], disconnected: false, cb: null };
	const factory = (cb) => {
		state.cb = cb;
		return {
			observe: (node) => state.observed.push(node),
			disconnect: () => { state.disconnected = true; },
		};
	};
	state.enter = () => state.cb?.([{ isIntersecting: true }]);
	state.scrollPast = () => state.cb?.([{ isIntersecting: false }]);
	return { factory, state };
}

describe('watchEmbed', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('does not fire while the embed is still below the fold', () => {
		const onTimeout = vi.fn();
		const { factory } = fakeObserver();
		watchEmbed(document.createElement('iframe'), { timeoutMs: 1000, onTimeout, observerFactory: factory });

		vi.advanceTimersByTime(60_000);

		// A lazy iframe has not begun loading yet, so it cannot have failed.
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it('starts the clock when the embed scrolls into view', () => {
		const onTimeout = vi.fn();
		const { factory, state } = fakeObserver();
		watchEmbed(document.createElement('iframe'), { timeoutMs: 1000, onTimeout, observerFactory: factory });

		state.scrollPast();
		vi.advanceTimersByTime(5000);
		expect(onTimeout).not.toHaveBeenCalled();

		state.enter();
		vi.advanceTimersByTime(999);
		expect(onTimeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it('stops watching once the embed reports it loaded', () => {
		const onTimeout = vi.fn();
		const { factory, state } = fakeObserver();
		const cancel = watchEmbed(document.createElement('iframe'), { timeoutMs: 1000, onTimeout, observerFactory: factory });

		state.enter();
		cancel();
		vi.advanceTimersByTime(60_000);

		expect(onTimeout).not.toHaveBeenCalled();
		expect(state.disconnected).toBe(true);
	});

	it('cancels cleanly before the embed was ever seen, leaking no observer', () => {
		const onTimeout = vi.fn();
		const { factory, state } = fakeObserver();
		const cancel = watchEmbed(document.createElement('iframe'), { timeoutMs: 1000, onTimeout, observerFactory: factory });

		cancel();
		state.enter();
		vi.advanceTimersByTime(60_000);

		expect(onTimeout).not.toHaveBeenCalled();
		expect(state.disconnected).toBe(true);
	});

	it('falls back to starting immediately with no IntersectionObserver', () => {
		// A false "did not load" is the safe direction; a permanent skeleton is not.
		const onTimeout = vi.fn();
		const real = globalThis.IntersectionObserver;
		delete globalThis.IntersectionObserver;
		try {
			watchEmbed(document.createElement('iframe'), { timeoutMs: 1000, onTimeout });
			vi.advanceTimersByTime(1000);
		} finally {
			if (real) globalThis.IntersectionObserver = real;
		}
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it('defaults to a deadline generous enough for a heavy third-party terminal', () => {
		expect(DEFAULT_EMBED_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
	});
});

describe('embedFallbackNode', () => {
	const opts = {
		name: 'The DexScreener chart',
		href: 'https://dexscreener.com/solana/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		label: 'Open in DexScreener',
		onRetry: () => {},
	};

	it('says what failed and why, not just that something went wrong', () => {
		const node = embedFallbackNode(opts);
		expect(node.textContent).toContain('The DexScreener chart did not load');
		expect(node.textContent).toMatch(/ad blocker|extension|network/);
	});

	it('always offers a way to see the chart anyway', () => {
		const node = embedFallbackNode(opts);
		const link = node.querySelector('a');
		expect(link.href).toBe(opts.href);
		expect(link.target).toBe('_blank');
		// An untrusted outbound link must not hand the provider window.opener.
		expect(link.rel).toContain('noopener');
	});

	it('offers a retry that actually calls back', () => {
		const onRetry = vi.fn();
		const node = embedFallbackNode({ ...opts, onRetry });
		node.querySelector('button').click();
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('is announced to a screen reader rather than appearing silently', () => {
		expect(embedFallbackNode(opts).getAttribute('role')).toBe('status');
	});

	it('replaces the dead embed in place instead of appending beside it', () => {
		const host = document.createElement('div');
		host.appendChild(document.createElement('iframe'));
		renderEmbedFallback(host, opts);
		expect(host.querySelector('iframe')).toBeNull();
		expect(host.children).toHaveLength(1);
	});
});
