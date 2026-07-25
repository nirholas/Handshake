/**
 * Grant Permissions Modal — 3-step scope builder, plain-English review, and
 * MetaMask EIP-712 sign flow for ERC-7710 delegations.
 *
 * Public API:
 *   new GrantPermissionsModal({ agentId, chainId, delegatorAddress,
 *     delegateAddress, presets? }).open()
 *   → Promise<{ ok: true, id, delegationHash } | { ok: false, reason }>
 */

import { AbiCoder, getAddress } from 'ethers';
import { apiFetch } from '../api.js';
import { ensureWallet } from '../erc8004/agent-registry.js';
import { encodeScopedDelegation, signDelegation } from './toolkit.js';
import { CAVEAT_ENFORCERS } from '../erc7710/abi.js';

// ── Token tables ──────────────────────────────────────────────────────────────

const TOKENS = {
	84532: [
		{ symbol: 'ETH', address: 'native', decimals: 18 },
		{ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
		{ symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
	],
	11155111: [
		{ symbol: 'ETH', address: 'native', decimals: 18 },
		{ symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 },
		{ symbol: 'WETH', address: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', decimals: 18 },
	],
	1: [
		{ symbol: 'ETH', address: 'native', decimals: 18 },
		{ symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
		{ symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
	],
};

const SUPPORTED_CHAINS = [
	{ id: 84532, name: 'Base Sepolia', testnet: true },
	{ id: 11155111, name: 'Sepolia', testnet: true },
	{ id: 1, name: 'Ethereum Mainnet', testnet: false },
];

const KNOWN_CONTRACTS = {
	84532: [{ name: 'Uniswap V3 Router', address: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4' }],
	11155111: [{ name: 'Uniswap V3 Router', address: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48' }],
	1: [
		{ name: 'Uniswap V3 Router', address: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
		{ name: 'Uniswap V2 Router', address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' },
	],
};

const EXPIRY_OFFSETS = { '24h': 86400, '7d': 604800, '30d': 2592000 };
const ZERO_ADDR = '0x' + '0'.repeat(40);

// ── Pure helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function formatAddress(addr) {
	if (!addr || addr === 'native') return addr;
	return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function formatAmount(raw, decimals) {
	if (!raw) return '0';
	const n = Number(raw) / 10 ** decimals;
	return n % 1 === 0 ? String(n) : n.toFixed(6).replace(/\.?0+$/, '');
}

function toBaseUnits(display, decimals) {
	const n = parseFloat(display) || 0;
	return BigInt(Math.round(n * 10 ** decimals)).toString();
}

function tokensForChain(chainId) {
	return TOKENS[chainId] ?? [{ symbol: 'ETH', address: 'native', decimals: 18 }];
}

function knownContractsForChain(chainId) {
	return KNOWN_CONTRACTS[chainId] ?? [];
}

function resolveExpiry(preset, custom) {
	if (preset === 'custom') {
		const ts = custom ? Math.floor(new Date(custom).getTime() / 1000) : 0;
		return ts;
	}
	return Math.floor(Date.now() / 1000) + (EXPIRY_OFFSETS[preset] ?? EXPIRY_OFFSETS['24h']);
}

function resolveTokenMeta(token, chainId) {
	const list = tokensForChain(chainId);
	return list.find((t) => t.address.toLowerCase() === token.toLowerCase()) ?? null;
}

function isKnownTarget(addr, chainId) {
	const list = knownContractsForChain(chainId);
	return list.some((c) => c.address.toLowerCase() === addr.toLowerCase());
}

function buildReviewLines(form, chainId) {
	const meta = resolveTokenMeta(form.token, chainId);
	const symbol = meta ? meta.symbol : formatAddress(form.token);
	const decimals = meta ? meta.decimals : 18;
	const amount = form.amount ? formatAmount(toBaseUnits(form.amount, decimals), decimals) : '?';

	const periodLabel =
		{ once: 'in total', daily: 'per day', weekly: 'per week' }[form.period] ?? '';

	const expiryTs = resolveExpiry(form.expiry, form.customExpiry);
	const expiryDate = expiryTs
		? new Date(expiryTs * 1000).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
			})
		: 'an unknown date';

	const lines = [];

	const targetNames = form.targets.map((addr) => {
		const known = knownContractsForChain(chainId).find(
			(c) => c.address.toLowerCase() === addr.toLowerCase(),
		);
		return known ? `${known.name} (${formatAddress(addr)})` : formatAddress(addr);
	});

	const targetDesc = form.targets.length === 0 ? 'any contract' : targetNames.join(', ');

	lines.push(
		`This agent can spend up to <strong>${escapeHtml(amount)} ${escapeHtml(symbol)}</strong>` +
			` ${escapeHtml(periodLabel)} on <strong>${escapeHtml(targetDesc)}</strong>` +
			` until <strong>${escapeHtml(expiryDate)}</strong>.`,
	);

	return lines;
}

function buildScopeCaveats(scope, chainId) {
	const coder = AbiCoder.defaultAbiCoder();
	const e = (key) => CAVEAT_ENFORCERS[key]?.[chainId] ?? ZERO_ADDR;

	const tokenAddr = scope.token === 'native' ? ZERO_ADDR : getAddress(scope.token);

	const caveats = [
		{
			enforcer: e('ERC20LimitEnforcer'),
			terms: coder.encode(['address', 'uint256'], [tokenAddr, BigInt(scope.maxAmount)]),
			args: '0x',
		},
		{
			enforcer: e('TimestampEnforcer'),
			terms: coder.encode(['uint128', 'uint128'], [0n, BigInt(scope.expiry)]),
			args: '0x',
		},
	];

	if (scope.targets && scope.targets.length > 0) {
		caveats.push({
			enforcer: e('AllowedTargetsEnforcer'),
			terms: coder.encode(['address[]'], [scope.targets.map((a) => getAddress(a))]),
			args: '0x',
		});
	}

	return caveats;
}

// ── CSS injection (once per page) ─────────────────────────────────────────────

const STYLE_ID = 'gm-styles';

function injectStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.gm-overlay{position:fixed;inset:0;z-index:130;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.85);backdrop-filter:blur(18px);
  -webkit-backdrop-filter:blur(18px);animation:gm-fadein .2s ease}
@keyframes gm-fadein{from{opacity:0}to{opacity:1}}
.gm-modal{width:92vw;max-width:520px;max-height:88vh;display:flex;
  flex-direction:column;background:rgba(10,10,10,.97);
  border:1px solid rgba(255,255,255,.08);border-radius:var(--radius-lg);
  overflow:hidden;box-shadow:0 16px 64px rgba(0,0,0,.7);color:#e0e0e0}
.gm-header{display:flex;align-items:center;justify-content:space-between;
  padding:var(--space-sm) var(--space-lg);border-bottom:1px solid rgba(255,255,255,.06);
  flex-shrink:0}
.gm-title{font-size:var(--text-lg);font-weight:500;color:#fff;letter-spacing:.03em}
.gm-close{background:none;border:none;color:rgba(255,255,255,.4);
  font-size:var(--text-2xl);cursor:pointer;padding:0;line-height:1;transition:color .2s}
.gm-close:hover{color:#fff}
.gm-breadcrumb{display:flex;align-items:center;gap:var(--space-xs);
  padding:var(--space-xs) var(--space-lg);background:rgba(255,255,255,.02);
  border-bottom:1px solid rgba(255,255,255,.04);flex-shrink:0}
.gm-bc-step{font-size:var(--text-sm);color:rgba(255,255,255,.35);white-space:nowrap}
.gm-bc-step--active{color:#fff;font-weight:500}
.gm-bc-sep{color:rgba(255,255,255,.2);font-size:var(--text-xs)}
.gm-body{padding:var(--space-lg);overflow-y:auto;flex:1;min-height:0}
.gm-field{margin-bottom:var(--space-lg)}
.gm-label{display:block;font-size:var(--text-sm);color:rgba(255,255,255,.6);
  margin-bottom:var(--space-xs)}
.gm-input{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);
  border-radius:var(--radius-md);color:#e0e0e0;padding:var(--space-xs) var(--space-sm);
  font-size:var(--text-sm);font-family:var(--font-body);outline:none;transition:border .2s}
.gm-input:focus{border-color:var(--accent)}
.gm-input[type=number]{-moz-appearance:textfield}
.gm-fieldset{border:none;padding:0;margin:0 0 var(--space-lg)}
.gm-legend{font-size:var(--text-sm);color:rgba(255,255,255,.6);margin-bottom:var(--space-xs)}
.gm-radio-group{display:flex;flex-wrap:wrap;gap:var(--space-xs)}
.gm-radio-label{display:flex;align-items:center;gap:var(--space-xs);cursor:pointer;
  font-size:var(--text-sm);color:#e0e0e0}
.gm-radio-label input[type=radio]{accent-color:var(--accent)}
.gm-amount-row{display:flex;align-items:center;gap:var(--space-xs)}
.gm-amount-row .gm-input{flex:1}
.gm-token-unit{font-size:var(--text-sm);color:rgba(255,255,255,.5);white-space:nowrap;
  min-width:3rem;text-align:right}
.gm-pills{display:flex;gap:var(--space-xs);flex-wrap:wrap;margin-bottom:var(--space-xs)}
.gm-pill{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
  border-radius:20px;color:rgba(255,255,255,.7);font-size:var(--text-sm);
  padding:var(--space-2xs) var(--space-sm);cursor:pointer;transition:all .15s}
.gm-pill:hover{border-color:var(--accent);color:#fff}
.gm-pill--active{background:var(--accent-soft);border-color:var(--accent);color:#fff}
.gm-targets-list{display:flex;flex-direction:column;gap:var(--space-xs);
  margin-bottom:var(--space-xs)}
.gm-target-row{display:flex;align-items:center;gap:var(--space-xs);
  background:rgba(255,255,255,.04);border-radius:var(--radius-md);
  padding:var(--space-2xs) var(--space-sm)}
.gm-target-addr{font-size:var(--text-sm);font-family:var(--font-mono);flex:1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-target-name{font-size:var(--text-xs);color:rgba(255,255,255,.45)}
.gm-target-remove{background:none;border:none;color:rgba(255,255,255,.35);cursor:pointer;
  font-size:var(--text-base);line-height:1;padding:0;transition:color .15s}
.gm-target-remove:hover{color:#e06c75}
.gm-targets-add{display:flex;gap:var(--space-xs);flex-wrap:wrap;align-items:center}
.gm-select{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);
  border-radius:var(--radius-md);color:#e0e0e0;padding:var(--space-2xs) var(--space-sm);
  font-size:var(--text-sm);cursor:pointer;outline:none}
.gm-actions{display:flex;justify-content:flex-end;gap:var(--space-sm);
  padding-top:var(--space-lg);border-top:1px solid rgba(255,255,255,.06)}
.gm-btn{padding:var(--space-xs) var(--space-lg);border-radius:var(--radius-md);
  font-size:var(--text-sm);font-family:var(--font-body);cursor:pointer;
  border:1px solid transparent;transition:all .15s;line-height:1.5}
.gm-btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}
.gm-btn--primary:hover{filter:brightness(1.15)}
.gm-btn--primary:disabled{opacity:.5;cursor:not-allowed;filter:none}
.gm-btn--ghost{background:transparent;border-color:rgba(255,255,255,.2);
  color:rgba(255,255,255,.7)}
.gm-btn--ghost:hover{border-color:rgba(255,255,255,.5);color:#fff}
.gm-btn--sm{padding:var(--space-2xs) var(--space-sm);font-size:var(--text-xs)}
.gm-review-list{list-style:none;padding:0;margin:0 0 var(--space-lg);
  display:flex;flex-direction:column;gap:var(--space-sm)}
.gm-review-item{font-size:var(--text-sm);line-height:var(--leading-loose);
  padding:var(--space-sm) var(--space-md);background:rgba(255,255,255,.04);
  border-radius:var(--radius-md);border-left:3px solid var(--accent)}
.gm-warning{font-size:var(--text-sm);color:#e06c75;padding:var(--space-xs) var(--space-sm);
  background:rgba(224,108,117,.08);border:1px solid rgba(224,108,117,.3);
  border-radius:var(--radius-md);margin-bottom:var(--space-md)}
.gm-status{display:flex;flex-direction:column;align-items:center;gap:var(--space-md);
  padding:var(--space-xl) 0;text-align:center}
.gm-status-icon{font-size:2.5rem;line-height:1}
.gm-status-text{font-size:var(--text-sm);color:rgba(255,255,255,.75)}
.gm-status--success .gm-status-text{color:#98c379}
.gm-status--error .gm-status-text{color:#e06c75}
.gm-error-detail{font-size:var(--text-xs);color:rgba(255,255,255,.4);
  font-family:var(--font-mono);word-break:break-all;text-align:left;
  background:rgba(0,0,0,.3);padding:var(--space-xs);border-radius:var(--radius-md);
  max-width:100%}
.gm-custom-token-row{margin-top:var(--space-xs)}
.gm-chain-group{flex-direction:column;gap:var(--space-xs)}
.gm-chain-row{padding:var(--space-xs) var(--space-sm);background:rgba(255,255,255,.04);
  border-radius:var(--radius-md);border:1px solid rgba(255,255,255,.08);width:100%}
.gm-chain-row:hover{border-color:var(--accent)}
.gm-chain-name{flex:1}
.gm-chain-testnet{font-size:var(--text-xs);color:rgba(255,255,255,.45);
  background:rgba(255,255,255,.06);padding:1px 6px;border-radius:8px;margin-left:auto}
`;
	document.head.appendChild(style);
}

// ── Main class ────────────────────────────────────────────────────────────────

export class GrantPermissionsModal {
	/**
	 * @param {{ agentId: string, chainId: number, delegatorAddress: string,
	 *   delegateAddress: string, presets?: object }} opts
	 */
	constructor({ agentId, chainId, delegatorAddress, delegateAddress, presets = {} }) {
		this._agentId = agentId;
		this._chainId = chainId ?? null;
		this._delegatorAddress = delegatorAddress ?? null;
		this._delegateAddress = delegateAddress ?? null;

		// If chainId is missing, start with network picker (step 0).
		this._step = this._chainId ? 1 : 0;
		this._form = {
			token: presets.token ?? 'native',
			customToken: '',
			amount: presets.amount ?? '',
			period: presets.period ?? 'once',
			expiry: presets.expiry ?? '24h',
			customExpiry: '',
			targets: Array.isArray(presets.targets) ? [...presets.targets] : [],
		};

		this._signedDelegation = null;
		this._lastScope = null;

		this.overlay = null;
		this._modal = null;
		this._body = null;
		this._resolve = null;
		this._previouslyFocused = null;
		this._onKeyDown = null;
		this._onOverlayClick = null;
		this._onTrapFocus = null;
	}

	/**
	 * Open the modal and return a promise that resolves when the user completes
	 * or cancels the flow.
	 * @returns {Promise<{ ok: true, id: string, delegationHash: string } | { ok: false, reason: string }>}
	 */
	open() {
		if (this.overlay) return Promise.resolve({ ok: false, reason: 'already_open' });
		return new Promise((resolve) => {
			this._resolve = resolve;
			this._previouslyFocused = document.activeElement;
			injectStyles();
			this._build();
			this._wireGlobal();
			this._renderStep(this._chainId ? 1 : 0);
			this._focusFirst();
		});
	}

	close() {
		this._settle({ ok: false, reason: 'closed' });
		this._cleanup();
	}

	// ── Build / teardown ───────────────────────────────────────────────────────

	_build() {
		this.overlay = document.createElement('div');
		this.overlay.className = 'gm-overlay';
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.overlay.setAttribute('aria-labelledby', 'gm-title');
		this.overlay.innerHTML = `
			<div class="gm-modal">
				<div class="gm-header">
					<span class="gm-title" id="gm-title">Grant Permissions</span>
					<button type="button" class="gm-close" aria-label="Close">&times;</button>
				</div>
				<nav class="gm-breadcrumb" aria-label="Steps">
					<span class="gm-bc-step" data-step="0" hidden>0. Network</span>
					<span class="gm-bc-sep gm-bc-sep--0" aria-hidden="true" hidden>›</span>
					<span class="gm-bc-step" data-step="1">1. Scope</span>
					<span class="gm-bc-sep" aria-hidden="true">›</span>
					<span class="gm-bc-step" data-step="2">2. Review</span>
					<span class="gm-bc-sep" aria-hidden="true">›</span>
					<span class="gm-bc-step" data-step="3">3. Sign</span>
				</nav>
				<div class="gm-body"></div>
			</div>
		`;
		document.body.appendChild(this.overlay);
		this._modal = this.overlay.querySelector('.gm-modal');
		this._body = this.overlay.querySelector('.gm-body');
		this.overlay.querySelector('.gm-close').addEventListener('click', () => this.close());
	}

	_wireGlobal() {
		this._onOverlayClick = (e) => {
			if (e.target === this.overlay) this.close();
		};
		this.overlay.addEventListener('click', this._onOverlayClick);

		this._onKeyDown = (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.close();
			}
		};
		document.addEventListener('keydown', this._onKeyDown);

		this._onTrapFocus = (e) => {
			if (e.key !== 'Tab') return;
			const items = this._focusables();
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
		};
		this.overlay.addEventListener('keydown', this._onTrapFocus);
	}

	_cleanup() {
		if (!this.overlay) return;
		if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
		this.overlay.remove();
		this.overlay = null;
		this._modal = null;
		this._body = null;
		this._onKeyDown = null;
		this._onOverlayClick = null;
		this._onTrapFocus = null;
		const prev = this._previouslyFocused;
		this._previouslyFocused = null;
		if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
			try {
				prev.focus();
			} catch (_) {}
		}
	}

	_settle(result) {
		if (!this._resolve) return;
		const fn = this._resolve;
		this._resolve = null;
		fn(result);
	}

	// ── Step routing ───────────────────────────────────────────────────────────

	_renderStep(n) {
		this._step = n;
		this._body.innerHTML = '';
		this._updateBreadcrumb(n);
		if (n === 0) this._renderStep0();
		else if (n === 1) this._renderStep1();
		else if (n === 2) this._renderStep2();
		else this._renderStep3();
	}

	_updateBreadcrumb(active) {
		// Reveal step 0 in breadcrumb only if it's part of this flow.
		const showStep0 = !this._chainId || active === 0;
		const step0El = this.overlay.querySelector('.gm-bc-step[data-step="0"]');
		const step0Sep = this.overlay.querySelector('.gm-bc-sep--0');
		if (step0El) step0El.hidden = !showStep0;
		if (step0Sep) step0Sep.hidden = !showStep0;

		this.overlay.querySelectorAll('.gm-bc-step').forEach((el) => {
			el.classList.toggle('gm-bc-step--active', Number(el.dataset.step) === active);
		});
	}

	// ── Step 0: Network picker ────────────────────────────────────────────────

	_renderStep0() {
		const chainOptions = SUPPORTED_CHAINS.map(
			(c) => `
				<label class="gm-radio-label gm-chain-row">
					<input type="radio" name="gm-chain" value="${c.id}">
					<span class="gm-chain-name">${escapeHtml(c.name)}</span>
					${c.testnet ? '<span class="gm-chain-testnet">testnet</span>' : ''}
				</label>`,
		).join('');

		this._body.innerHTML = `
			<form id="gm-chain-form" novalidate>
				<fieldset class="gm-fieldset">
					<legend class="gm-legend">Choose a network</legend>
					<div class="gm-radio-group gm-chain-group">${chainOptions}</div>
				</fieldset>
				<div class="gm-actions">
					<button type="button" class="gm-btn gm-btn--ghost" id="gm-cancel-btn-0">
						Cancel
					</button>
					<button type="submit" class="gm-btn gm-btn--primary" id="gm-chain-next" disabled>
						Continue →
					</button>
				</div>
			</form>
		`;

		const form = this._body.querySelector('#gm-chain-form');
		const nextBtn = form.querySelector('#gm-chain-next');

		form.querySelectorAll('input[name="gm-chain"]').forEach((radio) => {
			radio.addEventListener('change', () => {
				nextBtn.disabled = false;
			});
		});

		form.querySelector('#gm-cancel-btn-0').addEventListener('click', () => this.close());

		form.addEventListener('submit', (e) => {
			e.preventDefault();
			const checked = form.querySelector('input[name="gm-chain"]:checked');
			if (!checked) return;
			this._chainId = parseInt(checked.value, 10);
			// Reset token to native since per-chain token list changes.
			this._form.token = 'native';
			this._renderStep(1);
		});
	}

	// ── Step 1: Scope builder ─────────────────────────────────────────────────

	_renderStep1() {
		const tokens = tokensForChain(this._chainId);
		const contracts = knownContractsForChain(this._chainId);
		const currentToken = this._form.token;
		const isCustomToken = !tokens.find((t) => t.address === currentToken);
		const currentMeta = tokens.find((t) => t.address === currentToken);
		const unitLabel = currentMeta ? currentMeta.symbol : 'tokens';

		const tokenRadios = tokens
			.map(
				(t) => `
				<label class="gm-radio-label">
					<input type="radio" name="gm-token" value="${escapeHtml(t.address)}"
						${currentToken === t.address ? 'checked' : ''}>
					${escapeHtml(t.symbol)}
				</label>`,
			)
			.join('');

		const periodRadios = ['once', 'daily', 'weekly']
			.map(
				(p) => `
				<label class="gm-radio-label">
					<input type="radio" name="gm-period" value="${p}"
						${this._form.period === p ? 'checked' : ''}>
					${p.charAt(0).toUpperCase() + p.slice(1)}
				</label>`,
			)
			.join('');

		const expiryPills = ['24h', '7d', '30d', 'custom']
			.map(
				(k) => `
				<button type="button" class="gm-pill ${this._form.expiry === k ? 'gm-pill--active' : ''}"
					data-expiry="${k}">${k === '24h' ? '24 h' : k === '7d' ? '7 d' : k === '30d' ? '30 d' : 'Custom'}
				</button>`,
			)
			.join('');

		const targetRows = this._form.targets
			.map((addr) => {
				const known = contracts.find((c) => c.address.toLowerCase() === addr.toLowerCase());
				return `
				<div class="gm-target-row" data-addr="${escapeHtml(addr)}">
					<span class="gm-target-addr" title="${escapeHtml(addr)}">${escapeHtml(addr)}</span>
					${known ? `<span class="gm-target-name">${escapeHtml(known.name)}</span>` : ''}
					<button type="button" class="gm-target-remove" aria-label="Remove target"
						data-addr="${escapeHtml(addr)}">×</button>
				</div>`;
			})
			.join('');

		const knownOptions = contracts
			.map((c) => `<option value="${escapeHtml(c.address)}">${escapeHtml(c.name)}</option>`)
			.join('');

		this._body.innerHTML = `
			<form id="gm-scope-form" novalidate>
				<fieldset class="gm-fieldset">
					<legend class="gm-legend">Token</legend>
					<div class="gm-radio-group">
						${tokenRadios}
						<label class="gm-radio-label">
							<input type="radio" name="gm-token" value="custom"
								${isCustomToken || currentToken === 'custom' ? 'checked' : ''}>
							Custom
						</label>
					</div>
					<div class="gm-custom-token-row" id="gm-custom-token-row"
						${!isCustomToken && currentToken !== 'custom' ? 'hidden' : ''}>
						<input type="text" class="gm-input" id="gm-custom-token-input"
							placeholder="0x… ERC-20 address"
							value="${escapeHtml(isCustomToken ? currentToken : '')}">
					</div>
				</fieldset>

				<div class="gm-field">
					<label class="gm-label" for="gm-amount">Max amount</label>
					<div class="gm-amount-row">
						<input type="number" class="gm-input" id="gm-amount" min="0" step="any"
							placeholder="0.00" value="${escapeHtml(this._form.amount)}">
						<span class="gm-token-unit" id="gm-token-unit">${escapeHtml(unitLabel)}</span>
					</div>
				</div>

				<fieldset class="gm-fieldset">
					<legend class="gm-legend">Period</legend>
					<div class="gm-radio-group">${periodRadios}</div>
				</fieldset>

				<div class="gm-field">
					<label class="gm-label">Expiry</label>
					<div class="gm-pills">${expiryPills}</div>
					<input type="datetime-local" class="gm-input" id="gm-expiry-custom"
						value="${escapeHtml(this._form.customExpiry)}"
						${this._form.expiry !== 'custom' ? 'hidden' : ''}>
				</div>

				<div class="gm-field">
					<label class="gm-label">Allowed targets</label>
					<div class="gm-targets-list" id="gm-targets-list">${targetRows}</div>
					<div class="gm-targets-add">
						${
							contracts.length
								? `<select class="gm-select" id="gm-known-select">
								<option value="">Add known contract…</option>
								${knownOptions}
							</select>`
								: ''
						}
						<button type="button" class="gm-btn gm-btn--ghost gm-btn--sm"
							id="gm-add-custom-btn">+ Custom address</button>
					</div>
					<input type="text" class="gm-input" id="gm-custom-target-input"
						placeholder="0x… target address" style="margin-top:var(--space-xs)" hidden>
				</div>

				<div class="gm-actions">
					<button type="button" class="gm-btn gm-btn--ghost" id="gm-cancel-btn">
						Cancel
					</button>
					<button type="submit" class="gm-btn gm-btn--primary">
						Review →
					</button>
				</div>
			</form>
		`;

		this._bindStep1();
	}

	_bindStep1() {
		const form = this._body.querySelector('#gm-scope-form');
		const customTokenRow = form.querySelector('#gm-custom-token-row');
		const customTokenInput = form.querySelector('#gm-custom-token-input');
		const unitLabel = form.querySelector('#gm-token-unit');
		const expiryCustom = form.querySelector('#gm-expiry-custom');
		const targetsList = form.querySelector('#gm-targets-list');
		const knownSelect = form.querySelector('#gm-known-select');
		const addCustomBtn = form.querySelector('#gm-add-custom-btn');
		const customTargetInput = form.querySelector('#gm-custom-target-input');

		form.querySelectorAll('input[name="gm-token"]').forEach((radio) => {
			radio.addEventListener('change', () => {
				const isCustom = radio.value === 'custom';
				customTokenRow.hidden = !isCustom;
				if (!isCustom) {
					const meta = tokensForChain(this._chainId).find(
						(t) => t.address === radio.value,
					);
					unitLabel.textContent = meta ? meta.symbol : 'tokens';
				} else {
					unitLabel.textContent = 'tokens';
				}
			});
		});

		form.querySelectorAll('.gm-pill[data-expiry]').forEach((btn) => {
			btn.addEventListener('click', () => {
				form.querySelectorAll('.gm-pill[data-expiry]').forEach((b) =>
					b.classList.remove('gm-pill--active'),
				);
				btn.classList.add('gm-pill--active');
				expiryCustom.hidden = btn.dataset.expiry !== 'custom';
			});
		});

		if (knownSelect) {
			knownSelect.addEventListener('change', () => {
				const addr = knownSelect.value;
				if (!addr) return;
				knownSelect.value = '';
				this._addTarget(addr, targetsList);
			});
		}

		addCustomBtn.addEventListener('click', () => {
			customTargetInput.hidden = !customTargetInput.hidden;
			if (!customTargetInput.hidden) {
				customTargetInput.focus();
			}
		});

		customTargetInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = customTargetInput.value.trim();
				if (val) {
					try {
						const addr = getAddress(val);
						this._addTarget(addr, targetsList);
						customTargetInput.value = '';
						customTargetInput.hidden = true;
					} catch (_) {
						customTargetInput.style.borderColor = '#e06c75';
						setTimeout(() => (customTargetInput.style.borderColor = ''), 1500);
					}
				}
			}
		});

		targetsList.addEventListener('click', (e) => {
			const btn = e.target.closest('.gm-target-remove');
			if (!btn) return;
			const addr = btn.dataset.addr;
			this._form.targets = this._form.targets.filter(
				(t) => t.toLowerCase() !== addr.toLowerCase(),
			);
			btn.closest('.gm-target-row').remove();
		});

		form.querySelector('#gm-cancel-btn').addEventListener('click', () => this.close());

		form.addEventListener('submit', (e) => {
			e.preventDefault();
			this._collectStep1(form);
			this._renderStep(2);
		});
	}

	_addTarget(addr, listEl) {
		if (this._form.targets.some((t) => t.toLowerCase() === addr.toLowerCase())) return;
		this._form.targets.push(addr);
		const known = knownContractsForChain(this._chainId).find(
			(c) => c.address.toLowerCase() === addr.toLowerCase(),
		);
		const row = document.createElement('div');
		row.className = 'gm-target-row';
		row.dataset.addr = addr;
		row.innerHTML = `
			<span class="gm-target-addr" title="${escapeHtml(addr)}">${escapeHtml(addr)}</span>
			${known ? `<span class="gm-target-name">${escapeHtml(known.name)}</span>` : ''}
			<button type="button" class="gm-target-remove" aria-label="Remove target"
				data-addr="${escapeHtml(addr)}">×</button>
		`;
		listEl.appendChild(row);
	}

	_collectStep1(form) {
		const checkedToken = form.querySelector('input[name="gm-token"]:checked');
		const tokenVal = checkedToken ? checkedToken.value : 'native';
		if (tokenVal === 'custom') {
			const raw = form.querySelector('#gm-custom-token-input').value.trim();
			this._form.token = raw || 'native';
		} else {
			this._form.token = tokenVal;
		}
		this._form.amount = form.querySelector('#gm-amount').value.trim();
		const checkedPeriod = form.querySelector('input[name="gm-period"]:checked');
		this._form.period = checkedPeriod ? checkedPeriod.value : 'once';
		const activePill = form.querySelector('.gm-pill--active[data-expiry]');
		this._form.expiry = activePill ? activePill.dataset.expiry : '24h';
		this._form.customExpiry = form.querySelector('#gm-expiry-custom').value;
	}

	// ── Step 2: Plain-English review ──────────────────────────────────────────

	_renderStep2() {
		const lines = buildReviewLines(this._form, this._chainId);
		const hasUnknown = this._form.targets.some((addr) => !isKnownTarget(addr, this._chainId));

		const lineItems = lines.map((l) => `<li class="gm-review-item">${l}</li>`).join('');

		this._body.innerHTML = `
			<ul class="gm-review-list" role="list">${lineItems}</ul>
			${
				hasUnknown
					? `<div class="gm-warning" role="alert">
					⚠ One or more target addresses are not on the known-contracts list.
					Verify them before continuing.
				</div>`
					: ''
			}
			<div class="gm-actions">
				<button type="button" class="gm-btn gm-btn--ghost" id="gm-back-btn">
					← Back
				</button>
				<button type="button" class="gm-btn gm-btn--primary" id="gm-continue-btn">
					Continue to MetaMask →
				</button>
			</div>
		`;

		this._body
			.querySelector('#gm-back-btn')
			.addEventListener('click', () => this._renderStep(1));
		this._body
			.querySelector('#gm-continue-btn')
			.addEventListener('click', () => this._renderStep(3));
	}

	// ── Step 3: Sign + submit ─────────────────────────────────────────────────

	_renderStep3() {
		this._body.innerHTML = `
			<div class="gm-status" id="gm-status" role="status" aria-live="polite">
				<div class="gm-status-icon" id="gm-status-icon">⏳</div>
				<div class="gm-status-text" id="gm-status-text">Preparing…</div>
			</div>
			<div class="gm-actions" id="gm-sign-actions"></div>
		`;
		this._signAndSubmit();
	}

	_setStatus(icon, text, className = '') {
		const status = this._body?.querySelector('#gm-status');
		if (!status) return;
		status.className = 'gm-status' + (className ? ` ${className}` : '');
		const iconEl = status.querySelector('#gm-status-icon');
		const textEl = status.querySelector('#gm-status-text');
		if (iconEl) iconEl.textContent = icon;
		if (textEl) textEl.textContent = text;
	}

	_setActions(html) {
		const el = this._body?.querySelector('#gm-sign-actions');
		if (el) el.innerHTML = html;
	}

	async _signAndSubmit() {
		this._setStatus('⏳', 'Connecting wallet…');

		let signer;
		try {
			const wallet = await ensureWallet();
			signer = wallet.signer;
			// If we don't have a delegator yet, this connection provides it.
			if (!this._delegatorAddress) {
				this._delegatorAddress = wallet.address;
			}
		} catch (err) {
			this._setStatus('✗', `Wallet connection failed: ${err.message}`, 'gm-status--error');
			this._setActions(
				`<button class="gm-btn gm-btn--ghost" id="gm-retry-conn">Retry</button>`,
			);
			this._body
				.querySelector('#gm-retry-conn')
				?.addEventListener('click', () => this._signAndSubmit());
			return;
		}

		if (!this._delegateAddress) {
			this._setStatus(
				'✗',
				'Agent has no on-chain address yet. Register the agent first, then grant permissions.',
				'gm-status--error',
			);
			this._setActions(
				`<button class="gm-btn gm-btn--ghost" id="gm-close-no-delegate">Close</button>`,
			);
			this._body
				.querySelector('#gm-close-no-delegate')
				?.addEventListener('click', () => this.close());
			return;
		}

		const meta = tokensForChain(this._chainId).find((t) => t.address === this._form.token);
		const decimals = meta ? meta.decimals : 18;
		const maxAmount = toBaseUnits(this._form.amount || '0', decimals);
		const expiry = resolveExpiry(this._form.expiry, this._form.customExpiry);

		const scope = {
			token: this._form.token,
			maxAmount,
			period: this._form.period,
			targets: [...this._form.targets],
			expiry,
		};
		this._lastScope = scope;

		let signed = this._signedDelegation;

		if (!signed) {
			this._setStatus('⏳', 'Waiting for signature…');

			let delegation;
			try {
				const caveats = buildScopeCaveats(scope, this._chainId);
				delegation = encodeScopedDelegation({
					delegator: this._delegatorAddress,
					delegate: this._delegateAddress,
					caveats,
					expiry,
					chainId: this._chainId,
				});
			} catch (err) {
				this._setStatus('✗', `Scope error: ${err.message}`, 'gm-status--error');
				this._setActions(
					`<button class="gm-btn gm-btn--ghost" id="gm-back-from-err">← Back</button>`,
				);
				this._body
					.querySelector('#gm-back-from-err')
					?.addEventListener('click', () => this._renderStep(1));
				return;
			}

			try {
				signed = await signDelegation({ ...delegation, scope }, signer);
				this._signedDelegation = signed;
			} catch (err) {
				const reason =
					err?.code === 4001 || err?.code === 'ACTION_REJECTED'
						? 'Signature rejected.'
						: `Signature failed: ${err.message}`;
				this._setStatus('✗', reason, 'gm-status--error');
				this._setActions(`
					<button class="gm-btn gm-btn--ghost" id="gm-back-from-err">← Back</button>
					<button class="gm-btn gm-btn--primary" id="gm-retry-sign">Retry</button>
				`);
				this._body
					.querySelector('#gm-back-from-err')
					?.addEventListener('click', () => this._renderStep(1));
				this._body.querySelector('#gm-retry-sign')?.addEventListener('click', () => {
					this._signedDelegation = null;
					this._signAndSubmit();
				});
				return;
			}
		}

		await this._submitDelegation(signed, scope);
	}

	async _submitDelegation(signed, scope) {
		this._setStatus('⏳', 'Submitting…');
		this._setActions('');

		let data;
		try {
			const res = await apiFetch('/api/permissions/grant', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					agentId: this._agentId,
					chainId: this._chainId,
					delegation: signed,
					scope,
				}),
			});
			data = await res.json();

			if (!res.ok) {
				const msg = data?.message || data?.error || `HTTP ${res.status}`;
				throw Object.assign(new Error(msg), { statusCode: res.status });
			}
		} catch (err) {
			const msg = err.message || String(err);
			const isConflict = err.statusCode === 409;

			this._setStatus(
				'✗',
				isConflict ? 'Already granted.' : `Failed: ${msg}`,
				'gm-status--error',
			);

			const detail = document.createElement('div');
			detail.className = 'gm-error-detail';
			detail.textContent = msg;
			this._body.querySelector('#gm-status')?.appendChild(detail);

			const retryHtml = isConflict
				? `<button class="gm-btn gm-btn--ghost" id="gm-done-err">Close</button>`
				: `<button class="gm-btn gm-btn--ghost" id="gm-back-from-err">← Back</button>
				   <button class="gm-btn gm-btn--primary" id="gm-retry-submit">Retry submit</button>`;
			this._setActions(retryHtml);

			this._body
				.querySelector('#gm-back-from-err')
				?.addEventListener('click', () => this._renderStep(1));
			this._body
				.querySelector('#gm-retry-submit')
				?.addEventListener('click', () => this._submitDelegation(signed, scope));
			this._body.querySelector('#gm-done-err')?.addEventListener('click', () => this.close());
			return;
		}

		this._setStatus('✓', 'Granted ✓', 'gm-status--success');
		this._settle({ ok: true, id: data.id, delegationHash: data.delegationHash });

		setTimeout(() => this._cleanup(), 1500);
	}

	// ── Utilities ──────────────────────────────────────────────────────────────

	_focusFirst() {
		const items = this._focusables();
		if (items.length) {
			try {
				items[0].focus();
			} catch (_) {}
		}
	}

	_focusables() {
		if (!this.overlay) return [];
		return Array.from(
			this.overlay.querySelectorAll(
				'button:not([disabled]), input:not([disabled]):not([hidden]), ' +
					'select:not([disabled]), [tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => !el.closest('[hidden]'));
	}
}

// ── Convenience global (debug or explicit import only) ─────────────────────────

if (typeof window !== 'undefined' && !window.openGrantPermissions) {
	window.openGrantPermissions = (opts) => new GrantPermissionsModal(opts).open();
}

// ── openGrantModal — skill-facing convenience function ────────────────────────

/**
 * Simplified entry point for skills that want to open the grant modal with a
 * scope preset, without needing to resolve wallet addresses themselves.
 *
 * Connects the wallet to get the delegator address, fetches the agent's
 * delegate address from the permissions metadata endpoint, then opens the
 * GrantPermissionsModal with the preset fields pre-filled.
 *
 * @param {{
 *   agentId:          string,
 *   chainId:          number,
 *   preset:           {
 *     token:          string,
 *     maxAmount:      string,       // base units (e.g. "10000000" for 10 USDC)
 *     period:         string,
 *     targets?:       string[],
 *     expiry_days?:   number,
 *   },
 *   delegateAddress?: string,       // optional override; otherwise fetched from API
 * }} opts
 * @returns {Promise<{ ok: true, id: string, delegationHash: string } | { ok: false, reason: string }>}
 */
export async function openGrantModal({ agentId, chainId, preset, delegateAddress } = {}) {
	// 1. Connect wallet — delegator is whoever is currently signed in
	let delegatorAddress;
	try {
		const { address } = await ensureWallet();
		delegatorAddress = address;
	} catch (err) {
		return { ok: false, reason: `wallet_connection_failed: ${err.message}` };
	}

	// 2. Resolve delegate (agent smart account) from metadata if not provided
	let delegate = delegateAddress;
	if (!delegate) {
		try {
			const url = `/api/permissions/metadata?agentId=${encodeURIComponent(agentId)}&chainId=${encodeURIComponent(chainId)}`;
			const res = await fetch(url);
			const data = res.ok ? await res.json() : null;
			delegate = data?.delegations?.[0]?.delegate ?? null;
		} catch {
			/* ignore */
		}
	}
	if (!delegate) {
		return { ok: false, reason: 'delegate_address_unknown' };
	}

	// 3. Normalize preset — convert maxAmount from base units to display units
	const tokens = tokensForChain(chainId);
	const tokenMeta = preset?.token
		? tokens.find((t) => t.address.toLowerCase() === preset.token.toLowerCase())
		: null;
	const decimals = tokenMeta?.decimals ?? 6;

	const presets = {};
	if (preset?.token) presets.token = preset.token;
	if (preset?.period) presets.period = preset.period;
	if (preset?.targets) presets.targets = preset.targets;
	if (preset?.maxAmount) presets.amount = String(Number(preset.maxAmount) / 10 ** decimals);
	if (preset?.expiry_days) {
		presets.expiry = '30d';
	}

	return new GrantPermissionsModal({
		agentId,
		chainId,
		delegatorAddress,
		delegateAddress: delegate,
		presets,
	}).open();
}
