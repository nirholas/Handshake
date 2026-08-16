// GET /api/agent-screen-stream?agentId=<uuid> — SSE stream of agent screen frames.
//
// Polls Redis for the latest frame pushed by the agent and emits it over SSE.
// No true pub/sub needed: the 500ms poll is fast enough for a live "watch them
// work" experience. Upstash REST doesn't hold LISTEN connections in serverless.
//
// Events:
//   event: open   — { agentId, agentName, ts }  emitted once on connect
//   event: frame  — { ts, data?, activity, type, agentId }  when a new frame arrives
//   event: log    — { entries: [{ts, activity, type}] }  activity history (Redis or DB)
//   event: dark   — {}  emitted when the agent's frame TTL expires (stream gone dark)
//   event: ping   — {}  keepalive every 15s
//
// Activity backfill order: a live caster's pushed log (Redis `agent:screen:*:log`)
// takes priority; when none exists the stream falls back to the agent's real
// `agent_actions` DB rows and re-polls them every ACTIVITY_REFRESH_MS. This is
// what lets EVERY agent show a meaningful, always-fresh screen 24/7 even when no
// Playwright caster is running — the zero-cost baseline behind the live wall.
//
// The stream runs for up to 280s (Vercel limit 300s — budget for setup/teardown).
// Clients reconnect automatically via EventSource's built-in retry.

