// GET /api/pulse — the Money Pulse: a real, platform-wide stream of public
// wallet activity across every three.ws agent.
//
// EVERY row is a real event with an explorer-verifiable signature (or a real
// launch record). There are NO synthetic events — if the platform is quiet, the
// feed is honestly empty.
//
// Sources (all real):
//   · agent_custody_events — tips received (event_type='tip'), trades + snipes
//     (event_type='spend', category in 'trade'/'snipe'), and agent-to-agent
//     payments (category='x402'). These are already-public, on-chain movements.
//   · pump_agent_mints — coins launched by an agent.
//   · skill_purchases — real marketplace purchases (skill / time-pass) confirmed
//     on-chain and settled in $THREE. Surfaced as 'purchase' beats the instant a
//     sale lands, straight from the authoritative purchase ledger.
//
// Privacy is load-bearing (see prompts/agent-wallets/07): private withdrawals,
// spend-limit changes, key-recovery and vanity-swap custody events are OWNER-ONLY
// and NEVER appear here. The global feed also honours each agent's is_public flag
// and the per-agent `meta.pulse_opt_out` toggle (owner-controlled, server-side).
//
// Views:
//   GET /api/pulse                       — global live feed (keyset paginated)
//   GET /api/pulse?since=<cursor>        — delta poll: only events newer than cursor
//   GET /api/pulse?agent_id=<id>         — one agent's public "wallet story"
//   GET /api/pulse?view=stats            — aggregate money intelligence
//   GET /api/pulse?view=marketplace      — marketplace commerce viability metrics
//   GET /api/pulse?view=trading          — trading viability: activity, cost, realized P&L
//   GET /api/pulse?view=graph&window=…   — money-flow topology: who paid whom, for what
//   GET /api/pulse?view=agent-summary&agent_id=<id> — one wallet's lifetime summary
//
// Filters: type=all|tips|launches|trades|payments, network=mainnet|devnet.

