#!/usr/bin/env node
// Announce a build result from a script, a GitHub Action step, or a cron.
//
//   THREE_WS_API_KEY=sk_live_... node ci-notify.mjs "Nightly build" 0
//
// Exit code 0 announces a pass, anything else announces a failure at an
// importance high enough to cut through quiet hours. The CLI shipped with this
// package does the same thing with more options: `herald watch -- npm test`.

const [, , label = 'Build', rawCode = '0'] = process.argv;
const code = Number(rawCode);
const ok = code === 0;

const key = process.env.THREE_WS_API_KEY;
if (!key) {
	console.error('set THREE_WS_API_KEY (herald:announce scope) first');
	process.exit(2);
}

const res = await fetch(`${process.env.THREE_WS_ORIGIN || 'https://three.ws'}/api/herald/announce`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
	body: JSON.stringify({
		text: ok ? `${label} passed` : `${label} failed (exit ${code})`,
		from: 'CI',
		importance: ok ? 60 : 95,
		tone: ok ? 'celebrate' : 'error',
		url: process.env.BUILD_URL,
		key: `ci:${label}`,
	}),
});

if (!res.ok) {
	console.error(`herald rail returned ${res.status}`);
	process.exit(1);
}
console.log(ok ? 'announced: passed' : 'announced: failed');
