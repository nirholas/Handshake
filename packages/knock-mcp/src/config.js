// Environment for the knock MCP server.
//
// Most of this server needs no credential at all: reading a door, browsing the
// directory, knocking on a free door and reading a receipt are public acts, and
// requiring a key for them would defeat the point of a public door. A key is
// needed only for the two owner-side tools (reading your own knocks and
// replying to one).

export const THREE_WS_BASE = (process.env.THREE_WS_BASE || 'https://three.ws').replace(/\/+$/, '');
export const THREE_WS_API_KEY =
	process.env.THREE_WS_API_KEY || process.env.THREE_WS_TOKEN || process.env.THREE_WS_BEARER || '';
export const HTTP_TIMEOUT_MS = Number(process.env.THREE_WS_TIMEOUT_MS) || 20000;
export const USER_AGENT = 'three-ws-knock-mcp';