import { sql, isDbUnavailableError } from './_lib/db.js';
import { cors, json, method, error, serverError, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { isUuid } from './_lib/validate.js';
import { publicUrlOrNull as r2PublicUrl } from './_lib/r2.js';
import { explorerTxUrl, explorerAccountUrl } from './_lib/avatar-wallet.js';
import { cacheGet, cacheSet } from './_lib/cache.js';
import { marketplaceFeeBps } from './_lib/marketplace-platform-fee.js';
import { shapeTradingWindow, shapeTradingPnl, shapeTradingSeries, solFromLamports } from './_lib/pulse-trading.js';
import { MARKET_PAID_KINDS } from './_lib/marketplace-kinds.js';

// The custody categories that are safe to surface publicly. Everything else
// (withdraw, vanity_swap, limit_change, key_recover) is owner-private and is
// excluded by the WHERE clauses below — never add those here.
const PUBLIC_SPEND_CATEGORIES = ['trade', 'snipe', 'x402'];

// The live FEED additionally surfaces marketplace skill purchases (category
// 'marketplace') as 'purchase' beats — real, value-delivering commerce. This is a
// feed-only superset: the aggregate money math above stays on PUBLIC_SPEND_CATEGORIES
// so marketplace's $THREE-denominated rows never distort the SOL volume counters.
const FEED_SPEND_CATEGORIES = [...PUBLIC_SPEND_CATEGORIES, 'marketplace'];

// $THREE is the only coin the marketplace prices in. Real skill purchases settle
// in $THREE (6 decimals), so marketplace GMV is denominated here. A purchase is
// "paid" only when status='confirmed' and it's not a free trial.
const THREE_MINT = process.env.THREE_TOKEN_MINT || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const THREE_DECIMALS = 6;
// atomic $THREE → whole-token float (keeps the fractional part Number-division gives).
const threeFromAtomic = (atomic) => Number(atomic || 0) / 10 ** THREE_DECIMALS;

// type= query param → the set of `kind`s it admits.
const TYPE_KINDS = {
	all: ['tip', 'trade', 'snipe', 'payment', 'purchase', 'launch'],
	tips: ['tip'],
	trades: ['trade', 'snipe'],
	payments: ['payment'],
	purchases: ['purchase'],
	launches: ['launch'],
};

const FEED_TTL_S = 12;        // global feed page cache (short — it's a live feed)
const STATS_TTL_S = 45;       // aggregate stats cache
const MAX_LIMIT = 60;

// Keyset cursor = base64("<epoch_ms>|<row_id>"). row_id is the unified id of the
// last row on a page; comparing (ts, row_id) gives a stable total order across
// the UNION so pagination never skips or duplicates a row.
function encodeCursor(tsIso, rowId) {
	const ms = new Date(tsIso).getTime();
	return Buffer.from(`${ms}|${rowId}`, 'utf8').toString('base64url');
}
function decodeCursor(raw) {
	if (!raw || typeof raw !== 'string') return null;
	try {
		const [ms, rowId] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
		const n = Number(ms);
		if (!Number.isFinite(n) || !rowId) return null;
		return { ts: new Date(n).toISOString(), rowId };
	} catch {
		return null;
	}
}

const r2Url = (key, visible) =>
	key && visible ? r2PublicUrl(key) : null;

// Shape one DB row into the public pulse event the client renders. Pure.
function shapeEvent(r) {
	const avatarPublic = r.avatar_vis === 'public' || r.avatar_vis === 'unlisted';
	const amountLamports = r.amount_lamports != null ? String(r.amount_lamports) : null;
	const amountRaw = r.amount_raw != null ? String(r.amount_raw) : null;
	const sol = amountLamports != null ? Number(amountLamports) / 1e9 : null;
	const usd = r.usd != null ? Number(r.usd) : null;
	const sig = r.signature || null;
	return {
		id: r.row_id,
		kind: r.kind,                       // tip | trade | snipe | payment | launch
		ts: r.ts,
		network: r.network,
		agent: r.agent_id
			? {
					id: r.agent_id,
					name: r.agent_name || 'Agent',
					url: `/agents/${r.agent_id}`,
					avatar_thumbnail_url: r2Url(r.thumb_key, avatarPublic),
					solana_address: r.agent_addr || null,
					solana_vanity_prefix: r.vanity_prefix || null,
					solana_vanity_suffix: r.vanity_suffix || null,
				}
			: null,
		asset: r.asset || null,
		amount_lamports: amountLamports,
		amount_raw: amountRaw,
		sol,
		usd,
		signature: sig,
		explorer: sig ? explorerTxUrl(sig, r.network) : null,
		// launch-only fields
		mint: r.mint || null,
		symbol: r.symbol || null,
		coin_name: r.coin_name || null,
		// Trade direction, derived from which leg the agent spent: a BUY spends the
		// SOL/USDC/THREE quote leg (asset != mint), a SELL spends the token itself
		// (asset == mint). Only meaningful for coin-moving trade/snipe rows; null
		// otherwise. Lets a coin page colour each marker without an extra column.
		side: (r.kind === 'trade' || r.kind === 'snipe') && r.mint
			? (r.asset === r.mint ? 'sell' : 'buy')
			: null,
		skill: r.skill || null,            // marketplace 'purchase' beats carry the skill name
		mint_explorer: r.mint ? explorerAccountUrl(r.mint, r.network) : null,
		// the counterparty of a tip / payment, when public on-chain
		counterparty: r.counterparty || null,
	};
}

// ── feed view ───────────────────────────────────────────────────────────────
async function handleFeed(req, res, { network, type, agentId, mint, cursor, since }) {
	const kinds = TYPE_KINDS[type] || TYPE_KINDS.all;
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 30));

	// Privacy gate. A private agent never appears — in the global feed OR scoped to
	// its own id (err toward privacy; its owner still has the full private custody
	// trail elsewhere). The per-agent `pulse_opt_out` toggle additionally suppresses
	// an agent from the GLOBAL discovery feed only — its own profile/HUD still shows
	// its already-public on-chain history. Deleted agents are always out.
	const visGate = agentId
		? sql`ai.deleted_at IS NULL AND ai.is_public = true`
		: sql`ai.deleted_at IS NULL AND ai.is_public = true AND COALESCE((ai.meta->>'pulse_opt_out')::boolean, false) = false`;

	const agentFilterCe = agentId ? sql`AND ce.agent_id = ${agentId}` : sql``;
	const agentFilterPam = agentId ? sql`AND pam.agent_id = ${agentId}` : sql``;
	const agentFilterSp = agentId ? sql`AND sp.agent_id = ${agentId}` : sql``;

	// One UNION ALL of identical columns. Casts on the launch side make the null
	// columns type-compatible with the custody side.
	const feedCte = sql`
		SELECT
			ce.created_at                        AS ts,
			(CASE
				WHEN ce.event_type = 'tip'         THEN 'tip'
				WHEN ce.category   = 'x402'        THEN 'payment'
				WHEN ce.category   = 'snipe'       THEN 'snipe'
				WHEN ce.category   = 'marketplace' THEN 'purchase'
				ELSE 'trade'
			END)                                  AS kind,
			'c' || ce.id::text                    AS row_id,
			ce.network                            AS network,
			ai.id                                 AS agent_id,
			ai.name                               AS agent_name,
			ai.meta->>'solana_address'            AS agent_addr,
			ai.meta->>'solana_vanity_prefix'      AS vanity_prefix,
			ai.meta->>'solana_vanity_suffix'      AS vanity_suffix,
			av.thumbnail_key                      AS thumb_key,
			av.visibility                         AS avatar_vis,
			ce.asset                              AS asset,
			ce.amount_lamports                    AS amount_lamports,
			ce.amount_raw                         AS amount_raw,
			ce.usd                                AS usd,
			ce.signature                          AS signature,
			tk.mint                               AS mint,
			COALESCE(tm.symbol, ptok.symbol)      AS symbol,
			COALESCE(tm.name, ptok.name)          AS coin_name,
			NULLIF(ce.meta->>'skill', '')         AS skill,
			NULLIF(ce.meta->>'from', '')          AS counterparty
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${visGate}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		-- Resolve the traded token once: it lives in meta.mint (buys + sells) and,
		-- for sells, additionally in the asset column (which holds the mint). SOL /
		-- USDC / THREE assets are the quote/settlement leg, not a traded token.
		LEFT JOIN LATERAL (
			SELECT COALESCE(
				NULLIF(ce.meta->>'mint', ''),
				CASE WHEN ce.asset NOT IN ('SOL', 'USDC', 'THREE') THEN ce.asset END
			) AS mint
		) tk ON true
		-- Name the mint: general Helius/Jupiter cache first, then our own launches.
		-- token_metadata.mint is a PK and pump_agent_mints is unique on (mint,
		-- network), so neither join can fan the row out.
		LEFT JOIN token_metadata tm ON tm.mint = tk.mint
		LEFT JOIN pump_agent_mints ptok ON ptok.mint = tk.mint AND ptok.network = ce.network
		WHERE ce.network = ${network}
		  AND ce.status IN ('ok', 'confirmed')
		  AND (
			ce.event_type = 'tip'
			OR (ce.event_type = 'spend' AND ce.category = ANY(${FEED_SPEND_CATEGORIES}))
		  )
		  ${agentFilterCe}

		UNION ALL

		SELECT
			pam.created_at                        AS ts,
			'launch'                              AS kind,
			'l' || pam.id::text                   AS row_id,
			pam.network                           AS network,
			ai.id                                 AS agent_id,
			ai.name                               AS agent_name,
			ai.meta->>'solana_address'            AS agent_addr,
			ai.meta->>'solana_vanity_prefix'      AS vanity_prefix,
			ai.meta->>'solana_vanity_suffix'      AS vanity_suffix,
			av.thumbnail_key                      AS thumb_key,
			av.visibility                         AS avatar_vis,
			NULL::text                            AS asset,
			NULL::bigint                          AS amount_lamports,
			NULL::numeric                         AS amount_raw,
			NULL::numeric                         AS usd,
			NULL::text                            AS signature,
			pam.mint                              AS mint,
			pam.symbol                            AS symbol,
			pam.name                              AS coin_name,
			NULL::text                            AS skill,
			NULL::text                            AS counterparty
		FROM pump_agent_mints pam
		JOIN agent_identities ai ON ai.id = pam.agent_id AND ${visGate}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE pam.network = ${network}
		  ${agentFilterPam}

		UNION ALL

		-- Real marketplace purchases (skill / time-pass) confirmed on-chain and
		-- settled in $THREE on Solana mainnet. Read straight from skill_purchases,
		-- the same authoritative ledger the marketplace stats reconcile against, so a
		-- confirmed sale becomes a 'purchase' beat the moment it lands, not only when
		-- the synthetic circulation loop happens to be running. Free trials are
		-- excluded (MARKET_PAID_KINDS): a beat means value actually changed hands.
		-- The earning SELLER agent fronts the row, mirroring the top-earners math.
		-- These rows are always Solana mainnet, so the branch yields nothing on the
		-- devnet feed.
		SELECT
			COALESCE(sp.confirmed_at, sp.created_at)  AS ts,
			'purchase'                                AS kind,
			'p' || sp.id::text                        AS row_id,
			'mainnet'::text                           AS network,
			ai.id                                     AS agent_id,
			ai.name                                   AS agent_name,
			ai.meta->>'solana_address'                AS agent_addr,
			ai.meta->>'solana_vanity_prefix'          AS vanity_prefix,
			ai.meta->>'solana_vanity_suffix'          AS vanity_suffix,
			av.thumbnail_key                          AS thumb_key,
			av.visibility                             AS avatar_vis,
			'THREE'::text                             AS asset,
			NULL::bigint                              AS amount_lamports,
			sp.amount::numeric                        AS amount_raw,
			NULL::numeric                             AS usd,
			sp.tx_signature                           AS signature,
			NULL::text                                AS mint,
			NULL::text                                AS symbol,
			NULL::text                                AS coin_name,
			sp.skill                                  AS skill,
			NULL::text                                AS counterparty
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id AND ${visGate}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ${network} = 'mainnet'
		  AND sp.status = 'confirmed'
		  AND sp.kind = ANY(${MARKET_PAID_KINDS})
		  AND sp.currency_mint = ${THREE_MINT}
		  AND sp.chain = 'solana'
		  ${agentFilterSp}
	`;

	// Keyset bounds. `since` (delta poll) returns only rows strictly newer than
	// the cursor; `cursor` (load-older) returns rows strictly older. Both compare
	// on (ts, row_id) so ties at the same timestamp never skip a row.
	const cur = decodeCursor(cursor);
	const sinceCur = decodeCursor(since);
	const olderBound = cur
		? sql`AND (feed.ts < ${cur.ts} OR (feed.ts = ${cur.ts} AND feed.row_id < ${cur.rowId}))`
		: sql``;
	const newerBound = sinceCur
		? sql`AND (feed.ts > ${sinceCur.ts} OR (feed.ts = ${sinceCur.ts} AND feed.row_id > ${sinceCur.rowId}))`
		: sql``;

	// Coin-scoped feed: every agent transaction in one token, newest first. The
	// unified `feed.mint` column already resolves the traded mint on every branch
	// (trade/snipe via meta.mint or the asset leg, launch via pump_agent_mints), so
	// one equality narrows the whole UNION to a single coin. Powers the "agent
	// transactions" panel + chart markers on the coin detail page.
	const mintFilter = mint ? sql`AND feed.mint = ${mint}` : sql``;

	const rows = await sql`
		WITH feed AS (${feedCte})
		SELECT * FROM feed
		WHERE feed.kind = ANY(${kinds})
		  ${mintFilter}
		  ${olderBound}
		  ${newerBound}
		ORDER BY feed.ts DESC, feed.row_id DESC
		LIMIT ${limit + 1}
	`;

	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit).map(shapeEvent);
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? encodeCursor(last.ts, last.id) : null;
	// The newest row's cursor — clients hand it back as `since` to poll the delta.
	const headCursor = page[0] ? encodeCursor(page[0].ts, page[0].id) : (sinceCur ? since : null);

	return {
		events: page,
		has_more: hasMore,
		next_cursor: nextCursor,
		head_cursor: headCursor,
		network,
		type,
		agent_id: agentId || null,
		mint: mint || null,
	};
}

