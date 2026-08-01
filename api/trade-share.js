/**
 * SSR share page for a single closed pump.fun trade
 * -------------------------------------------------
 * GET /api/trade-share?id=<position uuid>
 * Wired via vercel.json: /trade/<id> -> /api/trade-share?id=$1
 *
 * This is BOTH the crawler surface and the human destination. Per-trade Open
 * Graph, Twitter Card and Farcaster Frame meta go in <head> (a static page
 * cannot vary those per id), and the body is the finished trade page: the card
 * image, the four numbers, every on-chain leg linked to Solscan, the agent's
 * full track record one click away, and one tap to post it.
 *
 * It never redirects a human away, because the shared moment IS the page.
 * Only an unknown / still-open / deleted trade bounces, to /arena.
 *
 * OG image: /api/trade-og?id=<uuid>
 */

import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { loadTradeCard } from './_lib/trade-card-store.js';

const CACHE = 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600';

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const id = (url.searchParams.get('id') || '').trim();
	const origin = env.APP_ORIGIN || 'https://three.ws';

	const card = await loadTradeCard(id, { origin });
	if (!card) return redirect(res, `${origin}/arena`);

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(renderHtml(card, origin));
});

function redirect(res, to) {
	res.statusCode = 302;
	res.setHeader('location', to);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

/** Solscan link, or a plain muted span when that leg has no real signature. */
function proofLink(href, label) {
	if (!href) return `<span class="proof proof-none" title="No on-chain signature for this leg">${esc(label)}</span>`;
	return `<a class="proof" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} <span aria-hidden="true">&#8599;</span></a>`;
}

function stat(label, value, cls = '') {
	return `<div class="stat">
				<dt>${esc(label)}</dt>
				<dd class="${cls}">${esc(value ?? 'n/a')}</dd>
			</div>`;
}

function renderHtml(card, origin) {
	const t = esc(card.title);
	const d = esc(card.description);
	const xIntent = `https://x.com/intent/post?text=${encodeURIComponent(card.shareText)}&url=${encodeURIComponent(card.shareUrl)}`;

	const chips = [
		card.paper
			? '<span class="chip chip-paper" title="Recorded in simulate mode. Paper fills are labeled and never counted as a live track record.">Paper fill</span>'
			: '<span class="chip chip-live" title="A real on-chain fill from the agent\'s own wallet.">Live on-chain</span>',
		`<span class="chip">${esc(card.exitLabel)}</span>`,
		card.moonbag
			? `<span class="chip chip-moon" title="Not a full exit: the buy-in came out and the rest still rides at zero cost basis.">Moon-bag riding${card.moonbagSol != null ? ` &#183; ${esc(card.moonbagSol.toFixed(3))} SOL` : ''}</span>`
			: '',
	].filter(Boolean).join('\n\t\t\t\t');

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${t}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#08080b">

	<meta property="og:type" content="article">
	<meta property="og:site_name" content="three.ws Arena">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(card.shareUrl)}">
	<meta property="og:image" content="${esc(card.ogImageUrl)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${t}">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(card.ogImageUrl)}">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(card.ogImageUrl)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="Full track record">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(card.agentUrl)}">
	<meta property="fc:frame:button:2" content="The Arena">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${esc(origin)}/arena">

	<link rel="canonical" href="${esc(card.shareUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		:root{
			--bg:#08080b; --panel:#0e1015; --line:#1f2937;
			--ink:#f9fafb; --ink-dim:#9ca3af; --ink-faint:#4b5563;
			--accent:${esc(card.accent)};
		}
		*{box-sizing:border-box}
		html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);
			font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
		a{color:inherit}
		.wrap{max-width:880px;margin:0 auto;padding:24px 20px 72px}
		.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
			padding-bottom:16px;border-bottom:1px solid var(--line)}
		.brand{font-size:12px;font-weight:700;letter-spacing:.14em;color:var(--ink-faint);text-decoration:none}
		.brand:hover,.brand:focus-visible{color:var(--ink-dim)}
		.top-link{font-size:13px;color:var(--ink-dim);text-decoration:none}
		.top-link:hover,.top-link:focus-visible{color:var(--ink)}

		.card-img{display:block;width:100%;height:auto;margin:24px 0 8px;border-radius:14px;
			border:1px solid var(--line);background:var(--panel)}

		.who{display:flex;align-items:center;gap:12px;margin:20px 0 4px}
		.who img,.who .mono{width:44px;height:44px;border-radius:50%;object-fit:cover;
			border:2px solid var(--accent);background:#1e293b;flex:none}
		.mono{display:grid;place-items:center;font-weight:800;color:#475569}
		.who h1{font-size:20px;font-weight:800;margin:0;line-height:1.25}
		.who p{margin:2px 0 0;font-size:13px;color:var(--ink-faint)}
		.who a{text-decoration:none}
		.who a:hover h1,.who a:focus-visible h1{color:var(--accent)}

		.chips{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0}
		.chip{font-size:12px;font-weight:600;letter-spacing:.03em;padding:5px 11px;border-radius:999px;
			border:1px solid var(--line);color:var(--ink-dim);background:rgba(255,255,255,.02)}
		.chip-live{color:#34d399;border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
		.chip-paper{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}
		.chip-moon{color:#c084fc;border-color:rgba(192,132,252,.35);background:rgba(192,132,252,.08)}

		.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:22px 0 0;padding:0}
		.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
		.stat dt{font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--ink-faint);margin:0}
		.stat dd{margin:8px 0 0;font-size:22px;font-weight:800;line-height:1.1}
		.pos{color:#34d399} .neg{color:#f87171}

		.proofs{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 0}
		.proof{font-size:13px;font-weight:600;padding:9px 14px;border-radius:10px;text-decoration:none;
			border:1px solid var(--line);background:var(--panel);color:var(--ink-dim);
			transition:border-color .15s ease,color .15s ease,transform .15s ease}
		a.proof:hover,a.proof:focus-visible{color:var(--ink);border-color:#334155;transform:translateY(-1px)}
		.proof-none{opacity:.45;cursor:not-allowed}

		.actions{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0 0}
		.btn{font:inherit;font-size:14px;font-weight:700;padding:12px 20px;border-radius:11px;cursor:pointer;
			text-decoration:none;display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);
			background:var(--panel);color:var(--ink);
			transition:border-color .15s ease,background .15s ease,transform .15s ease}
		.btn:hover,.btn:focus-visible{border-color:#334155;transform:translateY(-1px)}
		.btn:active{transform:translateY(0)}
		.btn-primary{background:var(--accent);border-color:var(--accent);color:#06110c}
		.btn-primary:hover,.btn-primary:focus-visible{filter:brightness(1.08)}
		:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

		.note{margin:28px 0 0;padding:16px 18px;border:1px solid var(--line);border-left:3px solid var(--accent);
			border-radius:0 12px 12px 0;background:var(--panel);font-size:13px;line-height:1.6;color:var(--ink-dim)}
		.note strong{color:var(--ink)}
		.foot{margin:32px 0 0;font-size:12px;color:var(--ink-faint);line-height:1.6}
		.foot a{color:var(--ink-dim)}

		@media (max-width:640px){
			.stats{grid-template-columns:repeat(2,1fr)}
			.who h1{font-size:18px}
		}
		@media (prefers-reduced-motion:reduce){
			*{transition:none!important}
		}
	</style>
</head>
<body>
	<div class="wrap">
		<header class="top">
			<a class="brand" href="${esc(origin)}/arena">THREE.WS &#183; ARENA</a>
			<a class="top-link" href="${esc(origin)}/arena">Watch agents trade live &#8594;</a>
		</header>

		<img class="card-img" src="${esc(card.ogImageUrl)}" width="1200" height="630" alt="${t}">

		<div class="who">
			${card.agentImage
				? `<img src="${esc(card.agentImage)}" alt="" width="44" height="44" loading="lazy">`
				: `<div class="mono" aria-hidden="true">${esc((card.agentName[0] || 'A').toUpperCase())}</div>`}
			<div>
				<a href="${esc(card.agentUrl)}"><h1>${esc(card.agentName)}</h1></a>
				<p>traded $${esc(card.symbol)}${card.coinName ? ` (${esc(card.coinName)})` : ''} &#183; ${esc(card.mintShort)}</p>
			</div>
		</div>

		<div class="chips">
				${chips}
		</div>

		<dl class="stats">
			${stat('IN', card.entrySolStr)}
			${stat('OUT', card.exitSolStr)}
			${stat('REALIZED', card.pnlSolStr, card.tone === 'win' ? 'pos' : card.tone === 'loss' ? 'neg' : '')}
			${stat('HELD', card.holdLabel)}
		</dl>

		<div class="proofs">
			${proofLink(card.buyUrl, 'Buy transaction')}
			${proofLink(card.sellUrl, 'Sell transaction')}
			${proofLink(card.mintUrl, 'Token')}
		</div>

		<div class="actions">
			<a class="btn btn-primary" href="${esc(xIntent)}" target="_blank" rel="noopener noreferrer">Post this trade</a>
			<a class="btn" href="${esc(card.agentUrl)}">Full track record</a>
			<a class="btn" href="${esc(origin)}/arena">Watch the Arena</a>
		</div>

		<p class="note">
			${card.paper
				? '<strong>This was a paper fill.</strong> The agent was running in simulate mode, so no SOL moved. Paper trades are labeled everywhere and never counted toward a live track record.'
				: '<strong>This trade is verifiable, not trusted.</strong> Both legs above link to their transaction on Solscan. The agent&#39;s full ledger shows every closed trade, losers included.'}
			${card.moonbag
				? ' The initial buy-in was sold and the remaining tokens still ride at zero cost basis, so the realized number here is not the whole position.'
				: ''}
		</p>

		<p class="foot">
			Autonomous agents trade pump.fun live on <a href="${esc(origin)}/arena">the Arena</a>.
			Past performance is not a prediction. Trading memecoins can lose money.
		</p>
	</div>
</body>
</html>`;
}
