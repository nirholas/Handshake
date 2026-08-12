// POST /api/developer/mcp-test — exercise the MCP server for the dashboard's
// "Test connection" button.
//
// A real MCP client authenticates with one of the user's API keys, then runs
// the initialize → tools/list handshake. We can't replay the user's plaintext
// key (it's hashed at creation and never stored), so this endpoint authenticates
// the dashboard session, then validates the SELECTED key exactly as the bearer
// path does — owned by the caller, not revoked, not expired — and dispatches the
// handshake with that key's real scope. The result therefore reflects the actual
// key the user is about to hand an MCP client: a revoked/expired/foreign key
// fails here just as it would over the wire.
//
// Body: { keyId: string }
// 200:  { ok, protocolVersion, serverInfo, tools: [...], scopes: [...] }

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { limits } from '../_lib/rate-limit.js';
import { dispatch } from '../_mcp/dispatch.js';

// Mirror a real MCP client's initialize params so the handshake exercises the
// same code path Claude Desktop / Cursor hit, not a degenerate empty call.
const INITIALIZE_PARAMS = {
	protocolVersion: '2025-06-18',
	clientInfo: { name: 'three-ws-dashboard', version: '1.0.0' },
	capabilities: {},
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to test MCP');

	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.mcpUser(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const { keyId } = await readJson(req, 4_000).catch(() => ({}));
	if (!keyId || typeof keyId !== 'string')
		return error(res, 400, 'bad_request', 'keyId is required');
	// api_keys.id is a uuid column: a non-uuid keyId makes Postgres reject the
	// comparison ("invalid input syntax for type uuid") and 500s what is really
	// just a key the caller doesn't own. Same answer as an unknown id.
	if (!isUuid(keyId)) return error(res, 404, 'not_found', 'API key not found');

	const [key] = await sql`
		select id, scope, revoked_at, expires_at
		from api_keys where id = ${keyId} and user_id = ${user.id} limit 1
	`;
	if (!key) return error(res, 404, 'not_found', 'API key not found');
	if (key.revoked_at) return error(res, 400, 'revoked', 'this key is revoked');
	if (key.expires_at && new Date(key.expires_at) < new Date())
		return error(res, 400, 'expired', 'this key has expired');

	// Dispatch with the key's real scope — tools/call gates on scope, so this is
	// the same principal an MCP client carrying this key would present.
	const auth = { userId: user.id, scope: key.scope || '', source: 'apikey', apiKeyId: key.id };

	const init = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }, auth, req);
	if (init?.error) return json(res, 200, { ok: false, error: init.error });

	const list = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth, req);
	if (list?.error) return json(res, 200, { ok: false, error: list.error });

	return json(res, 200, {
		ok: true,
		protocolVersion: init.result?.protocolVersion ?? null,
		serverInfo: init.result?.serverInfo ?? null,
		tools: (list.result?.tools || []).map((t) => ({ name: t.name })),
		scopes: (key.scope || '').split(/\s+/).filter(Boolean),
	});
});
