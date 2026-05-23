import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, error, method, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const rows = await sql`
		SELECT
			rl.id,
			rl.price_usd,
			rl.status,
			rl.created_at,
			ms.name  AS skill_name,
			ai.name  AS agent_name
		FROM royalty_ledger rl
		JOIN marketplace_skills ms ON ms.id = rl.skill_id
		JOIN agent_identities   ai ON ai.id = rl.agent_id
		WHERE rl.author_user_id = ${userId}
		ORDER BY rl.created_at DESC
		LIMIT 100
	`;

	// Asset sales (avatars / agents / plugins). asset_purchases stores amount
	// in atomic USDC units (6 decimals on Solana mainnet) — divide to get
	// price_usd for consistent reporting alongside the royalty ledger.
	let assetRows = [];
	try {
		assetRows = await sql`
			SELECT
				ap.id,
				ap.item_type,
				ap.item_id,
				ap.amount,
				ap.currency_mint,
				ap.confirmed_at,
				ap.created_at,
				ap.status,
				CASE ap.item_type
					WHEN 'avatar' THEN (SELECT name FROM avatars WHERE id = ap.item_id)
					WHEN 'agent'  THEN (SELECT name FROM agent_identities WHERE id = ap.item_id)
					ELSE NULL
				END AS item_name
			FROM asset_purchases ap
			WHERE ap.seller_user_id = ${userId}
			  AND ap.status = 'confirmed'
			ORDER BY ap.confirmed_at DESC NULLS LAST
			LIMIT 100
		`;
	} catch {
		// asset_purchases migration hasn't run yet — leave list empty.
	}

	const pending_usd = rows
		.filter((r) => r.status === 'pending')
		.reduce((s, r) => s + Number(r.price_usd), 0);

	const settled_usd = rows
		.filter((r) => r.status === 'settled')
		.reduce((s, r) => s + Number(r.price_usd), 0);

	const asset_settled_usd = assetRows.reduce(
		(s, r) => s + Number(r.amount) / 1_000_000,
		0,
	);

	const entries = rows.map((r) => ({
		skill_name: r.skill_name,
		agent_name: r.agent_name,
		price_usd: Number(r.price_usd),
		status: r.status,
		created_at: r.created_at,
		kind: 'skill',
	}));
	for (const r of assetRows) {
		entries.push({
			skill_name: `${r.item_type[0].toUpperCase()}${r.item_type.slice(1)} sale`,
			agent_name: r.item_name || '(deleted)',
			price_usd: Number(r.amount) / 1_000_000,
			status: 'settled',
			created_at: r.confirmed_at || r.created_at,
			kind: r.item_type,
		});
	}
	// Newest first, regardless of source.
	entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

	return json(res, 200, {
		pending_usd,
		settled_usd: settled_usd + asset_settled_usd,
		entries,
	});
});
