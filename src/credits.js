// /credits — prepaid balance, deposit (SOL or $THREE → credits), and ledger.
//
// Deposit flow reuses the platform Solana adapter (src/onchain/adapters): connect
// + inline SIWS link (so the signing wallet is linked, which the deposit verifier
// requires), then we build the transfer with web3.js / spl-token, hand the
// unsigned tx to the adapter (it signs, submits via /api/solana-rpc, and waits for
// confirmation), and POST the signature to /api/credits/deposit for server-side
// verification + crediting. @solana/web3.js + spl-token are loaded on demand so the
// page paints instantly for the read-only balance view.

import { getAdapter } from './onchain/adapters/index.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const origin = window.location.origin;

let state = {
	asset: 'SOL',
	deposit: null,
	prices: {},
	ledgerCursor: null,
	loadingMore: false,
};

function fmtAmount(n, max = 6) {
	const v = Number(n) || 0;
	return v.toLocaleString(undefined, { maximumFractionDigits: max });
}

function fmtWhen(iso) {
	try {
		const d = new Date(iso);
		const diff = (Date.now() - d.getTime()) / 1000;
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	} catch {
		return '';
	}
}

const LEDGER_LABEL = {
	deposit: 'Deposit',
	spend: 'Spend',
	refund: 'Refund',
	grant: 'Credit grant',
	adjust: 'Adjustment',
};

function ledgerActivity(row) {
	if (row.kind === 'deposit') return `Deposit · ${row.asset || ''}`.trim();
	if (row.kind === 'spend') return row.action ? `Spend · ${row.action}` : 'Spend';
	if (row.kind === 'refund') return row.action ? `Refund · ${row.action}` : 'Refund';
	return LEDGER_LABEL[row.kind] || row.kind;
}

function setStatus(msg, kind = 'work') {
	const el = $('status');
	el.textContent = msg || '';
	el.className = `status ${kind}`;
}

function renderTier(discountBps) {
	const pill = $('tier-pill');
	if (discountBps > 0) {
		pill.hidden = false;
		pill.textContent = `Holder discount active · ${(discountBps / 100).toFixed(0)}% off every spend`;
	} else {
		pill.hidden = true;
	}
}

function renderBuys(buys) {
	const host = $('buys');
	host.innerHTML = '';
	if (!buys?.length) {
		host.innerHTML =
			'<div class="muted" style="font-size:0.85rem">Pricing loads shortly.</div>';
		return;
	}
	for (const b of buys.slice(0, 8)) {
		const row = document.createElement('div');
		row.className = 'buy-row';
		row.innerHTML = `<span class="label"></span><span class="price"></span>`;
		row.querySelector('.label').textContent = b.label;
		row.querySelector('.price').textContent = fmtUsd(b.usd);
		host.appendChild(row);
	}
}

function renderLedger(items, { append = false } = {}) {
	const table = $('ledger');
	const empty = $('ledger-empty');
	const body = $('ledger-body');
	if (!append) body.innerHTML = '';
	if (!items?.length && !body.childElementCount) {
		table.hidden = true;
		empty.hidden = false;
		return;
	}
	empty.hidden = true;
	table.hidden = false;
	for (const r of items) {
		const tr = document.createElement('tr');
		const credit = r.amount_usd >= 0;
		const sig = r.tx_signature
			? `<a href="https://solscan.io/tx/${r.tx_signature}" target="_blank" rel="noopener">view</a>`
			: '';
		tr.innerHTML = `
			<td class="muted">${fmtWhen(r.created_at)}</td>
			<td>${escapeHtml(ledgerActivity(r))} ${sig}</td>
			<td class="amt ${credit ? 'pos' : 'neg'}">${credit ? '+' : '−'}${fmtUsd(Math.abs(r.amount_usd))}</td>
			<td class="amt">${fmtUsd(r.balance_after)}</td>`;
		body.appendChild(tr);
	}
}

// The ledger is keyset-paginated (25 per page). Show the button only while the
// API hands back a cursor, so the last page ends cleanly with no dead control.
// The label is captured from the DOM rather than hardcoded so the i18n catalog
// (data-i18n on the button) still owns the copy in every locale.
function renderLedgerMore() {
	const btn = $('ledger-more');
	if (!btn) return;
	if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
	btn.hidden = !state.ledgerCursor;
	btn.disabled = state.loadingMore;
	btn.setAttribute('aria-busy', state.loadingMore ? 'true' : 'false');
	btn.textContent = state.loadingMore ? `${btn.dataset.label}\u2026` : btn.dataset.label;
}

async function loadMoreLedger() {
	if (!state.ledgerCursor || state.loadingMore) return;
	state.loadingMore = true;
	renderLedgerMore();
	try {
		const r = await fetch(`/api/credits?cursor=${encodeURIComponent(state.ledgerCursor)}`, {
			credentials: 'include',
		});
		if (!r.ok) throw new Error('Could not load older activity.');
		const data = await r.json();
		state.ledgerCursor = data.next_cursor || null;
		renderLedger(data.ledger, { append: true });
	} catch (err) {
		setStatus(err.message || 'Could not load older activity.', 'err');
	} finally {
		state.loadingMore = false;
		renderLedgerMore();
	}
}

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
	);
}

