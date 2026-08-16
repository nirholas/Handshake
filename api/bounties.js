import { sql } from './_lib/db.js';
import { cors, json, error, readJson, wrap, method, rateLimited } from './_lib/http.js';
import { getSessionUser } from './_lib/auth.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits } from './_lib/rate-limit.js';
import { parseLimit, parseOffset } from './_lib/http-params.js';
import { enrichLikes } from './_lib/bounty-likes.js';
import { solUsdPrice } from './_lib/avatar-wallet.js';

export default wrap(async (req, res) => {
	if (cors(req, res)) return;

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://localhost');
		const tab = url.searchParams.get('tab') || 'trending';
		// Shared clamps, not hand-rolled ones: `parseInt('abc')` is NaN, and NaN
		// survives Math.min/Math.max unchanged, so `?limit=abc` used to reach
		// Postgres as `LIMIT NaN` and 500. See api/_lib/http-params.js.
		const limit = parseLimit(url.searchParams, { fallback: 30, max: 50 });
		const offset = parseOffset(url.searchParams);
		// Optional: identify the caller so submission cards know what they've liked.
		const userId = (await getSessionUser(req).catch(() => null))?.id || null;

		if (tab === 'feed') {
			// Mixed feed: interleave recent submissions and open bounties
			const [bounties, submissions] = await Promise.all([
				sql`
					SELECT b.id, b.user_id, b.username, b.title, b.description,
					       b.coin_symbol, b.coin_mint, b.reward_sol, b.reward_tokens,
					       b.reward_usd, b.status, b.expires_at, b.submission_count,
					       b.created_at, 'bounty' AS _type
					FROM bounties b
					WHERE b.deleted_at IS NULL AND b.status != 'closed'
					ORDER BY b.submission_count DESC, b.reward_usd DESC NULLS LAST, b.created_at DESC
					LIMIT ${Math.ceil(limit / 2)}
				`,
				sql`
					SELECT bs.id, bs.bounty_id, bs.user_id, bs.username,
					       bs.content, bs.media_url, bs.media_type, bs.status,
					       bs.created_at,
					       b.title AS bounty_title, b.coin_symbol, b.coin_mint,
					       'submission' AS _type
					FROM bounty_submissions bs
					JOIN bounties b ON bs.bounty_id = b.id
					WHERE bs.status != 'rejected' AND b.deleted_at IS NULL
					ORDER BY bs.created_at DESC
					LIMIT ${Math.ceil(limit / 2)}
				`,
			]);
			// Interleave: for each bounty insert up to 2 of its submissions
			const subsByBounty = {};
			for (const s of submissions) {
				if (!subsByBounty[s.bounty_id]) subsByBounty[s.bounty_id] = [];
				subsByBounty[s.bounty_id].push(s);
			}
			const feed = [];
			for (const b of bounties) {
				feed.push(b);
				const subs = subsByBounty[b.id] || [];
				for (const s of subs.slice(0, 2)) feed.push(s);
			}
			await enrichLikes(
				feed.filter((x) => x._type === 'submission'),
				{ userId },
			);
			return json(res, 200, { feed, tab });
		}

		if (tab === 'submissions') {
			const rows = await sql`
				SELECT bs.id, bs.bounty_id, bs.user_id, bs.username,
				       bs.content, bs.media_url, bs.media_type, bs.status,
				       bs.reward_sol, bs.created_at,
				       b.title AS bounty_title, b.coin_symbol, b.coin_mint
				FROM bounty_submissions bs
				JOIN bounties b ON bs.bounty_id = b.id
				WHERE bs.status != 'rejected' AND b.deleted_at IS NULL
				ORDER BY bs.created_at DESC
				LIMIT ${limit} OFFSET ${offset}
			`;
			await enrichLikes(rows, { userId });
			return json(res, 200, { submissions: rows, tab });
		}

		if (tab === 'open') {
			const rows = await sql`
				SELECT b.id, b.user_id, b.username, b.title, b.description,
				       b.coin_symbol, b.coin_mint, b.reward_sol, b.reward_tokens,
				       b.reward_usd, b.status, b.expires_at, b.submission_count, b.created_at
				FROM bounties b
				WHERE b.deleted_at IS NULL AND b.status = 'open'
				  AND (b.expires_at IS NULL OR b.expires_at > NOW())
				ORDER BY b.reward_usd DESC NULLS LAST, b.created_at DESC
				LIMIT ${limit} OFFSET ${offset}
			`;
			return json(res, 200, { bounties: rows, tab });
		}

		// trending (default)
		const rows = await sql`
			SELECT b.id, b.user_id, b.username, b.title, b.description,
			       b.coin_symbol, b.coin_mint, b.reward_sol, b.reward_tokens,
			       b.reward_usd, b.status, b.expires_at, b.submission_count, b.created_at
			FROM bounties b
			WHERE b.deleted_at IS NULL
			ORDER BY b.submission_count DESC, b.reward_usd DESC NULLS LAST, b.created_at DESC
			LIMIT ${limit} OFFSET ${offset}
		`;
		return json(res, 200, { bounties: rows, tab });
	}

	if (req.method === 'POST') {
		let user;
		try {
			user = await getSessionUser(req);
		} catch {
			return error(res, 401, 'unauthorized', 'sign in to post a bounty');
		}
		if (!user) return error(res, 401, 'unauthorized', 'sign in to post a bounty');
		if (!(await requireCsrf(req, res, user.id))) return;

		const rl = await limits.bountyCreate(user.id);
		if (!rl.success) return rateLimited(res, rl, 'too many bounties, slow down');

		const body = await readJson(req, 16_000);
		const {
			title,
			description,
			reward_sol,
			reward_tokens,
			coin_symbol,
			coin_mint,
			expires_in_days,
		} = body;

		if (!title?.trim()) return error(res, 400, 'bad_request', 'title is required');
		// Bound the free-text and identifier fields so a single bounty can't carry a
		// near-1MB payload into a public, everyone-reads table.
		if (title.trim().length > 200)
			return error(res, 400, 'bad_request', 'title too long (max 200)');
		if (typeof description === 'string' && description.length > 4000)
			return error(res, 400, 'bad_request', 'description too long (max 4000)');
		if (typeof coin_symbol === 'string' && coin_symbol.length > 32)
			return error(res, 400, 'bad_request', 'coin_symbol too long');
		if (typeof coin_mint === 'string' && coin_mint.length > 64)
			return error(res, 400, 'bad_request', 'coin_mint too long');
		if (!reward_sol && !reward_tokens)
			return error(res, 400, 'bad_request', 'set a reward (SOL or tokens)');

		let rewardSol = null;
		if (reward_sol) {
			rewardSol = parseFloat(reward_sol);
			if (!Number.isFinite(rewardSol) || rewardSol <= 0)
				return error(res, 400, 'bad_request', 'reward_sol must be a positive number');
		}
		let rewardTokens = null;
		if (reward_tokens) {
			const rawTokens = String(reward_tokens).trim();
			if (!/^\d+$/.test(rawTokens))
				return error(
					res,
					400,
					'bad_request',
					'reward_tokens must be a non-negative integer',
				);
			rewardTokens = BigInt(rawTokens);
		}

		// reward_usd is a real quote or nothing — never a number derived from a
		// hardcoded fallback price. Sorting treats missing values as NULLS LAST.
		let rewardUsd = null;
		if (rewardSol) {
			try {
				const solUsd = await solUsdPrice();
				rewardUsd = parseFloat((rewardSol * solUsd).toFixed(2));
			} catch (err) {
				console.warn(
					'[bounties] SOL/USD quote unavailable, storing reward_usd=null:',
					err?.message,
				);
			}
		}

		const parsedDays = parseInt(expires_in_days ?? '7', 10);
		const days = Number.isFinite(parsedDays)
			? Math.min(Math.max(Math.floor(parsedDays), 1), 30)
			: 7;
		const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
		const username = user.display_name || user.email?.split('@')[0] || 'anon';
		const symbol = coin_symbol?.trim() || '$THREE';
		const mint = coin_mint?.trim() || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

		const [bounty] = await sql`
			INSERT INTO bounties
			  (user_id, username, title, description, reward_sol, reward_tokens, reward_usd, coin_symbol, coin_mint, expires_at)
			VALUES
			  (${user.id}, ${username}, ${title.trim()}, ${description?.trim() || null},
			   ${rewardSol}, ${rewardTokens}, ${rewardUsd},
			   ${symbol}, ${mint}, ${expiresAt})
			RETURNING *
		`;
		return json(res, 201, { bounty });
	}

	if (!method(req, res, ['GET', 'POST'])) return;
});
