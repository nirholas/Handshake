import { describe, it, expect } from 'vitest';
import {
	SCALE,
	OCTAVES,
	ROOT_HZ,
	CATEGORIES,
	categoryOf,
	hashString,
	degreeToHz,
	amountOf,
	intensityOf,
	eventToNote,
	describeEvent,
	createBurstGate,
	matchesFilter,
	parseFilter,
	filterLabel,
	normalizeActor,
} from '../src/symphony-score.js';

describe('symphony-score: scale', () => {
	it('degree 0 is the root and each octave doubles it', () => {
		expect(degreeToHz(0)).toBeCloseTo(ROOT_HZ, 6);
		expect(degreeToHz(SCALE.length)).toBeCloseTo(ROOT_HZ * 2, 6);
		expect(degreeToHz(SCALE.length * 2)).toBeCloseTo(ROOT_HZ * 4, 6);
	});

	it('every reachable degree lands on the pentatonic scale', () => {
		for (let d = 0; d < SCALE.length * OCTAVES; d++) {
			const semis = Math.round(12 * Math.log2(degreeToHz(d) / ROOT_HZ)) % 12;
			expect(SCALE).toContain(semis);
		}
	});

	it('clamps out-of-range and garbage degrees instead of throwing', () => {
		expect(degreeToHz(-5)).toBeCloseTo(ROOT_HZ, 6);
		expect(degreeToHz(9999)).toBeCloseTo(degreeToHz(SCALE.length * OCTAVES - 1), 6);
		expect(Number.isFinite(degreeToHz(NaN))).toBe(true);
	});
});

describe('symphony-score: hashing', () => {
	it('is deterministic and 32-bit unsigned', () => {
		expect(hashString('agent-7')).toBe(hashString('agent-7'));
		expect(hashString('agent-7')).not.toBe(hashString('agent-8'));
		expect(hashString('x')).toBeGreaterThanOrEqual(0);
		expect(hashString(null)).toBe(hashString(''));
	});
});

describe('symphony-score: categories', () => {
	it('maps every documented feed type to a known voice', () => {
		const types = [
			'payment', 'agora-earned', 'coin-buy', 'agent-deploy', 'agent-onchain',
			'member-join', 'agora-registered', 'level-up', 'world-join',
			'mission-complete', 'agora-task-posted', 'agora-hired',
			'agora-task-claimed', 'agora-task-completed', 'agora-vouched',
			'agent-guard', 'agora-flagged', 'jackpot',
		];
		for (const t of types) expect(CATEGORIES).toContain(categoryOf(t));
	});

	it('falls back to bell for unknown or missing types', () => {
		expect(categoryOf('brand-new-event')).toBe('bell');
		expect(categoryOf(undefined)).toBe('bell');
	});
});

describe('symphony-score: amounts', () => {
	it('reads USDC atomic units from payment events', () => {
		expect(amountOf({ type: 'payment', usdcAtomic: 2_500_000 })).toEqual({ value: 2.5, unit: 'USDC' });
	});

	it('reads SOL from coin buys and jackpot rewards', () => {
		expect(amountOf({ type: 'coin-buy', sol: 0.75 })).toEqual({ value: 0.75, unit: 'SOL' });
		expect(amountOf({ type: 'jackpot', reward: 1.2 })).toEqual({ value: 1.2, unit: 'SOL' });
	});

	it('parses agora reward labels with units and thousands separators', () => {
		expect(amountOf({ rewardLabel: '0.5 SOL' })).toEqual({ value: 0.5, unit: 'SOL' });
		expect(amountOf({ rewardLabel: '12,500 THREE' })).toEqual({ value: 12500, unit: 'THREE' });
	});

	it('returns null when an event carries no amount', () => {
		expect(amountOf({ type: 'member-join', handle: 'nix' })).toBeNull();
		expect(amountOf(null)).toBeNull();
	});
});

