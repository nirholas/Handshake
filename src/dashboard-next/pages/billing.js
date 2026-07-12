// dashboard-next — Billing & Passes (the user-side money page).
//
// One place to see everything you PAY for on three.ws (the mirror of
// /dashboard/monetize, which is what you EARN): the Premium pass with its
// on-chain purchase history, the API keys those passes minted, creator
// subscriptions you hold, and jump-offs to invoices, partner x402 keys, and
// the full transaction ledger.
//
// Data: /api/premium/mine (session-linked passes + keys), /api/subscriptions/mine
// (creator subscriptions). Both render independently — one failing never
// blanks the other.

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime } from '../api.js';
import {
	skeletonHTML,
	emptyStateHTML,
	errorStateHTML,
	ensureStateKitStyles,
} from '../../shared/state-kit.js';

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
function assetAmount(p) {
	const decimals = p.asset === 'SOL' ? 9 : 6;
	const n = Number(p.amount_atomics) / 10 ** decimals;
	const v = n >= 1000 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumSignificantDigits: 4 });
	return `${v} ${p.asset === 'THREE' ? '$THREE' : p.asset}`;
}
const solscan = (sig) => `https://solscan.io/tx/${encodeURIComponent(sig)}`;

// ── Premium section ──────────────────────────────────────────────────────────

