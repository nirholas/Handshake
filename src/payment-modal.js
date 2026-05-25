/**
 * SkillPaymentModal — self-contained skill purchase flow for the agent-3d
 * embed element. Renders inside the shadow DOM so it works on any host page
 * without colliding with host CSS.
 *
 * Usage:
 *   const modal = new SkillPaymentModal(shadowRoot, agentId);
 *   const purchased = await modal.show({ skill, price });
 *   if (purchased) runtime.skillAccess = refreshedChecker;
 */

const USDC_DECIMALS = 6;

// Lazy-load Solana modules via bundled npm deps. Dynamic import keeps the
// Solana SDKs out of the initial chunk; Vite splits them into their own
// asset that's only fetched when a payment actually happens.
let _web3 = null;
let _spl = null;
async function loadSolana() {
	if (!_web3) _web3 = await import('@solana/web3.js');
	if (!_spl) _spl = await import('@solana/spl-token');
	return { web3: _web3, spl: _spl };
}

const STYLE = `
.pay-chip {
	background: rgba(167,139,250,.08);
	border: 1px solid rgba(167,139,250,.22);
	border-radius: 12px; padding: 12px 14px; margin: 2px 0;
}
.pay-chip-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.pay-chip-label { font-size: 12px; font-weight: 600; color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .06em; }
.pay-chip-skill { font-size: 13px; color: #a78bfa; font-family: monospace; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pay-chip-price { font-size: 15px; color: #34d399; font-weight: 700; margin-bottom: 10px; }
.pay-chip-actions { display: flex; gap: 8px; }
.pay-chip-btn {
	flex: 1; padding: 8px 12px; border-radius: 8px; border: none;
	font-size: 13px; font-weight: 600; cursor: pointer;
	background: linear-gradient(135deg, #7c3aed, #6d28d9); color: #fff;
	transition: opacity .15s; letter-spacing: .02em;
}
.pay-chip-btn:hover:not(:disabled) { opacity: .85; }
.pay-chip-btn:disabled { opacity: .4; cursor: default; }
.pay-chip-btn-pay { background: linear-gradient(135deg, #059669, #047857); }
.pay-chip-btn-cancel { flex: 0 0 auto; background: rgba(255,255,255,.08); color: rgba(255,255,255,.45); }
.pay-chip-status { font-size: 12px; color: rgba(255,255,255,.45); margin-top: 7px; min-height: 15px; }
.pay-chip-status.err { color: #f87171; }
.pay-chip-status.ok  { color: #34d399; }
.skill-pay-overlay {
	position: fixed; inset: 0; background: rgba(0,0,0,0.72);
	display: flex; align-items: center; justify-content: center;
	z-index: 9999; font-family: system-ui, sans-serif;
}
.skill-pay-overlay[hidden] { display: none; }
.skill-pay-box {
	background: #1a1a2e; border: 1px solid rgba(255,255,255,.12);
	border-radius: 16px; padding: 28px 24px; max-width: 380px; width: 90%;
	color: #f0f0f0; box-shadow: 0 24px 64px rgba(0,0,0,.6);
}
.skill-pay-head {
	display: flex; align-items: center; justify-content: space-between;
	margin-bottom: 20px;
}
.skill-pay-title { font-size: 17px; font-weight: 700; letter-spacing: .01em; }
.skill-pay-close {
	background: none; border: none; color: rgba(255,255,255,.5); font-size: 22px;
	cursor: pointer; line-height: 1; padding: 0; transition: color .15s;
}
.skill-pay-close:hover { color: #fff; }
.skill-pay-skill {
	font-size: 15px; font-weight: 600; color: #a78bfa;
	background: rgba(167,139,250,.1); border-radius: 8px;
	padding: 8px 12px; margin: 0 0 8px; font-family: monospace;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.skill-pay-desc { font-size: 13px; color: rgba(255,255,255,.55); margin: 0 0 16px; }
.skill-pay-price {
	display: flex; align-items: center; justify-content: space-between;
	font-size: 15px; margin-bottom: 20px; padding: 12px;
	background: rgba(255,255,255,.05); border-radius: 10px;
}
.skill-pay-price strong { font-size: 20px; color: #34d399; }
.skill-pay-wallet-area { margin-bottom: 12px; }
.skill-pay-btn {
	width: 100%; padding: 12px; border-radius: 10px; border: none;
	font-size: 14px; font-weight: 600; cursor: pointer;
	background: linear-gradient(135deg, #7c3aed, #6d28d9); color: #fff;
	transition: opacity .15s; letter-spacing: .02em;
}
.skill-pay-btn:hover:not(:disabled) { opacity: .88; }
.skill-pay-btn:disabled { opacity: .4; cursor: default; }
.skill-pay-confirm {
	width: 100%; padding: 13px; border-radius: 10px; border: none;
	font-size: 15px; font-weight: 700; cursor: pointer; letter-spacing: .02em;
	background: linear-gradient(135deg, #059669, #047857); color: #fff;
	transition: opacity .15s; margin-top: 10px;
}
.skill-pay-confirm:hover:not(:disabled) { opacity: .88; }
.skill-pay-confirm:disabled { opacity: .35; cursor: default; }
.skill-pay-status {
	margin-top: 12px; font-size: 13px; min-height: 18px; text-align: center;
	color: rgba(255,255,255,.6);
}
.skill-pay-status.err { color: #f87171; }
.skill-pay-status.ok  { color: #34d399; }
.skill-pay-open-link {
	display: block; text-align: center; margin-top: 14px;
	font-size: 12px; color: rgba(255,255,255,.4); text-decoration: none;
}
.skill-pay-open-link:hover { color: rgba(255,255,255,.7); text-decoration: underline; }
`;

