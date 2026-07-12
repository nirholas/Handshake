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

// A wallet-ownership signature is required to read the private half of
// /api/premium/status (keys, usage, purchase history). The server accepts it
// within a 5-minute window; we reuse a signature for 4 minutes so a single
// approval covers a normal session of key management without re-prompting.
const PROOF_TTL_MS = 4 * 60 * 1000;

const state = {
	plans: null,
	wallet: localStorage.getItem(WALLET_LS) || null,
	status: null,     // /api/premium/status for state.wallet
	proof: null,      // { wallet, signature, issuedAt, ts } ownership proof for keys/history
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

// Base64 of an ed25519 signature — the server (verifySiwsSignature) accepts base64.
function bytesToB64(bytes) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (const b of arr) bin += String.fromCharCode(b);
	return btoa(bin);
}

function freshProof() {
	const p = state.proof;
	return p && p.wallet === state.wallet && Date.now() - p.ts < PROOF_TTL_MS ? p : null;
}

// Prove control of the connected wallet so the server returns keys/usage/history.
// Reuses a still-fresh proof; otherwise asks the wallet to sign once. Returns the
// proof, or null if the wallet can't sign (falls back to public pass-state only).
async function ensureProof(provider) {
	if (!state.wallet) return null;
	const cached = freshProof();
	if (cached) return cached;
	if (!provider?.signMessage) return null;
	const issuedAt = new Date().toISOString();
	const message = `three.ws premium status\nWallet: ${state.wallet}\nIssued At: ${issuedAt}`;
	const res = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
	const signature = bytesToB64(res?.signature ?? res);
	state.proof = { wallet: state.wallet, signature, issuedAt, ts: Date.now() };
	return state.proof;
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

async function buy(planId, asset) {
	if (state.buying) return;
	state.buying = `${planId}:${asset}`;
	renderPricing();
	try {
		setBuyNote('Connecting wallet…');
		const { provider, wallet } = await connectWallet();
		setBuyNote('Locking the price and building your payment…');
		const { quote, tx_base64 } = await post('/api/premium/quote', { asset, wallet, plan: planId });
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
		try { await ensureProof(provider); } catch { /* keys stay hidden until Verify */ }
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
			try { await verifyAndLoad(); } catch (e) { setBuyNote(e.message, true); }
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
		// A fresh ownership signature unlocks the key-management panel below.
		const verifyBtn = freshProof()
			? ''
			: `<button class="dn-btn ghost" id="da-verify" type="button">Verify to manage keys</button>`;
		el.innerHTML = `
			<div class="da-hero da-hero-active">
				<div>
					<div class="da-hero-kicker">Premium pass · ${esc(short)}</div>
					<div class="da-hero-title"><span class="da-dot"></span> Active — ${left} day${left === 1 ? '' : 's'} left</div>
					<p class="da-hero-sub">Runs until ${esc(fmtDate(s.pass.expires_at))}. Renewing now appends 30 days to the end — no lost time. Browser searches: choose “sign with wallet” in the payment dialog on <a href="/markets/archive">/markets/archive</a>.</p>
				</div>
				<div class="da-hero-actions">${verifyBtn}<button class="dn-btn ghost" id="da-switch" type="button">Switch wallet</button></div>
			</div>`;
	}
	$('da-verify')?.addEventListener('click', async () => {
		try { await verifyAndLoad(); } catch (e) { setBuyNote(e.message, true); }
	});
	$('da-switch')?.addEventListener('click', async () => {
		localStorage.removeItem(WALLET_LS);
		state.wallet = null;
		state.status = null;
		state.proof = null;
		renderStatusCard();
		try { await verifyAndLoad(); } catch { /* stays disconnected */ }
	});
}

function renderPricing() {
	const el = $('da-pricing');
	if (!el || !state.plans) return;
	const plans = state.plans.plans || [];
	if (!plans.length) return;
	const active = Boolean(state.status?.active);
	const fromUsd = Math.min(...plans.map((p) => Number(p.usd)));

	const assetBtn = (plan, a) => {
		const key = `${plan.id}:${a.asset}`;
		const label = a.asset === 'THREE' ? '$THREE' : a.asset;
		if (!a.available) {
			return `<button class="da-paybtn" type="button" disabled title="${esc(a.reason || 'temporarily unavailable')}">${esc(label)} —</button>`;
		}
		const busy = state.buying === key;
		return `
			<button class="da-paybtn ${a.asset === 'THREE' ? 'da-paybtn-three' : ''}" type="button"
				data-buy-plan="${esc(plan.id)}" data-buy-asset="${esc(a.asset)}" ${state.buying ? 'disabled' : ''}
				title="≈ $${Number(a.usd).toFixed(2)} in ${esc(label)}">
				${busy ? 'Processing…' : `${esc(amountLabel(a))}${a.asset === 'THREE' ? ` <span class="da-off">−${Math.round((a.discount || 0) * 100)}%</span>` : ''}`}
			</button>`;
	};

	const cards = plans.map((plan) => {
		const hot = plan.id === 'pro';
		return `
			<div class="da-tiercard ${hot ? 'da-card-hot' : ''}">
				${hot ? '<div class="da-card-badge">Most popular</div>' : ''}
				<div class="da-card-asset">${esc(plan.tier)}</div>
				<div class="da-card-amount">$${Number(plan.usd) % 1 ? Number(plan.usd).toFixed(2) : Number(plan.usd)}<span class="da-per">/${plan.days}d</span></div>
				<ul class="da-feats">
					<li><strong>${Number(plan.rate_limit_per_minute).toLocaleString()}</strong> requests/min</li>
					<li>Unmetered archive search + API key</li>
					<li>${plan.commercial ? 'Commercial use licensed' : 'Personal & evaluation use'}</li>
					${plan.id === 'enterprise' ? '<li>Priority support · bulk corpus arrangements</li>' : ''}
				</ul>
				<p class="da-card-usd">${esc(plan.blurb || '')}</p>
				<div class="da-paygroup" role="group" aria-label="Pay for ${esc(plan.tier)}">
					${(plan.assets || []).map((a) => assetBtn(plan, a)).join('')}
				</div>
			</div>`;
	}).join('');

	el.innerHTML = `
		<div class="dn-panel">
			<div class="da-panel-head">
				<h2>${active ? 'Renew or upgrade' : 'Go Premium'} — from $${fromUsd % 1 ? fromUsd.toFixed(2) : fromUsd}/30 days</h2>
				<span class="da-tagline">Solana only · one transaction · pay in $THREE (20% off), SOL, or USDC</span>
			</div>
			<div class="da-cards da-cards-tiers">${cards}</div>
			<p class="da-note" id="da-buy-note" role="status" aria-live="polite"></p>
			<p class="da-note" style="color:var(--nxt-ink-fade)">Buying a higher tier while a pass is active upgrades your key's rate limit immediately and appends the new period to the end. Enterprise needs something custom? <a href="/community" style="color:var(--nxt-accent)">Talk to us.</a></p>
		</div>`;
	el.querySelectorAll('[data-buy-plan]').forEach((b) =>
		b.addEventListener('click', () => buy(b.dataset.buyPlan, b.dataset.buyAsset)),
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
		// An active pass with no visible key means we haven't proved wallet
		// ownership yet — the key exists server-side but is gated behind a signature.
		const locked = state.status?.active && !freshProof();
		el.innerHTML = locked
			? `<div class="dn-panel">
					<div class="da-panel-head"><h2>API key</h2></div>
					<p class="da-note">Your key is protected. <button class="da-inline-link" id="da-keys-verify" type="button">Verify this wallet</button> to view its prefix, usage, and rotate/revoke controls.</p>
				</div>`
			: `<div class="dn-panel">
					<div class="da-panel-head"><h2>API key</h2></div>
					<p class="da-note">No key yet — buying a pass mints one automatically (<code>x402_live_…</code>). It bypasses the per-call x402 charge on every premium endpoint via the <code>X-API-Key</code> header.</p>
				</div>`;
		$('da-keys-verify')?.addEventListener('click', async () => {
			try { await verifyAndLoad(); } catch (e) { setBuyNote(e.message, true); }
		});
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
		const p = freshProof();
		const auth = p
			? `&signature=${encodeURIComponent(p.signature)}&issuedAt=${encodeURIComponent(p.issuedAt)}`
			: '';
		state.status = await get(`/api/premium/status?wallet=${encodeURIComponent(state.wallet)}${auth}`);
	} catch {
		state.status = null;
	}
	renderAll();
}

// Connect the wallet, prove ownership, then reload the (now full) status.
async function verifyAndLoad() {
	const { provider } = await connectWallet();
	await ensureProof(provider);
	await loadStatus();
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
		.da-hero-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
		.da-inline-link { background: none; border: none; padding: 0; font: inherit; color: var(--nxt-accent); cursor: pointer; text-decoration: underline; }
		.da-inline-link:hover { color: var(--nxt-ink); }
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
		.da-cards-tiers { grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); align-items: stretch; }
		.da-tiercard { position: relative; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 1.2rem 1.1rem 1rem; display: flex; flex-direction: column; gap: .4rem; transition: border-color .15s ease, transform .15s ease; }
		.da-tiercard:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
		.da-per { font-size: .8rem; font-weight: 500; color: var(--nxt-ink-fade); margin-left: .15rem; }
		.da-feats { list-style: none; margin: .2rem 0 .3rem; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
		.da-feats li { font-size: .78rem; color: var(--nxt-ink-dim); padding-left: 1.1rem; position: relative; }
		.da-feats li::before { content: '✓'; position: absolute; left: 0; color: var(--nxt-success); font-weight: 700; }
		.da-paygroup { display: flex; flex-direction: column; gap: .4rem; margin-top: auto; }
		.da-paybtn { display: flex; align-items: center; justify-content: center; gap: .4rem; width: 100%; border: 1px solid var(--nxt-stroke); background: color-mix(in srgb, var(--nxt-ink) 4%, transparent); color: var(--nxt-ink); border-radius: var(--nxt-radius-sm); font-size: .8rem; font-weight: 600; padding: .5rem .7rem; cursor: pointer; transition: border-color .12s ease, background .12s ease; }
		.da-paybtn:hover:not(:disabled) { border-color: var(--nxt-stroke-strong); background: color-mix(in srgb, var(--nxt-ink) 8%, transparent); }
		.da-paybtn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
		.da-paybtn:disabled { opacity: .55; cursor: default; }
		.da-paybtn-three { border-color: color-mix(in srgb, var(--nxt-accent) 55%, transparent); background: color-mix(in srgb, var(--nxt-accent) 8%, transparent); }
		.da-off { font-size: .68rem; font-weight: 700; color: var(--nxt-accent); }
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
			<p class="dn-h1-sub" style="margin:0">The 660k-article crypto-news archive as a developer product — a monthly pass in three tiers, paid on Solana in $THREE, SOL, or USDC, instead of a payment per call.</p>
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
