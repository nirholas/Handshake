/**
 * Agent Wallet hub: page entry.
 *
 * Routes: /agent/:id/wallet and /agents/:id/wallet (agent named in the path),
 * plus /agent-wallet with an optional ?id=<uuid>.
 *
 * When no agent is named, the page resolves the signed-in user's own agents
 * from GET /api/agents: exactly one agent mounts its hub straight away, several
 * render a picker, and none (or a signed-out visitor) gets a designed next step
 * instead of a dead end.
 *
 * Every page state is designed: loading skeleton, picker, signed out, no agents
 * yet, agent not found, fetch error (with retry), and the live hub. Owner vs
 * visitor is decided server-side by the agent record's `is_owner`.
 */

import { mountAgentWalletHub } from './agent-wallet-hub/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveAgentId() {
	const fromQuery = new URLSearchParams(location.search).get('id');
	if (fromQuery) return fromQuery;
	// /agent/:id/wallet  or  /agents/:id/wallet
	const m = location.pathname.match(/\/agents?\/([^/]+)\/wallet/);
	return m ? decodeURIComponent(m[1]) : null;
}

const root = document.getElementById('awh-root');

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function renderLoading(label = 'Loading agent wallet') {
	root.innerHTML = `
		<div class="awh-page-skel" aria-busy="true" aria-label="${escapeHtml(label)}">
			<div class="awh-page-skel-row"></div>
			<div class="awh-page-skel-tabs"></div>
			<div class="awh-page-skel-card"></div>
		</div>`;
}

/**
 * A designed terminal state: heading, one line of guidance, and up to two real
 * actions. `retry` adds a button that re-runs the page load.
 */
function renderMessage({ title, body, actions = [], retry }) {
	root.innerHTML = `
		<div class="awh-page-msg" role="alert">
			<h1>${escapeHtml(title)}</h1>
			<p>${escapeHtml(body)}</p>
			<div class="awh-page-msg-actions">
				${actions
					.map(
						(a) =>
							`<a class="awh-page-btn${a.primary ? ' awh-page-btn--primary' : ''}" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`,
					)
					.join('')}
				${retry ? '<button class="awh-page-btn" type="button" data-act="retry">Try again</button>' : ''}
			</div>
		</div>`;
	if (retry) root.querySelector('[data-act="retry"]')?.addEventListener('click', () => load());
}

/** Picker shown when the signed-in user owns more than one agent. */
function renderPicker(agents) {
	root.innerHTML = `
		<section class="awh-pick" aria-labelledby="awh-pick-h">
			<h1 id="awh-pick-h" class="awh-pick-h">Your agent wallets</h1>
			<p class="awh-pick-lede">Each agent holds its own self-custodied Solana wallet. Pick one to see its balance, fund it, and review its activity.</p>
			<ul class="awh-pick-list">
				${agents
					.map((a) => {
						const ready = !!(a.wallet_ready ?? a.walletReady);
						const addr = a.solana_address || '';
						const sub = addr
							? `${addr.slice(0, 4)}…${addr.slice(-4)}`
							: 'Wallet is being prepared';
						return `<li>
							<a class="awh-pick-row" href="/agent/${encodeURIComponent(a.id)}/wallet">
								${
									a.avatar_thumbnail_url
										? `<img class="awh-pick-av" src="${escapeHtml(a.avatar_thumbnail_url)}" alt="" loading="lazy" />`
										: '<span class="awh-pick-av" aria-hidden="true"></span>'
								}
								<span class="awh-pick-id">
									<span class="awh-pick-name">${escapeHtml(a.name || 'Untitled agent')}</span>
									<span class="awh-pick-sub">${escapeHtml(sub)}</span>
								</span>
								<span class="awh-pick-state" data-state="${ready ? 'ready' : 'preparing'}">${ready ? 'Ready' : 'Preparing'}</span>
								<span class="awh-pick-go" aria-hidden="true">→</span>
							</a>
						</li>`;
					})
					.join('')}
			</ul>
			<div class="awh-page-msg-actions awh-pick-foot">
				<a class="awh-page-btn" href="/my-agents">Manage agents</a>
				<a class="awh-page-btn" href="/create-agent">Create an agent</a>
			</div>
		</section>`;
	document.title = 'Your agent wallets · three.ws';
}

