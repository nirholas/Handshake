// GET /api/community/auth/callback?challengeCode=…  (X OAuth redirect target)
//
// X redirects the popup here after the user authorizes. We exchange the
// one-time challenge code for the user's CoinCommunities session server-side,
// set httpOnly cookies, then hand control back to the opener via postMessage
// and close the popup. Falls back to the legacy accessToken-in-redirect shape.
import { text, wrap } from '../../_lib/http.js';
import { env } from '../../_lib/env.js';
import { cc, setUserSession, UnconfiguredError } from '../../_lib/coin-communities.js';

function page({ ok, user = null, message = '' }) {
	// The opener verifies event.origin === APP_ORIGIN before trusting this.
	const payload = JSON.stringify({ type: 'cc-auth', ok, user, message });
	return `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;background:#0a0e1c;color:#cdd9f5">
<div>${ok ? 'Signed in — you can close this window.' : 'Sign-in failed. You can close this window.'}</div>
<script>
(function(){
  var msg = ${payload};
  try { if (window.opener) window.opener.postMessage(msg, ${JSON.stringify(env.APP_ORIGIN)}); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 350);
})();
</script>`;
}

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const challengeCode = url.searchParams.get('challengeCode');
	const accessToken = url.searchParams.get('accessToken');
	const refreshToken = url.searchParams.get('refreshToken');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return text(res, 503, page({ ok: false, message: 'not configured' }), {
				'content-type': 'text/html; charset=utf-8',
			});
		}
		throw err;
	}

	try {
		let session;
		if (challengeCode) {
			const { data, error: apiErr } = await api.twitterChallengeExchange({
				body: { challengeCode },
			});
			if (apiErr || !data?.accessToken) throw new Error(apiErr?.message || 'exchange failed');
			session = data;
		} else if (accessToken) {
			session = { accessToken, refreshToken, user: null };
		} else {
			throw new Error('missing challenge code');
		}
		setUserSession(res, session);
		return text(res, 200, page({ ok: true, user: session.user }), {
			'content-type': 'text/html; charset=utf-8',
		});
	} catch (err) {
		return text(res, 200, page({ ok: false, message: err.message || 'sign-in failed' }), {
			'content-type': 'text/html; charset=utf-8',
		});
	}
});