// ── money-flow graph view ─────────────────────────────────────────────────────
// The TOPOLOGY of the agent economy: who paid whom, for what, and how much.
//
// Every other economy surface here is a leaderboard: totals per agent, ranked.
// A ranking cannot show the shape of the flow, and the shape is what diagnoses
// the platform's real failure mode. Capital dispersion looks perfectly healthy
// on a leaderboard (busy agents, real volume) while the money is in fact
// draining one-way into wallets that receive and never spend again. On a graph
// that is a glance: a node with inbound edges and no outbound ones.
//
// Two edge sources, both already-public on-chain movements with an
// explorer-verifiable signature. There is no third "estimated" or "inferred"
// edge type; if the platform is quiet the graph is honestly empty.
//
//   · agent-to-agent x402 payments — the row's agent SPENT, meta.to is the payee
//     wallet and meta.service names the skill that was bought.
//   · tips — the row's agent RECEIVED, meta.from is the payer wallet.
//
// Marketplace purchases are deliberately excluded: they settle in $THREE from a
// human buyer, so they are not an agent-to-agent edge and would silently mix a
// second denomination into the USD flow totals.
//
// Privacy: identical gate to the live feed on the side we own (no deleted, no
// private, no pulse_opt_out). A counterparty wallet is named ONLY when it
// resolves to a public agent; anything else stays an address-only node, which is
// exactly what the feed already exposes as `counterparty`.
const GRAPH_WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
const GRAPH_TTL_S = 60;
// Aggregated edges are ranked by value, so the cap keeps the biggest flows. When
// it bites we say so in the payload rather than presenting a truncated graph as
// the whole economy.
const GRAPH_MAX_EDGES = 400;

const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');

