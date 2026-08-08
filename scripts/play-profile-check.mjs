// Exercises the /play lobby + the in-world profile card in a real browser.
// The multiplayer server isn't running here, so we drive the inspector
// directly with the same subject shape CoinCommunities._inspectRemote builds
// from a peer's synced schema, and stub the profile/follow endpoints the card
// reads so the render path is the real one.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3002';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Real endpoints the card calls, answered with realistic shapes.
await page.route('**/api/users/nirholas', (route) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({
			user: {
				id: 'u-1',
				username: 'nirholas',
				display_name: 'Nick',
				bio: 'Building three.ws.',
				location: 'Lisbon',
				created_at: '2026-01-05T00:00:00Z',
				avatar_url: null,
			},
			stats: { creations: 12, coins: 2 },
			creations: [
				{ id: 'c1', type: 'model', title: 'Bronze sword', viewerUrl: '/viewer?src=sword', createdAt: '2026-07-01T00:00:00Z' },
				{ id: 'c2', type: 'world', title: 'Cliff village', viewerUrl: '/diorama?id=c2', createdAt: '2026-06-20T00:00:00Z' },
			],
		}),
	}),
);
await page.route('**/api/users/nirholas/follow', (route) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ following: false, followed_by: true, followers_count: 128, following_count: 42 }),
	}),
);
await page.route('**/api/friends', (route) =>
	route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { friends: [], incoming: [], outgoing: [] } }) }),
);
await page.route('**/api/csrf-token', (route) =>
	route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { token: 't' } }) }),
);

await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#cc-lobby', { timeout: 30_000 });
const lobbyOk = await page.isVisible('#cc-lobby .cc-name-input');

// Open the inspector exactly as a nameplate click does, with a verified handle.
await page.evaluate(async () => {
	localStorage.setItem('3dagent:auth-hint', JSON.stringify({ authed: true }));
	const mod = await import('/src/shared/avatar-inspector.js');
	mod.openAvatarInspector({ kind: 'peer', name: 'Nick', world: 'play', username: 'nirholas' });
});
await page.waitForSelector('[data-avi="profile"] .avi-creation', { timeout: 15_000 });

const card = await page.evaluate(() => {
	const root = document.querySelector('.avi-root');
	const prof = root.querySelector('[data-avi="profile"]');
	return {
		handle: root.querySelector('.avi-subname')?.textContent,
		bio: prof.querySelector('.avi-bio')?.textContent,
		counts: [...prof.querySelectorAll('.avi-profile-counts span')].map((s) => s.textContent.trim()),
		actions: [...prof.querySelectorAll('.avi-profile-actions button')].map((b) => b.textContent),
		creations: [...prof.querySelectorAll('.avi-creation')].map((a) => a.querySelector('.avi-creation-title')?.textContent),
		more: prof.querySelector('.avi-more')?.textContent?.trim(),
		footer: [...root.querySelectorAll('.avi-foot a')].map((a) => a.getAttribute('href')),
	};
});

// Guests must get no profile section at all.
await page.evaluate(async () => {
	const mod = await import('/src/shared/avatar-inspector.js');
	mod.closeAvatarInspector();
	mod.openAvatarInspector({ kind: 'peer', name: 'guest-ab12', world: 'play' });
});
await page.waitForTimeout(500);
const guestHasProfile = await page.evaluate(() => !!document.querySelector('[data-avi="profile"]'));

console.log(JSON.stringify({ lobbyOk, card, guestHasProfile, errors }, null, 2));
await browser.close();
