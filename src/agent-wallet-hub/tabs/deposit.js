/**
 * Agent Wallet hub — Deposit tab (fully built).
 *
 * The public, onboarding-grade "fund this agent" surface. Visible to the owner
 * AND to visitors — funding someone's agent is a first-class, public-safe action,
 * so there are no secrets and no management controls here.
 *
 * What it does:
 *   • Shows who you're funding (agent name + avatar) so the deposit is trustworthy.
 *   • Renders the agent's Solana address in full + truncated, with one-tap copy.
 *   • Renders a crisp Solana-Pay `solana:<address>?label=…[&amount=…]` QR via the
 *     first-party, zero-dependency generator in src/erc8004/qr.js — NO third-party
 *     CDN. Tapping the QR (or the "Open in a wallet app" link) fires the same
 *     `solana:` deep-link so a phone opens Phantom / Solflare / Backpack / etc.
 *   • Optional amount field that rewrites the QR + deep-link `?amount=` (in SOL).
 *   • Live "funds received" confirmation: polls the real on-chain balance and, the
 *     moment it increases, shows "◎X SOL received" and refreshes recent activity.
 *     The confirmation fires ONLY on a real balance increase — never simulated.
 *
 * Every state is designed: loading skeleton, waiting-for-first-deposit (calm empty
 * state), received (success), no-wallet (being prepared), and an RPC-unreachable
 * state that keeps the address + QR fully usable while live confirmation retries.
 *
 * Balance is read from GET /api/agents/:id/solana (the same live-RPC path with
 * failover + 60s server cache used across the hub). No hardcoded balances, no
 * fake "received" events.
 */

import { registerWalletTab } from '../registry.js';
import { fetchAgentSolanaWallet, fetchAgentSolanaActivity } from '../../agent-solana-wallet.js';
import { renderQRToSVG } from '../../erc8004/qr.js';
import { buildSolanaPayUri } from '../../shared/solana-pay.js';
import { formatSol, timeAgo, explorerAddressUrl, explorerTxUrl } from '../util.js';

// Balance is server-cached for 60s, so a faster poll just re-reads the cache.
// 15s keeps the "waiting for your deposit" loop feeling live without hammering RPC.
const POLL_MS = 15_000;

