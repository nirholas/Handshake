/**
 * Agent Wallet hub — Balance tab (fully built).
 *
 * Live SOL balance + USD estimate, recent on-chain activity, manual refresh, and
 * a 30s poll while visible. Every state is designed: skeleton loading, populated,
 * empty (no balance / no activity), and a "balance unavailable" RPC-failure state
 * that retries rather than showing a misleading 0 or a thrown error.
 *
 * All balances are real, read from GET /api/agents/:id/solana (and …/activity) —
 * the same live-RPC path with failover + 60s server cache used elsewhere. No
 * hardcoded or sample balances.
 */

import { registerWalletTab } from '../registry.js';
import { fetchAgentSolanaWallet, fetchAgentSolanaActivity } from '../../agent-solana-wallet.js';
import { solToUsd } from '../../shared/usd-price.js';
import { formatSol, timeAgo, explorerAddressUrl, explorerTxUrl } from '../util.js';

const POLL_MS = 30_000;

const BAL_STYLE_ID = 'awh-balance-style';
const BAL_STYLE = `
.awh-bal-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3,12px); }
.awh-bal-amount { font-family: var(--font-display, system-ui); font-size: var(--text-xl, 1.618rem); font-weight: 700; color: var(--ink-bright,#fff); line-height: 1.1; }
.awh-bal-amount.is-unavailable { font-size: var(--text-md,.8125rem); font-weight: 600; color: var(--warn,#fbbf24); cursor: help; }
.awh-bal-usd { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top: 4px; }
.awh-bal-refresh { flex: none; }
/* .awh-bal-addr / .awh-bal-addr .awh-mono / .awh-bal-mini live in the hub shell
 * stylesheet (index.js) so pay/trade reuse them regardless of mount order. */
.awh-bal-note { margin-top: var(--space-3,12px); font-size: var(--text-sm,.764rem); color: var(--warn,#fbbf24); }
.awh-bal-refresh-icon { display: inline-block; }
.awh-bal-refresh-icon.is-spinning { animation: awh-bal-spin .7s linear infinite; }
@keyframes awh-bal-spin { to { transform: rotate(360deg); } }

.awh-act-list { list-style: none; margin: 0; padding: 0; }
.awh-act-row { display: flex; align-items: center; gap: var(--space-3,12px); padding: 9px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awh-act-row:last-child { border-bottom: none; }
/* .awh-act-sig / .awh-act-sig:hover live in the hub shell stylesheet (index.js). */
.awh-act-meta { color: var(--ink-dim,#888); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awh-act-delta { font-family: var(--font-mono, ui-monospace, monospace); flex: none; }
.awh-act-delta.is-pos { color: var(--success,#4ade80); }
.awh-act-delta.is-neg { color: var(--danger,#f87171); }
.awh-act-fail { display: inline-block; margin-right: 7px; font-size: var(--text-2xs,.6875rem); font-weight: 600; color: var(--danger,#f87171); border: 1px solid color-mix(in srgb, var(--danger,#f87171) 40%, transparent); border-radius: var(--radius-pill,999px); padding: 0 7px; vertical-align: middle; flex: none; }

.awh-bal-skelbar, .awh-act-skel span { background: var(--surface-2, rgba(255,255,255,.05)); border-radius: var(--radius-sm,6px); animation: awh-skel 1.4s ease-in-out infinite; }
.awh-bal-skelbar--lg { height: 28px; width: 42%; margin-bottom: 10px; }
.awh-bal-skelbar--sm { height: 14px; width: 26%; margin-bottom: 18px; }
.awh-bal-skelbar--row { height: 34px; width: 60%; }
.awh-act-skel { display: flex; flex-direction: column; gap: 10px; }
.awh-act-skel span { height: 16px; width: 100%; }
.awh-act-skel span:nth-child(2) { width: 80%; }
.awh-act-skel span:nth-child(3) { width: 88%; }
@keyframes awh-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .awh-bal-skelbar, .awh-act-skel span, .awh-bal-refresh-icon.is-spinning { animation: none; } }
`;
function injectBalanceStyle() {
	if (typeof document === 'undefined' || document.getElementById(BAL_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = BAL_STYLE_ID;
	tag.textContent = BAL_STYLE;
	document.head.appendChild(tag);
}

registerWalletTab({
	id: 'balance',
	label: 'Balance',
	order: 10,
	ownerOnly: false,
	mount({ panel, ctx }) {
		injectBalanceStyle();
		const { escapeHtml, shortAddress, copyToClipboard, toast } = ctx;
		let pollTimer = null;
		let detachNet = null;
		let visible = false;
		let destroyed = false;

		const state = {
			loaded: false,
			address: ctx.agent.solana_address || ctx.agent.meta?.solana_address || null,
			sol: null,
			usd: null,
			balanceError: null,
			activity: null,
			activityError: null,
			activityLoaded: false,
			refreshing: false,
		};

		// GET /api/agents/:id/solana/activity is owner-only (401 anonymous, 403 for
		// another owner). A visitor requesting it gets no data, one console error
		// per load, and a Retry button that can never succeed, so the visitor view
		// says the feed is private instead of pretending the request failed.
		const canReadActivity = ctx.isOwner;

		function render() {
			if (destroyed) return;
			if (!state.loaded) {
				panel.innerHTML = `
					<div class="awh-card awh-bal-skel" aria-busy="true" aria-label="Loading balance">
						<div class="awh-bal-skelbar awh-bal-skelbar--lg"></div>
						<div class="awh-bal-skelbar awh-bal-skelbar--sm"></div>
						<div class="awh-bal-skelbar awh-bal-skelbar--row"></div>
					</div>`;
				return;
			}

			const net = ctx.getNetwork();
			const hasAddr = !!state.address;
			const balUnavailable = state.balanceError != null;
			const balText = balUnavailable
				? 'Balance unavailable'
				: state.sol == null
					? '—'
					: `${formatSol(state.sol)} SOL`;
			const usdText =
				!balUnavailable && state.usd != null
					? `≈ $${state.usd.toLocaleString('en-US', { maximumFractionDigits: state.usd < 1 ? 4 : 2 })}`
					: '';

			panel.innerHTML = `
				<div class="awh-card" ${state.refreshing ? 'aria-busy="true"' : ''}>
					<div class="awh-bal-top">
						<div role="status" aria-live="polite">
							<div class="awh-bal-amount ${balUnavailable ? 'is-unavailable' : ''}"
								${balUnavailable ? 'title="The Solana RPC could not be reached — this retries automatically."' : ''}>
								${escapeHtml(balText)}
							</div>
							${usdText ? `<div class="awh-bal-usd">${escapeHtml(usdText)}</div>` : ''}
						</div>
						<button class="awh-btn awh-bal-refresh" type="button" data-act="refresh"
							${state.refreshing ? 'disabled' : ''} aria-label="Refresh balance">
							<span class="awh-bal-refresh-icon ${state.refreshing ? 'is-spinning' : ''}" aria-hidden="true">↻</span>
							${state.refreshing ? 'Refreshing…' : 'Refresh'}
						</button>
					</div>
					${
						hasAddr
							? `<div class="awh-bal-addr">
									<span class="awh-mono" title="${escapeHtml(state.address)}">${escapeHtml(shortAddress(state.address, 6, 6))}</span>
									<button class="awh-btn awh-bal-mini" type="button" data-act="copy" aria-label="Copy wallet address">Copy</button>
									<a class="awh-btn awh-bal-mini" href="${escapeHtml(explorerAddressUrl(state.address, net))}" target="_blank" rel="noopener">Explorer ↗</a>
								</div>`
							: `<div class="awh-empty">This agent does not have a Solana wallet yet. It is being prepared automatically.</div>`
					}
					${
						balUnavailable
							? `<div class="awh-bal-note">The Solana network was unreachable. Retrying automatically — your funds are safe.</div>`
							: ''
					}
				</div>

				<div class="awh-card">
					<h2 class="awh-card-h">Recent activity</h2>
					<div data-host="activity">
						${
							!state.activityLoaded
								? `<div class="awh-act-skel"><span></span><span></span><span></span></div>`
								: renderActivity(net)
						}
					</div>
				</div>
			`;

			panel.querySelector('[data-act="refresh"]')?.addEventListener('click', () => {
				refreshAll(true);
			});
			panel.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
				const ok = await copyToClipboard(state.address);
				toast(ok ? 'Address copied' : 'Copy failed — select it manually');
			});
		}

		function renderActivity(net) {
			if (!canReadActivity) {
				const explorer = state.address
					? ` Every transaction is still public on the <a class="awh-act-sig" href="${escapeHtml(explorerAddressUrl(state.address, net))}" target="_blank" rel="noopener">block explorer</a>.`
					: '';
				return `<div class="awh-empty">This wallet's activity feed is private to its owner.${explorer}</div>`;
			}
			if (state.activityError) {
				return `<div class="awh-empty">Could not load activity. <button class="awh-btn awh-bal-mini" type="button" data-act="retry-activity">Retry</button></div>`;
			}
			const rows = state.activity || [];
			if (!rows.length) {
				return `<div class="awh-empty">No on-chain activity yet. Deposits and trades appear here.</div>`;
			}
			return `<ul class="awh-act-list">${rows
				.map((a) => {
					const delta = a.sol_delta;
					let cls = '';
					let txt = '—';
					if (typeof delta === 'number') {
						cls = delta > 0 ? 'is-pos' : delta < 0 ? 'is-neg' : '';
						txt = `${delta > 0 ? '+' : ''}${formatSol(delta)} SOL`;
					}
					const failed = a.success === false;
					const timeStr = timeAgo(a.block_time);
					const label = a.summary || (failed ? '' : 'transfer');
					const metaText = [label, timeStr].filter(Boolean).join(' · ');
					const failBadge = failed
						? '<span class="awh-act-fail" title="This transaction failed on-chain">Failed</span>'
						: '';
					return `<li class="awh-act-row">
						<a class="awh-mono awh-act-sig" href="${escapeHtml(explorerTxUrl(a.signature, net))}" target="_blank" rel="noopener" aria-label="View transaction ${escapeHtml(shortAddress(a.signature, 6, 4))} on the block explorer">${escapeHtml(shortAddress(a.signature, 6, 4))}</a>
						<span class="awh-act-meta">${failBadge}${escapeHtml(metaText)}</span>
						<span class="awh-act-delta ${cls}">${escapeHtml(txt)}</span>
					</li>`;
				})
				.join('')}</ul>`;
		}

		async function loadBalance() {
			const net = ctx.getNetwork();
			let r;
			try {
				r = await fetchAgentSolanaWallet(ctx.agentId, net);
			} catch {
				// Transient client/network failure — surface as the designed
				// "unavailable" state rather than a thrown error.
				state.balanceError = 'rpc_error';
				return;
			}
			if (r.status === 'forbidden') {
				// Visitor on a non-owned wallet still reads the public balance via
				// the same endpoint; a 401/403 here means the wallet read is gated.
				// Fall back to whatever public address we already have.
				return;
			}
			if (r.status === 'none') {
				state.address = null;
				state.sol = null;
				state.balanceError = null;
				return;
			}
			if (r.status === 'error') {
				state.balanceError = 'rpc_error';
				return;
			}
			// ok
			state.address = r.data.address || state.address;
			state.sol = r.data.sol;
			state.balanceError = r.data.balance_error || null;
			if (!state.balanceError && state.sol != null) {
				state.usd = await solToUsd(state.sol);
			} else {
				state.usd = null;
			}
		}

		async function loadActivity() {
			const net = ctx.getNetwork();
			if (!canReadActivity || !state.address) {
				state.activity = [];
				state.activityLoaded = true;
				state.activityError = null;
				return;
			}
			try {
				const data = await fetchAgentSolanaActivity(ctx.agentId, net, 10);
				state.activity = data?.signatures || [];
				state.activityError = null;
			} catch (e) {
				state.activityError = e?.message || 'activity_error';
			} finally {
				state.activityLoaded = true;
			}
		}

		async function refreshAll(manual = false) {
			if (state.refreshing) return;
			state.refreshing = manual;
			if (manual) render();
			await Promise.all([loadBalance(), loadActivity()]);
			state.loaded = true;
			state.refreshing = false;
			render();
		}

		function startPoll() {
			stopPoll();
			pollTimer = setInterval(() => {
				if (!visible || destroyed) return;
				// Poll balance only (cheap); leave activity to manual refresh +
				// the next show to avoid hammering the parsed-tx RPC.
				loadBalance().then(() => render());
			}, POLL_MS);
		}
		function stopPoll() {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
		}

		// React to network switches from the hub header.
		detachNet = ctx.onNetworkChange(() => {
			state.loaded = false;
			state.activityLoaded = false;
			state.activity = null;
			state.usd = null;
			render();
			refreshAll();
		});

		// Delegate the activity-retry button (it lives inside the activity host).
		panel.addEventListener('click', (e) => {
			if (e.target?.dataset?.act === 'retry-activity') {
				state.activityLoaded = false;
				render();
				loadActivity().then(() => render());
			}
		});

		render();

		return {
			onShow() {
				visible = true;
				if (!state.loaded) refreshAll();
				else render();
				startPoll();
			},
			onHide() {
				visible = false;
				stopPoll();
			},
			destroy() {
				destroyed = true;
				stopPoll();
				detachNet?.();
			},
		};
	},
});
