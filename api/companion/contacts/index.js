// GET  /api/companion/contacts → the people the companion knows.
// POST /api/companion/contacts → add or update one (upsert on the identity).
//
// A contact is what turns "a message arrived" into "Sarah is at the door": it
// carries the display name, the avatar that delivers her messages, the voice it
// speaks in, and how much her messages outrank everything else.

import { z } from 'zod';
import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { listContacts, upsertContact } from '../../_lib/companion/store.js';
import { TTS_VOICE_IDS } from '../../_lib/tts-voices.js';

const contactBody = z.object({
	identifier: z.string().min(1).max(320),
	display_name: z.string().min(1).max(80),
	avatar_glb_url: z.string().url().max(2048).nullable().optional(),
	avatar_image_url: z.string().url().max(2048).nullable().optional(),
	voice: z.enum(TTS_VOICE_IDS).nullable().optional(),
	priority_boost: z.number().int().min(-100).max(100).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const rl = await limits.companionRead(user.id);
		if (!rl.success) return rateLimited(res, rl);
		return json(res, 200, { contacts: await listContacts(user.id) });
	}

	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.companionWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(contactBody, await readJson(req));
	return json(res, 200, { contact: await upsertContact(user.id, body) });
});
