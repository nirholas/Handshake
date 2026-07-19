/**
 * GET /api/marketplace/skill-promo?agent_id=<uuid>&skill=<name>
 *
 * Public promo state for one paid skill: base price, the effective price the
 * quote will actually charge (dynamic pricing rules applied), and, while a
 * first-N-purchases proof phase is live, the real claimed/spots-left counts.
 * Powers the strikethrough + spots counter in the marketplace and the
 * purchase modal. Read-only, anonymous, briefly CDN-cached: the counter may
 * lag a few seconds behind a concurrent sale, but the charged amount always
 * comes from the quote, never from this endpoint.
 */

import { z } from 'zod';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { describeSkillPromo } from '../_lib/skill-pricing-rules.js';

const querySchema = z.object({
	agent_id: z.string().uuid(),
	skill: z.string().trim().min(1).max(100),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const query = parse(querySchema, {
		agent_id: url.searchParams.get('agent_id') || '',
		skill: url.searchParams.get('skill') || '',
	});

	const state = await describeSkillPromo(query.agent_id, query.skill);
	if (!state) return error(res, 404, 'not_found', 'no active price for this skill');

	res.setHeader('cache-control', 'public, max-age=10, s-maxage=15, stale-while-revalidate=30');
	return json(res, 200, { data: state });
});
