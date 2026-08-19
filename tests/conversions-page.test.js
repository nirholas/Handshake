// @vitest-environment jsdom
//
// /conversions renders both sides of a metered trial running out, and every
// defect pinned here was visible on the live page: a row invented a denominator
// ("1 of 1 free runs left") for a trial whose grant the server never reported,
// a missing timestamp printed a dangling "started" with nothing after it, the
// seller strip said "1 trials running", the Buy CTA dropped the buyer at the top
// of an agent selling a dozen skills, and a seller pricing in two currencies saw
// only the larger pile with no hint the other existed.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const OTHER = 'THREEsynthetic1111111111111111111111111116dp';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mount() {
	document.body.innerHTML = `
		<div class="role-switch" role="tablist">
			<button class="role-tab" role="tab" id="tab-buyer" aria-selected="true" data-role="buyer">Trials I hold</button>
			<button class="role-tab" role="tab" id="tab-seller" aria-selected="false" data-role="seller" tabindex="-1">Trials on my skills</button>
		</div>
		<div class="stats-grid" id="cv-stats"></div>
		<div id="cv-panel" role="tabpanel" aria-busy="true"><div class="cv-list" id="cv-list"></div></div>`;
}

/** Serve one payload per role, the way the endpoint does. */
function serve(byRole) {
	globalThis.fetch = vi.fn(async (url) => {
		const role = new URL(url, 'http://localhost').searchParams.get('role') || 'buyer';
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: byRole[role] ?? { role, trials: [], queue: [], summary: {} } }),
		};
	});
}

/** Import the page module fresh so its per-role cache never leaks between tests. */
async function render(byRole) {
	mount();
	serve(byRole);
	vi.resetModules();
	const mod = await import('../src/conversions.js');
	await vi.waitFor(() => {
		expect(document.getElementById('cv-panel').getAttribute('aria-busy')).toBe('false');
	});
	return mod;
}

const trial = (over = {}) => ({
	purchaseId: 'p1',
	agentId: AGENT,
	agentName: 'Ink',
	skill: 'icon-set',
	trialRemaining: 1,
	trialUses: 3,
	state: 'running-low',
	price: { atomic: '2000000', decimals: 6, display: '2', mint: THREE, chain: 'solana' },
	startedAt: '2026-08-01T00:00:00.000Z',
	lastUsedAt: null,
	agentUrl: `/agents/${AGENT}`,
	...over,
});

const buyerPayload = (trials, over = {}) => ({
	role: 'buyer',
	trials,
	total: trials.length,
	truncated: false,
	summary: { active: trials.length, fresh: 0, runningLow: trials.length, exhausted: 0 },
	...over,
});

const queueRow = (over = {}) => ({
	agentId: AGENT,
	agentName: 'Ink',
	agentUrl: `/agents/${AGENT}`,
	skill: 'icon-set',
	activeTrials: 1,
	exhausted: 0,
	lastRun: 1,
	sold: 0,
	conversionRate: 0,
	trialUses: 3,
	lastActivity: '2026-08-01T00:00:00.000Z',
	price: { atomic: '2000000', decimals: 6, display: '2', mint: THREE, chain: 'solana' },
	potential: { atomic: '0', display: '0', mint: THREE },
	pricingUrl: `/agents/${AGENT}/edit?tab=monetization`,
	...over,
});

const sellerPayload = (queue, summaryOver = {}) => ({
	role: 'seller',
	queue,
	summary: {
		skillsWithTrials: queue.length,
		activeTrials: 1,
		warmLeads: 0,
		lastRun: 1,
		sold: 0,
		potential: { mint: THREE, decimals: 6, atomic: '0', display: '0' },
		potentials: [{ mint: THREE, decimals: 6, atomic: '0', display: '0' }],
		...summaryOver,
	},
});

beforeEach(() => {
	window.history.replaceState({}, '', '/conversions');
});

afterEach(() => {
	delete globalThis.fetch;
});

describe('runs-left copy', () => {
	it('never invents a denominator the server did not report', async () => {
		const { runsLeftText } = await render({ buyer: buyerPayload([trial({ trialUses: null })]) });

		const meter = document.querySelector('.meter');
		const count = document.querySelector('.meter-count').textContent.trim();
		// The visible count and the meter's accessible name have to be one sentence,
		// or a screen reader and a sighted user are told different things.
		expect(count).toBe('1 free run left');
		expect(meter.getAttribute('aria-label')).toBe('1 free run left');
		expect(count).not.toContain('of');
		expect(runsLeftText(1, null)).toBe('1 free run left');
	});

	it('agrees with the grant when the grant is one run', async () => {
		await render({ buyer: buyerPayload([trial({ trialRemaining: 1, trialUses: 1 })]) });
		expect(document.querySelector('.meter-count').textContent.trim()).toBe('1 of 1 free run left');
		expect(document.querySelectorAll('.meter-pip')).toHaveLength(1);
	});

	it('pluralises a multi-run grant and fills one pip per run', async () => {
		await render({ buyer: buyerPayload([trial({ trialRemaining: 2, trialUses: 5 })]) });
		expect(document.querySelector('.meter-count').textContent.trim()).toBe('2 of 5 free runs left');
		expect(document.querySelectorAll('.meter-pip')).toHaveLength(5);
		expect(document.querySelectorAll('.meter-pip.is-left')).toHaveLength(2);
	});

	it('says the trial is spent, and marks the track, at zero runs', async () => {
		await render({
			buyer: buyerPayload([trial({ trialRemaining: 0, trialUses: 3, state: 'exhausted' })]),
		});
		expect(document.querySelector('.meter-count').textContent.trim()).toBe('Every free run spent');
		expect(document.querySelector('.meter.is-spent')).not.toBeNull();
		expect(document.querySelector('.pill').textContent.trim()).toBe('Trial spent');
	});
});

