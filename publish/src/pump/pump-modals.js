/**
 * Pump.fun modals: pay, governance, launch wizard, withdraw confirm.
 *
 * Mounted once per page via mountPumpModals(). Listens on window CustomEvents
 * dispatched by the AgentTokenWidget (pump-pay-open, pump-governance-open,
 * pump-withdraw-prepared) plus an explicit launch trigger.
 *
 * All flows go through the existing prep/confirm endpoints. Wallet signing
 * uses the same Solana wallet adapter pattern as src/erc8004/solana-deploy.js
 * (window.solana / phantom / backpack / solflare). Frontend never holds keys.
 */

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
.pmodal-slider-label {
	display: flex; justify-content: space-between; font-size: 0.78rem;
	color: rgba(255,255,255,0.6); margin-top: 0.4rem;
}
.pmodal-slider-label b { color: #a4f0bc; font-weight: 500; }
.pmodal-actions { display: flex; gap: 0.5rem; margin-top: 1.2rem; }
.pmodal-btn {
	flex: 1; padding: 0.6rem 0.9rem; border-radius: 8px; cursor: pointer;
	background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
	color: rgba(255,255,255,0.85); font-size: 0.86rem; transition: 0.15s;
}
.pmodal-btn:hover { background: rgba(255,255,255,0.08); }
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
	back.appendChild(inner);
	document.body.appendChild(back);
	back.addEventListener('click', (e) => {
		if (e.target === back) close();
	});
	function close() {
		if (back.parentNode) back.parentNode.removeChild(back);
	}
	return { back, inner, close };
}

// Bundled, not loaded from a CDN: same @solana/web3.js + spl-token versions
// the rest of the app uses.
import {
	VersionedTransaction,
	Connection,
	PublicKey,
	Keypair,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountInstruction,
	getAccount,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

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
	// Phantom Lighthouse requires the wallet to sign FIRST when there are
	// multiple signers; additional signers must sign afterward.
	const signed = await wallet.signTransaction(tx);
	for (const kp of extraSigners) signed.sign([kp]);
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
		const { TransactionMessage } = await import('@solana/web3.js');
		const decompiled = TransactionMessage.decompile(original.message);
		const merged = new TransactionMessage({
			payerKey: decompiled.payerKey,
			recentBlockhash: decompiled.recentBlockhash,
			instructions: [...prependIxs, ...decompiled.instructions],
		}).compileToV0Message();
		toSign = new VersionedTransaction(merged);
	}

	// Phantom Lighthouse requires the wallet to sign FIRST when there are
	// multiple signers; additional signers must sign afterward.
	const signed = await w.signTransaction(toSign);
	for (const kp of extraSigners) signed.sign([kp]);
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

