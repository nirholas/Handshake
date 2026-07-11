// dashboard-next — Data API developer console.
//
// The premium developer surface: buy/renew the monthly Premium pass on Solana
// ($THREE at a discount, SOL, or USDC), manage the x402_live_ API key it
// mints, watch usage, and copy working quickstarts against the news-archive
// Data API. Purchase is fully on-chain from the visitor's own wallet: quote →
// sign in Phantom → poll /api/premium/subscribe until the pass lands.
//
// Session-authed like every dashboard page (requireUser), and the purchase is
// additionally wallet-bound — the session link is what enables key
// rotate/revoke on this page.

import { mountShell } from '../shell.js';
import { requireUser, get, post, esc } from '../api.js';
import {
	skeletonHTML,
	errorStateHTML,
	ensureStateKitStyles,
	attachRetry,
} from '../../shared/state-kit.js';

const WALLET_LS = 'threews:premium:wallet';

const state = {
	plans: null,
	wallet: localStorage.getItem(WALLET_LS) || null,
	status: null,     // /api/premium/status for state.wallet
	buying: null,     // asset symbol while a purchase is in flight
	freshKey: null,   // plaintext shown exactly once after purchase/rotate
};

const $ = (id) => document.getElementById(id);

function fmtDate(iso) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? '—'
		: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function daysLeft(iso) {
	return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
function amountLabel(a) {
	const n = Number(a.amount_atomics) / 10 ** a.decimals;
	const rounded = n >= 1000 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumSignificantDigits: 4 });
	return `${rounded} ${a.asset === 'THREE' ? '$THREE' : a.asset}`;
}

function solanaProvider() {
	return window.phantom?.solana || window.solana || null;
}

// ── Purchase flow ────────────────────────────────────────────────────────────

async function connectWallet() {
	const provider = solanaProvider();
	if (!provider) {
		throw new Error('No Solana wallet found — install Phantom (phantom.com) and reload.');
	}
	const conn = await provider.connect();
	const wallet = (conn?.publicKey || provider.publicKey)?.toString();
	if (!wallet) throw new Error('Wallet did not return a public key.');
	state.wallet = wallet;
	localStorage.setItem(WALLET_LS, wallet);
	return { provider, wallet };
}

