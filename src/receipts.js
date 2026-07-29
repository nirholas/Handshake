/**
 * /receipts: the buyer-side x402 receipt vault.
 *
 * Every paid x402 call three.ws settles issues a signed offer-receipt artifact
 * (USE-17) that is durably logged server-side. This page lets any buyer prove
 * control of a wallet with one personal-sign message and pull back every
 * receipt ever issued to it via GET /api/x402/my-receipts: resource, network,
 * settlement tx, timestamp, plus the full signed artifact as JSON and a CSV
 * export of the window.
 *
 * The seller-side mirror is /x402-revenue (what the platform earns); this is
 * what YOU bought. Solana wallets sign via the injected provider (Phantom,
 * Backpack, Solflare); EVM wallets via personal_sign. The signature only
 * authorizes reads and is fresh for 5 minutes, matching the API window.
 */
import {
	buildReceiptsMessage,
	signatureStillFresh,
	networkLabel,
	explorerTxUrl,
	shortAddress,
	resourceDisplay,
	receiptsToCsv,
	summarizeReceipts,
	formatReceiptAmount,
	totalSpend,
} from './receipts-lib.js';
import { timeAgo } from './shared/pulse-format.js';

const API_URL = '/api/x402/my-receipts';
const SESSION_KEY = 'twx_receipts_session';
const FETCH_LIMIT = 200;

const $ = (id) => document.getElementById(id);

const state = {
	session: null, // { address, network, signature, issuedAt }
	rows: [],
	query: '',
	loading: false,
};

// ── wallet providers ─────────────────────────────────────────────────────────

function solanaProvider() {
	const w = window;
	if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
	if (w.solana?.isPhantom) return w.solana;
	if (w.backpack?.solana) return w.backpack.solana;
	if (w.solflare?.isSolflare) return w.solflare;
	if (w.solana) return w.solana;
	return null;
}

async function signWithSolana() {
	const provider = solanaProvider();
	if (!provider?.connect) {
		throw Object.assign(
			new Error('No Solana wallet found. Install Phantom, Backpack, or Solflare to continue.'),
			{ code: 'no_wallet' },
		);
	}
	const resp = await provider.connect();
	const address = (resp?.publicKey || provider.publicKey)?.toString();
	if (!address) throw new Error('Could not read your wallet address.');
	const issuedAt = new Date().toISOString();
	const message = buildReceiptsMessage(address, issuedAt, 'solana');
	const signed = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
	const sigBytes = signed?.signature ?? signed;
	const bs58 = (await import('bs58')).default;
	return { address, network: 'solana', signature: bs58.encode(sigBytes), issuedAt };
}

async function signWithEvm() {
	const eth = window.ethereum;
	if (!eth?.request) {
		throw Object.assign(
			new Error('No EVM wallet found. Install MetaMask or another injected wallet to continue.'),
			{ code: 'no_wallet' },
		);
	}
	const accounts = await eth.request({ method: 'eth_requestAccounts' });
	const address = accounts?.[0];
	if (!address) throw new Error('Could not read your wallet address.');
	const issuedAt = new Date().toISOString();
	const message = buildReceiptsMessage(address, issuedAt, 'evm');
	const hex = `0x${[...new TextEncoder().encode(message)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')}`;
	const signature = await eth.request({ method: 'personal_sign', params: [hex, address] });
	return { address, network: 'evm', signature, issuedAt };
}

// ── session persistence (survives reloads inside the 5-minute window) ────────

function loadSession() {
	try {
		const raw = sessionStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		const s = JSON.parse(raw);
		if (!s?.address || !s?.signature || !signatureStillFresh(s.issuedAt)) return null;
		return s;
	} catch {
		return null;
	}
}

function saveSession(session) {
	try {
		sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
	} catch {
		/* private mode: the session just won't survive a reload */
	}
}

function clearSession() {
	try {
		sessionStorage.removeItem(SESSION_KEY);
	} catch {
		/* ignore */
	}
}

// ── data ─────────────────────────────────────────────────────────────────────

async function fetchReceipts(session) {
	const params = new URLSearchParams({
		address: session.address,
		signature: session.signature,
		issuedAt: session.issuedAt,
		network: session.network,
		limit: String(FETCH_LIMIT),
	});
	const res = await fetch(`${API_URL}?${params}`);
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		const code = body?.error || `http_${res.status}`;
		const detail = body?.error_description || 'The receipt service returned an error.';
		throw Object.assign(new Error(detail), { code });
	}
	return body?.receipts || [];
}

