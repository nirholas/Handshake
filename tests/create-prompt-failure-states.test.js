// @vitest-environment jsdom
//
// Failure states on /create/prompt (src/create-prompt.js).
//
// This page spends a real GPU minute per attempt, so a failure state that
// offers the wrong recovery is expensive: "Try again" on a full library burns
// the same minute and lands on the same ceiling, and clicking through a
// Retry-After earns the same 429. Two rules follow, and these tests pin both:
//
//   · A refusal the user has to clear elsewhere (plan limit, unconfigured
//     deployment) shows NO retry button, and names where to go instead.
//   · A throttle quotes the server's Retry-After and holds the retry button,
//     counting it down in place.
//
// The fixture is the page's own markup, so an id this controller reads that
// stops existing in pages/create-prompt.html fails here rather than in a
// browser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(process.cwd(), 'pages/create-prompt.html'), 'utf8');
const BODY = PAGE.slice(PAGE.indexOf('<body>') + '<body>'.length, PAGE.indexOf('</body>'));

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Load the controller against a fresh copy of the page markup. */
async function mount(fetchImpl) {
	document.body.innerHTML = BODY.replace(/<script[\s\S]*?<\/script>/g, '');
	vi.stubGlobal('fetch', fetchImpl);
	vi.resetModules();
	await import('../src/create-prompt.js');
}

/** Type a prompt and press Generate, then let the submit settle. */
async function generate(text = 'A friendly robot mascot, rounded white shell') {
	const box = document.getElementById('prompt');
	box.value = text;
	box.dispatchEvent(new Event('input'));
	document.getElementById('generate-btn').click();
	await flush();
	await flush();
}

const jsonResponse = (status, body) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
});

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

describe('/create/prompt failure states', () => {
	it('sends a full library to the two places that clear it, and offers no retry', async () => {
		await mount(async () =>
			jsonResponse(402, {
				error: 'plan_limit',
				error_description: 'Your avatar library is full on this plan. Delete an avatar or upgrade to build another.',
			}),
		);
		await generate();

		const box = document.getElementById('build-error');
		expect(box.classList.contains('show')).toBe(true);
		expect(box.textContent).toContain('library is full');
		expect([...box.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
			'/dashboard',
			'/pricing',
		]);
		// Retrying the same prompt cannot clear a plan ceiling.
		expect(document.getElementById('build-retry-now')).toBeNull();
		expect(document.getElementById('build-edit')).not.toBeNull();
		// The screen must stop claiming work is still in flight.
		expect(document.querySelector('.build-wrap').classList.contains('errored')).toBe(true);
	});

	it('quotes the server Retry-After and holds the retry button for exactly that long', async () => {
		await mount(async () =>
			jsonResponse(429, { error: 'txt2img_rate_limited', error_description: 'busy', retry_after: 4 }),
		);
		await generate();

		const retry = document.getElementById('build-retry-now');
		expect(document.getElementById('build-error').textContent).toContain('wait 4 seconds');
		expect(retry.disabled).toBe(true);
		expect(retry.textContent).toBe('Try again in 4s');

		vi.advanceTimersByTime(2000);
		expect(retry.textContent).toBe('Try again in 2s');

		vi.advanceTimersByTime(2000);
		expect(retry.disabled).toBe(false);
		expect(retry.textContent).toBe('Try again');
	});

	it('names the connection when fetch itself fails, rather than shrugging', async () => {
		await mount(async () => {
			throw new TypeError('Failed to fetch');
		});
		await generate();

		expect(document.getElementById('build-error').textContent).toContain('Check your connection');
		// A network blip IS worth retrying, so the button stays.
		expect(document.getElementById('build-retry-now')).not.toBeNull();
	});

	it('offers the photo path when every avatar engine is busy', async () => {
		await mount(async () => jsonResponse(503, { error: 'regen_provider_error' }));
		await generate();

		const box = document.getElementById('build-error');
		expect(box.querySelector('a').getAttribute('href')).toBe('/create/selfie');
		expect(document.getElementById('build-retry-now')).not.toBeNull();
	});

	it('clears the failed look when the user goes back to edit the prompt', async () => {
		await mount(async () => jsonResponse(503, { error: 'regen_provider_error' }));
		await generate();

		document.getElementById('build-edit').click();
		await flush();

		expect(document.querySelector('.build-wrap').classList.contains('errored')).toBe(false);
		expect(document.getElementById('build-error').classList.contains('show')).toBe(false);
		expect(document.querySelector('.step.active').getAttribute('data-step')).toBe('compose');
		// The words the user typed survive the round trip.
		expect(document.getElementById('prompt').value).toContain('robot mascot');
	});

	it('bounces an anonymous user to sign-in with their prompt preserved', async () => {
		const assign = vi.fn();
		delete window.location;
		window.location = { assign, search: '', pathname: '/create/prompt' };
		await mount(async () => jsonResponse(401, { error: 'unauthorized' }));
		await generate('A medieval knight in battered steel plate');

		expect(assign).toHaveBeenCalledTimes(1);
		const next = decodeURIComponent(assign.mock.calls[0][0].split('next=')[1]);
		expect(next).toBe('/create/prompt?prompt=A%20medieval%20knight%20in%20battered%20steel%20plate');
	});
});
