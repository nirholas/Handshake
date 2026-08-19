/**
 * Launch Token Modal — pump.fun token launch flow.
 *
 * Steps: 1) details form  2) quote + bonding curve  3) wallet sign  4) success
 *
 * Usage:
 *   import { openLaunchTokenModal } from './launch-token-modal.js';
 *   openLaunchTokenModal({ agentId, agentName, imageUrl });
 */

import { mountLaunchBondingCurve } from './bonding-curve-chart.js';
import { log } from '../shared/log.js';
import { ensureRiskAck } from '../shared/risk-ack.js';
import { THREE_WS_MARK } from '../solana/vanity/brand.js';

const _isDev =
	typeof location !== 'undefined' &&
	(location.hostname === 'localhost' || location.hostname === '127.0.0.1');

function _esc(s) {
	return String(s ?? '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
	);
}

function _nameToSymbol(name) {
	const words = String(name || '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const raw =
		words.length === 1
			? words[0].slice(0, 5)
			: words.map((w) => w[0] || '').join('').slice(0, 5);
	return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'AGENT';
}

function _solFmt(v) {
	if (v == null) return '—';
	const n = Number(v);
	return `${n >= 10 ? n.toFixed(3) : n.toFixed(4)} SOL`;
}

function _apiError(status, data) {
	const code = data?.error || '';
	const desc = data?.error_description || '';
	const lc = `${code} ${desc}`.toLowerCase();
	if (status === 429 || code === 'rate_limited')
		return 'Too many launch attempts, try again tomorrow';
	if (status === 404 || code === 'not_found') return null; // caller should close
	if (
		status === 403 ||
		code === 'forbidden' ||
		code === 'wallet_mismatch' ||
		lc.includes('wallet')
	)
		return 'Wrong wallet — connect the wallet that owns this agent';
	if (code === 'insufficient_funds' || lc.includes('insufficient'))
		return 'Not enough SOL in this wallet to cover the launch. Add SOL and try again.';
	if (status === 401 || code === 'unauthorized')
		return 'Sign in to three.ws with this wallet, then launch again.';
	if (status >= 500)
		return 'three.ws had a problem preparing the launch. Try again in a moment.';
	return desc || `Request failed (${status})`;
}

/**
 * Map a Solana broadcast / send-transaction failure to copy a user can act on.
 * The RPC layer surfaces program errors ("custom program error: 0x1"),
 * preflight failures, expiry, and transport errors — each needs a different
 * next step, so a single "Connection error" catch-all is never enough.
 * @param {unknown} err
 */
function _broadcastError(err) {
	const raw = (err && (err.message || String(err))) || '';
	const m = raw.toLowerCase();
	if (/reject|denied|cancell?ed|user declined/.test(m))
		return 'You cancelled the transaction in your wallet.';
	if (/insufficient (lamports|funds)|custom program error: 0x1\b|debit an account/.test(m))
		return 'Not enough SOL to cover the launch + network fees. Add SOL and try again.';
	if (/slippage|0x1771|exceeds desired|too little|price moved/.test(m))
		return 'The price moved beyond your limit (slippage). Try again.';
	if (/blockhash not found|block height exceeded|expired|too old/.test(m))
		return 'The network was busy and the transaction expired. Try again.';
	if (/failed to fetch|networkerror|load failed|timed out|timeout|fetch failed|503|502|429/.test(m))
		return "Couldn't reach the Solana network. Check your connection and try again.";
	const short = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
	return short
		? `Solana rejected the transaction: ${short}`
		: 'Solana rejected the transaction. Try again.';
}

export class LaunchTokenModal {
	/**
	 * @param {{
	 *   agentId: string,
	 *   agentName?: string,
	 *   imageUrl?: string,
	 *   needsDeploy?: boolean,
	 *   agentForDeploy?: { id: string, name: string, description?: string, avatar_id?: string|null, skills?: string[] }|null,
	 * }} opts
	 */
	constructor({
		agentId,
		agentName = 'Agent',
		imageUrl = '',
		needsDeploy = false,
		agentForDeploy = null,
	}) {
		this.agentId = agentId;
		this._d = {
			name: String(agentName).slice(0, 32),
			symbol: _nameToSymbol(agentName),
			description: '',
			image: String(imageUrl),
			website: '',
			twitter: '',
			telegram: '',
			initialBuySol: 0,
			cluster: 'mainnet',
		};
		this._needsDeploy = !!needsDeploy;
		this._agentForDeploy = agentForDeploy;
		// Step 0 = deploy-on-chain (only when needsDeploy is true).
		// Step 1..4 = the normal launch flow.
		this._step = needsDeploy ? 0 : 1;
		this._overlay = null;
		this._chart = null;
		this._keyHandler = null;
		this._prevActive = null;
		this._solPriceUsd = null;
		this._deployBusy = false;
	}

	async _fetchSolPrice() {
		try {
			const r = await fetch(
				'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
			);
			if (r.ok) {
				const data = await r.json();
				this._solPriceUsd = data?.solana?.usd || null;
				// If modal is open on step 1, re-render to show price hints
				if (this._overlay && this._step === 1) {
					this._renderStep1();
				}
			}
		} catch (e) {
			log.warn('Could not fetch SOL price', e);
		}
	}

	_injectCss() {
		if (document.getElementById('ltm-styles')) return;
		const style = document.createElement('style');
		style.id = 'ltm-styles';
		style.textContent = `
			.ltm-input-wrap { position: relative; display: flex; }
			.ltm-input-wrap .ltm-input { flex-grow: 1; }
			.ltm-input-adornment {
				position: absolute;
				right: 12px;
				top: 50%;
				transform: translateY(-50%);
				color: var(--muted, #888);
				font-size: 13px;
				pointer-events: none;
			}
		`;
		document.head.appendChild(style);
	}

	_solFmtWithUsd(solAmount) {
		if (solAmount == null) return '—';
		const n = Number(solAmount);
		let text = `${n >= 10 ? n.toFixed(3) : n.toFixed(4)} SOL`;
		if (this._solPriceUsd) {
			const usd = (n * this._solPriceUsd).toFixed(2);
			text += ` (~$${usd})`;
		}
		return text;
	}

	open() {
		if (this._overlay) return;
		this._prevActive =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this._injectCss();
		this._fetchSolPrice();

		const el = document.createElement('div');
		el.className = 'ltm-overlay';
		document.body.appendChild(el);
		this._overlay = el;
		el.addEventListener('click', (e) => {
			if (e.target === el) this._close();
		});
		// Focus trap: Escape closes; Tab/Shift+Tab cycle within the dialog so
		// keyboard and screen-reader users can't tab out behind the overlay.
		this._keyHandler = (e) => {
			if (e.key === 'Escape') { this._close(); return; }
			if (e.key !== 'Tab') return;
			const items = this._focusable();
			if (items.length === 0) return;
			const first = items[0], last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !el.contains(active))) {
				e.preventDefault(); last.focus();
			} else if (!e.shiftKey && (active === last || !el.contains(active))) {
				e.preventDefault(); first.focus();
			}
		};
		window.addEventListener('keydown', this._keyHandler);
		requestAnimationFrame(() => el.classList.add('ltm-open'));
		if (this._needsDeploy) this._renderStep0();
		else this._renderStep1();
		this._focusInitial();
	}

	/** All focusable controls inside the dialog, in DOM order. */
	_focusable() {
		if (!this._overlay) return [];
		return Array.from(
			this._overlay.querySelectorAll(
				'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
	}

	/** Move focus into the dialog on open — close button, else first control. */
	_focusInitial() {
		const close = this._overlay?.querySelector('.ltm-close');
		const target = close || this._focusable()[0];
		target?.focus();
	}

	_close() {
		if (this._chart) {
			this._chart.destroy();
			this._chart = null;
		}
		if (this._copilot) {
			this._copilot.destroy();
			this._copilot = null;
		}
		if (!this._overlay) return;
		this._overlay.classList.remove('ltm-open');
		const el = this._overlay;
		this._overlay = null;
		setTimeout(() => el.remove(), 200);
		if (this._keyHandler) {
			window.removeEventListener('keydown', this._keyHandler);
			this._keyHandler = null;
		}
		if (this._prevActive && this._prevActive.isConnected) {
			this._prevActive.focus();
		}
		this._prevActive = null;
	}

	_stepDots() {
		const steps = this._needsDeploy ? [0, 1, 2, 3, 4] : [1, 2, 3, 4];
		return steps
			.map(
				(i) =>
					`<div class="ltm-step-dot ${this._step === i ? 'active' : this._step > i ? 'done' : ''}"></div>`,
			)
			.join('');
	}

	_shell(title, body, footer) {
		return `
		<div class="ltm-modal" role="dialog" aria-modal="true" aria-label="Launch Agent Token">
			<div class="ltm-header">
				<span class="ltm-title">${_esc(title)}</span>
				<div class="ltm-header-right">
					<div class="ltm-steps">${this._stepDots()}</div>
					<button class="ltm-close" aria-label="Close modal">×</button>
				</div>
			</div>
			<div class="ltm-body">${body}</div>
			<div class="ltm-footer">${footer}</div>
		</div>`;
	}

	_paint(html) {
		if (this._chart) {
			this._chart.destroy();
			this._chart = null;
		}
		if (!this._overlay) return;
		this._overlay.innerHTML = html;
		this._overlay.querySelector('.ltm-close')?.addEventListener('click', () => this._close());
	}

	// ── Step 0 — Deploy agent on Solana (only when needsDeploy) ───────────────

	_renderStep0() {
		this._step = 0;
		this._paint(
			this._shell(
				'Launch Token — Deploy Agent',
				`<div class="ltm-deploy-intro">
					<div class="ltm-deploy-title">Deploy your agent on Solana first</div>
					<div class="ltm-deploy-sub">
						Pump.fun tokens are tied to the agent's on-chain identity. We'll mint
						a Metaplex Core asset to your wallet — that asset becomes the agent's
						permanent on-chain record. The same wallet then launches the token.
					</div>
					<ul class="ltm-deploy-bullets">
						<li>You'll sign <strong>2 transactions</strong>: one to deploy, one to launch.</li>
						<li>Both use the same Solana wallet.</li>
						<li>Deploy cost is ~0.003 SOL of rent + network fees.</li>
					</ul>
				</div>
				<div class="ltm-status-msg" id="ltm-deploy-msg"></div>`,
				`<button class="ltm-btn btn btn--secondary" id="ltm-s0-cancel">Cancel</button>
				<button class="ltm-btn ltm-btn-primary btn btn--primary" id="ltm-s0-deploy">Deploy on Solana →</button>`,
			),
		);

		this._overlay.querySelector('#ltm-s0-cancel').addEventListener('click', () => this._close());
		this._overlay
			.querySelector('#ltm-s0-deploy')
			.addEventListener('click', () => this._runDeploy());
	}

	async _runDeploy() {
		if (this._deployBusy) return;
		const btn = this._overlay.querySelector('#ltm-s0-deploy');
		const cancel = this._overlay.querySelector('#ltm-s0-cancel');
		const setMsg = (text, err = false) => {
			const el = this._overlay?.querySelector('#ltm-deploy-msg');
			if (!el) return;
			el.textContent = text;
			el.className = `ltm-status-msg${err ? ' ltm-err' : ''}`;
		};

		if (!this._agentForDeploy?.id) {
			setMsg('Missing agent context — please reload and try again.', true);
			return;
		}

		this._deployBusy = true;
		btn.disabled = true;
		cancel.disabled = true;

		const labels = {
			connect: 'Connecting Solana wallet…',
			prep: 'Preparing on-chain manifest…',
			sign: 'Sign the deploy transaction in your wallet…',
			confirm: 'Confirming on Solana…',
			save: 'Linking agent to wallet…',
		};

		try {
			const [{ deployAgent }, { solana }] = await Promise.all([
				import('../onchain/deploy.js'),
				import('../onchain/chain-ref.js'),
			]);

			const ref = solana(this._d.cluster === 'devnet' ? 'devnet' : 'mainnet');

			setMsg(labels.connect);
			await deployAgent({
				agent: this._agentForDeploy,
				ref,
				onProgress: (step) => {
					const text = labels[step] || step;
					setMsg(text);
					btn.textContent = text;
				},
			});

			this._needsDeploy = false;
			setMsg('Deployed. Continuing to token details…');
			// Brief pause so user sees the success state before advancing.
			setTimeout(() => {
				if (!this._overlay) return;
				this._renderStep1();
			}, 400);
		} catch (err) {
			// Re-import to avoid an extra round trip in the happy path.
			const { isUserRejection } = await import('../onchain/adapters/index.js');
			if (isUserRejection(err)) {
				setMsg('Deploy cancelled. Click Deploy on Solana to try again.', true);
				btn.textContent = 'Deploy on Solana →';
				btn.disabled = false;
				cancel.disabled = false;
				this._deployBusy = false;
				return;
			}
			if (err?.code === 'NO_PROVIDER') {
				const url = err.installUrl || 'https://phantom.app';
				setMsg(`No Solana wallet detected. Install Phantom: ${url}`, true);
			} else {
				const msg = err?.message || 'Deploy failed — please try again.';
				setMsg(msg, true);
			}
			btn.textContent = 'Retry deploy';
			btn.disabled = false;
			cancel.disabled = false;
			this._deployBusy = false;
		}
	}

	// ── Live preview card (step 1) ────────────────────────────────────────────

	/** A live pump.fun-style coin card that mirrors the form as the user types. */
	_previewCardHtml() {
		const d = this._d;
		const initials = (d.symbol || d.name || 'A').slice(0, 3).toUpperCase();
		const img = d.image
			? `<img loading="lazy" decoding="async" class="ltm-pc-img" src="${_esc(d.image)}" alt="" data-fallback="sibling">
				<div class="ltm-pc-fallback" style="display:none">${_esc(initials)}</div>`
			: `<div class="ltm-pc-fallback">${_esc(initials)}</div>`;
		return `
		<div class="ltm-preview-card" id="ltm-preview">
			<div class="ltm-pc-media">${img}</div>
			<div class="ltm-pc-meta">
				<div class="ltm-pc-name" id="ltm-pc-name">${_esc(d.name || 'Your token')}</div>
				<div class="ltm-pc-sym" id="ltm-pc-sym">$${_esc(d.symbol || 'SYMBOL')}</div>
				<div class="ltm-pc-mark" title="Every three.ws launch mints an address starting with “${_esc(THREE_WS_MARK)}”.">
					<span class="ltm-pc-mark-chip">${_esc(THREE_WS_MARK)}…</span>
					<span class="ltm-pc-mark-label">on-chain mark</span>
				</div>
			</div>
		</div>`;
	}

	/** Refresh the preview card in place from the current field values. */
	_updatePreview({ name, symbol, image } = {}) {
		const ov = this._overlay;
		if (!ov) return;
		const nameEl = ov.querySelector('#ltm-pc-name');
		const symEl = ov.querySelector('#ltm-pc-sym');
		if (nameEl && name != null) nameEl.textContent = name || 'Your token';
		if (symEl && symbol != null) symEl.textContent = `$${symbol || 'SYMBOL'}`;
		if (image != null) {
			const media = ov.querySelector('#ltm-preview .ltm-pc-media');
			if (media) {
				const initials = (symbol || name || 'A').slice(0, 3).toUpperCase();
				media.innerHTML = image
					? `<img loading="lazy" decoding="async" class="ltm-pc-img" src="${_esc(image)}" alt="" data-fallback="sibling">
						<div class="ltm-pc-fallback" style="display:none">${_esc(initials)}</div>`
					: `<div class="ltm-pc-fallback">${_esc(initials)}</div>`;
			}
		}
	}

	// ── Step 1 — Token details ────────────────────────────────────────────────

	_renderStep1() {
		this._step = 1;
		const d = this._d;
		const netToggle = _isDev
			? `<div class="ltm-net-row">
				<span>Network:</span>
				<div class="ltm-toggle">
					<button class="ltm-toggle-btn${d.cluster === 'mainnet' ? ' active' : ''}" data-net="mainnet">Mainnet</button>
					<button class="ltm-toggle-btn${d.cluster === 'devnet' ? ' active' : ''}" data-net="devnet">Devnet</button>
				</div>
			</div>`
			: '';

		this._paint(
			this._shell(
				'Launch Token — Details',
				`${this._previewCardHtml()}
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-name">
						Token name <span class="ltm-hint">max 32 chars</span>
					</label>
					<input class="ltm-input" id="ltm-name" maxlength="32"
						value="${_esc(d.name)}" autocomplete="off">
				</div>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-sym">
						Symbol <span class="ltm-hint">2–10 alphanumeric</span>
					</label>
					<input class="ltm-input" id="ltm-sym" maxlength="10"
						value="${_esc(d.symbol)}" autocomplete="off">
					<span class="ltm-field-err" id="ltm-sym-err"></span>
				</div>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-desc">
						Description <span class="ltm-hint">optional, max 280</span>
					</label>
					<textarea class="ltm-textarea" id="ltm-desc"
						maxlength="280" rows="2">${_esc(d.description)}</textarea>
				</div>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-img">
						Image URL <span class="ltm-hint">optional</span>
					</label>
					<input class="ltm-input" id="ltm-img"
						value="${_esc(d.image)}" autocomplete="off" placeholder="https://…">
				</div>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-web">
						Website <span class="ltm-hint">optional — defaults to your three.ws agent page</span>
					</label>
					<input class="ltm-input" id="ltm-web" type="url"
						value="${_esc(d.website)}" autocomplete="off" placeholder="https://three.ws/agents/…">
				</div>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-tw">
						X / Twitter <span class="ltm-hint">optional — defaults to @trythreews</span>
					</label>
					<input class="ltm-input" id="ltm-tw" type="url"
						value="${_esc(d.twitter)}" autocomplete="off" placeholder="https://x.com/…">
				</div>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-tg">
						Telegram <span class="ltm-hint">optional</span>
					</label>
					<input class="ltm-input" id="ltm-tg" type="url"
						value="${_esc(d.telegram)}" autocomplete="off" placeholder="https://t.me/…">
				</div>
				<p class="ltm-brand-note">Every launch links back to three.ws and the $THREE coin in its on-chain metadata.</p>
				<div class="ltm-field">
					<label class="ltm-label" for="ltm-buy">
						Dev buy <span class="ltm-hint">optional, 0–50 SOL</span>
					</label>
					<div class="ltm-input-wrap">
						<input class="ltm-input" type="number" id="ltm-buy"
							min="0" max="50" step="0.1" value="${d.initialBuySol}">
						<span class="ltm-input-adornment" id="ltm-buy-usd"></span>
					</div>
				</div>
				${netToggle}`,
				`<div></div>
				<button class="ltm-btn ltm-btn-primary btn btn--primary" id="ltm-s1-next">Preview →</button>`,
			),
		);

		const nameInput = this._overlay.querySelector('#ltm-name');
		const symInput = this._overlay.querySelector('#ltm-sym');
		const symErr = this._overlay.querySelector('#ltm-sym-err');
		const buyInput = this._overlay.querySelector('#ltm-buy');
		const buyUsd = this._overlay.querySelector('#ltm-buy-usd');
		let symTouched = d.symbol !== _nameToSymbol(d.name);

		const updateBuyUsd = () => {
			if (!this._solPriceUsd || !buyUsd) return;
			const sol = parseFloat(buyInput.value) || 0;
			const usd = (sol * this._solPriceUsd).toFixed(2);
			buyUsd.textContent = `~ $${usd}`;
		};

		if (buyInput) {
			buyInput.addEventListener('input', updateBuyUsd);
			updateBuyUsd();
		}

		const imgInput = this._overlay.querySelector('#ltm-img');

		nameInput.addEventListener('input', () => {
			if (!symTouched) symInput.value = _nameToSymbol(nameInput.value);
			this._updatePreview({ name: nameInput.value.trim(), symbol: symInput.value });
		});
		symInput.addEventListener('input', () => {
			symInput.value = symInput.value.toUpperCase();
			symTouched = true;
			symErr.textContent = '';
			symInput.classList.remove('ltm-err');
			this._updatePreview({ symbol: symInput.value, name: nameInput.value.trim() });
		});
		if (imgInput) {
			imgInput.addEventListener('input', () =>
				this._updatePreview({
					image: imgInput.value.trim(),
					name: nameInput.value.trim(),
					symbol: symInput.value,
				}),
			);
		}

		this._overlay.querySelectorAll('[data-net]').forEach((btn) => {
			btn.addEventListener('click', () => {
				this._d.cluster = btn.dataset.net;
				this._overlay
					.querySelectorAll('[data-net]')
					.forEach((b) => b.classList.toggle('active', b === btn));
			});
		});

		this._overlay.querySelector('#ltm-s1-next').addEventListener('click', () => {
			const name = nameInput.value.trim();
			const symbol = symInput.value.toUpperCase().trim();

			if (!name) {
				nameInput.classList.add('ltm-err');
				nameInput.focus();
				return;
			}
			nameInput.classList.remove('ltm-err');

			if (!/^[A-Za-z0-9]{2,10}$/.test(symbol)) {
				symInput.classList.add('ltm-err');
				symErr.textContent = 'Must be 2–10 alphanumeric characters (A-Z, 0-9)';
				symInput.focus();
				return;
			}
			symInput.classList.remove('ltm-err');
			symErr.textContent = '';

			this._d.name = name;
			this._d.symbol = symbol;
			this._d.description = this._overlay.querySelector('#ltm-desc').value.trim();
			this._d.image = this._overlay.querySelector('#ltm-img').value.trim();
			this._d.website = this._overlay.querySelector('#ltm-web').value.trim();
			this._d.twitter = this._overlay.querySelector('#ltm-tw').value.trim();
			this._d.telegram = this._overlay.querySelector('#ltm-tg').value.trim();
			this._d.initialBuySol = Math.min(
				50,
				Math.max(0, parseFloat(this._overlay.querySelector('#ltm-buy').value) || 0),
			);

			this._renderStep2();
		});
	}

	// ── Step 2 — Preview quote + bonding curve ────────────────────────────────

	async _renderStep2() {
		this._step = 2;

		this._paint(
			this._shell(
				'Launch Token — Preview',
				`<div class="ltm-chart-title">Bonding curve (price vs supply)</div>
				<div class="ltm-chart-wrap" id="ltm-chart"></div>
				<div id="ltm-quote" class="ltm-quote-block">
					<div class="ltm-status-msg">
						<span class="ltm-spinner"></span>Fetching quote…
					</div>
				</div>`,
				`<button class="ltm-btn btn btn--secondary" id="ltm-s2-back">← Back</button>
				<button class="ltm-btn ltm-btn-primary btn btn--primary" id="ltm-s2-next" disabled>Continue →</button>`,
			),
		);

		const chartEl = this._overlay.querySelector('#ltm-chart');
		if (chartEl) this._chart = mountLaunchBondingCurve(chartEl);

		this._overlay.querySelector('#ltm-s2-back').addEventListener('click', () => this._renderStep1());

		try {
			const qs = new URLSearchParams({
				initial_buy_sol: String(this._d.initialBuySol),
				cluster: this._d.cluster,
			});
			const resp = await fetch(`/api/agents/tokens/launch-quote?${qs}`, {
				credentials: 'include',
			});
			const data = await resp.json();

			if (!resp.ok) {
				if (resp.status === 404) { this._close(); return; }
				const msg = _apiError(resp.status, data) || 'Request failed';
				this._overlay.querySelector('#ltm-quote').innerHTML =
					`<div class="ltm-status-msg ltm-err">${_esc(msg)}</div>`;
				return;
			}

			const rows = [['Fixed costs (rent + fees)', this._solFmtWithUsd(data.fixed_total_sol)]];
			if (data.initial_buy && data.initial_buy.sol > 0) {
				rows.push(['Dev buy', this._solFmtWithUsd(data.initial_buy.sol)]);
				if (data.initial_buy.protocol_fee_sol > 0)
					rows.push(['Protocol fee (~1%)', this._solFmtWithUsd(data.initial_buy.protocol_fee_sol)]);
				if (data.initial_buy.tokens_out) {
					const n = Number(data.initial_buy.tokens_out).toLocaleString();
					rows.push([`Tokens you receive`, `${n} ${this._d.symbol}`]);
				}
			}
			rows.push(['Total SOL needed', this._solFmtWithUsd(data.total_sol)]);

			this._overlay.querySelector('#ltm-quote').innerHTML = rows
				.map(
					([label, val], i) =>
						`<div class="ltm-quote-row">
							<span class="ltm-q-label">${_esc(label)}</span>
							<span class="ltm-q-val${i === rows.length - 1 ? ' ltm-total' : ''}">${_esc(val)}</span>
						</div>`,
				)
				.join('');

			const nextBtn = this._overlay.querySelector('#ltm-s2-next');
			nextBtn.disabled = false;
			nextBtn.addEventListener('click', () => this._renderStep3());
		} catch {
			if (!this._overlay) return;
			this._overlay.querySelector('#ltm-quote').innerHTML =
				`<div class="ltm-status-msg ltm-err">Couldn't reach three.ws to price the launch. Check your connection and retry.</div>`;
		}
	}

	// ── Step 3 — Connect wallet & sign ────────────────────────────────────────

	_renderStep3() {
		this._step = 3;

		this._paint(
			this._shell(
				'Launch Token — Sign',
				`<div class="ltm-wallet-row">
					<div class="ltm-wallet-info">
						<div class="ltm-wallet-status disconnected" id="ltm-ws">Wallet not connected</div>
						<div class="ltm-wallet-addr" id="ltm-wa"></div>
					</div>
					<button class="ltm-btn btn btn--secondary" id="ltm-connect">Connect Wallet</button>
				</div>
				<div class="ltm-status-msg" id="ltm-msg"></div>`,
				`<button class="ltm-btn btn btn--secondary" id="ltm-s3-back">← Back</button>
				<button class="ltm-btn ltm-btn-primary btn btn--primary" id="ltm-launch" disabled>Sign &amp; Launch</button>`,
			),
		);

		this._overlay.querySelector('#ltm-s3-back').addEventListener('click', () => this._renderStep2());

		const connectBtn = this._overlay.querySelector('#ltm-connect');
		const launchBtn = this._overlay.querySelector('#ltm-launch');
		let walletAddr = null;

		const _setConnected = (addr) => {
			walletAddr = addr;
			const ws = this._overlay.querySelector('#ltm-ws');
			const wa = this._overlay.querySelector('#ltm-wa');
			if (ws) { ws.textContent = 'Connected'; ws.className = 'ltm-wallet-status connected'; }
			if (wa) wa.textContent = `${addr.slice(0, 4)}…${addr.slice(-4)}`;
			connectBtn.style.display = 'none';
			launchBtn.disabled = false;
		};

		const sol = window.solana ?? window.phantom?.solana ?? window.backpack ?? window.solflare;
		if (sol?.isConnected && sol?.publicKey) {
			_setConnected(sol.publicKey.toString());
		}

		connectBtn.addEventListener('click', async () => {
			if (!sol) {
				this._msg('No Solana wallet detected. Install Phantom or Backpack.', true);
				return;
			}
			connectBtn.disabled = true;
			connectBtn.textContent = 'Connecting…';
			try {
				await sol.connect();
				_setConnected(sol.publicKey.toString());
			} catch {
				connectBtn.disabled = false;
				connectBtn.textContent = 'Connect Wallet';
				this._msg('Wallet connection cancelled.', true);
			}
		});

		launchBtn.addEventListener('click', () => this._doLaunch(walletAddr));
	}

	// ── Launch: prep → sign → broadcast → confirm ─────────────────────────────

	async _doLaunch(walletAddress) {
		// Launching costs real SOL (fees + optional dev buy) on mainnet.
		if (this._d.cluster !== 'devnet' && !(await ensureRiskAck({ context: 'launch' }))) return;
		const launchBtn = this._overlay.querySelector('#ltm-launch');
		const backBtn = this._overlay.querySelector('#ltm-s3-back');
		launchBtn.disabled = true;
		backBtn.disabled = true;

		const reset = () => {
			if (!this._overlay) return;
			if (launchBtn) launchBtn.disabled = false;
			if (backBtn) backBtn.disabled = false;
		};

		try {
			this._msg('Preparing transaction…');
			const prepResp = await fetch('/api/agents/tokens/launch-prep', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agent_id: this.agentId,
					provider: 'pumpfun',
					cluster: this._d.cluster,
					wallet_address: walletAddress,
					name: this._d.name,
					symbol: this._d.symbol,
					description: this._d.description,
					image: this._d.image,
					website: this._d.website,
					twitter: this._d.twitter,
					telegram: this._d.telegram,
					initial_buy_sol: this._d.initialBuySol,
				}),
			});
			const prep = await prepResp.json();

			if (!prepResp.ok) {
				if (prepResp.status === 404) { this._close(); return; }
				const msg = _apiError(prepResp.status, prep) || 'Preparation failed';
				this._msg(msg, true);
				reset();
				return;
			}

			this._msg('Sign transaction in your wallet…');
			const sol = window.solana ?? window.phantom?.solana ?? window.backpack ?? window.solflare;
			const { Transaction } = await import('@solana/web3.js');
			const txBytes = Uint8Array.from(atob(prep.tx_base64), (c) => c.charCodeAt(0));
			const tx = Transaction.from(txBytes);

			let signed;
			try {
				signed = await sol.signTransaction(tx);
			} catch (e) {
				const m = (e?.message || String(e)).toLowerCase();
				this._msg(
					/reject|denied|cancell?ed|user declined/.test(m)
						? 'You cancelled the signature in your wallet.'
						: 'Your wallet could not sign the transaction. Reconnect and try again.',
					true,
				);
				reset();
				return;
			}

			this._msg('Broadcasting to Solana…');
			const { Connection } = await import('@solana/web3.js');
			// Route via same-origin proxy — public mainnet RPC 403s most browsers.
			const rpcOrigin = window.location?.origin || 'https://three.ws';
			const rpcUrl = `${rpcOrigin}/api/solana-rpc${prep.cluster === 'devnet' ? '?net=devnet' : ''}`;
			const conn = new Connection(rpcUrl, 'confirmed');

			let signature;
			try {
				signature = await conn.sendRawTransaction(signed.serialize(), {
					skipPreflight: false,
					preflightCommitment: 'confirmed',
				});
			} catch (e) {
				this._msg(_broadcastError(e), true);
				reset();
				return;
			}

			this._msg('Confirming on-chain…');
			const confirmResp = await fetch('/api/agents/tokens/launch-confirm', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					prep_id: prep.prep_id,
					tx_signature: signature,
					wallet_address: walletAddress,
				}),
			});
			const confirmed = await confirmResp.json();

			if (!confirmResp.ok) {
				const msg = _apiError(confirmResp.status, confirmed) || 'Confirmation failed';
				this._msg(msg, true);
				reset();
				return;
			}

			const mint = confirmed.agent?.token?.mint || prep.mint;
			const pumpUrl =
				prep.cluster === 'mainnet' ? `https://pump.fun/coin/${mint}` : null;
			this._renderStep4(mint, pumpUrl, this.agentId);
		} catch {
			// Reaches here only on a transport failure of the prep/confirm fetches
			// (the sign + broadcast paths have their own mapped catches above).
			this._msg("Couldn't reach three.ws to finish the launch. Check your connection and try again.", true);
			reset();
		}
	}

	// ── Step 4 — Success ──────────────────────────────────────────────────────

	_renderStep4(mint, pumpUrl, agentId) {
		this._step = 4;
		const isMainnet = this._d.cluster !== 'devnet';
		const coin3dUrl = `/coin3d?mint=${encodeURIComponent(mint)}`;
		const dashboardUrl = agentId
			? `/pump-dashboard?agent=${encodeURIComponent(agentId)}`
			: '/pump-dashboard';
		const ctaRow = isMainnet
			? `<div class="ltm-cta-row">
					<a class="ltm-btn ltm-btn-primary" id="ltm-view-3d" href="${_esc(coin3dUrl)}" target="_blank" rel="noopener noreferrer">View in 3D</a>
					<button class="ltm-btn" id="ltm-manage">Manage on Dashboard</button>
					${pumpUrl ? `<a class="ltm-btn" id="ltm-pumpfun" href="${_esc(pumpUrl)}" target="_blank" rel="noopener noreferrer">View on pump.fun ↗</a>` : ''}
				</div>`
			: '';
		this._paint(
			this._shell(
				'Token Launched!',
				`<div class="ltm-success">
					<div class="ltm-success-title">Your coin is live</div>
					<canvas class="ltm-share-card" id="ltm-share" width="800" height="420"
						aria-label="Shareable launch card for ${_esc(this._d.symbol)}"></canvas>
					<div class="ltm-mint-box" id="ltm-mint">${_esc(mint)}</div>
					<div class="ltm-share-actions">
						<button class="ltm-btn" id="ltm-copy-mint">Copy mint</button>
						<button class="ltm-btn" id="ltm-download">Download card</button>
						<button class="ltm-btn ltm-btn-primary" id="ltm-share-x">Share on X</button>
					</div>
					${ctaRow}
					<div class="ltm-copilot" id="ltm-copilot"></div>
				</div>`,
				`<div></div>
				<button class="ltm-btn ltm-btn-primary btn btn--primary" id="ltm-done">Close</button>`,
			),
		);

		this._drawShareCard(mint);
		this._mountCopilot(mint);

		const ov = this._overlay;
		const shareText = `I just launched $${this._d.symbol} on @pumpdotfun — built & deployed on three.ws 🌐`;
		const shareUrl = pumpUrl || `https://three.ws`;

		ov.querySelector('#ltm-copy-mint')?.addEventListener('click', async (e) => {
			try {
				await navigator.clipboard.writeText(mint);
				e.target.textContent = 'Copied ✓';
				setTimeout(() => (e.target.textContent = 'Copy mint'), 1500);
			} catch {
				this._msg('Copy failed — select the address manually.', true);
			}
		});

		ov.querySelector('#ltm-download')?.addEventListener('click', () => {
			const canvas = ov.querySelector('#ltm-share');
			if (!canvas) return;
			const a = document.createElement('a');
			a.download = `${this._d.symbol || 'token'}-launch.png`;
			a.href = canvas.toDataURL('image/png');
			a.click();
		});

		ov.querySelector('#ltm-share-x')?.addEventListener('click', () => {
			const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
			window.open(intent, '_blank', 'noopener,noreferrer');
		});

		ov.querySelector('#ltm-manage')?.addEventListener('click', () => {
			this._close();
			window.location.href = dashboardUrl;
		});

		ov.querySelector('#ltm-done').addEventListener('click', () => {
			this._close();
		});

		window.dispatchEvent(
			new CustomEvent('agent-token-launched', { detail: { mint, pumpUrl } }),
		);
	}

	/**
	 * Mount the Launch Copilot panel on the success step so the launcher can arm
	 * an autonomous market-maker the moment their coin is live. Lazy-loaded so the
	 * launch modal's core path never waits on it; a load failure degrades silently
	 * (the success screen is fully usable without it).
	 */
	async _mountCopilot(mint) {
		const host = this._overlay?.querySelector('#ltm-copilot');
		if (!host) return;
		try {
			const { mountLaunchCopilot } = await import('../launch-copilot.js');
			this._copilot = mountLaunchCopilot(host, {
				mint,
				network: this._d.cluster === 'devnet' ? 'devnet' : 'mainnet',
				symbol: this._d.symbol || '',
				coinName: this._d.name || '',
			});
		} catch (e) {
			console.warn('[launch-modal] copilot mount skipped:', e?.message);
		}
	}

	/** Render a polished, shareable launch card onto the success-step canvas. */
	_drawShareCard(mint) {
		const canvas = this._overlay?.querySelector('#ltm-share');
		if (!canvas?.getContext) return;
		const ctx = canvas.getContext('2d');
		const W = canvas.width;
		const H = canvas.height;
		const d = this._d;

		// Backdrop — subtle vertical gradient on the brand-dark surface.
		const bg = ctx.createLinearGradient(0, 0, 0, H);
		bg.addColorStop(0, '#0f1512');
		bg.addColorStop(1, '#0a0c0b');
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, W, H);

		// Accent glow top-left.
		const glow = ctx.createRadialGradient(120, 90, 10, 120, 90, 360);
		glow.addColorStop(0, 'rgba(120,200,140,0.22)');
		glow.addColorStop(1, 'rgba(120,200,140,0)');
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, W, H);

		// Border.
		ctx.strokeStyle = 'rgba(120,200,140,0.25)';
		ctx.lineWidth = 2;
		ctx.strokeRect(8, 8, W - 16, H - 16);

		const drawText = (text, x, y, font, color, align = 'left') => {
			ctx.font = font;
			ctx.fillStyle = color;
			ctx.textAlign = align;
			ctx.fillText(text, x, y);
		};

		// Header eyebrow.
		drawText('LAUNCHED ON PUMP.FUN', 56, 70, '600 18px Inter, system-ui, sans-serif', 'rgba(120,200,140,0.85)');

		// Token name + symbol.
		const name = (d.name || 'Your token').slice(0, 28);
		drawText(name, 56, 150, '700 56px Inter, system-ui, sans-serif', '#f3f6f4');
		drawText(`$${(d.symbol || 'TOKEN').slice(0, 12)}`, 56, 210, '600 38px Inter, system-ui, sans-serif', 'rgba(216,245,226,0.9)');

		if (d.description) {
			const desc = d.description.length > 90 ? d.description.slice(0, 87) + '…' : d.description;
			drawText(desc, 56, 256, '400 20px Inter, system-ui, sans-serif', 'rgba(255,255,255,0.5)');
		}

		// Mint address (mono, truncated middle).
		const shortMint = mint.length > 24 ? `${mint.slice(0, 12)}…${mint.slice(-8)}` : mint;
		drawText('MINT', 56, 330, '600 14px Inter, system-ui, sans-serif', 'rgba(255,255,255,0.35)');
		drawText(shortMint, 56, 360, '500 24px ui-monospace, monospace', 'rgba(255,255,255,0.7)');

		// 3ws mark badge (bottom-left).
		ctx.fillStyle = 'rgba(120,200,140,0.14)';
		this._roundRect(ctx, 56, 376, 196, 30, 8);
		ctx.fill();
		drawText(`◆ ${THREE_WS_MARK}… on-chain mark`, 70, 396, '600 15px Inter, system-ui, sans-serif', 'rgba(216,245,226,0.95)');

		// three.ws wordmark (bottom-right).
		drawText('three.ws', W - 56, 392, '700 26px Inter, system-ui, sans-serif', 'rgba(255,255,255,0.85)', 'right');

		// Token image, if same-origin / CORS-friendly. Drawn async; failure is silent.
		if (d.image) {
			const im = new Image();
			im.crossOrigin = 'anonymous';
			im.onload = () => {
				try {
					const size = 150;
					const ix = W - 56 - size;
					const iy = 56;
					ctx.save();
					this._roundRect(ctx, ix, iy, size, size, 16);
					ctx.clip();
					ctx.drawImage(im, ix, iy, size, size);
					ctx.restore();
					ctx.strokeStyle = 'rgba(120,200,140,0.4)';
					ctx.lineWidth = 2;
					this._roundRect(ctx, ix, iy, size, size, 16);
					ctx.stroke();
				} catch {
					/* tainted canvas — leave card without the image */
				}
			};
			im.src = d.image;
		}
	}

	_roundRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	_msg(text, err = false) {
		const el = this._overlay?.querySelector('#ltm-msg');
		if (!el) return;
		el.textContent = text;
		el.className = `ltm-status-msg${err ? ' ltm-err' : ''}`;
	}
}

/**
 * Open the launch token modal.
 * @param {{ agentId: string, agentName?: string, imageUrl?: string }} opts
 * @returns {LaunchTokenModal}
 */
export function openLaunchTokenModal(opts) {
	const modal = new LaunchTokenModal(opts);
	modal.open();
	return modal;
}
