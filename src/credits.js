// /credits: prepaid balance, deposit (SOL or $THREE into credits), and ledger.
//
// Deposit flow reuses the platform Solana adapter (src/onchain/adapters): connect
// + inline SIWS link (so the signing wallet is linked, which the deposit verifier
// requires), then we build the transfer with web3.js / spl-token, hand the
// unsigned tx to the adapter (it signs, submits via /api/solana-rpc, and waits for
// confirmation), and POST the signature to /api/credits/deposit for server-side
// verification + crediting. @solana/web3.js + spl-token are loaded on demand so the
// page paints instantly for the read-only balance view.

import { getAdapter } from './onchain/adapters/index.js';
import { resolveTokenProgramId } from './shared/spl-token-program.js';

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

// The page's headline promise is the $THREE holder discount, so the pill states
// the tier the caller is actually charged at, and nudges toward the next one
// when they are not yet at the top. Hidden only when the tier cannot be read.
function renderTier(holder) {
	const pill = $('tier-pill');
	if (!holder) {
		pill.hidden = true;
		return;
	}
	const bps = Number(holder.discount_bps) || 0;
	const label = holder.tier?.label || 'Member';
	if (bps > 0) {
		pill.textContent = `${label} · ${(bps / 100).toFixed(0)}% off every spend`;
	} else if (holder.next_tier && holder.usd_to_next > 0) {
		pill.textContent = `${label} · hold ${fmtUsd(holder.usd_to_next)} more $THREE for ${holder.next_tier.label}`;
	} else {
		pill.textContent = `${label} · no holder discount yet`;
	}
	pill.hidden = false;
}

function renderBuys(buys) {
	const host = $('buys');
	host.innerHTML = '';
	$('buys-empty').hidden = Boolean(buys?.length);
	if (!buys?.length) return;
	for (const b of buys.slice(0, 8)) {
		const row = document.createElement('div');
		row.className = 'buy-row';
		const label = document.createElement('span');
		label.className = 'label';
		label.textContent = b.label;
		const price = document.createElement('span');
		price.className = 'price';
		price.textContent = fmtUsd(b.usd);
		row.append(label, price);
		host.appendChild(row);
	}
}

function cell(tr, className, text) {
	const td = document.createElement('td');
	if (className) td.className = className;
	if (text != null) td.textContent = text;
	tr.appendChild(td);
	return td;
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
		cell(tr, 'muted', fmtWhen(r.created_at));
		const activity = cell(tr, null, ledgerActivity(r));
		// Built as a node with an encoded signature rather than interpolated
		// markup, so a ledger row can never inject HTML into the page.
		if (r.tx_signature) {
			activity.append(' ');
			const link = document.createElement('a');
			link.href = `https://solscan.io/tx/${encodeURIComponent(r.tx_signature)}`;
			link.target = '_blank';
			link.rel = 'noopener';
			link.textContent = 'view';
			activity.appendChild(link);
		}
		cell(
			tr,
			`amt ${credit ? 'pos' : 'neg'}`,
			`${credit ? '+' : '\u2212'}${fmtUsd(Math.abs(r.amount_usd))}`,
		);
		cell(tr, 'amt', fmtUsd(r.balance_after));
		body.appendChild(tr);
	}
}

// The ledger is keyset-paginated (25 per page). Show the button only while the
// API hands back a cursor, so the last page ends cleanly with no dead control.
// The label lives in a child <span data-i18n>, so the busy affordance is a class
// (`.is-busy` appends an ellipsis in CSS) and the catalog keeps owning the copy
// in every locale.
function renderLedgerMore() {
	const btn = $('ledger-more');
	if (!btn) return;
	btn.hidden = !state.ledgerCursor;
	btn.disabled = state.loadingMore;
	btn.setAttribute('aria-busy', state.loadingMore ? 'true' : 'false');
	btn.classList.toggle('is-busy', state.loadingMore);
}

