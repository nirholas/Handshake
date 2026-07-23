// Quest-complete notification bridge — reports a finished /play mission or
// co-op heist to the API so it lands in the player's bell inbox, not just the
// anonymous site-wide ticker (publishFeedEvent in ./feed.js). Signs the same
// short-lived world-service token persistence.js uses for world saves
// (svc:'world'), verified server-side by api/_lib/world-service-auth.js —
// only this trusted game process can post a notification for an account.
//
// Best-effort and fire-and-forget: a flaky API must never block or crash the
// mission-complete flow, which already broadcasts to the players in real time.

import crypto from 'node:crypto';

const API_BASE = (process.env.WORLD_API_BASE || 'https://three.ws').replace(/\/$/, '');
const TOKEN_TTL_SEC = 120;

function secret() {
	return (
		process.env.MULTIPLAYER_SHARED_SECRET ||
		process.env.HOLDER_PASS_SECRET ||
		'dev-insecure-multiplayer-secret'
	);
}

// Mirrors persistence.js's signServiceToken byte-for-byte.
function signServiceToken() {
	const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
	const payload = Buffer.from(JSON.stringify({ svc: 'world', exp }), 'utf8').toString('base64url');
	const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
	return `${payload}.${sig}`;
}

// Report a finished quest for the given account id (the verified presence-
// ticket uid — NEVER the wallet/session account string). No-op if accountUid
// is missing (an unauthenticated player still plays, just doesn't get an inbox
// entry). Never throws.
export async function reportQuestComplete({ accountUid, mission, gold, coop, coin }) {
	if (!accountUid) return false;
	let bodyString;
	try {
		bodyString = JSON.stringify({ accountUid, mission, gold, coop, coin });
	} catch {
		return false;
	}
	try {
		const res = await fetch(`${API_BASE}/api/internal/quest-notify`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${signServiceToken()}`,
			},
			body: bodyString,
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) {
			console.warn(`[quest-notify] ${API_BASE}/api/internal/quest-notify → ${res.status}`);
			return false;
		}
		return true;
	} catch (err) {
		console.warn('[quest-notify] failed to report quest completion:', err?.message || err);
		return false;
	}
}