async function handleGraph(network, windowKey) {
	const interval = GRAPH_WINDOWS[windowKey] || GRAPH_WINDOWS['30d'];
	const pubAgent = sql`deleted_at IS NULL AND is_public = true
		AND COALESCE((meta->>'pulse_opt_out')::boolean, false) = false`;

	// One directed-transfer CTE, then aggregate to edges. Counterparty resolution
	// runs through a LATERAL with LIMIT 1 so two identities sharing a wallet can
	// never fan a single payment into two edges.
	const rows = await sql`
		WITH transfers AS (
			SELECT
				ce.created_at                          AS ts,
				'payment'::text                        AS kind,
				payer.id::text                         AS from_agent,
				NULL::text                             AS from_addr,
				payee.id                               AS to_agent,
				ce.meta->>'to'                         AS to_addr,
				ce.amount_lamports                     AS lamports,
				ce.usd                                 AS usd,
				ce.signature                           AS signature,
				NULLIF(ce.meta->>'service', '')        AS service
			FROM agent_custody_events ce
			JOIN agent_identities payer
			  ON payer.id = ce.agent_id
			 AND payer.deleted_at IS NULL AND payer.is_public = true
			 AND COALESCE((payer.meta->>'pulse_opt_out')::boolean, false) = false
			LEFT JOIN LATERAL (
				SELECT ai.id::text AS id FROM agent_identities ai
				WHERE ai.meta->>'solana_address' = ce.meta->>'to' AND ${pubAgent}
				LIMIT 1
			) payee ON true
			WHERE ce.network = ${network}
			  AND ce.event_type = 'spend' AND ce.category = 'x402'
			  AND ce.status IN ('ok', 'confirmed')
			  AND NULLIF(ce.meta->>'to', '') IS NOT NULL
			  AND ce.created_at > now() - ${interval}::interval

			UNION ALL

			SELECT
				ce.created_at, 'tip'::text,
				tipper.id, ce.meta->>'from',
				recv.id::text, NULL::text,
				ce.amount_lamports, ce.usd, ce.signature, NULL::text
			FROM agent_custody_events ce
			JOIN agent_identities recv
			  ON recv.id = ce.agent_id
			 AND recv.deleted_at IS NULL AND recv.is_public = true
			 AND COALESCE((recv.meta->>'pulse_opt_out')::boolean, false) = false
			LEFT JOIN LATERAL (
				SELECT ai.id::text AS id FROM agent_identities ai
				WHERE ai.meta->>'solana_address' = ce.meta->>'from' AND ${pubAgent}
				LIMIT 1
			) tipper ON true
			WHERE ce.network = ${network}
			  AND ce.event_type = 'tip'
			  AND ce.status IN ('ok', 'confirmed')
			  AND NULLIF(ce.meta->>'from', '') IS NOT NULL
			  AND ce.created_at > now() - ${interval}::interval
		)
		SELECT
			COALESCE('a:' || from_agent, 'w:' || from_addr)   AS from_key,
			COALESCE('a:' || to_agent,   'w:' || to_addr)     AS to_key,
			from_agent, to_agent, from_addr, to_addr,
			COUNT(*)::int                                     AS count,
			COALESCE(SUM(lamports), 0)::text                  AS lamports,
			COALESCE(SUM(usd), 0)::float8                     AS usd,
			MAX(ts)                                           AS last_ts,
			(ARRAY_AGG(signature ORDER BY ts DESC))[1]        AS last_signature,
			ARRAY_REMOVE(ARRAY_AGG(DISTINCT kind), NULL)      AS kinds,
			ARRAY_REMOVE(ARRAY_AGG(DISTINCT service), NULL)   AS services
		FROM transfers
		WHERE COALESCE(from_agent, from_addr) IS NOT NULL
		  AND COALESCE(to_agent, to_addr) IS NOT NULL
		GROUP BY 1, 2, from_agent, to_agent, from_addr, to_addr
		ORDER BY usd DESC, count DESC
		LIMIT ${GRAPH_MAX_EDGES + 1}
	`;

	const truncated = rows.length > GRAPH_MAX_EDGES;
	const edgeRows = truncated ? rows.slice(0, GRAPH_MAX_EDGES) : rows;

	// Name the agent nodes in one round trip. Only ids that survived the public
	// gate above reach here, so this join adds no new disclosure.
	const agentIds = [
		...new Set(edgeRows.flatMap((r) => [r.from_agent, r.to_agent]).filter(Boolean)),
	];
	const agentRows = agentIds.length
		? await sql`
			SELECT ai.id::text AS id, ai.name, ai.meta->>'solana_address' AS addr,
			       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis
			FROM agent_identities ai
			LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
			WHERE ai.id::text = ANY(${agentIds})
		`
		: [];
	const agentById = new Map(agentRows.map((a) => [a.id, a]));

	// Assemble nodes from the edges so the two collections can never disagree.
	const nodes = new Map();
	const nodeFor = (key, agentId, addr) => {
		const existing = nodes.get(key);
		if (existing) return existing;
		const agent = agentId ? agentById.get(agentId) : null;
		const address = agent?.addr || addr || null;
		const node = {
			id: key,
			kind: agent ? 'agent' : 'wallet',
			agent_id: agent?.id || null,
			name: agent?.name || shortAddr(addr),
			url: agent ? `/agents/${agent.id}` : null,
			avatar_thumbnail_url: agent
				? r2Url(agent.thumb_key, agent.avatar_vis === 'public' || agent.avatar_vis === 'unlisted')
				: null,
			address,
			address_short: shortAddr(address),
			explorer: address ? explorerAccountUrl(address, network) : null,
			in_usd: 0, out_usd: 0, in_sol: 0, out_sol: 0, in_count: 0, out_count: 0,
			partners_in: 0, partners_out: 0,
		};
		nodes.set(key, node);
		return node;
	};

	// Service totals come from their own aggregation, never from the edges: one
	// edge can cover several skills, so folding its USD into each of them would
	// report more revenue per service than actually settled.
	const serviceRows = await sql`
		SELECT NULLIF(ce.meta->>'service', '') AS name,
		       COUNT(*)::int                   AS count,
		       COALESCE(SUM(ce.usd), 0)::float8 AS usd
		FROM agent_custody_events ce
		JOIN agent_identities payer
		  ON payer.id = ce.agent_id
		 AND payer.deleted_at IS NULL AND payer.is_public = true
		 AND COALESCE((payer.meta->>'pulse_opt_out')::boolean, false) = false
		WHERE ce.network = ${network}
		  AND ce.event_type = 'spend' AND ce.category = 'x402'
		  AND ce.status IN ('ok', 'confirmed')
		  AND NULLIF(ce.meta->>'service', '') IS NOT NULL
		  AND ce.created_at > now() - ${interval}::interval
		GROUP BY 1
		ORDER BY usd DESC
	`;

	const edges = edgeRows.map((r) => {
		const sol = Number(r.lamports || 0) / 1e9;
		const usd = Number(r.usd || 0);
		const from = nodeFor(r.from_key, r.from_agent, r.from_addr);
		const to = nodeFor(r.to_key, r.to_agent, r.to_addr);
		from.out_usd += usd; from.out_sol += sol; from.out_count += r.count; from.partners_out += 1;
		to.in_usd += usd;    to.in_sol += sol;    to.in_count += r.count;    to.partners_in += 1;
		return {
			from: r.from_key,
			to: r.to_key,
			count: r.count,
			sol,
			usd,
			kinds: r.kinds || [],
			services: r.services || [],
			last_ts: r.last_ts,
			last_signature: r.last_signature || null,
			explorer: r.last_signature ? explorerTxUrl(r.last_signature, network) : null,
		};
	});

	const nodeList = [...nodes.values()];
	return {
		network,
		window: GRAPH_WINDOWS[windowKey] ? windowKey : '30d',
		generated_at: new Date().toISOString(),
		nodes: nodeList,
		edges,
		services: serviceRows.map((s) => ({ name: s.name, count: s.count, usd: Number(s.usd || 0) })),
		totals: {
			nodes: nodeList.length,
			edges: edges.length,
			transfers: edges.reduce((n, e) => n + e.count, 0),
			usd: edges.reduce((n, e) => n + e.usd, 0),
			sol: edges.reduce((n, e) => n + e.sol, 0),
			payments: edges.filter((e) => e.kinds.includes('payment')).reduce((n, e) => n + e.count, 0),
			tips: edges.filter((e) => e.kinds.includes('tip')).reduce((n, e) => n + e.count, 0),
			named_agents: nodeList.filter((n) => n.kind === 'agent').length,
		},
		// Honest about its own limits: a capped graph must never read as the whole economy.
		truncated,
		max_edges: GRAPH_MAX_EDGES,
	};
}

