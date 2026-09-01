/**
 * Mission Control — the real-time trading terminal.
 *
 * A keyboard-driven cockpit that fuses every live signal three.ws computes —
 * the launch firehose, intel scores, firewall verdicts, smart-money flow, and
 * the agent's own streaming positions — into one screen, and executes real
 * firewall + MEV-gated trades from the agent wallet.
 *
 * mountMissionControl(root) resolves the signed-in user and their trading
 * agents, builds the shell + three live panes, and owns the full lifecycle
 * (every SSE stream, timer, and listener is torn down on unmount / route change).
 *
 * $THREE is the only coin three.ws promotes. Every other mint shown here is live
 * market data the cockpit assesses — it names and recommends no other token.
 */

import { getMe } from '../account.js';
import { loadUserAgents } from '../memory-seed.js';
import { fetchAgentSolanaWallet } from '../agent-solana-wallet.js';

import { injectMissionControlStyles } from './styles.js';
import { createBus } from './realtime.js';
import { createStore } from './store.js';
import { createEnricher } from './enrich.js';
import { createFeedPane } from './feed.js';
import { createPositionsPane } from './positions.js';
import { createFocusPane } from './focus.js';
import { createKeyboard } from './keyboard.js';
import { escapeHtml, formatSol, shortAddress } from './format.js';

