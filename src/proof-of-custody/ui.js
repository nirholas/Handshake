/**
 * Proof-of-Custody — shared proof renderer.
 *
 * One renderer drives both the wallet-hub "Proof of Custody" tab and the
 * standalone /proof page, so the verification experience is identical wherever
 * an owner looks. It paints the inclusion proof, auto-runs the independent
 * in-browser verifier (passed in as `verify`), and reflects the outcome with an
 * honest green / red / pending state plus the per-step breakdown. It also renders
 * the movement reconciliation and, once verified, a shareable "verified custody"
 * badge + embed snippet.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function short(s, head = 8, tail = 8) {
	const v = String(s || '');
	return v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v;
}

function fmtTime(iso) {
	if (!iso) return '—';
	try {
		return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	} catch { return String(iso); }
}

/**
 * @param {HTMLElement} panel
 * @param {object} args
 * @param {object} args.proof   the `data` object from the inclusion-proof endpoint
 * @param {(proof:object)=>Promise<object>} args.verify  the independent verifier
 * @param {string} [args.shareBase='/proof']
 * @param {object} [args.ctx]   optional hub ctx (toast, copyToClipboard)
 */
export function renderProofUI(panel, { proof, verify, shareBase = '/proof', ctx = {} }) {
	injectProofStyle();
	if (!proof || proof.included === false) {
		panel.innerHTML = notYetState(proof);
		panel.querySelector('[data-reload]')?.addEventListener('click', () => location.reload());
		return;
	}

	const anchor = proof.anchor || {};
	const recon = proof.reconciliation || {};
	const reconClass = recon.status === 'unexplained' ? 'is-bad' : recon.status === 'baseline' ? '' : 'is-good';

	panel.innerHTML = `
		<div class="awh-proof">
			<div class="awh-proof-hero is-pending" data-hero>
				<div class="awh-proof-seal" data-seal><span class="awh-proof-spin" aria-hidden="true"></span></div>
				<div class="awh-proof-hero-main">
					<div class="awh-proof-hero-title" data-hero-title>Verifying custody on-chain…</div>
					<div class="awh-proof-hero-sub" data-hero-sub>Recomputing your leaf and reading the anchor straight from a public Solana RPC — no trust in our server.</div>
				</div>
			</div>

			<div class="awh-proof-facts">
				${fact('Epoch', `#${esc(proof.epoch)}`)}
				${fact('Attested balance', `${formatSol(proof.leaf?.balanceSol)} SOL`)}
				${fact('Wallets in tree', esc(proof.wallet_count))}
				${fact('Snapshot', esc(fmtTime(proof.snapshot_at)))}
				${fact('Wallet', `<span title="${esc(proof.leaf?.address)}">${esc(short(proof.leaf?.address))}</span>`)}
				${fact('Ledger head', `<span title="${esc(proof.leaf?.ledgerHead)}">${esc(short(proof.leaf?.ledgerHead, 10, 6))}</span>`)}
				${fact('Merkle root', `<span title="${esc(proof.merkle_root)}">${esc(short(proof.merkle_root, 10, 10))}</span>`)}
				${fact('On-chain anchor', anchor.signature
					? `<a href="${esc(anchor.explorer)}" target="_blank" rel="noopener" title="${esc(anchor.signature)}">${esc(short(anchor.signature, 8, 8))} ↗</a>`
					: `<span style="color:var(--warn,#fbbf24)">${esc(anchor.status || 'pending')}</span>`)}
			</div>

			<div class="awh-proof-card">
				<h2>Verification steps</h2>
				<p class="awh-proof-lead">Each step runs in your browser. You are not trusting three.ws to tell you it's fine — you're checking it.</p>
				<ul class="awh-proof-steps" data-steps>${stepRow({ name: 'Independent verification', ok: null, detail: 'Running…' })}</ul>
			</div>

			<div class="awh-proof-recon ${reconClass}">
				<div class="awh-proof-recon-h">${recon.status === 'unexplained' ? '⚠ Unexplained movement' : 'Movement reconciliation'}</div>
				<div>${esc(recon.human || 'No reconciliation available.')}</div>
				${Array.isArray(recon.authorized_events) && recon.authorized_events.length
					? `<ul class="awh-proof-events">${recon.authorized_events.map(eventRow).join('')}</ul>`
					: ''}
			</div>

			<div data-share hidden></div>
		</div>
	`;

	runVerification();

	async function runVerification() {
		let result;
		try {
			result = await verify(proof);
		} catch (e) {
			result = { verified: false, steps: [{ name: 'Verifier error', ok: false, detail: e.message }], summary: 'Verifier crashed.' };
		}
		paintResult(result);
	}

	function paintResult(result) {
		const hero = panel.querySelector('[data-hero]');
		const seal = panel.querySelector('[data-seal]');
		const title = panel.querySelector('[data-hero-title]');
		const sub = panel.querySelector('[data-hero-sub]');
		const stepsEl = panel.querySelector('[data-steps]');
		if (!hero) return;

		const pendingAnchor = !anchor.signature;
		hero.classList.remove('is-pending');
		if (result.verified) {
			hero.classList.add('is-verified');
			seal.innerHTML = '✓';
			title.textContent = `Custody verified on-chain · epoch ${proof.epoch}`;
			sub.innerHTML = anchor.explorer
				? `Verified at ${esc(fmtTime(new Date().toISOString()))} against <a href="${esc(anchor.explorer)}" target="_blank" rel="noopener">the anchor transaction ↗</a>. Your wallet was included with the stated balance and ledger head.`
				: 'Verified against the on-chain anchor.';
		} else if (pendingAnchor) {
			hero.classList.add('is-pending');
			seal.innerHTML = '◷';
			title.textContent = 'Awaiting on-chain anchor';
			sub.textContent = 'Your inclusion proof is internally consistent: your wallet is in the tree with the balance and ledger head shown. The epoch itself has not been committed on-chain, so this is not yet timestamped by a public chain. On-chain anchoring is currently unavailable, so do not expect that step to complete on its own.';
		} else {
			hero.classList.add('is-failed');
			seal.innerHTML = '✕';
			title.textContent = 'Custody NOT verified';
			sub.textContent = result.summary || 'Verification failed.';
		}

		stepsEl.innerHTML = (result.steps || []).map(stepRow).join('');

		if (result.verified) renderShare();
	}

	function renderShare() {
		const wrap = panel.querySelector('[data-share]');
		if (!wrap) return;
		// The public, re-verifiable artifact is the anchor transaction itself: anyone
		// can open it on a block explorer and read the committed root without an
		// account, and it stays valid regardless of which of our own pages are
		// routed. Per-wallet leaves stay owner-gated, so the shared badge points at
		// the on-chain transaction, never at the private per-wallet proof. This block
		// only renders once verification passed, so `anchor.explorer` is always set.
		const publicUrl = anchor.explorer;
		if (!publicUrl) return;
		const ownUrl = `${esc(shareBase)}?agent=${encodeURIComponent(proof.leaf.agentId)}`;
		const embed = `<a href="${publicUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font:600 12px system-ui;color:#4ade80;text-decoration:none;padding:5px 11px;border:1px solid #4ade8055;border-radius:999px;background:#4ade801a">✓ Custody verified on-chain · three.ws</a>`;
		wrap.hidden = false;
		wrap.className = 'awh-proof-card';
		wrap.innerHTML = `
			<h2>Show it off</h2>
			<p class="awh-proof-lead">Your custody is provable. The badge links to the anchor transaction on Solana, where anyone can read the committed root for themselves.</p>
			<div class="awh-proof-actions">
				<span class="awh-proof-badge">Custody verified on-chain</span>
				<button class="awh-proof-btn ghost" type="button" data-copy-link>Copy anchor link</button>
				<button class="awh-proof-btn ghost" type="button" data-copy-embed>Copy badge embed</button>
				<a class="awh-proof-btn ghost" href="${ownUrl}" target="_blank" rel="noopener">Open my verifier ↗</a>
			</div>
			<div class="awh-proof-share">
				<textarea class="awh-proof-embed" readonly rows="2" aria-label="Badge embed HTML">${esc(embed)}</textarea>
			</div>
		`;
		wrap.querySelector('[data-copy-link]')?.addEventListener('click', () => copy(publicUrl, 'Anchor link copied'));
		wrap.querySelector('[data-copy-embed]')?.addEventListener('click', () => copy(embed, 'Badge embed copied'));
	}

	async function copy(text, msg) {
		try {
			if (ctx.copyToClipboard) await ctx.copyToClipboard(text);
			else await navigator.clipboard.writeText(text);
			(ctx.toast || ((m) => {}))(msg);
		} catch { /* clipboard blocked — the textarea is selectable as a fallback */ }
	}
}

function fact(k, vHtml) {
	return `<div class="awh-proof-fact"><div class="awh-proof-fact-k">${esc(k)}</div><div class="awh-proof-fact-v">${vHtml}</div></div>`;
}

function stepRow(step) {
	const cls = step.ok === true ? 'ok' : step.ok === false ? 'bad' : 'pending';
	const ico = step.ok === true ? '✓' : step.ok === false ? '✕' : '…';
	return `<li class="awh-proof-step ${cls}">
		<span class="awh-proof-step-ico" aria-hidden="true">${ico}</span>
		<span class="awh-proof-step-c">
			<span class="awh-proof-step-name">${esc(humanStep(step.name))}</span>
			<span class="awh-proof-step-detail">${esc(step.detail || '')}</span>
		</span>
	</li>`;
}

function humanStep(name) {
	return ({
		leaf_recompute: 'Recompute leaf from public data',
		merkle_path: 'Walk the Merkle path to the root',
		onchain_anchor: 'Read the anchor straight from the chain',
		root_match: 'Match computed root to on-chain root',
		proof_present: 'Inclusion proof',
	})[name] || name;
}

function eventRow(e) {
	const sign = Number(e.amount_sol) ? `−${Math.abs(Number(e.amount_sol)).toFixed(6)}` : e.amount_sol;
	const link = e.explorer
		? `<a href="${esc(e.explorer)}" target="_blank" rel="noopener">${esc((e.event_type || '').toUpperCase())} ↗</a>`
		: esc((e.event_type || '').toUpperCase());
	return `<li class="awh-proof-event"><span>${link}${e.category ? ` · ${esc(e.category)}` : ''}${e.reason ? ` · ${esc(e.reason)}` : ''}</span><span>${esc(sign)} SOL</span></li>`;
}

function notYetState(proof) {
	const latest = proof && proof.latest_epoch != null ? proof.latest_epoch : null;
	return `<div class="awh-proof"><div class="awh-proof-card">
		<h2>Not attested yet</h2>
		<p class="awh-proof-lead">This wallet hasn't been included in a custody attestation epoch yet${latest != null ? ` (latest epoch is #${esc(latest)})` : ''}. New wallets are picked up on the next snapshot — check back shortly and you'll be able to verify your custody on-chain.</p>
		<button class="awh-proof-btn ghost" type="button" data-reload>Check again</button>
	</div></div>`;
}

function formatSol(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

const STYLE_ID = 'poc-proof-style';

/** Inject the shared proof styles once (used by the hub tab and /proof page). */
export function injectProofStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = PROOF_STYLE;
	document.head.appendChild(tag);
}

export const PROOF_STYLE = `
.awh-proof { display: flex; flex-direction: column; gap: var(--space-4,16px); }
.awh-proof-card { border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-lg,14px); background: var(--surface-1, rgba(255,255,255,.03)); padding: var(--space-4,16px); }
.awh-proof-card h2 { margin: 0 0 6px; font-size: var(--text-md,.9rem); color: var(--ink-bright,#fff); font-family: var(--font-display, system-ui); font-weight: 600; }
.awh-proof-lead { color: var(--ink-dim,#888); font-size: var(--text-sm,.8125rem); line-height: 1.55; margin: 0 0 4px; max-width: 64ch; }
.awh-proof-hero { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; border-radius: var(--radius-lg,14px); padding: var(--space-4,16px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); background: var(--surface-1, rgba(255,255,255,.03)); transition: border-color var(--duration-base,220ms), background var(--duration-base,220ms); }
.awh-proof-hero.is-verified { border-color: color-mix(in srgb, var(--success,#4ade80) 50%, transparent); background: color-mix(in srgb, var(--success,#4ade80) 8%, transparent); }
.awh-proof-hero.is-failed { border-color: color-mix(in srgb, var(--danger,#f87171) 55%, transparent); background: color-mix(in srgb, var(--danger,#f87171) 8%, transparent); }
.awh-proof-hero.is-pending { border-color: color-mix(in srgb, var(--warn,#fbbf24) 50%, transparent); background: color-mix(in srgb, var(--warn,#fbbf24) 7%, transparent); }
.awh-proof-seal { width: 46px; height: 46px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 22px; background: var(--surface-3, rgba(255,255,255,.08)); }
.awh-proof-hero.is-verified .awh-proof-seal { background: color-mix(in srgb, var(--success,#4ade80) 18%, transparent); color: var(--success,#4ade80); }
.awh-proof-hero.is-failed .awh-proof-seal { background: color-mix(in srgb, var(--danger,#f87171) 18%, transparent); color: var(--danger,#f87171); }
.awh-proof-hero.is-pending .awh-proof-seal { background: color-mix(in srgb, var(--warn,#fbbf24) 18%, transparent); color: var(--warn,#fbbf24); }
.awh-proof-hero-main { min-width: 0; flex: 1; }
.awh-proof-hero-title { font-size: var(--text-lg,1.15rem); font-weight: 700; color: var(--ink-bright,#fff); font-family: var(--font-display, system-ui); line-height: 1.15; }
.awh-proof-hero-sub { font-size: var(--text-sm,.8125rem); color: var(--ink-dim,#888); margin-top: 3px; }
.awh-proof-hero-sub a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.awh-proof-spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--warn,#fbbf24) 30%, transparent); border-top-color: var(--warn,#fbbf24); animation: awh-proof-spin 0.7s linear infinite; }
@keyframes awh-proof-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .awh-proof-spin { animation: none; } }

.awh-proof-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3,12px); }
.awh-proof-fact { background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding: 11px 13px; }
.awh-proof-fact-k { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim,#888); }
.awh-proof-fact-v { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.8125rem); color: var(--ink-bright,#fff); margin-top: 4px; word-break: break-all; }
.awh-proof-fact-v a { color: inherit; }

.awh-proof-steps { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.awh-proof-step { display: flex; gap: 10px; align-items: flex-start; font-size: var(--text-sm,.8125rem); padding: 10px 12px; border-radius: var(--radius-md,10px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-proof-step-ico { flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
.awh-proof-step.ok { border-color: color-mix(in srgb, var(--success,#4ade80) 35%, transparent); }
.awh-proof-step.ok .awh-proof-step-ico { background: color-mix(in srgb, var(--success,#4ade80) 18%, transparent); color: var(--success,#4ade80); }
.awh-proof-step.bad { border-color: color-mix(in srgb, var(--danger,#f87171) 40%, transparent); }
.awh-proof-step.bad .awh-proof-step-ico { background: color-mix(in srgb, var(--danger,#f87171) 18%, transparent); color: var(--danger,#f87171); }
.awh-proof-step.pending .awh-proof-step-ico { background: var(--surface-3, rgba(255,255,255,.08)); color: var(--ink-dim,#888); }
.awh-proof-step-c { min-width: 0; }
.awh-proof-step-name { color: var(--ink-bright,#fff); font-weight: 600; }
.awh-proof-step-detail { color: var(--ink-dim,#888); margin-top: 2px; line-height: 1.5; }

.awh-proof-recon { border-radius: var(--radius-md,10px); padding: 12px 14px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); background: var(--surface-1, rgba(255,255,255,.03)); font-size: var(--text-sm,.8125rem); line-height: 1.55; color: var(--ink,#e8e8e8); }
.awh-proof-recon.is-good { border-color: color-mix(in srgb, var(--success,#4ade80) 35%, transparent); }
.awh-proof-recon.is-bad { border-color: color-mix(in srgb, var(--danger,#f87171) 50%, transparent); background: color-mix(in srgb, var(--danger,#f87171) 7%, transparent); color: var(--danger,#f87171); }
.awh-proof-recon-h { font-weight: 600; color: var(--ink-bright,#fff); display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.awh-proof-recon.is-bad .awh-proof-recon-h { color: var(--danger,#f87171); }
.awh-proof-events { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.awh-proof-event { display: flex; justify-content: space-between; gap: 12px; font-size: var(--text-2xs,.72rem); font-family: var(--font-mono, ui-monospace, monospace); color: var(--ink-dim,#888); padding: 6px 9px; border-radius: var(--radius-sm,6px); background: var(--surface-2, rgba(255,255,255,.04)); }
.awh-proof-event a { color: var(--ink,#c8c8c8); }

.awh-proof-btn { appearance: none; font: inherit; font-size: var(--text-sm,.8125rem); font-weight: 600; cursor: pointer; color: var(--bg-1,#0a0a0a); background: var(--accent,#fff); border: 1px solid var(--accent,#fff); border-radius: var(--radius-md,10px); padding: 9px 16px; text-decoration: none; display: inline-flex; align-items: center; gap: 7px; transition: opacity var(--duration-fast,140ms), transform var(--duration-fast,140ms); }
.awh-proof-btn:hover { opacity: .9; }
.awh-proof-btn:active { transform: translateY(1px); }
.awh-proof-btn:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }
.awh-proof-btn.ghost { color: var(--ink,#e8e8e8); background: transparent; border-color: var(--stroke, rgba(255,255,255,.12)); }
.awh-proof-btn:disabled { opacity: .5; cursor: progress; }
.awh-proof-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

.awh-proof-share { margin-top: 12px; }
.awh-proof-embed { width: 100%; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-2xs,.7rem); color: var(--ink-dim,#888); background: var(--surface-2, rgba(255,255,255,.04)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding: 9px 11px; resize: vertical; min-height: 54px; }
.awh-proof-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: var(--radius-pill,999px); font-size: var(--text-2xs,.72rem); font-weight: 600; border: 1px solid color-mix(in srgb, var(--success,#4ade80) 40%, transparent); color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 10%, transparent); }
.awh-proof-badge::before { content: '✓'; }

.awh-proof-skel span { display: block; background: var(--surface-2, rgba(255,255,255,.05)); border-radius: var(--radius-md,10px); animation: awh-skel 1.4s ease-in-out infinite; margin-bottom: 12px; }
@keyframes awh-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .awh-proof-skel span { animation: none; } }
`;