// ── aggregate stats view ──────────────────────────────────────────────────────
async function handleStats(network) {
	// Public-agent gate, reused across every aggregate below so each counter honours
	// the same privacy contract as the live feed (no deleted, no private, no opt-out).
	const pubAgent = sql`ai.deleted_at IS NULL AND ai.is_public = true
		AND COALESCE((ai.meta->>'pulse_opt_out')::boolean, false) = false`;

	// 24h tip flow (count + SOL + USD where priced), platform-wide, public agents.
	const [tip24] = await sql`
		SELECT
			COUNT(*)::int                                          AS count,
			COALESCE(SUM(ce.amount_lamports), 0)::text             AS lamports,
			COALESCE(SUM(ce.usd), 0)::float8                       AS usd
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
		WHERE ce.network = ${network} AND ce.event_type = 'tip'
		  AND ce.status IN ('ok', 'confirmed')
		  AND ce.created_at > now() - interval '24 hours'
	`;

	// Top earning agents by tips received (rolling 7d). Lifetime would bury new
	// agents under early movers; 7d keeps "who's hot right now" honest.
	const topEarners = await sql`
		SELECT ai.id AS agent_id, ai.name AS agent_name,
		       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis,
		       ai.meta->>'solana_address' AS agent_addr,
		       COUNT(*)::int AS tip_count,
		       COALESCE(SUM(ce.amount_lamports), 0)::text AS lamports,
		       COALESCE(SUM(ce.usd), 0)::float8 AS usd
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ce.network = ${network} AND ce.event_type = 'tip'
		  AND ce.status IN ('ok', 'confirmed')
		  AND ce.created_at > now() - interval '7 days'
		GROUP BY ai.id, ai.name, av.thumbnail_key, av.visibility, ai.meta->>'solana_address'
		ORDER BY SUM(COALESCE(ce.usd, ce.amount_lamports / 1e9 * 0)) DESC NULLS LAST,
		         SUM(ce.amount_lamports) DESC NULLS LAST
		LIMIT 6
	`;

	// Busiest wallets — most public events (any kind) in the last 24h.
	const busiest = await sql`
		SELECT ai.id AS agent_id, ai.name AS agent_name,
		       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis,
		       ai.meta->>'solana_address' AS agent_addr,
		       COUNT(*)::int AS events
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ce.network = ${network}
		  AND ce.status IN ('ok', 'confirmed')
		  AND (ce.event_type = 'tip' OR (ce.event_type = 'spend' AND ce.category = ANY(${PUBLIC_SPEND_CATEGORIES})))
		  AND ce.created_at > now() - interval '24 hours'
		GROUP BY ai.id, ai.name, av.thumbnail_key, av.visibility, ai.meta->>'solana_address'
		ORDER BY COUNT(*) DESC
		LIMIT 6
	`;

	const [launch24] = await sql`
		SELECT COUNT(*)::int AS count
		FROM pump_agent_mints pam
		JOIN agent_identities ai ON ai.id = pam.agent_id AND ${pubAgent}
		WHERE pam.network = ${network} AND pam.created_at > now() - interval '24 hours'
	`;

	// 24h money tempo in one pass: total volume (SOL + priced USD), distinct active
	// wallets, and the trade/snipe/payment breakdown — so each spend category gets
	// its own honest counter instead of being lumped together.
	const [tempo24] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE ce.event_type = 'spend' AND ce.category = 'trade')::int  AS trades,
			COUNT(*) FILTER (WHERE ce.event_type = 'spend' AND ce.category = 'snipe')::int  AS snipes,
			COUNT(*) FILTER (WHERE ce.event_type = 'spend' AND ce.category = 'x402')::int   AS payments,
			COUNT(DISTINCT ce.agent_id)::int                                               AS active_wallets,
			COALESCE(SUM(ce.amount_lamports), 0)::text                                     AS lamports,
			COALESCE(SUM(ce.usd), 0)::float8                                               AS usd
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
		WHERE ce.network = ${network}
		  AND ce.status IN ('ok', 'confirmed')
		  AND (ce.event_type = 'tip' OR (ce.event_type = 'spend' AND ce.category = ANY(${PUBLIC_SPEND_CATEGORIES})))
		  AND ce.created_at > now() - interval '24 hours'
	`;

	// 24h marketplace demand — REAL skill purchases settled in $THREE. This is the
	// honest viability signal: value is delivered AND the platform earns a take-rate,
	// unlike the x402 counter which only measures agent-to-agent settlement plumbing.
	// Sourced from skill_purchases (the same table /marketplace confirms against).
	// Same "real sale" predicate as handleMarketplace(): money and party counts must
	// agree on which rows are sales, or a non-paid confirmed row inflates one side.
	const paidRow24 = sql`sp.status = 'confirmed' AND sp.kind = ANY(${MARKET_PAID_KINDS})`;
	const [mkt24] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE ${paidRow24})::int                                  AS purchases,
			COUNT(*) FILTER (WHERE sp.kind = 'trial')::int                             AS trials,
			COALESCE(SUM(sp.amount) FILTER (WHERE ${paidRow24}), 0)::text              AS gmv_atomic,
			COUNT(DISTINCT sp.user_id) FILTER (WHERE ${paidRow24})::int                AS buyers,
			COUNT(DISTINCT sp.agent_id) FILTER (WHERE ${paidRow24})::int               AS sellers
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
		WHERE sp.currency_mint = ${THREE_MINT} AND sp.chain = 'solana'
		  AND sp.created_at > now() - interval '24 hours'
	`;

	// The single biggest tip of the last 24h — the day's headline moment.
	const [bigTip] = await sql`
		SELECT ai.id AS agent_id, ai.name AS agent_name,
		       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis,
		       ai.meta->>'solana_address' AS agent_addr,
		       ce.amount_lamports::text AS lamports, ce.usd::float8 AS usd, ce.created_at AS ts
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ce.network = ${network} AND ce.event_type = 'tip'
		  AND ce.status IN ('ok', 'confirmed')
		  AND ce.created_at > now() - interval '24 hours'
		ORDER BY COALESCE(ce.usd, ce.amount_lamports / 1e9) DESC NULLS LAST
		LIMIT 1
	`;

	// Freshest coins off the launcher — real records from pump_agent_mints.
	const recentLaunches = await sql`
		SELECT pam.mint, pam.symbol, pam.name AS coin_name, pam.created_at AS ts,
		       ai.id AS agent_id, ai.name AS agent_name,
		       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis,
		       ai.meta->>'solana_address' AS agent_addr
		FROM pump_agent_mints pam
		JOIN agent_identities ai ON ai.id = pam.agent_id AND ${pubAgent}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE pam.network = ${network}
		ORDER BY pam.created_at DESC
		LIMIT 5
	`;

	// 7-day daily pulse — a zero-filled series the page renders as a sparkline so the
	// headline isn't a single flat number. Wallet events + launches, per UTC day.
	const series = await sql`
		WITH days AS (
			SELECT generate_series(
				date_trunc('day', now()) - interval '6 days',
				date_trunc('day', now()),
				interval '1 day'
			) AS day
		),
		ev AS (
			SELECT date_trunc('day', ce.created_at) AS day, COUNT(*)::int AS n
			FROM agent_custody_events ce
			JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
			WHERE ce.network = ${network}
			  AND ce.status IN ('ok', 'confirmed')
			  AND (ce.event_type = 'tip' OR (ce.event_type = 'spend' AND ce.category = ANY(${PUBLIC_SPEND_CATEGORIES})))
			  AND ce.created_at > date_trunc('day', now()) - interval '6 days'
			GROUP BY 1
		),
		lc AS (
			SELECT date_trunc('day', pam.created_at) AS day, COUNT(*)::int AS n
			FROM pump_agent_mints pam
			JOIN agent_identities ai ON ai.id = pam.agent_id AND ${pubAgent}
			WHERE pam.network = ${network}
			  AND pam.created_at > date_trunc('day', now()) - interval '6 days'
			GROUP BY 1
		)
		SELECT to_char(days.day, 'Dy')         AS label,
		       to_char(days.day, 'YYYY-MM-DD')  AS day,
		       COALESCE(ev.n, 0)                AS events,
		       COALESCE(lc.n, 0)                AS launches
		FROM days
		LEFT JOIN ev ON ev.day = days.day
		LEFT JOIN lc ON lc.day = days.day
		ORDER BY days.day
	`;

	const shapeAgent = (r) => ({
		id: r.agent_id,
		name: r.agent_name || 'Agent',
		url: `/agents/${r.agent_id}`,
		avatar_thumbnail_url: r2Url(r.thumb_key, r.avatar_vis === 'public' || r.avatar_vis === 'unlisted'),
		solana_address: r.agent_addr || null,
		tip_count: r.tip_count != null ? Number(r.tip_count) : undefined,
		events: r.events != null ? Number(r.events) : undefined,
		sol: r.lamports != null ? Number(r.lamports) / 1e9 : undefined,
		usd: r.usd != null ? Number(r.usd) : undefined,
	});

	const trades = Number(tempo24?.trades || 0);
	const snipes = Number(tempo24?.snipes || 0);
	const payments = Number(tempo24?.payments || 0);

	return {
		network,
		tips_24h: {
			count: Number(tip24?.count || 0),
			sol: Number(tip24?.lamports || 0) / 1e9,
			usd: Number(tip24?.usd || 0),
		},
		launches_24h: Number(launch24?.count || 0),
		// Kept for backward-compat: the combined swap/snipe/payment count.
		trades_24h: trades + snipes + payments,
		trades_only_24h: trades,
		snipes_24h: snipes,
		payments_24h: payments,
		// Real marketplace demand — paid skill purchases settled in $THREE. The honest
		// counterpart to payments_24h: every unit here delivered value and earned a fee.
		marketplace_24h: {
			purchases: Number(mkt24?.purchases || 0),
			trials: Number(mkt24?.trials || 0),
			gmv_three: threeFromAtomic(mkt24?.gmv_atomic),
			buyers: Number(mkt24?.buyers || 0),
			sellers: Number(mkt24?.sellers || 0),
		},
		active_wallets_24h: Number(tempo24?.active_wallets || 0),
		volume_24h: {
			sol: Number(tempo24?.lamports || 0) / 1e9,
			usd: Number(tempo24?.usd || 0),
		},
		biggest_tip_24h: bigTip
			? {
					agent: shapeAgent(bigTip),
					sol: Number(bigTip.lamports || 0) / 1e9,
					usd: bigTip.usd != null ? Number(bigTip.usd) : null,
					ts: bigTip.ts,
				}
			: null,
		series_7d: series.map((r) => ({
			label: r.label,
			day: r.day,
			events: Number(r.events || 0),
			launches: Number(r.launches || 0),
		})),
		recent_launches: recentLaunches.map((r) => ({
			mint: r.mint,
			symbol: r.symbol || null,
			coin_name: r.coin_name || null,
			ts: r.ts,
			mint_explorer: r.mint ? explorerAccountUrl(r.mint, network) : null,
			agent: shapeAgent(r),
		})),
		top_earners: topEarners.map(shapeAgent),
		busiest_wallets: busiest.map(shapeAgent),
	};
}

