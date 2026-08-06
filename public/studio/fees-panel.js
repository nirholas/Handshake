// Fees & rewards panel — post-launch control surface for a coin's creator fees
// and delegated reward splits. Mounted inside the studio's existing-token view
// (and reusable on the avatar page).
//
// Capabilities, all wired to real on-chain state via /api/pump/*:
//   • Show claimable creator fees (pump native vault + AMM WSOL vault).
//   • Claim creator fees — connected-wallet creator signs, or the agent
//     custodial wallet signs server-side (collect-creator-fee-agent).
//   • Delegate fees to a team / GitHub contributors (fee-sharing config) — the
//     "reward coin" mechanism. Route rewards to a single GitHub account (the
//     "$THREE → @nirholas" pattern) or import a whole repo's contributors,
//     assign a wallet + share to each, and write the split on-chain. A GitHub
//     handle is resolved to its three.ws-linked Solana payout wallet via
//     resolve-github-shareholder so the split pays a real, claimable address.
//   • Distribute / claim-if-delegated — anyone (creator, agent, or a delegated
//     shareholder) can crank distribution to release accrued shares.
//
// Entry:
//   mountFeesPanel(el, {
//     mint, network, creator, agentId, avatarId, symbol, name, getUser
//   }) → { teardown }

// ── Pure helpers (tested) ────────────────────────────────────────────────────

// Parse "owner/repo" (or a full GitHub URL) into { owner, repo } or null.
export function parseGithubRepo(input) {
	const s = String(input || '').trim();
	if (!s) return null;
	const m = s.match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
	if (!m) return null;
	const owner = m[1], repo = m[2];
	if (!owner || !repo || owner === 'github.com') return null;
	return { owner, repo };
}

// Parse a single GitHub account from "@login", "login", or a profile URL into
// the bare login, or null. GitHub logins are alphanumeric with single internal
// hyphens, 1–39 chars. Used for the "route rewards to one GitHub user" path;
// the caller tries parseGithubRepo first, so an "owner/repo" never lands here.
export function parseGithubAccount(input) {
	let s = String(input || '').trim().replace(/^@/, '');
	if (!s) return null;
	s = s.replace(/^https?:\/\//i, '').replace(/^github\.com\//i, '');
	const login = s.split('/')[0].replace(/\/+$/, '');
	if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)) return null;
	return login;
}

// Convert contributor weights into integer basis points summing to exactly
// 10000. Largest-remainder method; the heaviest row absorbs any rounding drift.
export function weightsToBps(weights) {
	const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
	if (total <= 0 || weights.length === 0) return weights.map(() => 0);
	const raw = weights.map((w) => (Math.max(0, w) / total) * 10_000);
	const floored = raw.map((x) => Math.floor(x));
	let remainder = 10_000 - floored.reduce((a, b) => a + b, 0);
	const order = raw
		.map((x, i) => ({ i, frac: x - Math.floor(x) }))
		.sort((a, b) => b.frac - a.frac);
	for (let k = 0; k < order.length && remainder > 0; k++, remainder--) floored[order[k].i] += 1;
	return floored;
}

// Validate a shareholder split. Returns { ok, errors[], totalBps }.
export function validateShareSplit(rows) {
	const errors = [];
	const clean = rows.filter((r) => r.address?.trim() || r.bps > 0);
	if (clean.length === 0) errors.push('Add at least one recipient.');
	if (clean.length > 10) errors.push('Maximum 10 recipients.');
	const seen = new Set();
	for (const r of clean) {
		const a = (r.address || '').trim();
		if (!a) { errors.push('Every recipient needs a wallet address.'); continue; }
		if (a.length < 32 || a.length > 44) errors.push(`Invalid wallet: ${a.slice(0, 8)}…`);
		if (seen.has(a)) errors.push(`Duplicate wallet: ${a.slice(0, 8)}…`);
		seen.add(a);
		if (!(r.bps > 0)) errors.push('Every recipient needs a share above 0%.');
	}
	const totalBps = clean.reduce((s, r) => s + (r.bps || 0), 0);
	if (clean.length && totalBps !== 10_000)
		errors.push(`Shares must total 100% (currently ${(totalBps / 100).toFixed(1)}%).`);
	return { ok: errors.length === 0, errors: [...new Set(errors)], totalBps };
}

