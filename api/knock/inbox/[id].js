// PATCH /api/knock/inbox/<id> → act on one knock.
//
//   { status: 'read' | 'dismissed' }        mark it
//   { status: 'replied', reply: '…' }       answer it
//   { block: true }                         and never hear from them again
//
// A reply is stored, not sent: Knock is a one-way door by design, and the
// sender reads the answer back through the same paymentless GET they already
// hold a link to (/api/knock/reply?id=…&token=…) rather than the door owner
// handing out an email address. Blocking uses the paying wallet when there was
// one and the sender's name when the knock was free.

import { z } from 'zod';
import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { formatUsdc } from '../../_lib/knock/policy.js';
import { addBlock, getKnock, updateKnock } from '../../_lib/knock/store.js';
import { markEvent } from '../../_lib/companion/store.js';

const patchBody = z.object({
	status: z.enum(['read', 'replied', 'dismissed']).optional(),
	reply: z.string().trim().max(2000).optional(),
	block: z.boolean().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'PATCH,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PATCH'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.knockWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const id = String(req.query?.id || '').trim();
	if (!id) return error(res, 400, 'missing_id', 'knock id required');

	const existing = await getKnock(user.id, id);
	if (!existing) return error(res, 404, 'not_found', 'no such knock');

	const body = parse(patchBody, await readJson(req));
	if (body.status === 'replied' && !body.reply) {
		return error(res, 400, 'missing_reply', 'replying needs a reply');
	}

	if (body.block) {
		// The wallet is the durable identity when the knock was paid for; a free
		// knock only ever gave us a name, so that is what gets blocked.
		await addBlock(user.id, existing.payer_wallet || existing.sender_name, 'blocked from the knock inbox');
	}

	const row = await updateKnock(user.id, id, {
		status: body.status ?? null,
		reply: body.reply ?? null,
	});

	// Reading or dismissing a knock settles its companion delivery too, so the
	// avatar never walks on later to announce something already dealt with.
	if (existing.companion_event_id && body.status) {
		await markEvent(user.id, existing.companion_event_id, {
			delivered: true,
			dismissed: body.status === 'dismissed',
		}).catch(() => null);
	}

	return json(res, 200, { knock: { ...row, amount: formatUsdc(row.amount_atomics) } });
});
