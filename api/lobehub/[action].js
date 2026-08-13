// LobeHub / LobeChat plugin surface for three.ws.
//
//   GET  /api/lobehub/manifest   the plugin manifest pasted into the LobeHub
//                                plugin store (public/lobehub/plugin.json)
//   GET  /api/lobehub/config     the .well-known descriptor a host discovers
//                                on its own (public/.well-known/lobehub-plugin.json)
//   POST /api/lobehub/handshake  pre-validate an agent id and hand the host the
//                                iframe URL plus the agent's embed policy
//
// The model-facing half of the plugin (the tool calls the LLM makes) lives in
// api/chat-plugin/[tool].js; this file is the host-facing half. All three
// actions are fetched cross-origin from a browser, so they carry an open CORS
// policy exactly like that sibling.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../_lib/db.js';
import { readEmbedPolicy } from '../_lib/embed-policy.js';
import { env } from '../_lib/env.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

// Resolve the manifests from THIS module's location rather than process.cwd().
// The handler runs from whatever directory the host process was started in, and
// under a cwd that is not the repo root the read simply failed. Because it used
// to run once at import time, that failure was permanent for the life of the
// instance: every request answered 500 with nothing to retry.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MANIFEST_FILES = {
	manifest: 'public/lobehub/plugin.json',
	config: 'public/.well-known/lobehub-plugin.json',
};

const manifestCache = new Map();

// Load on first use and cache only successes, so a transient read failure (a
// slow volume mount, a half-written file) is retried on the next request
// instead of pinning the endpoint to 500 forever. A genuine miss throws, which
// wrap() turns into a 500 with a correlation ref and a deduped ops alert naming
// the file an operator has to restore.
function loadManifest(action) {
	const cached = manifestCache.get(action);
	if (cached) return cached;
	const file = MANIFEST_FILES[action];
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8'));
	} catch (err) {
		throw new Error(`lobehub ${action} manifest unreadable at ${file}: ${err?.message || err}`);
	}
	manifestCache.set(action, parsed);
	return parsed;
}

// The origin a host says it is embedding the plugin from. Only the scheme and
// host are meaningful; anything else is a caller mistake worth naming rather
// than silently dropping.
function originHostname(value) {
	if (typeof value !== 'string' || !value.trim()) return null;
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	return url.hostname.toLowerCase() || null;
}

// The handshake is a pre-flight for an embed the iframe also resolves on its
// own, so a database outage degrades to an unverified handshake rather than
// taking the whole plugin down. api/chat-plugin/[tool].js makes the same call
// for the same reason; `verified` in the response tells the host which of the
// two answers it got.
async function lookupAgent(agentId) {
	let row;
	try {
		[row] = await sql`
			SELECT id, name FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
			LIMIT 1
		`;
	} catch (err) {
		console.warn('[lobehub/handshake] agent lookup failed, handshaking unverified:', err?.message);
		return { verified: false, found: true, name: null, policy: null };
	}
	if (!row) return { verified: true, found: false, name: null, policy: null };

	// The policy lives behind a second read, so it can fail on its own after the
	// identity is already confirmed. Folding that failure into the catch above
	// threw away an answer we had: the agent came back verified with a name, and
	// the host was told the handshake was unverified and nameless. Degrade only
	// the part that failed, and report the plugin's own hosts for the policy.
	let policy = null;
	try {
		policy = await readEmbedPolicy(agentId);
	} catch (err) {
		console.warn('[lobehub/handshake] embed policy read failed, reporting plugin hosts only:', err?.message);
	}
	return { verified: true, found: true, name: typeof row.name === 'string' ? row.name : null, policy };
}

// Fold the agent owner's own embed policy (agent_identities.embed_policy, the
// one the dashboard writes) into the answer. Reporting only the plugin's chat
// hosts told an owner who had restricted their agent that it embeds anywhere
// this plugin does, which is the opposite of what they configured.
function mergeEmbedOrigins(pluginHosts, policy) {
	const ownerHosts = (policy?.origins?.hosts ?? []).map((h) => String(h).toLowerCase());
	// A denylist means "everywhere except these", so unioning it with the hosts
	// this plugin runs in would invert it. Pass the owner's list through as-is.
	if (policy?.origins?.mode === 'denylist') {
		return { mode: 'denylist', hosts: [...new Set(ownerHosts)] };
	}
	const hosts = new Set(pluginHosts.map((h) => h.toLowerCase()));
	for (const host of ownerHosts) hosts.add(host);
	return { mode: 'allowlist', hosts: [...hosts] };
}

export default wrap(async (req, res) => {
	const action = req.query?.action;

	// Both manifests are read cross-origin: LobeHub's plugin store fetches the
	// manifest URL straight from the browser, and marketplace validators fetch
	// the .well-known descriptor the same way. Under the default (allowlisted)
	// CORS policy neither got an access-control-allow-origin header at all, so
	// every browser-side install attempt failed.
	if (action === 'manifest' || action === 'config') {
		if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
		if (!method(req, res, ['GET'])) return;
		return json(res, 200, loadManifest(action), { 'cache-control': 'public, max-age=300' });
	}

	if (action === 'handshake') {
		if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
		if (!method(req, res, ['POST'])) return;

		const rl = await limits.widgetRead(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const body = await readJson(req, 16_000);
		const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
		const hostOrigin = body?.hostOrigin || null;

		if (!agentId) {
			return error(res, 400, 'validation_error', 'agentId is required');
		}
		// agent_identities.id is a uuid column, so handing Postgres a non-uuid
		// string raises 22P02 and reached the caller as an opaque 500 (or, during
		// a DB outage, a 503) instead of telling them their id is malformed.
		if (!isUuid(agentId)) {
			return error(
				res,
				400,
				'validation_error',
				`agentId must be a UUID. Copy the agent ID from the dashboard at ${env.APP_ORIGIN}/dashboard.`,
			);
		}
		const hostOriginHost = hostOrigin === null ? null : originHostname(hostOrigin);
		if (hostOrigin !== null && !hostOriginHost) {
			return error(
				res,
				400,
				'validation_error',
				'hostOrigin must be an http(s) URL, for example https://chat.lobehub.com',
			);
		}

		const agent = await lookupAgent(agentId);
		if (!agent.found) {
			return error(
				res,
				404,
				'not_found',
				`no three.ws agent with id ${agentId}. Copy the agent ID from the dashboard at ${env.APP_ORIGIN}/dashboard.`,
			);
		}

		const allowedHosts = [
			'chat.lobehub.com',
			'lobechat.ai',
			'chat.sperax.io',
			'sperax.io',
			'sperax-iota.vercel.app',
			'sperax-jam2emun9-moomsi.vercel.app',
		];
		if (hostOriginHost) allowedHosts.push(hostOriginHost);

		return json(res, 200, {
			ok: true,
			agentId,
			agentName: agent.name,
			// false when the database was unreachable and the agent could not be
			// confirmed. The handshake still succeeds so the host can embed.
			verified: agent.verified,
			iframeUrl: `${env.APP_ORIGIN}/lobehub/iframe/?agent=${encodeURIComponent(agentId)}`,
			embedPolicy: {
				origins: mergeEmbedOrigins(allowedHosts, agent.policy),
			},
		});
	}

	// A misspelled action is read cross-origin like every other action here, and
	// it is nearly always a typo in a host's integration. Answering without a
	// CORS header hid the 404 behind an opaque browser network error, so the
	// integrator never saw the message naming the problem. api/chat-plugin's
	// unknown-tool branch is reachable for the same reason: it CORS-es first.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	return error(res, 404, 'not_found', 'unknown lobehub action');
});
