// GET /api/community/auth/callback?challengeCode=…  (X OAuth redirect target)
//
// X redirects the popup here after the user authorizes. We exchange the
// one-time challenge code for the user's CoinCommunities session server-side,
// set httpOnly cookies, then hand control back to the opener via postMessage
// and close the popup. Only the one-time challengeCode exchange is accepted;
// raw tokens in the redirect URL are never trusted (login CSRF / fixation).
import { method, text, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { cc, setUserSession, UnconfiguredError } from '../../_lib/coin-communities.js';
import { publishMemberJoin } from '../../_lib/feed.js';

// Surface a signed-in user in the live ticker. Fire-and-forget on a non-critical
// path: the throttle in publishMemberJoin keeps re-logins from spamming, and any
// failure (no display name, Redis down) degrades silently to no event.
function announceSignIn(user) {
	if (!user) return;
	const actor = user.username || user.handle || user.displayName || user.name || null;
	if (!actor) return;
	const handle = user.username || user.handle || null;
	publishMemberJoin({ userKey: user.id || user.userId || actor, actor, handle }).catch(() => {});
}

function page({ ok, user = null, message = '' }) {
	// The opener verifies event.origin === APP_ORIGIN before trusting this.
	const payload = JSON.stringify({ type: 'cc-auth', ok, user, message }).replace(/</g, '\\u003c');
	return `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;background:#0a0e1c;color:#cdd9f5">
<div>${ok ? 'Signed in. You can close this window.' : 'Sign-in failed. You can close this window.'}</div>
<script>
(function(){
  var msg = ${payload};
  try { if (window.opener) window.opener.postMessage(msg, ${JSON.stringify(env.APP_ORIGIN)}); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 350);
})();
</script>`;
}

function htmlPage(res, status, opts) {
	return text(res, status, page(opts), { 'content-type': 'text/html; charset=utf-8' });
}

export default wrap(async (req, res) => {
	// The redirect target is a browser navigation, nothing else. Anything with a
	// body is someone probing the exchange, not X handing back a user.
	if (!method(req, res, ['GET'])) return;

	// A challenge code is a one-shot credential: without a ceiling this endpoint
	// is an unmetered oracle for guessing them. The rest of the session surface
	// (wallet link, unlink, posting) already sits behind the same bucket, and one
	// sign-in spends exactly one request of it.
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) {
		return htmlPage(res, 429, { ok: false, message: 'too many sign-in attempts, try again shortly' });
	}

	const url = new URL(req.url, 'http://x');
	const challengeCode = url.searchParams.get('challengeCode');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return htmlPage(res, 503, { ok: false, message: 'not configured' });
		}
		throw err;
	}

	try {
		if (!challengeCode) throw new Error('missing challenge code');
		const { data, error: apiErr } = await api.twitterChallengeExchange({
			body: { challengeCode },
		});
		if (apiErr || !data?.accessToken) throw new Error(apiErr?.message || 'exchange failed');
		const session = data;
		setUserSession(res, session);
		announceSignIn(session.user);
		return htmlPage(res, 200, { ok: true, user: session.user });
	} catch (err) {
		return htmlPage(res, 200, { ok: false, message: err.message || 'sign-in failed' });
	}
});
