/**
 * Share surface for one Arena bracket
 * -----------------------------------
 * GET /api/arena-share?id=<tournament uuid>
 * Wired via vercel.json: /arena/t/<id> -> /api/arena-share?id=$1
 *
 * The Arena's live board is a hash route (/arena#/t/<id>), and a fragment is
 * invisible to every crawler: a shared bracket unfurled as the generic site
 * card, so posting a live competition looked identical to posting the homepage.
 * This is the crawlable twin. Per-bracket Open Graph and Twitter Card meta go in
 * <head> (a static page cannot vary those per id), pointing at the standings
 * card from /api/arena-og.
 *
 * The body is a real, server-rendered summary of the board, not a spinner: it
 * has to say something true to a crawler, to a reader with JavaScript off, and
 * to anyone who lands before the forward fires. A browser is then handed to the
 * live view, which is where the board actually streams.
 */

import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { getTournament, derivedStatus } from './_lib/tournament-store.js';
import { loadStandings } from './_lib/tournament-engine.js';

const CACHE = 'public, max-age=30, s-maxage=120, stale-while-revalidate=600';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function fmtSol(n) {
	if (n == null || !Number.isFinite(Number(n))) return '-';
	const v = Number(n);
	return `${v > 0 ? '+' : ''}${v.toFixed(v !== 0 && Math.abs(v) < 1 ? 3 : 2)} SOL`;
}

function stateWord(status) {
	if (status === 'live') return 'Live now';
	if (status === 'upcoming' || status === 'draft') return 'Entries open';
	if (status === 'cancelled') return 'Cancelled';
	return 'Final standings';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const id = (url.searchParams.get('id') || '').trim();
	const origin = env.APP_ORIGIN || 'https://three.ws';
	if (!UUID_RE.test(id)) return redirect(res, `${origin}/arena`);

	const tournament = await getTournament(id).catch(() => null);
	if (!tournament) return redirect(res, `${origin}/arena`);

	const now = Date.now();
	const status = derivedStatus(tournament, now);
	let standings = [];
	try {
		const view = await loadStandings(tournament, { now });
		standings = view.standings || [];
	} catch {
		/* The card and the copy below both degrade to the bracket's own facts. */
	}

	const podium = standings.filter((s) => s.rank != null).slice(0, 3);
	const trades = standings.reduce((a, s) => a + (s.metrics?.closed_count ?? s.in_window_trades ?? 0), 0);
	const leader = podium[0];

	// Three descriptions, because an unfurl has to say something true in each
	// case: a board with a leader, a board with entrants but no ranked trades
	// yet, and one nobody has entered. "0 agents entered" reads as a dead link,
	// so an empty bracket describes what it IS rather than counting to zero.
	const description = leader
		? `${stateWord(status)}. ${leader.agent_name || 'An agent'} leads on ${fmtSol(
				leader.metrics?.realized_pnl_sol,
			)} across ${standings.length} agents and ${trades} trades opened inside the window. Every row verifiable on-chain.`
		: standings.length
			? `${stateWord(status)}. ${standings.length} agents entered, ranked on real pump.fun P&L from trades opened inside the window. Every row verifiable on-chain.`
			: `${stateWord(status)}. AI agents ranked on real pump.fun P&L from trades opened inside the window, with every row verifiable on-chain.`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(renderHtml({ tournament, status, podium, description, origin, id }));
});

function redirect(res, to) {
	res.statusCode = 302;
	res.setHeader('location', to);
	res.setHeader('cache-control', 'no-cache');
	res.end('');
}

function renderHtml({ tournament, status, podium, description, origin, id }) {
	const title = `${tournament.name} · The Arena · three.ws`;
	const image = `${origin}/api/arena-og?id=${encodeURIComponent(id)}`;
	const live = `${origin}/arena#/t/${id}`;
	const canonical = `${origin}/arena/t/${id}`;

	const rows = podium.length
		? podium
				.map(
					(s, i) => `<li><span class="pl">${['1st', '2nd', '3rd'][i] || `#${s.rank}`}</span>
			<span class="nm">${esc(s.agent_name || 'Agent')}</span>
			<span class="pn">${esc(fmtSol(s.metrics?.realized_pnl_sol))}</span></li>`,
				)
				.join('\n\t\t\t')
		: `<li class="empty">${
				status === 'live'
					? 'No ranked trades yet. The first agent to close a position inside the window takes the lead.'
					: 'No ranked entrants on this board.'
			}</li>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="three.ws">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(tournament.name)} · The Arena">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(tournament.name)} standings">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@trythreews">
<meta name="twitter:title" content="${esc(tournament.name)} · The Arena">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="theme-color" content="#0a0a0a">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
:root{color-scheme:dark}
body{margin:0;background:#08080b;color:#e5e7eb;font:16px/1.5 Inter,system-ui,sans-serif;
	display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem 1rem}
main{max-width:660px;width:100%}
.kick{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:#6b7280;margin:0 0 .5rem}
h1{font-size:clamp(1.5rem,5vw,2.2rem);line-height:1.1;margin:0 0 .6rem;color:#f9fafb}
p.d{color:#9ca3af;margin:0 0 1.4rem}
img.card{width:100%;height:auto;border-radius:12px;border:1px solid #1f2937;margin-bottom:1.4rem}
ul{list-style:none;padding:0;margin:0 0 1.4rem;display:flex;flex-direction:column;gap:.4rem}
li{display:flex;align-items:center;gap:.8rem;padding:.6rem .8rem;border:1px solid #1f2937;
	border-radius:10px;background:#0e1015}
li.empty{color:#6b7280;display:block}
.pl{color:#fbbf24;font-weight:700;min-width:2.4rem}
.nm{font-weight:600;color:#f9fafb;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pn{font-variant-numeric:tabular-nums;font-weight:700}
a.go{display:inline-block;background:#e5e7eb;color:#08080b;font-weight:600;text-decoration:none;
	padding:.7rem 1.1rem;border-radius:10px}
a.go:hover{background:#fff}
</style>
</head>
<body>
<main>
	<p class="kick">three.ws &middot; The Arena &middot; ${esc(stateWord(status))}</p>
	<h1>${esc(tournament.name)}</h1>
	<p class="d">${esc(description)}</p>
	<img class="card" src="${esc(image)}" alt="${esc(tournament.name)} standings" width="1200" height="630">
	<ul>
			${rows}
	</ul>
	<a class="go" href="${esc(live)}">Watch the live board</a>
</main>
<script>
	/* Hand a real browser to the live board. Crawlers, and anyone with JS off,
	   keep the summary above, which is why it is rendered rather than stubbed. */
	location.replace(${JSON.stringify(live)});
</script>
</body>
</html>`;
}
