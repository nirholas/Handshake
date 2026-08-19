/**
 * Pump.fun modals: pay, governance, launch wizard.
 *
 * Mounted once per page via mountPumpModals(). Listens on window CustomEvents
 * dispatched by the AgentTokenWidget (pump-pay-open, pump-governance-open,
 * pump-withdraw-prepared) plus an explicit launch trigger.
 *
 * All flows go through the existing prep/confirm endpoints. Wallet signing
 * uses the same Solana wallet adapter pattern as src/erc8004/solana-deploy.js
 * (window.solana / phantom / backpack / solflare). Frontend never holds keys.
 */

import { grindVanity } from '../solana/vanity/grinder.js';
import { THREE_WS_VANITY } from '../solana/vanity/brand.js';
import { ensureRiskAck } from '../shared/risk-ack.js';

const M_STYLES = `
.pmodal-back {
	position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px);
	display: flex; align-items: center; justify-content: center; z-index: 1000;
	padding: 1rem; animation: pmodal-in 0.2s ease;
}
@keyframes pmodal-in { from { opacity: 0 } to { opacity: 1 } }
.pmodal {
	background: #0c0c0e; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
	max-width: 460px; width: 100%; padding: 1.4rem; color: #e5e5e5;
	font: 14px/1.5 Inter, sans-serif;
	box-shadow: 0 24px 60px rgba(0,0,0,0.5);
}
.pmodal h3 { margin: 0 0 0.3rem; font-weight: 400; font-size: 1.1rem; letter-spacing: -0.01em; }
.pmodal-sub { color: rgba(255,255,255,0.55); font-size: 0.82rem; margin-bottom: 1rem; }
.pmodal-row { display: flex; justify-content: space-between; padding: 0.4rem 0; font-size: 0.85rem; }
.pmodal-row + .pmodal-row { border-top: 1px solid rgba(255,255,255,0.04); }
.pmodal-row b { color: rgba(255,255,255,0.95); font-weight: 500; }
.pmodal-row code { font-family: ui-monospace, monospace; font-size: 0.78rem; color: rgba(255,255,255,0.6); }
.pmodal label { display: block; font-size: 0.78rem; color: rgba(255,255,255,0.55); margin: 0.7rem 0 0.3rem; }
.pmodal input[type="number"], .pmodal input[type="text"], .pmodal select {
	width: 100%; padding: 0.55rem 0.7rem; border-radius: 8px;
	background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
	color: #fff; font-size: 0.9rem; font-family: inherit;
}
.pmodal input[type="range"] { width: 100%; accent-color: #a4f0bc; }
.pmodal input:focus-visible, .pmodal select:focus-visible, .pmodal textarea:focus-visible {
	outline: 2px solid #fff; outline-offset: 2px;
}
.pmodal-slider-label {
	display: flex; justify-content: space-between; font-size: 0.78rem;
	color: rgba(255,255,255,0.6); margin-top: 0.4rem;
}
.pmodal-slider-label b { color: #a4f0bc; font-weight: 500; }
.pmodal-quote-toggle { display: flex; gap: 0.4rem; margin-top: 0.3rem; }
.pmodal-quote-opt {
	flex: 1; padding: 0.5rem 0.7rem; border-radius: 8px; cursor: pointer;
	background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
	color: rgba(255,255,255,0.7); font-size: 0.84rem; font-weight: 600; transition: 0.15s;
}
.pmodal-quote-opt:hover { background: rgba(255,255,255,0.08); }
.pmodal-quote-opt:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.pmodal-quote-opt.active {
	background: rgba(120,200,140,0.18); border-color: rgba(120,200,140,0.4); color: #d8f5e2;
}
.pmodal-actions { display: flex; gap: 0.5rem; margin-top: 1.2rem; }
.pmodal-btn {
	flex: 1; padding: 0.6rem 0.9rem; border-radius: 8px; cursor: pointer;
	background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
	color: rgba(255,255,255,0.85); font-size: 0.86rem; transition: 0.15s;
}
.pmodal-btn:hover { background: rgba(255,255,255,0.08); }
.pmodal-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.pmodal-btn-primary {
	background: rgba(120,200,140,0.18); border-color: rgba(120,200,140,0.32); color: #d8f5e2;
}
.pmodal-btn-primary:hover { background: rgba(120,200,140,0.26); }
.pmodal-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.pmodal-error { color: #f6b3b3; font-size: 0.8rem; margin-top: 0.6rem; min-height: 1em; }
.pmodal-ok    { color: #a4f0bc; font-size: 0.8rem; margin-top: 0.6rem; }
.pmodal-steps { display: flex; gap: 0.4rem; margin-bottom: 0.7rem; }
.pmodal-step {
	flex: 1; height: 3px; border-radius: 99px; background: rgba(255,255,255,0.06);
}
.pmodal-step.done   { background: #a4f0bc; }
.pmodal-step.active { background: rgba(164,240,188,0.5); }
.pmodal-receipt {
	margin-top: 0.6rem; padding: 0.7rem 0.85rem; border-radius: 10px;
	background: rgba(120,200,140,0.06); border: 1px solid rgba(120,200,140,0.18);
}
.pmodal-receipt-title { font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(180,230,200,0.85); margin-bottom: 0.4rem; }
.pmodal textarea { width: 100%; padding: 0.5rem 0.7rem; border-radius: 8px; resize: vertical;
	background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
	color: #fff; font-size: 0.85rem; font-family: inherit; }
.pmodal-meta-building { font-size: 0.78rem; color: rgba(255,255,255,0.45); margin-top: 0.6rem;
	animation: pmodal-pulse 1.4s ease-in-out infinite; }
.pmodal-meta-ok { font-size: 0.78rem; color: #a4f0bc; margin-top: 0.6rem; }
@keyframes pmodal-pulse { 0%,100% { opacity: 0.45 } 50% { opacity: 0.9 } }
`;

