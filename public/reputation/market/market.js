/**
 * /reputation/market: the Reputation Staking Market surface.
 *
 * Renders the four reads of specs/REPUTATION_STAKING_MARKET.md §8 and drives the
 * two writes. Everything on screen is derived from a signed attestation or an
 * escrowed lamport that the server read back off Solana; this module never
 * invents a number and never asserts a principal.
 *
 * The heavy Solana bundle (@solana/web3.js, via ../../src/solana-stake.js) is
 * imported lazily, only when the staker actually asks to sign, so a reader who
 * just wants the leaderboard never downloads a wallet stack.
 *
 * Walkthrough: docs/reputation-staking-market.md.
 */

import { formatSol } from '../../src/shared/reputation-staking.js';

const $ = (id) => document.getElementById(id);
const els = {
	stats: $('rsm-stats'),
	market: $('rsm-market'),
	netGroup: document.querySelector('.rsm-net'),
	stakeForm: $('rsm-stake-form'),
	stakeAgent: $('rsm-stake-agent'),
	stakeAmount: $('rsm-stake-amount'),
	stakeScore: $('rsm-stake-score'),
	stakeGo: $('rsm-stake-go'),
	recordForm: $('rsm-record-form'),
	recordSig: $('rsm-record-sig'),
	stakeMsg: $('rsm-stake-msg'),
	posForm: $('rsm-pos-form'),
	posStaker: $('rsm-pos-staker'),
	posConnect: $('rsm-pos-connect'),
	positions: $('rsm-positions'),
	posMsg: $('rsm-pos-msg'),
};

const STAKER_KEY = 'threews.rsm.staker';
const params = new URLSearchParams(location.search);

const state = {
	network: params.get('network') === 'mainnet' ? 'mainnet' : 'devnet',
	market: null,
	staker: (params.get('staker') || localStorage.getItem(STAKER_KEY) || '').trim(),
};

// ── formatting ───────────────────────────────────────────────────────────────

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const short = (pk) => (pk && pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk || '');

const sol = (lamports) => `${formatSol(lamports)} SOL`;

