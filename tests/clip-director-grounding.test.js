// The Clip Director's whole promise is "the real number, never a screenshot":
// /clip-director renders the card next to the on-chain proof link for the trade
// it claims to describe. The LLM lane writes the voice, so nothing downstream
// can tell a fluent invention from a fact.
//
// It is not hypothetical. During the /clip-director route audit a provider in
// the free chain answered a real +1.89x WIN on $NIBZ with "-8.2% realized loss"
// on "$THREE", gesture "celebrate": every word fluent, every fact invented, and
// it shipped straight to the page beside a solscan link proving the opposite.
//
// These tests pin the guard that catches it: every ticker and every figure in a
// generated card must trace to the trade, and the avatar reaction must point the
// same way the trade went.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The free LLM chain needs no key, so llmConfigured() is true even in CI and an
// unmocked directClip would reach the network and assert on whatever a rate
// limiter felt like returning. The writer is stubbed here so each test states
// exactly what the model said and what the guard did with it.
const llmText = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({
	llmConfigured: () => true,
	llmComplete: async (...a) => ({ text: await llmText(...a) }),
	LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

const { isGrounded, directClip, tradeFromPosition } = await import('../api/_lib/clip-director.js');

// The real closed round-trip, exactly as the API shaped it from the DB row.
const WIN = {
	mint: '4bJDxBr9F5JzJKCEkY1gqDGyP6B51ip6QfEyKKhYpump',
	symbol: 'NIBZ', name: 'Nibz',
	multiple: 1.89, pnl_pct: 214.6,
	entry_sol: 0.17, exit_sol: 0.32, realized_pnl_sol: 0.37,
	hold_min: 14, exit_reason: 'take_profit', quote_symbol: 'SOL', is_win: true,
	sell_sig: '5Hp5Q196Yjj57cFnsn2QTXTiVKYwVsYKuBixTwqTSekt6tpV5GseeR96a9e8HErkA1znvrMxzuewa1CXonm6PQdc',
};

const LOSS = { ...WIN, symbol: 'RACR', name: 'Racer', multiple: 0.22, pnl_pct: -78, realized_pnl_sol: -0.09, exit_reason: 'stop_loss', is_win: false };

describe('isGrounded', () => {
	it('rejects the exact hallucination observed in production traffic', () => {
		expect(isGrounded({
			hook: 'I let my bias override the data on $THREE today.',
			feature_stat: '-8.2% realized loss',
			body: 'Held the bounce expectation too long despite the volume profile breaking down.',
			alt_text: 'An agent closed a losing trade.',
		}, WIN)).toBe(false);
	});

	it('accepts copy whose every figure is in the trade', () => {
		expect(isGrounded({
			hook: '$NIBZ closed 1.89x in 14m. On-chain, no screenshots.',
			feature_stat: '1.89x',
			body: 'Took profit at target after 14 minutes, 0.37 SOL realized.',
			alt_text: 'Closed $NIBZ at 1.89x for 0.37 SOL.',
		}, WIN)).toBe(true);
	});

	it('rejects a foreign ticker even when every number is real', () => {
		expect(isGrounded({
			hook: '$BONK closed 1.89x in 14m.', feature_stat: '1.89x',
			body: 'Took profit at target.', alt_text: 'A winning trade.',
		}, WIN)).toBe(false);
	});

	it('rejects an invented number even when the ticker is right', () => {
		expect(isGrounded({
			hook: '$NIBZ closed 4.2x in 14m.', feature_stat: '4.2x',
			body: 'Took profit at target.', alt_text: 'A winning trade.',
		}, WIN)).toBe(false);
	});

	it('accepts the hold time read in either minutes or hours', () => {
		const long = { ...WIN, hold_min: 180 };
		expect(isGrounded({ hook: '$NIBZ ran 3h to 1.89x.', feature_stat: '1.89x', body: 'Held 180 minutes.', alt_text: 'A win.' }, long)).toBe(true);
	});

	it('does not read digits inside a ticker as a stated number', () => {
		const t = { ...WIN, symbol: 'W3B', name: null };
		expect(isGrounded({ hook: '$W3B closed 1.89x.', feature_stat: '1.89x', body: 'Closed at target.', alt_text: 'A win.' }, t)).toBe(true);
	});

	it('allows the follower count, which is real but not part of the trade', () => {
		expect(isGrounded({ hook: '$NIBZ closed 1.89x.', feature_stat: '1.89x', body: 'Copied by 12 traders.', alt_text: 'A win.' }, WIN, { copiedByCount: 12 })).toBe(true);
		expect(isGrounded({ hook: '$NIBZ closed 1.89x.', feature_stat: '1.89x', body: 'Copied by 900 traders.', alt_text: 'A win.' }, WIN, { copiedByCount: 12 })).toBe(false);
	});

	it('rejects empty copy rather than passing it through as vacuously grounded', () => {
		expect(isGrounded({ hook: '', feature_stat: '', body: '', alt_text: '' }, WIN)).toBe(false);
	});
});

describe('directClip', () => {
	beforeEach(() => llmText.mockReset());

	it('discards the hallucinated card and answers from the real trade instead', async () => {
		llmText.mockResolvedValue(JSON.stringify({
			hook: 'I let my bias override the data on $THREE today.',
			feature_stat: '-8.2% realized loss',
			avatar_gesture: 'celebrate',
			body: 'Held the bounce expectation too long despite the volume profile breaking down.',
			cta: 'view-track-record',
			alt_text: 'An agent closed a losing trade.',
		}));
		const clip = await directClip({ agentName: 'Crosshair', trade: WIN, surface: 'x' });
		expect(clip.source).toBe('deterministic');
		expect(clip.hook).not.toContain('THREE');
		expect(clip.feature_stat).toBe('1.89x');
		expect(isGrounded(clip, WIN)).toBe(true);
		expect(clip.verifiable).toBe(true);
	});

	it('keeps the model’s voice when every figure in it is real', async () => {
		llmText.mockResolvedValue(JSON.stringify({
			hook: '$NIBZ closed 1.89x in 14m. On-chain, no screenshots.',
			feature_stat: '1.89x',
			avatar_gesture: 'celebrate',
			body: 'Take profit hit after 14 minutes for 0.37 SOL realized.',
			cta: 'copy-the-agent',
			alt_text: 'Crosshair closed $NIBZ at 1.89x.',
		}));
		const clip = await directClip({ agentName: 'Crosshair', trade: WIN, surface: 'x' });
		expect(clip.source).toBe('llm');
		expect(clip.hook).toContain('$NIBZ');
	});

	it('rejects a card whose numbers only survive until the length clamp cuts them', async () => {
		// finalize() clamps the hook at 120 chars. A clamp landing mid-number turns
		// a real 1.89 into a stated 1.8, so the guard runs on the finalized bytes.
		const pad = 'On-chain, verifiable, no screenshots, and the whole round-trip stays on the public record for anyone to check.';
		llmText.mockResolvedValue(JSON.stringify({
			hook: `${pad} $NIBZ 1.89x`,
			feature_stat: '1.89x', avatar_gesture: 'celebrate',
			body: 'Take profit hit.', cta: 'copy-the-agent', alt_text: 'A win.',
		}));
		const clip = await directClip({ agentName: 'Crosshair', trade: WIN, surface: 'x' });
		expect(clip.source).toBe('deterministic');
	});

	it('gives a loss an honest card, never a celebration', async () => {
		llmText.mockImplementation(() => { throw new Error('providers exhausted'); });
		// "Swarm 2" is a real agent name, not a stated figure: the guard has to know
		// the difference or every numbered agent falls back forever.
		const clip = await directClip({ agentName: 'Swarm 2', trade: LOSS, surface: 'feed' });
		expect(clip.source).toBe('deterministic');
		expect(['sweat', 'shrug']).toContain(clip.avatar_gesture);
		expect(clip.cta).toBe('view-track-record');
		expect(isGrounded(clip, LOSS, { agentName: 'Swarm 2' })).toBe(true);
	});

	it('will not let a writer celebrate a stop-out', async () => {
		llmText.mockResolvedValue(JSON.stringify({
			hook: '$RACR stopped out at 0.22x.', feature_stat: '0.22x',
			avatar_gesture: 'celebrate', body: 'Risk line held.', cta: 'view-track-record',
			alt_text: 'A losing trade on $RACR.',
		}));
		const clip = await directClip({ agentName: 'Swarm 2', trade: LOSS, surface: 'x' });
		expect(clip.avatar_gesture).not.toBe('celebrate');
		expect(['sweat', 'shrug']).toContain(clip.avatar_gesture);
		expect(clip.gesture_clip).toBeTruthy();
	});

	it('answers from the trade when the provider chain is down', async () => {
		llmText.mockResolvedValue('not json at all');
		const clip = await directClip({ agentName: 'Crosshair', trade: WIN, surface: 'telegram' });
		expect(clip.source).toBe('deterministic');
		expect(clip.hook).toContain('$NIBZ');
		expect(isGrounded(clip, WIN)).toBe(true);
	});
});

describe('tradeFromPosition', () => {
	it('derives the multiple and hold time from real lamport columns', () => {
		const t = tradeFromPosition({
			mint: 'Mint111', symbol: 'NIBZ',
			entry_quote_lamports: 170_000_000, exit_quote_lamports: 320_000_000,
			realized_pnl_lamports: 150_000_000, realized_pnl_pct: 88.24,
			opened_at: '2026-08-01T00:00:00Z', closed_at: '2026-08-01T00:14:00Z',
			exit_reason: 'take_profit',
		});
		expect(t.multiple).toBe(1.88);
		expect(t.hold_min).toBe(14);
		expect(t.realized_pnl_sol).toBe(0.15);
		expect(t.is_win).toBe(true);
	});
});
