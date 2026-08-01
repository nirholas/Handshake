import { describe, it, expect } from 'vitest';
import {
	buildDescription,
	buildShareText,
	buildTitle,
	exitReasonLabel,
	headlineFor,
	heldSeconds,
	returnMultiple,
	shapeTradeCard,
	solscanToken,
	solscanTx,
	toneFor,
} from '../api/_lib/trade-card.js';

/** A realistic closed, live, profitable row. Tests override one field at a time. */
function row(over = {}) {
	return {
		id: '11111111-2222-3333-4444-555555555555',
		agent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		network: 'mainnet',
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		symbol: 'THREE',
		name: 'three.ws',
		status: 'closed',
		exit_reason: 'take_profit',
		entry_quote_lamports: '400000000',
		exit_quote_lamports: '1648000000',
		realized_pnl_lamports: '1248000000',
		realized_pnl_pct: 312,
		buy_sig: '5buysignature',
		sell_sig: '5sellsignature',
		moonbag_base_amount: '0',
		moonbag_last_value_lamports: '0',
		opened_at: '2026-08-01T10:00:00.000Z',
		closed_at: '2026-08-01T10:04:12.000Z',
		agent_name: 'ApedFox',
		agent_image: null,
		...over,
	};
}

describe('trade card numbers', () => {
	it('turns lamports into SOL and keeps the sign', () => {
		const c = shapeTradeCard(row());
		expect(c.entrySol).toBeCloseTo(0.4, 9);
		expect(c.exitSol).toBeCloseTo(1.648, 9);
		expect(c.pnlSol).toBeCloseTo(1.248, 9);
		expect(c.pnlSolStr.startsWith('+')).toBe(true);
	});

	it('leads with the percent and adds a multiple only past 2x', () => {
		expect(headlineFor(312)).toEqual({ primary: '+312%', secondary: '4.1x' });
		expect(headlineFor(45.2).secondary).toBe(null);
		expect(headlineFor(100).secondary).toBe('2.0x');
		expect(headlineFor(1900).secondary).toBe('20x');
	});

	it('computes the return multiple and floors a total loss at zero', () => {
		expect(returnMultiple(312)).toBeCloseTo(4.12, 9);
		expect(returnMultiple(-100)).toBe(0);
		expect(returnMultiple(-140)).toBe(0);
		expect(returnMultiple(null)).toBe(null);
	});

	it('reads the hold window from the two timestamps', () => {
		expect(heldSeconds('2026-08-01T10:00:00Z', '2026-08-01T10:04:12Z')).toBe(252);
		expect(shapeTradeCard(row()).holdLabel).toBe('4m');
	});

	it('refuses to invent a duration when a timestamp is missing or reversed', () => {
		expect(heldSeconds(null, '2026-08-01T10:04:12Z')).toBe(null);
		expect(heldSeconds('2026-08-01T10:04:12Z', '2026-08-01T10:00:00Z')).toBe(null);
		expect(shapeTradeCard(row({ closed_at: null })).holdLabel).toBe(null);
	});
});

describe('trade card honesty rules', () => {
	it('flags a paper fill from the simulate-mode sentinel', () => {
		const c = shapeTradeCard(row({ buy_sig: 'SIMULATED', sell_sig: 'SIMULATED' }));
		expect(c.paper).toBe(true);
		expect(c.buyUrl).toBe(null);
		expect(c.sellUrl).toBe(null);
		expect(c.title).toContain('(paper)');
		expect(c.description).toContain('Paper trade');
		expect(c.shareText).toContain('paper-traded');
	});

	it('treats a missing entry signature as paper, never as live', () => {
		expect(shapeTradeCard(row({ buy_sig: null })).paper).toBe(true);
		expect(shapeTradeCard(row({ buy_sig: '   ' })).paper).toBe(true);
		expect(shapeTradeCard(row()).paper).toBe(false);
	});

	it('renders a loss with the same shape as a win, only red', () => {
		const loss = shapeTradeCard(row({
			realized_pnl_pct: -38.4,
			realized_pnl_lamports: '-153600000',
			exit_quote_lamports: '246400000',
			exit_reason: 'stop_loss',
		}));
		expect(loss.tone).toBe('loss');
		expect(loss.accent).toBe('#f87171');
		expect(loss.headline).toContain('38.4%');
		expect(loss.exitLabel).toBe('Stop-loss');
		expect(loss.description).toContain('stop-loss');
	});

	it('says a moon-bag exit is not a full exit', () => {
		const c = shapeTradeCard(row({
			moonbag_base_amount: '90000000000',
			moonbag_last_value_lamports: '210000000',
		}));
		expect(c.moonbag).toBe(true);
		expect(c.moonbagSol).toBeCloseTo(0.21, 9);
		expect(c.description).toContain('moon-bag still riding');
	});

	it('never promises a return in the share text', () => {
		const text = shapeTradeCard(row()).shareText.toLowerCase();
		for (const banned of ['guarantee', 'will pump', 'financial advice', 'buy now', 'next 100x']) {
			expect(text).not.toContain(banned);
		}
		expect(text).toContain('on-chain, verifiable');
	});
});

