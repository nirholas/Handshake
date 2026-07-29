import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { isLiveFreeModel, pickDefaultFreeModel } from '../_lib/openrouter-free.js';
import { z } from 'zod';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant on three.ws — a platform for 3D AI agents, Solana, and pump.fun.

You have access to real-time pump.fun and Solana tools:
- Search, analyze, and get details on any pump.fun token
- Check bonding curve progress and graduation status
- Get token trades, holders, and read-only price quotes
- Resolve Solana Name Service (.sol) domains
- Get KOL radar signals for early alpha

When a 3D agent avatar is visible in the corner, you can use animation tools:
- agent_wave — make the avatar wave
- agent_express — express an emotion (celebration, curiosity, concern, empathy, patience)

Be concise, helpful, and crypto-native.`;

const DEFAULTS = {
	name: 'three.ws chat',
	logo_url: null,
	accent_color: '#6366f1',
	tagline: 'Chat with any AI model',
	// Resolved from the live free-model list at request time — see
	// withLiveDefaultModel(). A hardcoded id here is exactly what broke chat:
	// OpenRouter retired the configured default and every visitor's first
	// message failed on it.
	default_model: null,
	agent_id: null,
	system_prompt: DEFAULT_SYSTEM_PROMPT,
};

/**
 * Replace a configured default model that OpenRouter no longer serves with the
 * best live one, so the picker never opens on a dead id. The stored value is
 * left untouched: it becomes authoritative again the moment it is live.
 */
async function withLiveDefaultModel(config) {
	if (config.default_model && (await isLiveFreeModel(config.default_model))) return config;
	const live = await pickDefaultFreeModel({ exclude: [config.default_model].filter(Boolean) });
	return live ? { ...config, default_model: live } : config;
}

const bodySchema = z.object({
	name: z.string().trim().min(1).max(100),
	logo_url: z.string().url().max(500).nullable().optional(),
	accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
	tagline: z.string().trim().max(200).optional(),
	default_model: z.string().trim().min(1).max(100).optional(),
	agent_id: z.string().trim().max(100).nullable().optional(),
	system_prompt: z.string().max(4000).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// GET — fully public
	if (req.method === 'GET') {
		const [row] = await sql`SELECT name, logo_url, accent_color, tagline, default_model, agent_id, system_prompt FROM chat_brand_config WHERE key = 'global'`;
		return json(res, 200, { data: await withLiveDefaultModel(row ?? DEFAULTS) });
	}

	// POST — admin key required (DB row takes precedence over env var, enabling keyless redeploy)
	const [configRow] = await sql`SELECT admin_key, default_model FROM chat_brand_config WHERE key = 'global'`;
	const adminKey = configRow?.admin_key || env.CHAT_ADMIN_KEY;
	if (!adminKey) return error(res, 503, 'not_configured', 'Admin key is not configured');

	const provided = (req.headers['x-admin-key'] || '').trim();
	if (!provided || !constantTimeEquals(provided, adminKey))
		return error(res, 403, 'forbidden', 'invalid admin key');

	let body;
	try {
		const raw = await readJson(req);
		const result = bodySchema.safeParse(raw);
		if (!result.success) return error(res, 400, 'validation_error', result.error.issues[0]?.message ?? 'invalid body');
		body = result.data;
	} catch (err) {
		return error(res, err.status ?? 400, 'bad_request', err.message);
	}

	// default_model is NOT NULL in the schema, so an omitted one resolves to the
	// best model live right now rather than to a hardcoded id that will retire.
	const defaultModel =
		body.default_model ?? (await pickDefaultFreeModel()) ?? configRow?.default_model ?? '';

	const [row] = await sql`
		UPDATE chat_brand_config
		SET
			name          = ${body.name},
			logo_url      = ${body.logo_url ?? null},
			accent_color  = ${body.accent_color},
			tagline       = ${body.tagline ?? DEFAULTS.tagline},
			default_model = ${defaultModel},
			agent_id      = ${body.agent_id ?? null},
			system_prompt = ${body.system_prompt ?? DEFAULT_SYSTEM_PROMPT},
			updated_at    = now()
		WHERE key = 'global'
		RETURNING name, logo_url, accent_color, tagline, default_model, agent_id, system_prompt, updated_at
	`;

	return json(res, 200, { data: row });
});