/** Fetch one agent by id. Returns { agent } or { state } for a designed stop. */
async function fetchAgent(agentId) {
	const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
		credentials: 'include',
		headers: { accept: 'application/json' },
	});
	if (res.status === 404) return { state: 'not_found' };
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	if (!data?.agent) throw new Error('empty agent payload');
	return { agent: data.agent };
}

/**
 * Fetch the caller's own agents. Returns { agents } or { state: 'signed_out' }.
 *
 * The session is resolved first through /api/auth/me, which answers 200 with a
 * null user for anonymous visitors. GET /api/agents answers 401 for them, and
 * the browser logs every 401 response as a console error, so the signed-out
 * path stops before it fires one.
 */
async function fetchOwnAgents() {
	const me = await fetch('/api/auth/me', {
		credentials: 'include',
		headers: { accept: 'application/json' },
	});
	if (!me.ok) throw new Error(`HTTP ${me.status}`);
	const session = await me.json();
	if (!session?.user?.id) return { state: 'signed_out' };

	const res = await fetch('/api/agents', {
		credentials: 'include',
		headers: { accept: 'application/json' },
	});
	if (res.status === 401 || res.status === 403) return { state: 'signed_out' };
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	return { agents: Array.isArray(data?.agents) ? data.agents : [] };
}

function mountHub(agent) {
	document.title = `${agent.name || 'Agent'} wallet · three.ws`;
	mountAgentWalletHub({ mount: root, agent });
}

/** No agent in the URL: resolve the signed-in user's own agents. */
async function loadOwnWallets() {
	renderLoading('Loading your agent wallets');

	let result;
	try {
		result = await fetchOwnAgents();
	} catch {
		renderMessage({
			title: "Couldn't load your wallets",
			body: 'We could not reach the agent service. This is usually temporary, so check your connection and try again.',
			retry: true,
		});
		document.title = 'Agent Wallet · three.ws';
		return;
	}

	if (result.state === 'signed_out') {
		renderMessage({
			title: 'Sign in to open an agent wallet',
			body: 'Agent wallets are private to their owner. Sign in to see your agents and their balances, or create an account to get an agent with its own Solana wallet.',
			actions: [
				{ href: '/login?next=/agent-wallet', label: 'Sign in', primary: true },
				{ href: '/register', label: 'Create account' },
			],
		});
		document.title = 'Agent Wallet · three.ws';
		return;
	}

	const agents = result.agents;
	if (!agents.length) {
		renderMessage({
			title: 'No agents yet',
			body: 'Every agent you create gets a self-custodied Solana wallet it can fund, trade, and pay from. Create your first agent to open its wallet.',
			actions: [{ href: '/create-agent', label: 'Create an agent', primary: true }],
		});
		document.title = 'Agent Wallet · three.ws';
		return;
	}

	if (agents.length === 1) {
		mountHub(agents[0]);
		return;
	}

	renderPicker(agents);
}

/** An agent is named in the URL: load and mount its hub. */
async function loadNamedWallet(agentId) {
	if (!UUID_RE.test(agentId)) {
		renderMessage({
			title: 'That agent link is not valid',
			body: 'An agent wallet link carries the agent id. Open the wallet from the agent profile, or pick one of your own agents.',
			actions: [
				{ href: '/agent-wallet', label: 'Your agent wallets', primary: true },
				{ href: '/agents', label: 'Browse agents' },
			],
		});
		document.title = 'Agent Wallet · three.ws';
		return;
	}

	renderLoading();

	let result;
	try {
		result = await fetchAgent(agentId);
	} catch {
		renderMessage({
			title: "Couldn't load this wallet",
			body: 'We could not reach the agent service. This is usually temporary, so check your connection and try again.',
			retry: true,
		});
		document.title = 'Agent Wallet · three.ws';
		return;
	}

	if (result.state === 'not_found') {
		renderMessage({
			title: 'Agent not found',
			body: 'This agent does not exist or has been removed. It may have been deleted by its owner.',
			actions: [{ href: '/agents', label: 'Browse agents', primary: true }],
		});
		document.title = 'Agent not found · three.ws';
		return;
	}

	mountHub(result.agent);
}

async function load() {
	const agentId = resolveAgentId();
	if (agentId) return loadNamedWallet(agentId);
	return loadOwnWallets();
}

load();
