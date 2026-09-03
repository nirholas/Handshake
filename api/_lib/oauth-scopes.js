// OAuth scope sets, in one place, because two surfaces have to agree on them.
//
// A dynamically-registered MCP client learns what it may ask for by following
// the chain the 401 hands it: `WWW-Authenticate: Bearer resource_metadata=...`
// points at /.well-known/oauth-protected-resource (RFC 9728), and the client
// registers for the scopes that document lists. So the scope list published
// there and the scope list the registration endpoint actually keeps
// (`filterRegisterableScope`) are the same contract seen from two sides: any
// scope missing from the metadata is a scope no discovery-driven client will
// ever request, and any scope listed there but dropped at registration is a
// promise the server breaks.
//
// They drifted once already. The wallet/services scopes were added to
// registration to make the agent-wallet MCP server (api/mcp-agent) reachable,
// and the published metadata kept advertising the original eight, so a client
// that discovered its scopes the documented way still could not reach
// wallet_status, pay_and_call, provision_wallet or monetize_endpoint. Both
// sides now read this array, and tests/api/oauth-scope-discovery.test.js
// pins them together.

// Scopes a dynamically-registered client may request. Anything outside this set
// (notably privileged scopes like `permissions:redeem`, which authorizes
// gas-spending on-chain redemption) is silently dropped at registration so a
// self-registering client can never mint a token carrying it.
export const REGISTERABLE_SCOPES = Object.freeze([
	'avatars:read',
	'avatars:write',
	'avatars:delete',
	'profile',
	'offline_access',
	// Agent memory MCP tools (remember / recall / forget).
	'memory:read',
	'memory:write',
	// On-chain agent identity MCP tools (register_agent / identity_check).
	'agents:read',
	'agents:write',
	// Visitor feedback MCP tools (list_feedback / get_feedback_repro). Read-only
	// by design: the tools behind it compile a reported session into a failing
	// test and can change nothing (api/_mcp/tools/feedback.js). The handlers also
	// require an admin account, so granting this scope to a non-admin authorizes
	// nothing extra.
	'feedback:read',
	// Home Assistant MCP tools (home_status / home_list_macros / home_grants read;
	// home_activate / home_call act). `home:act` authorises ASKING to act, and
	// nothing more: an action that unlocks, opens, or disarms returns a pending
	// confirmation which only a browser session can satisfy
	// (api/home/[id]/confirm.js refuses every bearer principal, this scope
	// included). There is deliberately no `home:confirm` scope, because a
	// confirmation is a human saying yes and there is no token that can be one.
	'home:read',
	'home:act',
	// The wallet/services scopes gate the agent-wallet MCP server
	// (api/mcp-agent). They are registerable because the user approves each one
	// by name on the consent screen and every spend they authorize is still
	// bounded by the server-side caps and THREEWS_AGENT_PAY_ENABLED.
	'wallet:read',
	'wallet:write',
	'services:write',
]);

// Scopes that exist on the authorization server but are NOT self-registerable:
// they gate paid x402 endpoints for first-party and API-key principals via the
// auth-hints extension (installAccessControl({ requiredScope })), never the MCP
// resource. They belong in RFC 8414 authorization-server metadata and must stay
// out of the RFC 9728 protected-resource document for /api/mcp.
export const AUTH_HINT_SCOPES = Object.freeze(['read:agent-reputation', 'x402:bypass']);

// Everything the authorization server can issue, for RFC 8414 scopes_supported.
export const SUPPORTED_SCOPES = Object.freeze([...REGISTERABLE_SCOPES, ...AUTH_HINT_SCOPES]);

const REGISTERABLE = new Set(REGISTERABLE_SCOPES);

export function filterRegisterableScope(requested) {
	const kept = String(requested || '')
		.split(/\s+/)
		.filter((s) => REGISTERABLE.has(s));
	return kept.length ? kept.join(' ') : 'avatars:read';
}
