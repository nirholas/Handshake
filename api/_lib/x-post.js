// Internal helper: publish to X on behalf of a three.ws user.
// Handles: tier-aware quota, token refresh, dedup, cadence guard, threads,
// optional link-back, and post logging.

import { sql } from './db.js';
import { env } from './env.js';
import { encryptToken, decryptToken } from '../auth/x/[action].js';

export const FREE_MONTHLY_QUOTA = 5;
export const PRO_MONTHLY_QUOTA  = 100;
export const MAX_TWEET_LEN      = 280;
export const DEDUP_WINDOW_DAYS  = 7;
export const FREE_MIN_INTERVAL  = 30;     // minutes between posts
export const PRO_MIN_INTERVAL   = 5;

class XPostError extends Error {
	constructor(code, message, status = 400, extra = {}) {
		super(message);
		this.code = code;
		this.status = status;
		this.extra = extra;
	}
}

export async function getUserTier(userId) {
	const r = await sql`
		select plan, active_until from subscriptions
		where user_id = ${userId} and status = 'active' and active_until > now()
		limit 1
	`;
	if (!r.length) return { tier: 'free', quota: FREE_MONTHLY_QUOTA, min_interval_min: FREE_MIN_INTERVAL };
	return {
		tier: r[0].plan,
		active_until: r[0].active_until,
		quota: PRO_MONTHLY_QUOTA,
		min_interval_min: PRO_MIN_INTERVAL,
	};
}

async function refreshIfNeeded(conn) {
	const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
	if (expiresAt - Date.now() > 60_000) return decryptToken(conn.access_token);
	if (!conn.refresh_token) throw new XPostError('reauth_required', 'refresh_token missing, reconnect X account', 401);

	const refreshToken = decryptToken(conn.refresh_token);
	const creds = Buffer.from(`${env.X_OAUTH_CLIENT_ID}:${env.X_OAUTH_CLIENT_SECRET}`).toString('base64');
	const r = await fetch('https://api.twitter.com/2/oauth2/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${creds}` },
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: env.X_OAUTH_CLIENT_ID }).toString(),
	});
	if (!r.ok) throw new XPostError('reauth_required', `X token refresh failed: ${await r.text()}`, 401);
	const tok = await r.json();
	const newExpiresAt = new Date(Date.now() + (tok.expires_in ?? 7200) * 1000).toISOString();
	await sql`
		update social_connections
		set access_token = ${encryptToken(tok.access_token)},
		    refresh_token = ${tok.refresh_token ? encryptToken(tok.refresh_token) : conn.refresh_token},
		    expires_at = ${newExpiresAt},
		    updated_at = now()
		where id = ${conn.id}
	`;
	return tok.access_token;
}