describe('missing timestamps', () => {
	it('drops the clause rather than printing a dangling "started"', async () => {
		await render({ buyer: buyerPayload([trial({ startedAt: null })]) });
		const line = document.querySelector('.cv-agent').textContent.trim();
		expect(line).toBe('from Ink');
		expect(line).not.toContain('started');
	});

	it('drops the seller clause when nothing has happened yet', async () => {
		window.history.replaceState({}, '', '/conversions?role=seller');
		await render({ seller: sellerPayload([queueRow({ lastActivity: null })]) });
		expect(document.querySelector('.cv-agent').textContent.trim()).toBe('on Ink');
	});
});

describe('buyer CTAs', () => {
	it('deep-links the Buy CTA at the skill whose trial ran out', async () => {
		await render({
			buyer: buyerPayload([trial({ skill: 'icon set', trialRemaining: 0, state: 'exhausted' })]),
		});
		const cta = document.querySelector('.cv-side a');
		expect(cta.textContent.trim()).toBe('Buy it');
		expect(cta.getAttribute('href')).toBe(`/agents/${AGENT}?skill=icon%20set#pricing`);
	});

	it('says how many trials the capped list is leaving out', async () => {
		await render({
			buyer: buyerPayload([trial()], { total: 412, truncated: true }),
		});
		expect(document.querySelector('.cv-truncated').textContent).toContain('of 412 you hold');
	});

	it('shows no truncation note when the list is whole', async () => {
		await render({ buyer: buyerPayload([trial()]) });
		expect(document.querySelector('.cv-truncated')).toBeNull();
	});
});

describe('seller queue', () => {
	it('counts one running trial in the singular', async () => {
		window.history.replaceState({}, '', '/conversions?role=seller');
		await render({ seller: sellerPayload([queueRow({ activeTrials: 1 })]) });
		expect(document.querySelector('.cv-metrics').textContent).toContain('1 trial running');
		expect(document.querySelector('.cv-metrics').textContent).not.toContain('1 trials running');
	});

	it('keeps the plural for every other count', async () => {
		window.history.replaceState({}, '', '/conversions?role=seller');
		await render({ seller: sellerPayload([queueRow({ activeTrials: 4 })]) });
		expect(document.querySelector('.cv-metrics').textContent).toContain('4 trials running');
	});

	it('sends "Edit pricing" to the monetization panel, not a 404', async () => {
		window.history.replaceState({}, '', '/conversions?role=seller');
		await render({ seller: sellerPayload([queueRow()]) });
		const edit = [...document.querySelectorAll('.cv-side a')].find((a) => a.textContent.includes('Edit pricing'));
		expect(edit.getAttribute('href')).toBe(`/agents/${AGENT}/edit?tab=monetization`);
	});

	it('names the queue currencies the headline number cannot hold', async () => {
		window.history.replaceState({}, '', '/conversions?role=seller');
		const { otherMintsNote } = await render({
			seller: sellerPayload([queueRow()], {
				potential: { mint: THREE, decimals: 6, atomic: '4000000', display: '4' },
				potentials: [
					{ mint: THREE, decimals: 6, atomic: '4000000', display: '4' },
					{ mint: OTHER, decimals: 6, atomic: '1000000', display: '1' },
				],
			}),
		});
		const note = document.querySelector('.stat-note').textContent.trim();
		expect(note).toContain('plus 1');
		expect(otherMintsNote([{ display: '4', mint: THREE }])).toBeNull();
	});
});

describe('failure states', () => {
	it('offers a working retry when the endpoint fails', async () => {
		mount();
		let call = 0;
		globalThis.fetch = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return {
					ok: false,
					status: 500,
					json: async () => ({ error_description: 'the database is unavailable' }),
				};
			}
			return { ok: true, status: 200, json: async () => ({ data: buyerPayload([trial()]) }) };
		});
		vi.resetModules();
		await import('../src/conversions.js');

		await vi.waitFor(() => expect(document.querySelector('.cv-state.is-error')).not.toBeNull());
		expect(document.querySelector('.cv-state.is-error').textContent).toContain('the database is unavailable');

		document.getElementById('cv-retry').click();
		await vi.waitFor(() => expect(document.querySelector('.cv-row')).not.toBeNull());
		expect(call).toBe(2);
	});

	it('asks an unauthenticated visitor to sign in and returns them here', async () => {
		mount();
		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
		vi.resetModules();
		await import('../src/conversions.js');

		await vi.waitFor(() => expect(document.querySelector('.cv-state')).not.toBeNull());
		const link = document.querySelector('.cv-state a');
		expect(link.textContent.trim()).toBe('Sign in');
		expect(link.getAttribute('href')).toContain('/login?next=%2Fconversions');
	});
});
