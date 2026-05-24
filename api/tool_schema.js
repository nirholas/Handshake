import { cors, json, method, wrap } from './_lib/http.js';
import { TOOL_CATALOG } from './_mcp/catalog.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	return json(res, 200, TOOL_CATALOG);
});