let stylesInjected = false;
function ensureStyles() {
	if (stylesInjected) return;
	const t = document.createElement('style');
	t.textContent = M_STYLES;
	document.head.appendChild(t);
	stylesInjected = true;
}

function detectSolanaWallet() {
	if (typeof window === 'undefined') return null;
	return (
		window.solana ||
		window.phantom?.solana ||
		window.backpack ||
		window.solflare ||
		null
	);
}

function openModal() {
	ensureStyles();
	const back = document.createElement('div');
	back.className = 'pmodal-back';
	const inner = document.createElement('div');
	inner.className = 'pmodal';
	inner.setAttribute('role', 'dialog');
	inner.setAttribute('aria-modal', 'true');
	back.appendChild(inner);
	document.body.appendChild(back);
	back.addEventListener('click', (e) => {
		if (e.target === back) close();
	});

	const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
	function focusables() {
		return Array.from(inner.querySelectorAll(FOCUSABLE)).filter(
			(el) => el.offsetParent !== null || el === document.activeElement,
		);
	}
	function onKeydown(e) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
			return;
		}
		if (e.key !== 'Tab') return;
		const items = focusables();
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
	document.addEventListener('keydown', onKeydown, true);

	// Focus the first input, else the first button, inside the modal. Callers
	// populate inner.innerHTML synchronously after openModal() returns, so defer
	// to the next frame to focus a control that actually exists.
	requestAnimationFrame(() => {
		if (!inner.isConnected) return;
		const firstField = inner.querySelector('input, select, textarea') || inner.querySelector('button');
		if (firstField) firstField.focus();
	});

	function close() {
		document.removeEventListener('keydown', onKeydown, true);
		if (back.parentNode) back.parentNode.removeChild(back);
	}
	return { back, inner, close };
}

// Bundled npm imports — public/agent/index.html is registered as a Vite
// build input so its inline scripts (and this module) are processed by Rollup,
// which resolves bare specifiers against node_modules and ships the deps
// in the page's hashed asset chunk.
const {
	VersionedTransaction,
	Connection,
	PublicKey,
	Keypair,
	TransactionMessage,
} = await import('@solana/web3.js');
const {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountInstruction,
	getAccount,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} = await import('@solana/spl-token');

// Route through our same-origin proxy. The public mainnet RPC returns 403 to
// most browser origins; the proxy forwards server-side to Helius when
// HELIUS_API_KEY is set.
const RPC_ORIGIN =
	typeof window !== 'undefined' && window.location?.origin
		? window.location.origin
		: 'https://three.ws';
const RPC = (network) =>
	network === 'devnet'
		? `${RPC_ORIGIN}/api/solana-rpc?net=devnet`
		: `${RPC_ORIGIN}/api/solana-rpc`;

const USDC_MINT = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

/**
 * Derive the user's USDC associated token account. If the ATA does not yet
 * exist, returns null for `existing` so the caller can prepend a creation ix.
 */
export async function resolveUsdcAta({ owner, network = 'mainnet', currencyMint } = {}) {
	const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
	const mint = new PublicKey(currencyMint || USDC_MINT[network] || USDC_MINT.mainnet);
	const ata = await getAssociatedTokenAddress(mint, ownerPk, false);
	const conn = new Connection(RPC(network), 'confirmed');
	let existing = null;
	try {
		existing = await getAccount(conn, ata);
	} catch {
		existing = null;
	}
	return { ata, mint, owner: ownerPk, existing, connection: conn };
}