const pct = (fraction) => {
	const n = Number(fraction) || 0;
	if (n === 0) return '0%';
	return `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
};

const num = (n, digits = 3) => (Number(n) || 0).toFixed(digits);

const ago = (iso) => {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return '';
	const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (secs < 90) return `${secs}s ago`;
	if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
	if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
	return `${Math.round(secs / 86400)}d ago`;
};

const explorerTx = (sig) =>
	`https://explorer.solana.com/tx/${encodeURIComponent(sig)}${state.network === 'devnet' ? '?cluster=devnet' : ''}`;

// ── shared state renderers (the page's own design tokens) ─────────────────────

const skeleton = (rows = 4) => Array.from({ length: rows }, () => '<div class="rsm-skel"></div>').join('');

const emptyState = ({ title, body, action }) => `
	<div class="rsm-empty">
		<h4>${esc(title)}</h4>
		<p>${esc(body)}</p>
		${action ? `<button class="rsm-btn" type="button" data-action="${esc(action.id)}">${esc(action.label)}</button>` : ''}
	</div>`;

const errorState = ({ title, body, retry }) => `
	<div class="rsm-error" role="alert">
		<h4>${esc(title)}</h4>
		<p>${esc(body)}</p>
		${retry ? `<button class="rsm-btn" type="button" data-action="${esc(retry)}">Try again</button>` : ''}
	</div>`;

function say(el, text, tone = '') {
	el.textContent = text;
	el.className = `rsm-msg${tone ? ` ${tone}` : ''}`;
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Every call funnels through here so a failure always carries the server's own code. */
async function api(path, init) {
	const res = await fetch(path, init);
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const err = new Error(body?.error_description || `Request failed (${res.status})`);
		err.code = body?.error || 'request_failed';
		err.status = res.status;
		throw err;
	}
	return body;
}

// ── market table ─────────────────────────────────────────────────────────────

function renderStats(market) {
	if (!market) {
		els.stats.innerHTML = Array.from(
			{ length: 4 },
			() => '<div class="rsm-stat"><div class="rsm-skel" style="height:1.4rem"></div></div>',
		).join('');
		return;
	}
	const staked = market.agents.reduce((sum, a) => sum + BigInt(a.staked_lamports), 0n);
	const positions = market.agents.reduce((sum, a) => sum + a.open_positions, 0);
	const cells = [
		[sol(staked), 'Total staked'],
		[String(positions), 'Open positions'],
		[sol(market.epoch_pool_lamports), 'Epoch pool'],
		[`#${market.epoch}`, 'UTC epoch'],
	];
	els.stats.innerHTML = cells
		.map(
			([v, l]) =>
				`<div class="rsm-stat"><div class="rsm-stat-v rsm-num">${esc(v)}</div><div class="rsm-stat-l">${esc(l)}</div></div>`,
		)
		.join('');
}

function agentRow(agent, maxWeight) {
	const weight = Number(agent.epoch_weight) || 0;
	const bar = maxWeight > 0 ? Math.max(2, Math.round((weight / maxWeight) * 100)) : 0;
	const label = agent.name
		? `<a class="rsm-agent-name" href="/agent/${encodeURIComponent(agent.agent_id)}">${esc(agent.name)}</a>`
		: '<span class="rsm-agent-name">Unnamed agent</span>';
	const apr = Number(agent.realized_apr) || 0;
	return `
		<tr>
			<td>
				<span class="rsm-agent">
					${label}
					<span class="rsm-mono">${esc(short(agent.agent_asset))}</span>
				</span>
			</td>
			<td class="rsm-num">${esc(sol(agent.staked_lamports))}</td>
			<td class="rsm-num">${agent.unique_stakers}</td>
			<td class="rsm-num">${agent.mean_conviction === null ? '<span class="rsm-zero">n/a</span>' : num(agent.mean_conviction, 2)}</td>
			<td class="rsm-num">
				${weight > 0 ? num(weight) : '<span class="rsm-zero">0</span>'}
				<span class="rsm-bar" aria-hidden="true"><span style="width:${bar}%"></span></span>
			</td>
			<td class="rsm-num ${apr > 0 ? 'rsm-pos' : 'rsm-zero'}">${esc(pct(apr))}</td>
			<td><button class="rsm-btn" type="button" data-stake-agent="${esc(agent.agent_asset)}">Stake</button></td>
		</tr>`;
}

function renderMarket(market) {
	if (market.agents.length === 0) {
		els.market.innerHTML = emptyState({
			title: 'No conviction staked yet on this network',
			body: 'Be the first: paste an agent asset pubkey below, pick a conviction, and open a position. The market ranks agents the moment principal lands in escrow.',
			action: { id: 'focus-stake', label: 'Open the first position' },
		});
		return;
	}
	const maxWeight = market.agents.reduce((m, a) => Math.max(m, Number(a.epoch_weight) || 0), 0);
	els.market.innerHTML = `
		<div class="rsm-scroll">
			<table class="rsm-table">
				<thead>
					<tr>
						<th scope="col">Agent</th>
						<th scope="col">Staked</th>
						<th scope="col">Stakers</th>
						<th scope="col">Conviction</th>
						<th scope="col">Epoch weight</th>
						<th scope="col">Realized</th>
						<th scope="col"><span class="rsm-mono">&nbsp;</span></th>
					</tr>
				</thead>
				<tbody>${market.agents.map((a) => agentRow(a, maxWeight)).join('')}</tbody>
			</table>
		</div>`;
}

async function loadMarket() {
	renderStats(null);
	els.market.innerHTML = skeleton(5);
	try {
		const market = await api(`/api/reputation/market?network=${state.network}&limit=50`);
		state.market = market;
		renderStats(market);
		renderMarket(market);
		syncWritability();
	} catch (err) {
		state.market = null;
		els.stats.innerHTML = '';
		els.market.innerHTML = errorState({
			title: err.code === 'market_not_configured' ? 'No market on this network yet' : 'Could not load the market',
			body:
				err.code === 'market_not_configured'
					? 'This deployment has no staking escrow configured for this network, so there is nothing to stake into. Devnet is the free proof path.'
					: err.message,
			retry: 'reload-market',
		});
		syncWritability();
	}
}

/**
 * Mainnet writes are owner-gated (spec §1). Reflect that in the controls rather
 * than letting a staker build a transaction the server will refuse.
 */
function syncWritability() {
	const m = state.market;
	const blocked = !m || !m.escrow || (state.network === 'mainnet' && !m.mainnet_open);
	for (const el of [els.stakeGo, els.recordForm.querySelector('button')]) {
		el.disabled = blocked;
		el.title = blocked ? 'This network is not open for staking on this deployment.' : '';
	}
	if (blocked && m && state.network === 'mainnet' && !m.mainnet_open) {
		say(els.stakeMsg, 'Mainnet staking is owner-gated on this deployment. Devnet is open.', '');
	}
}

// ── positions ────────────────────────────────────────────────────────────────

function positionCard(p) {
	const chip = p.status === 'open' ? 'open' : p.status === 'settling' ? 'settling' : 'closed';
	const earnings = BigInt(p.earnings_lamports);
	const label = p.name
		? `<a href="/agent/${encodeURIComponent(p.agent_id)}">${esc(p.name)}</a>`
		: esc(short(p.agent_asset));
	return `
		<article class="rsm-card">
			<div class="rsm-card-top">
				<div class="rsm-agent">
					<span class="rsm-agent-name">${label}</span>
					<a class="rsm-mono" href="${esc(explorerTx(p.signature))}" target="_blank" rel="noopener noreferrer"
						>${esc(short(p.signature))} ↗</a
					>
				</div>
				<span class="rsm-chip ${chip}">${esc(p.status)}</span>
			</div>
			<div class="rsm-card-grid">
				<div>
					<div class="rsm-kv-l">Principal</div>
					<div class="rsm-kv-v">${esc(sol(p.principal_lamports))}</div>
				</div>
				<div>
					<div class="rsm-kv-l">${p.pending ? 'Earnings (pending)' : 'Earnings (settled)'}</div>
					<div class="rsm-kv-v ${earnings > 0n ? 'rsm-pos' : 'rsm-zero'}">${esc(sol(earnings))}</div>
				</div>
				<div>
					<div class="rsm-kv-l">Realized</div>
					<div class="rsm-kv-v">${esc(pct(p.realized_apr))}</div>
				</div>
				<div>
					<div class="rsm-kv-l">Opened</div>
					<div class="rsm-kv-v">${esc(ago(p.opened_at))}</div>
				</div>
			</div>
			<div style="margin-top:0.9rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
				${
					p.status === 'closed'
						? `<a class="rsm-btn" href="${esc(explorerTx(p.settle_signature))}" target="_blank" rel="noopener noreferrer">Settlement ↗</a>`
						: `<button class="rsm-btn primary" type="button" data-withdraw="${esc(p.signature)}">Withdraw principal + earnings</button>`
				}
				<span class="rsm-mono">${p.breakdown?.length ? `${p.breakdown.length} epoch${p.breakdown.length === 1 ? '' : 's'} accrued` : 'no epoch has accrued yet'}</span>
			</div>
		</article>`;
}

async function loadPositions(staker) {
	const who = (staker ?? state.staker).trim();
	if (!who) {
		els.positions.innerHTML = emptyState({
			title: 'Look up any wallet',
			body: 'Positions are owned by the wallet that signed the stake, so nothing here is private. Paste a staker pubkey or connect a Solana wallet.',
			action: { id: 'connect-staker', label: 'Use my wallet' },
		});
		return;
	}
	state.staker = who;
	els.posStaker.value = who;
	localStorage.setItem(STAKER_KEY, who);
	els.positions.innerHTML = skeleton(2);
	try {
		const view = await api(`/api/reputation/market-positions?staker=${encodeURIComponent(who)}&network=${state.network}`);
		if (view.count === 0) {
			els.positions.innerHTML = emptyState({
				title: 'No positions for this wallet',
				body: `${short(who)} holds nothing in the ${state.network} market. Open a position above and it will appear here as soon as the transaction confirms.`,
				action: { id: 'focus-stake', label: 'Open a position' },
			});
			return;
		}
		els.positions.innerHTML = `<div class="rsm-cards">${view.positions.map(positionCard).join('')}</div>`;
	} catch (err) {
		els.positions.innerHTML = errorState({
			title: 'Could not load positions',
			body: err.message,
			retry: 'reload-positions',
		});
	}
}

// ── wallet ───────────────────────────────────────────────────────────────────

function detectSolanaWallet() {
	return (
		window.phantom?.solana || window.backpack?.solana || window.solflare || window.threeWsWallet || window.solana || null
	);
}

async function connectWallet() {
	const provider = detectSolanaWallet();
	if (!provider) {
		throw new Error('No Solana wallet found. Install Phantom, Backpack, or Solflare, then reload.');
	}
	if (!provider.publicKey) await provider.connect();
	if (!provider.publicKey) throw new Error('Wallet did not return a public key.');
	return provider;
}

// ── writes ───────────────────────────────────────────────────────────────────

async function indexStake(signature) {
	const body = await api('/api/reputation/market-stake', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ signature, network: state.network }),
	});
	return body.position;
}