describe('symphony-score: intensity', () => {
	it('is bounded to [0.2, 1] and monotonic in amount', () => {
		const small = intensityOf({ sol: 0.001 });
		const mid = intensityOf({ sol: 0.5 });
		const whale = intensityOf({ sol: 50 });
		expect(small).toBeGreaterThanOrEqual(0.2);
		expect(whale).toBeLessThanOrEqual(1);
		expect(mid).toBeGreaterThan(small);
		expect(whale).toBeGreaterThan(mid);
	});

	it('gives amount-less events a fixed conversational level', () => {
		expect(intensityOf({ type: 'member-join' })).toBe(0.35);
	});
});

describe('symphony-score: eventToNote', () => {
	it('produces a complete, finite note spec', () => {
		const note = eventToNote({ type: 'payment', actor: 'NOVA', usdcAtomic: 5_000_000, id: 'a1' });
		expect(CATEGORIES).toContain(note.category);
		expect(Number.isFinite(note.hz)).toBe(true);
		expect(note.motifHz).toHaveLength(3);
		expect(note.motifHz.every(Number.isFinite)).toBe(true);
		expect(note.gain).toBeGreaterThan(0);
		expect(note.gain).toBeLessThanOrEqual(1);
		expect(note.pan).toBeGreaterThanOrEqual(-0.8);
		expect(note.pan).toBeLessThanOrEqual(0.8);
	});

	it('gives the same actor the same motif and pan across events', () => {
		const a = eventToNote({ type: 'payment', actor: 'ORACLE', usdcAtomic: 1_000_000 });
		const b = eventToNote({ type: 'payment', actor: 'ORACLE', usdcAtomic: 1_000_000 });
		expect(a.motifHz).toEqual(b.motifHz);
		expect(a.pan).toBe(b.pan);
	});

	it('puts bigger money in a lower register', () => {
		const dust = eventToNote({ type: 'coin-buy', actor: 'Z', sol: 0.001 });
		const whale = eventToNote({ type: 'coin-buy', actor: 'Z', sol: 100 });
		expect(whale.degree).toBeLessThan(dust.degree);
	});

	it('survives a completely empty event', () => {
		const note = eventToNote({});
		expect(CATEGORIES).toContain(note.category);
		expect(Number.isFinite(note.hz)).toBe(true);
	});
});

describe('symphony-score: describeEvent', () => {
	it('links payments to their explorer and agents to their profile', () => {
		const paid = describeEvent({ type: 'payment', actor: 'NOVA', usdcAtomic: 2_000_000, recipientLabel: 'ORACLE', explorerUrl: 'https://solscan.io/tx/abc' });
		expect(paid.href).toBe('https://solscan.io/tx/abc');
		expect(paid.title).toContain('NOVA');
		expect(paid.detail).toContain('USDC');

		const deployed = describeEvent({ type: 'agent-deploy', actor: 'nix', name: 'Helios', agentId: '42' });
		expect(deployed.href).toBe('/agents/42');
		expect(deployed.title).toContain('Helios');
	});

	it('rejects non-https explorer URLs', () => {
		const row = describeEvent({ type: 'payment', actor: 'X', explorerUrl: 'javascript:alert(1)' });
		expect(row.href).toBeNull();
	});

	it('composes guard refusals from the producer verb phrase', () => {
		const row = describeEvent({ type: 'agent-guard', actor: 'luna', label: 'skipped a pump.fun mayhem coin', reason: 'mayhem', agentId: 'a1' });
		expect(row.title).toBe('luna skipped a pump.fun mayhem coin');
		expect(row.detail).toBe('mayhem');
		expect(row.href).toBe('/agents/a1');
	});

	it('always yields printable copy for unknown types', () => {
		const row = describeEvent({ type: 'mystery-event', actor: 'Q' });
		expect(row.title.length).toBeGreaterThan(0);
		expect(row.icon.length).toBeGreaterThan(0);
	});
});