export class SkillPaymentModal {
	/**
	 * @param {ShadowRoot|Document} root  where to inject the modal element
	 * @param {string} agentId            the seller agent's UUID
	 */
	constructor(root, agentId) {
		this._root = root;
		this._agentId = agentId;
		this._resolve = null;
		this._wallet = null;
		this._connection = null;
		this._activePurchase = null;
		this._el = null;
		this._init();
	}

	_init() {
		// Inject <style> and overlay into the shadow/light DOM once.
		const style = document.createElement('style');
		style.textContent = STYLE;
		this._root.appendChild(style);

		const el = document.createElement('div');
		el.className = 'skill-pay-overlay';
		el.setAttribute('hidden', '');
		el.innerHTML = `
			<div class="skill-pay-box" role="dialog" aria-modal="true" aria-labelledby="skill-pay-title-text">
				<div class="skill-pay-head">
					<span class="skill-pay-title" id="skill-pay-title-text">Unlock Skill</span>
					<button class="skill-pay-close" aria-label="Close">×</button>
				</div>
				<p class="skill-pay-skill"></p>
				<p class="skill-pay-desc">This skill requires a one-time payment to unlock.</p>
				<div class="skill-pay-price">
					<span>Total</span>
					<strong></strong>
				</div>
				<div class="skill-pay-wallet-area">
					<button class="skill-pay-btn" id="skill-pay-connect">Connect Phantom</button>
				</div>
				<button class="skill-pay-confirm" disabled>Confirm Purchase</button>
				<div class="skill-pay-status" role="status" aria-live="polite"></div>
				<a class="skill-pay-open-link" target="_blank" rel="noopener">
					Open in marketplace →
				</a>
			</div>
		`;
		this._root.appendChild(el);
		this._el = el;

		el.querySelector('.skill-pay-close').addEventListener('click', () => this._cancel());
		el.addEventListener('click', (e) => { if (e.target === el) this._cancel(); });
		el.querySelector('#skill-pay-connect').addEventListener('click', () => this._connectWallet());
		el.querySelector('.skill-pay-confirm').addEventListener('click', () => this._purchase());
	}

	/**
	 * Show the modal for a payment-required event.
	 * @param {{ skill: string, price?: { amount: string|number, currency_mint: string, chain: string } }} payload
	 * @returns {Promise<boolean>} resolves true if purchased, false if dismissed
	 */
	show(payload) {
		return new Promise((resolve) => {
			this._resolve = resolve;
			this._activePurchase = null;

			const { skill = 'skill', price = {} } = payload;
			const amountUsdc = (Number(price.amount || 0) / 10 ** USDC_DECIMALS).toFixed(2);
			const currency = price.chain === 'solana' ? 'USDC' : price.currency_mint?.slice(0, 8) || 'USDC';

			this._el.querySelector('.skill-pay-skill').textContent = skill;
			this._el.querySelector('.skill-pay-price strong').textContent = `${amountUsdc} ${currency}`;
			this._el.querySelector('.skill-pay-open-link').href =
				`/marketplace/agents/${this._agentId}?buy=${encodeURIComponent(skill)}`;

			this._setStatus('');
			this._el.querySelector('.skill-pay-confirm').disabled = true;
			this._updateWalletArea();
			this._el.removeAttribute('hidden');
		});
	}

