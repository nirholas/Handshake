// <avatar-actions> — the per-avatar ownership + wallet control surfaced on every
// place a user interacts with, saves, or edits a 3D avatar.
//
// It expresses one model consistently everywhere:
//   • Saving someone else's avatar is a FORK — it mints a NEW avatar in your
//     namespace (copied model, your owner_id), linked back GitHub-style with
//     "Forked from <owner>". You never co-own one row.
//   • Every avatar's agent has its own custodial wallet, assigned per user. The
//     owner can create it (if missing) and manage it; nobody else can touch it.
//
// Usage (drop into any page):
//   <script type="module" src="/avatar-actions.js"></script>
//   <avatar-actions avatar-id="<uuid>"></avatar-actions>
// Optionally seed data to skip a fetch:
//   el.avatar = avatarObjectFromApi;            // { id, owner_id, agent_id, ... }
// Variants: variant="full" (default) | "compact" (icon-dense, for cards/toolbars)
//
// Emits bubbling CustomEvents the host can react to:
//   'avatar-forked'  detail: { avatar, agent }   — a new fork was created
//   'wallet-created' detail: { agentId, wallet_address, solana_address }

const API = '';

// Both backing endpoints (`/api/avatars/:id`, `/api/agents?avatar_id=`) reject a
// non-uuid id — 404 and 400 respectively. Pages legitimately mount this element
// over a stand-in avatar (the `default` mannequin on /mocap-studio), so match the
// server's contract here and skip the round trip entirely rather than fire two
// requests that can only fail.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _mePromise = null;

function me() {
	if (!_mePromise) {
		_mePromise = fetch(`${API}/api/auth/me`, { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : { user: null }))
			.then((d) => d.user || null)
			.catch(() => null);
	}
	return _mePromise;
}

let _csrf = null;
async function csrfToken() {
	if (_csrf) return _csrf;
	try {
		const r = await fetch(`${API}/api/csrf-token`, { credentials: 'include' });
		if (!r.ok) return null;
		_csrf = (await r.json()).token || null;
	} catch {
		_csrf = null;
	}
	return _csrf;
}

const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

