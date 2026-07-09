import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publicUrl } from '../_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const username = (req.query.username || '').toLowerCase().trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [user] = await sql`
		select id, display_name, username, created_at, wallet_address,
		       bio, website, location, avatar_url, banner_url
		from users
		where lower(username) = ${username} and deleted_at is null
		limit 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	const [
		avatarRows,
		agentRows,
		widgetRows,
		skillRows,
		pluginRows,
		coinRows,
		memoryRows,
		socialRows,
		statsRow,
		shopRows,
	] = await Promise.all([
		sql`
			select id, name, slug, description, storage_key, thumbnail_key, tags,
			       source, size_bytes, version, fork_count, parent_avatar_id, created_at
			from avatars
			where owner_id = ${user.id}
			  and visibility = 'public'
			  and deleted_at is null
			order by created_at desc
			limit 48
		`,
		sql`
			select id, name, description, avatar_url, profile_image_url, home_url,
			       wallet_address, chain_id, erc8004_agent_id, x_username,
			       farcaster_fname, created_at, is_published, forks_count, fork_of,
			       meta->>'solana_address' as solana_address,
			       meta->>'sns_domain'     as sns_domain,
			       meta->'onchain'         as onchain,
			       meta->'token'           as token
			from agent_identities
			where user_id = ${user.id}
			  and is_public = true
			  and deleted_at is null
			order by created_at desc
			limit 48
		`,
		sql`
			select id, type, name, avatar_id, view_count, is_public, created_at
			from widgets
			where user_id = ${user.id}
			  and is_public = true
			  and deleted_at is null
			order by view_count desc, created_at desc
			limit 24
		`,
		sql`
			select id, slug, name, description, category, tags, install_count,
			       price_per_call_usd, created_at
			from marketplace_skills
			where author_id = ${user.id}
			  and is_public = true
			order by install_count desc, created_at desc
			limit 24
		`,
		sql`
			select id, identifier, name, description, category, tags,
			       install_count, avg_rating, rating_count, created_at
			from plugins
			where author_id = ${user.id}
			  and is_public = true
			  and deleted_at is null
			order by install_count desc, created_at desc
			limit 24
		`,
		// Coins the user has launched. Each launch is recorded on the agent that
		// minted it, in meta.token. Surface only public agents with a confirmed
		// mint, newest first.
		sql`
			select id as agent_id, name as agent_name, profile_image_url, avatar_url,
			       meta->'token' as token
			from agent_identities
			where user_id = ${user.id}
			  and is_public = true
			  and deleted_at is null
			  and meta->'token'->>'mint' is not null
			order by coalesce(meta->'token'->>'launched_at', created_at::text) desc
			limit 48
		`,
		// Public memories the owner has explicitly opted to showcase, surfaced
		// through their public agents. Private memories (the default) never leave
		// the owner's own view.
		sql`
			select m.id, m.type, m.content, m.tags, m.created_at,
			       a.id as agent_id, a.name as agent_name
			from agent_memories m
			join agent_identities a on a.id = m.agent_id
			where a.user_id = ${user.id}
			  and a.is_public = true
			  and a.deleted_at is null
			  and m.is_public = true
			  and (m.expires_at is null or m.expires_at > now())
			order by m.created_at desc
			limit 48
		`,
		sql`
			select provider, username
			from social_connections
			where user_id = ${user.id}
			  and disconnected_at is null
		`,
		sql`
			select
			  (select count(*)::int from avatars
			    where owner_id = ${user.id} and visibility = 'public' and deleted_at is null) as avatars_count,
			  (select count(*)::int from agent_identities
			    where user_id = ${user.id} and is_public = true and deleted_at is null) as agents_count,
			  (select count(*)::int from widgets
			    where user_id = ${user.id} and is_public = true and deleted_at is null) as widgets_count,
			  (select count(*)::int from marketplace_skills
			    where author_id = ${user.id} and is_public = true) as skills_count,
			  (select count(*)::int from plugins
			    where author_id = ${user.id} and is_public = true and deleted_at is null) as plugins_count,
			  (select count(*)::int from agent_identities
			    where user_id = ${user.id} and is_public = true and deleted_at is null
			      and meta->'token'->>'mint' is not null) as coins_count,
			  (select count(*)::int from agent_memories m
			    join agent_identities a on a.id = m.agent_id
			    where a.user_id = ${user.id} and a.is_public = true and a.deleted_at is null
			      and m.is_public = true and (m.expires_at is null or m.expires_at > now())) as memories_count,
			  (select coalesce(sum(view_count), 0)::bigint from widgets
			    where user_id = ${user.id} and is_public = true and deleted_at is null) as total_widget_views
		`,
		// Items for sale: one-time-priced assets the user actively lists. The price
		// of record lives in asset_prices (item_type ∈ avatar|agent|plugin); join
		// each item type to pull a display name + thumbnail. Soft-deleted items are
		// excluded so a delisted asset never renders a dead card.
		sql`
			select ap.item_type, ap.item_id::text as item_id, ap.amount::text as amount,
			       ap.currency_mint, ap.chain, ap.mint_decimals, ap.updated_at,
			       av.name as avatar_name, av.slug as avatar_slug, av.thumbnail_key,
			       ag.name as agent_name, ag.profile_image_url, ag.avatar_url,
			       pl.name as plugin_name, pl.identifier as plugin_identifier
			from asset_prices ap
			left join avatars av
			  on ap.item_type = 'avatar' and av.id = ap.item_id and av.deleted_at is null
			left join agent_identities ag
			  on ap.item_type = 'agent' and ag.id = ap.item_id and ag.deleted_at is null
			left join plugins pl
			  on ap.item_type = 'plugin' and pl.id = ap.item_id and pl.deleted_at is null
			where ap.owner_user_id = ${user.id}
			  and ap.is_active = true
			  and coalesce(av.id, ag.id, pl.id) is not null
			order by ap.updated_at desc
			limit 48
		`.catch(() => []),
	]);

	const avatars = avatarRows.map((a) => ({
		id: a.id,
		slug: a.slug,
		name: a.name,
		description: a.description,
		thumbnail_url: a.thumbnail_key ? publicUrl(a.thumbnail_key) : null,
		model_url: a.storage_key ? publicUrl(a.storage_key) : null,
		size_bytes: Number(a.size_bytes || 0),
		source: a.source,
		version: a.version,
		fork_count: Number(a.fork_count || 0),
		is_fork: Boolean(a.parent_avatar_id),
		tags: a.tags || [],
		created_at: a.created_at,
	}));

	const agents = agentRows.map((a) => ({
		id: a.id,
		name: a.name,
		description: a.description,
		avatar_url: a.avatar_url,
		profile_image_url: a.profile_image_url,
		home_url: a.home_url,
		wallet_address: a.wallet_address,
		chain_id: a.chain_id,
		erc8004_agent_id: a.erc8004_agent_id ? String(a.erc8004_agent_id) : null,
		onchain: a.onchain || null,
		token: a.token || null,
		x_username: a.x_username,
		farcaster_fname: a.farcaster_fname,
		solana_address: a.solana_address,
		sns_domain: a.sns_domain
			? (a.sns_domain.endsWith('.sol') ? a.sns_domain : `${a.sns_domain}.sol`)
			: null,
		// Fork eligibility: only published agents can be forked (the fork endpoint
		// requires is_published). forks_count drives the "N forks" badge; is_fork
		// flags agents that are themselves derived from another.
		is_published: a.is_published === true,
		forks_count: Number(a.forks_count || 0),
		is_fork: Boolean(a.fork_of),
		created_at: a.created_at,
	}));

	// Items for sale. avatar/agent carry a thumbnail; plugins don't, so they fall
	// back to a glyph in the UI. Each card deep-links to the item's own page where
	// the existing purchase flow lives (no duplicate checkout here).
	const USDC_MINTS = new Set([
		'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC Solana mainnet
		'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC Solana devnet
	]);
	const currencyLabel = (mint, chain) => {
		if (!mint || mint === 'native') return chain === 'solana' ? 'SOL' : 'ETH';
		if (USDC_MINTS.has(mint)) return 'USDC';
		return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
	};
	const shop = shopRows
		.map((r) => {
			const isAvatar = r.item_type === 'avatar';
			const isAgent = r.item_type === 'agent';
			const name = r.avatar_name || r.agent_name || r.plugin_name || 'Item';
			const image = isAvatar
				? r.thumbnail_key
					? publicUrl(r.thumbnail_key)
					: null
				: isAgent
					? r.profile_image_url || r.avatar_url || null
					: null;
			const href = isAvatar
				? `/avatars/${r.item_id}`
				: isAgent
					? `/agent/${r.item_id}`
					: '/marketplace';
			const decimals = Number(r.mint_decimals || 0);
			const price = Number(r.amount || 0) / 10 ** decimals;
			return {
				item_type: r.item_type,
				item_id: r.item_id,
				name,
				image,
				href,
				price,
				currency: currencyLabel(r.currency_mint, r.chain),
				chain: r.chain,
			};
		})
		.filter(Boolean);

	const widgets = widgetRows.map((w) => ({
		id: w.id,
		type: w.type,
		name: w.name,
		avatar_id: w.avatar_id,
		view_count: Number(w.view_count || 0),
		created_at: w.created_at,
	}));

	const skills = skillRows.map((s) => ({
		id: s.id,
		slug: s.slug,
		name: s.name,
		description: s.description,
		category: s.category,
		tags: s.tags || [],
		install_count: s.install_count,
		price_per_call_usd: Number(s.price_per_call_usd || 0),
		created_at: s.created_at,
	}));

	const plugins = pluginRows.map((p) => ({
		id: p.id,
		identifier: p.identifier,
		name: p.name,
		description: p.description,
		category: p.category,
		tags: p.tags || [],
		install_count: p.install_count,
		avg_rating: Number(p.avg_rating || 0),
		rating_count: p.rating_count,
		created_at: p.created_at,
	}));

	// Coins: the launch record lives in agent_identities.meta.token. Pass through
	// only display-safe fields; the mint/links are user-supplied launch data.
	const coins = coinRows
		.map((c) => {
			const t = c.token || {};
			if (!t.mint) return null;
			return {
				mint: t.mint,
				name: t.name || c.agent_name,
				symbol: t.symbol || null,
				description: t.description || null,
				image: t.image || null,
				cluster: t.cluster || 'mainnet',
				launched_at: t.launched_at || null,
				url: t.pumpfun_url || t.explorer_url || null,
				agent_id: c.agent_id,
				agent_name: c.agent_name,
				agent_image: c.profile_image_url || c.avatar_url || null,
			};
		})
		.filter(Boolean);

	const memories = memoryRows.map((m) => ({
		id: m.id,
		type: m.type,
		content: m.content,
		tags: m.tags || [],
		created_at: m.created_at,
		agent_id: m.agent_id,
		agent_name: m.agent_name,
	}));

	const social = {};
	for (const row of socialRows) {
		social[row.provider] = row.username;
	}

	// Follower/following counts live in their own query so a deploy that lands
	// before the user_follows migration degrades to zeros rather than 500ing
	// every public profile (migrate-then-deploy; see api/_lib/bounty-likes.js).
	const [followCounts] = await sql`
		select
			(select count(*)::int from user_follows where following_id = ${user.id}) as followers,
			(select count(*)::int from user_follows where follower_id = ${user.id}) as following
	`.catch(() => [{ followers: 0, following: 0 }]);

	const stats = {
		avatars: statsRow?.[0]?.avatars_count ?? 0,
		agents: statsRow?.[0]?.agents_count ?? 0,
		widgets: statsRow?.[0]?.widgets_count ?? 0,
		skills: statsRow?.[0]?.skills_count ?? 0,
		plugins: statsRow?.[0]?.plugins_count ?? 0,
		coins: statsRow?.[0]?.coins_count ?? 0,
		memories: statsRow?.[0]?.memories_count ?? 0,
		shop: shop.length,
		widget_views: Number(statsRow?.[0]?.total_widget_views ?? 0),
		followers: followCounts?.followers ?? 0,
		following: followCounts?.following ?? 0,
	};

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, {
		user: {
			id: user.id,
			username: user.username,
			display_name: user.display_name || user.username,
			wallet_address: user.wallet_address,
			created_at: user.created_at,
			bio: user.bio || null,
			website: user.website || null,
			location: user.location || null,
			avatar_url: user.avatar_url || null,
			banner_url: user.banner_url || null,
		},
		stats,
		social,
		avatars,
		agents,
		widgets,
		skills,
		plugins,
		coins,
		memories,
		shop,
	});
});
