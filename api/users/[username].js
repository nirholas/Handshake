import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publicUrl } from '../_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const username = (req.query.username || '').toLowerCase().trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [user] = await sql`
		select id, display_name, username, created_at, referral_code, wallet_address
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
		socialRows,
		statsRow,
	] = await Promise.all([
		sql`
			select id, name, slug, description, storage_key, thumbnail_key, tags,
			       source, size_bytes, version, created_at
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
			       farcaster_fname, created_at,
			       meta->>'solana_address' as solana_address,
			       meta->>'sns_domain'     as sns_domain
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
			  (select coalesce(sum(view_count), 0)::bigint from widgets
			    where user_id = ${user.id} and is_public = true and deleted_at is null) as total_widget_views
		`,
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
		x_username: a.x_username,
		farcaster_fname: a.farcaster_fname,
		solana_address: a.solana_address,
		sns_domain: a.sns_domain
			? (a.sns_domain.endsWith('.sol') ? a.sns_domain : `${a.sns_domain}.sol`)
			: null,
		created_at: a.created_at,
	}));

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

	const social = {};
	for (const row of socialRows) {
		social[row.provider] = row.username;
	}

	const stats = {
		avatars: statsRow?.avatars_count ?? 0,
		agents: statsRow?.agents_count ?? 0,
		widgets: statsRow?.widgets_count ?? 0,
		skills: statsRow?.skills_count ?? 0,
		plugins: statsRow?.plugins_count ?? 0,
		widget_views: Number(statsRow?.total_widget_views ?? 0),
	};

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, {
		user: {
			username: user.username,
			display_name: user.display_name || user.username,
			referral_code: user.referral_code,
			wallet_address: user.wallet_address,
			created_at: user.created_at,
		},
		stats,
		social,
		avatars,
		agents,
		widgets,
		skills,
		plugins,
	});
});