function renderAll(data) {
	$('balance').textContent = fmtUsd(data.balance_usd);
	$('lifetime-dep').textContent = fmtUsd(data.lifetime_deposited_usd);
	$('lifetime-spent').textContent = fmtUsd(data.lifetime_spent_usd);
	$('deposit-addr').textContent = data.deposit?.wallet || 'Not configured';
	renderBuys(data.buys);
	state.ledgerCursor = data.next_cursor || null;
	renderLedger(data.ledger);
	renderLedgerMore();
}

async function loadPrices() {
	// Best-effort live estimate; degrades silently to no number if blocked.
	try {
		const mint = state.asset === 'SOL' ? SOL_MINT : state.deposit?.three_mint;
		if (!mint || state.prices[mint] != null) return updateEstimate();
		const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
		if (r.ok) {
			const d = await r.json();
			const p = Number(d?.[mint]?.usdPrice ?? d?.[mint]?.price);
			if (p > 0) state.prices[mint] = p;
		}
	} catch {
		/* estimate is a nicety */
	}
	updateEstimate();
}

function updateEstimate() {
	const amt = Number($('amount').value);
	const mint = state.asset === 'SOL' ? SOL_MINT : state.deposit?.three_mint;
	const price = state.prices[mint];
	const el = $('estimate');
	if (!(amt > 0)) {
		el.innerHTML = price
			? `1 ${state.asset === 'SOL' ? 'SOL' : '$THREE'} ≈ ${fmtUsd(price)}`
			: 'Credited at the live USD value when your deposit confirms.';
		return;
	}
	if (price > 0) {
		el.innerHTML = `≈ <b>${fmtUsd(amt * price)}</b> in credits`;
	} else {
		el.innerHTML = 'Credited at the live USD value when your deposit confirms.';
	}
}

function setAsset(asset) {
	state.asset = asset;
	for (const btn of document.querySelectorAll('.seg button')) {
		btn.setAttribute('aria-pressed', String(btn.dataset.asset === asset));
	}
	$('amount-label').textContent = `Amount (${asset === 'SOL' ? 'SOL' : '$THREE'})`;
	$('amount-unit').textContent = asset === 'SOL' ? 'SOL' : '$THREE';
	$('amount').step = asset === 'SOL' ? '0.001' : '1';
	const quick = $('quick');
	quick.innerHTML = '';
	const presets = asset === 'SOL' ? [0.05, 0.1, 0.25, 0.5, 1] : [10000, 50000, 100000, 500000];
	for (const p of presets) {
		const b = document.createElement('button');
		b.type = 'button';
		b.textContent = asset === 'SOL' ? `${p} SOL` : `${fmtAmount(p, 0)}`;
		b.addEventListener('click', () => {
			$('amount').value = String(p);
			updateEstimate();
		});
		quick.appendChild(b);
	}
	loadPrices();
}

async function refresh() {
	const r = await fetch('/api/credits', { credentials: 'include' });
	if (r.status === 401) {
		$('loading-state').hidden = true;
		$('app-state').hidden = true;
		$('signin-state').hidden = false;
		return null;
	}
	if (!r.ok) throw new Error('Could not load your credits.');
	const data = await r.json();
	state.deposit = data.deposit;
	$('loading-state').hidden = true;
	$('signin-state').hidden = true;
	$('app-state').hidden = false;
	renderAll(data);
	return data;
}

async function buildSolTransfer({ web3, conn, from, to, amountSol }) {
	const lamports = BigInt(Math.round(amountSol * web3.LAMPORTS_PER_SOL));
	if (lamports <= 0n) throw new Error('Enter an amount greater than zero.');
	const tx = new web3.Transaction().add(
		web3.SystemProgram.transfer({
			fromPubkey: new web3.PublicKey(from),
			toPubkey: new web3.PublicKey(to),
			lamports,
		}),
	);
	return tx;
}

async function buildThreeTransfer({ web3, spl, conn, from, to, amount, mintStr, decimals }) {
	const atomics = BigInt(Math.round(amount * 10 ** decimals));
	if (atomics <= 0n) throw new Error('Enter an amount greater than zero.');
	const owner = new web3.PublicKey(from);
	const dest = new web3.PublicKey(to);
	const mint = new web3.PublicKey(mintStr);
	const srcAta = await spl.getAssociatedTokenAddress(mint, owner);
	const dstAta = await spl.getAssociatedTokenAddress(mint, dest);
	const tx = new web3.Transaction();
	const dstInfo = await conn.getAccountInfo(dstAta);
	if (!dstInfo) {
		tx.add(spl.createAssociatedTokenAccountInstruction(owner, dstAta, dest, mint));
	}
	tx.add(spl.createTransferCheckedInstruction(srcAta, mint, dstAta, owner, atomics, decimals));
	return tx;
}