async function pollSubscribe(quoteId, signature) {
	// Confirmation usually lands in a few seconds; give it 90.
	for (let i = 0; i < 30; i++) {
		const out = await post('/api/premium/subscribe', { quote_id: quoteId, tx_signature: signature });
		if (out?.pass) return out;
		setBuyNote(`Payment sent — waiting for Solana confirmation… (${i + 1})`);
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error(`Transaction ${signature.slice(0, 8)}… did not confirm in time. Your funds are safe — reopen this page and the pass activates automatically once it lands.`);
}

function setBuyNote(text, isError = false) {
	const el = $('da-buy-note');
	if (!el) return;
	el.textContent = text || '';
	el.style.color = isError ? 'var(--nxt-danger)' : 'var(--nxt-ink-dim)';
}

async function buy(asset) {
	if (state.buying) return;
	state.buying = asset;
	renderPricing();
	try {
		setBuyNote('Connecting wallet…');
		const { provider, wallet } = await connectWallet();
		setBuyNote('Locking the price and building your payment…');
		const { quote, tx_base64 } = await post('/api/premium/quote', { asset, wallet });
		setBuyNote('Confirm the payment in your wallet…');
		const { VersionedTransaction } = await import('@solana/web3.js');
		const bytes = Uint8Array.from(atob(tx_base64), (c) => c.charCodeAt(0));
		const tx = VersionedTransaction.deserialize(bytes);
		const sent = await provider.signAndSendTransaction(tx);
		const signature = typeof sent === 'string' ? sent : sent?.signature;
		if (!signature) throw new Error('Wallet did not return a transaction signature.');
		const out = await pollSubscribe(quote.id, signature);
		state.freshKey = out.api_key || null;
		setBuyNote('');
		await loadStatus();
	} catch (err) {
		if (!/user rejected|cancell?ed/i.test(err?.message || '')) {
			setBuyNote(err?.message || 'Purchase failed — nothing was charged beyond the on-chain transaction you approved.', true);
		} else {
			setBuyNote('');
		}
	} finally {
		state.buying = null;
		renderPricing();
	}
}

// ── Key management ───────────────────────────────────────────────────────────

async function keyAction(action, id) {
	const verb = action === 'revoke' ? 'Revoke this API key? Anything using it stops working immediately.' : null;
	if (verb && !window.confirm(verb)) return;
	try {
		const out = await post('/api/premium/keys', { action, id });
		if (out?.api_key) state.freshKey = out.api_key;
		await loadStatus();
	} catch (err) {
		setBuyNote(err?.message === 'key_not_found' || err?.code === 'key_not_found'
			? 'This key isn’t linked to your account — keys bought without being signed in are managed via the API only.'
			: (err?.message || 'Key action failed.'), true);
	}
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderStatusCard() {
	const el = $('da-status');
	if (!el) return;
	if (!state.wallet) {
		el.innerHTML = `
			<div class="da-hero">
				<div>
					<div class="da-hero-kicker">Premium pass</div>
					<div class="da-hero-title">Not connected</div>
					<p class="da-hero-sub">Connect the Solana wallet you'll pay with to see your pass status, or buy below — the pass follows the wallet, the key follows your account.</p>
				</div>
				<button class="dn-btn primary" id="da-connect" type="button">Connect wallet</button>
			</div>`;
		$('da-connect')?.addEventListener('click', async () => {
			try { await connectWallet(); await loadStatus(); } catch (e) { setBuyNote(e.message, true); }
		});
		return;
	}
	const s = state.status;
	const short = `${state.wallet.slice(0, 4)}…${state.wallet.slice(-4)}`;
	if (!s) {
		el.innerHTML = `<div class="da-hero">${skeletonHTML(2, 'row')}</div>`;
		return;
	}
	if (!s.active) {
		el.innerHTML = `
			<div class="da-hero">
				<div>
					<div class="da-hero-kicker">Premium pass · ${esc(short)}</div>
					<div class="da-hero-title">No active pass</div>
					<p class="da-hero-sub">Pick an asset below — one on-chain payment activates 30 days of unmetered archive search plus an API key. Paying in $THREE is the cheapest way in.</p>
				</div>
				<button class="dn-btn ghost" id="da-switch" type="button">Switch wallet</button>
			</div>`;
	} else {
		const left = daysLeft(s.pass.expires_at);
		el.innerHTML = `
			<div class="da-hero da-hero-active">
				<div>
					<div class="da-hero-kicker">Premium pass · ${esc(short)}</div>
					<div class="da-hero-title"><span class="da-dot"></span> Active — ${left} day${left === 1 ? '' : 's'} left</div>
					<p class="da-hero-sub">Runs until ${esc(fmtDate(s.pass.expires_at))}. Renewing now appends 30 days to the end — no lost time. Browser searches: choose “sign with wallet” in the payment dialog on <a href="/markets/archive">/markets/archive</a>.</p>
				</div>
				<button class="dn-btn ghost" id="da-switch" type="button">Switch wallet</button>
			</div>`;
	}
	$('da-switch')?.addEventListener('click', async () => {
		localStorage.removeItem(WALLET_LS);
		state.wallet = null;
		state.status = null;
		renderStatusCard();
		try { await connectWallet(); await loadStatus(); } catch { /* stays disconnected */ }
	});
}

function renderPricing() {
	const el = $('da-pricing');
	if (!el || !state.plans) return;
	const { plan, assets } = state.plans;
	const active = Boolean(state.status?.active);
	const cards = assets.map((a) => {
		const highlight = a.asset === 'THREE';
		const buyLabel = state.buying === a.asset
			? 'Processing…'
			: active ? `Renew with ${a.asset === 'THREE' ? '$THREE' : a.asset}` : `Pay with ${a.asset === 'THREE' ? '$THREE' : a.asset}`;
		if (!a.available) {
			return `
				<div class="da-card" aria-disabled="true">
					<div class="da-card-asset">${a.asset === 'THREE' ? '$THREE' : esc(a.asset)}</div>
					<div class="da-card-amount">—</div>
					<div class="da-card-usd">${esc(a.reason || 'temporarily unavailable')}</div>
					<button class="dn-btn" type="button" disabled>Unavailable</button>
				</div>`;
		}
		return `
			<div class="da-card ${highlight ? 'da-card-hot' : ''}">
				${highlight ? `<div class="da-card-badge">−${Math.round((a.discount || 0) * 100)}% · platform coin</div>` : ''}
				<div class="da-card-asset">${a.asset === 'THREE' ? '$THREE' : esc(a.asset)}</div>
				<div class="da-card-amount">${esc(amountLabel(a))}</div>
				<div class="da-card-usd">≈ $${Number(a.usd).toFixed(2)} · ${plan.days} days</div>
				<button class="dn-btn ${highlight ? 'primary' : ''}" type="button" data-buy="${esc(a.asset)}" ${state.buying ? 'disabled' : ''}>${esc(buyLabel)}</button>
			</div>`;
	}).join('');
	el.innerHTML = `
		<div class="dn-panel">
			<div class="da-panel-head">
				<h2>${state.status?.active ? 'Renew' : 'Go Premium'} — $${Number(plan.usd).toFixed(2)}/${plan.days} days</h2>
				<span class="da-tagline">Solana only · one transaction · no card, no account required to pay</span>
			</div>
			<div class="da-cards">${cards}</div>
			<p class="da-note" id="da-buy-note" role="status" aria-live="polite"></p>
		</div>`;
	el.querySelectorAll('[data-buy]').forEach((b) =>
		b.addEventListener('click', () => buy(b.dataset.buy)),
	);
}

function renderFreshKey() {
	const el = $('da-freshkey');
	if (!el) return;
	if (!state.freshKey) { el.innerHTML = ''; return; }
	el.innerHTML = `
		<div class="dn-panel da-fresh">
			<div class="da-panel-head"><h2>Your API key — copy it now</h2></div>
			<p class="da-note">This is the only time the full key is shown. It is already active.</p>
			<div class="da-keyrow">
				<code class="da-keycode" id="da-key-plain">${esc(state.freshKey)}</code>
				<button class="dn-btn primary" id="da-key-copy" type="button">Copy</button>
			</div>
		</div>`;
	$('da-key-copy')?.addEventListener('click', async () => {
		await navigator.clipboard.writeText(state.freshKey).catch(() => {});
		$('da-key-copy').textContent = 'Copied ✓';
		setTimeout(() => { const b = $('da-key-copy'); if (b) b.textContent = 'Copy'; }, 1500);
	});
}

function renderKeys() {
	const el = $('da-keys');
	if (!el) return;
	const keys = state.status?.keys || [];
	if (!state.wallet || !keys.length) {
		el.innerHTML = `
			<div class="dn-panel">
				<div class="da-panel-head"><h2>API key</h2></div>
				<p class="da-note">No key yet — buying a pass mints one automatically (<code>x402_live_…</code>). It bypasses the per-call x402 charge on every premium endpoint via the <code>X-API-Key</code> header.</p>
			</div>`;
		return;
	}
	const rows = keys.map((k) => `
		<tr>
			<td><code>${esc(k.key_prefix)}…</code></td>
			<td>${k.status === 'active' ? '<span class="da-ok">active</span>' : `<span class="da-bad">${esc(k.status)}</span>`}</td>
			<td class="da-num">${k.rate_limit_per_minute}/min</td>
			<td>${esc(fmtDate(k.expires_at))}</td>
			<td class="da-num">${Number(k.usage.granted).toLocaleString()}</td>
			<td class="da-num">${Number(k.usage.denied).toLocaleString()}</td>
			<td>${k.usage.last_seen ? esc(fmtDate(k.usage.last_seen)) : '—'}</td>
			<td class="da-actions">
				<button class="dn-btn ghost" type="button" data-rotate="${esc(k.id)}">Rotate</button>
				<button class="dn-btn danger" type="button" data-revoke="${esc(k.id)}">Revoke</button>
			</td>
		</tr>`).join('');
	el.innerHTML = `
		<div class="dn-panel">
			<div class="da-panel-head"><h2>API key</h2><span class="da-tagline">usage from the access log — granted vs denied calls</span></div>
			<div class="da-scroll">
				<table class="da-table">
					<thead><tr><th>Key</th><th>Status</th><th class="da-num">Rate limit</th><th>Expires</th><th class="da-num">Granted</th><th class="da-num">Denied</th><th>Last used</th><th></th></tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		</div>`;
	el.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', () => keyAction('rotate', b.dataset.rotate)));
	el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => keyAction('revoke', b.dataset.revoke)));
}