// ── DOM utilities ─────────────────────────────────────────────────────────────

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const shortAddr = (a) => (!a || a.length < 10 ? a || '' : a.slice(0, 4) + '…' + a.slice(-4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = (typeof window !== 'undefined' && window.location?.origin
	? window.location.origin
	: 'https://three.ws') + '/api/solana-rpc';
const SOLSCAN = (sig, net) => `https://solscan.io/tx/${sig}${net === 'devnet' ? '?cluster=devnet' : ''}`;

function detectWallet() {
	if (typeof window === 'undefined') return null;
	return window.phantom?.solana || window.solana || window.backpack || window.solflare || null;
}

let _web3;
async function loadWeb3() {
	if (!_web3) _web3 = await import('https://esm.sh/@solana/web3.js@1.98.4');
	return _web3;
}

function friendlyError(msg) {
	const m = String(msg || '');
	if (/user rejected|rejected the request/i.test(m)) return 'Signing cancelled.';
	if (/0x1\b|insufficient.*lamports|insufficient.*sol/i.test(m)) return 'Not enough SOL to cover the network fee.';
	if (/creator_mismatch|connected wallet/i.test(m)) return m;
	if (/429|rate.limit/i.test(m)) return 'Too many requests — wait a moment and try again.';
	if (/no bonding curve|not_found/i.test(m)) return 'This coin is not on pump.fun yet.';
	return m;
}

// ── CSS ────────────────────────────────────────────────────────────────────────

const FP_CSS = `
.fp{display:flex;flex-direction:column;gap:.7rem;margin-top:.85rem;padding-top:.85rem;
  border-top:1px solid rgba(255,255,255,.07)}
.fp-head{display:flex;align-items:center;gap:.5rem}
.fp-head-t{font-size:.78rem;font-weight:600;color:rgba(255,255,255,.82);letter-spacing:-.01em}
.fp-badge{font-size:.6rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  padding:.16rem .45rem;border-radius:999px;margin-left:auto}
.fp-badge.creator{color:#c8f0d8;background:rgba(164,240,188,.1);border:1px solid rgba(164,240,188,.25)}
.fp-badge.split{color:rgba(255,255,255,.7);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15)}
.fp-badge.cashback{color:#a8c4f0;background:rgba(120,160,240,.1);border:1px solid rgba(120,160,240,.28)}

.fp-loading{display:flex;align-items:center;gap:.5rem;font-size:.74rem;color:rgba(255,255,255,.36);
  padding:.5rem 0}
@keyframes fp-spin{to{transform:rotate(360deg)}}
.fp-spin{width:13px;height:13px;border:2px solid rgba(255,255,255,.12);border-top-color:rgba(255,255,255,.5);
  border-radius:50%;animation:fp-spin .8s linear infinite;flex-shrink:0}

.fp-claim{display:flex;align-items:center;gap:.7rem;padding:.7rem .8rem;border-radius:11px;
  background:rgba(164,240,188,.05);border:1px solid rgba(164,240,188,.16)}
.fp-claim-amt{flex:1;min-width:0}
.fp-claim-n{font-size:1.15rem;font-weight:700;color:#fff;letter-spacing:-.02em;line-height:1.1}
.fp-claim-n small{font-size:.7rem;font-weight:500;color:rgba(255,255,255,.4);margin-left:.2rem}
.fp-claim-l{font-size:.64rem;color:rgba(255,255,255,.4);margin-top:.15rem}
.fp-btn{padding:.5rem .85rem;border-radius:8px;cursor:pointer;font-size:.78rem;font-weight:600;
  white-space:nowrap;transition:all .15s;line-height:1.1;border:1px solid transparent}
.fp-btn.primary{background:linear-gradient(135deg,rgba(120,200,140,.24),rgba(60,140,100,.16));
  border-color:rgba(120,200,140,.45);color:#d2f3df}
.fp-btn.primary:hover:not([disabled]){background:linear-gradient(135deg,rgba(120,200,140,.36),rgba(60,140,100,.24));
  border-color:rgba(120,200,140,.7)}
.fp-btn.ghost{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:rgba(255,255,255,.7)}
.fp-btn.ghost:hover:not([disabled]){background:rgba(255,255,255,.1);color:#fff}
.fp-btn.violet{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.17);color:rgba(255,255,255,.85)}
.fp-btn.violet:hover:not([disabled]){background:rgba(255,255,255,.11)}
.fp-btn[disabled]{opacity:.45;cursor:not-allowed}
.fp-btn.busy{opacity:.7;cursor:wait}

.fp-note{font-size:.69rem;color:rgba(255,255,255,.45);line-height:1.5;padding:.5rem .65rem;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:8px}
.fp-note.warn{color:rgba(246,200,114,.9);background:rgba(246,200,114,.06);border-color:rgba(246,200,114,.2)}
.fp-note.you{color:#c8f0d8;background:rgba(164,240,188,.07);border-color:rgba(164,240,188,.22)}
.fp-err{font-size:.72rem;color:#f6b3b3;padding:.45rem .6rem;border-radius:8px;line-height:1.45;
  background:rgba(246,179,179,.07);border:1px solid rgba(246,179,179,.18)}
.fp-ok{font-size:.72rem;color:#a4f0bc;padding:.45rem .6rem;border-radius:8px;line-height:1.45;
  background:rgba(164,240,188,.08);border:1px solid rgba(164,240,188,.22);display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.fp-ok a{color:#c8f0d8;text-decoration:none;border-bottom:1px solid rgba(200,240,216,.3)}

.fp-deleg{display:flex;flex-direction:column;gap:.55rem}
.fp-deleg-title{font-size:.72rem;font-weight:600;color:rgba(255,255,255,.7)}
.fp-share-row{display:flex;align-items:center;gap:.45rem}
.fp-share-row .fp-sh-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:.15rem}
.fp-share-addr{width:100%;padding:.4rem .55rem;border-radius:7px;outline:none;font-size:.74rem;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);color:#fff;
  font-family:ui-monospace,monospace;box-sizing:border-box;transition:border-color .15s}
.fp-share-addr:focus{border-color:rgba(255,255,255,.28)}
.fp-share-addr::placeholder{color:rgba(255,255,255,.22);font-family:inherit}
.fp-share-gh{font-size:.62rem;color:rgba(255,255,255,.4);display:flex;align-items:center;gap:.3rem}
.fp-share-gh img{width:13px;height:13px;border-radius:50%}
.fp-share-pct{width:62px;flex-shrink:0;padding:.4rem .4rem;border-radius:7px;outline:none;font-size:.74rem;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);color:#fff;text-align:right;
  font-family:ui-monospace,monospace;box-sizing:border-box}
.fp-share-pct:focus{border-color:rgba(255,255,255,.28)}
.fp-share-x{flex-shrink:0;width:26px;height:26px;border-radius:6px;cursor:pointer;line-height:1;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.5);font-size:.85rem}
.fp-share-x:hover{background:rgba(246,179,179,.12);border-color:rgba(246,179,179,.3);color:#f6b3b3}
.fp-deleg-foot{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.fp-deleg-total{font-size:.7rem;font-family:ui-monospace,monospace;margin-right:auto}
.fp-deleg-total.ok{color:#a4f0bc}
.fp-deleg-total.bad{color:rgba(246,200,114,.9)}
.fp-add{padding:.35rem .6rem;border-radius:7px;cursor:pointer;font-size:.7rem;
  background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.16);color:rgba(255,255,255,.6)}
.fp-add:hover{color:#fff;border-color:rgba(255,255,255,.3)}

.fp-gh{display:flex;gap:.4rem;align-items:center}
.fp-gh input{flex:1;min-width:0;padding:.42rem .6rem;border-radius:7px;outline:none;font-size:.74rem;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);color:#fff;box-sizing:border-box}
.fp-gh input:focus{border-color:rgba(255,255,255,.28)}
.fp-gh input::placeholder{color:rgba(255,255,255,.25)}
.fp-gh-hint{font-size:.63rem;color:rgba(255,255,255,.4);line-height:1.45;margin-top:-.15rem}
.fp-gh-hint b{color:rgba(255,255,255,.62);font-weight:600}
.fp-gh-modes{display:flex;gap:.3rem}
.fp-gh-mode{flex:1;padding:.34rem .5rem;border-radius:7px;cursor:pointer;font-size:.66rem;font-weight:600;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);color:rgba(255,255,255,.5);transition:all .15s}
.fp-gh-mode:hover{color:rgba(255,255,255,.8);border-color:rgba(255,255,255,.18)}
.fp-gh-mode.on{background:rgba(120,160,240,.12);border-color:rgba(120,160,240,.4);color:#bcd0f5}

.fp-holders{display:flex;flex-direction:column;gap:.3rem}
.fp-holder{display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;border-radius:8px;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);font-size:.73rem}
.fp-holder code{flex:1;min-width:0;font-family:ui-monospace,monospace;color:rgba(255,255,255,.6);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-holder .fp-holder-pct{font-weight:600;color:rgba(255,255,255,.85)}
.fp-holder.is-you{background:rgba(164,240,188,.06);border-color:rgba(164,240,188,.2)}
.fp-holder.is-you .fp-holder-pct{color:#a4f0bc}
.fp-holder .fp-you-tag{font-size:.58rem;font-weight:600;color:#0c1410;background:#a4f0bc;
  padding:.05rem .3rem;border-radius:4px;letter-spacing:.03em}

.fp-cta{display:flex;align-items:center;gap:.6rem;padding:.6rem .7rem;border-radius:10px;cursor:pointer;
  background:rgba(255,255,255,.03);border:1px dashed rgba(255,255,255,.14);transition:all .15s}
.fp-cta:hover{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.22)}
.fp-cta-ic{font-size:1.1rem;line-height:1}
.fp-cta-b{flex:1;min-width:0}
.fp-cta-t{font-size:.76rem;font-weight:600;color:rgba(255,255,255,.85)}
.fp-cta-s{font-size:.65rem;color:rgba(255,255,255,.45);margin-top:.1rem;line-height:1.4}
.fp-cta-arrow{color:rgba(255,255,255,.45);font-size:.9rem}

.fp-wallet{display:flex;align-items:center;gap:.5rem;font-size:.7rem;color:rgba(255,255,255,.5);
  padding:.45rem .6rem;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.fp-wallet .fp-w-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.2);flex-shrink:0}
.fp-wallet.on .fp-w-dot{background:#a4f0bc;box-shadow:0 0 6px rgba(164,240,188,.45)}
.fp-wallet code{font-family:ui-monospace,monospace;color:rgba(255,255,255,.62)}
.fp-wallet .fp-w-btn{margin-left:auto;padding:.26rem .55rem;border-radius:6px;cursor:pointer;font-size:.68rem;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.75)}
.fp-wallet .fp-w-btn:hover{background:rgba(255,255,255,.12);color:#fff}
`;

let _cssInjected = false;
function injectCss() {
	if (_cssInjected || typeof document === 'undefined') return;
	_cssInjected = true;
	const el = document.createElement('style');
	el.textContent = FP_CSS;
	document.head.appendChild(el);
}

// ── Mount ──────────────────────────────────────────────────────────────────────

export function mountFeesPanel(container, opts = {}) {
	injectCss();
	const { mint, network = 'mainnet', creator, agentId, avatarId, symbol = 'TOKEN', getUser } = opts;

	const s = {
		info: null, loading: true, loadError: '',
		wallet: null,                 // { provider, address }
		agentWalletAddress: undefined, // undefined=unresolved, null=none, string=addr
		busy: '',                      // action label while a tx is in flight
		actionError: '', actionOk: null, // { label, sig }
		editing: false,
		rows: [],                      // [{ address, pct, gh?:{login,avatar} }]
		githubRepo: '', githubBusy: false, githubError: '',
		ghMode: 'contributors', // 'contributors' = split a repo; 'owner' = repo owner/creator gets 100%
	};

	let _alive = true;

	// Is the agent custodial wallet the on-chain creator? → server-signed path.
	const isAgentCreator = () =>
		s.agentWalletAddress && creator && s.agentWalletAddress === creator;
	// Connected wallet matches the creator → it can sign creator-only actions.
	const connectedIsCreator = () => s.wallet?.address && creator && s.wallet.address === creator;
	// Connected wallet is one of the delegated shareholders.
	const youAreShareholder = () => {
		const holders = s.info?.sharing_config?.shareholders || [];
		return !!(s.wallet?.address && holders.some((h) => h.address === s.wallet.address));
	};

	const agentBody = () => (agentId ? { agent_id: agentId } : { avatar_id: avatarId });

	// ── Data ──────────────────────────────────────────────────────────────────

	async function loadInfo() {
		s.loading = true; s.loadError = '';
		render();
		try {
			const r = await fetch(`/api/pump/fee-info?mint=${encodeURIComponent(mint)}&network=${network}`,
				{ credentials: 'include' });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
			s.info = data;
		} catch (e) {
			s.loadError = friendlyError(e.message || String(e));
		}
		s.loading = false;
		render();
	}

	// Resolve the agent custodial wallet address once, so we know whether to use
	// the server-signed path. Best-effort — failure just falls back to connected.
	async function resolveAgentWallet() {
		if (!agentId && !avatarId) { s.agentWalletAddress = null; return; }
		try {
			const r = await fetch('/api/pump/agent-wallet', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...agentBody(), network }),
			});
			const data = await r.json();
			s.agentWalletAddress = r.ok ? (data.address || null) : null;
		} catch { s.agentWalletAddress = null; }
		render();
	}

	async function tryAutoConnect() {
		const w = detectWallet();
		if (!w?.isConnected || !w.publicKey) return;
		const addr = w.publicKey.toBase58?.() || w.publicKey.toString?.();
		if (addr) { s.wallet = { provider: w, address: addr }; render(); }
	}

	async function connectWallet() {
		const w = detectWallet();
		if (!w) { window.open('https://phantom.app/', '_blank', 'noopener'); return; }
		try {
			if (!w.isConnected) await w.connect?.();
			const addr = w.publicKey?.toBase58?.() || w.publicKey?.toString?.();
			if (addr) { s.wallet = { provider: w, address: addr }; s.actionError = ''; render(); }
		} catch { /* dismissed */ }
	}

	// ── Transaction helpers ─────────────────────────────────────────────────────

	async function pollConfirm(conn, sig, timeoutMs = 75_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
			const st = value?.[0];
			if (st) {
				if (st.err) throw new Error(`On-chain error: ${JSON.stringify(st.err)}`);
				if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
			}
			await sleep(2000);
		}
		throw new Error('Confirmation timed out — the transaction may still land. Check Solscan.');
	}

	async function signSendPrep(txBase64) {
		const { VersionedTransaction, Connection } = await loadWeb3();
		const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0)));
		const signed = await s.wallet.provider.signTransaction(tx);
		const conn = new Connection(RPC_URL, 'confirmed');
		const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
		await pollConfirm(conn, sig);
		return sig;
	}

	function finishAction(label, sig) {
		s.busy = ''; s.actionError = '';
		s.actionOk = { label, sig };
		render();
		loadInfo(); // refresh on-chain truth
	}

	function failAction(e) {
		s.busy = ''; s.actionError = friendlyError(e.message || String(e)); render();
	}

	// ── Actions ─────────────────────────────────────────────────────────────────

	async function claimCreatorFees() {
		if (s.busy) return;
		s.busy = 'Claiming…'; s.actionError = ''; s.actionOk = null; render();
		try {
			let sig;
			if (isAgentCreator()) {
				const r = await fetch('/api/pump/collect-creator-fee-agent', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...agentBody(), mint, network }),
				});
				const d = await r.json();
				if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
				sig = d.signature;
			} else {
				if (!s.wallet) { await connectWallet(); if (!s.wallet) { s.busy = ''; render(); return; } }
				const r = await fetch('/api/pump/collect-creator-fee-prep', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ creator_address: creator, wallet_address: s.wallet.address, network }),
				});
				const d = await r.json();
				if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
				sig = await signSendPrep(d.tx_base64);
			}
			finishAction('Creator fees claimed', sig);
		} catch (e) { failAction(e); }
	}

	async function distribute() {
		if (s.busy) return;
		s.busy = 'Distributing…'; s.actionError = ''; s.actionOk = null; render();
		try {
			let sig;
			// Prefer the connected wallet (so a delegated shareholder can crank it);
			// fall back to the agent wallet when the agent is the creator.
			if (s.wallet) {
				const r = await fetch('/api/pump/distribute-creator-fees-prep', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ mint, wallet_address: s.wallet.address, network }),
				});
				const d = await r.json();
				if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
				sig = await signSendPrep(d.tx_base64);
			} else if (isAgentCreator()) {
				const r = await fetch('/api/pump/distribute-creator-fees-agent', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...agentBody(), mint, network }),
				});
				const d = await r.json();
				if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
				sig = d.signature;
			} else {
				await connectWallet(); s.busy = ''; render(); return;
			}
			finishAction('Rewards distributed to shareholders', sig);
		} catch (e) { failAction(e); }
	}

	async function saveDelegation() {
		const split = validateShareSplit(s.rows);
		if (!split.ok) { s.actionError = split.errors[0]; render(); return; }
		const shareholders = s.rows
			.filter((r) => r.address?.trim() && r.bps > 0)
			.map((r) => ({ address: r.address.trim(), share_bps: r.bps }));

		s.busy = 'Saving split…'; s.actionError = ''; s.actionOk = null; render();
		try {
			if (isAgentCreator()) {
				const r = await fetch('/api/pump/fee-sharing-agent', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...agentBody(), mint, network, shareholders }),
				});
				const d = await r.json();
				if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
				s.editing = false;
				finishAction('Reward split saved on-chain', d.signatures?.[d.signatures.length - 1]);
			} else {
				// Connected-wallet creator: create config (if needed) then set shares,
				// signing each step in the wallet.
				if (!s.wallet) { await connectWallet(); if (!s.wallet) { s.busy = ''; render(); return; } }
				if (!s.info?.has_sharing_config) {
					s.busy = 'Creating config…'; render();
					const cr = await fetch('/api/pump/create-fee-sharing-prep', {
						method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ mint, creator_address: creator, wallet_address: s.wallet.address, network }),
					});
					const cd = await cr.json();
					if (!cr.ok) throw new Error(cd.error_description || cd.error || `HTTP ${cr.status}`);
					await signSendPrep(cd.tx_base64);
				}
				s.busy = 'Setting shares…'; render();
				const current = (s.info?.sharing_config?.shareholders || []).map((h) => h.address);
				const ur = await fetch('/api/pump/update-fee-shares-prep', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						mint, wallet_address: s.wallet.address, network,
						current_shareholders: current.length ? current : [creator],
						new_shareholders: shareholders,
					}),
				});
				const ud = await ur.json();
				if (!ur.ok) throw new Error(ud.error_description || ud.error || `HTTP ${ur.status}`);
				const sig = await signSendPrep(ud.tx_base64);
				s.editing = false;
				finishAction('Reward split saved on-chain', sig);
			}
		} catch (e) { failAction(e); }
	}

	// ── GitHub import ─────────────────────────────────────────────────────────────

	// Dispatch the recipient input — routes rewards to anyone, not just GitHub:
	//   • a raw Solana wallet (base58)          → added directly
	//   • an X handle ("x:@naval", x.com/naval)  → resolved via X (platform 1)
	//   • an "owner/repo"                        → repo owner (owner mode) or split
	//   • a bare "@login"                        → that GitHub account
	async function importGithub() {
		const raw = (s.githubRepo || '').trim();
		// Raw Solana wallet → direct recipient, no resolution needed.
		if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return addWalletRecipient(raw);
		// Explicit X (Twitter): "x:@handle", "x/handle", or an x.com / twitter.com URL.
		const xm = raw.match(/^(?:x:|x\/|(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/)@?([A-Za-z0-9_]{1,15})$/i);
		if (xm) return addSocialAccount('x', xm[1]);
		const repo = parseGithubRepo(raw);
		if (repo) {
			if (s.ghMode === 'owner') return addSocialAccount('github', repo.owner);
			return importGithubRepo(repo);
		}
		const login = parseGithubAccount(raw);
		if (login) return addSocialAccount('github', login);
		s.githubError = 'Enter a GitHub @user, an X handle (x:@handle), an owner/repo, or a Solana wallet.';
		render();
	}

	// Add a raw Solana wallet (or SNS-resolved address) as a direct recipient.
	function addWalletRecipient(address) {
		s.rows = s.rows.filter((r) => r.address?.trim() || r.gh);
		if (s.rows.some((r) => r.address === address)) { s.githubError = 'That wallet is already a recipient.'; render(); return; }
		if (s.rows.length >= 10) { s.githubError = 'Maximum 10 recipients.'; render(); return; }
		s.rows.push({ address, bps: s.rows.length === 0 ? 10_000 : 0 });
		s.githubRepo = ''; s.githubError = ''; s.editing = true; render();
	}

	// Single social account (GitHub or X) → one reward recipient. Resolves the
	// handle to its three.ws-linked Solana payout wallet; if the user hasn't linked
	// one, the row is flagged so the creator can paste a wallet or ask them to link.
	async function addSocialAccount(platform, login) {
		const isX = platform === 'x';
		// Drop blank seed rows (the setup CTA leaves one empty 100% row).
		s.rows = s.rows.filter((r) => r.address?.trim() || r.gh);
		if (s.rows.some((r) => r.gh?.platform === platform && r.gh?.login?.toLowerCase() === login.toLowerCase())) {
			s.githubError = `@${login} is already a recipient.`; render(); return;
		}
		if (s.rows.length >= 10) { s.githubError = 'Maximum 10 recipients.'; render(); return; }
		s.githubBusy = true; s.githubError = '';
		const row = {
			address: '', bps: s.rows.length === 0 ? 10_000 : 0,
			gh: {
				platform, login,
				avatar: isX ? `https://unavatar.io/x/${esc(login)}` : `https://github.com/${esc(login)}.png?size=40`,
				url: isX ? `https://x.com/${esc(login)}` : `https://github.com/${esc(login)}`,
				resolving: true,
			},
		};
		s.rows.push(row); s.editing = true; render();
		try {
			const r = await fetch('/api/pump/resolve-github-shareholder', {
				method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ platform, username: login, network }),
			});
			const d = await r.json();
			if (r.ok && d.mode === 'wallet' && d.address) {
				row.address = d.address; row.gh.linked = true;
				s.githubRepo = '';
			} else {
				row.gh.unlinked = true;
				s.githubError = d.note
					|| `@${login} has no three.ws-linked Solana wallet yet — paste their wallet, or ask them to link one on three.ws to claim directly.`;
			}
		} catch (e) {
			row.gh.unlinked = true; s.githubError = friendlyError(e.message || String(e));
		}
		row.gh.resolving = false; s.githubBusy = false;
		if (_alive) render();
	}

	async function importGithubRepo(parsed) {
		s.githubBusy = true; s.githubError = ''; render();
		try {
			const r = await fetch(
				`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contributors?per_page=10`,
				{ headers: { accept: 'application/vnd.github+json' } });
			if (r.status === 404) throw new Error('Repository not found.');
			if (r.status === 403) throw new Error('GitHub rate limit hit — try again in a minute.');
			if (!r.ok) throw new Error(`GitHub error ${r.status}`);
			const contributors = (await r.json())
				.filter((c) => c.type === 'User')
				.slice(0, 10);
			if (!contributors.length) throw new Error('No contributors found on that repo.');
			const bps = weightsToBps(contributors.map((c) => c.contributions || 1));
			s.rows = contributors.map((c, i) => ({
				address: '', bps: bps[i],
				gh: { login: c.login, avatar: c.avatar_url, url: c.html_url, resolving: true },
			}));
			s.editing = true;
			render();
			// Auto-resolve each contributor to their three.ws-linked Solana payout
			// wallet so the reward split pays real people without manual address
			// entry. Best-effort and in parallel — anyone we can't resolve is left
			// for manual entry (or removal).
			resolveContributorWallets();
		} catch (e) {
			s.githubError = friendlyError(e.message || String(e));
			s.githubBusy = false;
			render();
		}
		s.githubBusy = false;
		render();
	}

	// Fill in each GitHub contributor's linked Solana wallet via the
	// resolve-github-shareholder bridge. Only auto-fills a real linked wallet
	// ('wallet' mode) so the split always pays a claimable address; contributors
	// with no three.ws wallet are flagged so the creator can add one or drop them.
	async function resolveContributorWallets() {
		await Promise.all(s.rows.map(async (row) => {
			if (!row.gh?.login || row.address) { if (row.gh) row.gh.resolving = false; return; }
			try {
				const r = await fetch('/api/pump/resolve-github-shareholder', {
					method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ github_username: row.gh.login, network }),
				});
				const d = await r.json();
				if (r.ok && d.mode === 'wallet' && d.address) {
					row.address = d.address;
					row.gh.linked = true;
				} else {
					row.gh.unlinked = true;
				}
			} catch { row.gh.unlinked = true; }
			row.gh.resolving = false;
		}));
		if (_alive) render();
	}

	// ── Delegation editor row helpers ─────────────────────────────────────────────

	function startEditing(seed) {
		s.rows = seed && seed.length
			? seed.map((h) => ({ address: h.address, bps: h.bps }))
			: [{ address: '', bps: 10_000 }];
		s.editing = true; s.actionError = ''; render();
	}
	function addRow() { if (s.rows.length < 10) { s.rows.push({ address: '', bps: 0 }); render(); } }
	function removeRow(i) { s.rows.splice(i, 1); render(); }

	// ── Render ────────────────────────────────────────────────────────────────────

	function render() {
		if (!_alive) return;
		if (s.loading && !s.info) { renderLoading(); return; }
		if (s.loadError && !s.info) { renderLoadError(); return; }
		renderMain();
	}

	function renderLoading() {
		container.innerHTML = `<div class="fp"><div class="fp-loading"><div class="fp-spin"></div>Reading on-chain fees…</div></div>`;
	}

	function renderLoadError() {
		container.innerHTML = `<div class="fp">
			<div class="fp-head"><span class="fp-head-t">Fees &amp; rewards</span></div>
			<div class="fp-err">${esc(s.loadError)}</div>
			<button class="fp-btn ghost" id="fp-retry">Retry</button>
		</div>`;
		container.querySelector('#fp-retry')?.addEventListener('click', loadInfo);
	}

	function renderMain() {
		const info = s.info || {};
		const dest = info.fee_destination;
		const badge = dest === 'sharing_config'
			? `<span class="fp-badge split">Delegated split</span>`
			: dest === 'cashback'
				? `<span class="fp-badge cashback">Trader cashback</span>`
				: `<span class="fp-badge creator">Creator fees</span>`;

		const okBlock = s.actionOk
			? `<div class="fp-ok">✓ ${esc(s.actionOk.label)}${s.actionOk.sig
				? ` · <a href="${esc(SOLSCAN(s.actionOk.sig, network))}" target="_blank" rel="noopener">view ↗</a>` : ''}</div>`
			: '';
		const errBlock = s.actionError ? `<div class="fp-err">${esc(s.actionError)}</div>` : '';

		container.innerHTML = `<div class="fp">
			<div class="fp-head"><span class="fp-head-t">Fees &amp; rewards</span>${badge}</div>
			${renderClaim(info)}
			${okBlock}${errBlock}
			${renderDelegation(info)}
			${renderSignerHint(info)}
		</div>`;

		wire();
	}

	function renderClaim(info) {
		if (info.is_cashback_coin) {
			return `<div class="fp-note">This coin returns trading fees to holders as <b>cashback</b> — there's no creator vault to claim. Traders claim their own cashback from pump.fun.</div>`;
		}
		const sol = Number(info.claimable_sol || 0);
		const has = sol > 0.0000001;
		const amt = sol < 0.001 && has ? sol.toFixed(6) : sol.toFixed(4);
		const inFlight = s.busy === 'Claiming…' || s.busy === 'Distributing…';
		// When fees are delegated, the claim button cranks distribution instead of
		// pulling to a single creator.
		const delegated = info.fee_destination === 'sharing_config';
		const label = delegated ? 'Distribute' : 'Claim';
		const action = delegated ? 'distribute' : 'claim';
		const sub = delegated ? 'Accrued · splits to shareholders' : 'Claimable creator fees';
		return `<div class="fp-claim">
			<div class="fp-claim-amt">
				<div class="fp-claim-n">${amt}<small>SOL</small></div>
				<div class="fp-claim-l">${sub}</div>
			</div>
			<button class="fp-btn primary${inFlight ? ' busy' : ''}" id="fp-claim" data-action="${action}" ${(!has || s.busy) ? 'disabled' : ''}>
				${inFlight ? s.busy : label}
			</button>
		</div>`;
	}

	function renderDelegation(info) {
		if (info.is_cashback_coin) return '';

		// Editing mode — shareholder split editor + GitHub import.
		if (s.editing) return renderEditor(info);

		// Existing on-chain split.
		if (info.has_sharing_config && info.sharing_config?.shareholders?.length) {
			const holders = info.sharing_config.shareholders;
			const rowsHtml = holders.map((h) => {
				const you = s.wallet?.address === h.address;
				return `<div class="fp-holder${you ? ' is-you' : ''}">
					<code title="${esc(h.address)}">${esc(shortAddr(h.address))}</code>
					${you ? `<span class="fp-you-tag">YOU</span>` : ''}
					<span class="fp-holder-pct">${(h.bps / 100).toFixed(1)}%</span>
				</div>`;
			}).join('');
			const youNote = youAreShareholder()
				? `<div class="fp-note you">You're delegated ${(holders.find((h) => h.address === s.wallet.address).bps / 100).toFixed(1)}% of creator fees. Hit <b>Distribute</b> above to release accrued rewards to every shareholder, including you.</div>`
				: '';
			const canEdit = isAgentCreator() || connectedIsCreator();
			return `<div class="fp-deleg">
				<div class="fp-deleg-title">Reward split — ${holders.length} recipient${holders.length === 1 ? '' : 's'}</div>
				<div class="fp-holders">${rowsHtml}</div>
				${youNote}
				${canEdit ? `<div class="fp-deleg-foot"><button class="fp-btn ghost" id="fp-edit">Edit split</button></div>` : ''}
			</div>`;
		}

		// No split yet — offer to set one up (gated by graduation).
		if (!info.is_graduated) {
			return `<div class="fp-note warn">🎁 <b>Delegated rewards</b> unlock once this coin graduates to the AMM (reaches the bonding-curve cap). Until then, all creator fees go to the creator and can be claimed above.</div>`;
		}
		return `<div class="fp-cta" id="fp-setup" role="button" tabindex="0">
			<span class="fp-cta-ic">🎁</span>
			<div class="fp-cta-b">
				<div class="fp-cta-t">Delegate fees as rewards</div>
				<div class="fp-cta-s">Split creator fees across a team or GitHub contributors. Each delegated wallet can claim its share.</div>
			</div>
			<span class="fp-cta-arrow">→</span>
		</div>`;
	}

	function renderEditor(info) {
		const split = validateShareSplit(s.rows);
		const totalPct = (split.totalBps / 100).toFixed(1);
		const totalCls = split.totalBps === 10_000 ? 'ok' : 'bad';
		const rowsHtml = s.rows.map((r, i) => `
			<div class="fp-share-row" data-i="${i}">
				<div class="fp-sh-meta">
					<input class="fp-share-addr" data-i="${i}" placeholder="Recipient Solana wallet" value="${esc(r.address)}" spellcheck="false" />
					${r.gh ? `<span class="fp-share-gh"><img src="${esc(r.gh.avatar)}" alt="" data-fallback="hide" />${r.gh.platform === 'x' ? '𝕏 ' : ''}@${esc(r.gh.login)}${
						r.gh.resolving ? ` · <span style="color:rgba(255,255,255,.4)">resolving…</span>`
						: r.gh.linked ? ` · <span style="color:#a4f0bc">linked ✓</span>`
						: r.gh.unlinked ? ` · <span style="color:rgba(246,200,114,.9)" title="No three.ws-linked Solana wallet — paste theirs, or ask them to link a wallet on three.ws">add wallet</span>`
						: ''
					}</span>` : ''}
				</div>
				<input class="fp-share-pct" data-i="${i}" type="number" min="0" max="100" step="0.1" value="${(r.bps / 100).toFixed(1)}" />
				<button class="fp-share-x" data-i="${i}" title="Remove">✕</button>
			</div>`).join('');

		const busy = !!s.busy;
		return `<div class="fp-deleg">
			<div class="fp-deleg-title">🎁 Reward split — delegate creator fees</div>
			<div class="fp-gh-modes">
				<button class="fp-gh-mode${s.ghMode === 'contributors' ? ' on' : ''}" data-mode="contributors">Split contributors</button>
				<button class="fp-gh-mode${s.ghMode === 'owner' ? ' on' : ''}" data-mode="owner">Owner / creator only</button>
			</div>
			<div class="fp-gh">
				<input id="fp-gh-input" placeholder="@github · x:@handle · owner/repo · or a Solana wallet" value="${esc(s.githubRepo)}" spellcheck="false" />
				<button class="fp-btn violet${s.githubBusy ? ' busy' : ''}" id="fp-gh-go" ${s.githubBusy ? 'disabled' : ''}>${s.githubBusy ? 'Resolving…' : 'Add'}</button>
			</div>
			<div class="fp-gh-hint">${s.ghMode === 'owner'
				? `An <b>owner/repo</b> (or <b>@user</b>) routes <b>100%</b> to that one account — no contributor split.`
				: `Route to a <b>GitHub</b> or <b>X</b> account (<b>x:@handle</b>), a <b>wallet</b>, or split a repo's <b>contributors</b>.`}</div>
			${s.githubError ? `<div class="fp-err">${esc(s.githubError)}</div>` : ''}
			${s.rows.length ? rowsHtml : `<div class="fp-note">Add recipients below or import a GitHub repo's contributors.</div>`}
			<button class="fp-add" id="fp-add" ${s.rows.length >= 10 ? 'disabled' : ''}>+ Add recipient</button>
			<div class="fp-deleg-foot">
				<span class="fp-deleg-total ${totalCls}">Total ${totalPct}%</span>
				<button class="fp-btn ghost" id="fp-cancel" ${busy ? 'disabled' : ''}>Cancel</button>
				<button class="fp-btn primary${busy ? ' busy' : ''}" id="fp-save" ${busy ? 'disabled' : ''}>${busy ? esc(s.busy) : 'Save split on-chain'}</button>
			</div>
			<div class="fp-note">Shares are written to a pump.fun fee-sharing config. ${isAgentCreator() ? 'Your agent wallet signs.' : 'Your connected creator wallet signs (one or two prompts).'} Each recipient can then claim by distributing.</div>
		</div>`;
	}

	// Tell the user which wallet is needed when a creator-only action can't be
	// taken with the current signer.
	function renderSignerHint(info) {
		if (info.is_cashback_coin) return '';
		if (isAgentCreator()) {
			return `<div class="fp-wallet on"><span class="fp-w-dot"></span>Signed by agent wallet <code>${esc(shortAddr(creator))}</code></div>`;
		}
		// Creator is an external wallet — surface connect / mismatch state.
		if (!s.wallet) {
			return `<div class="fp-wallet"><span class="fp-w-dot"></span>Connect the creator wallet to manage fees
				<button class="fp-w-btn" id="fp-connect">Connect</button></div>`;
		}
		if (!connectedIsCreator() && !youAreShareholder()) {
			return `<div class="fp-wallet on"><span class="fp-w-dot"></span>Connected <code>${esc(shortAddr(s.wallet.address))}</code> — creator is <code title="${esc(creator)}">${esc(shortAddr(creator))}</code>. Claiming needs the creator wallet.</div>`;
		}
		return `<div class="fp-wallet on"><span class="fp-w-dot"></span>Connected <code>${esc(shortAddr(s.wallet.address))}</code></div>`;
	}

	// ── Wiring ──────────────────────────────────────────────────────────────────

	function wire() {
		const q = (sel) => container.querySelector(sel);

		q('#fp-claim')?.addEventListener('click', (e) => {
			e.currentTarget.dataset.action === 'distribute' ? distribute() : claimCreatorFees();
		});
		q('#fp-edit')?.addEventListener('click', () => startEditing(s.info?.sharing_config?.shareholders));
		const setup = q('#fp-setup');
		if (setup) {
			setup.addEventListener('click', () => startEditing());
			setup.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEditing(); } });
		}
		q('#fp-connect')?.addEventListener('click', connectWallet);

		// Editor
		q('#fp-add')?.addEventListener('click', addRow);
		q('#fp-cancel')?.addEventListener('click', () => { s.editing = false; s.actionError = ''; render(); });
		q('#fp-save')?.addEventListener('click', saveDelegation);
		q('#fp-gh-go')?.addEventListener('click', importGithub);
		q('#fp-gh-input')?.addEventListener('input', (e) => { s.githubRepo = e.target.value; });
		q('#fp-gh-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); importGithub(); } });
		container.querySelectorAll('.fp-gh-mode').forEach((el) => {
			el.addEventListener('click', (e) => { s.ghMode = e.currentTarget.dataset.mode; s.githubError = ''; render(); });
		});

		container.querySelectorAll('.fp-share-addr').forEach((el) => {
			el.addEventListener('input', (e) => { s.rows[+e.target.dataset.i].address = e.target.value; });
		});
		container.querySelectorAll('.fp-share-pct').forEach((el) => {
			el.addEventListener('input', (e) => {
				const pct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
				s.rows[+e.target.dataset.i].bps = Math.round(pct * 100);
				const t = container.querySelector('.fp-deleg-total');
				const split = validateShareSplit(s.rows);
				if (t) { t.textContent = `Total ${(split.totalBps / 100).toFixed(1)}%`; t.className = `fp-deleg-total ${split.totalBps === 10_000 ? 'ok' : 'bad'}`; }
			});
		});
		container.querySelectorAll('.fp-share-x').forEach((el) => {
			el.addEventListener('click', (e) => removeRow(+e.currentTarget.dataset.i));
		});
	}

	// ── Boot ────────────────────────────────────────────────────────────────────

	render();
	loadInfo();
	resolveAgentWallet();
	tryAutoConnect();

	return {
		teardown() { _alive = false; container.innerHTML = ''; },
	};
}
