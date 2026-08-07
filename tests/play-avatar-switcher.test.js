// @vitest-environment jsdom
//
// In-world avatar switcher (/play). The lobby's avatar bar is unreachable once
// a world opens, so avatar-switcher.js puts saved avatars, quick picks and the
// bring-your-own tools in a HUD drawer. These tests pin the panel's data states
// (signed-out, empty, populated, fetch failure) and the pick contract with the
// scene: every chosen value flows through onPick, an ok result marks the chip
// active, a load failure reports the avatar unchanged, and a pick in flight
// blocks a second one instead of firing two rig rebuilds.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AvatarSwitcher } from '../src/game/avatar-switcher.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function jsonResponse(status, body) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Route the two list fetches the panel makes; anything unrouted fails loudly.
function mockFetch(routes) {
	return vi.fn(async (url) => {
		for (const [prefix, resp] of Object.entries(routes)) {
			if (String(url).startsWith(prefix)) return typeof resp === 'function' ? resp() : resp;
		}
		throw new Error(`unrouted fetch: ${url}`);
	});
}

describe('AvatarSwitcher (/play in-world avatar change)', () => {
	let host;

	beforeEach(() => {
		host = document.createElement('div');
		document.body.appendChild(host);
	});

	afterEach(() => {
		host.remove();
		vi.unstubAllGlobals();
	});

	function make(h = {}, routes = {}) {
		vi.stubGlobal('fetch', mockFetch({
			'/api/avatars/mine': jsonResponse(200, { avatars: [] }),
			'/api/explore': jsonResponse(200, { items: [] }),
			...routes,
		}));
		const sw = new AvatarSwitcher(host, { current: () => '', ...h });
		sw.mount();
		return sw;
	}

	it('renders saved avatars and routes a chip click through onPick, marking it active on ok', async () => {
		const onPick = vi.fn(async () => ({ ok: true }));
		make({ onPick }, {
			'/api/avatars/mine': jsonResponse(200, {
				avatars: [
					{ id: 'av-1', name: 'Knight', thumb_url: '/api/avatars/av-1/thumb' },
					{ id: 'av-2', name: 'Astronaut', thumb_url: '/api/avatars/av-2/thumb' },
				],
			}),
		});
		await flush();

		const chips = [...host.querySelectorAll('.cc-avsw-chip')].filter((c) => c.dataset.value);
		const knight = chips.find((c) => c.dataset.value === 'av-1');
		expect(knight).toBeTruthy();
		expect(knight.textContent).toContain('Knight');

		knight.click();
		await flush();
		expect(onPick).toHaveBeenCalledWith('av-1', { label: 'Knight' });
		expect(knight.classList.contains('is-active')).toBe(true);
		const status = host.querySelector('.cc-avsw-status');
		expect(status.hidden).toBe(false);
		expect(status.getAttribute('data-state')).toBe('done');
	});

	it('keeps the current avatar and reports the failure when the scene cannot load the pick', async () => {
		const onPick = vi.fn(async () => ({ ok: false, reason: 'load-failed' }));
		make({ onPick }, {
			'/api/avatars/mine': jsonResponse(200, { avatars: [{ id: 'av-9', name: 'Broken', thumb_url: '/t' }] }),
		});
		await flush();

		const chip = host.querySelector('.cc-avsw-chip[data-value="av-9"]');
		chip.click();
		await flush();
		expect(chip.classList.contains('is-active')).toBe(false);
		const status = host.querySelector('.cc-avsw-status');
		expect(status.getAttribute('data-state')).toBe('error');
		expect(status.textContent).toContain('unchanged');
	});

	it('shows a sign-in path when the saved-avatars API says unauthorized', async () => {
		make({}, { '/api/avatars/mine': jsonResponse(401, { error: 'unauthorized' }) });
		await flush();

		const link = host.querySelector('.cc-avsw-note a');
		expect(link).toBeTruthy();
		expect(link.getAttribute('href')).toBe('/login?next=/play');
	});

	it('shows a create path when the account has no saved avatars yet', async () => {
		make({}, { '/api/avatars/mine': jsonResponse(200, { avatars: [] }) });
		await flush();

		const note = host.querySelector('.cc-avsw-note');
		expect(note.textContent).toContain('No saved avatars yet');
		expect(note.querySelector('a[href="/create"]')).toBeTruthy();
	});

	it('offers a retry when the saved-avatars fetch fails outright', async () => {
		let calls = 0;
		make({}, {
			'/api/avatars/mine': () => {
				calls++;
				if (calls === 1) return jsonResponse(500, {});
				return jsonResponse(200, { avatars: [{ id: 'av-3', name: 'Back', thumb_url: '/t' }] });
			},
		});
		await flush();

		const retry = host.querySelector('.cc-avsw-retry');
		expect(retry).toBeTruthy();
		retry.click();
		await flush();
		expect(host.querySelector('.cc-avsw-chip[data-value="av-3"]')).toBeTruthy();
	});

	it('always offers the default avatar and adds community quick picks from explore', async () => {
		make({}, {
			'/api/explore': jsonResponse(200, {
				items: [
					{ name: 'Community One', glbUrl: 'https://three.ws/m/one.glb', image: '/img/one.png' },
					{ name: 'No model, skipped', image: '/img/two.png' },
				],
			}),
		});
		await flush();

		const values = [...host.querySelectorAll('.cc-avsw-chip')].map((c) => c.dataset.value);
		expect(values).toContain('/avatars/default.glb');
		expect(values).toContain('https://three.ws/m/one.glb');
		expect(values.filter(Boolean)).toHaveLength(2); // default + one explore pick; nothing for the model-less item
	});

	it('sends a pasted URL through onPick and rejects an empty paste with guidance', async () => {
		const onPick = vi.fn(async () => ({ ok: true }));
		make({ onPick });
		await flush();

		const input = host.querySelector('.cc-avsw-paste-input');
		const wear = [...host.querySelectorAll('.cc-avsw-btn')].find((b) => b.textContent.includes('Wear it'));

		wear.click();
		await flush();
		expect(onPick).not.toHaveBeenCalled();
		expect(host.querySelector('.cc-avsw-status').getAttribute('data-state')).toBe('error');

		input.value = '  https://three.ws/avatars/hero.glb  ';
		wear.click();
		await flush();
		expect(onPick).toHaveBeenCalledWith('https://three.ws/avatars/hero.glb', { label: 'your pasted avatar' });
	});

	it('blocks a second pick while one is in flight so the rig never rebuilds twice at once', async () => {
		let resolveFirst;
		const onPick = vi.fn(() => new Promise((r) => { resolveFirst = r; }));
		make({ onPick }, {
			'/api/avatars/mine': jsonResponse(200, {
				avatars: [
					{ id: 'av-1', name: 'One', thumb_url: '/t1' },
					{ id: 'av-2', name: 'Two', thumb_url: '/t2' },
				],
			}),
		});
		await flush();

		host.querySelector('.cc-avsw-chip[data-value="av-1"]').click();
		host.querySelector('.cc-avsw-chip[data-value="av-2"]').click();
		expect(onPick).toHaveBeenCalledTimes(1);

		resolveFirst({ ok: true });
		await flush();
		host.querySelector('.cc-avsw-chip[data-value="av-2"]').click();
		expect(onPick).toHaveBeenCalledTimes(2);
	});
});