function renderQuickstart() {
	const el = $('da-quickstart');
	if (!el) return;
	const key = state.status?.keys?.[0]?.key_prefix ? `${state.status.keys[0].key_prefix}…` : 'x402_live_YOUR_KEY';
	const snippets = {
		curl: `curl "https://three.ws/api/news/archive?q=bitcoin+etf&start_date=2024-01-01&end_date=2024-03-31&limit=50" \\
  -H "X-API-Key: ${key}"`,
		javascript: `const res = await fetch(
  'https://three.ws/api/news/archive?' + new URLSearchParams({
    ticker: 'BTC', sentiment: 'negative', start_date: '2022-11-01', end_date: '2022-11-30',
  }),
  { headers: { 'X-API-Key': '${key}' } },
);
const { articles, scanned } = await res.json();`,
		mcp: `// claude_desktop_config.json / .mcp.json — crypto_news_archive tool
{
  "mcpServers": {
    "three-ws": { "command": "npx", "args": ["-y", "@three-ws/mcp-server"] }
  }
}`,
	};
	const tabs = Object.keys(snippets).map((t) =>
		`<button class="da-tab" type="button" data-tab="${t}" aria-pressed="${t === 'curl'}">${t === 'javascript' ? 'JavaScript' : t.toUpperCase()}</button>`,
	).join('');
	el.innerHTML = `
		<div class="dn-panel">
			<div class="da-panel-head"><h2>Quickstart</h2><span class="da-tagline">works the moment your pass is active</span></div>
			<div class="da-tabs" role="tablist">${tabs}</div>
			<pre class="da-code" id="da-snippet"><code>${esc(snippets.curl)}</code></pre>
			<button class="dn-btn ghost" id="da-snippet-copy" type="button">Copy snippet</button>
		</div>`;
	let current = 'curl';
	el.querySelectorAll('.da-tab').forEach((b) =>
		b.addEventListener('click', () => {
			current = b.dataset.tab;
			el.querySelectorAll('.da-tab').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
			$('da-snippet').innerHTML = `<code>${esc(snippets[current])}</code>`;
		}),
	);
	$('da-snippet-copy')?.addEventListener('click', async () => {
		await navigator.clipboard.writeText(snippets[current]).catch(() => {});
		$('da-snippet-copy').textContent = 'Copied ✓';
		setTimeout(() => { const b = $('da-snippet-copy'); if (b) b.textContent = 'Copy snippet'; }, 1500);
	});
}