async function submitStake(event) {
	event.preventDefault();
	const agent = els.stakeAgent.value.trim();
	const amountSol = Number(els.stakeAmount.value);
	const score = Number(els.stakeScore.value);

	if (!agent) return say(els.stakeMsg, 'Enter the agent asset pubkey you want to back.', 'bad');
	if (!(amountSol >= 0.001)) return say(els.stakeMsg, 'The minimum stake is 0.001 SOL.', 'bad');
	if (!state.market?.escrow) return say(els.stakeMsg, 'This network has no market escrow configured.', 'bad');

	els.stakeGo.disabled = true;
	try {
		say(els.stakeMsg, 'Connecting your wallet…');
		const wallet = await connectWallet();

		say(els.stakeMsg, 'Loading the Solana signer…');
		const { stakeOnMarket } = await import('../../src/solana-stake.js');

		say(els.stakeMsg, `Approve the transfer of ${amountSol} SOL to the market escrow in your wallet…`);
		const signature = await stakeOnMarket({
			agentAsset: agent,
			escrow: state.market.escrow,
			lamports: BigInt(Math.round(amountSol * 1e9)),
			score,
			network: state.network,
			wallet,
		});

		say(els.stakeMsg, 'Verifying the transaction against the chain…');
		const position = await indexStake(signature);
		say(els.stakeMsg, `Position open: ${sol(position.principal_lamports)} on ${short(position.agent_asset)}.`, 'ok');

		await Promise.all([loadMarket(), loadPositions(position.staker)]);
	} catch (err) {
		say(els.stakeMsg, err.message, 'bad');
	} finally {
		els.stakeGo.disabled = false;
		syncWritability();
	}
}

