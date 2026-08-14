/**
 * The two OAuth discovery documents and the registration endpoint describe one
 * contract from three sides, and a client that follows the documented path
 * touches all three: the 401 from any MCP server carries
 * `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`,
 * the client reads `scopes_supported` from that document, and it registers for
 * exactly those scopes at /api/oauth/register.
 *
 * So a scope the registration endpoint grants but the protected-resource
 * document omits is a scope no discovery-driven client ever asks for. That is
 * how the whole agent-wallet MCP server (wallet:read / wallet:write /
 * services:write) became unreachable through the documented flow while the
 * registration endpoint happily granted those scopes to anyone who knew to name
 * them. These assertions pin the surfaces to the shared array so the next scope
 * added on one side cannot silently skip the other.
 */
import { describe, it, expect } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const {
	REGISTERABLE_SCOPES,
	AUTH_HINT_SCOPES,
	SUPPORTED_SCOPES,
	filterRegisterableScope,
} = await import('../../api/_lib/oauth-scopes.js');
const { default: wkHandler } = await import('../../api/wk.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

async function fetchWellKnown(name) {
	const res = makeRes();
	const req = { method: 'GET', url: `/api/wk?name=${name}`, headers: {}, query: { name } };
	await wkHandler(req, res);
	return { res, doc: JSON.parse(res.body) };
}

describe('OAuth discovery scope parity', () => {
	it('serves the protected-resource document with the registerable scopes', async () => {
		const { res, doc } = await fetchWellKnown('oauth-protected-resource');
		expect(res.statusCode).toBe(200);
		expect(doc.scopes_supported).toEqual([...REGISTERABLE_SCOPES]);
	});

	it('publishes every scope the registration endpoint would keep', async () => {
		const { doc } = await fetchWellKnown('oauth-protected-resource');
		// Ask for everything the metadata advertises; registration must keep it
		// all, or a compliant client is being told to request scopes it loses.
		const kept = filterRegisterableScope(doc.scopes_supported.join(' '));
		expect(kept.split(' ')).toEqual(doc.scopes_supported);
	});

	it('reaches the agent-wallet scopes through the documented flow', async () => {
		const { doc } = await fetchWellKnown('oauth-protected-resource');
		for (const scope of ['wallet:read', 'wallet:write', 'services:write']) {
			expect(doc.scopes_supported).toContain(scope);
		}
	});

	it('serves authorization-server metadata covering the resource scopes', async () => {
		const { res, doc } = await fetchWellKnown('oauth-authorization-server');
		expect(res.statusCode).toBe(200);
		expect(doc.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
		const { doc: resourceDoc } = await fetchWellKnown('oauth-protected-resource');
		for (const scope of resourceDoc.scopes_supported) {
			expect(doc.scopes_supported).toContain(scope);
		}
	});

	it('keeps the auth-hints scopes out of the protected-resource document', async () => {
		// These gate paid x402 endpoints for first-party principals, not the MCP
		// resource, and registration drops them. Advertising them to MCP clients
		// would promise a scope every registration silently strips.
		const { doc } = await fetchWellKnown('oauth-protected-resource');
		for (const scope of AUTH_HINT_SCOPES) {
			expect(doc.scopes_supported).not.toContain(scope);
			expect(filterRegisterableScope(scope)).toBe('avatars:read');
		}
	});

	it('points the protected-resource document at the MCP resource', async () => {
		const { doc } = await fetchWellKnown('oauth-protected-resource');
		expect(doc.resource).toBe('https://three.ws/api/mcp');
		expect(doc.authorization_servers).toContain('https://three.ws');
		const { doc: asDoc } = await fetchWellKnown('oauth-authorization-server');
		// The issuer named by the resource must be the issuer the AS claims,
		// or the client walks the chain into a document it will reject.
		expect(doc.authorization_servers).toContain(asDoc.issuer);
	});
});