const DEP_STYLE_ID = 'awh-deposit-style';
const DEP_STYLE = `
.awh-dep-who { display: flex; align-items: center; gap: var(--space-3,12px); margin-bottom: var(--space-3,12px); }
.awh-dep-who-av { width: 36px; height: 36px; border-radius: var(--radius-md,10px); object-fit: cover; flex: none; background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); }
.awh-dep-who-txt { font-size: var(--text-md,.8125rem); color: var(--ink-dim,#888); line-height: 1.35; }
.awh-dep-who-txt strong { color: var(--ink-bright,#fff); font-weight: 600; }

.awh-dep-grid { display: grid; grid-template-columns: auto 1fr; gap: var(--space-5,20px); align-items: start; }
@media (max-width: 560px) { .awh-dep-grid { grid-template-columns: 1fr; } }

.awh-dep-qrwrap { display: flex; flex-direction: column; align-items: center; gap: var(--space-2,8px); }
.awh-dep-qr { display: block; width: 188px; max-width: 52vw; height: auto; padding: 10px; background: #fff; border-radius: var(--radius-md,10px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); transition: transform var(--duration-fast,140ms) var(--ease-standard,ease), box-shadow var(--duration-fast,140ms) var(--ease-standard,ease); }
a.awh-dep-qr:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(0,0,0,.35); }
a.awh-dep-qr:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 3px; }
.awh-dep-qr svg { display: block; width: 100%; height: auto; }
.awh-dep-deeplink { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); text-decoration: none; border-bottom: 1px dotted currentColor; }
.awh-dep-deeplink:hover { color: var(--ink,#e8e8e8); }

.awh-dep-side { display: flex; flex-direction: column; gap: var(--space-3,12px); min-width: 0; }
.awh-dep-label { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim,#888); }
.awh-dep-addr { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-sm,6px); padding: 9px 11px; word-break: break-all; line-height: 1.5; }
.awh-dep-actions { display: flex; gap: var(--space-2,8px); flex-wrap: wrap; }

.awh-dep-amount { display: flex; flex-direction: column; gap: 5px; }
.awh-dep-amount-field { display: flex; align-items: center; gap: 6px; background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-sm,6px); padding: 2px 10px; transition: border-color var(--duration-fast,140ms); }
.awh-dep-amount-field:focus-within { border-color: var(--stroke-strong, rgba(255,255,255,.22)); }
.awh-dep-amount-field input { flex: 1 1 auto; min-width: 0; appearance: none; -moz-appearance: textfield; font: inherit; font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); background: transparent; border: none; padding: 8px 0; }
.awh-dep-amount-field input::-webkit-outer-spin-button, .awh-dep-amount-field input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.awh-dep-amount-field input:focus { outline: none; }
.awh-dep-amount-field .unit { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); font-family: var(--font-mono, ui-monospace, monospace); flex: none; }
.awh-dep-amount-hint { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }
.awh-dep-amount-hint.is-err { color: var(--warn,#fbbf24); }

.awh-dep-how { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); line-height: 1.55; margin: 0; }

.awh-dep-status { display: flex; align-items: center; gap: 10px; }
.awh-dep-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.awh-dep-status[data-state="waiting"] .awh-dep-dot { background: var(--warn,#fbbf24); animation: awh-dep-pulse 1.5s ease-in-out infinite; }
.awh-dep-status[data-state="received"] .awh-dep-dot { background: var(--success,#4ade80); box-shadow: 0 0 8px color-mix(in srgb, var(--success,#4ade80) 70%, transparent); }
.awh-dep-status[data-state="paused"] .awh-dep-dot { background: var(--ink-dim,#888); }
.awh-dep-status-txt { font-size: var(--text-md,.8125rem); color: var(--ink,#e8e8e8); }
.awh-dep-status[data-state="received"] .awh-dep-status-txt { color: var(--success,#4ade80); font-weight: 600; }
.awh-dep-status-sub { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top: 3px; }
.awh-dep-received { animation: awh-dep-pop var(--duration-base,220ms) var(--ease-out,ease); }

.awh-dep-act-list { list-style: none; margin: 0; padding: 0; }
.awh-dep-act-row { display: flex; align-items: center; gap: var(--space-3,12px); padding: 8px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awh-dep-act-row:last-child { border-bottom: none; }
.awh-dep-act-sig { color: var(--ink,#e8e8e8); text-decoration: none; font-family: var(--font-mono, ui-monospace, monospace); }
.awh-dep-act-sig:hover { text-decoration: underline; }
.awh-dep-act-meta { color: var(--ink-dim,#888); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awh-dep-act-delta { font-family: var(--font-mono, ui-monospace, monospace); flex: none; }
.awh-dep-act-delta.is-pos { color: var(--success,#4ade80); }
.awh-dep-act-delta.is-neg { color: var(--danger,#f87171); }

.awh-dep-skel { display: flex; flex-direction: column; gap: 14px; }
.awh-dep-skel span { background: var(--surface-2, rgba(255,255,255,.05)); border-radius: var(--radius-sm,6px); animation: awh-skel 1.4s ease-in-out infinite; height: 16px; }
.awh-dep-skel span.qr { height: 168px; width: 168px; border-radius: var(--radius-md,10px); }
.awh-dep-skel span.l { width: 70%; } .awh-dep-skel span.m { width: 50%; }

@keyframes awh-dep-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.85); } }
@keyframes awh-dep-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes awh-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .awh-dep-status .awh-dep-dot, .awh-dep-received, .awh-dep-skel span { animation: none; } a.awh-dep-qr:hover { transform: none; } }
`;

