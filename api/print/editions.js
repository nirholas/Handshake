/**
 * Edition scarcity for a forge model.
 *
 *   GET  /api/print/editions?creation_id=<uuid>
 *        → { edition: { limit, issued, remaining, soldOut } }   (public)
 *   POST /api/print/editions  { creation_id, edition_of }
 *        → { edition }                                          (creator only)
 *
 * `edition_of: null` is an open edition and is every model's default. A number
 * caps how many physical copies may ever exist; the cap is enforced when a
 * print is quoted (so a sold-out model never takes money) and frozen onto each
 * certificate at ship time (so a later change cannot rewrite what a shipped
 * certificate already promised).
 *
 * A cap below what has already shipped is refused rather than clamped: an
 * edition cannot be shrunk under its own history.
 */

import { cors, json, method, wrap, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { getSessionUser } from '../_lib/auth.js';
import { hashClient } from '../_lib/forge-store.js';
import { editionState, setEditionLimit, PrintEditionError } from '../_lib/print/editions.js';

const STATUS_BY_CODE = {
	creation_not_found: 404,
	not_creation_owner: 403,
	edition_limit_invalid: 400,
	edition_limit_out_of_range: 400,
	edition_limit_below_issued: 409,
	series_key_underivable: 400,
};

function clientKeyFrom(req) {
	const raw = req.headers['x-forge-client'];
	const header = Array.isArray(raw) ? raw[0] : raw;
	return header ? hashClient(header) : null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		if (req.method === 'GET') {
			const url = new URL(req.url, 'http://localhost');
			const creationId = url.searchParams.get('creation_id') || '';
			if (!isUuid(creationId)) return json(res, 400, { error: 'invalid creation_id' });
			return json(res, 200, { edition: await editionState({ creationId }) });
		}

		const body = await readJson(req);
		const creationId = String(body?.creation_id || '');
		if (!isUuid(creationId)) return json(res, 400, { error: 'invalid creation_id' });

		const user = await getSessionUser(req, res);
		const clientKey = clientKeyFrom(req);
		if (!user && !clientKey) {
			return json(res, 401, { error: 'sign in to set the edition size for your model' });
		}

		const edition = await setEditionLimit({
			creationId,
			userId: user?.id ?? null,
			clientKey,
			limit: Object.prototype.hasOwnProperty.call(body || {}, 'edition_of')
				? body.edition_of
				: body?.limit,
		});
		return json(res, 200, { edition });
	} catch (err) {
		if (err instanceof PrintEditionError) {
			return json(res, STATUS_BY_CODE[err.code] || 400, { error: err.message, code: err.code });
		}
		throw err;
	}
});
