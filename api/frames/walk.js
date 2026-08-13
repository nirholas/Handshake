/**
 * Farcaster Frame for a Walk capture
 * ----------------------------------
 * GET /api/frames/walk?avatar=<id>&handle=<handle>
 *
 * Returns an HTML document carrying both the Farcaster Frames v2 (`fc:frame`,
 * version "next") embed and the legacy v1 frame meta, plus Open Graph + Twitter
 * Card tags. Cast this URL in Warpcast and it renders a rich card whose button
 * launches the live /walk experience for that avatar.
 *
 * The frame image reuses the platform's existing 1.91:1 Walk OG card
 * (/api/walk-og), the same card agent-share frames use, so there is one
 * source of truth for the social artwork.
 *
 * An `avatar` that does not resolve to a publicly visible avatar (deleted,
 * private, or malformed) is dropped rather than deep-linked, so a stale cast
 * degrades to the generic walk instead of a button that loads nothing.
 */

import { getAvatar } from '../_lib/avatars.js';
import { cors, wrap, text, method } from '../_lib/http.js';
import { env } from '../_lib/env.js';

const CACHE = 'public, max-age=300, s-maxage=3600';

function esc(s) {
	return String(s).replace(
		/[<>&"']/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const origin = env.APP_ORIGIN || 'https://three.ws';
	const url = new URL(req.url, origin);
	const requestedId = (url.searchParams.get('avatar') || '').trim().slice(0, 64);
	const handle = (url.searchParams.get('handle') || '').trim().slice(0, 40);

	// Three outcomes matter here, and they are not the same thing:
	//   resolved  -> a real, publicly visible avatar; deep-link straight to it.
	//   not found -> deleted, private, or a malformed id. Deep-linking would send
	//                the caster's audience to a /walk that can never load, so the
	//                frame degrades to the generic walk instead of a dead button.
	//   lookup failed -> the DB is unreachable. The id may well be good, so keep
	//                the deep link and only degrade the copy.
	let avatarName = '';
	let avatarId = requestedId;
	if (requestedId) {
		try {
			const avatar = await getAvatar({ id: requestedId });
			if (avatar?.name) avatarName = String(avatar.name).slice(0, 48);
			if (!avatar) avatarId = '';
		} catch {
			// Lookup unavailable: trust the id, degrade to generic copy.
		}
	}

	const ogParams = new URLSearchParams();
	if (avatarId) ogParams.set('avatar', avatarId);
	if (handle) ogParams.set('handle', handle);
	const imageUrl = `${origin}/api/walk-og${ogParams.toString() ? `?${ogParams}` : ''}`;

	const walkUrl = avatarId
		? `${origin}/walk?avatar=${encodeURIComponent(avatarId)}`
		: `${origin}/walk`;
	const createUrl = `${origin}/create`;

	const title = avatarName
		? `Walk ${avatarName} on three.ws`
		: handle
			? `Walk @${handle}'s avatar on three.ws`
			: 'Walk your avatar on three.ws';
	const description = 'A third-person stroll for your 3D agent. Tap to walk yours.';
	// A frame with no resolvable avatar is an invitation, not a portrait, so the
	// button says so rather than pointing at an "avatar" the card never showed.
	const primaryCta = avatarId ? 'Walk this avatar' : 'Walk your avatar';

	// Frames v2 embed: single JSON meta. Button launches the live /walk app.
	const frameV2 = {
		version: 'next',
		imageUrl,
		button: {
			title: primaryCta,
			action: {
				type: 'launch_frame',
				name: 'three.ws Walk',
				url: walkUrl,
				splashImageUrl: `${origin}/pwa-512x512.png`,
				splashBackgroundColor: '#0a0a0a',
			},
		},
	};

	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${esc(title)}</title>
	<meta name="description" content="${esc(description)}">

	<meta property="og:type" content="website">
	<meta property="og:title" content="${esc(title)}">
	<meta property="og:description" content="${esc(description)}">
	<meta property="og:image" content="${esc(imageUrl)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${esc(title)}">
	<meta property="og:url" content="${esc(walkUrl)}">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${esc(title)}">
	<meta name="twitter:description" content="${esc(description)}">
	<meta name="twitter:image" content="${esc(imageUrl)}">

	<!-- Farcaster Frames v2 -->
	<meta name="fc:frame" content="${esc(JSON.stringify(frameV2))}">

	<!-- Farcaster Frames v1 (legacy clients) -->
	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(imageUrl)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="${esc(primaryCta)} →">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(walkUrl)}">
	<meta property="fc:frame:button:2" content="Make your own">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${esc(createUrl)}">

	<link rel="canonical" href="${esc(walkUrl)}">
	<style>
		html,body{margin:0;height:100%;background:#0a0a0a;color:#fff;font-family:system-ui,-apple-system,sans-serif}
		.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:24px}
		img{max-width:min(560px,92vw);width:100%;border-radius:16px;border:1px solid rgba(255,255,255,0.1)}
		a.cta{display:inline-block;background:#7c5cff;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px;transition:background .15s ease,transform .15s ease}
		a.cta:hover{background:#8f74ff;transform:translateY(-1px)}
		a.cta:active{background:#6a4ae0;transform:translateY(0)}
		a.secondary{color:rgba(255,255,255,0.72);text-decoration:none;font-size:14px;border-bottom:1px solid rgba(255,255,255,0.24);transition:color .15s ease,border-color .15s ease}
		a.secondary:hover{color:#fff;border-color:#fff}
		a:focus-visible{outline:2px solid #a78bfa;outline-offset:3px}
		p{color:rgba(255,255,255,0.6);font-size:14px;margin:0}
		@media (prefers-reduced-motion:reduce){a.cta{transition:none}a.cta:hover,a.cta:active{transform:none}}
	</style>
</head>
<body>
	<div class="wrap">
		<img src="${esc(imageUrl)}" alt="${esc(title)}">
		<a class="cta" href="${esc(walkUrl)}">${esc(primaryCta)} →</a>
		<p>${esc(description)}</p>
		<a class="secondary" href="${esc(createUrl)}">Make your own avatar</a>
	</div>
	<script>
		// Real browsers (not social crawlers) go straight to the live experience.
		if (!/bot|crawler|spider|facebookexternalhit|warpcast|farcaster|twitterbot|slackbot|discordbot/i.test(navigator.userAgent)) {
			location.replace(${JSON.stringify(walkUrl)});
		}
	</script>
</body>
</html>`;

	text(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': CACHE });
});