// ── per-agent lifetime summary ─────────────────────────────────────────────────
async function handleAgentSummary(network, agentId) {
	const [agent] = await sql`
		SELECT id, name, deleted_at, is_public FROM agent_identities WHERE id = ${agentId}
	`;
	// Private/deleted agents expose no public summary — matches the feed gate.
	if (!agent || agent.deleted_at || agent.is_public === false) return null;

	const [tips] = await sql`
		SELECT COUNT(*)::int AS count,
		       COALESCE(SUM(amount_lamports), 0)::text AS lamports,
		       COALESCE(SUM(usd), 0)::float8 AS usd,
		       COALESCE(MAX(amount_lamports), 0)::text AS biggest_lamports,
		       COALESCE(MAX(usd), 0)::float8 AS biggest_usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND event_type = 'tip' AND status IN ('ok', 'confirmed')
	`;
	// Public outflow = trades + snipes + agent-to-agent payments (never withdraws).
	const [outflow] = await sql`
		SELECT COUNT(*)::int AS count,
		       COALESCE(SUM(amount_lamports), 0)::text AS lamports,
		       COALESCE(SUM(usd), 0)::float8 AS usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND event_type = 'spend' AND category = ANY(${PUBLIC_SPEND_CATEGORIES})
		  AND status IN ('ok', 'confirmed')
	`;
	const [launches] = await sql`
		SELECT COUNT(*)::int AS count FROM pump_agent_mints
		WHERE agent_id = ${agentId} AND network = ${network}
	`;

	return {
		agent_id: agentId,
		network,
		tips: {
			count: Number(tips?.count || 0),
			sol: Number(tips?.lamports || 0) / 1e9,
			usd: Number(tips?.usd || 0),
			biggest_sol: Number(tips?.biggest_lamports || 0) / 1e9,
			biggest_usd: Number(tips?.biggest_usd || 0),
		},
		outflow: {
			count: Number(outflow?.count || 0),
			sol: Number(outflow?.lamports || 0) / 1e9,
			usd: Number(outflow?.usd || 0),
		},
		launches: Number(launches?.count || 0),
	};
}

