/**
 * Fork Royalty Streams — shared UI for provenance income.
 *
 * One source of truth for every surface that renders the royalty relationship:
 *   • royaltySignalsHTML(data)   — the trust chips: "earns from N forks" /
 *                                  "shares N% upstream".
 *   • openRoyaltyPanel(agentId)  — the transparent split ledger both sides see.
 *   • mountRoyaltySetting(...)    — owner control to set the fork royalty rate.
 *   • confirmForkRoyalty(terms)   — the consent dialog the fork flow shows BEFORE
 *                                  a fork that carries terms is created.
 *
 * All numbers come from GET /api/agents/:id/solana/royalty (real DB + on-chain
 * ledger). Every payout links to its real explorer tx. No mock data, no hidden
 * cuts: a forker always sees they keep the majority; an ancestor sees real income
 * by descendant. The royalty layer stays in the wallet's violet family.
 */

let _apiFetch = null;
async function api() {
	if (_apiFetch) return _apiFetch;
	try { ({ apiFetch: _apiFetch } = await import('../api.js')); }
	catch { _apiFetch = (p, o) => fetch(p, { credentials: 'include', ...o }); }
	return _apiFetch;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const pct = (bps) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
const sol = (n) => `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 5 })} SOL`;
const usd = (n) => (n == null ? '' : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const explorer = (sig, net) => `https://solscan.io/tx/${sig}${net === 'devnet' ? '?cluster=devnet' : ''}`;

/** Fetch the full royalty view for an agent. Returns null on any failure. */
export async function fetchRoyalty(agentId) {
	if (!agentId) return null;
	try {
		const f = await api();
		const r = await f(`/api/agents/${agentId}/solana/royalty`, { credentials: 'include' });
		if (!r.ok) return null;
		return (await r.json()).data || null;
	} catch { return null; }
}

/**
 * The compact trust signals for a chip/HUD/lineage row. Returns '' when there's
 * nothing to say (a free, un-forked agent) so callers can render nothing.
 */
export function royaltySignalsHTML(data, { compact = false } = {}) {
	if (!data) return '';
	const out = [];
	const anc = data.ancestor;
	const desc = data.descendant;
	if (anc?.earns_royalties && anc.fork_count > 0) {
		const earned = Number(anc.earned_usd) > 0 ? ` · ${esc(usd(anc.earned_usd))} earned` : '';
		out.push(`<span class="twr-sig twr-sig--earn" title="This creator earns a royalty when its forks earn">
			<span class="twr-sig-ic" aria-hidden="true">↑</span>earns from ${anc.fork_count} ${anc.fork_count === 1 ? 'fork' : 'forks'}${compact ? '' : earned}</span>`);
	}
	if (desc?.shares_upstream && desc.total_bps > 0) {
		out.push(`<span class="twr-sig twr-sig--share" title="This fork shares a slice of its income with the creators it descends from">
			<span class="twr-sig-ic" aria-hidden="true">⑂</span>shares ${pct(desc.total_bps)} upstream</span>`);
	}
	if (!out.length) return '';
	return `<span class="twr-sigs">${out.join('')}</span>`;
}

/** Open the transparent split-ledger modal. */
export async function openRoyaltyPanel(agentId, { name = 'this agent', network = 'mainnet' } = {}) {
	ensureStyles();
	const backdrop = document.createElement('div');
	backdrop.className = 'twr-backdrop';
	backdrop.setAttribute('role', 'dialog');
	backdrop.setAttribute('aria-modal', 'true');
	backdrop.setAttribute('aria-label', `Fork royalties for ${name}`);
	backdrop.innerHTML = `<div class="twr-panel"><div class="twr-load"><span class="twr-spin"></span>Loading royalty ledger…</div></div>`;
	document.body.appendChild(backdrop);
	document.body.style.overflow = 'hidden';

	const close = () => {
		backdrop.classList.add('twr-out');
		document.body.style.overflow = '';
		setTimeout(() => backdrop.remove(), 160);
		document.removeEventListener('keydown', onKey);
	};
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

	const data = await fetchRoyalty(agentId);
	const panel = backdrop.querySelector('.twr-panel');
	if (!data) {
		panel.innerHTML = `<div class="twr-head"><h2>Fork royalties</h2><button class="twr-x" aria-label="Close">✕</button></div>
			<div class="twr-empty">Couldn't load the royalty ledger right now. <button class="twr-retry">Retry</button></div>`;
		panel.querySelector('.twr-x').onclick = close;
		panel.querySelector('.twr-retry').onclick = () => { close(); openRoyaltyPanel(agentId, { name, network }); };
		return;
	}
	panel.innerHTML = renderPanel(data, { name, network });
	panel.querySelector('.twr-x').onclick = close;
	panel.querySelector('.twr-x').focus();
}

function renderPanel(data, { name, network }) {
	const anc = data.ancestor || {};
	const desc = data.descendant || {};
	const cfg = data.config || {};

	// As ancestor: income earned from descendants' forks.
	const ancSection = (anc.earns_royalties || Number(anc.earned_usd) > 0 || (anc.income || []).length)
		? `<section class="twr-sec">
			<div class="twr-sec-h"><h3>↑ Royalties this creator earns</h3>
				<span class="twr-kpi">${esc(sol(Number(anc.earned_lamports) / 1e9))}${Number(anc.earned_usd) > 0 ? ` · ${esc(usd(anc.earned_usd))}` : ''}</span></div>
			<p class="twr-note">From <b>${anc.fork_count}</b> ${anc.fork_count === 1 ? 'fork' : 'forks'} carrying these terms · <b>${anc.paying_forks}</b> ${anc.paying_forks === 1 ? 'has' : 'have'} actually paid.</p>
			${(anc.income || []).length
				? `<div class="twr-ledger">${anc.income.map((p) => incomeRow(p, network)).join('')}</div>`
				: `<div class="twr-zero">No royalty income yet — honest zero. When a fork that descends from this creator earns SOL, the split lands here automatically.</div>`}
		</section>`
		: '';

	// As descendant: what this fork shares upstream + what it has paid.
	const descSection = desc.shares_upstream
		? `<section class="twr-sec">
			<div class="twr-sec-h"><h3>⑂ What this fork shares upstream</h3>
				<span class="twr-kpi twr-kpi--keep">keeps ${esc(pct(desc.keep_bps))}</span></div>
			<div class="twr-split">
				<div class="twr-split-bar" role="img" aria-label="${esc(pct(desc.keep_bps))} kept by this fork, ${esc(pct(desc.total_bps))} shared upstream">
					<div class="twr-split-keep" style="flex:${desc.keep_bps}">you keep ${esc(pct(desc.keep_bps))}</div>
					${desc.schedule.map((s, i) => `<div class="twr-split-up" style="flex:${s.bps};--i:${i}" title="${esc(s.ancestor_owner_name || 'creator')} · ${esc(pct(s.bps))}"></div>`).join('')}
				</div>
			</div>
			<p class="twr-note">A defined slice of <b>new SOL income</b> only — never a claim on this wallet's balance. Set at fork time, can't change retroactively. You keep the clear majority.</p>
			<div class="twr-creators">
				${desc.schedule.map((s) => `<div class="twr-creator">
					<span class="twr-depth" title="lineage distance">gen ${s.depth}</span>
					<span class="twr-cname">${esc(s.ancestor_owner_name || 'creator')}</span>
					<span class="twr-cwallet">${s.ancestor_wallet ? esc(shortAddr(s.ancestor_wallet)) : '—'}</span>
					<span class="twr-cbps">${esc(pct(s.bps))}</span>
				</div>`).join('')}
			</div>
			${Number(desc.paid_count) > 0
				? `<div class="twr-sec-h twr-sub"><h4>Royalties paid</h4><span class="twr-kpi">${esc(sol(Number(desc.paid_lamports) / 1e9))}${Number(desc.paid_usd) > 0 ? ` · ${esc(usd(desc.paid_usd))}` : ''}</span></div>
					<div class="twr-ledger">${desc.payouts.filter((p) => p.status !== 'skipped').map((p) => paidRow(p, network)).join('')}</div>`
				: `<div class="twr-zero">Hasn't earned eligible income yet — nothing has been shared. When it earns a SOL tip or stream, the split runs automatically.</div>`}
		</section>`
		: `<section class="twr-sec"><div class="twr-sec-h"><h3>⑂ Upstream royalties</h3></div>
			<div class="twr-zero">This agent is original (or forked something free) — it owes nothing upstream and keeps <b>100%</b> of what it earns.</div></section>`;

	return `
		<div class="twr-head">
			<h2>Fork royalties · ${esc(name)}</h2>
			<button class="twr-x" aria-label="Close">✕</button>
		</div>
		<div class="twr-body">
			${ancSection}
			${descSection}
			<p class="twr-foot">Royalties are opt-in, capped at ${esc(pct(cfg.total_cap_bps || 2000))} total upstream, and decay with lineage distance so the active forker always keeps the majority. Paid on real ${esc(cfg.eligible_asset || 'SOL')} income, on-chain, idempotently. <a href="/changelog" class="twr-link">How this works →</a></p>
		</div>`;
}

function incomeRow(p, network) {
	const net = p.network || network;
	const who = p.fork_agent_id ? `<a href="/agents/${esc(p.fork_agent_id)}" class="twr-link">a fork</a>` : 'a fork';
	return `<div class="twr-row twr-row--in">
		<span class="twr-row-amt">+${esc(sol(p.amount_sol))}</span>
		<span class="twr-row-mid">from ${who} · ${esc(p.source_kind)} · gen ${p.depth} · ${esc(pct(p.bps))}</span>
		${p.signature ? `<a class="twr-tx" href="${esc(explorer(p.signature, net))}" target="_blank" rel="noopener">tx ↗</a>` : `<span class="twr-pending">${esc(p.status)}</span>`}
	</div>`;
}

function paidRow(p, network) {
	const net = p.network || network;
	const dest = p.rerouted ? 'platform treasury (ancestor unavailable)'
		: (p.recipient_wallet ? `<a href="/agents/${esc(p.ancestor_agent_id)}" class="twr-link">${esc(shortAddr(p.recipient_wallet))}</a>` : 'creator');
	const badge = p.status === 'failed' ? `<span class="twr-pending twr-fail">failed</span>`
		: p.status === 'pending' ? `<span class="twr-pending">pending</span>`
		: (p.signature ? `<a class="twr-tx" href="${esc(explorer(p.signature, net))}" target="_blank" rel="noopener">tx ↗</a>` : '');
	return `<div class="twr-row twr-row--out">
		<span class="twr-row-amt twr-out">−${esc(sol(p.amount_sol))}</span>
		<span class="twr-row-mid">to ${dest} · gen ${p.depth} · ${esc(pct(p.bps))}</span>
		${badge}
	</div>`;
}

/**
 * The consent dialog the fork flow shows when an avatar carries royalty terms.
 * Resolves to true only if the user explicitly accepts. Pure promise — no fork
 * is created here; the caller proceeds on `true`.
 *
 * @param {object} royalty  the public terms from GET /api/avatars/fork?royalty=1
 * @param {string} avatarName
 */
export function confirmForkRoyalty(royalty, avatarName = 'this avatar') {
	ensureStyles();
	return new Promise((resolve) => {
		const backdrop = document.createElement('div');
		backdrop.className = 'twr-backdrop';
		backdrop.setAttribute('role', 'dialog');
		backdrop.setAttribute('aria-modal', 'true');
		backdrop.setAttribute('aria-label', `Fork royalty terms for ${avatarName}`);
		const creators = (royalty.creators || []).map((c) => `<div class="twr-creator">
			<span class="twr-depth">gen ${c.depth}</span>
			<span class="twr-cname">${esc(c.owner_name || 'creator')}</span>
			<span class="twr-cwallet">${c.wallet ? esc(shortAddr(c.wallet)) : '—'}</span>
			<span class="twr-cbps">${esc(pct(c.bps))}</span>
		</div>`).join('');
		backdrop.innerHTML = `<div class="twr-panel twr-panel--sm">
			<div class="twr-head"><h2>Fork royalty</h2><button class="twr-x" aria-label="Cancel">✕</button></div>
			<div class="twr-body">
				<p class="twr-lead">Forking <b>${esc(avatarName)}</b> mints <b>your own wallet</b> — you alone own it and its funds. As thanks to the creators it descends from, a small slice of <b>new SOL income your fork earns</b> streams upstream, automatically and on-chain.</p>
				<div class="twr-split">
					<div class="twr-split-bar">
						<div class="twr-split-keep" style="flex:${royalty.keep_bps}">you keep ${esc(pct(royalty.keep_bps))}</div>
						${(royalty.creators || []).map((c, i) => `<div class="twr-split-up" style="flex:${c.bps};--i:${i}"></div>`).join('')}
					</div>
				</div>
				<div class="twr-creators">${creators}</div>
				<ul class="twr-terms">
					<li>Applies only to <b>SOL tips & money-stream income</b> your fork earns — never to your existing balance.</li>
					<li>You keep the <b>clear majority</b> (${esc(pct(royalty.keep_bps))}). Total upstream is hard-capped and decays with distance.</li>
					<li>These terms are <b>frozen now</b> — a creator changing their rate later never affects your fork.</li>
				</ul>
				<div class="twr-actions">
					<button class="twr-btn twr-btn--ghost" data-cancel>Cancel</button>
					<button class="twr-btn twr-btn--go" data-accept>Accept & fork — keep ${esc(pct(royalty.keep_bps))}</button>
				</div>
			</div>
		</div>`;
		document.body.appendChild(backdrop);
		document.body.style.overflow = 'hidden';
		const done = (val) => {
			document.body.style.overflow = '';
			backdrop.classList.add('twr-out');
			setTimeout(() => backdrop.remove(), 160);
			document.removeEventListener('keydown', onKey);
			resolve(val);
		};
		const onKey = (e) => { if (e.key === 'Escape') done(false); };
		document.addEventListener('keydown', onKey);
		backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
		backdrop.querySelector('.twr-x').onclick = () => done(false);
		backdrop.querySelector('[data-cancel]').onclick = () => done(false);
		backdrop.querySelector('[data-accept]').onclick = () => done(true);
		backdrop.querySelector('[data-accept]').focus();
	});
}

/**
 * Owner control: set this agent's fork royalty rate + eligible income types.
 * Renders into `host`, self-loads current config, persists via PUT (CSRF auto).
 * Calls onChange(config) after a successful save. Safe no-op if not owner
 * (the endpoint rejects a non-owner PUT, and we only mount for owners).
 */
export async function mountRoyaltySetting({ host, agentId, onChange } = {}) {
	if (!host || !agentId) return;
	ensureStyles();
	const data = await fetchRoyalty(agentId);
	const cfg = data?.config || { bps: 0, eligible: { tips: true, stream: true }, per_creator_cap_bps: 1000, eligible_asset: 'SOL' };
	const cap = cfg.per_creator_cap_bps || 1000;
	const ancCount = data?.ancestor?.fork_count || 0;

	const card = document.createElement('div');
	card.className = 'twr-set';
	const draw = () => {
		const curPct = (cfg.bps / 100).toString();
		card.innerHTML = `
			<div class="twr-set-h">
				<h4>Fork royalty</h4>
				${ancCount > 0 ? `<button class="twr-set-view" type="button" data-view>earns from ${ancCount} ${ancCount === 1 ? 'fork' : 'forks'} →</button>` : ''}
			</div>
			<p class="twr-set-sub">Earn a slice of income from forks of this avatar. Applies to <b>future forks only</b>; max ${esc(pct(cap))}. The forker always keeps the majority. Set 0 to make forks free.</p>
			<div class="twr-set-row">
				<div class="twr-range">
					<input type="range" min="0" max="${cap}" step="50" value="${cfg.bps}" data-range aria-label="Royalty percent">
					<output class="twr-range-out" data-out>${esc(pct(cfg.bps))}</output>
				</div>
			</div>
			<div class="twr-set-elig">
				<label><input type="checkbox" data-elig="tips" ${cfg.eligible.tips !== false ? 'checked' : ''}> Tips</label>
				<label><input type="checkbox" data-elig="stream" ${cfg.eligible.stream !== false ? 'checked' : ''}> Money streams</label>
				<span class="twr-set-asset">on ${esc(cfg.eligible_asset || 'SOL')} income</span>
			</div>
			<div class="twr-set-actions">
				<button class="twr-btn twr-btn--go" type="button" data-save disabled>Save royalty</button>
				<span class="twr-set-msg" data-msg></span>
			</div>`;
		wire();
	};
	const wire = () => {
		const range = card.querySelector('[data-range]');
		const out = card.querySelector('[data-out]');
		const save = card.querySelector('[data-save]');
		const msg = card.querySelector('[data-msg]');
		let dirty = false;
		const markDirty = () => { dirty = true; save.disabled = false; msg.textContent = ''; };
		range.addEventListener('input', () => { out.textContent = pct(Number(range.value)); markDirty(); });
		card.querySelectorAll('[data-elig]').forEach((c) => c.addEventListener('change', markDirty));
		card.querySelector('[data-view]')?.addEventListener('click', () =>
			openRoyaltyPanel(agentId, { name: 'this agent' }));
		save.addEventListener('click', async () => {
			if (!dirty) return;
			save.disabled = true;
			msg.textContent = 'Saving…';
			msg.className = 'twr-set-msg';
			try {
				const f = await api();
				const r = await f(`/api/agents/${agentId}/solana/royalty`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({
						bps: Number(range.value),
						eligible: {
							tips: card.querySelector('[data-elig="tips"]').checked,
							stream: card.querySelector('[data-elig="stream"]').checked,
						},
					}),
				});
				const d = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(d.message || d.error || 'save failed');
				cfg.bps = d.data.bps;
				cfg.eligible = d.data.eligible;
				dirty = false;
				msg.textContent = d.data.bps > 0 ? `Saved · forks pay ${pct(d.data.bps)} upstream` : 'Saved · forks are free';
				msg.className = 'twr-set-msg twr-ok';
				onChange?.(d.data);
			} catch (e) {
				msg.textContent = e.message || 'Could not save';
				msg.className = 'twr-set-msg twr-fail';
				save.disabled = false;
			}
		});
	};
	draw();
	host.appendChild(card);
	return card;
}

let _styled = false;
function ensureStyles() {
	if (_styled || typeof document === 'undefined') return;
	_styled = true;
	const s = document.createElement('style');
	s.id = 'twr-styles';
	s.textContent = `
.twr-backdrop{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
	padding:16px;background:rgba(8,8,12,.7);backdrop-filter:blur(5px);animation:twr-fade .18s ease;}
.twr-backdrop.twr-out{animation:twr-fade .16s ease reverse;}
@keyframes twr-fade{from{opacity:0}to{opacity:1}}
.twr-panel{width:min(560px,100%);max-height:88vh;overflow:auto;background:var(--bg-0,#0a0a0a);
	border:1px solid var(--stroke,rgba(255,255,255,.1));border-radius:var(--radius-lg,16px);
	box-shadow:0 24px 80px rgba(0,0,0,.6);color:var(--ink,#f5f5f6);
	font-family:var(--font-body,Inter,system-ui,sans-serif);animation:twr-rise .2s var(--ease-standard,cubic-bezier(.2,.8,.2,1));}
.twr-panel--sm{width:min(440px,100%);}
@keyframes twr-rise{from{transform:translateY(12px) scale(.99);opacity:0}to{transform:none;opacity:1}}
.twr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 18px;
	border-bottom:1px solid var(--stroke,rgba(255,255,255,.08));position:sticky;top:0;background:var(--bg-0,#0a0a0a);z-index:1;}
.twr-head h2{margin:0;font-size:15px;font-weight:600;font-family:var(--font-display,'Space Grotesk',sans-serif);}
.twr-x{background:none;border:1px solid var(--stroke,rgba(255,255,255,.12));color:var(--ink-dim,#9a9aa2);
	width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:13px;line-height:1;transition:.14s;}
.twr-x:hover{background:var(--surface-2,rgba(255,255,255,.05));color:var(--ink,#fff);}
.twr-x:focus-visible{outline:2px solid #c4b5fd;outline-offset:2px;}
.twr-body{padding:16px 18px 18px;}
.twr-load,.twr-empty{padding:40px 18px;text-align:center;color:var(--ink-dim,#9a9aa2);font-size:13px;display:flex;flex-direction:column;gap:12px;align-items:center;}
.twr-spin{width:16px;height:16px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:twr-spin .7s linear infinite;}
@keyframes twr-spin{to{transform:rotate(360deg)}}
.twr-sec{margin-bottom:18px;}
.twr-sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 6px;}
.twr-sec-h.twr-sub{margin-top:16px;}
.twr-sec-h h3{margin:0;font-size:13px;font-weight:600;}
.twr-sec-h h4{margin:0;font-size:12px;font-weight:600;color:var(--ink-dim,#9a9aa2);text-transform:uppercase;letter-spacing:.05em;}
.twr-kpi{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:13px;font-weight:600;color:#c4b5fd;}
.twr-kpi--keep{color:var(--success,#4ade80);}
.twr-note{margin:6px 0 10px;font-size:12px;line-height:1.5;color:var(--ink-dim,#9a9aa2);}
.twr-zero{padding:14px;border:1px dashed var(--stroke,rgba(255,255,255,.12));border-radius:10px;
	font-size:12px;line-height:1.5;color:var(--ink-dim,#9a9aa2);text-align:center;}
.twr-split{margin:10px 0;}
.twr-split-bar{display:flex;height:30px;border-radius:8px;overflow:hidden;border:1px solid var(--stroke,rgba(255,255,255,.1));}
.twr-split-keep{background:linear-gradient(180deg,rgba(74,222,128,.32),rgba(74,222,128,.18));color:var(--ink,#fff);
	display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;min-width:0;white-space:nowrap;padding:0 6px;}
.twr-split-up{background:linear-gradient(180deg,rgba(196,181,253,calc(.5 - var(--i,0)*.08)),rgba(139,92,246,calc(.34 - var(--i,0)*.06)));
	border-left:1px solid rgba(10,10,10,.5);min-width:6px;}
.twr-creators{display:flex;flex-direction:column;gap:4px;margin:8px 0;}
.twr-creator{display:flex;align-items:center;gap:10px;font-size:12px;padding:5px 8px;border-radius:7px;background:var(--surface-1,rgba(255,255,255,.03));}
.twr-depth{font-size:10px;font-weight:700;color:var(--ink-dim,#9a9aa2);text-transform:uppercase;letter-spacing:.04em;flex:0 0 auto;}
.twr-cname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.twr-cwallet{font-family:var(--font-mono,monospace);color:var(--ink-dim,#9a9aa2);font-size:11px;}
.twr-cbps{font-family:var(--font-mono,monospace);font-weight:600;color:#c4b5fd;flex:0 0 auto;}
.twr-ledger{display:flex;flex-direction:column;gap:3px;margin-top:6px;}
.twr-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;border-radius:7px;background:var(--surface-1,rgba(255,255,255,.03));}
.twr-row-amt{font-family:var(--font-mono,monospace);font-weight:600;color:var(--success,#4ade80);flex:0 0 auto;}
.twr-row-amt.twr-out{color:#c4b5fd;}
.twr-row-mid{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-dim,#9a9aa2);}
.twr-tx{flex:0 0 auto;color:#c4b5fd;text-decoration:none;font-size:11px;border-bottom:1px dashed currentColor;}
.twr-tx:hover{color:#ddd6fe;}
.twr-pending{flex:0 0 auto;font-size:11px;color:var(--warn,#fbbf24);}
.twr-pending.twr-fail{color:var(--danger,#f87171);}
.twr-foot{margin:14px 0 0;font-size:11px;line-height:1.5;color:var(--ink-faint,#6b6b73);}
.twr-link{color:#c4b5fd;text-decoration:none;border-bottom:1px dashed currentColor;}
.twr-link:hover{color:#ddd6fe;}
.twr-lead{font-size:13px;line-height:1.55;margin:0 0 12px;}
.twr-terms{margin:12px 0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--ink-dim,#cfcfd6);}
.twr-terms b{color:var(--ink,#fff);}
.twr-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}
.twr-btn{font:inherit;font-size:13px;font-weight:600;padding:9px 14px;border-radius:10px;cursor:pointer;border:1px solid var(--stroke,rgba(255,255,255,.12));transition:.14s;}
.twr-btn--ghost{background:transparent;color:var(--ink-dim,#cfcfd6);}
.twr-btn--ghost:hover{background:var(--surface-2,rgba(255,255,255,.05));color:var(--ink,#fff);}
.twr-btn--go{background:linear-gradient(180deg,#a78bfa,#8b5cf6);border-color:#8b5cf6;color:#fff;}
.twr-btn--go:hover{filter:brightness(1.08);}
.twr-btn--go:disabled{opacity:.5;cursor:default;filter:none;}
.twr-btn:focus-visible{outline:2px solid #c4b5fd;outline-offset:2px;}
.twr-sigs{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;}
.twr-sig{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;
	border:1px solid rgba(139,92,246,.4);color:#c4b5fd;background:rgba(139,92,246,.1);white-space:nowrap;}
.twr-sig--earn{border-color:rgba(74,222,128,.35);color:#86efac;background:rgba(74,222,128,.08);}
.twr-sig-ic{font-size:10px;}
.twr-set{border:1px solid var(--stroke,rgba(255,255,255,.1));border-radius:12px;padding:12px 14px;background:var(--surface-1,rgba(255,255,255,.03));
	font-family:var(--font-body,Inter,system-ui,sans-serif);color:var(--ink,#f5f5f6);}
.twr-set-h{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.twr-set-h h4{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-dim,#9a9aa2);}
.twr-set-view{background:none;border:none;color:#c4b5fd;font:inherit;font-size:11px;font-weight:600;cursor:pointer;padding:0;}
.twr-set-view:hover{text-decoration:underline;}
.twr-set-sub{margin:6px 0 10px;font-size:11.5px;line-height:1.5;color:var(--ink-dim,#9a9aa2);}
.twr-set-sub b{color:var(--ink,#fff);}
.twr-range{display:flex;align-items:center;gap:10px;}
.twr-range input[type=range]{flex:1;accent-color:#8b5cf6;}
.twr-range-out{font-family:var(--font-mono,monospace);font-weight:600;color:#c4b5fd;min-width:48px;text-align:right;}
.twr-set-elig{display:flex;align-items:center;gap:14px;margin:10px 0;font-size:12px;color:var(--ink-dim,#cfcfd6);flex-wrap:wrap;}
.twr-set-elig label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;}
.twr-set-elig input{accent-color:#8b5cf6;}
.twr-set-asset{color:var(--ink-faint,#6b6b73);font-size:11px;}
.twr-set-actions{display:flex;align-items:center;gap:10px;}
.twr-set-msg{font-size:11.5px;color:var(--ink-dim,#9a9aa2);}
.twr-set-msg.twr-ok{color:var(--success,#4ade80);}
.twr-set-msg.twr-fail{color:var(--danger,#f87171);}
@media (max-width:520px){.twr-panel{max-height:92vh;}.twr-row-mid{font-size:11px;}}
@media (prefers-reduced-motion:reduce){.twr-backdrop,.twr-panel,.twr-spin{animation:none;}}
`;
	document.head.appendChild(s);
}

if (typeof window !== 'undefined') {
	window.twsForkRoyalty = { fetchRoyalty, openRoyaltyPanel, confirmForkRoyalty, royaltySignalsHTML, mountRoyaltySetting };
}
