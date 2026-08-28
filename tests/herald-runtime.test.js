// Runtime tests for createHerald (herald-sdk/src/index.js): the orchestration
// around the rules engine. Presenters are injected, the clock is injected, and
// timers are faked, so these assert real behaviour (what reached a human, in
// what order, and what got held) with no DOM and no waiting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHerald } from '../herald-sdk/src/index.js';

function fakePresenter(name, { shows = true } = {}) {
	const shown = [];
	return {
		name,
		shown,
		async ready() {
			return shows;
		},
		async present(message, opts) {
			shown.push({ text: message.text, importance: message.importance, opts });
			return shows;
		},
		stop() {},
	};
}

function harness(over = {}) {
	let clock = Date.parse('2026-08-28T12:00:00.000Z');
	const card = fakePresenter('card');
	const avatar = fakePresenter('avatar');
	const delivered = [];
	const dropped = [];
	const herald = createHerald({
		presenters: { avatar, card },
		now: () => clock,
		onDeliver: (m) => delivered.push(m.text),
		onDrop: (m, reason) => dropped.push([m?.text ?? null, reason]),
		...over,
	});
	return {
		herald,
		card,
		avatar,
		delivered,
		dropped,
		tick: (ms) => {
			clock += ms;
		},
		get clock() {
			return clock;
		},
	};
}

// Let every queued microtask (presenter awaits) settle.
const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('delivery', () => {
	it('prefers the avatar when one can be rendered', async () => {
		const h = harness();
		h.herald.announce({ text: 'Deploy is green', importance: 80 });
		await settle();
		expect(h.avatar.shown.map((s) => s.text)).toEqual(['Deploy is green']);
		expect(h.card.shown).toHaveLength(0);
		expect(h.herald.stats().delivered).toBe(1);
	});

	it('falls back to the card when the avatar cannot render', async () => {
		const avatar = fakePresenter('avatar', { shows: false });
		const h = harness({ presenters: { avatar, card: fakePresenter('card') } });
		h.herald.announce({ text: 'No GPU here', importance: 80 });
		await settle();
		expect(h.herald.stats().delivered).toBe(1);
	});

	it('passes a dwell scaled to the line and an Open action for a url', async () => {
		const h = harness();
		h.herald.announce({ text: 'Payment received', importance: 80, url: '/wallet' });
		await settle();
		const { opts } = h.avatar.shown[0];
		expect(opts.dwellMs).toBeGreaterThan(4000);
		expect(opts.actions[0]).toMatchObject({ label: 'Open', href: '/wallet' });
	});

	it('counts a presenter that throws as dropped, and keeps working after', async () => {
		const avatar = fakePresenter('avatar');
		avatar.present = async () => {
			throw new Error('webgl lost');
		};
		const h = harness({ presenters: { avatar, card: fakePresenter('card') } });
		h.herald.announce({ text: 'first', importance: 80 });
		await settle();
		expect(h.herald.stats().dropped).toBe(1);
		h.herald.announce({ text: 'second', importance: 80, id: 'two' });
		await settle();
		expect(h.herald.stats().received).toBe(2);
	});
});

describe('the interrupt budget', () => {
	it('says a message once, however many times a source repeats it', async () => {
		const h = harness();
		for (let i = 0; i < 3; i++) h.herald.announce({ id: 'same', text: 'Same thing', importance: 80 });
		await settle();
		expect(h.avatar.shown).toHaveLength(1);
		expect(h.dropped).toContainEqual(['Same thing', 'duplicate']);
	});

	it('drops what does not clear the floor and reports why', async () => {
		const h = harness({ rules: { minImportance: 70 } });
		h.herald.announce({ text: 'FYI', importance: 20 });
		await settle();
		expect(h.avatar.shown).toHaveLength(0);
		expect(h.herald.stats().drops.at(-1)).toMatchObject({ reason: 'below-importance-floor' });
	});

	it('holds a burst past the batch size and collapses it into one summary', async () => {
		const h = harness({ rules: { maxPerWindow: 1, batchSize: 2 } });
		for (const i of [1, 2, 3, 4]) {
			h.herald.announce({ id: `b${i}`, text: `alert ${i}`, importance: 70 + i });
		}
		await settle();
		// One got through; the rest are rate-limited into the held queue.
		expect(h.avatar.shown).toHaveLength(1);
		expect(h.herald.stats().holding).toBe(3);

		// Let the rate window drain, then run the sweep.
		h.tick(70_000);
		await vi.advanceTimersByTimeAsync(6_000);
		await settle();
		const lines = h.avatar.shown.map((s) => s.text);
		expect(lines).toContain('alert 4'); // highest importance first
		expect(lines.some((l) => /more message/.test(l))).toBe(true);
	});

	it('mutes and unmutes on demand', async () => {
		const h = harness();
		h.herald.mute();
		h.herald.announce({ text: 'ignored', importance: 100 });
		await settle();
		expect(h.avatar.shown).toHaveLength(0);
		expect(h.herald.muted).toBe(true);

		h.herald.unmute();
		h.herald.announce({ text: 'heard', importance: 100 });
		await settle();
		expect(h.avatar.shown.map((s) => s.text)).toEqual(['heard']);
	});

	it('expires a timed mute', async () => {
		const h = harness();
		h.herald.mute(60_000);
		h.herald.announce({ text: 'during', importance: 100 });
		await settle();
		expect(h.avatar.shown).toHaveLength(0);
		h.tick(61_000);
		h.herald.announce({ text: 'after', importance: 100 });
		await settle();
		expect(h.avatar.shown.map((s) => s.text)).toEqual(['after']);
	});
});

describe('scorers', () => {
	it('lifts a message over the floor by who it is from', async () => {
		const h = harness({ rules: { minImportance: 80 } });
		h.herald.rule((m) => (m.from === 'oncall' ? 100 : undefined));
		h.herald.announce({ text: 'page', importance: 10, from: 'oncall' });
		h.herald.announce({ text: 'noise', importance: 10, from: 'newsletter' });
		await settle();
		expect(h.avatar.shown.map((s) => s.text)).toEqual(['page']);
	});
});

describe('sources', () => {
	it('reads a source and normalises whatever shape it emits', async () => {
		const h = harness();
		const source = {
			name: 'test',
			start(emit) {
				emit({ id: 's1', body: 'From a feed', priority: 90, link: '/x' });
				emit('a bare string that is important enough by default');
				return () => {};
			},
		};
		h.herald.source(source);
		await settle();
		expect(h.herald.stats().received).toBe(2);
		expect(h.avatar.shown[0].text).toBe('From a feed');
	});

	it('stops every source when the herald stops', async () => {
		const h = harness();
		const stopped = vi.fn();
		h.herald.source({ name: 'x', start: () => stopped });
		h.herald.stop();
		expect(stopped).toHaveBeenCalled();
	});
});

describe('stats', () => {
	it('reports what happened, with the last drops and their reasons', async () => {
		const h = harness();
		h.herald.announce({ text: 'kept', importance: 90 });
		h.herald.announce({ text: '', importance: 90 });
		await settle();
		const stats = h.herald.stats();
		expect(stats).toMatchObject({ received: 1, delivered: 1, dropped: 1 });
		expect(stats.drops.at(-1).reason).toBe('empty');
	});
});