const styles = `
:host { display: block; --aa-fg: var(--text, #f5f5f6); --aa-dim: var(--text-dim, #8c8c92);
  --aa-bg: var(--surface-2, rgba(255,255,255,0.04)); --aa-line: var(--border, rgba(255,255,255,0.1));
  --aa-acc: var(--accent, #9945ff); --aa-good: #5fd08a; --aa-bad: #e06c75;
  font: 13px/1.45 var(--font, ui-sans-serif, system-ui, sans-serif); color: var(--aa-fg); }
.card { border: 1px solid var(--aa-line); border-radius: 12px; background: var(--aa-bg);
  padding: 14px; display: flex; flex-direction: column; gap: 12px; }
:host([variant="compact"]) .card { padding: 10px; gap: 8px; border-radius: 10px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spread { justify-content: space-between; }
.lineage { font-size: 12px; color: var(--aa-dim); display: flex; align-items: center; gap: 6px; }
.lineage a { color: var(--aa-fg); text-decoration: none; border-bottom: 1px dashed var(--aa-line); }
.lineage a:hover { border-bottom-color: var(--aa-acc); color: var(--aa-acc); }
.forks { font-size: 12px; color: var(--aa-dim); }
button { font: inherit; cursor: pointer; border-radius: 9px; border: 1px solid var(--aa-line);
  background: rgba(255,255,255,0.04); color: var(--aa-fg); padding: 8px 12px; display: inline-flex;
  align-items: center; gap: 7px; transition: background .15s, border-color .15s, transform .05s; }
button:hover { background: rgba(255,255,255,0.08); border-color: var(--aa-acc); }
button:active { transform: translateY(1px); }
button:focus-visible { outline: 2px solid var(--aa-acc); outline-offset: 2px; }
button[disabled] { opacity: .55; cursor: progress; }
button.primary { background: var(--aa-acc); border-color: var(--aa-acc); color: #fff; font-weight: 600; }
button.primary:hover { filter: brightness(1.08); background: var(--aa-acc); }
.wallet { border: 1px solid var(--aa-line); border-radius: 10px; padding: 10px 12px; display: flex;
  flex-direction: column; gap: 8px; }
.wallet h4 { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--aa-dim); font-weight: 600; }
.addr { display: flex; align-items: center; gap: 8px; }
.addr .chain { font-size: 10px; font-weight: 700; color: var(--aa-dim); width: 26px; }
.addr code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--aa-fg); }
.copy { padding: 3px 7px; font-size: 11px; }
.copy.copied { color: var(--aa-good); border-color: var(--aa-good); }
.bal { margin-left: auto; font-size: 11px; color: var(--aa-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bal.has { color: var(--aa-fg); }
.manage { color: var(--aa-acc); text-decoration: none; font-size: 12px; font-weight: 600; }
.manage:hover { text-decoration: underline; }
.msg { font-size: 12px; padding: 8px 10px; border-radius: 8px; }
.msg.err { color: var(--aa-bad); background: rgba(224,108,117,0.1); }
.msg.ok { color: var(--aa-good); background: rgba(95,208,138,0.1); }
.spinner { width: 13px; height: 13px; border: 2px solid currentColor; border-top-color: transparent;
  border-radius: 50%; animation: aa-spin .7s linear infinite; }
@keyframes aa-spin { to { transform: rotate(360deg); } }
.hidden { display: none !important; }
.muted { color: var(--aa-dim); font-size: 12px; }
.rty-sig { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600;
  padding:2px 8px; border-radius:999px; border:1px solid rgba(139,92,246,.4); color:#c4b5fd;
  background:rgba(139,92,246,.1); white-space:nowrap; cursor:pointer; }
.rty-sig.earn { border-color:rgba(95,208,138,.4); color:#86efac; background:rgba(95,208,138,.08); }
.rty-sig:hover { filter:brightness(1.15); }
.rty-overlay { position:absolute; inset:0; z-index:5; display:flex; align-items:center; justify-content:center;
  padding:10px; background:rgba(8,8,12,.74); backdrop-filter:blur(3px); border-radius:12px; }
.rty-box { width:100%; max-width:380px; max-height:100%; overflow:auto; background:#0c0c10;
  border:1px solid rgba(139,92,246,.3); border-radius:12px; padding:14px; box-shadow:0 18px 60px rgba(0,0,0,.6); }
.rty-box h3 { margin:0 0 8px; font-size:14px; }
.rty-box p { margin:0 0 10px; font-size:12px; line-height:1.5; color:var(--aa-dim); }
.rty-box p b, .rty-terms b { color:var(--aa-fg); }
.rty-bar { display:flex; height:26px; border-radius:7px; overflow:hidden; border:1px solid var(--aa-line); margin:8px 0; }
.rty-keep { background:linear-gradient(180deg,rgba(95,208,138,.32),rgba(95,208,138,.18)); color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; white-space:nowrap; padding:0 4px; min-width:0; }
.rty-up { background:linear-gradient(180deg,rgba(196,181,253,calc(.5 - var(--i,0)*.08)),rgba(139,92,246,.34));
  border-left:1px solid rgba(10,10,10,.5); min-width:5px; }
.rty-list { display:flex; flex-direction:column; gap:3px; margin:6px 0; }
.rty-cr { display:flex; align-items:center; gap:8px; font-size:11px; padding:4px 7px; border-radius:6px; background:rgba(255,255,255,.04); }
.rty-gen { font-size:9px; font-weight:700; color:var(--aa-dim); text-transform:uppercase; }
.rty-nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rty-w { font-family:ui-monospace,monospace; color:var(--aa-dim); font-size:10px; }
.rty-bp { font-family:ui-monospace,monospace; font-weight:600; color:#c4b5fd; }
.rty-terms { margin:8px 0; padding-left:16px; font-size:11px; line-height:1.55; color:var(--aa-dim); }
.rty-acts { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
.rty-cancel { background:transparent; }
`;

