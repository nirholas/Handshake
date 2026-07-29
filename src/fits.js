/**
 * /fits: the public cosmetics economy.
 *
 * Premium cosmetics on three.ws are bought with real USDC, and every sale
 * splits revenue with the creator of the coin world the fit belongs to. That
 * whole ledger existed only behind a panel inside /play. This page makes it a
 * first-class surface: the scarcest fits, the collectors wearing them, the
 * creators actually getting paid, a live sales drip, and a per-wallet earnings
 * lookup any creator can open without an account.
 *
 *   GET /api/cosmetics/leaderboard  rarest fits, top collectors/creators, recent
 *   GET /api/cosmetics/earnings?creator=<wallet>  one creator's settled earnings
 *
 * Every number is read from the settled-sale ledger. A quiet economy shows an
 * honest empty state rather than filler.
 */
import {
	RARITY_LABEL,
	fmtUsdc,
	fmtCount,
	shortWallet,
	displayAccount,
	rankFits,
	summarizeBoard,
	boardIsEmpty,
	coinWorldUrl,
	solscanAccountUrl,
	looksLikeWallet,
} from './fits-lib.js';
import { timeAgo } from './shared/pulse-format.js';

const BOARD_URL = '/api/cosmetics/leaderboard?limit=24';
const EARNINGS_URL = '/api/cosmetics/earnings';
const REFRESH_MS = 45_000;

const $ = (id) => document.getElementById(id);

const state = { board: null, refreshTimer: null };

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function rarityPill(rarity) {
	const key = String(rarity || 'common').toLowerCase();
	return `<span class="ft-pill ft-r-${esc(key)}">${esc(RARITY_LABEL[key] || key)}</span>`;
}

// ── board ────────────────────────────────────────────────────────────────────

async function loadBoard() {
	const res = await fetch(BOARD_URL, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`The cosmetics ledger returned ${res.status}.`);
	return res.json();
}

async function refresh({ silent = false } = {}) {
	if (!silent) renderSkeleton();
	try {
		state.board = await loadBoard();
		renderBoard();
	} catch (err) {
		if (!state.board) renderBoardError(err?.message || 'Could not load the cosmetics ledger.');
	}
}

function renderSkeleton() {
	$('ft-board-error').hidden = true;
	$('ft-fits').innerHTML = Array.from({ length: 4 })
		.map(() => '<div class="ft-card ft-skeleton" aria-hidden="true"></div>')
		.join('');
	for (const id of ['ft-collectors', 'ft-creators', 'ft-recent']) {
		$(id).innerHTML = Array.from({ length: 3 })
			.map(() => '<li class="ft-row ft-skeleton" aria-hidden="true"></li>')
			.join('');
	}
}

function renderBoardError(message) {
	const el = $('ft-board-error');
	el.hidden = false;
	$('ft-board-error-msg').textContent = message;
	$('ft-fits').innerHTML = '';
	for (const id of ['ft-collectors', 'ft-creators', 'ft-recent']) $(id).innerHTML = '';
}