	hide() {
		this._el.setAttribute('hidden', '');
	}

	_cancel() {
		this.hide();
		this._resolve?.(false);
		this._resolve = null;
	}

	_setStatus(msg, kind = '') {
		const el = this._el.querySelector('.skill-pay-status');
		el.textContent = msg;
		el.className = 'skill-pay-status' + (kind ? ' ' + kind : '');
	}

	_updateWalletArea() {
		const area = this._el.querySelector('.skill-pay-wallet-area');
		const confirm = this._el.querySelector('.skill-pay-confirm');
		if (this._wallet?.isConnected || window.solana?.isConnected) {
			const pub = (this._wallet?.publicKey || window.solana?.publicKey)?.toBase58?.() || '';
			area.innerHTML = `<div style="font-size:12px;color:rgba(255,255,255,.5);padding:8px 0">
				Connected: <code>${pub.slice(0, 6)}…${pub.slice(-4)}</code>
				<button id="skill-pay-disconnect" style="margin-left:8px;font-size:11px;background:none;border:1px solid rgba(255,255,255,.2);border-radius:6px;color:rgba(255,255,255,.5);cursor:pointer;padding:2px 6px">Disconnect</button>
			</div>`;
			area.querySelector('#skill-pay-disconnect')?.addEventListener('click', () => this._disconnect());
			confirm.disabled = false;
		} else {
			area.innerHTML = `<button class="skill-pay-btn" id="skill-pay-connect">Connect Phantom</button>`;
			area.querySelector('#skill-pay-connect')?.addEventListener('click', () => this._connectWallet());
			confirm.disabled = true;
		}
	}

	async _connectWallet() {
		const btn = this._el.querySelector('#skill-pay-connect');
		if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }
		try {
			// Try injected Phantom wallet first, then wallet adapter
			if (window.solana?.isPhantom || window.solana?.connect) {
				await window.solana.connect();
				this._wallet = window.solana;
			} else {
				this._setStatus('Phantom not detected. Install Phantom wallet to purchase.', 'err');
				if (btn) { btn.textContent = 'Connect Phantom'; btn.disabled = false; }
				return;
			}
			this._setStatus('');
			this._updateWalletArea();
		} catch (e) {
			this._setStatus(e.message || 'Connection failed', 'err');
			if (btn) { btn.textContent = 'Connect Phantom'; btn.disabled = false; }
		}
	}

	_disconnect() {
		this._wallet?.disconnect?.();
		this._wallet = null;
		this._updateWalletArea();
	}

	async _purchase() {
		const confirm = this._el.querySelector('.skill-pay-confirm');
		confirm.disabled = true;

		const skill = this._el.querySelector('.skill-pay-skill').textContent;

		// Step 1: Create pending purchase record
		this._setStatus('Creating purchase…');
		let purchase;
		try {
			const r = await fetch('/api/marketplace/purchase', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ agent_id: this._agentId, skill }),
			});
			const j = await r.json();
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			purchase = j.data;
			if (purchase.already_owned) {
				this._setStatus('✓ Already purchased — access granted.', 'ok');
				await delay(1000);
				this.hide();
				this._resolve?.(true);
				this._resolve = null;
				return;
			}
		} catch (e) {
			this._setStatus(e.message || 'Failed to start purchase', 'err');
			confirm.disabled = false;
			return;
		}

		// Step 2: Build + sign + send the SPL transfer
		this._setStatus('Building transaction…');
		try {
			const { web3, spl } = await loadSolana();
			const { Connection, PublicKey, Transaction } = web3;
			const { getAssociatedTokenAddressSync, createTransferInstruction } = spl;

			if (!this._connection) {
				const rpc = window.__solanaRpc || `${window.location.origin}/api/solana-rpc`;
				this._connection = new Connection(rpc, 'confirmed');
			}

			const payer = this._wallet?.publicKey || window.solana?.publicKey;
			if (!payer) throw new Error('Wallet not connected');

			const payerKey = new PublicKey(payer.toBase58());
			const recipientKey = new PublicKey(purchase.recipient);
			const mintKey = new PublicKey(purchase.currency_mint);
			const referenceKey = new PublicKey(purchase.reference);

			const fromAta = getAssociatedTokenAddressSync(mintKey, payerKey);
			const toAta = getAssociatedTokenAddressSync(mintKey, recipientKey);

			const ix = createTransferInstruction(fromAta, toAta, payerKey, BigInt(purchase.amount));
			ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

			const { blockhash } = await this._connection.getLatestBlockhash('confirmed');
			const tx = new Transaction({ feePayer: payerKey, recentBlockhash: blockhash }).add(ix);

			this._setStatus('Approve in wallet…');
			const wallet = this._wallet || window.solana;
			const txid = await wallet.sendTransaction(tx, this._connection);

			this._setStatus('Waiting for confirmation…');
			await this._connection.confirmTransaction(txid, 'confirmed');

			this._setStatus('Verifying with server…');
			const ok = await this._pollConfirm(purchase.reference);
			if (!ok) throw new Error('Server could not verify the transaction — contact support with tx: ' + txid);

			this._setStatus('✓ Skill unlocked!', 'ok');
			await delay(1200);
			this.hide();
			this._resolve?.(true);
			this._resolve = null;
		} catch (e) {
			this._setStatus(e.message || 'Purchase failed', 'err');
			confirm.disabled = false;
		}
	}

	async _pollConfirm(reference, maxMs = 60_000) {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			const r = await fetch(`/api/marketplace/purchase/${reference}/confirm`, {
				method: 'POST',
				credentials: 'include',
			});
			const j = await r.json().catch(() => ({}));
			if (r.ok && j.data?.status === 'confirmed') return true;
			if (r.status === 409) throw new Error(j.error_description || 'Transfer mismatch');
			await delay(2500);
		}
		return false;
	}

	destroy() {
		this._el?.remove();
		this._el = null;
	}
}