import { cors, error, method, rateLimited, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';
import { reactionsRecentKey, reactionsTotalKey, REACTION_RECENT_CAP } from './_lib/reaction-rules.js';
import { rowToEntry } from './_lib/agent-activity.js';

export const maxDuration = 300;

const MAX_DURATION_MS = 280_000;
const PING_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 500;
const ACTIVITY_REFRESH_MS = 8_000; // re-poll DB activity for dark agents

// rowToEntry (agent_actions row → the `log` entry shape) is shared with the
// batched wall endpoint so the two can never render the same action differently.
// See api/_lib/agent-activity.js.

// Decode one record read back out of Redis. The Upstash REST client
// deserializes JSON responses by default, so a value written as a JSON string
// comes back as an ALREADY-PARSED object; running JSON.parse over that throws
// and the record is silently dropped. That is exactly what happened to every
// live caster's activity log and to every viewer reaction: the frame poll below
// handled both shapes, these two read paths did not, so the log arrived empty
// and reactions never fanned out. Returns null only for genuinely unusable data.
export function parseRedisRecord(value) {
	if (value && typeof value === 'object') return value;
	if (typeof value !== 'string') return null;
	try { return JSON.parse(value); } catch { return null; }
}

// Fetch the agent's most recent real activity from the database. Used as the
// always-available fallback when no live caster is pushing a structured log.
async function fetchDbActivity(agentId) {
	const rows = await sql`
		SELECT type, payload, created_at
		FROM agent_actions
		WHERE agent_id = ${agentId}
		ORDER BY id DESC
		LIMIT 50
	`.catch(() => []);
	// oldest-first for display, matching the Redis log ordering.
	return rows.map(rowToEntry).reverse();
}

// wrap(): a fault raised before the SSE head is written must land the platform's
// sanitized envelope with a correlation ref, a Sentry capture and an ops alert.
// Once the head is out, the loop below owns its own errors and wrap()'s
// headersSent guard keeps it from writing a second response over the stream.
export default wrap(async function handleAgentScreenStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const agentId = (url.searchParams.get('agentId') || '').trim();
	// Answer pre-stream faults through the shared error() envelope so an SSE client
	// reads the same { error, error_description } shape every other endpoint emits,
	// with the standard no-store + nosniff headers.
	if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');

	// Resolve agent name for the open event
	const [agentRow] = await sql`
		SELECT name FROM agent_identities WHERE id = ${agentId} LIMIT 1
	`.catch(() => []);
	if (!agentRow) return error(res, 404, 'not_found', 'agent not found');

	const r = getRedis();

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active || res.writableEnded) return;
		try {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		} catch {
			active = false;
		}
	};

	req.on('close', () => { active = false; });

	// Emit open event immediately
	send('open', { agentId, agentName: agentRow.name, ts: Date.now() });

	// Emit activity log backfill. A live caster's pushed Redis log wins; otherwise
	// fall back to the agent's real DB activity so the screen is never blank.
	let hasRedisLog = false;
	if (r) {
		try {
			const logKey = `agent:screen:${agentId}:log`;
			const raw = await r.lrange(logKey, 0, 49);
			const entries = (raw || [])
				.map(parseRedisRecord)
				.filter(Boolean)
				.reverse(); // oldest-first for display
			// Only an entry we could actually decode counts as a live caster log.
			// An undecodable list must fall through to the DB backfill rather than
			// leave the panel blank behind a `hasRedisLog` flag it never earned.
			if (entries.length) {
				hasRedisLog = true;
				send('log', { entries });
			}
		} catch { /* non-fatal */ }
	}
	let lastDbActivityTs = 0;
	if (!hasRedisLog) {
		try {
			const entries = await fetchDbActivity(agentId);
			if (entries.length) {
				lastDbActivityTs = entries[entries.length - 1].ts;
				send('log', { entries });
			}
		} catch { /* non-fatal */ }
	}

	const frameKey = `agent:screen:${agentId}:frame`;
	const reactionKey = reactionsRecentKey(agentId);
	const reactionTotalKey = reactionsTotalKey(agentId);
	let lastTs = 0;
	let wasDark = false;
	// With no frame store configured there is nothing to poll, so the loop below
	// never reaches its dark branch and the viewer would sit on "Connecting…" for
	// the whole 280s. Say it once up front instead; the DB activity backfill above
	// and its refresh below still keep the panel meaningful.
	if (!r) {
		wasDark = true;
		send('dark', {});
	}
	// Only replay reactions that arrive AFTER this viewer connects — joining mid
	// stream shouldn't dump a backlog of bursts. But do send the current windowed
	// total straight away so the live count is correct the instant the bar mounts.
	let lastReactionTs = Date.now();
	if (r) {
		try {
			const t = Number(await r.get(reactionTotalKey));
			if (Number.isFinite(t) && t > 0) send('reaction', { bursts: [], total: t });
		} catch { /* count will catch up on the first reaction */ }
	}
	let deadline = Date.now() + MAX_DURATION_MS;
	let pingAt = Date.now() + PING_INTERVAL_MS;
	let activityAt = Date.now() + ACTIVITY_REFRESH_MS;

	const loop = async () => {
		while (active && Date.now() < deadline) {
			const now = Date.now();

			// Keepalive ping
			if (now >= pingAt) {
				send('ping', {});
				pingAt = now + PING_INTERVAL_MS;
			}

			// Refresh DB activity for agents with no live caster log, so an idle
			// agent's screen keeps reflecting real on-chain/skill activity as it
			// happens. Skipped entirely once a caster is pushing its own log.
			if (!hasRedisLog && now >= activityAt) {
				activityAt = now + ACTIVITY_REFRESH_MS;
				try {
					const entries = await fetchDbActivity(agentId);
					if (entries.length) {
						const newestTs = entries[entries.length - 1].ts;
						if (newestTs > lastDbActivityTs) {
							lastDbActivityTs = newestTs;
							send('log', { entries });
						}
					}
				} catch { /* non-fatal */ }
			}

			// Poll for new frame
			if (r) {
				try {
					const raw = await r.get(frameKey);
					if (raw) {
						const frame = parseRedisRecord(raw);
						if (frame?.ts && frame.ts !== lastTs) {
							lastTs = frame.ts;
							wasDark = false;
							send('frame', frame);
						}
					} else if (!wasDark) {
						// No frame in Redis — agent is dark. Emit once, including on the
						// very first poll (a viewer who connects to an already-offline
						// agent must get the "offline" state, not hang on "Connecting…").
						wasDark = true;
						send('dark', {});
					}
				} catch { /* Redis blip — keep polling */ }

				// Poll for new viewer reactions and fan them out to this client. The
				// list is LPUSH newest-first; we take everything newer than the last
				// one we forwarded, replay it oldest-first as floating-emoji bursts,
				// and carry the windowed total so every viewer's count agrees.
				try {
					const recent = await r.lrange(reactionKey, 0, REACTION_RECENT_CAP - 1);
					if (recent?.length) {
						const fresh = recent
							.map(parseRedisRecord)
							.filter((x) => x && Number(x.ts) > lastReactionTs)
							.sort((a, b) => a.ts - b.ts);
						if (fresh.length) {
							lastReactionTs = fresh[fresh.length - 1].ts;
							const total = Number(await r.get(reactionTotalKey)) || undefined;
							send('reaction', { bursts: fresh.map((x) => ({ emoji: x.emoji, ts: x.ts })), total });
						}
					}
				} catch { /* reactions are best-effort — frames are the priority */ }
			}

			// Yield to event loop before next poll
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}

		if (!res.writableEnded) res.end();
	};

	loop().catch(() => { if (!res.writableEnded) res.end(); });
});