async function connect(kind) {
	if (state.loading) return;
	setConnectBusy(kind, true);
	hideError();
	try {
		const session = kind === 'solana' ? await signWithSolana() : await signWithEvm();
		state.session = session;
		saveSession(session);
		await refresh({ resign: false });
	} catch (err) {
		if (err?.code === 4001 || /reject|cancel|denied|declined/i.test(String(err?.message))) {
			showError('Signature request was cancelled. Nothing was sent.');
		} else if (err?.code === 'no_wallet') {
			showError(err.message);
		} else {
			showError(err?.message || 'Could not sign in with that wallet.');
		}
	} finally {
		setConnectBusy(kind, false);
	}
}

async function refresh({ resign = true } = {}) {
	const session = state.session;
	if (!session || state.loading) return;
	state.loading = true;
	showVault();
	renderSkeleton();
	try {
		let active = session;
		if (!signatureStillFresh(active.issuedAt)) {
			if (!resign) throw new Error('Signature expired. Sign in again to refresh.');
			active = active.network === 'solana' ? await signWithSolana() : await signWithEvm();
			state.session = active;
			saveSession(active);
		}
		state.rows = await fetchReceipts(active);
		renderVault();
	} catch (err) {
		if (err?.code === 'stale_signature' || err?.code === 'invalid_signature') {
			// Server rejected the cached signature: drop it and return to sign-in.
			disconnect();
			showError('Your session expired. Connect your wallet again to view receipts.');
		} else if (err?.code === 4001 || /reject|cancel|denied/i.test(String(err?.message))) {
			renderVault();
		} else {
			renderLoadError(err?.message || 'Could not load receipts.');
		}
	} finally {
		state.loading = false;
	}
}

function disconnect() {
	state.session = null;
	state.rows = [];
	clearSession();
	$('rc-vault').hidden = true;
	$('rc-signin').hidden = false;
}

// ── rendering ────────────────────────────────────────────────────────────────

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function showVault() {
	$('rc-signin').hidden = true;
	$('rc-vault').hidden = false;
	const s = state.session;
	$('rc-wallet-addr').textContent = shortAddress(s.address);
	$('rc-wallet-addr').title = s.address;
	$('rc-wallet-net').textContent = s.network === 'solana' ? 'Solana' : 'EVM';
}

function renderSkeleton() {
	$('rc-list').innerHTML = Array.from({ length: 4 })
		.map(() => '<div class="rc-row rc-skeleton" aria-hidden="true"></div>')
		.join('');
	$('rc-empty').hidden = true;
	$('rc-load-error').hidden = true;
}

function renderLoadError(message) {
	$('rc-list').innerHTML = '';
	$('rc-empty').hidden = true;
	const el = $('rc-load-error');
	el.hidden = false;
	$('rc-load-error-msg').textContent = message;
}

function filteredRows() {
	const q = state.query.trim().toLowerCase();
	if (!q) return state.rows;
	return state.rows.filter(
		(r) =>
			resourceDisplay(r.resourceUrl).toLowerCase().includes(q) ||
			String(r.transaction || '').toLowerCase().includes(q) ||
			networkLabel(r.network).toLowerCase().includes(q),
	);
}

function renderVault() {
	const stats = summarizeReceipts(state.rows);
	const spend = totalSpend(state.rows);
	$('rc-k-total').textContent = String(stats.total);
	$('rc-k-endpoints').textContent = String(stats.endpoints);
	$('rc-k-networks').textContent = stats.networks.length ? stats.networks.join(' · ') : '·';
	$('rc-k-last').textContent = stats.lastAt ? timeAgo(stats.lastAt) : '·';
	// Receipts issued before settlement capture landed carry no amount; say so
	// rather than quietly under-reporting the total.
	$('rc-k-spend').textContent = spend.priced ? spend.label : '·';
	$('rc-k-spend-note').textContent = spend.unpriced
		? `${spend.priced} of ${stats.total} priced`
		: 'USDC settled';
	$('rc-load-error').hidden = true;

	const rows = filteredRows();
	const list = $('rc-list');
	if (!state.rows.length) {
		list.innerHTML = '';
		$('rc-empty').hidden = false;
		$('rc-empty-title').textContent = 'No receipts for this wallet yet';
		$('rc-empty-body').innerHTML =
			'Receipts appear here the moment this wallet pays any three.ws x402 endpoint. ' +
			'Browse the <a href="/x402">paid endpoint catalog</a> or read ' +
			'<a href="/docs/x402-endpoints">how x402 payments work</a> to make your first call.';
		return;
	}
	if (!rows.length) {
		list.innerHTML = '';
		$('rc-empty').hidden = false;
		$('rc-empty-title').textContent = 'No receipts match your search';
		$('rc-empty-body').textContent = 'Try a different endpoint path, network, or transaction hash.';
		return;
	}
	$('rc-empty').hidden = true;

	list.innerHTML = rows
		.map((r, i) => {
			const url = explorerTxUrl(r.network, r.transaction);
			const txCell = r.transaction
				? url
					? `<a class="rc-tx" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(r.transaction))} ↗</a>`
					: `<span class="rc-tx rc-tx-raw" title="${esc(r.transaction)}">${esc(shortAddress(r.transaction))}</span>`
				: '<span class="rc-tx rc-tx-none" title="This receipt was issued without an on-chain tx hash for privacy">private</span>';
			const when = r.issuedAt
				? `<time datetime="${esc(r.issuedAt)}" title="${esc(new Date(r.issuedAt).toLocaleString())}">${esc(timeAgo(r.issuedAt))}</time>`
				: '·';
			const amount = formatReceiptAmount(r.amountAtomics, r.assetDecimals);
			const amountCell = amount
				? `<span class="rc-amount" title="${esc(r.amountAtomics)} atomic units">${esc(amount.label)}</span>`
				: '';
			return `
			<div class="rc-row" data-idx="${i}">
				<div class="rc-row-main">
					<span class="rc-resource" title="${esc(r.resourceUrl)}">${esc(resourceDisplay(r.resourceUrl))}</span>
					<span class="rc-meta">
						${amountCell}
						<span class="rc-net" data-net="${esc(networkLabel(r.network))}">${esc(networkLabel(r.network))}</span>
						${when}
						${txCell}
					</span>
				</div>
				<div class="rc-row-actions">
					<button type="button" class="rc-act" data-action="copy" data-idx="${i}" title="Copy the signed receipt JSON">copy</button>
					<button type="button" class="rc-act" data-action="download" data-idx="${i}" title="Download the signed receipt JSON">json</button>
				</div>
			</div>`;
		})
		.join('');
}