async function postOne({ accessToken, text, replyTo, mediaIds = null }) {
	const body = {};
	if (text) body.text = text;
	if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
	if (mediaIds && mediaIds.length) body.media = { media_ids: mediaIds };
	const r = await fetch('https://api.twitter.com/2/tweets', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new XPostError('tweet_failed', `X API error: ${(await r.text()).slice(0, 200)}`, 502);
	return (await r.json()).data;
}

// Chunked upload of a screenshot / clip to X's v2 media endpoint, returning the
// media_id to attach to a tweet. Single endpoint, command-driven (INIT → APPEND
// → FINALIZE → STATUS), authenticated with the connected user's OAuth2 token —
// which must carry the `media.write` scope (granted on connect, see auth/x).
// Video is processed asynchronously, so we poll STATUS until it succeeds.
const X_MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
const X_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB — X's per-APPEND ceiling

function mediaCategoryFor(mimeType) {
	if (mimeType.startsWith('video/')) return 'tweet_video';
	if (mimeType === 'image/gif') return 'tweet_gif';
	return 'tweet_image';
}

export async function uploadMediaV2({ accessToken, buffer, mimeType }) {
	const total = buffer.length;
	const auth = { authorization: `Bearer ${accessToken}` };

	const initForm = new FormData();
	initForm.set('command', 'INIT');
	initForm.set('media_type', mimeType);
	initForm.set('total_bytes', String(total));
	initForm.set('media_category', mediaCategoryFor(mimeType));
	const initRes = await fetch(X_MEDIA_UPLOAD_URL, { method: 'POST', headers: auth, body: initForm });
	if (!initRes.ok)
		throw new XPostError('media_upload_failed', `media INIT failed: ${(await initRes.text()).slice(0, 200)}`, 502);
	const initJson = await initRes.json();
	const mediaId = initJson?.data?.id || initJson?.data?.media_id_string || initJson?.media_id_string;
	if (!mediaId) throw new XPostError('media_upload_failed', 'media INIT returned no id', 502);

	let segment = 0;
	for (let offset = 0; offset < total; offset += X_MEDIA_CHUNK_BYTES) {
		const chunk = buffer.subarray(offset, Math.min(offset + X_MEDIA_CHUNK_BYTES, total));
		const appendForm = new FormData();
		appendForm.set('command', 'APPEND');
		appendForm.set('media_id', mediaId);
		appendForm.set('segment_index', String(segment));
		appendForm.set('media', new Blob([chunk], { type: 'application/octet-stream' }), 'chunk');
		const appendRes = await fetch(X_MEDIA_UPLOAD_URL, { method: 'POST', headers: auth, body: appendForm });
		if (!appendRes.ok)
			throw new XPostError('media_upload_failed', `media APPEND ${segment} failed: ${(await appendRes.text()).slice(0, 200)}`, 502);
		segment++;
	}

	const finalizeForm = new FormData();
	finalizeForm.set('command', 'FINALIZE');
	finalizeForm.set('media_id', mediaId);
	const finalizeRes = await fetch(X_MEDIA_UPLOAD_URL, { method: 'POST', headers: auth, body: finalizeForm });
	if (!finalizeRes.ok)
		throw new XPostError('media_upload_failed', `media FINALIZE failed: ${(await finalizeRes.text()).slice(0, 200)}`, 502);
	const finalizeJson = await finalizeRes.json();
	let info = finalizeJson?.data?.processing_info || finalizeJson?.processing_info || null;

	// Async transcode (video): poll STATUS until the asset is ready or fails.
	let tries = 0;
	while (info && (info.state === 'pending' || info.state === 'in_progress') && tries < 30) {
		await new Promise((r) => setTimeout(r, Math.min((info.check_after_secs || 1) * 1000, 5000)));
		const statusRes = await fetch(`${X_MEDIA_UPLOAD_URL}?command=STATUS&media_id=${mediaId}`, { headers: auth });
		if (!statusRes.ok) break;
		const statusJson = await statusRes.json();
		info = statusJson?.data?.processing_info || statusJson?.processing_info || null;
		tries++;
	}
	if (info && info.state === 'failed')
		throw new XPostError('media_processing_failed', info?.error?.message || 'media processing failed', 502);

	return mediaId;
}

// Publish a single tweet (text) or a thread (threadParts).
// Counts each tweet against the user's monthly quota.
// Optionally appends a link to https://three.ws/avatars/<agentId> on the final tweet.
export async function publishTweet({ userId, agentId = null, text, threadParts = null, replyTo = null, appendLink = false, mediaBuffer = null, mediaMimeType = null }) {
	if (!env.X_OAUTH_CLIENT_ID || !env.X_OAUTH_CLIENT_SECRET) {
		throw new XPostError('not_configured', 'X OAuth is not configured', 501);
	}
	const hasMedia = mediaBuffer && mediaBuffer.length > 0 && mediaMimeType;

	const parts = Array.isArray(threadParts) && threadParts.length
		? threadParts.map((s) => String(s || '').trim()).filter(Boolean)
		: [String(text || '').trim()].filter(Boolean);
	if (!parts.length) throw new XPostError('validation_error', 'text required', 400);
	for (const p of parts) {
		if (p.length > MAX_TWEET_LEN) throw new XPostError('validation_error', `each tweet must be ≤${MAX_TWEET_LEN} chars`, 400);
	}

	const tier = await getUserTier(userId);

	const rows = await sql`
		select * from social_connections
		where user_id = ${userId} and provider = 'x' and disconnected_at is null
		limit 1
	`;
	const conn = rows[0];
	if (!conn) throw new XPostError('not_connected', 'X account not connected', 400);

	// Reset monthly counter if month boundary crossed.
	if (new Date(conn.month_resets_at) <= new Date()) {
		await sql`
			update social_connections
			set posts_this_month = 0,
			    month_resets_at = date_trunc('month', now()) + interval '1 month'
			where id = ${conn.id}
		`;
		conn.posts_this_month = 0;
	}

	if (conn.posts_this_month + parts.length > tier.quota) {
		throw new XPostError('quota_exceeded', `${tier.tier} tier limit of ${tier.quota} posts/month reached`, 402, {
			posts_used: conn.posts_this_month,
			quota: tier.quota,
			tier: tier.tier,
			month_resets_at: conn.month_resets_at,
			upgrade_url: '/pricing',
		});
	}

	// Cadence guard.
	if (conn.last_posted_at) {
		const elapsedMin = (Date.now() - new Date(conn.last_posted_at).getTime()) / 60_000;
		if (elapsedMin < tier.min_interval_min) {
			const wait = Math.ceil(tier.min_interval_min - elapsedMin);
			throw new XPostError('rate_limited', `please wait ${wait} more min before posting again`, 429, {
				retry_after_minutes: wait,
				tier: tier.tier,
				upgrade_url: tier.tier === 'free' ? '/pricing' : undefined,
			});
		}
	}

	// Dedup on first part of thread. Skipped for media posts: a user sharing
	// several distinct screenshots / clips of the same avatar reuses the same
	// caption legitimately, so identical text alone must not block them.
	if (!hasMedia) {
		const head = parts[0];
		const dup = await sql`
			select 1 from x_posts
			where user_id = ${userId} and text = ${head}
			  and created_at > now() - ${`${DEDUP_WINDOW_DAYS} days`}::interval
			limit 1
		`;
		if (dup.length) throw new XPostError('duplicate', `same text posted within the last ${DEDUP_WINDOW_DAYS} days`, 409);
	}

	// Append link-back to agent page on final tweet (if it fits).
	if (appendLink && agentId) {
		const link = `https://three.ws/avatars/${agentId}`;
		const last = parts[parts.length - 1];
		if (!last.includes(link)) {
			const candidate = `${last}\n\n${link}`;
			if (candidate.length <= MAX_TWEET_LEN) parts[parts.length - 1] = candidate;
		}
	}

	const accessToken = await refreshIfNeeded(conn);

	// Upload media once and attach to the first (head) tweet only.
	const mediaIds = hasMedia
		? [await uploadMediaV2({ accessToken, buffer: mediaBuffer, mimeType: mediaMimeType })]
		: null;

	const published = [];
	let prevId = replyTo;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const d = await postOne({ accessToken, text: part, replyTo: prevId, mediaIds: i === 0 ? mediaIds : null });
		published.push(d);
		await sql`
			insert into x_posts (user_id, agent_id, tweet_id, text, reply_to_tweet_id)
			values (${userId}, ${agentId}, ${d.id}, ${part}, ${prevId})
		`;
		prevId = d.id;
	}

	await sql`
		update social_connections
		set posts_this_month = posts_this_month + ${published.length},
		    last_posted_at = now(),
		    updated_at = now()
		where id = ${conn.id}
	`;

	const head0 = published[0];
	return {
		tweet_id: head0.id,
		url: `https://x.com/${conn.username}/status/${head0.id}`,
		username: conn.username,
		thread: published.length > 1 ? published.map((p) => p.id) : undefined,
		posts_used: conn.posts_this_month + published.length,
		quota: tier.quota,
		tier: tier.tier,
	};
}

export { XPostError };
