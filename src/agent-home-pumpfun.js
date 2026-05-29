/**
 * Pump.fun card on the agent home panel
 * --------------------------------------
 * States:
 *   - skeleton                          (loading)
 *   - cta            (no token yet)     → one-click launch
 *   - active         (token launched)   → live status + inline trade panel
 *   - graduated      (curve complete)   → AMM badge
 *
 * Trade UX:
 *   - Inline trade panel (no window.prompt). Live-quotes via pumpfun-curve-quote
 *     while the user types (debounced). Shows expected output and price impact.
 *   - Skill toasts: every successful pumpfun-* result surfaces a transient
 *     toast with the tx signature linking to the explorer.
 *
 * Mobile: action buttons wrap; trade panel collapses to a single column.
 *
 * Mint click: opens the existing pumpfun-feed widget filtered to that mint
 * inside the host page (when available) instead of leaving for pump.fun.
 */

import { ACTION_TYPES } from './agent-protocol.js';

const REFRESH_MS = 30_000;
const QUOTE_DEBOUNCE_MS = 250;

export function mountPumpFunCard({ panel, identity, skills, memory, protocol }) {
	if (!panel || !identity?.id) return null;
	protocol = protocol || (typeof window !== 'undefined' ? window.VIEWER?.agent_protocol : null);

	const root = document.createElement('section');
	root.className = 'agent-home-pumpfun';
	panel.appendChild(root);

	const toastTray = document.createElement('div');
	toastTray.className = 'pumpfun-toasts';
	root.appendChild(toastTray);

	let state = {
		mint: null,
		symbol: null,
		network: 'mainnet',
		loading: true,
		tradeOpen: null, // null | 'buy' | 'sell'
		tradeAmount: '',
		quote: null,
		quoting: false,
		signer: 'agent', // 'agent' = server-side agent wallet; 'owner' = browser wallet
		// vanity launch
		vanityEnabled: false,
		vanitySuffix: 'pump',
		vanityProgress: null,
		// auto-trader
		botOpen: false,
		botMode: 'auto-snipe',
		botDryRun: false,
		botDurationSec: 60,
		botPerTradeSol: 0.05,
		botCapSol: 0.5,
		botQuery: '',
		botWallet: '',
		botRunning: false,
		botProgress: null, // last onProgress event
		botSpent: 0,
		botEventCount: 0,
	};
	let botAbort = null;
	// Stable per-mode session ids — re-running the same mode resumes prior state.
	const botSessionIds = {
		'research-and-buy': `pf-research-${identity.id}`,
		'auto-snipe': `pf-snipe-${identity.id}`,
		'copy-trade': `pf-copy-${identity.id}`,
		'rug-exit-watch': `pf-exit-${identity.id}`,
	};
	let refreshTimer = null;
	let quoteTimer = null;
	let unsubProtocol = null;

	const cardBody = document.createElement('div');
	cardBody.className = 'pumpfun-card-body';
	root.appendChild(cardBody);

	const launchCard = () => `
		<div class="pumpfun-card pumpfun-card--cta">
			<div class="pumpfun-card-head">
				<span class="pumpfun-card-icon">◎</span>
				<span class="pumpfun-card-title">Launch coin on pump.fun</span>
			</div>
			<p class="pumpfun-card-sub">Mint a token whose metadata is your 3D avatar.</p>
			<div class="pumpfun-signer" role="tablist" aria-label="Signer">
				<button class="pumpfun-signer-tab ${state.signer === 'agent' ? 'is-active' : ''}" data-action="signer-agent" role="tab" aria-selected="${state.signer === 'agent'}">Agent wallet</button>
				<button class="pumpfun-signer-tab ${state.signer === 'owner' ? 'is-active' : ''}" data-action="signer-owner" role="tab" aria-selected="${state.signer === 'owner'}">Owner wallet</button>
			</div>
			<label class="pumpfun-vanity-row" title="Grind a custom mint address ending in your suffix. Slower, but distinctive.">
				<input type="checkbox" data-action="toggle-vanity" ${state.vanityEnabled ? 'checked' : ''}>
				<span>Vanity ends with</span>
				<input type="text" data-action="vanity-suffix" value="${escapeAttr(state.vanitySuffix)}" maxlength="6" ${state.vanityEnabled ? '' : 'disabled'} class="pumpfun-vanity-input">
			</label>
			${state.vanityProgress ? `<div class="pumpfun-vanity-progress">grinding… ${formatNumber(state.vanityProgress.rate)}/s · eta ${escapeHtml(state.vanityProgress.eta)}</div>` : ''}
			<button class="pumpfun-btn pumpfun-btn--primary" id="pf-launch-btn">
				Launch ${deriveSymbol(identity.name)}
			</button>
			<a class="pumpfun-card-foot" href="https://pump.fun" target="_blank" rel="noopener">What is pump.fun?</a>
		</div>
	`;

	const statusCard = (s) => {
		const pct = s.progressPct != null ? `${s.progressPct.toFixed(1)}%` : '—';
		const cap = s.marketCap ? formatLamports(s.marketCap) : '—';
		const explorer =
			s.network === 'devnet'
				? `https://pump.fun/coin/${s.mint}?cluster=devnet`
				: `https://pump.fun/coin/${s.mint}`;
		const grad = s.graduated;
		return `
			<div class="pumpfun-card ${grad ? 'pumpfun-card--graduated' : ''}">
				<div class="pumpfun-card-head">
					<span class="pumpfun-card-icon">${grad ? '🎓' : '◎'}</span>
					<span class="pumpfun-card-title">${escapeHtml(s.symbol || 'Token')}</span>
					<a class="pumpfun-card-link" href="${explorer}" target="_blank" rel="noopener" title="Open on pump.fun">↗</a>
				</div>
				<div class="pumpfun-stats">
					<div class="pumpfun-stat">
						<span class="pumpfun-stat-label">Market cap</span>
						<span class="pumpfun-stat-value">${cap}</span>
					</div>
					<div class="pumpfun-stat">
						<span class="pumpfun-stat-label">${grad ? 'Status' : 'To graduation'}</span>
						<span class="pumpfun-stat-value">${grad ? 'Graduated' : pct}</span>
					</div>
				</div>
				${grad ? '' : `<div class="pumpfun-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${(s.progressPct || 0).toFixed(1)}"><div class="pumpfun-progress-bar" style="width:${Math.min(100, s.progressPct || 0)}%"></div></div>`}
				<button class="pumpfun-card-mint" data-action="open-feed" title="Open live feed for this mint">${shortMint(s.mint)}</button>
				<div class="pumpfun-card-actions">
					<button class="pumpfun-btn ${s.tradeOpen === 'buy' ? 'pumpfun-btn--active' : ''}" data-action="toggle-buy">Buy</button>
					<button class="pumpfun-btn ${s.tradeOpen === 'sell' ? 'pumpfun-btn--active' : ''}" data-action="toggle-sell">Sell</button>
					<button class="pumpfun-btn pumpfun-btn--ghost" data-action="claim">Claim fees</button>
					<button class="pumpfun-btn ${s.botOpen ? 'pumpfun-btn--active' : ''}" data-action="toggle-bot">🤖 Auto</button>
				</div>
				${s.tradeOpen ? tradePanel(s) : ''}
				${s.botOpen ? botPanel(s) : ''}
			</div>
		`;
	};

	const botPanel = (s) => {
		const modes = [
			['research-and-buy', 'Research & Buy'],
			['auto-snipe', 'Auto-Snipe'],
			['copy-trade', 'Copy-Trade'],
			['rug-exit-watch', 'Rug Exit'],
		];
		const needsQuery = s.botMode === 'research-and-buy';
		const needsWallet = s.botMode === 'copy-trade';
		const isExitWatch = s.botMode === 'rug-exit-watch';
		return `
			<div class="pumpfun-trade pumpfun-bot">
				<div class="pumpfun-bot-modes">
					${modes.map(([k, label]) => `<button class="pumpfun-btn ${s.botMode === k ? 'pumpfun-btn--active' : ''}" data-action="bot-mode" data-mode="${k}" ${s.botRunning ? 'disabled' : ''}>${label}</button>`).join('')}
				</div>
				${needsQuery ? `<label class="pumpfun-trade-label"><span>Query</span><input class="pumpfun-trade-input" data-bot-field="query" type="text" placeholder="name, symbol, or mint" value="${escapeAttr(s.botQuery)}" ${s.botRunning ? 'disabled' : ''}></label>` : ''}
				${needsWallet ? `<label class="pumpfun-trade-label"><span>Wallet</span><input class="pumpfun-trade-input" data-bot-field="wallet" type="text" placeholder="creator/wallet pubkey" value="${escapeAttr(s.botWallet)}" ${s.botRunning ? 'disabled' : ''}></label>` : ''}
				<div class="pumpfun-bot-grid">
					<label class="pumpfun-trade-label"><span>Duration (s)</span><input class="pumpfun-trade-input" data-bot-field="durationSec" type="number" min="10" max="3600" value="${s.botDurationSec}" ${s.botRunning ? 'disabled' : ''}></label>
					${isExitWatch ? '' : `<label class="pumpfun-trade-label"><span>Per-trade SOL</span><input class="pumpfun-trade-input" data-bot-field="perTradeSol" type="number" min="0.001" step="0.001" value="${s.botPerTradeSol}" ${s.botRunning ? 'disabled' : ''}></label>`}
					${isExitWatch ? '' : `<label class="pumpfun-trade-label"><span>Cap SOL</span><input class="pumpfun-trade-input" data-bot-field="capSol" type="number" min="0.001" step="0.01" value="${s.botCapSol}" ${s.botRunning ? 'disabled' : ''}></label>`}
				</div>
				<label class="pumpfun-vanity-row" title="Run filters/quotes only — no signing or SOL spent. Useful for tuning before going live.">
					<input type="checkbox" data-bot-field="dryRun" ${s.botDryRun ? 'checked' : ''} ${s.botRunning ? 'disabled' : ''}>
					<span>Dry run</span>
				</label>
				<div class="pumpfun-trade-actions">
					<button class="pumpfun-btn pumpfun-btn--ghost" data-action="close-bot" ${s.botRunning ? 'disabled' : ''}>Close</button>
					${s.botRunning
						? `<button class="pumpfun-btn pumpfun-btn--primary" data-action="bot-stop">Stop</button>`
						: `<button class="pumpfun-btn pumpfun-btn--primary" data-action="bot-run">${s.botDryRun ? 'Run dry-run' : 'Run live'}</button>`}
				</div>
				<div class="pumpfun-bot-progress" id="pf-bot-progress">${botProgressLine(s)}</div>
			</div>
		`;
	};

	function botProgressLine(s) {
		if (!s.botRunning && !s.botProgress) return '';
		const e = s.botProgress;
		const head = s.botRunning
			? `<span class="pumpfun-quote-status">${escapeHtml(s.botMode)} · ${s.botEventCount} events · ${s.botSpent.toFixed(4)} SOL</span>`
			: `<span class="pumpfun-quote-out">done · ${s.botEventCount} events · ${s.botSpent.toFixed(4)} SOL</span>`;
		const last = e ? `<span class="pumpfun-quote-out"> · last: ${escapeHtml(e.type)}${e.mint ? ` ${shortMint(e.mint)}` : ''}${e.reason ? ` (${escapeHtml(e.reason)})` : ''}</span>` : '';
		return head + last;
	}

	const tradePanel = (s) => {
		const isBuy = s.tradeOpen === 'buy';
		const placeholder = isBuy ? '0.1' : '1000000';
		const unit = isBuy ? 'SOL' : 'units';
		const q = s.quote;
		let preview = '';
		if (s.quoting) {
			preview = `<span class="pumpfun-quote-status">Quoting…</span>`;
		} else if (q && q.success) {
			const out = isBuy
				? `≈ ${formatNumber(q.data?.tokensOut)} ${escapeHtml(s.symbol || 'tokens')}`
				: `≈ ${formatLamports(q.data?.solOut)}`;
			preview = `<span class="pumpfun-quote-out">${out}</span>`;
		} else if (q && !q.success) {
			preview = `<span class="pumpfun-quote-err">${escapeHtml(q.output || 'No quote')}</span>`;
		}
		return `
			<div class="pumpfun-trade">
				<div class="pumpfun-signer" role="tablist" aria-label="Signer">
					<button class="pumpfun-signer-tab ${s.signer === 'agent' ? 'is-active' : ''}" data-action="signer-agent" role="tab" aria-selected="${s.signer === 'agent'}">Agent wallet</button>
					<button class="pumpfun-signer-tab ${s.signer === 'owner' ? 'is-active' : ''}" data-action="signer-owner" role="tab" aria-selected="${s.signer === 'owner'}">Owner wallet</button>
				</div>
				<label class="pumpfun-trade-label">
					<span>${isBuy ? 'Spend' : 'Sell'}</span>
					<input
						class="pumpfun-trade-input"
						id="pf-trade-amount"
						type="text"
						inputmode="decimal"
						placeholder="${placeholder}"
						value="${escapeAttr(s.tradeAmount)}"
						autocomplete="off"
						spellcheck="false"
					>
					<span class="pumpfun-trade-unit">${unit}</span>
				</label>
				<div class="pumpfun-quote">${preview}</div>
				<div class="pumpfun-trade-actions">
					<button class="pumpfun-btn pumpfun-btn--ghost" data-action="close-trade">Cancel</button>
					<button class="pumpfun-btn pumpfun-btn--primary" data-action="confirm-trade" ${isExecutable(s) ? '' : 'disabled'}>
						${isBuy ? 'Buy' : 'Sell'}
					</button>
				</div>
			</div>
		`;
	};

	const skeleton = () => `<div class="pumpfun-card pumpfun-card--skeleton"></div>`;

	const render = () => {
		if (state.loading) {
			cardBody.innerHTML = skeleton();
			return;
		}
		cardBody.innerHTML = state.mint ? statusCard(state) : launchCard();
		bind();
		// Restore focus to the input after re-render so typing stays uninterrupted.
		if (state.tradeOpen) {
			const el = cardBody.querySelector('#pf-trade-amount');
			if (el) {
				el.focus();
				const len = el.value.length;
				try { el.setSelectionRange(len, len); } catch {/*ignore*/}
			}
		}
	};

	const bind = () => {
		const launchBtn = cardBody.querySelector('#pf-launch-btn');
		if (launchBtn) {
			launchBtn.addEventListener('click', () => doLaunch(launchBtn));
		}
		cardBody.querySelectorAll('[data-action]').forEach((btn) => {
			btn.addEventListener('click', (e) => handleAction(btn.dataset.action, e));
		});
		const input = cardBody.querySelector('#pf-trade-amount');
		if (input) {
			input.addEventListener('input', (e) => {
				state.tradeAmount = e.target.value;
				scheduleQuote();
				const btn = cardBody.querySelector('[data-action="confirm-trade"]');
				if (btn) btn.disabled = !isExecutable(state);
			});
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && isExecutable(state)) {
					e.preventDefault();
					executeTrade();
				} else if (e.key === 'Escape') {
					closeTrade();
				}
			});
		}
		// Vanity suffix input
		const vinput = cardBody.querySelector('[data-action="vanity-suffix"]');
		if (vinput) {
			vinput.addEventListener('input', (e) => {
				state.vanitySuffix = e.target.value;
			});
		}
		// Bot field inputs
		cardBody.querySelectorAll('[data-bot-field]').forEach((el) => {
			const field = el.dataset.botField;
			const evt = el.type === 'checkbox' ? 'change' : 'input';
			el.addEventListener(evt, (e) => {
				const v = el.type === 'checkbox' ? e.target.checked
					: el.type === 'number' ? parseFloat(e.target.value) || 0
					: e.target.value;
				const map = { dryRun: 'botDryRun', durationSec: 'botDurationSec', perTradeSol: 'botPerTradeSol', capSol: 'botCapSol', query: 'botQuery', wallet: 'botWallet' };
				if (map[field]) state[map[field]] = v;
			});
		});
	};

	async function doLaunch(launchBtn) {
		launchBtn.disabled = true;
		const useAgent = state.signer === 'agent';
		const wantsVanity = state.vanityEnabled && state.vanitySuffix?.trim();
		launchBtn.textContent = wantsVanity ? 'Grinding vanity…' : 'Launching…';
		try {
			let extraArgs = {};
			if (wantsVanity) {
				if (useAgent) {
					// Server grinds + signs in the same request.
					extraArgs = { vanitySuffix: state.vanitySuffix.trim() };
					launchBtn.textContent = `Launching with …${state.vanitySuffix.trim()}…`;
				} else {
					// Client grinds with workers, owner wallet signs.
					try {
						const { grindVanity } = await import('./solana/vanity/grinder.js');
						const ground = await grindVanity({
							suffix: state.vanitySuffix.trim(),
							onProgress: (p) => {
								state.vanityProgress = { rate: p.rate, eta: p.eta };
								const slot = cardBody.querySelector('.pumpfun-vanity-progress');
								if (slot) slot.textContent = `grinding… ${formatNumber(p.rate)}/s · eta ${p.eta}`;
							},
						});
						extraArgs = {
							mintPublicKey: ground.publicKey,
							mintSecretKeyB64: btoa(String.fromCharCode(...ground.secretKey)),
						};
						state.vanityProgress = null;
						launchBtn.textContent = `Launching ${shortMint(ground.publicKey)}…`;
					} catch (err) {
						state.vanityProgress = null;
						launchBtn.disabled = false;
						launchBtn.textContent = `Retry launch ${deriveSymbol(identity.name)}`;
						toast(err.message || 'Vanity grind failed', null, null, 'error');
						render();
						return;
					}
				}
			}
			const skillName = useAgent
				? 'pumpfun-self-launch-from-identity'
				: 'pumpfun-launch-from-agent';
			const r = await skills?.perform(
				skillName,
				{ network: state.network, ...extraArgs },
				{ identity },
			);
			if (r?.success && r.data?.mint) {
				toast(`Launched ${r.data.symbol || ''}`, r.data.signature, state.network, 'success');
				state = { ...state, mint: r.data.mint, symbol: r.data.symbol, loading: true };
				await refresh();
			} else {
				launchBtn.disabled = false;
				launchBtn.textContent = `Retry launch ${deriveSymbol(identity.name)}`;
				toast(r?.output || 'Launch failed', null, null, 'error');
			}
		} catch (err) {
			launchBtn.disabled = false;
			launchBtn.textContent = 'Launch failed — retry';
			toast(err.message || 'Launch failed', null, null, 'error');
		}
	}

	async function runBot() {
		if (state.botRunning) return;
		const skillConfig = {
			sessionSpendCapSol: parseFloat(state.botCapSol) || 0.5,
			perTradeSol: parseFloat(state.botPerTradeSol) || 0.05,
		};
		const skillName = `pumpfun-${state.botMode}`;
		const args = {
			sessionId: botSessionIds[state.botMode],
			dryRun: !!state.botDryRun,
			durationSec: Math.max(10, parseInt(state.botDurationSec, 10) || 60),
			onProgress: (evt) => {
				state.botProgress = evt;
				state.botEventCount += 1;
				if (typeof evt.spent === 'number') state.botSpent = evt.spent;
				const slot = cardBody.querySelector('#pf-bot-progress');
				if (slot) slot.innerHTML = botProgressLine(state);
			},
		};
		if (state.botMode === 'research-and-buy') {
			if (!state.botQuery?.trim()) return toast('Query required', null, null, 'error');
			args.query = state.botQuery.trim();
			args.amountSol = parseFloat(state.botPerTradeSol) || 0.05;
			delete args.durationSec;
		} else if (state.botMode === 'auto-snipe') {
			args.perTradeSol = parseFloat(state.botPerTradeSol) || 0.05;
		} else if (state.botMode === 'copy-trade') {
			if (!state.botWallet?.trim()) return toast('Wallet required', null, null, 'error');
			args.wallet = state.botWallet.trim();
		} else if (state.botMode === 'rug-exit-watch') {
			if (!state.mint) return toast('No mint to watch', null, null, 'error');
			args.mints = [state.mint];
		}
		botAbort = new AbortController();
		args.signal = botAbort.signal;
		state.botRunning = true;
		state.botSpent = 0;
		state.botEventCount = 0;
		state.botProgress = null;
		render();
		try {
			const r = await skills.perform(skillName, args, { identity, memory, skillConfig });
			if (r?.success) {
				if (typeof r.data?.spent === 'number') state.botSpent = r.data.spent;
				toast(`${state.botDryRun ? '[dry-run] ' : ''}${r.output || `${state.botMode} done`}`, null, null, 'success');
			} else {
				toast(r?.output || `${state.botMode} failed`, null, null, 'error');
			}
		} catch (err) {
			toast(err.message || `${state.botMode} failed`, null, null, 'error');
		} finally {
			state.botRunning = false;
			botAbort = null;
			render();
		}
	}

	function stopBot() {
		if (botAbort) {
			try { botAbort.abort(); } catch {}
		}
	}

	const handleAction = (action, e) => {
		if (action === 'open-feed') return openFeed();
		if (action === 'claim') return doClaim();
		if (action === 'toggle-buy') return toggleTrade('buy');
		if (action === 'toggle-sell') return toggleTrade('sell');
		if (action === 'close-trade') return closeTrade();
		if (action === 'confirm-trade') return executeTrade();
		if (action === 'signer-agent') return setSigner('agent');
		if (action === 'signer-owner') return setSigner('owner');
		if (action === 'toggle-bot') { state.botOpen = !state.botOpen; return render(); }
		if (action === 'close-bot') { state.botOpen = false; return render(); }
		if (action === 'bot-mode') {
			state.botMode = e?.currentTarget?.dataset?.mode || state.botMode;
			return render();
		}
		if (action === 'bot-run') return runBot();
		if (action === 'bot-stop') return stopBot();
		if (action === 'toggle-vanity') {
			state.vanityEnabled = !state.vanityEnabled;
			return render();
		}
	};

	const setSigner = (signer) => {
		if (state.signer === signer) return;
		state.signer = signer;
		render();
	};

	const toggleTrade = (side) => {
		state.tradeOpen = state.tradeOpen === side ? null : side;
		state.tradeAmount = '';
		state.quote = null;
		render();
	};

	const closeTrade = () => {
		state.tradeOpen = null;
		state.tradeAmount = '';
		state.quote = null;
		render();
	};

	const scheduleQuote = () => {
		if (quoteTimer) clearTimeout(quoteTimer);
		const amt = state.tradeAmount?.trim();
		if (!amt || !isFinite(parseFloat(amt))) {
			state.quote = null;
			updateQuoteDOM();
			return;
		}
		state.quoting = true;
		updateQuoteDOM();
		quoteTimer = setTimeout(async () => {
			try {
				const isBuy = state.tradeOpen === 'buy';
				const r = await skills.perform(
					'pumpfun-curve-quote',
					{
						mint: state.mint,
						side: isBuy ? 'buy' : 'sell',
						solAmount: isBuy ? parseFloat(amt) : undefined,
						tokenAmount: isBuy ? undefined : amt.replace(/\D/g, ''),
						network: state.network,
					},
					{ identity },
				);
				state.quote = r;
				state.quoting = false;
				updateQuoteDOM();
			} catch {
				state.quote = { success: false, output: 'Quote unavailable' };
				state.quoting = false;
				updateQuoteDOM();
			}
		}, QUOTE_DEBOUNCE_MS);
	};

	const updateQuoteDOM = () => {
		const slot = cardBody.querySelector('.pumpfun-quote');
		const btn = cardBody.querySelector('[data-action="confirm-trade"]');
		if (!slot) return;
		const q = state.quote;
		if (state.quoting) {
			slot.innerHTML = `<span class="pumpfun-quote-status">Quoting…</span>`;
		} else if (q && q.success) {
			const isBuy = state.tradeOpen === 'buy';
			const out = isBuy
				? `≈ ${formatNumber(q.data?.tokensOut)} ${escapeHtml(state.symbol || 'tokens')}`
				: `≈ ${formatLamports(q.data?.solOut)}`;
			slot.innerHTML = `<span class="pumpfun-quote-out">${out}</span>`;
		} else if (q && !q.success) {
			slot.innerHTML = `<span class="pumpfun-quote-err">${escapeHtml(q.output || 'No quote')}</span>`;
		} else {
			slot.innerHTML = '';
		}
		if (btn) btn.disabled = !isExecutable(state);
	};

	const executeTrade = async () => {
		if (!isExecutable(state)) return;
		const isBuy = state.tradeOpen === 'buy';
		const btn = cardBody.querySelector('[data-action="confirm-trade"]');
		if (btn) {
			btn.disabled = true;
			btn.textContent = 'Sending…';
		}
		try {
			const useAgent = state.signer === 'agent';
			const skillName = useAgent
				? 'pumpfun-self-swap'
				: isBuy
				? 'pumpfun-buy-with-quote'
				: 'pumpfun-sell';
			const args = useAgent
				? {
						mint: state.mint,
						side: isBuy ? 'buy' : 'sell',
						solAmount: isBuy ? parseFloat(state.tradeAmount) : undefined,
						tokenAmount: isBuy ? undefined : state.tradeAmount.replace(/\D/g, ''),
						network: state.network,
				  }
				: isBuy
				? { mint: state.mint, solAmount: parseFloat(state.tradeAmount), network: state.network }
				: {
						mint: state.mint,
						tokenAmount: state.tradeAmount.replace(/\D/g, ''),
						network: state.network,
				  };
			const r = await skills.perform(skillName, args, { identity });
			if (r?.success) {
				toast(
					isBuy ? `Bought ${state.tradeAmount} SOL` : `Sold ${state.tradeAmount} units`,
					r.data?.signature,
					state.network,
					'success',
				);
				closeTrade();
				await refresh();
			} else {
				toast(r?.output || 'Trade failed', null, null, 'error');
				if (btn) {
					btn.disabled = false;
					btn.textContent = isBuy ? 'Buy' : 'Sell';
				}
			}
		} catch (err) {
			toast(err.message || 'Trade failed', null, null, 'error');
			if (btn) {
				btn.disabled = false;
				btn.textContent = isBuy ? 'Buy' : 'Sell';
			}
		}
	};

	const doClaim = async () => {
		try {
			const r = await skills.perform(
				'pumpfun-claim-fees',
				{ network: state.network },
				{ identity },
			);
			toast(
				r?.output || (r?.success ? 'Fees claimed' : 'Claim failed'),
				r?.data?.signature,
				state.network,
				r?.success ? 'success' : 'error',
			);
		} catch (err) {
			toast(err.message || 'Claim failed', null, null, 'error');
		}
	};

	const openFeed = () => {
		// If host has the pumpfun-feed widget mounted, expose mint via custom event.
		// Otherwise fall back to opening pump.fun in a new tab.
		const ev = new CustomEvent('pumpfun-feed:focus-mint', {
			detail: { mint: state.mint, network: state.network },
			bubbles: true,
		});
		const handled = !root.dispatchEvent(ev) || ev.defaultPrevented;
		if (!handled) {
			const url =
				state.network === 'devnet'
					? `https://pump.fun/coin/${state.mint}?cluster=devnet`
					: `https://pump.fun/coin/${state.mint}`;
			window.open(url, '_blank', 'noopener');
		}
	};

	const refresh = async () => {
		const found = resolveMintFrom(memory, identity);
		state = { ...state, ...found, loading: false };
		render();
		if (state.mint && skills) {
			try {
				const r = await skills.perform(
					'pumpfun-watch-curve',
					{ mint: state.mint, network: state.network },
					{ identity },
				);
				if (r?.success && r.data) {
					state = { ...state, ...r.data };
					render();
				}
			} catch {/* swallow */}
		}
	};

	// ── Toasts ───────────────────────────────────────────────────────────────
	function toast(message, signature, network, level = 'info') {
		const el = document.createElement('div');
		el.className = `pumpfun-toast pumpfun-toast--${level}`;
		const explorer = signature
			? network === 'devnet'
				? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
				: `https://solscan.io/tx/${signature}`
			: null;
		el.innerHTML = `
			<span class="pumpfun-toast-msg">${escapeHtml(message)}</span>
			${explorer ? `<a class="pumpfun-toast-link" href="${explorer}" target="_blank" rel="noopener">↗</a>` : ''}
		`;
		toastTray.appendChild(el);
		// Trigger entry animation on next frame.
		requestAnimationFrame(() => el.classList.add('is-in'));
		setTimeout(() => {
			el.classList.remove('is-in');
			setTimeout(() => el.remove(), 240);
		}, 5500);
	}

	// Subscribe to skill-done events globally so non-card-initiated trades
	// (e.g. from the LLM tool loop or chat) also surface as toasts here.
	if (protocol?.on) {
		const handler = (ev) => {
			const skill = ev.detail?.payload?.skill;
			const result = ev.detail?.payload?.result;
			if (!skill || !skill.startsWith('pumpfun-') || !result) return;
			// Skip the ones that are reads or already toasted by direct caller.
			if (skill === 'pumpfun-watch-curve' || skill === 'pumpfun-curve-quote' || skill === 'pumpfun-status')
				return;
			if (result.success && result.data?.signature) {
				toast(result.output || 'Done', result.data.signature, result.data.network || state.network, 'success');
			}
		};
		protocol.on(ACTION_TYPES.SKILL_DONE, handler);
		unsubProtocol = () => protocol.off?.(ACTION_TYPES.SKILL_DONE, handler);
	}

	let _refreshing = false;
	refresh();
	refreshTimer = setInterval(() => {
		if (state.mint && !state.tradeOpen && !_refreshing) {
			_refreshing = true;
			refresh().finally(() => { _refreshing = false; });
		}
	}, REFRESH_MS);

	return {
		destroy() {
			if (refreshTimer) clearInterval(refreshTimer);
			if (quoteTimer) clearTimeout(quoteTimer);
			if (unsubProtocol) unsubProtocol();
			root.remove();
		},
		refresh,
	};
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isExecutable(s) {
	if (!s.tradeOpen || !s.tradeAmount) return false;
	const n = parseFloat(s.tradeAmount);
	if (!isFinite(n) || n <= 0) return false;
	if (s.quoting) return false;
	if (s.quote && s.quote.success === false) return false;
	return true;
}