class AvatarActions extends HTMLElement {
	static get observedAttributes() {
		return ['avatar-id'];
	}

	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
		this._avatar = null;
		this._agent = null;
		this._me = null;
		this._busy = false;
	}

	set avatar(v) {
		this._avatar = v || null;
		if (this.isConnected) this._init();
	}
	get avatar() {
		return this._avatar;
	}

	connectedCallback() {
		this._init();
	}

	attributeChangedCallback(name, oldV, newV) {
		if (name === 'avatar-id' && oldV !== newV && this.isConnected) this._init();
	}

	get avatarId() {
		return this._avatar?.id || this.getAttribute('avatar-id') || null;
	}

	async _init() {
		const id = this.avatarId;
		// No id, or a stand-in that can never resolve (default mannequin): stay
		// invisible without issuing requests the server is guaranteed to reject.
		if (!id || !UUID_RE.test(String(id))) {
			this.shadowRoot.innerHTML = '';
			return;
		}
		this._render(); // initial skeleton
		try {
			this._me = await me();
			if (!this._avatar) {
				const r = await fetch(`${API}/api/avatars/${id}`, { credentials: 'include' });
				if (r.ok) this._avatar = (await r.json()).avatar || null;
			}
			// Resolve the avatar's agent (owner sees wallet_address; secrets stripped).
			const ar = await fetch(`${API}/api/agents?avatar_id=${encodeURIComponent(id)}`, {
				credentials: 'include',
			});
			if (ar.ok) this._agent = (await ar.json()).agents?.[0] || null;
			// Royalty trust signals (earns-from / shares-upstream). Best-effort.
			if (this._agent?.id) {
				try {
					const rr = await fetch(`${API}/api/agents/${this._agent.id}/solana/royalty`, { credentials: 'include' });
					if (rr.ok) this._royalty = (await rr.json()).data || null;
				} catch { /* signals are decoration */ }
			}
		} catch {
			/* render whatever we have */
		}
		// A bad / non-existent id (e.g. a default mannequin stand-in) never resolves
		// an avatar — stay invisible rather than showing a stuck "Loading…".
		if (!this._avatar) {
			this.shadowRoot.innerHTML = '';
			return;
		}
		this._render();
	}

	get isOwner() {
		return !!(this._me && this._avatar && this._me.id === this._avatar.owner_id);
	}

	_render() {
		const a = this._avatar;
		const css = `<style>${styles}</style>`;
		if (!a) {
			this.shadowRoot.innerHTML = `${css}<div class="card"><span class="muted">Loading…</span></div>`;
			return;
		}

		const lineage = a.forked_from
			? `<div class="lineage">⑂ Forked from
				<a href="/avatar-page.html?id=${a.forked_from.avatar_id}" title="View the original">
					${escapeHtml(a.forked_from.owner_name || a.forked_from.name || 'original')}
				</a></div>`
			: '';
		const forks =
			a.fork_count > 0
				? `<span class="forks">⑂ ${a.fork_count} ${a.fork_count === 1 ? 'fork' : 'forks'}</span>`
				: '';
		const royaltySignals = this._royaltySignals();

		// mode: "full" (default) shows wallet to owners + fork to others;
		// "wallet" shows only the wallet panel; "fork" shows only the save/fork
		// affordance (use on surfaces that already manage the wallet elsewhere).
		const mode = this.getAttribute('mode') || 'full';
		let body = '';
		if (this.isOwner) {
			body = mode === 'fork' ? '' : this._walletBlock();
		} else if (mode === 'wallet') {
			body = '';
		} else if (this._me) {
			body = `<button class="primary" data-act="fork" title="Save a copy to your own avatars">
				⑂ Save to my avatars</button>
				<div class="muted">Creates your own copy with its own agent wallet. The original stays untouched.</div>`;
		} else {
			body = `<a class="manage" href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">Sign in to save this avatar →</a>`;
		}

		// Nothing to show for this viewer/mode combo — stay invisible rather than
		// render an empty card.
		if (!body && !lineage && !forks && !royaltySignals) {
			this.shadowRoot.innerHTML = '';
			return;
		}

		this.shadowRoot.innerHTML = `${css}
			<div class="card">
				${lineage || forks ? `<div class="row spread">${lineage}${forks}</div>` : ''}
				${royaltySignals ? `<div class="row">${royaltySignals}</div>` : ''}
				<div class="body">${body}</div>
				<div class="msg-slot"></div>
			</div>`;
		this._wire();
	}

	// Royalty trust chips: "earns from N forks" (ancestor) / "shares N% upstream"
	// (descendant). Click opens the full transparent ledger. '' when nothing to say.
	_royaltySignals() {
		const d = this._royalty;
		if (!d) return '';
		const out = [];
		const anc = d.ancestor;
		const desc = d.descendant;
		if (anc?.earns_royalties && anc.fork_count > 0) {
			out.push(`<span class="rty-sig earn" data-royalty title="Earns a royalty when forks of this avatar earn">↑ earns from ${anc.fork_count} ${anc.fork_count === 1 ? 'fork' : 'forks'}</span>`);
		}
		if (desc?.shares_upstream && desc.total_bps > 0) {
			const p = (desc.total_bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
			out.push(`<span class="rty-sig" data-royalty title="Shares a slice of new income with the creators it descends from">⑂ shares ${p}% upstream</span>`);
		}
		return out.join('');
	}

	_walletBlock() {
		const ag = this._agent;
		if (!ag) {
			return `<div class="muted">Save the avatar to give its agent a wallet.</div>`;
		}
		const evm = ag.wallet_address || null;
		const sol = ag.meta?.solana_address || null;
		const solVanity = !!(sol && (ag.meta?.solana_vanity_prefix || ag.meta?.solana_vanity_suffix));
		const manage = `<a class="manage" href="/agent-edit.html?id=${ag.id}">Manage →</a>`;

		if (!evm && !sol) {
			return `<div class="wallet">
				<div class="row spread"><h4>Agent wallet</h4>${manage}</div>
				<div class="muted">No wallet yet. Give this agent a custodial EVM + Solana wallet it can transact with.</div>
				<button class="primary" data-act="create-wallet">Create wallet</button>
			</div>`;
		}
		const addr = (chain, a, balKey) =>
			a
				? `<div class="addr"><span class="chain">${chain}</span><code>${short(a)}</code>
					<button class="copy" data-copy="${a}" title="Copy ${chain} address">Copy</button>
					<span class="bal" data-bal="${balKey}"></span></div>`
				: '';
		const VTAG = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#a78bfa;border:1px solid rgba(139,92,246,.45);border-radius:999px;padding:1px 6px;';
		const solRow = sol
			? `<div class="addr"><span class="chain">SOL</span><code>${short(sol)}</code>
				<button class="copy" data-copy="${sol}" title="Copy SOL address">Copy</button>
				${solVanity
					? `<span title="Custom vanity address" style="${VTAG}">vanity</span>`
					: `<a class="manage" href="/agent/${ag.id}/wallet#vanity" title="Grind a custom vanity address">✦ Vanity</a>`}
				<span class="bal" data-bal="sol"></span></div>`
			: '';
		return `<div class="wallet">
			<div class="row spread"><h4>Agent wallet</h4>${manage}</div>
			${addr('EVM', evm, 'eth')}
			${solRow}
			${evm && sol ? '' : `<button data-act="create-wallet">Provision missing chain</button>`}
		</div>`;
	}

	_wire() {
		const root = this.shadowRoot;
		root.querySelectorAll('[data-copy]').forEach((b) =>
			b.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(b.dataset.copy);
					b.classList.add('copied');
					const t = b.textContent;
					b.textContent = 'Copied';
					setTimeout(() => {
						b.classList.remove('copied');
						b.textContent = t;
					}, 1400);
				} catch {
					/* clipboard blocked — no-op */
				}
			}),
		);
		root.querySelector('[data-act="fork"]')?.addEventListener('click', () => this._fork());
		root.querySelectorAll('[data-royalty]').forEach((s) =>
			s.addEventListener('click', () => this._openRoyalty()));
		root
			.querySelector('[data-act="create-wallet"]')
			?.addEventListener('click', () => this._createWallet());

		// Keep primary buttons (incl. "Save to my avatars") legible regardless of the
		// host's --accent: a light/white accent gets black text, a dark one keeps white.
		this._applyAccentContrast();

		// Fill live balances after the addresses are on screen (owner + has wallet).
		if (this.isOwner && this._agent && root.querySelector('.bal')) this._loadBalances();
	}

	// Pick black or white button text from the *rendered* accent background so a
	// white/light accent never produces invisible white-on-white text. Reads the
	// resolved background color of each primary button (CSS vars already applied)
	// and sets the contrasting foreground inline.
	_applyAccentContrast() {
		const btns = this.shadowRoot.querySelectorAll('button.primary');
		if (!btns.length) return;
		for (const btn of btns) {
			const bg = getComputedStyle(btn).backgroundColor;
			const m = bg.match(/rgba?\(([^)]+)\)/);
			if (!m) continue;
			const [r, g, b, a = '1'] = m[1].split(',').map((v) => parseFloat(v));
			// Fully transparent backgrounds inherit the surface — leave default text.
			if (a === 0) continue;
			// Relative luminance (sRGB) → light backgrounds read black, dark read white.
			const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
			btn.style.color = lum > 0.6 ? '#000' : '#fff';
		}
	}

	async _loadBalances() {
		const ag = this._agent;
		if (!ag) return;
		let d;
		try {
			const r = await fetch(`${API}/api/agents/${ag.id}/wallet`, { credentials: 'include' });
			if (!r.ok) return;
			d = await r.json();
		} catch {
			return;
		}
		const root = this.shadowRoot;
		const fmt = (n, unit) =>
			n == null ? '' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${unit}`;
		const eth = root.querySelector('[data-bal="eth"]');
		if (eth && d.balance_eth != null) {
			eth.textContent = fmt(d.balance_eth, 'ETH');
			eth.classList.add('has');
		}
		const sol = root.querySelector('[data-bal="sol"]');
		if (sol && (d.solana_balance != null || d.usdc_balance != null)) {
			const parts = [];
			if (d.solana_balance != null) parts.push(fmt(d.solana_balance, 'SOL'));
			if (d.usdc_balance) parts.push(fmt(d.usdc_balance, 'USDC'));
			sol.textContent = parts.join(' · ');
			sol.classList.add('has');
		}
	}

	_msg(kind, html) {
		const slot = this.shadowRoot.querySelector('.msg-slot');
		if (slot) slot.innerHTML = `<div class="msg ${kind}">${html}</div>`;
	}

	_setBusy(btn, label) {
		this._busy = true;
		if (btn) {
			btn.disabled = true;
			btn.dataset.label = btn.innerHTML;
			btn.innerHTML = `<span class="spinner"></span>${label}`;
		}
	}
	_clearBusy(btn) {
		this._busy = false;
		if (btn && btn.dataset.label) {
			btn.disabled = false;
			btn.innerHTML = btn.dataset.label;
		}
	}

	async _fork() {
		if (this._busy) return;
		const btn = this.shadowRoot.querySelector('[data-act="fork"]');
		this._msg('', '');

		// Consent gate: if this avatar's lineage carries a fork royalty, show the
		// EXACT terms and require explicit acceptance before creating the fork. The
		// forker mints their own wallet and keeps the clear majority; a defined slice
		// of new SOL income streams upstream. Reject → no fork is created.
		let acceptRoyalty = false;
		try {
			const tr = await fetch(`${API}/api/avatars/fork?of=${encodeURIComponent(this.avatarId)}&royalty=1`, {
				credentials: 'include',
			});
			if (tr.ok) {
				const { royalty } = await tr.json();
				if (royalty?.has_royalty) {
					const accepted = await this._confirmRoyalty(royalty);
					if (!accepted) return; // user declined — nothing happens
					acceptRoyalty = true;
				}
			}
		} catch {
			/* terms preview unavailable — server still gates the POST, so proceed */
		}

		this._setBusy(btn, 'Saving…');
		try {
			const r = await fetch(`${API}/api/avatars/fork`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source_avatar_id: this.avatarId, accept_royalty: acceptRoyalty }),
			});
			const d = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(d.message || d.error || `fork failed (${r.status})`);
			const wallet = d.agent?.wallet_address ? ` Its agent wallet: <code>${short(d.agent.wallet_address)}</code>.` : '';
			this._msg(
				'ok',
				`Saved to your avatars. <a class="manage" href="/avatar-page.html?id=${d.avatar.id}">Open →</a>${wallet}`,
			);
			this.dispatchEvent(
				new CustomEvent('avatar-forked', { detail: d, bubbles: true, composed: true }),
			);
		} catch (e) {
			this._msg('err', escapeHtml(e.message));
		} finally {
			this._clearBusy(btn);
		}
	}

	// Open the transparent royalty ledger. Pages that load the app bundle expose
	// the rich shared panel on window; everywhere else, route to the agent page
	// where it is always available.
	_openRoyalty() {
		const agentId = this._agent?.id;
		if (!agentId) return;
		const panel = (typeof window !== 'undefined') && window.twsForkRoyalty?.openRoyaltyPanel;
		if (panel) panel(agentId, { name: this._avatar?.name || 'this agent' });
		else window.location.href = `/agent/${agentId}#royalties`;
	}

	// Inline royalty-consent dialog (self-contained — no cross-bundle import).
	// Resolves true only on explicit accept. The fork is created by the caller.
	_confirmRoyalty(royalty) {
		return new Promise((resolve) => {
			const keepPct = (royalty.keep_pct ?? (royalty.keep_bps / 100)).toLocaleString(undefined, { maximumFractionDigits: 2 });
			const rows = (royalty.creators || [])
				.map((c) => `<div class="rty-cr"><span class="rty-gen">gen ${c.depth}</span>
					<span class="rty-nm">${escapeHtml(c.owner_name || 'creator')}</span>
					<span class="rty-w">${c.wallet ? short(c.wallet) : '—'}</span>
					<span class="rty-bp">${(c.pct ?? c.bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span></div>`)
				.join('');
			const bar = `<div class="rty-bar"><div class="rty-keep" style="flex:${royalty.keep_bps}">you keep ${keepPct}%</div>${(royalty.creators || []).map((c, i) => `<div class="rty-up" style="flex:${c.bps};--i:${i}"></div>`).join('')}</div>`;
			const overlay = document.createElement('div');
			overlay.className = 'rty-overlay';
			overlay.innerHTML = `<div class="rty-box" role="dialog" aria-modal="true" aria-label="Fork royalty terms">
				<h3>Fork royalty</h3>
				<p>Forking mints <b>your own wallet</b> — you alone own it and its funds. As thanks to the creators it descends from, a small slice of <b>new SOL income your fork earns</b> streams upstream, on-chain.</p>
				${bar}
				<div class="rty-list">${rows}</div>
				<ul class="rty-terms">
					<li>Applies only to <b>SOL tips & stream income</b> your fork earns — never your existing balance.</li>
					<li>You keep the <b>clear majority</b> (${keepPct}%); upstream is capped and decays with distance.</li>
					<li>Terms are <b>frozen now</b> — later rate changes never affect your fork.</li>
				</ul>
				<div class="rty-acts">
					<button class="rty-cancel">Cancel</button>
					<button class="rty-accept primary">Accept & fork — keep ${keepPct}%</button>
				</div>
			</div>`;
			this.shadowRoot.appendChild(overlay);
			const done = (val) => { overlay.remove(); resolve(val); };
			overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
			overlay.querySelector('.rty-cancel').addEventListener('click', () => done(false));
			overlay.querySelector('.rty-accept').addEventListener('click', () => done(true));
			overlay.querySelector('.rty-accept').focus();
		});
	}

	async _createWallet() {
		if (this._busy) return;
		const ag = this._agent;
		if (!ag) return;
		const btn = this.shadowRoot.querySelector('[data-act="create-wallet"]');
		this._setBusy(btn, 'Creating…');
		this._msg('', '');
		try {
			const token = await csrfToken();
			const r = await fetch(`${API}/api/agents/${ag.id}/wallet/provision`, {
				method: 'POST',
				credentials: 'include',
				headers: token ? { 'x-csrf-token': token } : {},
			});
			const d = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(d.message || d.error || `provision failed (${r.status})`);
			// Reflect the new wallet locally and re-render.
			this._agent = {
				...ag,
				wallet_address: d.wallet_address,
				meta: { ...(ag.meta || {}), solana_address: d.solana_address },
			};
			this._render();
			this._msg('ok', 'Wallet created. Fund it from the agent page to start transacting.');
			this.dispatchEvent(
				new CustomEvent('wallet-created', {
					detail: { agentId: ag.id, ...d },
					bubbles: true,
					composed: true,
				}),
			);
		} catch (e) {
			this._clearBusy(btn);
			this._msg('err', escapeHtml(e.message));
		}
	}
}

function escapeHtml(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

if (!customElements.get('avatar-actions')) {
	customElements.define('avatar-actions', AvatarActions);
}

export { AvatarActions };