async function submitRecord(event) {
	event.preventDefault();
	const signature = els.recordSig.value.trim();
	if (!signature) return say(els.stakeMsg, 'Paste the signature of a stake transaction you already broadcast.', 'bad');

	const button = els.recordForm.querySelector('button');
	button.disabled = true;
	try {
		say(els.stakeMsg, 'Reading the transaction back off Solana…');
		const position = await indexStake(signature);
		say(els.stakeMsg, `Verified: ${sol(position.principal_lamports)} staked on ${short(position.agent_asset)}.`, 'ok');
		els.recordSig.value = '';
		await Promise.all([loadMarket(), loadPositions(position.staker)]);
	} catch (err) {
		say(els.stakeMsg, err.message, 'bad');
	} finally {
		button.disabled = false;
		syncWritability();
	}
}

async function withdraw(signature, button) {
	button.disabled = true;
	const original = button.textContent;
	button.textContent = 'Settling…';
	try {
		const body = await api('/api/reputation/market-withdraw', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ signature, network: state.network }),
		});
		const s = body.settlement;
		const paid = BigInt(s.principal_lamports) + BigInt(s.earnings_lamports);
		say(
			els.posMsg,
			body.status === 'already_closed'
				? `Already settled: ${sol(paid)} was returned to the staker.`
				: `Settled: ${sol(paid)} returned (${sol(s.earnings_lamports)} earned)${s.clamped ? ', earnings clamped to the escrow surplus' : ''}.`,
			'ok',
		);
		await Promise.all([loadMarket(), loadPositions()]);
	} catch (err) {
		say(els.posMsg, err.message, 'bad');
		button.disabled = false;
		button.textContent = original;
	}
}

// ── wiring ───────────────────────────────────────────────────────────────────

function focusStake(agentAsset) {
	if (agentAsset) els.stakeAgent.value = agentAsset;
	els.stakeAgent.focus();
	els.stakeAgent.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setNetwork(network) {
	if (network === state.network) return;
	state.network = network;
	for (const b of els.netGroup.querySelectorAll('button')) {
		b.setAttribute('aria-pressed', String(b.dataset.network === network));
	}
	const url = new URL(location.href);
	url.searchParams.set('network', network);
	history.replaceState(null, '', url);
	say(els.stakeMsg, '');
	say(els.posMsg, '');
	loadMarket();
	loadPositions();
}

els.netGroup.addEventListener('click', (e) => {
	const button = e.target.closest('button[data-network]');
	if (button) setNetwork(button.dataset.network);
});

document.addEventListener('click', async (e) => {
	const stakeBtn = e.target.closest('[data-stake-agent]');
	if (stakeBtn) return focusStake(stakeBtn.dataset.stakeAgent);

	const withdrawBtn = e.target.closest('[data-withdraw]');
	if (withdrawBtn) return withdraw(withdrawBtn.dataset.withdraw, withdrawBtn);

	const action = e.target.closest('[data-action]')?.dataset.action;
	if (action === 'reload-market') return loadMarket();
	if (action === 'reload-positions') return loadPositions();
	if (action === 'focus-stake') return focusStake();
	if (action === 'connect-staker') return connectStaker();
});

async function connectStaker() {
	try {
		say(els.posMsg, 'Connecting your wallet…');
		const wallet = await connectWallet();
		say(els.posMsg, '');
		await loadPositions(wallet.publicKey.toString());
	} catch (err) {
		say(els.posMsg, err.message, 'bad');
	}
}

els.stakeForm.addEventListener('submit', submitStake);
els.recordForm.addEventListener('submit', submitRecord);
els.posForm.addEventListener('submit', (e) => {
	e.preventDefault();
	say(els.posMsg, '');
	loadPositions(els.posStaker.value);
});
els.posConnect.addEventListener('click', connectStaker);

for (const b of els.netGroup.querySelectorAll('button')) {
	b.setAttribute('aria-pressed', String(b.dataset.network === state.network));
}
if (params.get('agent')) els.stakeAgent.value = params.get('agent');

loadMarket();
loadPositions();