async function loadMoreLedger() {
	if (!state.ledgerCursor || state.loadingMore) return;
	state.loadingMore = true;
	$('ledger-error').hidden = true;
	renderLedgerMore();
	try {
		const r = await fetchCredits(
			`/api/credits?cursor=${encodeURIComponent(state.ledgerCursor)}`,
		);
		if (!r.ok) throw new Error('Could not load older activity.');
		const data = await r.json();
		state.ledgerCursor = data.next_cursor || null;
		renderLedger(data.ledger, { append: true });
	} catch {
		// Reported next to the ledger, not in the deposit card's status line, so
		// the message sits where the failed control is. The button stays enabled
		// so the retry is one click.
		$('ledger-error').hidden = false;
	} finally {
		state.loadingMore = false;
		renderLedgerMore();
	}
}

function renderAll(data) {
	$('balance').textContent = fmtUsd(data.balance_usd);
	$('lifetime-dep').textContent = fmtUsd(data.lifetime_deposited_usd);
	$('lifetime-spent').textContent = fmtUsd(data.lifetime_spent_usd);
	const addr = $('deposit-addr');
	const wallet = data.deposit?.wallet || '';
	addr.textContent = wallet || 'Deposits are not configured right now.';
	// From here the script owns this element, so the catalog pass (which lands
	// after an async locale fetch) cannot revert a real address to its
	// placeholder copy.
	addr.dataset.i18nOwned = '1';
	$('copy-addr').disabled = !wallet;
	$('copy-addr').hidden = !wallet;
	renderTier(data.holder);
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
	const unit = state.asset === 'SOL' ? 'SOL' : '$THREE';
	const fallback = 'Credited at the live USD value when your deposit confirms.';
	el.textContent = '';
	if (!(amt > 0)) {
		el.textContent = price > 0 ? `1 ${unit} \u2248 ${fmtUsd(price)}` : fallback;
		return;
	}
	if (!(price > 0)) {
		el.textContent = fallback;
		return;
	}
	const strong = document.createElement('b');
	strong.textContent = fmtUsd(amt * price);
	el.append('\u2248 ', strong, ' in credits');
}