export function mountMissionControl(root, opts = {}) {
	if (!root) throw new Error('mountMissionControl requires a root element');
	injectMissionControlStyles();

	const bus = createBus();
	let store = null;
	let enricher = null;
	const panes = [];
	let keyboard = null;
	let balanceTimer = null;
	const cleanups = [];
	let destroyed = false;
	let autoSelecting = false;

	root.innerHTML = `<div class="mc-root" data-host="mc"><div class="mc-empty" style="height:100%"><div class="mc-empty-ico">◎</div><h3>Booting Mission Control…</h3><p>Connecting to the live launch firehose.</p></div></div>`;
	const rootEl = root.querySelector('[data-host="mc"]');

	(async () => {
		// Resolve the session first and ask for agents only when someone is
		// signed in: /api/agents answers 401 to an anonymous visitor, and the
		// browser logs every 4xx to the console. Either call failing degrades
		// to a read-only cockpit rather than a dead page.
		const user = await getMe().catch(() => null);
		const agents = user ? await loadUserAgents().catch(() => []) : [];
		if (destroyed) return;

		const tradable = (agents || []).filter((a) => a && (a.solana_address || a.meta?.solana_address || a.wallet_ready || a.walletReady));

		store = createStore({ bus, userId: user?.id || 'anon', signedIn: !!user });
		enricher = createEnricher({ store });
		if (opts.network === 'devnet') store.setNetwork('devnet');
		if (tradable[0]) store.setAgent(normalizeAgent(tradable[0]));

		buildShell({ user, agents: tradable });
	})();

	function normalizeAgent(a) {
		return {
			id: a.id,
			name: a.name || 'Agent',
			solana_address: a.solana_address || a.meta?.solana_address || null,
		};
	}

	function buildShell({ user, agents }) {
		rootEl.innerHTML = `
			${topbarHtml({ user, agents })}
			<div class="mc-main" data-host="main">
				<div class="mc-pane" data-host="feed"></div>
				<div class="mc-pane" data-host="focus"></div>
				<div class="mc-pane" data-host="positions"></div>
			</div>
			<div class="mc-mobilebar" role="tablist" aria-label="Panels">
				<button role="tab" data-mpane="feed" aria-selected="true">Feed</button>
				<button role="tab" data-mpane="focus" aria-selected="false">Focus</button>
				<button role="tab" data-mpane="positions" aria-selected="false">Positions</button>
			</div>
		`;

		// The connection pills subscribe before any pane exists, so the very
		// first state a pane publishes (the positions pane's "idle" for a visitor
		// with no agent, emitted synchronously on creation) is never lost.
		wireConnPills();

		// panes
		const feed = createFeedPane({ store, bus, enrich: enricher, mount: rootEl.querySelector('[data-host="feed"]') });
		const focus = createFocusPane({ store, bus, enrich: enricher, mount: rootEl.querySelector('[data-host="focus"]') });
		const positions = createPositionsPane({ store, bus, mount: rootEl.querySelector('[data-host="positions"]') });
		panes.push(feed, focus, positions);
		keyboard = createKeyboard({ store, bus, feed });

		wireTopbar({ agents });
		wireMobileBar();
		wireExpressBadge();

		// Auto-select the first launch that streams in (one-shot) for instant
		// signal. It is flagged so the phone layout keeps showing the feed the
		// user just opened; only a selection the user makes jumps to Focus.
		const offFirst = bus.on('feed:add', (row) => {
			if (!store.getSelected()) {
				autoSelecting = true;
				try { store.select(row.mint); } finally { autoSelecting = false; }
			}
			offFirst();
		});
		cleanups.push(offFirst);

		startBalance();
	}

	// ── topbar ────────────────────────────────────────────────────────────────
	function topbarHtml({ user, agents }) {
		let agentControl;
		if (agents.length) {
			agentControl = `
				<label class="mc-ctrl"><span class="mc-sr">Trading agent</span>
					<select class="mc-select" data-host="agentsel" aria-label="Trading agent">
						${agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || 'Agent')}</option>`).join('')}
					</select>
				</label>`;
		} else if (user) {
			agentControl = `<a class="mc-select" href="/create-agent" title="Create an agent wallet to trade">＋ Create a wallet</a>`;
		} else {
			agentControl = `<a class="mc-select" href="/login?next=%2Fterminal" title="Sign in to trade from your agent wallet">Sign in to trade</a>`;
		}
		return `
			<div class="mc-topbar">
				<a class="mc-brand" href="/" title="three.ws home">
					<img class="mc-brand-logo" src="/three.svg" alt="" width="22" height="22" loading="eager" decoding="async" />
					<h1>Mission Control</h1><span>Terminal</span>
				</a>
				<span class="mc-topbar-spacer"></span>
				<span class="mc-balance" data-host="balance" hidden>◎ <b data-host="balsol">—</b></span>
				${agentControl}
				<label class="mc-ctrl"><span class="mc-sr">Network</span>
					<select class="mc-select" data-host="netsel" aria-label="Network">
						<option value="mainnet">Mainnet</option>
						<option value="devnet">Devnet</option>
					</select>
				</label>
				<lang-switcher compact></lang-switcher>
				<div class="mc-conn-group">
					<span class="mc-conn" data-host="conn-feed" data-state="reconnecting"><span class="mc-conn-dot"></span>Feed</span>
					<span class="mc-conn" data-host="conn-pos" data-state="reconnecting"><span class="mc-conn-dot"></span>Positions</span>
				</div>
				<button class="mc-iconbtn" data-host="help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
			</div>`;
	}

	function wireTopbar({ agents }) {
		const agentSel = rootEl.querySelector('[data-host="agentsel"]');
		if (agentSel) {
			agentSel.value = store.getAgent()?.id || '';
			agentSel.addEventListener('change', () => {
				const a = agents.find((x) => x.id === agentSel.value);
				if (a) store.setAgent(normalizeAgent(a));
			});
		}
		const netSel = rootEl.querySelector('[data-host="netsel"]');
		netSel.value = store.getNetwork();
		netSel.addEventListener('change', () => store.setNetwork(netSel.value));

		rootEl.querySelector('[data-host="help"]').addEventListener('click', () => keyboard?.openHelp());
	}

	function wireMobileBar() {
		const buttons = [...rootEl.querySelectorAll('[data-mpane]')];
		const setActive = (name) => {
			for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.mpane === name));
			for (const key of ['feed', 'focus', 'positions']) {
				rootEl.querySelector(`[data-host="${key}"]`)?.classList.toggle('is-active', key === name);
			}
		};
		for (const b of buttons) b.addEventListener('click', () => setActive(b.dataset.mpane));
		setActive('feed');
		// jump to Focus on the phone when a coin is picked
		cleanups.push(bus.on('select', () => {
			if (autoSelecting) return;
			if (window.matchMedia('(max-width: 760px)').matches) setActive('focus');
		}));
	}

	function wireConnPills() {
		const feedPill = rootEl.querySelector('[data-host="conn-feed"]');
		const posPill = rootEl.querySelector('[data-host="conn-pos"]');
		cleanups.push(bus.on('conn:feed', (s) => feedPill?.setAttribute('data-state', s)));
		cleanups.push(bus.on('conn:positions', (s) => posPill?.setAttribute('data-state', s)));
	}

	function wireExpressBadge() {
		// Reflect express mode in the brand chip so the user always knows the trade
		// confirmation state at a glance.
		const chip = rootEl.querySelector('.mc-brand span');
		const refresh = () => {
			const a = store.getAgent();
			const express = a && store.isExpress(a.id);
			if (chip) {
				chip.textContent = express ? 'Express' : 'Terminal';
				chip.style.color = express ? 'var(--warn,#fbbf24)' : '';
				chip.style.borderColor = express ? 'color-mix(in srgb, var(--warn,#fbbf24) 40%, transparent)' : '';
			}
		};
		cleanups.push(bus.on('express', refresh));
		cleanups.push(bus.on('agent', refresh));
		refresh();
	}

	// ── balance ───────────────────────────────────────────────────────────────
	function startBalance() {
		const refresh = async () => {
			const agent = store.getAgent();
			const wrap = rootEl.querySelector('[data-host="balance"]');
			const sol = rootEl.querySelector('[data-host="balsol"]');
			if (!agent?.id || !wrap || !sol) { if (wrap) wrap.hidden = true; return; }
			try {
				const r = await fetchAgentSolanaWallet(agent.id, store.getNetwork());
				if (r.status === 'ok' && r.data) {
					wrap.hidden = false;
					sol.textContent = r.data.sol != null ? formatSol(r.data.sol) : '—';
					wrap.title = r.data.address ? shortAddress(r.data.address, 6, 6) : '';
				} else {
					wrap.hidden = true;
				}
			} catch { /* transient — keep last */ }
		};
		refresh();
		cleanups.push(bus.on('agent', refresh));
		cleanups.push(bus.on('network', refresh));
		cleanups.push(bus.on('trade:done', refresh));
		balanceTimer = setInterval(refresh, 30_000);
	}

	// ── teardown ────────────────────────────────────────────────────────────────
	function destroy() {
		if (destroyed) return;
		destroyed = true;
		if (balanceTimer) clearInterval(balanceTimer);
		for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
		for (const p of panes) { try { p.destroy?.(); } catch { /* ignore */ } }
		try { keyboard?.destroy?.(); } catch { /* ignore */ }
		try { enricher?.clear?.(); } catch { /* ignore */ }
		try { bus.clear?.(); } catch { /* ignore */ }
		root.innerHTML = '';
	}

	// Clean up on SPA-style navigation away or full unload.
	const onPageHide = () => destroy();
	window.addEventListener('pagehide', onPageHide, { once: true });
	cleanups.push(() => window.removeEventListener('pagehide', onPageHide));

	return { destroy };
}