// ── marketplace viability dashboard ────────────────────────────────────────────
// The numbers that actually answer "is agent-to-agent commerce viable?" — not raw
// payment count (vanity) but GMV, repeat-buyer rate, unique trading pairs, average
// ticket and the platform take-rate. All sourced from real, confirmed skill_purchases
// rows (each backed by an on-chain $THREE transfer), gated to public seller agents.
async function handleMarketplace(network) {
	const pubAgent = sql`ai.deleted_at IS NULL AND ai.is_public = true
		AND COALESCE((ai.meta->>'pulse_opt_out')::boolean, false) = false`;
	const feeBps = marketplaceFeeBps();

	// One definition of "a real marketplace sale", shared by EVERY money and party
	// aggregate below. It has to be shared: filtering the counts on status+kind but
	// the money on status alone is what let non-sale rows (a trial, or a bundle
	// access record, both of which are 'confirmed' but not a paid kind) land in
	// gmv/fees/buyers/sellers while being excluded from the purchase count. That
	// also skewed avg_ticket, which divides a GMV by a count that excluded part of
	// what produced it. These are published on a transparency page, so they are
	// derived from one predicate rather than kept in sync by hand.
	const paidRow = sql`sp.status = 'confirmed' AND sp.kind = ANY(${MARKET_PAID_KINDS})`;

	// One windowed aggregate, reused for 24h and 7d so both cards read identically.
	const windowAgg = async (interval) => {
		const [r] = await sql`
			SELECT
				COUNT(*) FILTER (WHERE ${paidRow})::int                                    AS purchases,
				-- Deliberately status-free: this counts trials STARTED in the window, so a
				-- trial that has since lapsed still counts. It is a demand signal, not money.
				COUNT(*) FILTER (WHERE sp.kind = 'trial')::int                             AS trials,
				COALESCE(SUM(sp.amount) FILTER (WHERE ${paidRow}), 0)::text                AS gmv_atomic,
				COUNT(DISTINCT sp.user_id) FILTER (WHERE ${paidRow})::int                  AS buyers,
				COUNT(DISTINCT sp.agent_id) FILTER (WHERE ${paidRow})::int                 AS sellers,
				COUNT(DISTINCT (sp.user_id, sp.agent_id)) FILTER (WHERE ${paidRow})::int   AS pairs,
				COALESCE(SUM(sp.platform_fee_amount) FILTER (WHERE ${paidRow}), 0)::text   AS fee_atomic
			FROM skill_purchases sp
			JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
			WHERE sp.currency_mint = ${THREE_MINT} AND sp.chain = 'solana'
			  AND sp.created_at > now() - ${interval}::interval
		`;
		const purchases = Number(r?.purchases || 0);
		const gmv = threeFromAtomic(r?.gmv_atomic);
		// Take-rate is the fee ACTUALLY charged on-chain (persisted per row by the
		// purchase splitter), never a GMV × rate estimate — so the number is real
		// even when some purchases predate the fee or skipped it.
		return {
			purchases,
			trials: Number(r?.trials || 0),
			gmv_three: gmv,
			buyers: Number(r?.buyers || 0),
			sellers: Number(r?.sellers || 0),
			pairs: Number(r?.pairs || 0),
			avg_ticket_three: purchases > 0 ? gmv / purchases : 0,
			take_rate_three: threeFromAtomic(r?.fee_atomic),
		};
	};

	// Repeat-buyer rate (7d): the single strongest viability signal — do buyers come
	// back, or is every purchase a one-off? Counts buyers with ≥2 paid purchases.
	const repeatPromise = sql`
		WITH b AS (
			SELECT sp.user_id, COUNT(*) AS n
			FROM skill_purchases sp
			JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
			WHERE sp.currency_mint = ${THREE_MINT} AND sp.chain = 'solana'
			  AND sp.status = 'confirmed' AND sp.kind = ANY(${MARKET_PAID_KINDS})
			  AND sp.created_at > now() - interval '7 days'
			GROUP BY sp.user_id
		)
		SELECT COUNT(*)::int AS buyers, COUNT(*) FILTER (WHERE n >= 2)::int AS repeat_buyers FROM b
	`;

	// Top skills by 7d GMV — what is the market actually paying for?
	const topSkillsPromise = sql`
		SELECT sp.skill,
		       COUNT(*)::int                       AS purchases,
		       COALESCE(SUM(sp.amount), 0)::text    AS gmv_atomic,
		       COUNT(DISTINCT sp.user_id)::int      AS buyers
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
		WHERE sp.currency_mint = ${THREE_MINT} AND sp.chain = 'solana'
		  AND sp.status = 'confirmed' AND sp.kind = ANY(${MARKET_PAID_KINDS})
		  AND sp.created_at > now() - interval '7 days'
		GROUP BY sp.skill
		ORDER BY SUM(sp.amount) DESC NULLS LAST
		LIMIT 6
	`;

	// Top sellers by 7d earnings — the supply side that's actually clearing.
	const topSellersPromise = sql`
		SELECT ai.id AS agent_id, ai.name AS agent_name,
		       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis,
		       ai.meta->>'solana_address' AS agent_addr,
		       COUNT(*)::int AS sales, COALESCE(SUM(sp.amount), 0)::text AS gmv_atomic
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE sp.currency_mint = ${THREE_MINT} AND sp.chain = 'solana'
		  AND sp.status = 'confirmed' AND sp.kind = ANY(${MARKET_PAID_KINDS})
		  AND sp.created_at > now() - interval '7 days'
		GROUP BY ai.id, ai.name, av.thumbnail_key, av.visibility, ai.meta->>'solana_address'
		ORDER BY SUM(sp.amount) DESC NULLS LAST
		LIMIT 6
	`;

	// 7-day GMV + purchase sparkline, zero-filled per UTC day.
	const seriesPromise = sql`
		WITH days AS (
			SELECT generate_series(
				date_trunc('day', now()) - interval '6 days',
				date_trunc('day', now()),
				interval '1 day'
			) AS day
		),
		ev AS (
			SELECT date_trunc('day', sp.created_at) AS day,
			       COUNT(*) FILTER (WHERE ${paidRow})::int                       AS purchases,
			       COALESCE(SUM(sp.amount) FILTER (WHERE ${paidRow}), 0)::text   AS gmv_atomic
			FROM skill_purchases sp
			JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
			WHERE sp.currency_mint = ${THREE_MINT} AND sp.chain = 'solana'
			  AND sp.created_at > date_trunc('day', now()) - interval '6 days'
			GROUP BY 1
		)
		SELECT to_char(days.day, 'Dy') AS label, to_char(days.day, 'YYYY-MM-DD') AS day,
		       COALESCE(ev.purchases, 0) AS purchases, COALESCE(ev.gmv_atomic, '0') AS gmv_atomic
		FROM days LEFT JOIN ev ON ev.day = days.day
		ORDER BY days.day
	`;

	const [d24, d7, [repeat], topSkills, topSellers, series] = await Promise.all([
		windowAgg('24 hours'),
		windowAgg('7 days'),
		repeatPromise,
		topSkillsPromise,
		topSellersPromise,
		seriesPromise,
	]);

	const buyers7 = Number(repeat?.buyers || 0);
	const repeatBuyers7 = Number(repeat?.repeat_buyers || 0);

	return {
		network,
		fee_bps: feeBps,
		fee_pct: feeBps / 100,
		window_24h: d24,
		window_7d: d7,
		repeat_buyer_rate_7d: buyers7 > 0 ? repeatBuyers7 / buyers7 : 0,
		repeat_buyers_7d: repeatBuyers7,
		buyers_7d: buyers7,
		series_7d: series.map((r) => ({
			label: r.label,
			day: r.day,
			purchases: Number(r.purchases || 0),
			gmv_three: threeFromAtomic(r.gmv_atomic),
		})),
		top_skills: topSkills.map((r) => ({
			skill: r.skill,
			purchases: Number(r.purchases || 0),
			buyers: Number(r.buyers || 0),
			gmv_three: threeFromAtomic(r.gmv_atomic),
		})),
		top_sellers: topSellers.map((r) => ({
			id: r.agent_id,
			name: r.agent_name || 'Agent',
			url: `/agents/${r.agent_id}`,
			avatar_thumbnail_url: r2Url(r.thumb_key, r.avatar_vis === 'public' || r.avatar_vis === 'unlisted'),
			solana_address: r.agent_addr || null,
			sales: Number(r.sales || 0),
			gmv_three: threeFromAtomic(r.gmv_atomic),
		})),
	};
}

