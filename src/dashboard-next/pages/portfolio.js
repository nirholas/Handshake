// dashboard-next — Portfolio & NFTs page.
//
// Shows the user's on-chain holdings across linked wallets:
//   • Token balances (SOL, USDC, custom tokens via /api/wallet/balances)
//   • Avatar NFTs the user has minted
//   • Agent badges / credentials
//   • Pump.fun tokens launched by the user's agents
//
// Real endpoints:
//   GET /api/wallet/balances        { balances: [{ symbol, amount, usd_value, chain, mint }] }
//   GET /api/auth/wallets           { wallets: [...] }
//   GET /api/avatars                { avatars: [...] }   (filter nft_mint set)
//   GET /api/agents                 { agents: [...] }

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime, formatUsdc, ApiError } from '../api.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

const CHAIN_LABELS = {
	solana: 'Solana',
	base: 'Base',
	ethereum: 'Ethereum',
	polygon: 'Polygon',
	optimism: 'Optimism',
};

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();

		main.innerHTML = `
			<h1 class="dn-h1">Portfolio & NFTs</h1>
			<p class="dn-h1-sub">Your on-chain holdings — tokens, avatars minted as NFTs, and agent credentials.</p>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px">
				${Array.from({ length: 3 }).map(() => `<div class="dn-skeleton" style="height:120px;border-radius:12px"></div>`).join('')}
			</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		const [balancesResp, walletsResp, avatarsResp, agentsResp] = await Promise.all([
			safeGet('/api/wallet/balances'),
			safeGet('/api/auth/wallets'),
			safeGet('/api/avatars?limit=100'),
			safeGet('/api/agents'),
		]);

		const balances = balancesResp?.balances || balancesResp?.tokens || [];
		const wallets = walletsResp?.wallets || [];
		const avatars = (avatarsResp?.avatars || []).filter((av) => av.nft_mint || av.nft_address || av.token_id);
		const agents = agentsResp?.agents || [];
		const pumpAgents = agents.filter((a) => a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca);

		host.innerHTML = '';
		host.appendChild(renderBalances(balances, wallets));
		host.appendChild(renderNftAvatars(avatars));
		host.appendChild(renderPumpTokens(pumpAgents));
		host.appendChild(renderAgentBadges(agents));
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

async function safeGet(url) {
	try { return await get(url); }
	catch { return null; }
}

// ── Token balances ─────────────────────────────────────────────────────────

function renderBalances(balances, wallets) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Token balances</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Across ${wallets.length} linked wallet${wallets.length === 1 ? '' : 's'}.</div>
			</div>
			<a class="dn-btn" href="/dashboard-next/account">Manage wallets →</a>
		</div>
		<div data-slot="balances"></div>
	`;

	const host = panel.querySelector('[data-slot="balances"]');

	if (!wallets.length) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No wallets linked</h3>
				<p>Link a wallet to see your token balances.</p>
				<a class="dn-btn primary" href="/dashboard-next/account">Link wallet →</a>
			</div>`;
		return panel;
	}

	if (!balances.length) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No balances found</h3>
				<p>Your linked wallets appear to be empty, or balance data is temporarily unavailable.</p>
			</div>`;
		return panel;
	}

	const totalUsd = balances.reduce((s, b) => s + (Number(b.usd_value) || 0), 0);

	host.innerHTML = `
		<div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;margin-bottom:16px">
			$${totalUsd.toFixed(2)}
			<span style="font-size:13px;font-weight:400;color:var(--nxt-ink-dim)">estimated total</span>
		</div>
		<div style="overflow-x:auto">
			<table style="width:100%;border-collapse:collapse;font-size:13px">
				<thead>
					<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
						<th style="padding:8px 10px;font-weight:500">Token</th>
						<th style="padding:8px 10px;font-weight:500">Chain</th>
						<th style="padding:8px 10px;font-weight:500;text-align:right">Balance</th>
						<th style="padding:8px 10px;font-weight:500;text-align:right">USD Value</th>
					</tr>
				</thead>
				<tbody>
					${balances.map((b) => `
						<tr style="border-bottom:1px solid var(--nxt-stroke)">
							<td style="padding:10px">
								<div style="font-weight:600">${esc(b.symbol || b.name || 'Unknown')}</div>
								${b.mint ? `<div style="font-family:${MONO};font-size:11px;color:var(--nxt-ink-fade)">${esc(b.mint.slice(0, 12))}…</div>` : ''}
							</td>
							<td style="padding:10px;color:var(--nxt-ink-dim)">${esc(CHAIN_LABELS[b.chain] || b.chain || '—')}</td>
							<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">
								${esc(formatAmount(b))}
							</td>
							<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--nxt-ink-dim)">
								${b.usd_value != null ? `$${Number(b.usd_value).toFixed(2)}` : '—'}
							</td>
						</tr>
					`).join('')}
				</tbody>
			</table>
		</div>
	`;
	return panel;
}

function formatAmount(b) {
	const n = Number(b.amount) || 0;
	if (n === 0) return '0';
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
	if (n < 0.0001) return n.toExponential(2);
	return n.toFixed(n < 0.01 ? 6 : 4);
}

// ── NFT Avatars ────────────────────────────────────────────────────────────