function renderPremium(data) {
	const el = $('bl-premium');
	if (!data) {
		el.innerHTML = errorStateHTML({ title: 'Couldn’t load your passes', body: 'The premium endpoint is unreachable — retry in a moment.' });
		return;
	}
	const { active, passes, keys, plan } = data;
	const tiers = Array.isArray(data.plans) && data.plans.length ? data.plans : [plan];
	const fromUsd = Math.min(...tiers.map((t) => Number(t.usd)));
	const tierName = (id) => {
		const t = tiers.find((x) => x.id === (id === 'premium' ? 'developer' : id));
		return t?.tier || t?.name || 'Premium';
	};

	const hero = active
		? `
			<div class="bl-hero bl-hero-active">
				<div>
					<div class="bl-kicker">Premium pass · ${esc(tierName(active.plan))}</div>
					<div class="bl-title"><span class="bl-dot"></span> Active — ${daysLeft(active.expires_at)} days left</div>
					<p class="bl-sub">Wallet <code>${esc(active.wallet.slice(0, 4))}…${esc(active.wallet.slice(-4))}</code> · runs until ${esc(fmtDate(active.expires_at))}</p>
				</div>
				<a class="dn-btn primary" href="/dashboard/data-api">Manage &amp; renew</a>
			</div>`
		: `
			<div class="bl-hero">
				<div>
					<div class="bl-kicker">Premium pass</div>
					<div class="bl-title">No active pass</div>
					<p class="bl-sub">Premium unlocks unmetered Data-API search and an API key from $${fromUsd.toFixed(2)}/${plan.days} days — payable in $THREE (20% off), SOL, or USDC on Solana.</p>
				</div>
				<a class="dn-btn primary" href="/dashboard/data-api">Go Premium</a>
			</div>`;

	const history = passes.length
		? `
			<div class="bl-scroll">
				<table class="bl-table">
					<thead><tr><th>Purchased</th><th>Tier</th><th>Paid</th><th class="bl-num">USD</th><th>Period</th><th>Transaction</th></tr></thead>
					<tbody>
						${passes.map((p) => `
							<tr>
								<td>${esc(fmtDate(p.created_at))}</td>
								<td>${esc(tierName(p.plan))}</td>
								<td>${esc(assetAmount(p))}</td>
								<td class="bl-num">$${Number(p.usd_price).toFixed(2)}</td>
								<td>${esc(fmtDate(p.started_at))} → ${esc(fmtDate(p.expires_at))}</td>
								<td><a href="${esc(solscan(p.tx_signature))}" target="_blank" rel="noopener">${esc(p.tx_signature.slice(0, 8))}…</a></td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>`
		: `<p class="bl-note">No purchases yet.</p>`;

	const keyRows = keys.length
		? `
			<div class="bl-scroll">
				<table class="bl-table">
					<thead><tr><th>Key</th><th>Status</th><th>Wallet</th><th>Expires</th><th class="bl-num">Calls granted</th><th>Last used</th></tr></thead>
					<tbody>
						${keys.map((k) => `
							<tr>
								<td><code>${esc(k.key_prefix)}…</code></td>
								<td>${k.status === 'active' ? '<span class="bl-ok">active</span>' : `<span class="bl-bad">${esc(k.status)}</span>`}</td>
								<td>${k.wallet ? `<code>${esc(k.wallet.slice(0, 4))}…${esc(k.wallet.slice(-4))}</code>` : '—'}</td>
								<td>${esc(fmtDate(k.expires_at))}</td>
								<td class="bl-num">${Number(k.usage.granted).toLocaleString()}</td>
								<td>${k.usage.last_seen ? esc(relTime(k.usage.last_seen)) : '—'}</td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>
			<p class="bl-note">Rotate or revoke keys on the <a href="/dashboard/data-api">Data API console</a>.</p>`
		: '';

	el.innerHTML = `
		${hero}
		<section class="dn-panel">
			<div class="bl-panel-head"><h2>Payment history</h2><span class="bl-tagline">every purchase is one on-chain Solana transaction</span></div>
			${history}
		</section>
		${keys.length ? `<section class="dn-panel"><div class="bl-panel-head"><h2>API keys from your passes</h2></div>${keyRows}</section>` : ''}`;
}

// ── Creator subscriptions ────────────────────────────────────────────────────

function renderSubscriptions(subs) {
	const el = $('bl-subs');
	if (subs === null) {
		// Endpoint failed — say so quietly, don't fake an empty state.
		el.innerHTML = `
			<section class="dn-panel">
				<div class="bl-panel-head"><h2>Creator subscriptions</h2></div>
				<p class="bl-note">Couldn’t load your creator subscriptions right now — they’re unaffected; retry in a moment.</p>
			</section>`;
		return;
	}
	const list = Array.isArray(subs) ? subs : subs?.subscriptions || subs?.data || [];
	if (!list.length) {
		el.innerHTML = `
			<section class="dn-panel">
				<div class="bl-panel-head"><h2>Creator subscriptions</h2></div>
				${emptyStateHTML({
					icon: '💫',
					title: 'No creator subscriptions',
					body: 'When you subscribe to a creator or an agent’s skill plan, it shows up here with its renewal date.',
					actions: [{ label: 'Browse the marketplace', href: '/marketplace' }],
				})}
			</section>`;
		return;
	}
	const rows = list.map((s) => `
		<tr>
			<td>${esc(s.plan_name || s.name || s.plan_id || 'plan')}</td>
			<td>${esc(s.creator_handle || s.creator_id || s.agent_id || '—')}</td>
			<td>${esc(String(s.status || '—'))}</td>
			<td>${s.current_period_ends_at ? esc(fmtDate(s.current_period_ends_at)) : '—'}</td>
			<td class="bl-num">${s.price_usd != null ? `$${Number(s.price_usd).toFixed(2)}` : '—'}</td>
		</tr>`).join('');
	el.innerHTML = `
		<section class="dn-panel">
			<div class="bl-panel-head"><h2>Creator subscriptions</h2></div>
			<div class="bl-scroll">
				<table class="bl-table">
					<thead><tr><th>Plan</th><th>Creator</th><th>Status</th><th>Renews</th><th class="bl-num">Price</th></tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		</section>`;
}

function renderLinks() {
	$('bl-links').innerHTML = `
		<section class="dn-panel">
			<div class="bl-panel-head"><h2>More money surfaces</h2></div>
			<div class="bl-linkgrid">
				<a class="bl-link" href="/dashboard/transactions"><strong>Transactions</strong><span>Full ledger of purchases and sales, with CSV export.</span></a>
				<a class="bl-link" href="/billing"><strong>Invoices</strong><span>Statements and invoice history.</span></a>
				<a class="bl-link" href="/billing/keys"><strong>Partner x402 keys</strong><span>AWS Marketplace and partner subscription keys.</span></a>
				<a class="bl-link" href="/dashboard/monetize"><strong>Monetize</strong><span>The other direction — what you earn, payouts, and plans you sell.</span></a>
			</div>
		</section>`;
}

function injectStyles() {
	if (document.getElementById('bl-styles')) return;
	ensureStateKitStyles();
	const s = document.createElement('style');
	s.id = 'bl-styles';
	s.textContent = `
		.bl-root { display: flex; flex-direction: column; gap: 1.25rem; padding-bottom: 3rem; }
		.bl-hero { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; background: var(--nxt-glass); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 1.2rem 1.4rem; }
		.bl-hero-active { border-left: 3px solid var(--nxt-success); }
		.bl-kicker { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: var(--nxt-ink-fade); }
		.bl-title { font-size: 1.3rem; font-weight: 680; color: var(--nxt-ink); margin: .2rem 0; display: flex; align-items: center; gap: .5rem; }
		.bl-sub { margin: 0; font-size: .84rem; color: var(--nxt-ink-dim); line-height: 1.5; }
		.bl-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--nxt-success); box-shadow: 0 0 8px var(--nxt-success); display: inline-block; }
		.bl-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin-bottom: .8rem; }
		.bl-panel-head h2 { margin: 0; font-size: .95rem; font-weight: 650; color: var(--nxt-ink); }
		.bl-tagline { font-size: .74rem; color: var(--nxt-ink-fade); }
		.bl-note { margin: .6rem 0 0; font-size: .8rem; color: var(--nxt-ink-dim); }
		.bl-note a { color: var(--nxt-accent); }
		.bl-scroll { overflow-x: auto; }
		.bl-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
		.bl-table th { text-align: left; font-weight: 600; color: var(--nxt-ink-fade); font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; padding: .35rem .5rem; border-bottom: 1px solid var(--nxt-stroke); white-space: nowrap; }
		.bl-table td { padding: .45rem .5rem; border-bottom: 1px solid color-mix(in srgb, var(--nxt-stroke) 55%, transparent); color: var(--nxt-ink); }
		.bl-table a { color: var(--nxt-accent); }
		.bl-num { text-align: right; font-variant-numeric: tabular-nums; }
		.bl-ok { color: var(--nxt-success); font-weight: 600; }
		.bl-bad { color: var(--nxt-danger); font-weight: 600; }
		.bl-linkgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: .7rem; }
		.bl-link { display: flex; flex-direction: column; gap: .25rem; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: .8rem .9rem; text-decoration: none; transition: border-color .15s ease, transform .15s ease; }
		.bl-link:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
		.bl-link:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
		.bl-link strong { color: var(--nxt-ink); font-size: .86rem; }
		.bl-link span { color: var(--nxt-ink-fade); font-size: .74rem; line-height: 1.4; }
	`;
	document.head.appendChild(s);
}

(async function boot() {
	const main = await mountShell();
	await requireUser();
	injectStyles();

	main.innerHTML = `
		<div style="margin-bottom:1.5rem">
			<h1 class="dn-h1" style="margin-bottom:.25rem">Billing &amp; Passes</h1>
			<p class="dn-h1-sub" style="margin:0">Everything you pay for on three.ws — your Premium pass, on-chain payment history, API keys, and subscriptions.</p>
		</div>
		<div class="bl-root">
			<div id="bl-premium"><div class="dn-panel">${skeletonHTML(3, 'row')}</div></div>
			<div id="bl-subs"><div class="dn-panel">${skeletonHTML(2, 'row')}</div></div>
			<div id="bl-links"></div>
		</div>`;

	renderLinks();
	const [premium, subs] = await Promise.all([
		get('/api/premium/mine').catch(() => null),
		get('/api/subscriptions/mine').catch(() => null),
	]);
	renderPremium(premium);
	renderSubscriptions(subs);
})().catch((err) => {
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `<h1 class="dn-h1">Billing &amp; Passes</h1><div class="dn-panel"><div class="dn-panel-title" style="color:var(--nxt-danger)">Failed to load</div><div class="dn-panel-sub">${String(err?.message || 'unknown').replace(/</g, '&lt;')}</div></div>`;
});