async function signAndSend(txBase64, { extraSigners = [], network = 'mainnet' } = {}) {
	const wallet = detectSolanaWallet();
	if (!wallet) throw new Error('No Solana wallet detected. Install Phantom.');
	if (!wallet.isConnected) await wallet.connect?.();
	const tx = VersionedTransaction.deserialize(
		Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0)),
	);
	for (const kp of extraSigners) tx.sign([kp]);
	const signed = await wallet.signTransaction(tx);
	const conn = new Connection(RPC(network), 'confirmed');
	const sig = await conn.sendRawTransaction(signed.serialize(), {
		skipPreflight: false,
	});
	await conn.confirmTransaction(sig, 'confirmed');
	return sig;
}

/**
 * Sign + send a server-prepared VersionedTransaction. Optionally prepend
 * additional instructions (e.g. ATA creation) before submission. Used by the
 * widget's withdraw flow which needs a CreateATA + Withdraw atomic.
 *
 * Note: prepending ixs requires recompiling to a v0 message because the server
 * already finalized the message. We prepend by deserialising, building a fresh
 * message with the original blockhash + payer + (extra + original) ixs is not
 * possible without reading the original ixs from the message — which we do via
 * `getMessage()` decompile. Fallback: if prependIxs is empty, just re-sign.
 */
export async function signAndSendVTx(
	txBase64,
	{ extraSigners = [], network = 'mainnet', prependIxs = [], wallet, connection } = {},
) {
	const w = wallet || detectSolanaWallet();
	if (!w) throw new Error('No Solana wallet detected. Install Phantom.');
	if (!w.isConnected) await w.connect?.();
	const conn = connection || new Connection(RPC(network), 'confirmed');

	const original = VersionedTransaction.deserialize(
		Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0)),
	);

	let toSign = original;
	if (prependIxs && prependIxs.length) {
		// Decompile original message → splice in prepend ixs → recompile.
		const decompiled = TransactionMessage.decompile(original.message);
		const merged = new TransactionMessage({
			payerKey: decompiled.payerKey,
			recentBlockhash: decompiled.recentBlockhash,
			instructions: [...prependIxs, ...decompiled.instructions],
		}).compileToV0Message();
		toSign = new VersionedTransaction(merged);
	}

	for (const kp of extraSigners) toSign.sign([kp]);
	const signed = await w.signTransaction(toSign);
	const sig = await conn.sendRawTransaction(signed.serialize(), {
		skipPreflight: false,
	});
	await conn.confirmTransaction(sig, 'confirmed');
	return sig;
}

// ── Pay modal ───────────────────────────────────────────────────────────────
function openPay({ mint, network }) {
	const { inner, close } = openModal();
	let receipt = null;
	inner.innerHTML = `
		<h3>Pay this agent</h3>
		<div class="pmodal-sub">Settles via pump-agent-payments. Funds buyback + owner per the agent's split.</div>
		<label>Amount (USDC)</label>
		<input type="number" min="0.01" step="0.01" value="0.50" id="pmodal-pay-amount" />
		<label>Why <span style="color:rgba(255,255,255,0.4)">(optional — surfaces in the feed)</span></label>
		<input type="text" placeholder="optimize_model" id="pmodal-pay-tool" />
		<label>Window</label>
		<select id="pmodal-pay-window">
			<option value="60">1 minute (single call)</option>
			<option value="3600">1 hour</option>
			<option value="86400">1 day (subscription)</option>
			<option value="2592000">30 days (subscription)</option>
		</select>
		<div class="pmodal-error" id="pmodal-pay-err"></div>
		<div id="pmodal-pay-receipt"></div>
		<div class="pmodal-actions">
			<button class="pmodal-btn" id="pmodal-pay-cancel">Cancel</button>
			<button class="pmodal-btn pmodal-btn-primary" id="pmodal-pay-go">Pay</button>
		</div>
	`;
	inner.querySelector('#pmodal-pay-cancel').addEventListener('click', close);
	inner.querySelector('#pmodal-pay-go').addEventListener('click', async () => {
		const amt = parseFloat(inner.querySelector('#pmodal-pay-amount').value);
		const tool = inner.querySelector('#pmodal-pay-tool').value.trim();
		const win = parseInt(inner.querySelector('#pmodal-pay-window').value, 10);
		const err = inner.querySelector('#pmodal-pay-err');
		const btn = inner.querySelector('#pmodal-pay-go');
		err.textContent = '';
		if (!(amt > 0)) {
			err.textContent = 'Amount must be > 0';
			return;
		}
		const wallet = detectSolanaWallet();
		if (!wallet) {
			err.textContent = 'No Solana wallet detected. Install Phantom.';
			return;
		}
		if (network !== 'devnet' && !(await ensureRiskAck({ context: 'x402-pay' }))) return;
		btn.disabled = true;
		btn.textContent = 'Connecting…';
		try {
			if (!wallet.isConnected) await wallet.connect?.();
			const payer = wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString();
			btn.textContent = 'Resolving ATA…';
			const { ata, existing } = await resolveUsdcAta({ owner: payer, network });
			if (!existing) {
				err.textContent =
					'Your USDC token account does not exist on this wallet yet. Receive any amount of USDC first, then try again.';
				btn.disabled = false;
				btn.textContent = 'Pay';
				return;
			}
			btn.textContent = 'Preparing…';
			const prep = await fetch('/api/pump/accept-payment-prep', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					mint,
					payer_wallet: payer,
					user_token_account: ata.toBase58(),
					amount_usdc: amt,
					duration_seconds: win,
					tool_name: tool || undefined,
					network,
				}),
			}).then((r) => r.json());
			if (prep.error) throw new Error(prep.error_description || prep.error);
			btn.textContent = 'Sign in wallet…';
			const sig = await signAndSend(prep.tx_base64, { network });
			btn.textContent = 'Confirming…';
			const confirm = await fetch('/api/pump/accept-payment-confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ payment_id: prep.payment_id, tx_signature: sig }),
			}).then((r) => r.json());
			if (confirm.error) throw new Error(confirm.error_description || confirm.error);
			receipt = { ...prep, tx_signature: sig };
			inner.querySelector('#pmodal-pay-receipt').innerHTML = `
				<div class="pmodal-receipt">
					<div class="pmodal-receipt-title">X402 receipt</div>
					<div class="pmodal-row"><span>Invoice</span><code>${prep.invoice_id}</code></div>
					<div class="pmodal-row"><span>Amount</span><b>$${amt.toFixed(2)}</b></div>
					<div class="pmodal-row"><span>Settles</span><a href="https://solscan.io/tx/${sig}${network === 'devnet' ? '?cluster=devnet' : ''}" target="_blank" rel="noopener" style="color:#a4f0bc">${sig.slice(0, 8)}…</a></div>
				</div>`;
			btn.textContent = 'Done';
		} catch (e) {
			err.textContent = e.message || String(e);
			btn.disabled = false;
			btn.textContent = 'Pay';
		}
	});
}