function renderCatalog() {
	const el = $('da-catalog');
	if (!el) return;
	const rows = [
		['GET /api/news/archive', 'Search 660k+ articles back to 2017 — keyword, ticker, source, date, sentiment, language', 'Premium · 60/day free · $0.001/search'],
		['GET /api/news/archive?stats=true', 'Corpus statistics + month range', 'Free'],
		['GET /api/news/archive?trending=true', 'Most-covered tickers of the newest archive weeks', 'Free'],
		['GET /api/news/feed', 'Live headlines from 192 publisher feeds', 'Free'],
		['GET /api/news/digest', 'Last 1–72 h clustered into narratives with stance + tickers', 'Free'],
	].map(([ep, what, access]) => `
		<tr><td><code>${esc(ep)}</code></td><td>${esc(what)}</td><td>${esc(access)}</td></tr>`).join('');
	el.innerHTML = `
		<div class="dn-panel">
			<div class="da-panel-head"><h2>Endpoints</h2><a class="da-tagline" href="/docs/api-reference">full API reference →</a></div>
			<div class="da-scroll">
				<table class="da-table">
					<thead><tr><th>Endpoint</th><th>What it does</th><th>Access</th></tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		</div>`;
}

function renderAll() {
	renderStatusCard();
	renderPricing();
	renderFreshKey();
	renderKeys();
	renderQuickstart();
	renderCatalog();
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadStatus() {
	if (!state.wallet) { renderAll(); return; }
	try {
		state.status = await get(`/api/premium/status?wallet=${encodeURIComponent(state.wallet)}`);
	} catch {
		state.status = null;
	}
	renderAll();
}

function injectStyles() {
	if (document.getElementById('da-styles')) return;
	ensureStateKitStyles();
	const s = document.createElement('style');
	s.id = 'da-styles';
	s.textContent = `
		.da-root { display: flex; flex-direction: column; gap: 1.25rem; padding-bottom: 3rem; }
		.da-hero { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; background: var(--nxt-glass); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 1.2rem 1.4rem; }
		.da-hero-active { border-left: 3px solid var(--nxt-success); }
		.da-hero-kicker { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: var(--nxt-ink-fade); }
		.da-hero-title { font-size: 1.35rem; font-weight: 680; color: var(--nxt-ink); margin: .2rem 0; display: flex; align-items: center; gap: .5rem; }
		.da-hero-sub { margin: 0; font-size: .85rem; color: var(--nxt-ink-dim); line-height: 1.55; max-width: 60ch; }
		.da-hero-sub a { color: var(--nxt-accent); }
		.da-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--nxt-success); box-shadow: 0 0 8px var(--nxt-success); display: inline-block; }
		.da-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin-bottom: .9rem; }
		.da-panel-head h2 { margin: 0; font-size: .95rem; font-weight: 650; color: var(--nxt-ink); }
		.da-tagline { font-size: .74rem; color: var(--nxt-ink-fade); }
		.da-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: .9rem; }
		.da-card { position: relative; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 1.1rem 1rem .9rem; display: flex; flex-direction: column; gap: .3rem; transition: border-color .15s ease, transform .15s ease; }
		.da-card:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
		.da-card[aria-disabled="true"] { opacity: .55; }
		.da-card-hot { border-color: color-mix(in srgb, var(--nxt-accent) 55%, transparent); background: color-mix(in srgb, var(--nxt-accent) 6%, transparent); }
		.da-card-badge { position: absolute; top: -.6rem; left: .8rem; font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--nxt-accent); background: var(--nxt-bg-0); border: 1px solid color-mix(in srgb, var(--nxt-accent) 55%, transparent); padding: .12rem .5rem; border-radius: var(--nxt-radius-pill); }
		.da-card-asset { font-size: .78rem; color: var(--nxt-ink-dim); font-weight: 600; }
		.da-card-amount { font-size: 1.3rem; font-weight: 700; color: var(--nxt-ink); letter-spacing: -.01em; }
		.da-card-usd { font-size: .74rem; color: var(--nxt-ink-fade); margin-bottom: .55rem; }
		.da-note { margin: .8rem 0 0; font-size: .8rem; color: var(--nxt-ink-dim); line-height: 1.5; min-height: 1em; }
		.da-fresh { border-color: color-mix(in srgb, var(--nxt-success) 50%, transparent); }
		.da-keyrow { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-top: .6rem; }
		.da-keycode { font-family: var(--nxt-mono, ui-monospace, monospace); font-size: .82rem; background: color-mix(in srgb, var(--nxt-ink) 7%, transparent); padding: .5rem .7rem; border-radius: 6px; word-break: break-all; user-select: all; }
		.da-scroll { overflow-x: auto; }
		.da-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
		.da-table th { text-align: left; font-weight: 600; color: var(--nxt-ink-fade); font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; padding: .35rem .5rem; border-bottom: 1px solid var(--nxt-stroke); white-space: nowrap; }
		.da-table td { padding: .45rem .5rem; border-bottom: 1px solid color-mix(in srgb, var(--nxt-stroke) 55%, transparent); color: var(--nxt-ink); vertical-align: middle; }
		.da-num { text-align: right; font-variant-numeric: tabular-nums; }
		.da-ok { color: var(--nxt-success); font-weight: 600; }
		.da-bad { color: var(--nxt-danger); font-weight: 600; }
		.da-actions { white-space: nowrap; display: flex; gap: .4rem; }
		.da-tabs { display: flex; gap: .4rem; margin-bottom: .6rem; }
		.da-tab { background: none; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); border-radius: var(--nxt-radius-pill); font-size: .74rem; padding: .3rem .8rem; cursor: pointer; transition: all .12s ease; }
		.da-tab[aria-pressed="true"] { color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); background: color-mix(in srgb, var(--nxt-ink) 6%, transparent); }
		.da-tab:focus-visible, .da-card button:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
		.da-code { background: color-mix(in srgb, var(--nxt-ink) 6%, transparent); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: .9rem 1rem; overflow-x: auto; font-size: .78rem; line-height: 1.55; margin: 0 0 .7rem; }
		.da-code code { font-family: var(--nxt-mono, ui-monospace, monospace); white-space: pre; }
	`;
	document.head.appendChild(s);
}

(async function boot() {
	const main = await mountShell();
	await requireUser();
	injectStyles();

	main.innerHTML = `
		<div style="margin-bottom:1.5rem">
			<h1 class="dn-h1" style="margin-bottom:.25rem">Data API</h1>
			<p class="dn-h1-sub" style="margin:0">The 660k-article crypto-news archive as a developer product — one monthly pass, paid on Solana in $THREE, SOL, or USDC, instead of a payment per call.</p>
		</div>
		<div class="da-root" id="da-root">
			<div id="da-status"></div>
			<div id="da-freshkey"></div>
			<div id="da-pricing">${`<div class="dn-panel">${skeletonHTML(3, 'row')}</div>`}</div>
			<div id="da-keys"></div>
			<div id="da-quickstart"></div>
			<div id="da-catalog"></div>
		</div>`;

	attachRetry($('da-root'), () => boot2());
	async function boot2() {
		try {
			state.plans = await get('/api/premium/plans');
		} catch (err) {
			$('da-pricing').innerHTML = errorStateHTML({
				title: 'Couldn’t load pricing',
				body: esc(err?.message || 'The pricing endpoint is unreachable — retry in a moment.'),
			});
			return;
		}
		await loadStatus();
	}
	await boot2();
})().catch((err) => {
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `<h1 class="dn-h1">Data API</h1><div class="dn-panel"><div class="dn-panel-title" style="color:var(--nxt-danger)">Failed to load</div><div class="dn-panel-sub">${String(err?.message || 'unknown').replace(/</g, '&lt;')}</div></div>`;
});
