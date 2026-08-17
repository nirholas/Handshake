// @vitest-environment jsdom
//
// DOM-level test for the create-agent wizard's avatar-quota error handling.
// Loads the real page markup from pages/create-agent.html, drives the wizard
// to submit with "Add later" selected (which still copies the default starter
// into the user's library), and asserts that a 402 plan_limit_count from
// account.js#saveRemoteGlbToAccount renders the recovery message — connect an
// owned avatar / free up a slot / upgrade — instead of the raw server text.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const planLimitErr = Object.assign(new Error('avatar count limit reached on plan free'), {
	status: 402,
	data: {
		error: 'plan_limit_count',
		error_description: 'avatar count limit reached on plan free',
	},
});

const saveRemoteGlbToAccount = vi.fn().mockRejectedValue(planLimitErr);
const apiFetch = vi.fn(async () => ({
	ok: true,
	headers: { get: () => 'application/json' },
	json: async () => ({ avatars: [] }),
}));

// noteSession is a module-local session flag setter with no observable effect
// on this suite, but create-agent.js calls it during boot, so the mock has to
// export it or boot rejects before the first assertion runs.
vi.mock('../src/api.js', () => ({
	apiFetch: (...a) => apiFetch(...a),
	noteSession: () => {},
}));
vi.mock('../src/account.js', () => ({
	getMe: vi.fn(async () => ({ id: 'u1', plan: 'free' })),
	saveRemoteGlbToAccount: (...a) => saveRemoteGlbToAccount(...a),
}));
vi.mock('../src/analytics.js', () => ({
	track: () => {},
	trackFunnelStep: () => {},
	trackError: () => {},
	identifyUser: () => {},
	ANALYTICS_EVENTS: new Proxy({}, { get: (_, k) => String(k) }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = (elm) => elm.dispatchEvent(new MouseEvent('click', { bubbles: true }));

function activePanelStep() {
	return document.querySelector('.panel.is-active')?.dataset.step;
}

beforeAll(async () => {
	const html = readFileSync(
		path.resolve(__dirname, '../pages/create-agent.html'),
		'utf8',
	);
	document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
	Element.prototype.scrollIntoView ||= () => {};
	globalThis.requestAnimationFrame ||= (cb) => setTimeout(cb, 0);

	await import('../src/create-agent.js');
	await flush(); // boot(): auth probe resolves, wizard shows step 0
});

describe('create-agent wizard — avatar quota exceeded', () => {
	it('walks to review and shows recovery paths on plan_limit_count', async () => {
		// Step 0: name.
		const name = document.getElementById('f-name');
		name.value = 'Quota Test';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		click(document.getElementById('btn-next'));
		expect(activePanelStep()).toBe('1');

		// Step 1: "Add later" + acknowledgment.
		click(document.querySelector('.model-tab[data-pane="skip"]'));
		const ack = document.getElementById('f-skip-ack');
		ack.checked = true;
		ack.dispatchEvent(new Event('change', { bubbles: true }));
		click(document.getElementById('btn-next'));
		expect(activePanelStep()).toBe('2');

		// Steps 2–3 have no hard gates.
		click(document.getElementById('btn-next'));
		click(document.getElementById('btn-next'));
		expect(activePanelStep()).toBe('4');

		// Submit — the default-starter copy rejects with 402 plan_limit_count.
		document
			.getElementById('wizard')
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await flush();
		await flush();

		expect(saveRemoteGlbToAccount).toHaveBeenCalled();
		const msg = document.getElementById('foot-msg');
		expect(msg.className).toContain('err');
		// Not the raw server message — the designed recovery state.
		expect(msg.textContent).not.toContain('avatar count limit reached on plan free');
		expect(msg.textContent).toContain('avatar library is full');
		expect(msg.querySelector('a[href="/dashboard/avatars"]')).toBeTruthy();
		expect(msg.querySelector('a[href="/dashboard/monetize"]')).toBeTruthy();
		expect(msg.querySelector('#msg-use-library')).toBeTruthy();

		// The submit button is re-enabled for another attempt.
		expect(document.getElementById('btn-create').disabled).toBe(false);
	});

	it('"connect an avatar you already own" jumps to the library tab', async () => {
		click(document.getElementById('msg-use-library'));
		await flush();

		expect(activePanelStep()).toBe('1');
		const libTab = document.querySelector('.model-tab[data-pane="library"]');
		expect(libTab.classList.contains('is-active')).toBe(true);
		expect(
			document
				.querySelector('.model-pane[data-pane="library"]')
				.classList.contains('is-active'),
		).toBe(true);
		// The owned-avatar library actually loaded (real fetch path, no dead tab).
		expect(apiFetch.mock.calls.some(([url]) => String(url).includes('/api/avatars'))).toBe(
			true,
		);
	});
});