function renderBoard() {
	const board = state.board;
	$('ft-board-error').hidden = true;
	const s = summarizeBoard(board);

	$('ft-k-gross').textContent = fmtUsdc(s.recentGrossUsdc);
	$('ft-k-gross-note').textContent = s.recentSales
		? `across the last ${fmtCount(s.recentSales)} sales`
		: 'no sales yet';
	$('ft-k-creators').textContent = fmtCount(s.creators);
	$('ft-k-creators-note').textContent = `${fmtUsdc(s.creatorEarnedUsdc)} earned`;
	$('ft-k-collectors').textContent = fmtCount(s.collectors);
	$('ft-k-fits').textContent = fmtCount(s.fitsTracked);
	$('ft-k-fits-note').textContent = s.rarest
		? `rarest: ${s.rarest.name} (${fmtCount(s.rarest.owners)} owner${Number(s.rarest.owners) === 1 ? '' : 's'})`
		: 'none minted yet';

	$('ft-empty').hidden = !boardIsEmpty(board);

	renderFits(rankFits(board?.rarestFits));
	renderCollectors(board?.topCollectors || []);
	renderCreators(board?.topCreators || []);
	renderRecent(board?.recent || []);
	$('ft-updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
}

function renderFits(fits) {
	const el = $('ft-fits');
	if (!fits.length) {
		el.innerHTML =
			'<p class="ft-none">No premium fits have been minted yet. The first buyer tops this board.</p>';
		return;
	}
	el.innerHTML = fits
		.map((f) => {
			const url = coinWorldUrl(f.worldMint);
			const art = f.previewImage
				? `<img class="ft-card-art" src="${esc(f.previewImage)}" alt="" loading="lazy" width="72" height="72" />`
				: `<span class="ft-card-art ft-card-art--none" aria-hidden="true">${esc((f.slot || '?').slice(0, 2))}</span>`;
			const owners = Number(f.owners) || 0;
			const body = `
				${art}
				<span class="ft-card-name">${esc(f.name || f.cosmeticId)}</span>
				<span class="ft-card-meta">
					${rarityPill(f.rarity)}
					<span class="ft-slot">${esc(f.slot || '')}</span>
				</span>
				<span class="ft-card-owners">${fmtCount(owners)} owner${owners === 1 ? '' : 's'}</span>`;
			return url
				? `<a class="ft-card" href="${esc(url)}" title="Open the coin world this fit belongs to">${body}</a>`
				: `<div class="ft-card">${body}</div>`;
		})
		.join('');
}

function renderCollectors(collectors) {
	const el = $('ft-collectors');
	if (!collectors.length) {
		el.innerHTML = '<li class="ft-none">No collectors yet.</li>';
		return;
	}
	el.innerHTML = collectors
		.map((c, i) => {
			const fits = Number(c.fits) || 0;
			return `<li class="ft-row">
				<span class="ft-rank">${i + 1}</span>
				<span class="ft-row-main" title="${esc(c.account)}">${esc(displayAccount(c.account))}</span>
				<span class="ft-row-sub">${fmtCount(fits)} fit${fits === 1 ? '' : 's'}</span>
				<span class="ft-row-val" title="Rarity-weighted flex score">${fmtCount(c.flexScore)}</span>
			</li>`;
		})
		.join('');
}

function renderCreators(creators) {
	const el = $('ft-creators');
	if (!creators.length) {
		el.innerHTML = '<li class="ft-none">No creator earnings settled yet.</li>';
		return;
	}
	el.innerHTML = creators
		.map((c, i) => {
			const sales = Number(c.sales) || 0;
			const scan = solscanAccountUrl(c.wallet);
			const name = scan
				? `<a class="ft-row-main" href="${esc(scan)}" target="_blank" rel="noopener noreferrer" title="${esc(c.wallet)}">${esc(shortWallet(c.wallet))}</a>`
				: `<span class="ft-row-main">${esc(shortWallet(c.wallet))}</span>`;
			return `<li class="ft-row" data-wallet="${esc(c.wallet)}">
				<span class="ft-rank">${i + 1}</span>
				${name}
				<span class="ft-row-sub">${fmtCount(sales)} sale${sales === 1 ? '' : 's'}</span>
				<span class="ft-row-val ft-earn">${esc(fmtUsdc(c.earnedUsdc))}</span>
				<button type="button" class="ft-mini" data-lookup="${esc(c.wallet)}">breakdown</button>
			</li>`;
		})
		.join('');
}

function renderRecent(recent) {
	const el = $('ft-recent');
	if (!recent.length) {
		el.innerHTML = '<li class="ft-none">No sales settled yet.</li>';
		return;
	}
	el.innerHTML = recent
		.map((s) => {
			const url = coinWorldUrl(s.mint);
			const label = `${esc(s.name || s.cosmeticId)}`;
			const main = url
				? `<a class="ft-row-main" href="${esc(url)}">${label}</a>`
				: `<span class="ft-row-main">${label}</span>`;
			return `<li class="ft-row">
				${main}
				${rarityPill(s.rarity)}
				<span class="ft-row-sub">${esc(displayAccount(s.buyer))}</span>
				<span class="ft-row-val ft-earn">${esc(fmtUsdc(s.priceUsdc))}</span>
				<time class="ft-row-when" datetime="${esc(s.settledAt || '')}">${esc(s.settledAt ? timeAgo(s.settledAt) : '')}</time>
			</li>`;
		})
		.join('');
}

// ── creator earnings lookup ──────────────────────────────────────────────────

async function lookupCreator(wallet) {
	const panel = $('ft-earnings');
	const out = $('ft-earnings-out');
	panel.hidden = false;
	$('ft-earnings-error').hidden = true;
	out.innerHTML = '<div class="ft-row ft-skeleton" aria-hidden="true"></div>';
	panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

	try {
		const res = await fetch(`${EARNINGS_URL}?creator=${encodeURIComponent(wallet)}`, {
			headers: { accept: 'application/json' },
		});
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			throw new Error(body?.error_description || `Lookup returned ${res.status}.`);
		}
		renderEarnings(body);
	} catch (err) {
		out.innerHTML = '';
		$('ft-earnings-error').hidden = false;
		$('ft-earnings-error-msg').textContent =
			err?.message || 'Could not read earnings for that wallet.';
	}
}

