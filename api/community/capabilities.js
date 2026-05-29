// GET /api/community/capabilities
// Tells the browser which Town affordances are live: reads/realtime (needs
// CC_API_KEY) and posting (needs the server key-pair). The browser uses this
// to render the composer enabled vs. in its designed locked state — never a
// dead button.
import { cors, json, method, wrap } from '../_lib/http.js';
import { capabilities } from '../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	// Capabilities are deployment-wide and safe to cache briefly at the edge.
	res.setHeader('cache-control', 'public, max-age=30, s-maxage=30');
	return json(res, 200, { data: capabilities() });
});
