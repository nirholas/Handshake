// /forever — client controller for the Bitcoin inscription splash.
//
// State machine: compose → pay → win
//   - compose: textarea + options, "Inscribe forever" CTA
//   - pay:     QR + address + Lightning, polling /api/forever/status
//   - win:     inscription ID, tx hash, share-to-X CTA
//
// Persistence: orderId is stored in sessionStorage so an accidental reload
// during the payment wait keeps the user on the same charge.

const $ = (id) => document.getElementById(id);
const els = {
	message: $('message'),
	receive: $('receiveAddress'),
	feeRate: $('feeRate'),
	charCount: $('charCount').querySelector('b'),
	byteCount: $('byteCount').querySelector('b'),
	byteWrap: $('byteCount'),
	inscribeBtn: $('inscribeBtn'),
	errorBanner: $('errorBanner'),
	viewCompose: $('view-compose'),
	viewPay: $('view-pay'),
	viewWin: $('view-win'),
	statePill: $('statePill'),
	statePillLabel: $('statePill').querySelector('.label'),
	qrBox: $('qrBox'),
	amountBtc: $('amountBtc'),
	amountSats: $('amountSats'),
	amountUsd: $('amountUsd'),
	payAddress: $('payAddress'),
	lnRow: $('lnRow'),
	lnInvoice: $('lnInvoice'),
	receiveAddrPay: $('receiveAddrPay'),
	orderIdPay: $('orderIdPay'),
	openWallet: $('openWallet'),
	mempoolLink: $('mempoolLink'),
	cancelPay: $('cancelPay'),
	messagePreview: $('messagePreview'),
	winMessage: $('winMessage'),
	winInscriptionLink: $('winInscriptionLink'),
	winTxLink: $('winTxLink'),
	winReceive: $('winReceive'),
	shareX: $('shareX'),
	copyLink: $('copyLink'),
	inscribeAnother: $('inscribeAnother'),
	feeEstimate: $('feeEstimate'),
};

const STATE_LABEL = {
	'waiting-payment': 'waiting for payment',
	'payment-received': 'payment received',
	inscribing: 'inscribing onto Bitcoin',
	inscribed: 'inscribed forever',
	failed: 'inscription failed',
};

// ── live counters ───────────────────────────────────────────────
function updateCounters() {
	const text = els.message.value;
	const chars = [...text].length;
	const bytes = new TextEncoder().encode(text).length;
	els.charCount.textContent = chars.toLocaleString();
	els.byteCount.textContent = bytes.toLocaleString();
	els.byteWrap.classList.toggle('warn', bytes > 1500);
	els.message.style.height = 'auto';
	els.message.style.height = Math.min(els.message.scrollHeight, 360) + 'px';
}
// ── live fee estimate ───────────────────────────────────────────
// A taproot text inscription pays for two transactions: the commit and the
// reveal. The reveal carries the inscription in its witness, which gets the
// 4x SegWit weight discount. These constants approximate the vsize so the user
// sees the BTC cost — and can confirm they have funds — before committing to a
// real on-chain charge. The authoritative amount still comes from the order.
const COMMIT_VBYTES = 154; // 1-in / 2-out P2TR commit tx
const REVEAL_OVERHEAD_VBYTES = 160; // reveal tx minus the inscription witness
const POSTAGE_SATS = 546; // dust output that carries the inscribed sat
const SERVICE_BUFFER = 1.12; // OrdinalsBot service + mining-fee headroom

function estimateInscriptionSats(messageBytes, feeRate) {
	if (!Number.isFinite(messageBytes) || !Number.isFinite(feeRate) || feeRate <= 0) {
		return null;
	}
	// Inscription witness bytes get the /4 weight discount.
	const witnessVbytes = Math.ceil(messageBytes / 4) + 60; // +60 for envelope opcodes
	const totalVbytes = COMMIT_VBYTES + REVEAL_OVERHEAD_VBYTES + witnessVbytes;
	const minerSats = totalVbytes * feeRate;
	return Math.ceil((minerSats + POSTAGE_SATS) * SERVICE_BUFFER);
}

// Declared above renderFeeEstimate: the top-level renderFeeEstimate() call below
// reads BTC_USD, so a `let` declared after that call leaves it in the temporal
// dead zone and throws "Cannot access 'BTC_USD' before initialization", which
// aborts this module and takes the whole fee estimator down with it.
let BTC_USD = null;