// ── Launch wizard ──────────────────────────────────────────────────────────
function openLaunch({ identity, agentId }) {
	const { inner, close } = openModal();
	let step = 1;

	function render() {
		const symbolDefault = (identity?.name || 'AGENT')
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 8) || 'AGENT';
		inner.innerHTML = `
			<h3>Launch $${symbolDefault}</h3>
			<div class="pmodal-sub">Pump.fun bonding curve + agent-payments PDA. Three steps.</div>
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
			body.innerHTML = `
				<label>Name</label>
				<input type="text" id="pmodal-launch-name" value="${identity?.name || 'Agent'}" />
				<label>Symbol</label>
				<input type="text" id="pmodal-launch-symbol" maxlength="10" value="${symbolDefault}" />
				<label>Metadata URI <span style="color:rgba(255,255,255,0.4)">(IPFS or HTTPS to a JSON manifest with avatar + bio)</span></label>
				<input type="text" id="pmodal-launch-uri" placeholder="https://three.ws/agent/${agentId}/pump-metadata.json" />
			`;
		} else if (step === 2) {
			body.innerHTML = `
				<label>Buyback share</label>
				<input type="range" min="0" max="5000" step="50" value="500" id="pmodal-launch-bps" />
				<div class="pmodal-slider-label">
					<span>0%</span>
					<b id="pmodal-launch-bps-val">5.0%</b>
					<span>50%</span>
				</div>
				<div class="pmodal-row" style="border-top:none;margin-top:0.6rem">
					<span>If this agent earns $10/mo:</span>
					<b id="pmodal-launch-projection">$0.50/mo burned</b>
				</div>
				<label>Creator initial buy <span style="color:rgba(255,255,255,0.4)">(SOL, optional)</span></label>
				<input type="number" id="pmodal-launch-buyin" value="0" min="0" max="50" step="0.1" />
				<div class="pmodal-sub" style="margin-top:0.7rem">
					Buyback share is locked once configured (per the SDK fee-share policy).
					Choose carefully — it can't be changed later via this wizard.
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
		} else if (step === 3) {
			const name = inner._formCache?.name || identity?.name;
			const symbol = inner._formCache?.symbol || symbolDefault;
			const bps = inner._formCache?.bps || 500;
			const buyin = inner._formCache?.buyin || 0;
			body.innerHTML = `
				<div class="pmodal-row"><span>Name</span><b>${name}</b></div>
				<div class="pmodal-row"><span>Symbol</span><b>$${symbol}</b></div>
				<div class="pmodal-row"><span>Buyback</span><b>${(bps / 100).toFixed(1)}%</b></div>
				<div class="pmodal-row"><span>Initial buy</span><b>${buyin} SOL</b></div>
				<div class="pmodal-row"><span>Tx contains</span><b>createInstruction + PumpAgent.create</b></div>
				<div class="pmodal-sub" style="margin-top:0.7rem">
					You'll be asked to sign once with your Solana wallet. Both the new
					mint keypair and your wallet co-sign.
				</div>
			`;
		}

		inner.querySelector('#pmodal-launch-back').addEventListener('click', () => {
			step = Math.max(1, step - 1);
			render();
		});
		inner.querySelector('#pmodal-launch-next').addEventListener('click', async () => {
			const errEl = inner.querySelector('#pmodal-launch-err');
			errEl.textContent = '';
			if (step === 1) {
				const name = inner.querySelector('#pmodal-launch-name').value.trim();
				const symbol = inner.querySelector('#pmodal-launch-symbol').value.trim().toUpperCase();
				const uri = inner.querySelector('#pmodal-launch-uri').value.trim();
				if (!name || !symbol || !uri) {
					errEl.textContent = 'All three fields are required.';
					return;
				}
				inner._formCache = { ...(inner._formCache || {}), name, symbol, uri };
				step = 2;
				render();
			} else if (step === 2) {
				const bps = parseInt(inner.querySelector('#pmodal-launch-bps').value, 10);
				const buyin = parseFloat(inner.querySelector('#pmodal-launch-buyin').value || '0');
				inner._formCache = { ...(inner._formCache || {}), bps, buyin };
				step = 3;
				render();
			} else {
				const btn = inner.querySelector('#pmodal-launch-next');
				btn.disabled = true;
				btn.textContent = 'Preparing…';
				try {
					const wallet = detectSolanaWallet();
					if (!wallet) throw new Error('No Solana wallet detected.');
					if (!wallet.isConnected) await wallet.connect?.();
					const payer =
						wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString();
					const f = inner._formCache || {};
					const prep = await fetch('/api/pump/launch-prep', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({
							agent_id: agentId,
							wallet_address: payer,
							name: f.name,
							symbol: f.symbol,
							uri: f.uri,
							buyback_bps: f.bps || 0,
							sol_buy_in: f.buyin || 0,
							network: 'mainnet',
						}),
					}).then((r) => r.json());
					if (prep.error) throw new Error(prep.error_description || prep.error);

					const mintKp = prep.mint_secret_key_b64
						? Keypair.fromSecretKey(
								Uint8Array.from(atob(prep.mint_secret_key_b64), (c) => c.charCodeAt(0)),
							)
						: null;
					btn.textContent = 'Sign in wallet…';
					const sig = await signAndSend(prep.tx_base64, {
						extraSigners: mintKp ? [mintKp] : [],
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
					btn.textContent = 'Launched 🎉';
					setTimeout(() => {
						close();
						window.location.reload();
					}, 1200);
				} catch (e) {
					errEl.textContent = e.message || String(e);
					const btn = inner.querySelector('#pmodal-launch-next');
					if (btn) {
						btn.disabled = false;
						btn.textContent = 'Launch on-chain';
					}
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

export function openPumpLaunchWizard(identity, agentId) {
	openLaunch({ identity, agentId });
}
