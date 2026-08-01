/**
 * Trader Passport panel (Proof tab of /trader/<agent_id>).
 *
 * The Proof tab has always told visitors that the headline score is committed
 * on-chain daily. This panel is the part that lets them check it: the signed
 * credential itself, how old it is, how far the live numbers have drifted since it
 * was signed, and a Verify button that re-reads the attestation transaction from
 * Solana rather than from our database.
 *
 * Loaded lazily the first time the Proof tab is opened, the passport costs an
 * extra request, and most visitors never leave the track-record tab.
 */

import { escapeHtml, fmtSol, fmtPct, shortAddr, relTime, pnlClass } from './trader-format.js';

const state = { loaded: false, loading: false, data: null };

function solscanTx(sig, network) {
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}
function solscanAddr(addr, network) {
	return network === 'devnet' ? `https://solscan.io/account/${addr}?cluster=devnet` : `https://solscan.io/account/${addr}`;
}

function fmtNum(n, dp = 0) {
	return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(dp) : ', ';
}

/** How a committed field is rendered against its live counterpart. */
const DRIFT_ROWS = [
	{ key: 'score', label: 'Trader Score', fmt: (v) => fmtNum(v, 0) },
	{ key: 'closed', label: 'Closed trades', fmt: (v) => fmtNum(v, 0) },
	{ key: 'win_rate', label: 'Win rate', fmt: (v) => (typeof v === 'number' ? fmtPct(v * 100) : ', ') },
	{ key: 'realized_pnl_sol', label: 'Realized P&L', fmt: (v) => (typeof v === 'number' ? fmtSol(v) : ', ') },
	{ key: 'max_drawdown_pct', label: 'Max drawdown', fmt: (v) => (typeof v === 'number' ? fmtPct(v) : ', ') },
];

function skeleton() {
	return `
		<div class="tp-pp tp-pp-loading" aria-busy="true">
			<div class="tp-pp-head"><span class="tp-pp-title">Trader Passport</span></div>
			<div class="tp-sk tp-pp-sk"></div>
			<div class="tp-sk tp-pp-sk" style="width:70%"></div>
		</div>`;
}

function ageLine(days) {
	if (days == null) return '';
	if (days === 0) return 'signed today';
	if (days === 1) return 'signed yesterday';
	return `signed ${days} days ago`;
}

function unattested(d) {
	return `
		<div class="tp-pp tp-pp-empty">
			<div class="tp-pp-head">
				<span class="tp-pp-title">Trader Passport</span>
				<span class="tp-pp-badge tp-pp-badge-pending">Not yet attested</span>
			</div>
			<p class="tp-pp-note">${escapeHtml(d.unattested_reason || 'No on-chain attestation for this wallet yet.')}</p>
			<p class="tp-pp-note tp-pp-dim">
				Every trade above is already verifiable on its own, follow any row to its Solscan transaction. The passport
				adds a second layer: one signed statement that pins the whole score at a point in time.
			</p>
		</div>`;
}

function driftTable(drift) {
	if (!drift) return '';
	const rows = DRIFT_ROWS.map(({ key, label, fmt }) => {
		const f = drift.fields[key];
		if (!f) return '';
		const moved = f.delta != null && f.delta !== 0;
		const deltaCell = moved
			? `<span class="tp-pp-delta ${pnlClass(f.delta)}">${f.delta > 0 ? '+' : ''}${fmt(f.delta)}</span>`
			: '<span class="tp-pp-delta tp-pp-dim">unchanged</span>';
		return `<tr>
			<th scope="row">${label}</th>
			<td class="tp-pp-attested">${fmt(f.attested)}</td>
			<td class="tp-pp-live">${fmt(f.live)}</td>
			<td>${deltaCell}</td>
		</tr>`;
	}).join('');
	return `
		<table class="tp-pp-table">
			<caption class="tp-pp-caption">
				${drift.moved
					? 'The live record has moved since this credential was signed. Both numbers are shown, the credential is a snapshot, not a live feed.'
					: 'The live record still matches what was committed on-chain.'}
			</caption>
			<thead><tr><th scope="col">Metric</th><th scope="col">Committed</th><th scope="col">Live</th><th scope="col">Change</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>`;
}

