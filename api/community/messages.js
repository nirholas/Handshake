// /api/community/messages?token=<mint>
//   GET  — recent messages for a coin's community (public read).
//   POST — post a message, attributed server-side via the server key-pair.
//          Available only when CC_SERVER_KEY/SECRET are set AND the caller
//          supplies the posting user's twitterId + linked wallet. Otherwise
//          returns 403 posting_locked, which the composer renders as its
//          designed locked state — not a broken submit.
import { z } from 'zod';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import {
	cc,
	canPostServer,
	isValidToken,
	serverHeaders,
	toTownMessage,
	UnconfiguredError,
} from '../_lib/coin-communities.js';

const CHAINS = ['solana', 'ethereum', 'base', 'bsc'];

const postSchema = z.object({
	content: z.string().trim().min(1).max(2000),
	walletAddress: z.string().trim().min(1).max(120),
	twitterId: z.string().trim().min(1).max(64),
	chainId: z.enum(CHAINS).default('solana'),
});

function getApi(res) {
	try {
		return cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
			return null;
		}
		throw err;
	}
}

async function handleGet(req, res, token) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const api = getApi(res);
	if (!api) return;

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
	const before = url.searchParams.get('before') || undefined;

	const { data, error: apiErr } = await api.getMessagesPublic({
		path: { token_address: token },
		query: { limit, before },
	});
	if (apiErr) {
		return error(res, 502, 'upstream_error', apiErr.message || 'failed to load messages');
	}

	const messages = (data?.messages ?? []).map(toTownMessage);
	res.setHeader('cache-control', 'public, max-age=5, s-maxage=5, stale-while-revalidate=30');
	return json(res, 200, { data: { messages } });
}

async function handlePost(req, res, token) {
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (!canPostServer()) {
		return error(
			res,
			403,
			'posting_locked',
			'server posting is not configured for this deployment',
		);
	}

	const body = await readJson(req).catch(() => null);
	const parsed = postSchema.safeParse(body);
	if (!parsed.success) {
		return error(
			res,
			400,
			'validation_error',
			parsed.error.issues[0]?.message || 'invalid body',
		);
	}

	const api = getApi(res);
	if (!api) return;

	const { content, walletAddress, twitterId, chainId } = parsed.data;
	const { data, error: apiErr } = await api.postMessageServer({
		path: { token_address: token },
		body: { content, walletAddress, twitterId, chainId },
		headers: serverHeaders(),
	});
	if (apiErr) {
		// 403 from upstream means the wallet isn't linked / lacks token balance —
		// surface it verbatim so the composer can tell the user exactly why.
		const status = apiErr.statusCode === 403 ? 403 : 502;
		return error(res, status, 'post_failed', apiErr.message || 'failed to post message');
	}

	return json(res, 200, {
		data: { message: data?.message ? toTownMessage(data.message) : null },
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const token = new URL(req.url, 'http://x').searchParams.get('token');
	if (!isValidToken(token)) {
		return error(res, 400, 'validation_error', 'valid token query param required');
	}

	if (req.method === 'GET') return handleGet(req, res, token);
	return handlePost(req, res, token);
});