// ── Governance modal (updateBuybackBps) ─────────────────────────────────────
function openGovernance({ mint, currentBps }) {
	const { inner, close } = openModal();
	inner.innerHTML = `
		<h3>Set buyback share</h3>
		<div class="pmodal-sub">What share of every paid call burns $AGENT? Higher = more deflation; lower = more owner takeaway.</div>
		<input type="range" min="0" max="10000" step="50" value="${currentBps || 0}" id="pmodal-gov-slider" />
		<div class="pmodal-slider-label">
			<span>0%</span>
			<b id="pmodal-gov-val">${((currentBps || 0) / 100).toFixed(1)}%</b>
			<span>100%</span>
		</div>
		<div class="pmodal-error" id="pmodal-gov-err"></div>
		<div class="pmodal-actions">
			<button class="pmodal-btn" id="pmodal-gov-cancel">Cancel</button>
			<button class="pmodal-btn pmodal-btn-primary" id="pmodal-gov-go">Update on-chain</button>
		</div>
	`;
	const slider = inner.querySelector('#pmodal-gov-slider');
	const val = inner.querySelector('#pmodal-gov-val');
	slider.addEventListener('input', () => {
		val.textContent = `${(slider.value / 100).toFixed(1)}%`;
	});
	inner.querySelector('#pmodal-gov-cancel').addEventListener('click', close);
	inner.querySelector('#pmodal-gov-go').addEventListener('click', async () => {
		const err = inner.querySelector('#pmodal-gov-err');
		const btn = inner.querySelector('#pmodal-gov-go');
		err.textContent = '';
		btn.disabled = true;
		btn.textContent = 'Preparing…';
		try {
			const wallet = detectSolanaWallet();
			if (!wallet) throw new Error('No Solana wallet detected.');
			if (!wallet.isConnected) await wallet.connect?.();
			const payer = wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString();
			const prep = await fetch('/api/pump/governance-prep', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					mint,
					authority_wallet: payer,
					new_buyback_bps: parseInt(slider.value, 10),
					network: 'mainnet',
				}),
			}).then((r) => r.json());
			if (prep.error) throw new Error(prep.error_description || prep.error);
			btn.textContent = 'Sign in wallet…';
			const sig = await signAndSend(prep.tx_base64, { network: 'mainnet' });
			btn.textContent = `Done · ${sig.slice(0, 6)}…`;
		} catch (e) {
			err.textContent = e.message || String(e);
			btn.disabled = false;
			btn.textContent = 'Update on-chain';
		}
	});
}

// Token images travel to /api/pump/build-metadata as base64 JSON, which
// inflates raw bytes by 4/3. Files at or under this size always fit the API's
// 4 MB raw ceiling once encoded, so they ship untouched (this also preserves
// animated GIFs). Anything larger is downscaled in the browser rather than
// rejected. Twin of the helper in public/studio/launch-panel.js (the two
// launch surfaces are bundled separately and cannot share a module).
const IMAGE_PASSTHROUGH_BYTES = 3 * 1024 * 1024;
const IMAGE_MAX_DIM = 1024;