function historyList(history, network) {
	const rows = history.filter((h) => h.day).slice(0, 8);
	if (rows.length < 2) return '';
	const items = rows.map((h) => `
		<li>
			<span class="tp-pp-hist-day">${escapeHtml(h.day)}</span>
			<span class="tp-pp-hist-score">${fmtNum(h.score, 0)}</span>
			<a href="${solscanTx(h.signature, network)}" target="_blank" rel="noopener">${escapeHtml(shortAddr(h.signature, 6, 6))} ↗</a>
		</li>`).join('');
	return `
		<details class="tp-pp-hist">
			<summary>${rows.length} daily attestations on record</summary>
			<ul class="tp-pp-hist-list">${items}</ul>
		</details>`;
}

function attested(d) {
	const c = d.credential;
	const age = ageLine(d.credential_age_days);
	const issuer = d.issuer?.attester;
	return `
		<div class="tp-pp">
			<div class="tp-pp-head">
				<span class="tp-pp-title">Trader Passport</span>
				<span class="tp-pp-badge tp-pp-badge-ok">Attested on-chain</span>
				<span class="tp-pp-kind">${escapeHtml(d.kind)}</span>
			</div>

			<p class="tp-pp-note">
				This trader's ${escapeHtml(c.window === 'all' ? 'all-time' : c.window)} score was committed to Solana on
				<strong>${escapeHtml(c.day || '')}</strong>${age ? ` (${age})` : ''} as a memo signed by the three.ws attester${
					issuer ? `, <a class="tp-proof-link" href="${solscanAddr(issuer, d.network)}" target="_blank" rel="noopener">${escapeHtml(shortAddr(issuer))} ↗</a>` : ''
				}. It cannot be edited after the fact, and it is readable by any application, not just this page.
			</p>

			${driftTable(d.drift)}

			<div class="tp-pp-facts">
				<a class="tp-pp-fact" href="${solscanTx(c.signature, d.network)}" target="_blank" rel="noopener">
					<span class="tp-pp-fact-k">Attestation</span>
					<span class="tp-pp-fact-v">${escapeHtml(shortAddr(c.signature, 6, 6))} ↗</span>
				</a>
				<div class="tp-pp-fact">
					<span class="tp-pp-fact-k">Slot</span>
					<span class="tp-pp-fact-v">${c.slot != null ? c.slot : ', '}</span>
				</div>
				<div class="tp-pp-fact">
					<span class="tp-pp-fact-k">Signed</span>
					<span class="tp-pp-fact-v">${c.block_time ? escapeHtml(relTime(c.block_time)) : ', '}</span>
				</div>
			</div>

			${historyList(d.history || [], d.network)}

			<div class="tp-pp-actions">
				<button class="lb-btn lb-btn-primary" id="tp-pp-verify" type="button">Verify against the chain</button>
				<button class="lb-btn" id="tp-pp-copy" type="button">Copy passport API URL</button>
			</div>
			<div class="tp-pp-verdict" id="tp-pp-verdict" role="status" aria-live="polite"></div>
			<p class="tp-pp-note tp-pp-dim">
				Verification re-reads the transaction from a Solana RPC node and re-checks the signer, the subject wallet and
				the payload. It reads no three.ws database, so the result holds even if you don't trust this site.
			</p>
		</div>`;
}