describe('trade card links', () => {
	it('builds mainnet and devnet solscan links, and none for a paper leg', () => {
		expect(solscanTx('5sig', 'mainnet')).toBe('https://solscan.io/tx/5sig');
		expect(solscanTx('5sig', 'devnet')).toBe('https://solscan.io/tx/5sig?cluster=devnet');
		expect(solscanTx('SIMULATED', 'mainnet')).toBe(null);
		expect(solscanTx(null, 'mainnet')).toBe(null);
		expect(solscanToken('Mint111', 'mainnet')).toBe('https://solscan.io/token/Mint111');
	});

	it('points share, image and agent links at the given origin', () => {
		const c = shapeTradeCard(row(), { origin: 'https://three.ws' });
		expect(c.shareUrl).toBe('https://three.ws/trade/11111111-2222-3333-4444-555555555555');
		expect(c.ogImageUrl).toBe('https://three.ws/api/trade-og?id=11111111-2222-3333-4444-555555555555');
		expect(c.agentUrl).toBe('https://three.ws/trader/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
	});

	it('falls back to devnet links only when the row says devnet', () => {
		expect(shapeTradeCard(row({ network: 'devnet' })).buyUrl).toContain('cluster=devnet');
		expect(shapeTradeCard(row({ network: 'anything-else' })).network).toBe('mainnet');
	});
});

describe('trade card copy', () => {
	it('names the agent, the coin and the outcome in the title', () => {
		expect(buildTitle(shapeTradeCard(row()))).toBe('ApedFox +312% on $THREE · three.ws Arena');
	});

	it('strips a leading $ from the symbol so the card never prints $$', () => {
		expect(shapeTradeCard(row({ symbol: '$THREE' })).symbol).toBe('THREE');
	});

	it('falls back to the coin name, then a neutral word, for a symbol-less row', () => {
		expect(shapeTradeCard(row({ symbol: null })).symbol).toBe('three.ws');
		expect(shapeTradeCard(row({ symbol: null, name: null })).symbol).toBe('coin');
	});

	it('describes every exit reason the engine can write', () => {
		expect(exitReasonLabel('trailing_stop')).toBe('Trailing stop');
		expect(exitReasonLabel('timeout')).toBe('Max hold reached');
		expect(exitReasonLabel('graduated')).toBe('Graduated to AMM');
		expect(exitReasonLabel(null)).toBe('Closed');
		expect(exitReasonLabel('some_new_reason')).toBe('some new reason');
	});

	it('degrades to a neutral card when the P&L is unknown', () => {
		const c = shapeTradeCard(row({ realized_pnl_pct: null, realized_pnl_lamports: null }));
		expect(toneFor(null)).toBe('flat');
		expect(c.headline).toBe('CLOSED');
		expect(c.multipleLabel).toBe(null);
		expect(c.pnlSolStr).toBe(null);
		expect(buildTitle(c)).toContain('Closed on $THREE');
		expect(buildDescription(c)).not.toContain('realized');
		expect(buildShareText(c)).toContain('closed');
	});

	it('treats a flat trade as neither a win nor a loss', () => {
		expect(toneFor(0)).toBe('flat');
		expect(toneFor(0.01)).toBe('flat');
		expect(toneFor(0.2)).toBe('win');
		expect(shapeTradeCard(row({ realized_pnl_pct: 0 })).win).toBe(false);
	});

	it('survives a nameless agent without printing an empty headline', () => {
		expect(shapeTradeCard(row({ agent_name: '  ' })).agentName).toBe('Agent');
		expect(shapeTradeCard(row({ agent_name: null })).agentName).toBe('Agent');
	});
});