// ── trading viability dashboard ────────────────────────────────────────────────
// The numbers that answer "is funded agent trading actually happening, what does it
// cost, and is it making money?" Activity + cost come from agent_custody_events
// (category='trade' — the exact source the headline Trades counter reconciles with,
// so the panel can never drift from it). Realized P&L comes from CLOSED positions in
// the strategy + sniper position tables, where exit-minus-entry is computed against
// real fills. Heartbeat buys that never close show up as cost with no P&L — which is
// the honest story: profitability lives in positions that round-trip, not in volume.
async function handleTrading(network) {
	const pubAgent = sql`ai.deleted_at IS NULL AND ai.is_public = true
		AND COALESCE((ai.meta->>'pulse_opt_out')::boolean, false) = false`;

	// One windowed aggregate over the custody ledger, reused for 24h + 7d. Buys carry
	// SOL out in amount_lamports (asset='SOL'); sells carry only token base units, so
	// "SOL deployed" = SUM(amount_lamports) is exactly the SOL spent acquiring coins.
	const windowAgg = async (interval) => {
		const [r] = await sql`
			SELECT
				COUNT(*)::int                                                AS trades,
				COUNT(*) FILTER (WHERE ce.amount_lamports IS NOT NULL)::int  AS buys,
				COUNT(*) FILTER (WHERE ce.amount_lamports IS NULL)::int      AS sells,
				COALESCE(SUM(ce.amount_lamports), 0)::text                   AS deployed_lamports,
				COALESCE(SUM(ce.usd), 0)::float8                             AS deployed_usd,
				COUNT(DISTINCT ce.agent_id)::int                             AS traders
			FROM agent_custody_events ce
			JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
			WHERE ce.network = ${network}
			  AND ce.event_type = 'spend' AND ce.category = 'trade'
			  AND ce.status IN ('ok', 'confirmed')
			  AND ce.created_at > now() - ${interval}::interval
		`;
		return shapeTradingWindow(r);
	};

	// Realized P&L over 7d from CLOSED positions across both real position tables.
	// `realized_pnl_lamports` is signed (exit − entry); a win is strictly positive.
	const pnlPromise = sql`
		WITH closed AS (
			SELECT sp.realized_pnl_lamports AS pnl
			FROM agent_strategy_positions sp
			JOIN agent_identities ai ON ai.id = sp.agent_id AND ${pubAgent}
			WHERE sp.network = ${network} AND sp.status = 'closed'
			  AND sp.realized_pnl_lamports IS NOT NULL
			  AND sp.closed_at > now() - interval '7 days'
			UNION ALL
			SELECT snp.realized_pnl_lamports AS pnl
			FROM agent_sniper_positions snp
			JOIN agent_identities ai ON ai.id = snp.agent_id AND ${pubAgent}
			WHERE snp.network = ${network} AND snp.status = 'closed'
			  AND snp.realized_pnl_lamports IS NOT NULL
			  AND snp.closed_at > now() - interval '7 days'
		)
		SELECT COUNT(*)::int                              AS closed_count,
		       COUNT(*) FILTER (WHERE pnl > 0)::int       AS wins,
		       COALESCE(SUM(pnl), 0)::text                AS net_lamports
		FROM closed
	`;

	// Top trading agents (7d) by trade count, then SOL deployed — the wallets actually
	// putting capital to work. Same public-agent gate as every other rail.
	const topTradersPromise = sql`
		SELECT ai.id AS agent_id, ai.name AS agent_name,
		       av.thumbnail_key AS thumb_key, av.visibility AS avatar_vis,
		       ai.meta->>'solana_address' AS agent_addr,
		       COUNT(*)::int AS trades,
		       COALESCE(SUM(ce.amount_lamports), 0)::text AS deployed_lamports
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ce.network = ${network}
		  AND ce.event_type = 'spend' AND ce.category = 'trade'
		  AND ce.status IN ('ok', 'confirmed')
		  AND ce.created_at > now() - interval '7 days'
		GROUP BY ai.id, ai.name, av.thumbnail_key, av.visibility, ai.meta->>'solana_address'
		ORDER BY COUNT(*) DESC, SUM(ce.amount_lamports) DESC NULLS LAST
		LIMIT 6
	`;

	// 7-day trade-count + SOL-deployed sparkline, zero-filled per UTC day.
	const seriesPromise = sql`
		WITH days AS (
			SELECT generate_series(
				date_trunc('day', now()) - interval '6 days',
				date_trunc('day', now()),
				interval '1 day'
			) AS day
		),
		ev AS (
			SELECT date_trunc('day', ce.created_at) AS day,
			       COUNT(*)::int AS trades,
			       COALESCE(SUM(ce.amount_lamports), 0)::text AS deployed_lamports
			FROM agent_custody_events ce
			JOIN agent_identities ai ON ai.id = ce.agent_id AND ${pubAgent}
			WHERE ce.network = ${network}
			  AND ce.event_type = 'spend' AND ce.category = 'trade'
			  AND ce.status IN ('ok', 'confirmed')
			  AND ce.created_at > date_trunc('day', now()) - interval '6 days'
			GROUP BY 1
		)
		SELECT to_char(days.day, 'Dy') AS label, to_char(days.day, 'YYYY-MM-DD') AS day,
		       COALESCE(ev.trades, 0) AS trades, COALESCE(ev.deployed_lamports, '0') AS deployed_lamports
		FROM days LEFT JOIN ev ON ev.day = days.day
		ORDER BY days.day
	`;

	const [d24, d7, [pnl], topTraders, series] = await Promise.all([
		windowAgg('24 hours'),
		windowAgg('7 days'),
		pnlPromise,
		topTradersPromise,
		seriesPromise,
	]);

	return {
		network,
		window_24h: d24,
		window_7d: d7,
		realized_pnl_7d: shapeTradingPnl(pnl),
		series_7d: shapeTradingSeries(series),
		top_traders: topTraders.map((r) => ({
			id: r.agent_id,
			name: r.agent_name || 'Agent',
			url: `/agents/${r.agent_id}`,
			avatar_thumbnail_url: r2Url(r.thumb_key, r.avatar_vis === 'public' || r.avatar_vis === 'unlisted'),
			solana_address: r.agent_addr || null,
			trades: Number(r.trades || 0),
			deployed_sol: solFromLamports(r.deployed_lamports),
		})),
	};
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const view = url.searchParams.get('view') || 'feed';
	const agentId = url.searchParams.get('agent_id') || null;
	if (agentId && !isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a uuid');
	const mint = url.searchParams.get('mint') || null;
	if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return error(res, 400, 'validation_error', 'mint must be a base58 address');
	const typeRaw = url.searchParams.get('type') || 'all';
	const type = TYPE_KINDS[typeRaw] ? typeRaw : 'all';
	const cursor = url.searchParams.get('cursor');
	const since = url.searchParams.get('since');

	try {
		if (view === 'stats') {
			const cacheKey = `pulse:stats:${network}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleStats(network);
				await cacheSet(cacheKey, body, STATS_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=20');
			return json(res, 200, { data: body });
		}

		if (view === 'marketplace') {
			const cacheKey = `pulse:marketplace:${network}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleMarketplace(network);
				await cacheSet(cacheKey, body, STATS_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=20');
			return json(res, 200, { data: body });
		}

		if (view === 'trading') {
			const cacheKey = `pulse:trading:${network}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleTrading(network);
				await cacheSet(cacheKey, body, STATS_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=20');
			return json(res, 200, { data: body });
		}

		if (view === 'graph') {
			const windowKey = GRAPH_WINDOWS[url.searchParams.get('window')]
				? url.searchParams.get('window')
				: '30d';
			const cacheKey = `pulse:graph:${network}:${windowKey}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleGraph(network, windowKey);
				await cacheSet(cacheKey, body, GRAPH_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=30');
			return json(res, 200, { data: body });
		}

		if (view === 'agent-summary') {
			if (!agentId) return error(res, 400, 'validation_error', 'agent_id is required for agent-summary');
			const body = await handleAgentSummary(network, agentId);
			if (!body) return error(res, 404, 'not_found', 'agent not found');
			res.setHeader('cache-control', 'public, max-age=20');
			return json(res, 200, { data: body });
		}

		// Default: feed. A delta poll (`since`) is never cached — it must be live.
		// A first page (no cursor/since) of the GLOBAL feed is cached briefly to
		// shield the DB from a thundering herd of pollers.
		const isFirstGlobalPage = !cursor && !since && !agentId && !mint;
		if (isFirstGlobalPage) {
			// `limit` is part of the cache key: handleFeed returns exactly `limit` rows
			// (plus has_more / next_cursor computed from it), so two callers asking for
			// different page sizes must NOT share a cached body. Omitting it let a
			// limit=1 self-heal probe poison the shared feed page with a 1-row body.
			// Clamp identically to handleFeed so the key matches the body it produced.
			const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || 30));
			const cacheKey = `pulse:feed:${network}:${type}:${limit}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleFeed(req, res, { network, type, agentId, mint, cursor, since });
				await cacheSet(cacheKey, body, FEED_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=8');
			return json(res, 200, { data: body });
		}

		const body = await handleFeed(req, res, { network, type, agentId, mint, cursor, since });
		return json(res, 200, { data: body });
	} catch (e) {
		if (isDbUnavailableError(e)) {
			console.warn('[api/pulse] db unavailable:', e?.message);
			return serverError(res, 503, 'service_unavailable', e);
		}
		console.error('[api/pulse] failed', e?.message, e?.stack);
		return serverError(res, 502, 'pulse_failed', e);
	}
}
