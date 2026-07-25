// POST /api/x402/telegram-health
//
// Changelog Telegram Bot Health Check — verifies that the platform bot can
// reach the Telegram API and is correctly configured, so new changelog entries
// will actually reach $THREE holders when `npm run changelog:push` runs.
//
// Body: { bot: "changelog" }
//   bot  — which platform bot to probe. Only "changelog" is defined today;
//          the field is required so callers are explicit about intent and
//          future bots (e.g. "oracle", "ops") can share the same endpoint.
//
// Response: { bot, reachable, bot_id, bot_username, latency_ms, checked_at }
//   reachable     — true when Telegram API returned a valid bot record
//   bot_id        — numeric Telegram user_id of the bot (null if unreachable)
//   bot_username  — @handle (null if unreachable)
//   latency_ms    — round-trip to api.telegram.org (null on timeout/error)
//   checked_at    — ISO-8601 timestamp of this probe
//
// Why pay-per-call? The check confirms the TELEGRAM_BOT_TOKEN is valid and
// the bot is live; that proof is worth $0.001 USDC to any agent that needs
// to know whether the changelog delivery channel is healthy before attempting
// a push. Also: keeping the endpoint in the x402 bazaar makes the health
// signal discoverable and auditable in x402_autonomous_log.
//
// Alert convention: when unreachable, the handler writes a Redis key
// `x402:telegram-health:alert` (TTL 25 min) so the ops dashboard and the
// changelog-push script can detect a degraded channel without a DB query.
//
// Env:
//   TELEGRAM_BOT_TOKEN          — bot token from @BotFather (same token used
//                                 by scripts/changelog-telegram.mjs and
//                                 /api/pump/deliver-telegram.js)
//   TELEGRAM_CHANGELOG_CHAT_ID  — changelog channel id (used only for context
//                                 in error messages, not for sending)

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { getRedis } from '../_lib/redis.js';

const ROUTE = '/api/x402/telegram-health';
const TELEGRAM_API = 'https://api.telegram.org';
const PROBE_TIMEOUT_MS = 8000;

// Redis key written when the changelog bot is unreachable.
const ALERT_KEY = 'x402:telegram-health:alert';
const ALERT_TTL_S = 25 * 60; // 25 min — longer than the 5-min probe cooldown

const VALID_BOTS = new Set(['changelog']);

const DESCRIPTION =
	'Changelog Telegram Bot Health Check — pays $0.001 USDC to verify that the ' +
	'three.ws platform bot can reach the Telegram API and is alive. Returns ' +
	'{ reachable, bot_id, bot_username, latency_ms }. If unreachable, new changelog ' +
	'entries will not reach $THREE holders until the bot is restored.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['bot'],
	properties: {
		bot: {
			type: 'string',
			enum: ['changelog'],
			description: 'Which platform bot to probe.',
		},
	},
	additionalProperties: false,
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['bot', 'reachable', 'checked_at'],
	properties: {
		bot:          { type: 'string' },
		reachable:    { type: 'boolean' },
		bot_id:       { type: ['integer', 'null'] },
		bot_username: { type: ['string', 'null'] },
		latency_ms:   { type: ['integer', 'null'] },
		reason:       { type: ['string', 'null'] },
		checked_at:   { type: 'string', format: 'date-time' },
	},
};

const OUTPUT_EXAMPLE = {
	bot: 'changelog',
	reachable: true,
	bot_id: 7234567890,
	bot_username: 'three_ws_bot',
	latency_ms: 142,
	reason: null,
	checked_at: '2026-06-28T12:00:00.000Z',
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: { bot: 'changelog' },
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Probe the Telegram Bot API's getMe endpoint and return a health record.
// Never throws — an unreachable Telegram API IS the health verdict.
async function probeTelegramBot() {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const checkedAt = new Date().toISOString();

	if (!token) {
		return {
			reachable: false,
			bot_id: null,
			bot_username: null,
			latency_ms: null,
			reason: 'TELEGRAM_BOT_TOKEN not configured',
			checked_at: checkedAt,
		};
	}

	const t0 = Date.now();
	let data = null;
	let latencyMs = null;
	let reason = null;

	try {
		const r = await fetch(`${TELEGRAM_API}/bot${token}/getMe`, {
			method: 'GET',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		latencyMs = Date.now() - t0;
		data = await r.json().catch(() => null);
		if (!r.ok || !data?.ok) {
			reason = data?.description || `HTTP ${r.status}`;
		}
	} catch (err) {
		latencyMs = Date.now() - t0;
		reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
			? `timeout after ${PROBE_TIMEOUT_MS}ms`
			: (err?.message || 'network_error');
	}

	const botInfo = data?.result || null;
	const reachable = !!botInfo && !reason;

	return {
		reachable,
		bot_id: botInfo?.id ?? null,
		bot_username: botInfo?.username ?? null,
		latency_ms: latencyMs,
		reason: reachable ? null : reason,
		checked_at: checkedAt,
	};
}

// Write or clear the ops alert key so the ops dashboard and changelog-push
// can detect channel degradation without a DB query.
async function updateAlert(reachable, details) {
	let redis = null;
	try { redis = await getRedis(); } catch { return; }
	if (!redis) return;
	try {
		if (!reachable) {
			await redis.set(
				ALERT_KEY,
				JSON.stringify({
					reason: details.reason,
					bot_id: details.bot_id,
					latency_ms: details.latency_ms,
					checked_at: details.checked_at,
				}),
				{ EX: ALERT_TTL_S },
			);
		} else {
			await redis.del(ALERT_KEY);
		}
	} catch {
		// Redis write failure must never surface as an endpoint error.
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	// $0.001 USDC = 1000 atomics. Override via X402_PRICE_TELEGRAM_HEALTH.
	priceAtomics: priceFor('telegram-health', '1000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	services: ['telegram-health'],
	service: withService({
		serviceName: 'three.ws Telegram Bot Health',
		tags: ['health', 'telegram', 'bot', 'changelog', 'canary'],
	}),

	async handler({ req }) {
		// Parse body — require { bot: "changelog" }.
		let bot = null;
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (body.bot && typeof body.bot === 'string') bot = body.bot.trim();
		} catch { /* leave bot null */ }

		if (!bot || !VALID_BOTS.has(bot)) {
			throw Object.assign(
				new Error(`bot must be one of: ${[...VALID_BOTS].join(', ')}`),
				{ status: 400, code: 'invalid_bot' },
			);
		}

		const health = await probeTelegramBot();
		// Fire-and-forget alert update — never delays the response.
		updateAlert(health.reachable, health).catch(() => {});

		return { bot, ...health };
	},
});
