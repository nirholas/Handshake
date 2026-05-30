// CoinCommunities server-side client — the ONLY place the API key lives.
//
// Each coin on three.ws is its own 3D world (/walk?coin=<mint>); its
// CoinCommunities community is that world's live social layer. The browser
// never sees the API key: it talks to the api/community/* proxy, which calls
// CoinCommunities with the key held here. Realtime works the same way — the
// proxy mints a short-lived WS ticket and the browser opens the socket to
// CoinCommunities directly with it (see api/community/ws-ticket.js).
//
// Two credential tiers:
//   CC_API_KEY                      — reads (feed, messages) + WS tickets.
//   CC_SERVER_KEY + CC_SERVER_SECRET — server-side post attribution. Optional;
//                                      absent → the Town composer stays in its
//                                      designed locked state, reads still work.

import { configureApi, api } from '@coin-communities/sdk/node';
import { normalizeGatewayURL } from '../../src/ipfs.js';

// Solana mint addresses — base58, 32–44 chars. Communities are keyed by these.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let _configured = false;

export function ccBaseUrl() {
	return (process.env.CC_BASE_URL || 'https://api.coin-communities.xyz').replace(/\/+$/, '');
}

function ccApiKey() {
	return process.env.CC_API_KEY || '';
}

function ccServerKey() {
	return process.env.CC_SERVER_KEY || '';
}

function ccServerSecret() {
	return process.env.CC_SERVER_SECRET || '';
}

/** Reads + WS tickets available. */
export function isConfigured() {
	return Boolean(ccApiKey());
}

/** Server-side post attribution available (postMessageServer). */
export function canPostServer() {
	return Boolean(ccServerKey() && ccServerSecret());
}

/** Validate a community token address before it ever reaches the API. */
export function isValidToken(token) {
	return typeof token === 'string' && BASE58_RE.test(token);
}

class UnconfiguredError extends Error {
	constructor() {
		super('CoinCommunities is not configured (set CC_API_KEY)');
		this.code = 'cc_unconfigured';
	}
}

export { UnconfiguredError };

/**
 * Returns the configured `api` namespace. Configures the shared client once
 * per cold start. Throws UnconfiguredError if no API key is set so callers can
 * answer with a clean 503 rather than leaking a stack trace.
 */
export function cc() {
	if (!isConfigured()) throw new UnconfiguredError();
	if (!_configured) {
		configureApi({ baseUrl: ccBaseUrl(), headers: { 'x-api-key': ccApiKey() } });
		_configured = true;
	}
	return api;
}

/** Headers for server-key-pair operations (merged per-call over the api key). */
export function serverHeaders() {
	return {
		'x-server-key': ccServerKey(),
		'x-server-secret': ccServerSecret(),
	};
}

/** Capability snapshot the browser uses to decide which Town affordances to show. */
export function capabilities() {
	const configured = isConfigured();
	return {
		configured,
		// User posting (X sign-in → link wallet → postMessage) needs only the API
		// key (plus a whitelisted OAuth redirect, which the dashboard owns).
		canPostUser: configured,
		// Server attribution (postMessageServer) needs the server key-pair.
		canPostServer: canPostServer(),
		// Either path means the composer should be live rather than locked.
		canPost: configured || canPostServer(),
		baseUrl: ccBaseUrl(),
		defaultToken:
			(isValidToken(process.env.CC_DEFAULT_TOKEN) && process.env.CC_DEFAULT_TOKEN) || null,
	};
}

// ─── CoinCommunities user session (X-OAuth) ──────────────────────────────────
// A signed-in CoinCommunities user is identified by a JWT we keep in an
// httpOnly cookie scoped to the proxy path, so user-scoped writes (postMessage,
// wallet linking) are forwarded server-side without the token ever being
// readable by page scripts. The API key still rides every request globally.

const AT_COOKIE = 'cc_at';
const RT_COOKIE = 'cc_rt';
const AT_TTL = 60 * 60; // 1h — access token
const RT_TTL = 60 * 60 * 24 * 30; // 30d — refresh token

function cookieAttrs(maxAge) {
	// Scoped to the proxy so it's never sent with page or unrelated API requests.
	return `Path=/api/community; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Persist a CoinCommunities user session to httpOnly cookies. */
export function setUserSession(res, { accessToken, refreshToken }) {
	const cookies = [];
	if (accessToken) cookies.push(`${AT_COOKIE}=${accessToken}; ${cookieAttrs(AT_TTL)}`);
	if (refreshToken) cookies.push(`${RT_COOKIE}=${refreshToken}; ${cookieAttrs(RT_TTL)}`);
	if (cookies.length) res.setHeader('set-cookie', cookies);
}

/** Clear the CoinCommunities user session cookies. */
export function clearUserSession(res) {
	res.setHeader('set-cookie', [
		`${AT_COOKIE}=; Path=/api/community; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
		`${RT_COOKIE}=; Path=/api/community; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
	]);
}

/** Read the current user's access token from the request cookies, if any. */
export function userToken(req) {
	const cookie = req.headers.cookie || '';
	const m = cookie.match(new RegExp(`(?:^|;\\s*)${AT_COOKIE}=([^;]+)`));
	return m ? decodeURIComponent(m[1]) : null;
}

/** Per-call headers that attach a user's bearer JWT for user-scoped operations. */
export function userAuthHeaders(req) {
	const token = userToken(req);
	return token ? { Authorization: `Bearer ${token}` } : null;
}

/**
 * Normalize a TopCommunity into the world-card shape the lobby renders. Keeps
 * the browser ignorant of the upstream schema so a field rename upstream is a
 * one-line change here.
 */
export function toWorldCard(c) {
	return {
		token: c.tokenAddress,
		symbol: c.tokenSymbol || null,
		image: normalizeGatewayURL(c.tokenHighResImageUrl || c.tokenImageUrl || '') || null,
		chainId: c.chainId ?? null,
		members: c.memberCount ?? 0,
		posts: c.postCount ?? 0,
		likes: c.totalLikes ?? 0,
		latestPostAt: c.latestPostAt ?? null,
	};
}

/**
 * Normalize a Message into the compact shape Town renders (rail rows + bubbles).
 * Drops moderation internals the client doesn't need.
 */
export function toTownMessage(m) {
	return {
		id: m.id,
		token: m.tokenAddress,
		content: m.content,
		mediaUrl: m.mediaUrl || null,
		username: m.username || 'anon',
		avatar: m.profileImageUrl || null,
		twitterUrl: m.userTwitterUrl || null,
		wallet: m.walletAddress || null,
		followers: m.followerCount ?? 0,
		likes: m.likeCount ?? 0,
		replies: m.replyCount ?? 0,
		createdAt: m.createdAt,
	};
}