function renderEarnings(data) {
	const t = data?.totals || {};
	const scan = solscanAccountUrl(data?.creatorWallet);
	const head = `
		<div class="ft-earn-head">
			<span class="ft-earn-wallet">
				${scan ? `<a href="${esc(scan)}" target="_blank" rel="noopener noreferrer">${esc(shortWallet(data?.creatorWallet))}</a>` : esc(shortWallet(data?.creatorWallet))}
			</span>
			<span class="ft-earn-total">${esc(fmtUsdc(t.earnedUsdc))}</span>
			<span class="ft-earn-label">lifetime earned</span>
		</div>
		<div class="ft-earn-grid">
			<div><span class="ft-kpi-label">Sales</span><span class="ft-kpi-val">${fmtCount(t.sales)}</span></div>
			<div><span class="ft-kpi-label">Buyers</span><span class="ft-kpi-val">${fmtCount(t.buyers)}</span></div>
			<div><span class="ft-kpi-label">Last 30 days</span><span class="ft-kpi-val">${esc(fmtUsdc(t.earned30dUsdc))}</span></div>
			<div><span class="ft-kpi-label">Paid out</span><span class="ft-kpi-val">${esc(fmtUsdc(t.paidUsdc))}</span></div>
			<div><span class="ft-kpi-label">Pending</span><span class="ft-kpi-val">${esc(fmtUsdc(t.pendingUsdc))}</span></div>
			<div><span class="ft-kpi-label">Gross volume</span><span class="ft-kpi-val">${esc(fmtUsdc(t.grossUsdc))}</span></div>
		</div>`;

	const perCosmetic = (data?.perCosmetic || []).length
		? `<div class="ft-earn-block">
				<h3>By cosmetic</h3>
				<ul class="ft-list">
					${(data.perCosmetic || [])
						.map(
							(c) => `<li class="ft-row">
								<span class="ft-row-main">${esc(c.name || c.cosmeticId)}</span>
								${rarityPill(c.rarity)}
								<span class="ft-row-sub">${fmtCount(c.sales)} sale${Number(c.sales) === 1 ? '' : 's'}</span>
								<span class="ft-row-val ft-earn">${esc(fmtUsdc(c.earnedUsdc))}</span>
							</li>`,
						)
						.join('')}
				</ul>
			</div>`
		: '';

	const perCoin = (data?.perCoin || []).length
		? `<div class="ft-earn-block">
				<h3>By coin world</h3>
				<ul class="ft-list">
					${(data.perCoin || [])
						.map((c) => {
							const url = coinWorldUrl(c.mint);
							const label = esc(shortWallet(c.mint));
							return `<li class="ft-row">
								${url ? `<a class="ft-row-main" href="${esc(url)}" title="${esc(c.mint)}">${label}</a>` : `<span class="ft-row-main">${label}</span>`}
								<span class="ft-row-sub">${fmtCount(c.sales)} sale${Number(c.sales) === 1 ? '' : 's'}</span>
								<span class="ft-row-val ft-earn">${esc(fmtUsdc(c.earnedUsdc))}</span>
							</li>`;
						})
						.join('')}
				</ul>
			</div>`
		: '';

	const nothing =
		!Number(t.sales) && !perCosmetic && !perCoin
			? '<p class="ft-none">No settled cosmetic sales for this wallet yet.</p>'
			: '';

	$('ft-earnings-out').innerHTML = head + nothing + perCosmetic + perCoin;
}

// ── boot ─────────────────────────────────────────────────────────────────────

function wire() {
	$('ft-retry').addEventListener('click', () => refresh());

	$('ft-lookup-form').addEventListener('submit', (e) => {
		e.preventDefault();
		const wallet = $('ft-lookup-input').value.trim();
		if (!looksLikeWallet(wallet)) {
			$('ft-earnings').hidden = false;
			$('ft-earnings-out').innerHTML = '';
			$('ft-earnings-error').hidden = false;
			$('ft-earnings-error-msg').textContent =
				'That does not look like a Solana wallet address. Paste the creator wallet (32 to 44 base58 characters).';
			return;
		}
		lookupCreator(wallet);
	});

	// The creator rows carry their own wallet, so the board doubles as the
	// lookup's index: no copy-paste round trip to see a breakdown.
	$('ft-creators').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-lookup]');
		if (!btn) return;
		$('ft-lookup-input').value = btn.dataset.lookup;
		lookupCreator(btn.dataset.lookup);
	});

	// Pause polling while the tab is hidden: a background tab must not keep
	// hitting the ledger.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			clearInterval(state.refreshTimer);
			state.refreshTimer = null;
		} else if (!state.refreshTimer) {
			refresh({ silent: true });
			state.refreshTimer = setInterval(() => refresh({ silent: true }), REFRESH_MS);
		}
	});
}

function boot() {
	wire();
	refresh();
	state.refreshTimer = setInterval(() => refresh({ silent: true }), REFRESH_MS);
}

boot();