async function doDeposit() {
	const btn = $('deposit-btn');
	const amount = Number($('amount').value);
	if (!(amount > 0)) return setStatus('Enter an amount greater than zero.', 'err');
	if (!state.deposit?.wallet) return setStatus('Deposits are not configured right now.', 'err');

	btn.disabled = true;
	try {
		setStatus('Connecting wallet…');
		const adapter = getAdapter('solana');
		if (!adapter.isAvailable()) {
			setStatus('No Solana wallet detected. Install Phantom to deposit.', 'err');
			window.open(adapter.installUrl(), '_blank', 'noopener');
			return;
		}
		const { address, ref } = await adapter.connect({ ensureLinked: true, cluster: 'mainnet' });

		setStatus('Building transaction…');
		const web3 = await import('@solana/web3.js');
		const conn = new web3.Connection(`${origin}/api/solana-rpc`, 'confirmed');
		const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

		let tx;
		if (state.asset === 'SOL') {
			tx = await buildSolTransfer({
				web3,
				conn,
				from: address,
				to: state.deposit.wallet,
				amountSol: amount,
			});
		} else {
			const spl = await import('@solana/spl-token');
			tx = await buildThreeTransfer({
				web3,
				spl,
				conn,
				from: address,
				to: state.deposit.wallet,
				amount,
				mintStr: state.deposit.three_mint,
				decimals: state.deposit.three_decimals || 6,
			});
		}
		tx.feePayer = new web3.PublicKey(address);
		tx.recentBlockhash = blockhash;
		tx.lastValidBlockHeight = lastValidBlockHeight;

		const txBase64 = btoa(
			String.fromCharCode(
				...tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
			),
		);

		setStatus('Confirm the transfer in your wallet…');
		const { txHash } = await adapter.signAndSend({ txBase64 }, ref);

		setStatus('Verifying deposit on-chain…');
		await verifyAndApply(txHash, state.asset);
	} catch (err) {
		setStatus(err?.message || 'Deposit failed. Please try again.', 'err');
	} finally {
		btn.disabled = false;
	}
}

// Solana finalization (rooting) lands a few seconds after confirmation. The
// server credits only finalized deposits, returning a `pending` result until
// then; we poll the same endpoint on a real interval (not a fake progress bar)
// so credits apply automatically without the user re-submitting.
const FINALIZE_POLL_MS = 3000;
const FINALIZE_MAX_TRIES = 12; // ~36s — covers finalization with margin
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifyAndApply(txSignature, asset, attempt = 0) {
	const r = await fetch('/api/credits/deposit', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ asset, tx_signature: txSignature, network: 'mainnet' }),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) {
		throw Object.assign(new Error(data.error_description || 'Deposit could not be verified.'), {
			data,
		});
	}
	if (data.pending) {
		if (attempt >= FINALIZE_MAX_TRIES) {
			setStatus(
				'Your deposit is confirmed and credits the moment it finalizes on-chain — leave this page open, it updates automatically.',
				'work',
			);
			return;
		}
		setStatus('Confirmed — finalizing on-chain…');
		await sleep(FINALIZE_POLL_MS);
		return verifyAndApply(txSignature, asset, attempt + 1);
	}
	if (data.replay) {
		setStatus(`Already credited — balance ${fmtUsd(data.balance_usd)}.`, 'ok');
	} else {
		setStatus(
			`Added ${fmtUsd(data.credited_usd)} (${fmtAmount(data.amount)} ${asset}). New balance ${fmtUsd(data.balance_usd)}.`,
			'ok',
		);
	}
	$('amount').value = '';
	$('manual-sig').value = '';
	updateEstimate();
	await refresh().catch(() => {});
}

async function doManualVerify() {
	const sig = $('manual-sig').value.trim();
	if (!sig) return setStatus('Paste a transaction signature to verify.', 'err');
	const btn = $('verify-btn');
	btn.disabled = true;
	try {
		setStatus('Verifying deposit on-chain…');
		await verifyAndApply(sig, state.asset);
	} catch (err) {
		setStatus(err?.message || 'Could not verify that signature.', 'err');
	} finally {
		btn.disabled = false;
	}
}

function wire() {
	for (const btn of document.querySelectorAll('.seg button')) {
		btn.addEventListener('click', () => setAsset(btn.dataset.asset));
	}
	$('amount').addEventListener('input', updateEstimate);
	$('deposit-btn').addEventListener('click', doDeposit);
	$('verify-btn').addEventListener('click', doManualVerify);
	$('ledger-more').addEventListener('click', loadMoreLedger);
}

async function main() {
	wire();
	setAsset('SOL');
	try {
		await refresh();
	} catch (err) {
		$('loading-state').hidden = true;
		setStatus(err?.message || 'Something went wrong loading your credits.', 'err');
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', main);
} else {
	main();
}
