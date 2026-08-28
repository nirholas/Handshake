// POST /api/companion/ingest - the phone and desktop bridge.
//
// This is the lane that needs no provider integration at all: anything that can
// make an HTTP request can hand the companion a message. A Tasker/MacroDroid
// profile on Android (which has a real notification-listener trigger), an iOS
// Shortcut posting from a Share Sheet or an automation, a macOS Mail rule, a
// shell script at the end of a build, an Apps Script trigger on a Gmail label,
// a Zapier/n8n step, an agent over MCP. The recipes are in docs/companion.md.
//
// Auth is the per-user bridge token (Authorization: Bearer, or `token` in the
// body for senders that cannot set headers). It is not a session, so there is
// no CSRF surface: the token IS the credential, and rotating it in the UI
// revokes every device at once.
//
// Body: {
//   title:     string  (required) what the notification says
//   body:      string  (optional) the longer text
//   sender:    string  (optional) display name, matched against contacts
//   sender_id: string  (optional) handle / address / number, matched first
//   app:       string  (optional) which app it came from, e.g. "Messages"
//   url:       string  (optional) somewhere to open
//   id:        string  (optional) sender-side id, for exact dedupe
//   priority:  "high" | "normal" | "low"  (optional) the device's own verdict
//   occurred_at: ISO timestamp (optional)
// }

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { userForIngestToken } from '../_lib/companion/store.js';
import { ingestItem } from '../_lib/companion/poll.js';

const ingestBody = z.object({
	token: z.string().min(8).max(200).optional(),
	title: z.string().min(1).max(300),
	body: z.string().max(4000).optional(),
	sender: z.string().max(200).optional(),
	sender_id: z.string().max(320).optional(),
	app: z.string().max(80).optional(),
	url: z.string().url().max(2048).optional(),
	id: z.string().max(200).optional(),
	priority: z.enum(['high', 'normal', 'low']).optional(),
	occurred_at: z.string().max(64).optional(),
});

function bearerFrom(req) {
	const header = req.headers.authorization || '';
	const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
	return match ? match[1].trim() : null;
}

// A device that retries a failed POST must not produce a second delivery, and
// most notification forwarders carry no id of their own. Hashing the content
// plus the minute it arrived makes a retry idempotent without making two
// genuinely identical messages an hour apart collapse into one.
function externalIdFor(body) {
	if (body.id) return `bridge:${body.id.slice(0, 160)}`;
	const minute = new Date().toISOString().slice(0, 16);
	const digest = createHash('sha256')
		.update([body.app || '', body.sender || '', body.sender_id || '', body.title, body.body || '', minute].join(' '))
		.digest('hex')
		.slice(0, 32);
	return `bridge:${digest}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const raw = await readJson(req);
	const body = parse(ingestBody, raw);
	const token = bearerFrom(req) || body.token;
	if (!token) return error(res, 401, 'unauthorized', 'send your bridge token as an Authorization: Bearer header');

	const rl = await limits.companionIngest(token);
	if (!rl.success) return rateLimited(res, rl);

	const settings = await userForIngestToken(token);
	if (!settings) return error(res, 401, 'unauthorized', 'unknown bridge token, check /companion for the current one');

	const occursAt = body.occurred_at && !Number.isNaN(Date.parse(body.occurred_at))
		? new Date(body.occurred_at).toISOString()
		: null;

	const stored = await ingestItem(settings, {
		source_kind: 'bridge',
		external_id: externalIdFor(body),
		sender: body.sender || body.app || 'Your phone',
		sender_id: body.sender_id || null,
		identity_candidates: [body.sender_id, body.sender].filter(Boolean),
		// The title and body are stored exactly as the device sent them. An
		// earlier version folded the app name into the title ("Sarah (Messages)")
		// and pushed the real text down into the body, which read fine in the
		// spoken line and terribly in the feed, where every row said the same
		// four words. `app` already travels as its own field.
		title: body.title,
		body: body.body || null,
		url: body.url || null,
		occurs_at: occursAt,
		priority_hint: body.priority || null,
	});

	// A duplicate is a success from the sender's point of view: the message did
	// reach the companion, just not for the first time.
	if (!stored) return json(res, 200, { accepted: true, duplicate: true });

	return json(res, 201, {
		accepted: true,
		duplicate: false,
		event: {
			id: stored.id,
			importance: stored.importance,
			reason: stored.reason,
			line: stored.spoken_line,
			delivered: stored.delivered === true,
		},
	});
});