function renderNftAvatars(nftAvatars) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Avatar NFTs</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Avatars you've minted on-chain as NFTs.</div>
			</div>
			<a class="dn-btn" href="/dashboard-next/avatars">All avatars →</a>
		</div>
		<div data-slot="nfts"></div>
	`;
	const host = panel.querySelector('[data-slot="nfts"]');

	if (!nftAvatars.length) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No avatar NFTs</h3>
				<p>Mint an avatar as an NFT to anchor your 3D identity on-chain.</p>
				<a class="dn-btn primary" href="/dashboard-next/avatars">View avatars →</a>
			</div>`;
		return panel;
	}

	host.innerHTML = `
		<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">
			${nftAvatars.map((av) => `
				<div style="border:1px solid var(--nxt-stroke);border-radius:10px;overflow:hidden;background:rgba(255,255,255,0.02)">
					${av.thumbnail_url
						? `<img src="${esc(av.thumbnail_url)}" alt="${esc(av.name || '')}" style="width:100%;aspect-ratio:1;object-fit:cover" loading="lazy" />`
						: `<div style="width:100%;aspect-ratio:1;background:rgba(154,124,255,0.12);display:grid;place-items:center;color:var(--nxt-ink-fade);font-size:32px">🎭</div>`
					}
					<div style="padding:10px">
						<div style="font-weight:600;font-size:13px;margin-bottom:4px">${esc(av.name || 'Untitled')}</div>
						<div style="font-family:${MONO};font-size:11px;color:var(--nxt-ink-fade)">${esc((av.nft_mint || av.nft_address || av.token_id || '').slice(0, 14))}…</div>
						<a href="/avatar-artifact?id=${encodeURIComponent(av.id)}" target="_blank" rel="noopener"
							style="display:inline-block;margin-top:8px;font-size:11.5px;color:var(--nxt-accent)">View NFT ↗</a>
					</div>
				</div>
			`).join('')}
		</div>
	`;
	return panel;
}

// ── Pump.fun tokens ────────────────────────────────────────────────────────

function renderPumpTokens(pumpAgents) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Pump.fun tokens</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Tokens your agents launched on Pump.fun.</div>
			</div>
			<a class="dn-btn" href="/dashboard-next/tokens">Token dashboard →</a>
		</div>
		<div data-slot="tokens"></div>
	`;
	const host = panel.querySelector('[data-slot="tokens"]');

	if (!pumpAgents.length) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No tokens launched</h3>
				<p>Launch a Pump.fun token from any of your agents to see it here.</p>
				<a class="dn-btn primary" href="/dashboard-next/tokens">Token dashboard →</a>
			</div>`;
		return panel;
	}

	host.innerHTML = `
		<div style="overflow-x:auto">
			<table style="width:100%;border-collapse:collapse;font-size:13px">
				<thead>
					<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
						<th style="padding:8px 10px;font-weight:500">Agent / Token</th>
						<th style="padding:8px 10px;font-weight:500;text-align:right">Holders</th>
						<th style="padding:8px 10px;font-weight:500"></th>
					</tr>
				</thead>
				<tbody>
					${pumpAgents.map((a) => {
						const meta = a.meta?.pumpfun || a.meta?.token || {};
						const mint = meta.mint || meta.address || meta.ca || '';
						const ticker = meta.symbol || meta.ticker || a.name || 'TOKEN';
						const holders = meta.holders ?? '—';
						return `
							<tr style="border-bottom:1px solid var(--nxt-stroke)">
								<td style="padding:10px">
									<div style="font-weight:600">$${esc(String(ticker).toUpperCase())}</div>
									<div style="color:var(--nxt-ink-dim);font-size:12px">${esc(a.name || a.display_name || '')}</div>
								</td>
								<td style="padding:10px;text-align:right;color:var(--nxt-ink-dim)">${esc(String(holders))}</td>
								<td style="padding:10px;text-align:right">
									${mint ? `<a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">View ↗</a>` : ''}
								</td>
							</tr>
						`;
					}).join('')}
				</tbody>
			</table>
		</div>
	`;
	return panel;
}

// ── Agent badges ───────────────────────────────────────────────────────────

function renderAgentBadges(agents) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const registered = agents.filter((a) => a.onchain_id || a.erc8004_id || a.chain_id);

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">On-chain agent registry</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Agents registered under ERC-8004.</div>
			</div>
			<a class="dn-btn" href="/onchain" target="_blank" rel="noopener">Browse registry ↗</a>
		</div>
		<div data-slot="badges"></div>
	`;
	const host = panel.querySelector('[data-slot="badges"]');

	if (!registered.length) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No on-chain registrations</h3>
				<p>Register an agent on-chain to give it an immutable ERC-8004 identity.</p>
				<a class="dn-btn primary" href="/onchain" target="_blank" rel="noopener">ERC-8004 registry ↗</a>
			</div>`;
		return panel;
	}

	host.innerHTML = `
		<div style="display:flex;flex-direction:column;gap:8px">
			${registered.map((a) => `
				<div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--nxt-stroke);border-radius:8px">
					<div style="flex:1">
						<div style="font-weight:600;font-size:13.5px">${esc(a.name || a.display_name || 'Agent')}</div>
						<div style="font-family:${MONO};font-size:11.5px;color:var(--nxt-ink-fade)">${esc(a.onchain_id || a.erc8004_id || '')}</div>
					</div>
					<span class="dn-tag success">registered</span>
					<a href="/onchain?agent=${encodeURIComponent(a.id)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--nxt-accent)">View ↗</a>
				</div>
			`).join('')}
		</div>
	`;
	return panel;
}