describe('symphony-score: burst gate', () => {
	const guard = (actor = 'luna') => ({ type: 'agent-guard', actor });

	it('admits the first event and suppresses the flood behind it', () => {
		const gate = createBurstGate(1500);
		expect(gate.admit(guard(), 1000).play).toBe(true);
		expect(gate.admit(guard(), 1200).play).toBe(false);
		expect(gate.admit(guard(), 2400).play).toBe(false);
	});

	it('re-admits after the gap with an accent sized by what it swallowed', () => {
		const gate = createBurstGate(1500);
		gate.admit(guard(), 1000);
		for (let t = 1100; t < 2500; t += 100) gate.admit(guard(), t);
		const next = gate.admit(guard(), 3000);
		expect(next.play).toBe(true);
		expect(next.accent).toBeGreaterThan(0);
		expect(next.accent).toBeLessThanOrEqual(0.3);
	});

	it('gates per (type, actor): different actors play independently', () => {
		const gate = createBurstGate(1500);
		expect(gate.admit(guard('luna'), 1000).play).toBe(true);
		expect(gate.admit(guard('nova'), 1001).play).toBe(true);
		expect(gate.admit({ type: 'payment', actor: 'luna' }, 1002).play).toBe(true);
	});

	it('never accents an unsuppressed key', () => {
		const gate = createBurstGate(1500);
		gate.admit(guard(), 1000);
		const next = gate.admit(guard(), 5000);
		expect(next).toEqual({ play: true, accent: 0 });
	});
});

describe('symphony-score: solo filter', () => {
	it('matches everything when the filter is empty', () => {
		for (const f of [null, undefined, {}, { actor: '' }]) {
			expect(matchesFilter({ type: 'payment', actor: 'NOVA' }, f)).toBe(true);
		}
	});

	it('matches an actor case- and whitespace-insensitively', () => {
		const f = { actor: 'My First Agent' };
		expect(matchesFilter({ actor: 'my first agent' }, f)).toBe(true);
		expect(matchesFilter({ actor: '  My   First Agent ' }, f)).toBe(true);
		expect(matchesFilter({ actor: 'Luna' }, f)).toBe(false);
	});

	it('matches an agentId exactly and ignores the actor label', () => {
		const f = { agentId: 'a-1' };
		expect(matchesFilter({ agentId: 'a-1', actor: 'Luna' }, f)).toBe(true);
		expect(matchesFilter({ agentId: 'a-1', actor: 'luna' }, f)).toBe(true);
		expect(matchesFilter({ agentId: 'a-2', actor: 'Luna' }, f)).toBe(false);
		expect(matchesFilter({ actor: 'Luna' }, f)).toBe(false); // no agentId on the event
	});

	it('never matches a missing event', () => {
		expect(matchesFilter(null, { actor: 'Luna' })).toBe(false);
	});

	it('normalizes actor labels predictably', () => {
		expect(normalizeActor('  My   First Agent ')).toBe('my first agent');
		expect(normalizeActor(null)).toBe('');
	});
});

describe('symphony-score: parseFilter', () => {
	it('reads ?agent and ?actor, preferring agent', () => {
		expect(parseFilter('?agent=a-1')).toEqual({ agentId: 'a-1' });
		expect(parseFilter('?actor=Luna')).toEqual({ actor: 'Luna' });
		expect(parseFilter('?agent=a-1&actor=Luna')).toEqual({ agentId: 'a-1' });
	});

	it('decodes and trims, and bounds the length', () => {
		expect(parseFilter('?actor=My%20First%20Agent')).toEqual({ actor: 'My First Agent' });
		expect(parseFilter(`?actor=${'x'.repeat(200)}`).actor).toHaveLength(64);
	});

	it('returns an empty filter for junk, blanks, or nothing', () => {
		expect(parseFilter('')).toEqual({});
		expect(parseFilter('?actor=')).toEqual({});
		expect(parseFilter('?other=1')).toEqual({});
		expect(parseFilter(null)).toEqual({});
	});
});

describe('symphony-score: filterLabel', () => {
	it('is empty when nothing is soloed', () => {
		expect(filterLabel({})).toBe('');
	});

	it('uses the actor verbatim', () => {
		expect(filterLabel({ actor: 'Luna' })).toBe('Luna');
	});

	it('resolves an agentId to a display name from the events it has seen', () => {
		const events = [{ agentId: 'a-1', actor: 'Luna' }];
		expect(filterLabel({ agentId: 'a-1' }, events)).toBe('Luna');
		expect(filterLabel({ agentId: 'a-9' }, events)).toBe('a-9'); // no event yet
	});
});