function renderFeeEstimate() {
	if (!els.feeEstimate) return;
	const bytes = new TextEncoder().encode(els.message.value).length;
	const feeRate = Number(els.feeRate.value);
	const sats = estimateInscriptionSats(bytes, feeRate);
	if (!sats) {
		els.feeEstimate.textContent = 'paid in BTC · settled in ~1 block';
		return;
	}
	const btc = sats / 1e8;
	const usd = BTC_USD ? ` · ≈ $${(btc * BTC_USD).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '';
	els.feeEstimate.textContent =
		`est. ~${sats.toLocaleString()} sats (${btc.toFixed(8)} BTC)${usd} · have funds ready before you commit`;
}

els.message.addEventListener('input', () => { updateCounters(); renderFeeEstimate(); });
els.feeRate.addEventListener('change', renderFeeEstimate);
updateCounters();
renderFeeEstimate();

// ── btc/usd price (single fetch, best-effort) ───────────────────
async function fetchBtcPrice() {
	try {
		const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
		if (!r.ok) return;
		const d = await r.json();
		const p = d?.bitcoin?.usd;
		if (typeof p === 'number') {
			BTC_USD = p;
			renderFeeEstimate();
		}
	} catch {
		// Price is decoration; not required for the flow.
	}
}
fetchBtcPrice();

// ── QR rendering ────────────────────────────────────────────────
// Uses Google's chart server as a zero-dep QR generator. The payload is the
// BIP-21 URI so any Bitcoin wallet can scan it directly. Fallback to a plain
// address QR if BIP-21 construction fails.
function renderQR(payload) {
	els.qrBox.innerHTML = '';
	const img = document.createElement('img');
	img.alt = 'Bitcoin payment QR';
	img.src =
		'https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=' +
		encodeURIComponent(payload);
	img.loading = 'eager';
	img.decoding = 'async';
	els.qrBox.appendChild(img);
}

function buildBip21({ address, amountBtc, lightning, label }) {
	const params = new URLSearchParams();
	if (amountBtc) params.set('amount', amountBtc.toFixed(8));
	if (label) params.set('label', label);
	if (lightning) params.set('lightning', lightning);
	const qs = params.toString();
	return `bitcoin:${address}${qs ? '?' + qs : ''}`;
}

// ── error display ──────────────────────────────────────────────
function showError(msg) {
	els.errorBanner.textContent = msg;
	els.errorBanner.classList.add('show');
}
function clearError() {
	els.errorBanner.classList.remove('show');
	els.errorBanner.textContent = '';
}

// ── link enable/disable ────────────────────────────────────────
// Action links (open-in-wallet, mempool) ship inert with no href so they can't
// navigate to "#". Once a valid target exists we set the href and clear the
// inert styling; if it's missing we keep them disabled.
function setLinkActive(el, href) {
	if (!el) return;
	if (href) {
		el.href = href;
		el.classList.remove('is-pending');
		el.removeAttribute('aria-disabled');
	} else {
		el.removeAttribute('href');
		el.classList.add('is-pending');
		el.setAttribute('aria-disabled', 'true');
	}
}

// ── view switching ─────────────────────────────────────────────
function show(view) {
	els.viewCompose.classList.remove('show', 'fade-in');
	els.viewPay.classList.remove('show', 'fade-in');
	els.viewWin.classList.remove('show', 'fade-in');
	if (view === 'compose') {
		els.viewCompose.style.display = '';
		els.viewCompose.classList.add('fade-in');
	} else if (view === 'pay') {
		els.viewCompose.style.display = 'none';
		els.viewPay.classList.add('show', 'fade-in');
		els.viewWin.classList.remove('show');
	} else if (view === 'win') {
		els.viewCompose.style.display = 'none';
		els.viewPay.classList.remove('show');
		els.viewWin.classList.add('show', 'fade-in');
	}
}

// ── current order state ────────────────────────────────────────
let currentOrder = null; // { orderId, message, receiveAddress }
let pollTimer = null;

function setStatePill(state) {
	els.statePill.classList.remove('ok', 'err');
	if (state === 'inscribed') els.statePill.classList.add('ok');
	if (state === 'failed') els.statePill.classList.add('err');
	els.statePillLabel.textContent = STATE_LABEL[state] || state;
}

// ── inscribe flow ──────────────────────────────────────────────
els.inscribeBtn.addEventListener('click', async () => {
	clearError();
	const message = els.message.value.trim();
	if (!message) {
		showError('Type a message first.');
		els.message.focus();
		return;
	}
	const bytes = new TextEncoder().encode(message).length;
	if (bytes > 1500) {
		showError(`Message is ${bytes} bytes. Trim it under 1500.`);
		return;
	}
	const receiveAddress = els.receive.value.trim() || undefined;
	const feeRate = Number(els.feeRate.value);

	// Funds gate: an inscription is a real, non-refundable BTC charge paid from
	// the user's own wallet. Surface the estimated cost and require explicit
	// confirmation that they hold enough BTC before we create the order.
	const estSats = estimateInscriptionSats(bytes, feeRate);
	if (estSats) {
		const estBtc = (estSats / 1e8).toFixed(8);
		const estUsd = BTC_USD ? ` (≈ $${((estSats / 1e8) * BTC_USD).toLocaleString(undefined, { maximumFractionDigits: 2 })})` : '';
		const ok = window.confirm(
			`This inscription will cost approximately ${estSats.toLocaleString()} sats — ${estBtc} BTC${estUsd}, ` +
			`paid from your own Bitcoin wallet at ${feeRate} sats/vB.\n\n` +
			`Make sure that wallet holds enough BTC to cover the charge plus network fees. ` +
			`The payment is final once broadcast.\n\nContinue?`,
		);
		if (!ok) return;
	}

	els.inscribeBtn.disabled = true;
	els.inscribeBtn.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M12 3a9 9 0 0 1 9 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></svg> Creating order…';

	try {
		const res = await fetch('/api/forever/inscribe', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message, receiveAddress, feeRate }),
		});
		const data = await res.json();
		if (!res.ok) {
			throw new Error(data?.error_description || data?.error || `HTTP ${res.status}`);
		}
		await onOrderCreated(data, message);
	} catch (e) {
		showError(e.message || 'Inscription failed. Try again.');
		els.inscribeBtn.disabled = false;
		els.inscribeBtn.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg> Inscribe forever';
	}
});

async function onOrderCreated(data, message) {
	currentOrder = {
		orderId: data.orderId,
		message,
		receiveAddress: data.receiveAddress,
	};
	sessionStorage.setItem('forever:order', JSON.stringify(currentOrder));

	const c = data.charge || {};
	const amountBtc = c.amountBtc ?? (c.amount ? c.amount / 1e8 : 0);
	const amountSats = c.amount || 0;
	const lightning = c.lightningInvoice;

	els.amountBtc.textContent = amountBtc ? amountBtc.toFixed(8) : '—';
	els.amountSats.textContent = amountSats ? `· ${amountSats.toLocaleString()} sats` : '';
	els.amountUsd.textContent = BTC_USD && amountBtc
		? `≈ $${(amountBtc * BTC_USD).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
		: '';
	els.payAddress.textContent = c.address || '—';
	els.receiveAddrPay.textContent = data.receiveAddress;
	els.orderIdPay.textContent = data.orderId;
	els.messagePreview.textContent = message;

	if (lightning) {
		els.lnRow.style.display = '';
		els.lnInvoice.textContent = lightning;
	} else {
		els.lnRow.style.display = 'none';
	}

	const bip21 = buildBip21({
		address: c.address,
		amountBtc,
		lightning,
		label: 'three.ws · forever',
	});
	renderQR(bip21);
	setLinkActive(els.openWallet, c.address ? bip21 : null);
	setLinkActive(els.mempoolLink, c.address ? `https://mempool.space/address/${c.address}` : null);
	setStatePill('waiting-payment');

	show('pay');
	startPolling();

	els.inscribeBtn.disabled = false;
	els.inscribeBtn.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg> Inscribe forever';
}

// ── polling ────────────────────────────────────────────────────
function startPolling() {
	stopPolling();
	pollOnce();
	pollTimer = setInterval(pollOnce, 6000);
}
function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function pollOnce() {
	if (!currentOrder?.orderId) return;
	try {
		const r = await fetch(
			`/api/forever/status?id=${encodeURIComponent(currentOrder.orderId)}`,
		);
		const d = await r.json();
		if (!r.ok) return;
		setStatePill(d.state);

		if (d.state === 'inscribed' && d.inscription?.id) {
			stopPolling();
			await onInscribed(d);
		} else if (d.state === 'failed') {
			stopPolling();
			showError(
				'OrdinalsBot reports this order failed. If you paid, contact OrdinalsBot support with order ID ' +
					currentOrder.orderId,
			);
		}
	} catch {
		// transient network — keep polling
	}
}

async function onInscribed(d) {
	const insc = d.inscription;
	const inscriptionUrl = d.links?.inscription || `https://ordinals.com/inscription/${insc.id}`;
	const txUrl = d.links?.revealTx || (insc.revealTxid ? `https://mempool.space/tx/${insc.revealTxid}` : null);

	els.winMessage.textContent = currentOrder.message;
	els.winInscriptionLink.textContent = insc.id;
	setLinkActive(els.winInscriptionLink, inscriptionUrl);
	if (txUrl) {
		els.winTxLink.textContent = insc.revealTxid || 'view tx';
		setLinkActive(els.winTxLink, txUrl);
	} else {
		els.winTxLink.textContent = '—';
		setLinkActive(els.winTxLink, null);
	}
	els.winReceive.textContent = currentOrder.receiveAddress;

	// Wire share buttons against this inscription.
	const shareText = buildShareText(currentOrder.message, inscriptionUrl);
	const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
	els.shareX.onclick = () => window.open(xUrl, '_blank', 'noopener,width=600,height=520');
	els.copyLink.onclick = async () => {
		try {
			await navigator.clipboard.writeText(inscriptionUrl);
			els.copyLink.textContent = 'Copied ✓';
			setTimeout(() => (els.copyLink.textContent = 'Copy permalink'), 1500);
		} catch {
			window.prompt('Copy this link:', inscriptionUrl);
		}
	};
	els.inscribeAnother.onclick = () => {
		sessionStorage.removeItem('forever:order');
		currentOrder = null;
		els.message.value = '';
		updateCounters();
		clearError();
		show('compose');
	};

	sessionStorage.removeItem('forever:order');
	show('win');
}

function buildShareText(message, url) {
	// Viral hook: short, declarative, with the message quoted. URL goes last
	// so X auto-unfurls the inscription preview.
	const truncated = message.length > 180 ? message.slice(0, 177) + '…' : message;
	return (
		`I just etched this onto Bitcoin. Forever.\n\n` +
		`"${truncated}"\n\n` +
		`Verify on chain: ${url}\n\n` +
		`Make yours → three.ws/forever`
	);
}

// ── pay-view actions ───────────────────────────────────────────
els.cancelPay.addEventListener('click', () => {
	if (!confirm('Cancel this inscription? Your message will not be inscribed unless you pay the BTC charge.')) return;
	stopPolling();
	sessionStorage.removeItem('forever:order');
	currentOrder = null;
	show('compose');
});

document.querySelectorAll('.copy[data-copy]').forEach((btn) => {
	btn.addEventListener('click', async () => {
		const targetId = btn.getAttribute('data-copy');
		const node = $(targetId);
		const text = node?.textContent?.trim();
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			const orig = btn.textContent;
			btn.textContent = 'copied ✓';
			setTimeout(() => (btn.textContent = orig), 1200);
		} catch {
			window.prompt('Copy:', text);
		}
	});
});

