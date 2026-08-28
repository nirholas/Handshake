// POST /api/knock/send
//
// The free lane. A door priced at zero takes a plain JSON post from anyone:
// no wallet, no session, no signature. That is the on-ramp, and the reason it
// exists is that the interesting half of Knock (a stranger reaching a person
// and being announced in person) should be tryable before anyone spends money.
//
//   { "to": "nirholas", "from": "Ada", "message": "…", "subject": "…" }
//
// A priced door answers 402 here with the x402 endpoint to use instead, so a
// caller that guessed the wrong lane is told exactly where to go rather than
// being refused. Free means there is no price to make a flood expensive, so
// the IP bucket is deliberately tight (api/_lib/rate-limit.js, knockSendIp).

import { z } from 'zod';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { env } from '../_lib/env.js';
import { formatUsdc, normalizeHandle } from '../_lib/knock/policy.js';
import { publicDoorByHandle } from '../_lib/knock/store.js';
import { checkDoor, deliverKnock } from '../_lib/knock/deliver.js';
import { receiptUrl } from '../_lib/knock/receipt.js';

const body = z.object({
	to: z.string().trim().min(1).max(40),
	from: z.string().trim().min(1).max(64),
	message: z.string().min(1).max(2000),
	subject: z.string().trim().max(120).optional(),
	url: z.string().trim().max(400).optional(),
	sender_kind: z.enum(['agent', 'human', 'unknown']).optional(),
	request_id: z.string().trim().max(80).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.knockSendIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'this free lane accepts a few knocks per hour from one address');

	const input = parse(body, await readJson(req));
	const handle = normalizeHandle(input.to);
	const door = await publicDoorByHandle(handle);
	if (!door) return error(res, 404, 'no_door', 'no open door for that handle');

	if (String(door.price_atomics) !== '0') {
		return error(res, 402, 'payment_required', `${door.display_name || handle} charges ${formatUsdc(door.price_atomics)} to be reached`, {
			endpoint: `${env.APP_ORIGIN}/api/x402/knock?to=${encodeURIComponent(handle)}`,
			price_atomics: String(door.price_atomics),
			price: formatUsdc(door.price_atomics),
			protocol: 'x402',
		});
	}

	try {
		const { clean } = await checkDoor(door.user_id, input);
		const { knock, duplicate } = await deliverKnock({ userId: door.user_id, clean });
		return json(res, duplicate ? 200 : 201, {
			ok: true,
			duplicate,
			knock_id: knock.id,
			delivered_to: door.display_name || handle,
			receipt_url: receiptUrl(knock.id),
			paid: '$0.00',
		});
	} catch (err) {
		if (err?.code && err?.status) return error(res, err.status, err.code, err.message);
		throw err;
	}
});
