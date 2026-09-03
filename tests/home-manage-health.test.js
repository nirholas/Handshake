// @vitest-environment jsdom
//
// What the owner of a house actually sees when it stops answering.
//
// The `home` subsystem in /api/healthz refuses, on purpose, to page anyone for a
// single dark house. That refusal is only defensible if the person whose house it
// is gets told instead, so this file renders the real manage view against the
// real payloads GET /api/home/:id/health returned from the live database on
// 2026-09-03 and asserts the sentences reach the screen.
//
// The payloads below are copied from that run rather than invented, so a change
// to the wire shape breaks this file instead of quietly emptying a panel.

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A house that has gone quiet. Captured from the live route. */
const STALE = {
	state: 'stale',
	fault: 'unknown',
	headline: 'Your home has gone quiet.',
	reason: 'It last answered at 2026-09-03T03:54:13.910Z. That is longer than we expect, and not yet long enough for us to call it offline.',
	advice: [
		'Nothing is broken yet. Everything below is the last state we saw.',
		'If it stays quiet, check that Home Assistant is still running.',
	],
	measured: true,
	windowMinutes: 1440,
	actions: { total: 4, ok: 3, refused: 1, failed: 0, lastFailedAt: null, timed: 4, p95LatencyMs: 412 },
	confirmations: { total: 2, redeemed: 1, expired: 1 },
	fleet: { othersFailing: 0, correlated: false },
};

/** The same house, during an outage that is ours. */
const OURS = {
	...STALE,
	state: 'unreachable',
	fault: 'us',
	headline: 'This one is us, not your home.',
	reason: '30 other homes stopped answering in the last 15 minutes, so this is a problem on our side rather than anything you changed.',
	advice: ['Nothing to do. Your token and your Home Assistant are untouched.'],
	fleet: { othersFailing: 30, correlated: true },
};

/** A token Home Assistant is refusing. */
const AUTH_FAILED = {
	...STALE,
	state: 'auth_failed',
	fault: 'your_home',
	headline: 'Home Assistant rejected our token.',
	reason: 'The stored access token could not be read. Reconnect this home to store a new one.',
	advice: ['In Home Assistant, open your profile, then Security, and create a new long-lived access token.'],
	actions: { total: 0, ok: 0, refused: 0, failed: 0, lastFailedAt: null, timed: 0, p95LatencyMs: null },
	confirmations: { total: 0, redeemed: 0, expired: 0 },
};

function home(overrides = {}) {
	return {
		id: '9a0eae2b-55f4-4580-902f-2a345f2e5ef2',
		label: 'Empty house',
		base_url: 'http://homeassistant.local:8123',
		status: 'connected',
		status_detail: null,
		capabilities: { areaCount: 4, entityCount: 31, macroCount: 2, haVersion: '2026.8.3' },
		// Older than the 90s staleness window, so the card already looks unhealthy
		// and the panel is expected to load without being opened.
		last_ok_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		last_error_at: null,
		revoked_at: null,
		role: 'owner',
		...overrides,
	};
}

let served = STALE;

beforeEach(() => {
	served = STALE;
	document.body.innerHTML = '<div id="hm-root"></div>';
	vi.stubGlobal('fetch', vi.fn(async (url) => {
		const path = String(url);
		if (path.includes('/health')) {
			return new Response(JSON.stringify({ home_id: home().id, health: served }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		// The view fetches its own home list on boot; everything else it asks for
		// is another panel that is not under test here.
		return new Response(JSON.stringify({ homes: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
	}));
});

/** Imported lazily: the module boots itself against `fetch` on first import. */
async function render(homes) {
	const { renderManage } = await import('../src/home/manage.js');
	const root = document.getElementById('hm-root');
	root.append(renderManage({ homes, onDisconnect() {}, onReconnect() {} }));
	// One microtask turn for the eager health fetch to settle.
	await new Promise((resolve) => setTimeout(resolve, 0));
	return root;
}

describe('a house that is not answering explains itself without being asked', () => {
	it('loads the reason on its own, because nobody should have to hunt for it', async () => {
		const root = await render([home()]);
		expect(root.textContent).toContain('Your home has gone quiet.');
		expect(root.textContent).toContain('That is longer than we expect');
	});

	it('carries the way out, not just the diagnosis', async () => {
		const root = await render([home()]);
		expect(root.textContent).toContain('check that Home Assistant is still running');
	});

	it('shows the measured numbers rather than a reassuring blank', async () => {
		const root = await render([home()]);
		const labels = [...root.querySelectorAll('.hm-stat-label')].map((n) => n.textContent);
		expect(labels).toContain('Actions done');
		expect(labels).toContain('Our response time');
		expect(root.textContent).toContain('412 ms');
	});

	it('says plainly when a confirmation timed out, because that action did not happen', async () => {
		const root = await render([home()]);
		expect(root.textContent).toContain('1 confirmation timed out');
	});
});

describe('whose fault it is changes what the user is told to do', () => {
	it('sends nobody to their router during our own outage', async () => {
		served = OURS;
		const root = await render([home({ status: 'unreachable' })]);
		expect(root.textContent).toContain('This one is us, not your home.');
		expect(root.textContent).toContain('Nothing to do.');
		// Painting a working house red during our outage would be a lie.
		expect(root.querySelector('.hm-notice-error')).toBeNull();
	});

	it('gives a rejected token its own fix, which is not "check your network"', async () => {
		served = AUTH_FAILED;
		const root = await render([home({ status: 'auth_failed' })]);
		expect(root.textContent).toContain('long-lived access token');
		expect(root.querySelector('.hm-notice-error')).not.toBeNull();
	});
});

describe('a healthy house', () => {
	it('does not spend a round trip on load', async () => {
		// Six working homes must not cost six health fetches nobody asked for.
		await render([home({ last_ok_at: new Date().toISOString() })]);
		const calls = fetch.mock.calls.map(([u]) => String(u));
		expect(calls.filter((u) => u.includes('/health'))).toHaveLength(0);
	});

	it('still offers the panel, so a curious user can open it', async () => {
		const root = await render([home({ last_ok_at: new Date().toISOString() })]);
		const titles = [...root.querySelectorAll('summary')].map((n) => n.textContent);
		expect(titles).toContain('How this home is doing');
	});
});
