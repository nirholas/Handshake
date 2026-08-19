/**
 * Hub actions row for the /agents/:id page.
 * Renders four CTAs (Customize, Embed, Deploy on-chain, Edit avatar)
 * into the agent-home-panel, above the timeline.
 *
 * Only shown to the agent's owner. Non-owners see the unmodified panel.
 */
import { AgentEmbedModal } from './agent-embed-modal.js';
import { log } from './shared/log.js';

/**
 * @param {HTMLElement}                                  panel      — .agent-home-panel element
 * @param {import('./agent-identity.js').AgentIdentity}  identity
 * @param {Object}                                       rawAgent   — raw API response (includes chain_id, is_registered when owner)
 */
export function renderHubActions(panel, identity, rawAgent) {
	const agentId = identity.id;
	const isRegistered = Boolean(rawAgent.is_registered);
	const chainId = rawAgent.chain_id || null;
	const walletAddress = rawAgent.wallet_address || null;
	const erc8004AgentId = rawAgent.erc8004_agent_id || null;

	const row = document.createElement('div');
	row.className = 'agent-hub-actions';
	row.innerHTML = `
		<button class="agent-hub-btn" id="hub-customize" title="Open the editing surface">
			${_iconGear()}
			<span>Customize</span>
		</button>
		<button class="agent-hub-btn" id="hub-embed" title="Get embed code">
			${_iconCode()}
			<span>Embed</span>
		</button>
		<button class="agent-hub-btn${isRegistered ? ' hub-btn--deployed' : ''}" id="hub-deploy"
			title="${isRegistered ? 'Manage on-chain record (edit, transfer, redeploy)' : 'Deploy on-chain — optional'}">
			${_iconChain()}
			<span>${isRegistered ? _deployedLabel(chainId, walletAddress, erc8004AgentId) : 'Deploy on-chain'}</span>
			${isRegistered ? '' : '<span class="agent-hub-opt">· Optional</span>'}
		</button>
		<button class="agent-hub-btn" id="hub-edit" title="Edit avatar">
			${_iconPencil()}
			<span>Edit avatar</span>
		</button>
	`;

	// Customize → /app?agent=:id
	row.querySelector('#hub-customize').addEventListener('click', () => {
		location.href = `/app?agent=${agentId}`;
	});

	// Embed → open modal
	const embedModal = new AgentEmbedModal(agentId);
	row.querySelector('#hub-embed').addEventListener('click', () => embedModal.open());

	// Deploy on-chain → RegisterUI (lazy-imported). For a registered agent we
	// open directly on the "My Agents" tab so the owner gets Edit / Redeploy /
	// Transfer without re-selecting their chain + agent.
	const deployBtn = row.querySelector('#hub-deploy');
	if (isRegistered) {
		deployBtn.addEventListener('click', async () => {
			deployBtn.disabled = true;
			try {
				const { RegisterUI } = await import('./erc8004/register-ui.js');
				const wrap = document.createElement('div');
				wrap.className = 'agent-register-overlay';
				document.body.appendChild(wrap);
				const ui = new RegisterUI(
					wrap,
					() => {},
					{
						initialTab: 'my',
						// onRegistered must NOT tear down the UI: the success screen with
						// the tx link stays up until the user closes it themselves.
						onClose: ({ registered }) => {
							wrap.remove();
							if (registered) location.reload();
						},
					},
				);
				wrap.addEventListener('click', (e) => {
					if (e.target === wrap) ui.destroy();
				});
			} catch (err) {
				log.error('[hub] register-ui load failed', err);
			} finally {
				deployBtn.disabled = false;
			}
		});
	} else {
		deployBtn.addEventListener('click', async () => {
			deployBtn.disabled = true;
			deployBtn.querySelector('span').textContent = 'Opening…';
			try {
				const initial = await _resolveAgentPrefill(rawAgent);
				const { RegisterUI } = await import('./erc8004/register-ui.js');
				const wrap = document.createElement('div');
				wrap.className = 'agent-register-overlay';
				document.body.appendChild(wrap);
				const ui = new RegisterUI(
					wrap,
					() => {},
					{
						initial,
						onClose: ({ registered }) => {
							wrap.remove();
							if (registered) location.reload();
						},
					},
				);
				wrap.addEventListener('click', (e) => {
					if (e.target === wrap) ui.destroy();
				});
			} catch (err) {
				log.error('[hub] register-ui load failed', err);
				deployBtn.disabled = false;
				deployBtn.querySelector('span').textContent = 'Deploy on-chain';
			}
		});
	}

	// Edit avatar → /agents/:id/edit
	row.querySelector('#hub-edit').addEventListener('click', () => {
		location.href = `/agents/${agentId}/edit`;
	});

	// Insert above the timeline (but below identity card + skills)
	const timeline = panel.querySelector('#agent-timeline');
	if (timeline) {
		panel.insertBefore(row, timeline);
	} else {
		panel.appendChild(row);
	}
}

/**
 * Build the `opts.initial` payload for RegisterUI from a backend agent.
 * Pulls name + description directly; if the agent has a linked avatar_id,
 * resolves that avatar's GLB + thumbnail so the wizard opens with the
 * embodied version pre-selected. Falls back silently on any fetch failure.
 *
 * @param {Object} rawAgent
 */
async function _resolveAgentPrefill(rawAgent) {
	const initial = {
		name: rawAgent.name || '',
		description: rawAgent.description || '',
	};
	if (!rawAgent.avatar_id) return initial;
	try {
		const res = await fetch(`/api/avatars/${encodeURIComponent(rawAgent.avatar_id)}`, {
			credentials: 'include',
		});
		if (!res.ok) return initial;
		const { avatar } = await res.json();
		if (!avatar) return initial;
		initial.glbUrl = avatar.url || avatar.model_url || '';
		initial.imageUrl = avatar.thumbnail_url || '';
	} catch (err) {
		log.warn('[hub] avatar prefill failed; opening wizard without it', err);
	}
	return initial;
}

// ── Icon helpers (inline SVG, consistent with existing nav icons) ─────────────

function _iconGear() {
	return `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.01 7.01 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.488.488 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.37 1.04.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
	</svg>`;
}

function _iconCode() {
	return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
	</svg>`;
}

function _iconChain() {
	return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
		<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
	</svg>`;
}

function _iconPencil() {
	return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
		<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
	</svg>`;
}

function _deployedLabel(chainId, walletAddress, erc8004AgentId) {
	const names = {
		1: 'Ethereum',
		10: 'Optimism',
		56: 'BNB',
		137: 'Polygon',
		8453: 'Base',
		42161: 'Arbitrum',
		97: 'BSC Testnet',
		84532: 'Base Sepolia',
		11155111: 'Sepolia',
	};
	const chain = names[chainId] || `Chain ${chainId || '?'}`;
	const tag = erc8004AgentId
		? `#${erc8004AgentId}`
		: walletAddress
			? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
			: '';
	return tag ? `${chain} · ${tag}` : chain;
}