function renderVerdict(el, v) {
	if (v.valid) {
		el.className = 'tp-pp-verdict is-ok';
		el.innerHTML = `
			<strong>Verified on-chain.</strong> The memo at
			<a href="${solscanTx(v.signature, v.network)}" target="_blank" rel="noopener">${escapeHtml(shortAddr(v.signature, 6, 6))} ↗</a>
			was signed by <code>${escapeHtml(shortAddr(v.attester || '', 6, 6))}</code> and commits
			<code>${escapeHtml(shortAddr(v.subject || '', 4, 4))}</code>'s score of
			<strong>${fmtNum(v.payload?.score, 0)}</strong> at slot ${v.slot ?? ', '}.`;
		return;
	}
	el.className = 'tp-pp-verdict is-bad';
	const reasons = (v.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
	el.innerHTML = `
		<strong>This credential did not verify.</strong>
		${reasons ? `<ul>${reasons}</ul>` : ''}
		<span class="tp-pp-dim">Treat the committed score as unproven and rely on the per-trade transactions above.</span>`;
}

function wire(host, ctx, data) {
	const verifyBtn = host.querySelector('#tp-pp-verify');
	const verdict = host.querySelector('#tp-pp-verdict');
	verifyBtn?.addEventListener('click', async () => {
		verifyBtn.disabled = true;
		const label = verifyBtn.textContent;
		verifyBtn.textContent = 'Checking the chain…';
		verdict.className = 'tp-pp-verdict is-busy';
		verdict.textContent = 'Reading the attestation transaction from Solana…';
		try {
			const url = `/api/trader-passport/verify?signature=${encodeURIComponent(data.credential.signature)}`
				+ `&network=${encodeURIComponent(data.network)}&wallet=${encodeURIComponent(data.subject.wallet)}`
				+ (data.issuer?.attester ? `&attester=${encodeURIComponent(data.issuer.attester)}` : '');
			const r = await fetch(url, { headers: { accept: 'application/json' } });
			const v = await r.json();
			if (!r.ok) throw new Error(v?.message || `verification failed (${r.status})`);
			renderVerdict(verdict, v);
		} catch (err) {
			verdict.className = 'tp-pp-verdict is-bad';
			verdict.innerHTML = `<strong>Could not reach the chain.</strong> ${escapeHtml(err.message)} <span class="tp-pp-dim">The credential itself is unchanged, try again.</span>`;
		} finally {
			verifyBtn.disabled = false;
			verifyBtn.textContent = label;
		}
	});

	host.querySelector('#tp-pp-copy')?.addEventListener('click', async () => {
		const url = `${location.origin}/api/trader-passport?wallet=${encodeURIComponent(data.subject.wallet)}&network=${encodeURIComponent(data.network)}`;
		try {
			await navigator.clipboard.writeText(url);
			ctx.toast?.('Passport API URL copied');
		} catch {
			ctx.toast?.(url);
		}
	});
}

/**
 * Render the passport into `host`. Safe to call repeatedly, the fetch happens once
 * per page load, and a failure renders an honest, recoverable message.
 *
 * @param {HTMLElement} host
 * @param {{ agentId: string, network: string, window: string, toast?: (m: string) => void }} ctx
 */
export async function mountPassport(host, ctx) {
	if (!host || state.loading) return;
	if (state.loaded && state.data) return;

	state.loading = true;
	host.innerHTML = skeleton();
	try {
		const url = `/api/trader-passport?agent_id=${encodeURIComponent(ctx.agentId)}`
			+ `&network=${encodeURIComponent(ctx.network)}&window=${encodeURIComponent(ctx.window)}`;
		const r = await fetch(url, { headers: { accept: 'application/json' } });
		const data = await r.json();
		if (!r.ok) throw new Error(data?.message || `passport unavailable (${r.status})`);
		state.data = data;
		state.loaded = true;
		host.innerHTML = data.status === 'attested' ? attested(data) : unattested(data);
		if (data.status === 'attested') wire(host, ctx, data);
	} catch (err) {
		host.innerHTML = `
			<div class="tp-pp tp-pp-empty">
				<div class="tp-pp-head"><span class="tp-pp-title">Trader Passport</span></div>
				<p class="tp-pp-note">Could not load the on-chain credential: ${escapeHtml(err.message)}</p>
				<button class="lb-btn" id="tp-pp-retry" type="button">Try again</button>
			</div>`;
		host.querySelector('#tp-pp-retry')?.addEventListener('click', () => {
			state.loaded = false;
			mountPassport(host, ctx);
		});
	} finally {
		state.loading = false;
	}
}

/** Drop the cached passport so the next mount refetches (window/network changed). */
export function resetPassport() {
	state.loaded = false;
	state.data = null;
}