function injectDepositStyle() {
	if (typeof document === 'undefined' || document.getElementById(DEP_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = DEP_STYLE_ID;
	tag.textContent = DEP_STYLE;
	document.head.appendChild(tag);
}

registerWalletTab({
	id: 'deposit',
	label: 'Deposit',
	order: 20,
	ownerOnly: false,
	mount({ panel, ctx }) {
		injectDepositStyle();
		const { escapeHtml, shortAddress, copyToClipboard, toast } = ctx;

		let pollTimer = null;
		let detachNet = null;
		let visible = false;
		let destroyed = false;
		let qrDebounce = null;

		const agentName = ctx.agent?.name || 'this agent';
		const avatar = ctx.agent?.avatar_thumbnail_url || '';
		// Solana-Pay labels are short merchant-style names. Clamp the (user-controlled,
		// unbounded) agent name so it can never push the QR payload past the generator's
		// version-10 capacity — the address + deep-link must always stay scannable.
		const qrLabel = agentName.length > 48 ? `${agentName.slice(0, 47)}…` : agentName;

		const state = {
			loaded: false,
			address: ctx.agent?.solana_address || ctx.agent?.meta?.solana_address || null,
			amount: '', // user-entered SOL amount for the QR/deep-link
			amountError: false,
			// Live confirmation tracking.
			baselineSol: null, // first observed balance; deposits are measured against it
			balanceError: false,
			received: null, // { delta, total } of the most recent detected deposit
			receivedCount: 0,
			// Recent activity (refreshed when a deposit lands).
			activity: null,
			activityLoaded: false,
		};

		function solanaUri() {
			return buildSolanaPayUri(state.address, {
				amount: state.amountError ? null : state.amount,
				label: qrLabel,
			});
		}

		function qrMarkup() {
			const uri = solanaUri();
			if (!uri) return '';
			// First-party, zero-dep QR. SVG scales crisply at any size and needs no canvas.
			// The generator throws above its version-10 capacity; the clamped label keeps
			// us well under it, but fall back to an address-only code (always within
			// capacity) rather than ever throwing out of render or the debounce timer.
			try {
				return renderQRToSVG(uri, { scale: 6, margin: 1 });
			} catch {
				const safe = buildSolanaPayUri(state.address, {});
				try {
					return safe ? renderQRToSVG(safe, { scale: 6, margin: 1 }) : '';
				} catch {
					return '';
				}
			}
		}

		function statusBlock() {
			if (state.balanceError) {
				return `
					<div class="awh-dep-status" data-state="paused">
						<span class="awh-dep-dot" aria-hidden="true"></span>
						<div>
							<div class="awh-dep-status-txt">Live confirmation paused</div>
							<div class="awh-dep-status-sub">The Solana network was unreachable — retrying automatically. Your deposit will still arrive; this panel will confirm it once the network responds.</div>
						</div>
					</div>`;
			}
			if (state.received) {
				const sub =
					state.receivedCount > 1
						? `That's deposit #${state.receivedCount}. Balance is now ◎${escapeHtml(formatSol(state.received.total))} SOL.`
						: `Balance is now ◎${escapeHtml(formatSol(state.received.total))} SOL. Send more any time, or head to the Balance and Trade tabs.`;
				return `
					<div class="awh-dep-status awh-dep-received" data-state="received">
						<span class="awh-dep-dot" aria-hidden="true"></span>
						<div>
							<div class="awh-dep-status-txt">◎${escapeHtml(formatSol(state.received.delta))} SOL received</div>
							<div class="awh-dep-status-sub">${sub}</div>
						</div>
					</div>`;
			}
			return `
				<div class="awh-dep-status" data-state="waiting">
					<span class="awh-dep-dot" aria-hidden="true"></span>
					<div>
						<div class="awh-dep-status-txt">Waiting for your first deposit…</div>
						<div class="awh-dep-status-sub">Scan the code or send SOL to the address above. The moment funds land on-chain, you'll see it confirmed right here.</div>
					</div>
				</div>`;
		}

		function activityBlock(net) {
			if (!state.activityLoaded) return '';
			const rows = state.activity || [];
			if (!rows.length) return '';
			return `
				<div class="awh-card">
					<h2 class="awh-card-h">Recent activity</h2>
					<ul class="awh-dep-act-list">
						${rows
							.map((a) => {
								const delta = a.sol_delta;
								let cls = '';
								let txt = '—';
								if (typeof delta === 'number') {
									cls = delta > 0 ? 'is-pos' : delta < 0 ? 'is-neg' : '';
									txt = `${delta > 0 ? '+' : ''}${formatSol(delta)} SOL`;
								}
								const failed = a.success === false;
								return `<li class="awh-dep-act-row">
									<a class="awh-dep-act-sig" href="${escapeHtml(explorerTxUrl(a.signature, net))}" target="_blank" rel="noopener">${escapeHtml(shortAddress(a.signature, 6, 4))}</a>
									<span class="awh-dep-act-meta">${escapeHtml(a.summary ? a.summary : failed ? 'failed' : 'transfer')} · ${escapeHtml(timeAgo(a.block_time))}</span>
									<span class="awh-dep-act-delta ${cls}">${escapeHtml(txt)}</span>
								</li>`;
							})
							.join('')}
					</ul>
				</div>`;
		}

		function render() {
			if (destroyed) return;
			const net = ctx.getNetwork();

			if (!state.loaded) {
				panel.innerHTML = `
					<div class="awh-card awh-dep-skel" aria-busy="true" aria-label="Loading deposit details">
						<span class="qr"></span>
						<span class="l"></span>
						<span class="m"></span>
					</div>`;
				return;
			}

			if (!state.address) {
				panel.innerHTML = `
					<div class="awh-card">
						<div class="awh-dep-who">
							${avatar ? `<img class="awh-dep-who-av" src="${escapeHtml(avatar)}" alt="" loading="lazy" data-fallback="remove" />` : ''}
							<div class="awh-dep-who-txt">You're funding <strong>${escapeHtml(agentName)}</strong></div>
						</div>
						<div class="awh-empty">This agent's Solana wallet is still being prepared. It's created automatically — refresh in a moment and the deposit address will appear here.</div>
						<div class="awh-dep-actions" style="margin-top:12px">
							<button class="awh-btn" type="button" data-act="reload">Refresh</button>
						</div>
					</div>`;
				panel.querySelector('[data-act="reload"]')?.addEventListener('click', () => {
					state.loaded = false;
					render();
					loadInitial();
				});
				return;
			}

			const uri = solanaUri();
			panel.innerHTML = `
				<div class="awh-card">
					<div class="awh-dep-who">
						${avatar ? `<img class="awh-dep-who-av" src="${escapeHtml(avatar)}" alt="" loading="lazy" data-fallback="remove" />` : ''}
						<div class="awh-dep-who-txt">You're funding <strong>${escapeHtml(agentName)}</strong> — send SOL to the wallet below.</div>
					</div>

					<div class="awh-dep-grid">
						<div class="awh-dep-qrwrap">
							<a class="awh-dep-qr" data-host="qr" href="${escapeHtml(uri)}"
								aria-label="Solana deposit link for ${escapeHtml(agentName)} — scan with a phone wallet, or tap to open a wallet app">${qrMarkup()}</a>
							<a class="awh-dep-deeplink" data-host="deeplink" href="${escapeHtml(uri)}">Open in a wallet app ↗</a>
						</div>

						<div class="awh-dep-side">
							<div>
								<div class="awh-dep-label">Wallet address${net === 'devnet' ? ' · Devnet' : ''}</div>
								<div class="awh-dep-addr" title="${escapeHtml(state.address)}">${escapeHtml(state.address)}</div>
							</div>
							<div class="awh-dep-actions">
								<button class="awh-btn awh-btn--primary" type="button" data-act="tip" aria-label="Tip from your connected wallet">◎ Tip from your wallet</button>
									<button class="awh-btn" type="button" data-act="copy" aria-label="Copy wallet address">Copy address</button>
								<a class="awh-btn" href="${escapeHtml(explorerAddressUrl(state.address, net))}" target="_blank" rel="noopener">Explorer ↗</a>
							</div>

							<div class="awh-dep-amount">
								<label class="awh-dep-label" for="awh-dep-amount-input">Amount (optional)</label>
								<div class="awh-dep-amount-field">
									<input id="awh-dep-amount-input" data-input="amount" type="number" inputmode="decimal"
										min="0" step="0.01" placeholder="0.00" value="${escapeHtml(state.amount)}"
										aria-describedby="awh-dep-amount-hint" />
									<span class="unit" aria-hidden="true">SOL</span>
								</div>
								<div class="awh-dep-amount-hint ${state.amountError ? 'is-err' : ''}" id="awh-dep-amount-hint">
									${state.amountError ? 'Enter a positive number — the QR uses the address only until then.' : 'Preset an amount in the QR + wallet link, or leave blank to let the sender choose.'}
								</div>
							</div>
						</div>
					</div>

					<p class="awh-dep-how">
						<strong>How to fund:</strong> scan the QR with your phone's wallet (Phantom, Solflare, Backpack…),
						tap “Open in a wallet app” on mobile, or copy the address and send SOL from any wallet or exchange.
					</p>
				</div>

				<div class="awh-card" data-host="status" role="status" aria-live="polite">${statusBlock()}</div>

				<div data-host="activity">${activityBlock(net)}</div>
			`;

			panel.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
				const ok = await copyToClipboard(state.address);
				toast(ok ? 'Address copied' : 'Copy failed — select it manually');
			});

			panel.querySelector('[data-act="tip"]')?.addEventListener('click', async () => {
				try {
					const { openTipModal } = await import('../../shared/agent-tip-modal.js');
					openTipModal(
						{
							solana_address: state.address,
							name: ctx.agent?.name,
							avatar_thumbnail_url: ctx.agent?.avatar_thumbnail_url,
							meta: ctx.agent?.meta,
						},
						{ network: ctx.getNetwork(), onSent: () => { state.baselineSol = null; poll(); } },
					);
				} catch {
					toast('Could not open the tip dialog — copy the address and send from any wallet');
				}
			});

			const amountInput = panel.querySelector('[data-input="amount"]');
			amountInput?.addEventListener('input', onAmountInput);
		}

		function onAmountInput(e) {
			const raw = e.target.value.trim();
			state.amount = raw;
			const n = Number(raw);
			state.amountError = raw !== '' && (!Number.isFinite(n) || n <= 0);
			// Debounce the QR re-render so fast typing stays smooth.
			clearTimeout(qrDebounce);
			qrDebounce = setTimeout(() => {
				if (destroyed) return;
				const uri = solanaUri();
				const qrHost = panel.querySelector('[data-host="qr"]');
				const deeplink = panel.querySelector('[data-host="deeplink"]');
				if (qrHost) {
					qrHost.innerHTML = qrMarkup();
					if (uri) qrHost.setAttribute('href', uri);
				}
				if (deeplink && uri) deeplink.setAttribute('href', uri);
				const hint = panel.querySelector('#awh-dep-amount-hint');
				if (hint) {
					hint.classList.toggle('is-err', state.amountError);
					hint.textContent = state.amountError
						? 'Enter a positive number — the QR uses the address only until then.'
						: 'Preset an amount in the QR + wallet link, or leave blank to let the sender choose.';
				}
			}, 220);
		}

		function patchStatus() {
			const host = panel.querySelector('[data-host="status"]');
			if (host) host.innerHTML = statusBlock();
		}
		function patchActivity() {
			const host = panel.querySelector('[data-host="activity"]');
			if (host) host.innerHTML = activityBlock(ctx.getNetwork());
		}

		/** Read the live balance. Returns the SOL number, or null if unavailable. */
		async function readBalance() {
			const net = ctx.getNetwork();
			let r;
			try {
				r = await fetchAgentSolanaWallet(ctx.agentId, net);
			} catch {
				return { ok: false };
			}
			if (!r) return { ok: false };
			if (r.status === 'forbidden') return { ok: false, forbidden: true };
			if (r.status === 'none') return { ok: true, address: null, sol: null };
			if (r.status === 'error') return { ok: false };
			if (r.data?.balance_error) return { ok: false };
			return { ok: true, address: r.data?.address || null, sol: r.data?.sol ?? null };
		}

		async function loadInitial() {
			const res = await readBalance();
			if (res.ok) {
				if (res.address) state.address = res.address;
				state.balanceError = false;
				if (typeof res.sol === 'number') state.baselineSol = res.sol;
			} else {
				// Address may still be known from the agent record — keep the panel usable.
				state.balanceError = true;
			}
			state.loaded = true;
			render();
			if (state.address) loadActivity();
		}

		async function poll() {
			if (!visible || destroyed || !state.address) return;
			const res = await readBalance();
			if (!res.ok) {
				if (!state.balanceError) {
					state.balanceError = true;
					patchStatus();
				}
				return;
			}
			const wasErrored = state.balanceError;
			state.balanceError = false;
			const sol = res.sol;
			if (typeof sol !== 'number') {
				if (wasErrored) patchStatus();
				return;
			}
			if (state.baselineSol == null) {
				// First good read after an error — establish the baseline silently.
				state.baselineSol = sol;
				if (wasErrored) patchStatus();
				return;
			}
			const delta = sol - state.baselineSol;
			// Guard against float dust; a real deposit is well above lamport noise.
			if (delta > 1e-7) {
				state.received = { delta, total: sol };
				state.receivedCount += 1;
				state.baselineSol = sol;
				patchStatus();
				toast(`◎${formatSol(delta)} SOL received`);
				loadActivity(); // a deposit just landed — pull the fresh tx in
			} else if (wasErrored) {
				patchStatus();
			}
		}

		async function loadActivity() {
			const net = ctx.getNetwork();
			// The activity feed is owner-only server-side; a visitor funding someone
			// else's agent would only earn a 401 in the console. The deposit QR,
			// address, and live "received" confirmation all work without it.
			if (!ctx.isOwner || !state.address) return;
			try {
				const data = await fetchAgentSolanaActivity(ctx.agentId, net, 8);
				state.activity = data?.signatures || [];
			} catch {
				state.activity = state.activity || [];
			} finally {
				state.activityLoaded = true;
				patchActivity();
			}
		}

		function startPoll() {
			stopPoll();
			pollTimer = setInterval(poll, POLL_MS);
		}
		function stopPoll() {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
		}

		// A network switch resets the live-confirmation baseline for the new cluster.
		detachNet = ctx.onNetworkChange(() => {
			state.loaded = false;
			state.baselineSol = null;
			state.received = null;
			state.receivedCount = 0;
			state.activity = null;
			state.activityLoaded = false;
			state.balanceError = false;
			render();
			loadInitial();
		});

		render();

		return {
			onShow() {
				visible = true;
				if (!state.loaded) loadInitial();
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
				clearTimeout(qrDebounce);
				detachNet?.();
			},
		};
	},
});