/**
 * PaymentChip — compact inline payment card that renders inside the chat thread.
 * Replaces the blocking SkillPaymentModal overlay with a conversational flow.
 * The agent narrates before/after; the chip handles wallet connection + SPL transfer.
 */
export class PaymentChip {
	/** @param {string} agentId  seller agent UUID */
	constructor(agentId) {
		this._agentId = agentId;
		this._wallet = null;
		this._connection = null;
	}

	/**
	 * Inject a payment chip into chatEl and return a promise that resolves
	 * true (purchased) or false (dismissed / failed).
	 * @param {Element} chatEl
	 * @param {{ skill: string, price?: { amount: string|number, currency_mint: string, chain: string } }} payload
	 * @returns {Promise<boolean>}
	 */
	show(chatEl, payload) {
		return new Promise((resolve) => {
			const { skill = 'skill', price = {} } = payload;
			const amountUsdc = (Number(price.amount || 0) / 10 ** USDC_DECIMALS).toFixed(2);
			const currency = price.chain === 'solana' ? 'USDC' : (price.currency_mint?.slice(0, 8) || 'USDC');

			const wrapper = document.createElement('div');
			wrapper.className = 'msg';
			wrapper.innerHTML = `
				<div class="role">agent</div>
				<div class="body">
					<div class="pay-chip">
						<div class="pay-chip-head">
							<span class="pay-chip-label">Payment required</span>
						</div>
						<div class="pay-chip-skill">${skill}</div>
						<div class="pay-chip-price">${amountUsdc} ${currency}</div>
						<div class="pay-chip-actions"></div>
						<div class="pay-chip-status"></div>
					</div>
				</div>
			`;

			const setStatus = (msg, kind = '') => {
				const el = wrapper.querySelector('.pay-chip-status');
				el.textContent = msg;
				el.className = 'pay-chip-status' + (kind ? ' ' + kind : '');
			};

			const dismiss = (result) => {
				wrapper.remove();
				resolve(result);
			};

			const updateActions = () => {
				const actions = wrapper.querySelector('.pay-chip-actions');
				const connected = this._wallet?.isConnected || window.solana?.isConnected;
				if (connected) {
					actions.innerHTML = `
						<button class="pay-chip-btn pay-chip-btn-pay">Pay ${amountUsdc} ${currency}</button>
						<button class="pay-chip-btn pay-chip-btn-cancel">Cancel</button>
					`;
					actions.querySelector('.pay-chip-btn-pay').addEventListener('click', () => runPurchase());
				} else {
					actions.innerHTML = `
						<button class="pay-chip-btn pay-chip-btn-connect">Connect Phantom</button>
						<button class="pay-chip-btn pay-chip-btn-cancel">Dismiss</button>
					`;
					actions.querySelector('.pay-chip-btn-connect').addEventListener('click', () => connectWallet());
				}
				actions.querySelector('.pay-chip-btn-cancel').addEventListener('click', () => dismiss(false));
			};

			const connectWallet = async () => {
				setStatus('Connecting…');
				try {
					if (window.solana?.isPhantom || window.solana?.connect) {
						await window.solana.connect();
						this._wallet = window.solana;
						setStatus('');
						updateActions();
					} else {
						setStatus('Phantom not detected. Install Phantom to pay.', 'err');
					}
				} catch (e) {
					setStatus(e.message || 'Connection failed', 'err');
				}
			};

			const runPurchase = async () => {
				const payBtn = wrapper.querySelector('.pay-chip-btn-pay');
				if (payBtn) payBtn.disabled = true;

				setStatus('Creating purchase…');
				let purch;
				try {
					const r = await fetch('/api/marketplace/purchase', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({ agent_id: this._agentId, skill }),
					});
					const j = await r.json();
					if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
					purch = j.data;
					if (purch.already_owned) {
						setStatus('Already purchased.', 'ok');
						await delay(800);
						dismiss(true);
						return;
					}
				} catch (e) {
					setStatus(e.message || 'Failed to start purchase', 'err');
					if (payBtn) payBtn.disabled = false;
					return;
				}

				setStatus('Building transaction…');
				try {
					const { web3, spl } = await loadSolana();
					const { Connection, PublicKey, Transaction } = web3;
					const { getAssociatedTokenAddressSync, createTransferInstruction } = spl;

					if (!this._connection) {
						const rpc = window.__solanaRpc || `${window.location.origin}/api/solana-rpc`;
						this._connection = new Connection(rpc, 'confirmed');
					}

					const payer = this._wallet?.publicKey || window.solana?.publicKey;
					if (!payer) throw new Error('Wallet not connected');

					const payerKey = new PublicKey(payer.toBase58());
					const recipientKey = new PublicKey(purch.recipient);
					const mintKey = new PublicKey(purch.currency_mint);
					const referenceKey = new PublicKey(purch.reference);

					const fromAta = getAssociatedTokenAddressSync(mintKey, payerKey);
					const toAta = getAssociatedTokenAddressSync(mintKey, recipientKey);

					const ix = createTransferInstruction(fromAta, toAta, payerKey, BigInt(purch.amount));
					ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

					const { blockhash } = await this._connection.getLatestBlockhash('confirmed');
					const tx = new Transaction({ feePayer: payerKey, recentBlockhash: blockhash }).add(ix);

					setStatus('Approve in Phantom…');
					const wallet = this._wallet || window.solana;
					const txid = await wallet.sendTransaction(tx, this._connection);

					setStatus('Confirming…');
					await this._connection.confirmTransaction(txid, 'confirmed');

					setStatus('Verifying…');
					const ok = await this._pollConfirm(purch.reference);
					if (!ok) throw new Error('Verification failed — contact support. tx: ' + txid);

					setStatus('Unlocked!', 'ok');
					await delay(900);
					dismiss(true);
				} catch (e) {
					setStatus(e.message || 'Purchase failed', 'err');
					if (payBtn) payBtn.disabled = false;
				}
			};

			updateActions();
			chatEl.appendChild(wrapper);
			chatEl.scrollTop = chatEl.scrollHeight;
		});
	}

	async _pollConfirm(reference, maxMs = 60_000) {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			const r = await fetch(`/api/marketplace/purchase/${reference}/confirm`, {
				method: 'POST',
				credentials: 'include',
			});
			const j = await r.json().catch(() => ({}));
			if (r.ok && j.data?.status === 'confirmed') return true;
			if (r.status === 409) throw new Error(j.error_description || 'Transfer mismatch');
			await delay(2500);
		}
		return false;
	}
}

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