// ── actions ──────────────────────────────────────────────────────────────────

function receiptArtifact(row) {
	return JSON.stringify(
		{
			id: row.id,
			payer: row.payer,
			network: row.network,
			resourceUrl: row.resourceUrl,
			transaction: row.transaction,
			issuedAt: row.issuedAt,
			format: row.format,
			receipt: row.receipt,
		},
		null,
		2,
	);
}

function downloadBlob(content, filename, type) {
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast('Copied to clipboard');
	} catch {
		toast('Copy failed. Use the JSON download instead.');
	}
}

function exportCsv() {
	if (!state.rows.length) {
		toast('Nothing to export yet');
		return;
	}
	const addr = shortAddress(state.session?.address || 'wallet').replace('…', '-');
	downloadBlob(receiptsToCsv(filteredRows()), `x402-receipts-${addr}.csv`, 'text/csv');
	toast('CSV exported');
}

let toastTimer = null;
function toast(message) {
	const el = $('rc-toast');
	el.textContent = message;
	el.hidden = false;
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.classList.remove('show');
		toastTimer = setTimeout(() => {
			el.hidden = true;
		}, 200);
	}, 1800);
}

function showError(message) {
	const el = $('rc-signin-error');
	el.hidden = false;
	el.textContent = message;
}

function hideError() {
	$('rc-signin-error').hidden = true;
}

function setConnectBusy(kind, busy) {
	const btn = kind === 'solana' ? $('rc-connect-solana') : $('rc-connect-evm');
	btn.disabled = busy;
	btn.classList.toggle('busy', busy);
	btn.querySelector('.rc-btn-label').textContent = busy
		? 'Waiting for wallet…'
		: btn.dataset.label;
}

// ── boot ─────────────────────────────────────────────────────────────────────

function wire() {
	$('rc-connect-solana').addEventListener('click', () => connect('solana'));
	$('rc-connect-evm').addEventListener('click', () => connect('evm'));
	$('rc-refresh').addEventListener('click', () => refresh());
	$('rc-export').addEventListener('click', exportCsv);
	$('rc-disconnect').addEventListener('click', disconnect);
	$('rc-retry').addEventListener('click', () => refresh());

	$('rc-search').addEventListener('input', (e) => {
		state.query = e.target.value;
		renderVault();
	});

	$('rc-list').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		const row = filteredRows()[Number(btn.dataset.idx)];
		if (!row) return;
		if (btn.dataset.action === 'copy') copyText(receiptArtifact(row));
		if (btn.dataset.action === 'download') {
			downloadBlob(
				receiptArtifact(row),
				`x402-receipt-${row.id}.json`,
				'application/json',
			);
		}
	});

	document.addEventListener('keydown', (e) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === '/' && !$('rc-vault').hidden) {
			e.preventDefault();
			$('rc-search').focus();
		}
		if (e.key === 'e' && !$('rc-vault').hidden) exportCsv();
	});
}

function boot() {
	wire();
	const cached = loadSession();
	if (cached) {
		state.session = cached;
		refresh({ resign: false });
	}
}

boot();