function resolveMintFrom(memory, identity) {
	try {
		if (memory?.recall) {
			const hits = memory.recall('pumpfun:launch') || [];
			const latest = hits.sort(
				(a, b) => (b.context?.launchedAt || 0) - (a.context?.launchedAt || 0),
			)[0];
			if (latest?.context?.mint) {
				return {
					mint: latest.context.mint,
					symbol: latest.context.symbol,
					network: latest.context.network || 'mainnet',
				};
			}
		}
	} catch {/* ignore */}
	const meta = identity?.meta || {};
	if (meta.pumpfun_mint) {
		return {
			mint: meta.pumpfun_mint,
			symbol: meta.pumpfun_symbol,
			network: meta.pumpfun_network || 'mainnet',
		};
	}
	return { mint: null, symbol: null };
}

function deriveSymbol(name) {
	return (
		String(name || 'AGENT')
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 10) || 'AGENT'
	);
}

function shortMint(m) {
	if (!m) return '';
	return `${m.slice(0, 6)}…${m.slice(-4)}`;
}

function formatLamports(lamports) {
	const n = Number(lamports) / 1e9;
	if (!isFinite(n)) return '—';
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K SOL`;
	if (n >= 1) return `${n.toFixed(2)} SOL`;
	return `${n.toFixed(4)} SOL`;
}

function formatNumber(s) {
	if (s == null) return '—';
	const n = Number(s);
	if (!isFinite(n)) return String(s);
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
	return String(Math.round(n));
}

function escapeHtml(s) {
	return String(s || '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	})[c]);
}

function escapeAttr(s) {
	return escapeHtml(s);
}
