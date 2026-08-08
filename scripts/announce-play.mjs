// Broadcast a live-event announcement to everyone currently inside /play.
//
// Sends a signed POST to the multiplayer server's /internal/announce webhook,
// which relays it to every live walk_world room (optionally one coin's world)
// over the existing 'notice' channel: every client shows it as a toast, and
// clients that know the banner form show title/detail as a centre-screen card.
//
//   node scripts/announce-play.mjs "Totem showdown starts in 2 minutes!"
//   node scripts/announce-play.mjs --title "🎡 Wheel hour" --detail "Free spin at the plaza wheel" "Head to Fortune's Folly!"
//   node scripts/announce-play.mjs --coin <mint> "Only this world sees this"
//   node scripts/announce-play.mjs --server http://localhost:2567 "Local test"
//
// The signature uses MULTIPLAYER_SHARED_SECRET (falling back to
// HOLDER_PASS_SECRET, the same chain the server verifies with), read from the
// environment or .env. Keep byte-compatible with verifyAnnounceSignature in
// multiplayer/src/presence-token.js.

import crypto from 'node:crypto';
import fs from 'node:fs';

function loadDotEnv(path = '.env') {
	try {
		for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch { /* no .env, rely on the environment */ }
}
loadDotEnv();

const DEFAULT_SERVER = 'https://three-ws-multiplayer-93741856042.us-central1.run.app';

const args = process.argv.slice(2);
const opts = { server: DEFAULT_SERVER, title: '', detail: '', coin: '', durationMs: 0 };
const positional = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--server') opts.server = args[++i] || opts.server;
	else if (a === '--title') opts.title = args[++i] || '';
	else if (a === '--detail') opts.detail = args[++i] || '';
	else if (a === '--coin') opts.coin = args[++i] || '';
	else if (a === '--duration-ms') opts.durationMs = Number(args[++i]) || 0;
	else positional.push(a);
}
const text = positional.join(' ').trim();
if (!text) {
	console.error('Usage: node scripts/announce-play.mjs [--title t] [--detail d] [--coin mint] [--server url] "message"');
	process.exit(1);
}

const secret = process.env.MULTIPLAYER_SHARED_SECRET || process.env.HOLDER_PASS_SECRET;
if (!secret) {
	console.error('No MULTIPLAYER_SHARED_SECRET or HOLDER_PASS_SECRET in the environment or .env.');
	process.exit(1);
}

const body = {
	text,
	...(opts.title ? { title: opts.title } : {}),
	...(opts.detail ? { detail: opts.detail } : {}),
	...(opts.coin ? { coin: opts.coin } : {}),
	...(opts.durationMs > 0 ? { durationMs: opts.durationMs } : {}),
};
const ts = Math.floor(Date.now() / 1000);
const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64url');
const sig = crypto.createHmac('sha256', secret).update(`announce:${ts}:${payloadHash}`).digest('base64url');

const resp = await fetch(`${opts.server.replace(/\/$/, '')}/internal/announce`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		'x-announce-timestamp': String(ts),
		'x-announce-signature': sig,
	},
	body: JSON.stringify(body),
});
const result = await resp.json().catch(() => ({}));
if (!resp.ok) {
	console.error(`Announce failed: HTTP ${resp.status}`, result);
	process.exit(1);
}
console.log(`Delivered to ${result.rooms} room(s), ${result.players} player(s).`);