async function downscaleTokenImage(file) {
	let bitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}
	const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close?.();
	const encode = (type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));
	// PNG first to keep transparency; JPEG only when PNG is still too big.
	let blob = await encode('image/png');
	if (!blob || blob.size > IMAGE_PASSTHROUGH_BYTES) {
		for (const quality of [0.92, 0.85, 0.75]) {
			const jpeg = await encode('image/jpeg', quality);
			if (jpeg) blob = jpeg;
			if (jpeg && jpeg.size <= IMAGE_PASSTHROUGH_BYTES) break;
		}
	}
	if (!blob || blob.size > IMAGE_PASSTHROUGH_BYTES) return null;
	const base = (file.name || 'token').replace(/\.[^.]+$/, '');
	const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
	return new File([blob], `${base}.${ext}`, { type: blob.type });
}

// ── Launch wizard ──────────────────────────────────────────────────────────
// formData: { name, symbol, description, initialBuy, feeTier, image (File|null) }
// Steps: 1 = token details (pre-filled) + metadata generation
//        2 = quote pair (SOL/USDC) + buyback share + initial buy
//        3 = review + sign
function openLaunch({ identity, agentId, avatarId, formData }) {
	const { inner, close } = openModal();
	let step = 1;
	// Aborts the in-browser 3ws-mark grind if the user backs out mid-stamp.
	let launchGrindAbort = null;

	async function buildMetadata(name, symbol, description) {
		let imageDataUrl = null;
		if (formData?.image instanceof File) {
			let imageFile = formData.image;
			if (imageFile.size > IMAGE_PASSTHROUGH_BYTES) {
				imageFile = await downscaleTokenImage(imageFile);
				if (!imageFile) {
					throw new Error('Token image is too large. Use an image under 4 MB.');
				}
			}
			imageDataUrl = await new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = (e) => resolve(e.target.result);
				reader.onerror = () => resolve(null);
				reader.readAsDataURL(imageFile);
			});
		}
		const descSource = description || formData?.description || identity?.description || '';
		const payload = {
			name: String(name).trim().slice(0, 32),
			symbol: String(symbol).trim().slice(0, 10),
			description: String(descSource).trim().slice(0, 500),
			...(avatarId ? { avatar_id: avatarId } : {}),
			...(agentId ? { agent_id: agentId } : {}),
			...(imageDataUrl ? { image_data_url: imageDataUrl } : {}),
		};
		const resp = await fetch('/api/pump/build-metadata', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(payload),
		});
		if (!resp.ok) {
			const errJson = await resp.json().catch(() => null);
			const detail = errJson?.error_description
				|| errJson?.issues?.map((i) => `${i.path?.join('.') || 'body'}: ${i.message}`).join('; ')
				|| errJson?.error
				|| `HTTP ${resp.status}`;
			throw new Error(detail);
		}
		return resp.json();
	}

	function esc(s) {
		return String(s ?? '').replace(/[&<>"']/g, (c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
		);
	}

	function render() {
		const nameDefault = String(formData?.name || identity?.name || 'Agent').slice(0, 32);
		const symbolDefault = (formData?.symbol || nameDefault)
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 8) || 'AGENT';
		const descDefault = String(formData?.description || identity?.description || '').slice(0, 500);

		inner.innerHTML = `
			<h3>Launch $${esc(symbolDefault)}</h3>
			<div class="pmodal-sub">Pump.fun bonding curve · Three steps.</div>
			<div class="pmodal-steps">
				<div class="pmodal-step ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
				<div class="pmodal-step ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
				<div class="pmodal-step ${step >= 3 ? (step === 3 ? 'active' : 'done') : ''}"></div>
			</div>
			<div id="pmodal-launch-body"></div>
			<div class="pmodal-error" id="pmodal-launch-err"></div>
			<div class="pmodal-actions">
				<button class="pmodal-btn" id="pmodal-launch-back" ${step === 1 ? 'disabled' : ''}>Back</button>
				<button class="pmodal-btn pmodal-btn-primary" id="pmodal-launch-next">${step === 3 ? 'Launch on-chain' : 'Next'}</button>
			</div>
		`;
		const body = inner.querySelector('#pmodal-launch-body');

		if (step === 1) {
			const cachedName = inner._formCache?.name || nameDefault;
			const cachedSymbol = inner._formCache?.symbol || symbolDefault;
			body.innerHTML = `
				<label>Token name</label>
				<input type="text" id="pmodal-launch-name" maxlength="32" value="${esc(cachedName)}" />
				<label>Symbol</label>
				<input type="text" id="pmodal-launch-symbol" maxlength="10" value="${esc(cachedSymbol)}" />
				<label>Description</label>
				<textarea id="pmodal-launch-desc" rows="2" maxlength="500">${esc(descDefault)}</textarea>
				<div class="pmodal-sub" style="margin-top:0.5rem">Token image and metadata are generated automatically from your avatar.</div>
			`;
		} else if (step === 2) {
			const initialBuyVal = formData?.initialBuy || inner._formCache?.buyin || 0;
			// Quote pair. USDC-paired is the default for agent coins: the agent
			// earns USDC, and its buyback swaps that USDC → token & burns in the
			// same currency. SOL-paired is the classic pump.fun curve.
			const quoteCur = inner._formCache?.quoteCurrency || 'usdc';
			const buyMax = quoteCur === 'usdc' ? 100000 : 50;
			const buyStep = quoteCur === 'usdc' ? 1 : 0.1;
			body.innerHTML = `
				<label>Quote pair</label>
				<div class="pmodal-quote-toggle" role="radiogroup" aria-label="Quote currency">
					<button type="button" class="pmodal-quote-opt${quoteCur === 'usdc' ? ' active' : ''}" data-quote="usdc" role="radio" aria-checked="${quoteCur === 'usdc'}">USDC</button>
					<button type="button" class="pmodal-quote-opt${quoteCur === 'sol' ? ' active' : ''}" data-quote="sol" role="radio" aria-checked="${quoteCur === 'sol'}">SOL</button>
				</div>
				<div class="pmodal-sub" id="pmodal-quote-note" style="margin-top:0.4rem"></div>
				<label style="margin-top:0.8rem">Buyback share</label>
				<input type="range" min="0" max="5000" step="50" value="${inner._formCache?.bps ?? 500}" id="pmodal-launch-bps" />
				<div class="pmodal-slider-label">
					<span>0%</span>
					<b id="pmodal-launch-bps-val">5.0%</b>
					<span>50%</span>
				</div>
				<div class="pmodal-row" style="border-top:none;margin-top:0.6rem">
					<span>If this agent earns $10/mo:</span>
					<b id="pmodal-launch-projection">$0.50/mo burned</b>
				</div>
				<label>Creator initial buy (<span id="pmodal-buyin-unit">${quoteCur.toUpperCase()}</span>, optional)</label>
				<input type="number" id="pmodal-launch-buyin" value="${Number(initialBuyVal) || 0}" min="0" max="${buyMax}" step="${buyStep}" />
				<div class="pmodal-sub" style="margin-top:0.7rem">
					Buyback share and quote pair are locked at launch — choose carefully.
				</div>
			`;
			const bps = body.querySelector('#pmodal-launch-bps');
			const v = body.querySelector('#pmodal-launch-bps-val');
			const proj = body.querySelector('#pmodal-launch-projection');
			const update = () => {
				const pct = bps.value / 100;
				v.textContent = `${pct.toFixed(1)}%`;
				proj.textContent = `$${((10 * pct) / 100).toFixed(2)}/mo burned`;
			};
			bps.addEventListener('input', update);
			update();

			const note = body.querySelector('#pmodal-quote-note');
			const buyUnit = body.querySelector('#pmodal-buyin-unit');
			const buyInput = body.querySelector('#pmodal-launch-buyin');
			const symForNote = inner._formCache?.symbol || symbolDefault;
			const renderQuote = (cur) => {
				if (note)
					note.innerHTML =
						cur === 'usdc'
							? `USDC-paired — the agent's USDC earnings buy back &amp; burn $${esc(symForNote)} in the same currency it earns.`
							: `SOL-paired — the classic pump.fun curve. Buyback burns are funded by swapping the agent's USDC earnings into SOL first.`;
				if (buyUnit) buyUnit.textContent = cur.toUpperCase();
				if (buyInput) {
					buyInput.max = cur === 'usdc' ? 100000 : 50;
					buyInput.step = cur === 'usdc' ? 1 : 0.1;
				}
			};
			renderQuote(quoteCur);
			body.querySelectorAll('.pmodal-quote-opt').forEach((btn) => {
				btn.addEventListener('click', () => {
					const cur = btn.dataset.quote;
					inner._formCache = { ...(inner._formCache || {}), quoteCurrency: cur };
					body.querySelectorAll('.pmodal-quote-opt').forEach((b) => {
						const on = b === btn;
						b.classList.toggle('active', on);
						b.setAttribute('aria-checked', String(on));
					});
					renderQuote(cur);
				});
			});
		} else if (step === 3) {
			const f = inner._formCache || {};
			const name = f.name || nameDefault;
			const symbol = f.symbol || symbolDefault;
			const cur = (f.quoteCurrency || 'usdc').toUpperCase();
			body.innerHTML = `
				<div class="pmodal-row"><span>Name</span><b>${esc(name)}</b></div>
				<div class="pmodal-row"><span>Symbol</span><b>$${esc(symbol)}</b></div>
				<div class="pmodal-row"><span>Quote pair</span><b>${esc(cur)}</b></div>
				<div class="pmodal-row"><span>Mint mark</span><b><code>3ws</code>…</b></div>
				<div class="pmodal-row"><span>Buyback</span><b>${((f.bps || 500) / 100).toFixed(1)}%</b></div>
				<div class="pmodal-row"><span>Initial buy</span><b>${f.buyin || 0} ${esc(cur)}</b></div>
				<div class="pmodal-row"><span>Tx</span><b>createInstruction + PumpAgent.create</b></div>
				<div class="pmodal-sub" style="margin-top:0.7rem">
					Every three.ws coin is stamped <code>3ws…</code> on-chain. We grind the mark in your browser, then you sign once — the mint keypair and your wallet co-sign.
				</div>
				<div class="pmodal-meta-building" id="pmodal-launch-grind" role="status" aria-live="polite" aria-atomic="false" hidden></div>
			`;
		}

		inner.querySelector('#pmodal-launch-back').addEventListener('click', () => {
			// Backing out mid-stamp cancels the grind so we never sign after the
			// user navigated away (the grind's catch treats AbortError as a no-op).
			if (launchGrindAbort) { try { launchGrindAbort.abort(); } catch {} }
			step = Math.max(1, step - 1);
			render();
		});

		inner.querySelector('#pmodal-launch-next').addEventListener('click', async () => {
			const errEl = inner.querySelector('#pmodal-launch-err');
			errEl.textContent = '';

			if (step === 1) {
				const name = inner.querySelector('#pmodal-launch-name').value.trim();
				const symbol = inner.querySelector('#pmodal-launch-symbol').value.trim().toUpperCase();
				const desc = inner.querySelector('#pmodal-launch-desc').value.trim();
				if (!name || !symbol) {
					errEl.textContent = 'Name and symbol are required.';
					return;
				}
				const nextBtn = inner.querySelector('#pmodal-launch-next');
				// Rebuild metadata if name/symbol changed or we have no URI yet
				const fieldsChanged =
					inner._formCache?.name !== name ||
					inner._formCache?.symbol !== symbol ||
					inner._formCache?.desc !== desc;
				inner._formCache = { ...(inner._formCache || {}), name, symbol, desc };
				if (fieldsChanged) inner._formCache.uri = null;
				if (!inner._formCache.uri) {
					nextBtn.disabled = true;
					nextBtn.textContent = 'Building metadata…';
					try {
						const data = await buildMetadata(name, symbol, desc);
						inner._formCache.uri = data.metadata_url;
					} catch (e) {
						errEl.textContent = `Metadata failed: ${e.message}`;
						nextBtn.disabled = false;
						nextBtn.textContent = 'Next';
						return;
					}
					nextBtn.disabled = false;
					nextBtn.textContent = 'Next';
				}
				step = 2;
				render();
			} else if (step === 2) {
				const bps = parseInt(inner.querySelector('#pmodal-launch-bps').value, 10);
				const buyin = parseFloat(inner.querySelector('#pmodal-launch-buyin').value || '0');
				const quoteCurrency = inner._formCache?.quoteCurrency || 'usdc';
				inner._formCache = { ...(inner._formCache || {}), bps, buyin, quoteCurrency };
				step = 3;
				render();
			} else {
				const btn = inner.querySelector('#pmodal-launch-next');
				btn.disabled = true;

				// 1 ── Grind the three.ws brand mark in the browser. The mint secret
				// never leaves the page; the server builds the tx around our vanity
				// pubkey and we co-sign locally.
				btn.textContent = 'Stamping 3ws…';
				const grindEl = inner.querySelector('#pmodal-launch-grind');
				if (grindEl) { grindEl.hidden = false; grindEl.textContent = 'Stamping the three.ws mark 3ws…'; }
				let mintKp;
				launchGrindAbort = new AbortController();
				try {
					const ground = await grindVanity({
						...THREE_WS_VANITY,
						signal: launchGrindAbort.signal,
						onProgress: ({ rate, eta }) => {
							if (grindEl && grindEl.isConnected) {
								grindEl.textContent = `Stamping the three.ws mark 3ws… ${Math.round(rate).toLocaleString()}/s · eta ${eta}`;
							}
						},
					});
					mintKp = Keypair.fromSecretKey(ground.secretKey);
				} catch (e) {
					launchGrindAbort = null;
					if (e?.name === 'AbortError' || !inner.isConnected) return; // user backed out
					errEl.textContent = e.message || 'Could not stamp the three.ws mark.';
					btn.disabled = false; btn.textContent = 'Launch on-chain';
					if (grindEl) grindEl.hidden = true;
					return;
				}
				launchGrindAbort = null;
				if (!inner.isConnected) return; // modal closed mid-grind — never pop the wallet
				if (grindEl) {
					const addr = mintKp.publicKey.toBase58();
					const mark = addr.slice(0, 3);
					const tail = addr.slice(3, 9) + '…';
					grindEl.innerHTML = `Stamped <strong style="color:rgba(255,255,255,.88);font-weight:700">${mark}</strong><span style="opacity:.5">${tail}</span> &mdash; every three.ws coin starts with <strong>3ws</strong>.`;
					grindEl.setAttribute('aria-label', `Stamped three.ws mark on mint ${addr.slice(0, 6)}…`);
				}

				btn.textContent = 'Preparing…';
				try {
					const wallet = detectSolanaWallet();
					if (!wallet) throw new Error('No Solana wallet detected. Install Phantom or Backpack.');
					if (!wallet.isConnected) await wallet.connect?.();
					const payer = wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString();
					if (!payer) throw new Error('Could not read wallet public key.');
					const f = inner._formCache || {};
					const prep = await fetch('/api/pump/launch-prep', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({
							...(agentId ? { agent_id: agentId } : {}),
							...(avatarId ? { avatar_id: avatarId } : {}),
							wallet_address: payer,
							name: f.name,
							symbol: f.symbol,
							uri: f.uri,
							buyback_bps: f.bps || 0,
							// USDC-paired by default so the buyback swaps in the same
							// currency the agent earns; the server resolves the mint.
							quote_currency: f.quoteCurrency || 'usdc',
							...((f.quoteCurrency || 'usdc') === 'usdc'
								? { usdc_buy_in: f.buyin || 0 }
								: { sol_buy_in: f.buyin || 0 }),
							mint_address: mintKp.publicKey.toBase58(),
							network: 'mainnet',
						}),
					}).then((r) => r.json());
					if (prep.error) throw new Error(prep.error_description || prep.error);

					btn.textContent = 'Sign in wallet…';
					const sig = await signAndSend(prep.tx_base64, {
						extraSigners: [mintKp],
						network: 'mainnet',
					});
					btn.textContent = 'Confirming…';
					const confirm = await fetch('/api/pump/launch-confirm', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({ prep_id: prep.prep_id, tx_signature: sig }),
					}).then((r) => r.json());
					if (confirm.error) throw new Error(confirm.error_description || confirm.error);
					// Show the stamped mint with emphasized 3ws prefix before redirect.
					const launchedMint = confirm.pump_agent_mint?.mint || mintKp.publicKey.toBase58();
					const mintMark = launchedMint.slice(0, 3);
					const mintRest = launchedMint.slice(3, 7) + '…' + launchedMint.slice(-4);
					if (grindEl) {
						grindEl.hidden = false;
						grindEl.className = 'pmodal-ok';
						grindEl.innerHTML = `Stamped on-chain — every three.ws coin starts with <strong style="font-weight:700">3ws</strong>. Mint: <strong style="color:rgba(255,255,255,.88);font-weight:700" aria-label="three.ws mark">${mintMark}</strong><span style="opacity:.5">${mintRest}</span>`;
					}
					btn.textContent = 'Launched!';
					const resolvedAgentId = prep.agent_id || agentId;
					setTimeout(() => {
						close();
						if (resolvedAgentId) {
							window.location.href = `/agents/${resolvedAgentId}`;
						} else {
							window.location.reload();
						}
					}, 900);
				} catch (e) {
					const isUnbranded = /unbranded_mint/.test(e.message || '');
					errEl.textContent = isUnbranded
						? 'Could not stamp the brand — retry to re-grind.'
						: (e.message || String(e));
					const btn = inner.querySelector('#pmodal-launch-next');
					if (btn) {
						btn.disabled = false;
						btn.textContent = isUnbranded ? 'Retry stamp' : 'Launch on-chain';
					}
					if (grindEl) { grindEl.hidden = true; grindEl.className = 'pmodal-meta-building'; }
				}
			}
		});
	}
	render();
}

// ── Mount ──────────────────────────────────────────────────────────────────
export function mountPumpModals({ identity, agentId } = {}) {
	if (typeof window === 'undefined') return;
	if (window.__pumpModalsMounted) return;
	window.__pumpModalsMounted = true;

	window.addEventListener('pump-pay-open', (e) => openPay(e.detail || {}));
	window.addEventListener('pump-governance-open', (e) =>
		openGovernance(e.detail || {}),
	);
	window.addEventListener('pump-launch-open', (e) =>
		openLaunch(e.detail || { identity, agentId }),
	);
}

export function openPumpLaunchWizard(identity, agentId, avatarId, formData) {
	openLaunch({ identity, agentId, avatarId, formData });
}
