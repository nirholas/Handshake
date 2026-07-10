/**
 * GET /api/trending?window=24h|7d|all&limit=10
 *
 * Returns trending agents (by real chat activity) and top Oracle conviction
 * coins — two rankings powering the public /trending leaderboard.
 *
 * Agent ranking:
 *   24h / 7d  — count of usage_events (kind='llm') in the window, per public agent
 *   all time  — total count of usage_events (kind='llm') per public agent
 *
 * `chat_count` is NOT a stored column on agent_identities — it is derived with a
 * correlated COUNT(*) over usage_events, the same pattern used by galaxy.js,
 * agents.js, and characters.js.
 *
 * Coin ranking:
 *   always    — oracle_conviction.score desc, filtered to recent scored_at (<24h stale)
 *
 * Cache: 2 min public CDN (trending doesn't need sub-minute freshness).
 */

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { sql } from './_lib/db.js';
import { thumbnailUrl } from './_lib/r2.js';

const WINDOWS = new Set(['24h', '7d', 'all']);
const WINDOW_INTERVAL = { '24h': '1 day', '7d': '7 days' };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const win   = WINDOWS.has(p.get('window')) ? p.get('window') : '24h';
	const limit = Math.min(20, Math.max(1, Number(p.get('limit') || 10)));

	// ── Agents ─────────────────────────────────────────────────────────────
	let agentRows;
	if (win === 'all') {
		// Total real LLM usage events per public agent. chat_count is derived
		// (no stored column) so it is filtered/ordered via the outer alias.
		agentRows = await sql`
			select * from (
				select
					i.id,
					i.name,
					i.description,
					i.meta,
					a.thumbnail_key as avatar_thumbnail_key,
					a.visibility    as avatar_visibility,
					coalesce((
						select count(*)::int from usage_events ue
						where ue.agent_id = i.id and ue.kind = 'llm'
					), 0) as chat_count
				from agent_identities i
				left join avatars a on a.id = i.avatar_id and a.deleted_at is null
				where i.deleted_at is null
				  and i.is_public = true
			) t
			where t.chat_count > 0
			order by t.chat_count desc
			limit ${limit}
		`.catch(() => []);
	} else {
		// Count real LLM usage events in the time window per public agent. The
		// all-time chat_count is derived via a correlated subquery (no stored col).
		const interval = WINDOW_INTERVAL[win];
		agentRows = await sql`
			select
				i.id,
				i.name,
				i.description,
				i.meta,
				a.thumbnail_key as avatar_thumbnail_key,
				a.visibility    as avatar_visibility,
				count(u.id)::int as window_chats,
				coalesce((
					select count(*)::int from usage_events ue
					where ue.agent_id = i.id and ue.kind = 'llm'
				), 0) as chat_count
			from usage_events u
			join agent_identities i on i.id = u.agent_id
			left join avatars a on a.id = i.avatar_id and a.deleted_at is null
			where u.kind = 'llm'
			  and u.created_at >= now() - ${interval}::interval
			  and i.deleted_at is null
			  and i.is_public = true
			group by i.id, i.name, i.description, i.meta,
			         a.thumbnail_key, a.visibility
			order by window_chats desc
			limit ${limit}
		`.catch(() => []);
	}

	const agents = agentRows.map((r, idx) => {
		const meta      = r.meta || {};
		const isOnchain = Boolean(meta.onchain || meta.sol_mint_address);
		const thumbPub  = r.avatar_visibility === 'public' || r.avatar_visibility === 'unlisted';
		const thumb     = r.avatar_thumbnail_key && thumbPub ? thumbnailUrl(r.avatar_thumbnail_key) : null;
		return {
			rank:               idx + 1,
			id:                 r.id,
			name:               r.name || null,
			description:        r.description ? r.description.slice(0, 100) : null,
			avatar_thumbnail_url: thumb,
			chat_count:         Number(r.chat_count) || 0,
			window_chats:       Number(r.window_chats) || null,
			is_onchain:         isOnchain,
			// Public custodial wallet + vanity pattern for the shared wallet chip.
			solana_address:       typeof meta.solana_address === 'string' ? meta.solana_address : null,
			solana_vanity_prefix: meta.solana_vanity_prefix || null,
			solana_vanity_suffix: meta.solana_vanity_suffix || null,
			agent_url:          `https://three.ws/agent/${encodeURIComponent(r.id)}`,
		};
	});

	// Reputation as a real discovery signal. Attach each agent's wallet-trust
	// score (computed from real ledger + chain activity) and, when sort=trust is
	// requested, blend it into the ranking as ONE signal among others — never a
	// pay-to-win override. Best-effort: a momentary scoring failure just leaves an
	// agent without a score and keeps the activity ranking intact.
	const sortMode = p.get('sort') === 'trust' ? 'trust' : 'activity';
	if (agents.length) {
		try {
			const { scoreAgentsLite } = await import('./_lib/trust/wallet-reputation.js');
			const reps = await scoreAgentsLite(agents.map((a) => a.id));
			for (const a of agents) {
				const rep = reps.get(a.id);
				if (rep) {
					a.reputation = { score: rep.score, tier: rep.tier, tierLabel: rep.tierLabel, isNew: rep.isNew };
				}
			}
			if (sortMode === 'trust') {
				// Blend: normalized activity (0..1) + normalized trust (0..1), trust
				// weighted 0.45 so genuine activity still leads but proven, trusted
				// agents rise. Activity is normalized within this page's range.
				const maxChats = Math.max(1, ...agents.map((a) => a.window_chats || a.chat_count || 0));
				const blended = agents
					.map((a) => {
						const act = (a.window_chats || a.chat_count || 0) / maxChats;
						const trust = (a.reputation?.score || 0) / 100;
						return { a, k: act * 0.55 + trust * 0.45 };
					})
					.sort((x, y) => y.k - x.k);
				blended.forEach((b, i) => (b.a.rank = i + 1));
				agents.length = 0;
				agents.push(...blended.map((b) => b.a));
			}
		} catch {
			/* reputation enrichment is additive — never block the trending feed */
		}
	}

	// ── Coins (Oracle conviction) ───────────────────────────────────────────
	const coinRows = await sql`
		select mint, symbol, name, score, tier, momentum, pedigree, structure, narrative,
		       smart_wallet_count, scored_at
		from oracle_conviction
		where scored_at >= now() - interval '36 hours'
		  and score is not null
		order by score desc
		limit ${limit}
	`.catch(() => []);

	const coins = coinRows.map((r, idx) => ({
		rank:               idx + 1,
		mint:               r.mint,
		symbol:             r.symbol || null,
		name:               r.name   || null,
		score:              Number(r.score),
		tier:               r.tier,
		momentum:           Number(r.momentum) || 0,
		pedigree:           Number(r.pedigree) || 0,
		structure:          Number(r.structure) || 0,
		narrative:          Number(r.narrative) || 0,
		smart_wallet_count: Number(r.smart_wallet_count) || 0,
		scored_at:          r.scored_at,
		coin_url:           `https://three.ws/oracle/coin/${encodeURIComponent(r.mint)}`,
	}));

	return json(res, 200, {
		window: win,
		generated_at: new Date().toISOString(),
		agents,
		coins,
	}, { 'cache-control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60' });
});
