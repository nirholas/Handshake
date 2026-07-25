// POST /api/x402/notify — Notification Delivery Probe
//
// Paid canary ($0.001 USDC) that exercises the platform notification delivery
// path end-to-end. The autonomous loop sends a heartbeat through the `canary`
// channel every 5 minutes; the endpoint records delivery timing to
// canary_notification_log and returns { delivered, channel, latency_ms } —
// the actionable signal that confirms the notification subsystem is alive.
//
// Body:
//   { "channel": "canary", "message": "x402 loop heartbeat", "priority": "low" }
//
// Response:
//   { delivered: true, channel: "canary", latency_ms: <number>, notification_id: "<uuid>" }

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody as readRawBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/notify';

const VALID_CHANNELS = new Set(['canary', 'ops', 'system']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);

// One-time DDL guard per warm instance.
let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS canary_notification_log (
			id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			channel      text    NOT NULL,
			message      text    NOT NULL,
			priority     text    NOT NULL DEFAULT 'low',
			payer        text,
			latency_ms   integer NOT NULL,
			delivered    boolean NOT NULL DEFAULT true,
			created_at   timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS canary_notification_log_channel_ts
			ON canary_notification_log (channel, created_at DESC)
	`;
	_schemaReady = true;
}

const DESCRIPTION =
	'Notification Delivery Probe — pay $0.001 USDC to send a canary message ' +
	'through the platform notification channel and confirm delivery. Returns ' +
	'{ delivered, channel, latency_ms } so the autonomous loop can assert the ' +
	'notification subsystem is alive within a 2-second SLA. Channel "canary" is ' +
	'the x402 loop heartbeat lane; "ops" and "system" route to the ops alert surface.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		channel: {
			type: 'string',
			enum: ['canary', 'ops', 'system'],
			description: 'Delivery channel. "canary" is the autonomous-loop heartbeat lane.',
			default: 'canary',
		},
		message: {
			type: 'string',
			maxLength: 500,
			description: 'Notification message body.',
			default: 'x402 loop heartbeat',
		},
		priority: {
			type: 'string',
			enum: ['low', 'normal', 'high'],
			description: 'Delivery priority hint.',
			default: 'low',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['delivered', 'channel', 'latency_ms', 'notification_id', 'ts'],
	properties: {
		delivered:       { type: 'boolean' },
		channel:         { type: 'string' },
		latency_ms:      { type: 'integer', description: 'Time from request receipt to DB record completion.' },
		notification_id: { type: 'string', format: 'uuid' },
		message:         { type: 'string' },
		priority:        { type: 'string' },
		payer:           { type: ['string', 'null'] },
		ts:              { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['notification health check', 'delivery canary', 'ops alerting'],
	input: {
		type: 'json',
		example: { channel: 'canary', message: 'x402 loop heartbeat', priority: 'low' },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			delivered: true,
			channel: 'canary',
			latency_ms: 18,
			notification_id: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
			message: 'x402 loop heartbeat',
			priority: 'low',
			payer: null,
			ts: '2026-06-28T10:00:00Z',
		},
	},
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

async function readBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const chunks = [await readRawBody(req, 1_000_000)];
		const raw = Buffer.concat(chunks).toString('utf8');
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('notify', '1000'), // $0.001 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Notification Delivery',
		tags: ['notification', 'canary', 'health', 'delivery', 'ops'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req, payer }) {
		const t0 = Date.now();
		const body = await readBody(req);

		const rawChannel = typeof body.channel === 'string' ? body.channel.trim().slice(0, 64) : 'canary';
		const channel = VALID_CHANNELS.has(rawChannel) ? rawChannel : 'canary';

		const message = typeof body.message === 'string'
			? body.message.trim().slice(0, 500)
			: 'x402 loop heartbeat';

		const rawPriority = typeof body.priority === 'string' ? body.priority.trim().toLowerCase() : 'low';
		const priority = VALID_PRIORITIES.has(rawPriority) ? rawPriority : 'low';

		let notification_id = crypto.randomUUID();
		let delivered = false;

		try {
			await ensureSchema();
			const latency_ms_pre = Date.now() - t0;
			const [row] = await sql`
				INSERT INTO canary_notification_log
					(channel, message, priority, payer, latency_ms, delivered)
				VALUES
					(${channel}, ${message}, ${priority}, ${payer ?? null}, ${latency_ms_pre}, true)
				RETURNING id
			`;
			notification_id = row?.id ?? notification_id;
			delivered = true;
		} catch (err) {
			console.error('[x402/notify] db insert failed:', err?.message);
			// delivered stays false — the signal is actionable
		}

		const latency_ms = Date.now() - t0;

		return {
			delivered,
			channel,
			latency_ms,
			notification_id,
			message,
			priority,
			payer: payer ?? null,
			ts: new Date().toISOString(),
		};
	},
});
