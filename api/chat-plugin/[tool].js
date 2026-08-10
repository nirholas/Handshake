// Gateway-facing tool endpoint for the three.ws chat plugin (LobeChat / SperaxOS).
//
// When the LLM calls one of the plugin's functions, the host's plugin gateway
// POSTs the function arguments here as the JSON body and forwards the user's
// plugin settings in a header. The standalone iframe animates the avatar over
// postMessage; this endpoint returns the concise tool result the model reads
// back. Both halves run for every call; this is the model-facing half.
//
// Function → URL mapping is declared in /sperax/manifest.json:
//   render_agent → /api/chat-plugin/render-agent
//   speak        → /api/chat-plugin/speak
//   gesture      → /api/chat-plugin/gesture
//   emote        → /api/chat-plugin/emote
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';

const GESTURES = ['wave', 'nod', 'point', 'shrug'];
const EMOTIONS = ['concern', 'celebration', 'patience', 'curiosity', 'empathy'];

// A UUID agentId names a row in `agent_identities`, so confirm it exists before
// telling the model the panel is bound: a typo in the plugin settings otherwise
// reads back as a successful binding while the iframe silently shows nothing.
// Any other shape is a handle or manifest id that the <agent-3d> element
// resolves in the browser, so it passes through unverified. A DB outage must
// never take the plugin down with it: an infra failure degrades to the same
// unverified path rather than a 500.
async function resolveAgent(agentId) {
	if (!isUuid(agentId)) return { known: true, name: null };
	try {
		const [row] = await sql`
			SELECT name FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!row) return { known: false, name: null };
		return { known: true, name: typeof row.name === 'string' ? row.name : null };
	} catch (err) {
		console.warn('[chat-plugin] agent lookup failed, binding unverified:', err?.message);
		return { known: true, name: null };
	}
}

// LobeChat forwards settings in `lobe-chat-plugin-settings`; SperaxOS renames it
// to `Sperax-Plugin-Settings`. Header names are lower-cased by Node.
function readSettings(req) {
	const raw = req.headers['sperax-plugin-settings'] || req.headers['lobe-chat-plugin-settings'];
	if (!raw || typeof raw !== 'string') return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

// The gateway posts the arguments object as the body. Be defensive about a
// `{ arguments: "<json-string>" }` envelope in case a host wraps it.
function readArgs(body) {
	if (!body || typeof body !== 'object') return {};
	if (typeof body.arguments === 'string') {
		try {
			return JSON.parse(body.arguments) || {};
		} catch {
			return {};
		}
	}
	return body;
}

export default wrap(async (req, res) => {
	// Server-to-server from the gateway, but also reachable by browser-based
	// marketplace validators, so keep it openly readable.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const tool = String(req.query?.tool || '').toLowerCase();
	const args = readArgs(await readJson(req, 64_000));
	const settings = readSettings(req);
	const agentId =
		(typeof args.agentId === 'string' ? args.agentId.trim() : '') ||
		(typeof settings.agentId === 'string' ? settings.agentId.trim() : '') ||
		null;

	switch (tool) {
		case 'render-agent': {
			if (!agentId) {
				return error(res, 400, 'validation_error', 'agentId is required');
			}
			const agent = await resolveAgent(agentId);
			if (!agent.known) {
				return error(
					res,
					404,
					'not_found',
					`no three.ws agent with id ${agentId}. Copy the agent ID from the dashboard at https://three.ws/dashboard into the plugin settings.`,
				);
			}
			return json(res, 200, {
				ok: true,
				action: 'render_agent',
				agentId,
				agentName: agent.name,
				message: agent.name
					? `The embodied avatar panel is now bound to ${agent.name} (agent ${agentId}).`
					: `The embodied avatar panel is now bound to agent ${agentId}.`,
			});
		}

		case 'speak': {
			const text = typeof args.text === 'string' ? args.text.trim() : '';
			if (!text) return error(res, 400, 'validation_error', 'text is required');
			const sentiment =
				typeof args.sentiment === 'number' ? Math.max(-1, Math.min(1, args.sentiment)) : 0;
			return json(res, 200, {
				ok: true,
				action: 'speak',
				spoken: text,
				sentiment,
				message: 'The avatar spoke this line aloud in the panel.',
			});
		}

		case 'gesture': {
			const name = typeof args.name === 'string' ? args.name.toLowerCase() : '';
			if (!GESTURES.includes(name)) {
				return error(
					res,
					400,
					'validation_error',
					`name must be one of: ${GESTURES.join(', ')}`,
				);
			}
			return json(res, 200, {
				ok: true,
				action: 'gesture',
				gesture: name,
				message: `The avatar played the "${name}" gesture.`,
			});
		}

		case 'emote': {
			const trigger = typeof args.trigger === 'string' ? args.trigger.toLowerCase() : '';
			if (!EMOTIONS.includes(trigger)) {
				return error(
					res,
					400,
					'validation_error',
					`trigger must be one of: ${EMOTIONS.join(', ')}`,
				);
			}
			const weight =
				typeof args.weight === 'number' ? Math.max(0, Math.min(1, args.weight)) : 1;
			return json(res, 200, {
				ok: true,
				action: 'emote',
				emotion: trigger,
				weight,
				message: `The avatar's body language shifted toward "${trigger}".`,
			});
		}

		default:
			return error(res, 404, 'not_found', `unknown plugin tool: ${tool || '(none)'}`);
	}
});