// ── resume after reload ────────────────────────────────────────
(function resumeIfAny() {
	try {
		const raw = sessionStorage.getItem('forever:order');
		if (!raw) return;
		const saved = JSON.parse(raw);
		if (!saved?.orderId) return;
		currentOrder = saved;
		// Repaint pay view with cached message; status poll will fill the rest.
		els.orderIdPay.textContent = saved.orderId;
		els.messagePreview.textContent = saved.message || '';
		els.receiveAddrPay.textContent = saved.receiveAddress || '—';
		show('pay');
		// Refresh the charge details from server.
		fetch(`/api/forever/status?id=${encodeURIComponent(saved.orderId)}`)
			.then((r) => r.json())
			.then((d) => {
				if (d.charge?.address) {
					const amountBtc = d.charge.amountBtc ?? (d.charge.amount ? d.charge.amount / 1e8 : 0);
					els.amountBtc.textContent = amountBtc ? amountBtc.toFixed(8) : '—';
					els.amountSats.textContent = d.charge.amount ? `· ${d.charge.amount.toLocaleString()} sats` : '';
					els.amountUsd.textContent = BTC_USD && amountBtc
						? `≈ $${(amountBtc * BTC_USD).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
						: '';
					els.payAddress.textContent = d.charge.address;
					const bip21 = buildBip21({ address: d.charge.address, amountBtc, label: 'three.ws · forever' });
					renderQR(bip21);
					setLinkActive(els.openWallet, bip21);
					setLinkActive(els.mempoolLink, `https://mempool.space/address/${d.charge.address}`);
				}
				setStatePill(d.state || 'waiting-payment');
				startPolling();
				if (d.state === 'inscribed' && d.inscription?.id) onInscribed(d);
			})
			.catch(() => startPolling());
	} catch {
		sessionStorage.removeItem('forever:order');
	}
})();