function setAsset(asset) {
	state.asset = asset;
	for (const btn of document.querySelectorAll('.seg button')) {
		btn.setAttribute('aria-pressed', String(btn.dataset.asset === asset));
	}
	// Both asset variants ship in the HTML with their own catalog keys, so the
	// swap is a visibility toggle and the copy stays localized.
	for (const el of document.querySelectorAll('[data-asset-label], [data-asset-unit]')) {
		el.hidden = (el.dataset.assetLabel || el.dataset.assetUnit) !== asset;
	}
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

// Exactly one of loading / signed-out / error / app is visible at any moment.
function showState(name) {
	$('loading-state').hidden = name !== 'loading';
	$('signin-state').hidden = name !== 'signin';
	$('error-state').hidden = name !== 'error';
	$('app-state').hidden = name !== 'app';
}

// A failed load used to hide every panel and leave the page blank below the
// heading, because the only status line lives inside the (hidden) app panel.
function showError(message) {
	const el = $('error-msg');
	el.textContent =
		message ||
		'The credits service did not respond. Your balance and history are safe; this page just could not read them.';
	el.dataset.i18nOwned = '1';
	showState('error');
}

// A dropped connection rejects with the browser's own "Failed to fetch", which
// is not a message anyone can act on. Every throw out of here is designed copy.
async function fetchCredits(path) {
	try {
		return await fetch(path, { credentials: 'include' });
	} catch {
		throw new Error(
			navigator.onLine === false
				? 'You appear to be offline. Reconnect, then try again.'
				: 'We could not reach three.ws. Check your connection, then try again.',
		);
	}
}

async function refresh() {
	const r = await fetchCredits('/api/credits');
	if (r.status === 401) {
		showState('signin');
		return null;
	}
	if (!r.ok) {
		const body = await r.json().catch(() => ({}));
		throw new Error(
			body.error_description ||
				(r.status === 429
					? 'Too many requests. Wait a moment, then try again.'
					: 'We could not read your balance and history. Try again in a moment.'),
		);
	}
	const data = await r.json();
	state.deposit = data.deposit;
	showState('app');
	renderAll(data);
	return data;
}

async function reload() {
	const btn = $('retry-btn');
	btn.disabled = true;
	btn.classList.add('is-busy');
	try {
		showState('loading');
		await refresh();
	} catch (err) {
		showError(err?.message);
	} finally {
		btn.disabled = false;
		btn.classList.remove('is-busy');
	}
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

	// $THREE is a Token-2022 mint, so every derivation and instruction below must
	// target the mint's real owning program. The spl-token defaults (legacy
	// TOKEN_PROGRAM_ID) derive the wrong ATAs and fail simulation with "incorrect
	// program id for instruction".
	const tokenProgramId = await resolveTokenProgramId(conn, mint, spl);
	const ataArgs = [false, tokenProgramId, spl.ASSOCIATED_TOKEN_PROGRAM_ID];
	const srcAta = await spl.getAssociatedTokenAddress(mint, owner, ...ataArgs);
	const dstAta = await spl.getAssociatedTokenAddress(mint, dest, ...ataArgs);

	const [srcInfo, dstInfo] = await Promise.all([
		conn.getAccountInfo(srcAta),
		conn.getAccountInfo(dstAta),
	]);
	if (!srcInfo) throw new Error('This wallet holds no $THREE. Buy some first, then deposit.');
	const held = BigInt((await conn.getTokenAccountBalance(srcAta)).value.amount);
	if (held < atomics) {
		throw new Error(
			`Not enough $THREE. This wallet holds ${fmtAmount(Number(held) / 10 ** decimals)}.`,
		);
	}

	const tx = new web3.Transaction();
	if (!dstInfo) {
		tx.add(
			spl.createAssociatedTokenAccountInstruction(
				owner,
				dstAta,
				dest,
				mint,
				tokenProgramId,
				spl.ASSOCIATED_TOKEN_PROGRAM_ID,
			),
		);
	}
	tx.add(
		spl.createTransferCheckedInstruction(
			srcAta,
			mint,
			dstAta,
			owner,
			atomics,
			decimals,
			[],
			tokenProgramId,
		),
	);
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
const FINALIZE_MAX_TRIES = 12; // ~36s, which covers finalization with margin
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
				'Your deposit is confirmed. It credits the moment it finalizes on-chain, so leave this page open and it updates automatically.',
				'work',
			);
			return;
		}
		setStatus('Confirmed. Finalizing on-chain…');
		await sleep(FINALIZE_POLL_MS);
		return verifyAndApply(txSignature, asset, attempt + 1);
	}
	if (data.replay) {
		setStatus(`Already credited. Balance ${fmtUsd(data.balance_usd)}.`, 'ok');
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

// Deposit addresses are 44 characters of base58 that nobody should retype.
// Restores its own label after a moment so the control never looks stuck.
let copyResetTimer = 0;
async function copyDepositAddress() {
	const wallet = state.deposit?.wallet;
	if (!wallet) return;
	const btn = $('copy-addr');
	try {
		await navigator.clipboard.writeText(wallet);
		btn.textContent = 'Copied';
	} catch {
		// Clipboard permission denied (or an insecure origin): select the address
		// so the copy is still one keystroke away.
		const range = document.createRange();
		range.selectNodeContents($('deposit-addr'));
		const sel = window.getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
		btn.textContent = 'Selected';
	}
	btn.dataset.i18nOwned = '1';
	clearTimeout(copyResetTimer);
	copyResetTimer = setTimeout(() => {
		btn.textContent = 'Copy';
	}, 1800);
}

function wire() {
	for (const btn of document.querySelectorAll('.seg button')) {
		btn.addEventListener('click', () => setAsset(btn.dataset.asset));
	}
	$('amount').addEventListener('input', updateEstimate);
	$('deposit-btn').addEventListener('click', doDeposit);
	$('verify-btn').addEventListener('click', doManualVerify);
	$('ledger-more').addEventListener('click', loadMoreLedger);
	$('copy-addr').addEventListener('click', copyDepositAddress);
	$('retry-btn').addEventListener('click', reload);
}

async function main() {
	wire();
	setAsset('SOL');
	try {
		await refresh();
	} catch (err) {
		showError(err?.message);
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', main);
} else {
	main();
}
