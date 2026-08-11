// @vitest-environment jsdom
//
// The token-plan panel on the agent profile (src/agent-token-plan.js).
//
// The property under test is the one the panel exists to guarantee: a visitor
// sees the agent's coin as configured, an owner sees the designer plus the free
// rehearsal, and neither ever sees a claim that money moved. A regression here
// would either leak an owner's unfinished ticker onto a public profile or draw a
// coin that does not exist as though it launched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountAgentTokenPlan, planSummaryHTML, verdictHTML } from '../src/agent-token-plan.js';

const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const PLACEHOLDER_MINT = 'THREEsynthetic1111111111111111111111111111';

const readyPlan = {
	id: 'p1', agent_id: AGENT_ID, network: 'mainnet', name: 'Ada Ledger', symbol: 'ADA',
	description: 'The ledger of a working agent', image_url: null, website: null,
	coin_type: 'agent', quote_currency: 'sol', buyback_bps: 2500, sol_buy_in: 0.5,
	usdc_buy_in: 0, status: 'ready', mint: null, last_dry_run: null,
	readiness: { ready: true, blockers: [], warnings: [] },
	cost_estimate: { total_sol: 0.0191, dev_buy_usdc: 0 },
};

let handle = null;

function mount(response, opts = {}) {
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => response,
	}));
	document.body.innerHTML = '<div id="host"></div>';
	handle = mountAgentTokenPlan(document.getElementById('host'), { agentId: AGENT_ID, ...opts });
	// One microtask turn for the load fetch to resolve and render.
	return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	handle?.destroy();
	handle = null;
	vi.restoreAllMocks();
});

describe('planSummaryHTML', () => {
	it('draws the ticker, name and mechanics of an unlaunched plan', () => {
		const html = planSummaryHTML(readyPlan);
		expect(html).toContain('$ADA');
		expect(html).toContain('Ada Ledger');
		expect(html).toContain('Ready to launch');
		expect(html).toContain('25%');
	});

	it('escapes a hostile coin name instead of rendering it as markup', () => {
		const html = planSummaryHTML({ ...readyPlan, name: '<img src=x onerror=alert(1)>' });
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});

	it('links a launched plan to the coin it became', () => {
		const html = planSummaryHTML({ ...readyPlan, status: 'launched', mint: PLACEHOLDER_MINT });
		expect(html).toContain('Launched');
		expect(html).toContain(`/launches/${PLACEHOLDER_MINT}`);
	});

	it('reports a USDC-paired dev buy in USDC, not SOL', () => {
		const html = planSummaryHTML({ ...readyPlan, quote_currency: 'usdc', sol_buy_in: 0, usdc_buy_in: 100 });
		expect(html).toContain('100 USDC');
		expect(html).toContain('USDC</b>');
	});
});

describe('verdictHTML', () => {
	it('says plainly that a passing rehearsal broadcast nothing', () => {
		const html = verdictHTML({ verdict: 'would_succeed', tx_bytes: 900, simulation: { units_consumed: 120000, logs: [] } });
		expect(html).toContain('Rehearsal passed');
		expect(html).toMatch(/Nothing was broadcast/i);
		expect(html).toContain('900 bytes');
	});

	it('separates an unfunded wallet from a broken plan', () => {
		const html = verdictHTML({ verdict: 'funding_required', tx_bytes: 900, simulation: { logs: [] } });
		expect(html).toContain('wallet unfunded');
		expect(html).toContain('atp-verdict warn');
	});

	it('renders a compile failure as an error with its reason', () => {
		const html = verdictHTML({
			verdict: 'compile_failed',
			compile_error: 'transaction exceeds Solana packet limits',
			simulation: null,
		});
		expect(html).toContain('atp-verdict err');
		expect(html).toContain('exceeds Solana packet limits');
	});

	it('renders nothing for an unknown verdict rather than an empty box', () => {
		expect(verdictHTML({ verdict: 'something-new' })).toBe('');
		expect(verdictHTML(null)).toBe('');
	});
});

describe('mounted panel', () => {
	it('shows a visitor the plan without any editing controls', async () => {
		await mount({ agent_id: AGENT_ID, is_owner: false, launch_wallet: null, plan: readyPlan });
		const host = document.getElementById('host');
		expect(host.textContent).toContain('$ADA');
		expect(host.querySelector('form')).toBeNull();
		expect(host.querySelector('[data-act="dry-run"]')).toBeNull();
		expect(host.textContent).toMatch(/has not launched yet/i);
	});

	it('leaves nothing behind for a visitor when the agent has no plan', async () => {
		await mount({ agent_id: AGENT_ID, is_owner: false, plan: null });
		expect(document.getElementById('host').textContent.trim()).toBe('');
	});

	it('gives the owner the designer and the rehearsal button', async () => {
		await mount({ agent_id: AGENT_ID, is_owner: true, launch_wallet: 'wallet', plan: readyPlan }, { isOwner: true });
		const host = document.getElementById('host');
		expect(host.querySelector('form')).toBeTruthy();
		expect(host.querySelector('[data-act="save"]')).toBeTruthy();
		expect(host.querySelector('[data-act="dry-run"]')).toBeTruthy();
		expect(host.querySelector('input[name="symbol"]').value).toBe('ADA');
		expect(host.textContent).toMatch(/mints nothing/i);
	});

	it('offers the owner an empty-state designer when no plan exists yet', async () => {
		await mount({ agent_id: AGENT_ID, is_owner: true, plan: null }, { isOwner: true });
		const host = document.getElementById('host');
		expect(host.textContent).toMatch(/no coin yet/i);
		expect(host.querySelector('form')).toBeTruthy();
	});

	it('drops the editor once the plan has launched', async () => {
		await mount(
			{ agent_id: AGENT_ID, is_owner: true, plan: { ...readyPlan, status: 'launched', mint: PLACEHOLDER_MINT } },
			{ isOwner: true },
		);
		const host = document.getElementById('host');
		expect(host.querySelector('form')).toBeNull();
		expect(host.textContent).toContain('Launched');
	});

	it('reveals the card only when there is something to reveal', async () => {
		const onReveal = vi.fn();
		await mount({ agent_id: AGENT_ID, is_owner: false, plan: null }, { onReveal });
		expect(onReveal).not.toHaveBeenCalled();

		await mount({ agent_id: AGENT_ID, is_owner: false, plan: readyPlan }, { onReveal });
		expect(onReveal).toHaveBeenCalled();
	});

	it('gives the owner a retry path when the plan request fails', async () => {
		global.fetch = vi.fn(async () => { throw new Error('offline'); });
		document.body.innerHTML = '<div id="host"></div>';
		handle = mountAgentTokenPlan(document.getElementById('host'), { agentId: AGENT_ID, isOwner: true });
		await new Promise((r) => setTimeout(r, 0));
		const host = document.getElementById('host');
		expect(host.textContent).toMatch(/Could not load/i);
		expect(host.querySelector('[data-act="retry"]')).toBeTruthy();
	});
});
