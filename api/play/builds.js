// /api/play/builds — featured builds for a coin's /play world (R20).
//
//   GET  ?mint=<mint>                    → { builds: [...] } newest first
//   POST { mint, title, author, blocks, thumb } → { ok, id }
//
// A "build" is a player's screenshot of their voxel creation plus a little
// metadata. Storage reuses the same Upstash Redis the rest of /play persists to
// (the R17 layer) — see api/_lib/builds-store.js. The surface that renders these
// lives in the /play client (coincommunities-ui.js); each card links back into
// the coin's world.
import { z } from 'zod';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { listBuilds, publishBuild } from '../_lib/builds-store.js';

// Mirror the client/server build caps so a forged payload can't claim an
// impossible size. MAX_BLOCKS matches build-voxels.js / WalkRoom.
const MAX_BLOCKS = 6000;
// A downscaled JPEG thumbnail (~720px wide, q0.72) is tens of KB; cap the data
// URL well above that but far below Redis's per-value ceiling so one oversized
// screenshot can't bloat a coin's storage.
const MAX_THUMB_CHARS = 280_000; // ~210 KB decoded

// The mint is not just an identifier here: it becomes the Redis key a coin's
// featured builds live under. So its FORMAT is checked, not only its length,
// which is what api/play/population.js does with the same coin-world identifier
// and what billboard-store.js does with the same kind of per-coin Redis key.
// Base58 covers Solana worlds, 0x-hex covers the EVM ones; a length check alone
// let any 32-to-64-character string mint a key from an unauthenticated publish.
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function isCoinWorld(v) {
	const s = String(v || '').trim();
	return SOLANA_MINT_RE.test(s) || EVM_ADDRESS_RE.test(s);
}

const publishSchema = z.object({
	mint: z.string().trim().refine(isCoinWorld),
	title: z.string().trim().max(60).optional().default(''),
	author: z.string().trim().max(32).optional().default(''),
	blocks: z.number().int().min(0).max(MAX_BLOCKS),
	thumb: z.string()
		.regex(/^data:image\/(jpeg|png|webp);base64,/, 'thumb must be a base64 image data URL')
		.max(MAX_THUMB_CHARS, 'thumb too large'),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') {
		res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const mint = String(req.query?.mint || '').trim();
		if (!isCoinWorld(mint)) {
			return error(res, 400, 'bad_mint', 'a valid coin mint is required');
		}
		try {
			const builds = await listBuilds(mint);
			return json(res, 200, { builds });
		} catch (err) {
			console.error('[play/builds] list failed:', err?.message);
			return error(res, 502, 'list_failed', 'could not load featured builds');
		}
	}

	// POST — publish a build.
	res.setHeader('cache-control', 'no-store');
	const rl = await limits.buildPublishIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'sharing too fast — try again shortly');

	// Read a little past the thumb cap so a modestly-oversized screenshot is
	// rejected by the schema (a clean 413) rather than the raw byte limit, while
	// a truly enormous body is still refused before it's fully buffered.
	const parsed = publishSchema.safeParse(await readJson(req, Math.round(MAX_THUMB_CHARS * 1.5)).catch(() => null));
	if (!parsed.success) {
		const tooBig = parsed.error?.issues?.some((i) => /too large/.test(i.message));
		if (tooBig) return error(res, 413, 'thumb_too_large', 'screenshot too large to share');
		return error(res, 400, 'validation_error', 'mint, blocks and a screenshot are required');
	}
	const { mint, title, author, blocks, thumb } = parsed.data;
	const id = (globalThis.crypto?.randomUUID?.() || `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
	try {
		await publishBuild(mint, {
			id, title, author, blocks, thumb,
			coinName: '', coinSymbol: '',
			createdAt: Date.now(),
		});
		return json(res, 201, { ok: true, id });
	} catch (err) {
		if (err?.message === 'persistence_unavailable') {
			return error(res, 503, 'unavailable', 'sharing is temporarily unavailable');
		}
		console.error('[play/builds] publish failed:', err?.message);
		return error(res, 502, 'publish_failed', 'could not publish build');
	}
});
