// GET  /api/companion/sources → every connected source (credentials redacted).
// POST /api/companion/sources → connect one.
//
// A new connection is verified against the real provider BEFORE it is stored,
// so a wrong bot token or an ICS URL that points at an HTML page is reported
// while the user is still looking at the form rather than failing silently on a
// cron run three minutes later.

import { z } from 'zod';
import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { listSources, createSource } from '../../_lib/companion/store.js';
import { laneFor } from '../../_lib/companion/poll.js';
import { normalizeIcsUrl } from '../../_lib/companion/lanes/calendar.js';
import { SsrfError } from '../../_lib/ssrf.js';

const telegramConfig = z.object({
	kind: z.literal('telegram'),
	label: z.string().min(1).max(80).optional(),
	bot_token: z.string().min(20).max(200),
});

const calendarConfig = z.object({
	kind: z.literal('calendar'),
	label: z.string().min(1).max(80).optional(),
	ics_url: z.string().min(8).max(2048),
	lookahead_minutes: z.number().int().min(5).max(720).optional(),
});

const emailConfig = z.object({
	kind: z.literal('email'),
	label: z.string().min(1).max(80).optional(),
	host: z.string().min(3).max(255),
	port: z.number().int().min(1).max(65535).optional(),
	secure: z.boolean().optional(),
	user: z.string().min(1).max(320),
	pass: z.string().min(1).max(512),
	folder: z.string().min(1).max(120).optional(),
});

const createBody = z.discriminatedUnion('kind', [telegramConfig, calendarConfig, emailConfig]);

const DEFAULT_LABEL = {
	telegram: 'Telegram',
	calendar: 'Calendar',
	email: 'Email',
};

function configFor(body) {
	if (body.kind === 'telegram') return { bot_token: body.bot_token };
	if (body.kind === 'calendar') {
		return {
			ics_url: normalizeIcsUrl(body.ics_url),
			lookahead_minutes: body.lookahead_minutes || 30,
		};
	}
	return {
		host: body.host.trim(),
		port: body.port || 993,
		secure: body.secure !== false,
		user: body.user.trim(),
		pass: body.pass,
		folder: body.folder || 'INBOX',
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const rl = await limits.companionRead(user.id);
		if (!rl.success) return rateLimited(res, rl);
		return json(res, 200, { sources: await listSources(user.id) });
	}

	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.companionPoll(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(createBody, await readJson(req));
	const config = configFor(body);
	const lane = laneFor(body.kind);

	let verification;
	try {
		verification = await lane.verify(config);
	} catch (err) {
		if (err instanceof SsrfError) {
			return error(res, 400, 'source_unreachable', 'that URL is not a public address we can fetch');
		}
		return error(res, 400, 'source_unreachable', String(err?.message || err).slice(0, 300));
	}

	// Telegram's own answer names the bot, which is what the setup card shows
	// next to the connection ("message @your_bot").
	const stored = { ...config, ...(verification.bot_username ? { bot_username: verification.bot_username } : {}) };
	const source = await createSource(user.id, {
		kind: body.kind,
		label: body.label || verification.calendar_name || DEFAULT_LABEL[body.kind],
		config: stored,
	});

	return json(res, 201, { source, verification });
});
