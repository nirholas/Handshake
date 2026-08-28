/**
 * GET /api/glance/template
 *
 * The Adaptive Card template the Windows 11 widgets board fetches once (the
 * `ms_ac_template` in the PWA manifest's `widgets` member) and then binds to
 * whatever /api/glance/card returns. Static per deploy, so it caches hard.
 */

import { adaptiveTemplate } from '../_lib/glance-adaptive.js';
import { cors, json, wrap, method } from '../_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	res.setHeader('cache-control', 'public, max-age=3600, s-maxage=86400');
	return json(res, 200, adaptiveTemplate());
});
