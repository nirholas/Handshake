/**
 * Rich agent detail page.
 *
 * Loads via /api/agents/:id (UUID) and /api/avatars/:id for the image.
 * Falls back to a 404 view when the id is unknown or fetch fails.
 *
 * Owner-private fields (chain_id, wallet_address, erc8004_*) only appear when
 * the requester is the agent's owner — render() tolerates them being absent.
 */

import {
	Connection,
	PublicKey,
	Transaction,
	SystemProgram,
	LAMPORTS_PER_SOL,
	clusterApiUrl,
} from '@solana/web3.js';
const solanaWeb3 = { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, clusterApiUrl };
import { openSwapModal } from './swap-jupiter.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICE_TYPES = {
	web: { tag: 'WEB' },
	a2a: { tag: 'A2A' },
	mcp: { tag: 'MCP' },
	token: { tag: 'TOKEN' },
	dbc: { tag: 'DBC' },
	chart: { tag: 'CHART' },
};

const TRUST_ACCENT = {
	reputation: 'amber',
	'crypto-economic': 'violet',
	tee: 'green',
};

const GRADIENTS = [
	['#7c3aed', '#4f46e5'],
	['#0ea5e9', '#6366f1'],
	['#10b981', '#0ea5e9'],
	['#f59e0b', '#ef4444'],
	['#ec4899', '#8b5cf6'],
	['#14b8a6', '#3b82f6'],
];

function avatarDataUri(name) {
	const [c1, c2] = GRADIENTS[(name?.charCodeAt(0) || 0) % GRADIENTS.length];
	const letter = (name || '?')[0].toUpperCase();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="168" viewBox="0 0 168 168"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="168" height="168" rx="24" fill="url(#g)"/><text x="50%" y="55%" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="80" font-weight="600" fill="white">${letter}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function shortAddr(s, head = 4, tail = 4) {
	if (!s) return '—';
	const str = String(s);
	if (str.length <= head + tail + 1) return str;
	return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of [].concat(children || [])) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

function pill(text, accent = '') {
	return el('span', { class: `ad-pill ${accent ? `ad-pill-${accent}` : ''}`, text });
}

function renderService(svc) {
	const meta = SERVICE_TYPES[svc.type] || { tag: (svc.type || '').toUpperCase() };
	const head = el('div', { class: 'ad-svc-head' }, [
		el('span', { class: 'ad-svc-tag', text: meta.tag }),
		svc.version ? el('span', { class: 'ad-svc-version', text: svc.version }) : null,
		svc.label ? el('span', { class: 'ad-svc-version', text: svc.label }) : null,
	]);

	const card = el('div', { class: 'ad-svc' }, [head]);

	if (svc.url) {
		card.appendChild(
			el('div', { class: 'ad-svc-link' }, [
				el('span', { text: '🔗' }),
				el('span', { text: svc.url }),
				el('button', {
					class: 'ad-copy',
					'aria-label': 'Copy',
					onclick: () => navigator.clipboard?.writeText(svc.url),
				}, '⧉'),
			]),
		);
	}

	const metaItems = [];
	if (svc.skills?.length) {
		metaItems.push(el('span', { class: 'ad-svc-meta-label', text: 'SKILLS' }));
		svc.skills.forEach((s) => metaItems.push(el('span', { class: 'ad-chip', text: s })));
	}
	if (svc.domains?.length) {
		metaItems.push(el('span', { class: 'ad-svc-meta-label', text: 'DOMAINS' }));
		svc.domains.forEach((s) => metaItems.push(el('span', { class: 'ad-chip', text: s })));
	}
	if (metaItems.length) card.appendChild(el('div', { class: 'ad-svc-meta' }, metaItems));

	return card;
}

function render(agent) {
	document.title = `${agent.name} — three.ws`;

	const $ = (id) => document.getElementById(id);

	$('ad-avatar').src = agent.avatar || avatarDataUri(agent.name);
	$('ad-avatar').alt = agent.name;
	$('ad-avatar').onerror = () => { $('ad-avatar').src = avatarDataUri(agent.name); };
	$('ad-name').textContent = agent.name;

	const status = $('ad-status');
	status.textContent = agent.active ? 'Active' : 'Inactive';
	status.classList.toggle('ad-status-inactive', !agent.active);

	$('ad-id-short').textContent = shortAddr(agent.id);
	$('ad-id-short').dataset.full = agent.id;
	$('ad-asset-kind').textContent = agent.assetKind || 'Core Asset';
	$('ad-desc').textContent = agent.description || '';

	const trustPills = $('ad-trust-pills');
	trustPills.innerHTML = '';
	(agent.trust || []).forEach((t) =>
		trustPills.appendChild(pill(t, TRUST_ACCENT[t.toLowerCase()] || '')),
	);

	const services = $('ad-services');
	services.innerHTML = '';
	(agent.services || []).forEach((s) => services.appendChild(renderService(s)));
	$('ad-svc-count').textContent = `${agent.services?.length || 0} configured`;
	$('ad-svc-count2').textContent = String(agent.services?.length || 0);

	$('ad-holdings-addr').textContent = shortAddr(agent.wallet);
	$('ad-holdings-addr').dataset.full = agent.wallet;
	$('ad-holdings-sol').textContent = String(agent.solBalance ?? 0);

	if (agent.token) {
		$('ad-token-body').classList.remove('ad-muted');
		$('ad-token-body').textContent = '';
		const tokenRow = el('div', { class: 'ad-row ad-row-split' }, [
			el('span', { text: agent.token.symbol || 'TOKEN' }),
			el('span', { class: 'ad-mono', text: shortAddr(agent.token.mint) }),
		]);
		$('ad-token-body').appendChild(tokenRow);
		const dashLink = agent.token.pumpfun_url
			|| (agent.token.cluster === 'devnet'
				? `https://explorer.solana.com/address/${agent.token.mint}?cluster=devnet`
				: `https://pump.fun/${agent.token.mint}`);
		const viewBtn = el('a', {
			class: 'ad-token-cta',
			href: dashLink,
			target: '_blank',
			rel: 'noopener noreferrer',
			text: `View on ${agent.token.cluster === 'devnet' ? 'Solana Explorer' : 'pump.fun'} →`,
		});
		$('ad-token-body').appendChild(viewBtn);
	} else if (agent.isOwner) {
		$('ad-token-body').classList.remove('ad-muted');
		$('ad-token-body').textContent = '';
		const launchBtn = el('button', {
			class: 'ad-token-cta',
			type: 'button',
			text: '🚀 Launch agent token',
		});
		launchBtn.addEventListener('click', async () => {
			launchBtn.disabled = true;
			try {
				const { openLaunchTokenModal } = await import('/src/pump/launch-token-modal.js');
				const rec = agent.rawMetadata || {};
				const onchain = rec.onchain || rec.meta?.onchain || null;
				const needsDeploy = !onchain || onchain.family !== 'solana';
				const imageUrl =
					rec.avatar_thumbnail_url || rec.meta?.thumbnail_url || agent.avatar || '';
				openLaunchTokenModal({
					agentId: agent.id,
					agentName: agent.name,
					imageUrl,
					needsDeploy,
					agentForDeploy: needsDeploy
						? {
								id: agent.id,
								name: rec.name || agent.name,
								description: rec.description || '',
								avatar_id: rec.avatar_id || null,
								skills: rec.skills || undefined,
							}
						: null,
				});
			} finally {
				launchBtn.disabled = false;
			}
		});
		$('ad-token-body').appendChild(launchBtn);
	}

	$('ad-rewards').textContent = String(agent.creatorRewards ?? 0);

	const mechs = $('ad-trust-mechs');
	mechs.innerHTML = '';
	(agent.trust || []).forEach((t) =>
		mechs.appendChild(pill(t, TRUST_ACCENT[t.toLowerCase()] || '')),
	);

	const pay = $('ad-payment');
	pay.innerHTML = '';
	pay.appendChild(pill(agent.x402 ? 'x402 Supported' : 'x402 Not Supported', agent.x402 ? 'green' : ''));

	$('ad-agent-id').textContent = shortAddr(agent.id);
	const regs = $('ad-registries');
	regs.innerHTML = '';
	(agent.registries || []).forEach((r) => regs.appendChild(pill(r)));

	$('ad-raw').textContent = JSON.stringify(agent.rawMetadata || agent, null, 2);

	const onchain = $('ad-onchain');
	onchain.innerHTML = '';
	[
		['Agent UUID', shortAddr(agent.id)],
		['Agent Wallet', shortAddr(agent.wallet)],
		['Owner', shortAddr(agent.owner)],
		['Authority', shortAddr(agent.authority)],
	].forEach(([k, v]) => {
		onchain.appendChild(
			el('div', { class: 'ad-row ad-row-split' }, [
				el('span', { class: 'ad-muted', text: k }),
				el('span', { class: 'ad-mono', text: v }),
			]),
		);
	});

	$('ad-active').textContent = agent.active ? 'true' : 'false';
	$('ad-x402').textContent = agent.x402 ? 'Yes' : 'No';

	const supportedTrust = $('ad-supported-trust');
	supportedTrust.innerHTML = '';
	(agent.trust || []).forEach((t) =>
		supportedTrust.appendChild(pill(t, TRUST_ACCENT[t.toLowerCase()] || '')),
	);

	const protos = $('ad-protocols');
	protos.innerHTML = '';
	(agent.protocols || []).forEach((p) => protos.appendChild(pill(p)));

	if (agent.explorerUrl && agent.explorerUrl !== '#') $('ad-explorer').href = agent.explorerUrl;
	else $('ad-explorer').style.display = 'none';
	if (agent.tradeUrl && agent.tradeUrl !== '#') $('ad-trade').href = agent.tradeUrl;
	else $('ad-trade').style.display = 'none';

	const sns = agent.rawMetadata?.meta?.sns_domain;
	if (sns) {
		document.getElementById('ad-sns-row').style.display = '';
		document.getElementById('ad-sns').textContent = `${sns}.sol`;
	}

	const voiceProvider = agent.rawMetadata?.voice_provider;
	const voiceId = agent.rawMetadata?.voice_id;
	if (voiceProvider && voiceProvider !== 'browser') {
		document.getElementById('ad-voice-row').style.display = '';
		document.getElementById('ad-voice').innerHTML = `<span class="ad-pill ad-pill-green">cloned · ${voiceProvider}</span>`;
	} else if (voiceProvider === 'browser') {
		document.getElementById('ad-voice-row').style.display = '';
		document.getElementById('ad-voice').textContent = 'browser TTS';
	}

	document.querySelector('.ad-main').classList.remove('loading');
	bindWalletActions();

	loadExtraSections(agent.id, agent.rawMetadata);
}

async function loadExtraSections(agentId, rec) {
	const url = (p) => `/api/agents/${encodeURIComponent(agentId)}${p}`;

	const safe = async (fn) => {
		try { return await fn(); } catch (e) { return null; }
	};

	const [actions, memory, strategy, reputation, embedPolicy] = await Promise.all([
		safe(() => fetchJson(url('/actions?limit=8'))),
		safe(() => fetch(`/api/agent-memory?agentId=${encodeURIComponent(agentId)}&limit=6`, { credentials: 'include' }).then((r) => r.ok ? r.json() : null)),
		safe(() => fetch(`/api/agent-strategy?id=${encodeURIComponent(agentId)}`, { credentials: 'include' }).then((r) => r.ok ? r.json() : null)),
		safe(() => fetchJson(url('/reputation'))),
		safe(() => fetch(url('/embed-policy'), { credentials: 'include' }).then((r) => r.ok ? r.json() : null)),
	]);

	if (actions?.actions?.length) renderActions(actions.actions, agentId);
	if (memory?.entries?.length) renderMemory(memory.entries);
	if (strategy?.data?.strategy != null) renderStrategy(strategy.data.strategy);
	if (reputation && (reputation.count > 0 || reputation.average > 0)) renderReputation(reputation);
	if (embedPolicy) renderEmbedPolicy(embedPolicy);
}

function escapeText(s) {
	return String(s == null ? '' : s);
}

function fmtRelTime(iso) {
	const t = new Date(iso).getTime();
	const sec = Math.floor((Date.now() - t) / 1000);
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
	return new Date(iso).toLocaleDateString();
}

function actionIcon(type) {
	return ({ speak: '💬', remember: '📝', sign: '✍️', 'skill-done': '✓', validate: '✔', 'load-end': '📦' })[type] || '•';
}

function summarizeActionPayload(p) {
	if (typeof p !== 'object' || !p) return '';
	if (p.text) return String(p.text).slice(0, 90);
	if (p.content) return String(p.content).slice(0, 90);
	const k = Object.keys(p)[0];
	if (k == null) return '';
	const v = p[k];
	return typeof v === 'string' ? `${k}=${v.slice(0, 60)}` : `${k}=${typeof v}`;
}

function renderActions(actions, agentId) {
	const card = document.getElementById('ad-actions-card');
	const list = document.getElementById('ad-actions-list');
	document.getElementById('ad-actions-count').textContent = `${actions.length} recent`;
	list.innerHTML = '';
	for (const a of actions) {
		const verifyMark =
			a.verified === true ? '<span class="ad-pill ad-pill-green" title="signature verified">✓</span>'
			: a.verified === false ? '<span class="ad-pill" title="invalid signature">✗</span>'
			: '';
		const meta = el('span', { class: 'ad-muted', style: 'font-size:11px;display:flex;align-items:center;gap:6px' });
		if (verifyMark) {
			const m = document.createElement('span');
			m.innerHTML = verifyMark;
			meta.appendChild(m);
		}
		meta.appendChild(el('span', { text: fmtRelTime(a.timestamp) }));
		const row = el('div', { class: 'ad-row ad-row-split', style: 'padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)' }, [
			el('span', { style: 'display:flex;align-items:center;gap:8px;min-width:0' }, [
				el('span', { text: actionIcon(a.type) }),
				el('span', { class: 'ad-mono', style: 'min-width:90px;flex-shrink:0', text: a.type }),
				el('span', { class: 'ad-muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: summarizeActionPayload(a.payload) }),
			]),
			meta,
		]);
		list.appendChild(row);
	}
	list.appendChild(
		el('div', { style: 'text-align:center;padding-top:10px' }, [
			el('a', { class: 'ad-cta', href: `/dashboard/actions?agent=${encodeURIComponent(agentId)}`, text: 'See full action log →' }),
		]),
	);
	card.style.display = '';
}

function renderMemory(entries) {
	const card = document.getElementById('ad-memory-card');
	document.getElementById('ad-memory-count').textContent = `${entries.length}`;
	const list = document.getElementById('ad-memory-list');
	list.innerHTML = '';
	for (const m of entries) {
		const row = el('div', { style: 'padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)' }, [
			el('div', { class: 'ad-muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px', text: m.type || 'memory' }),
			el('div', { style: 'color:#ddd;font-size:13px;white-space:pre-wrap', text: String(m.content || '').slice(0, 240) }),
		]);
		list.appendChild(row);
	}
	card.style.display = '';
}

function renderStrategy(strategy) {
	const card = document.getElementById('ad-strategy-card');
	const pre = document.getElementById('ad-strategy');
	pre.textContent = typeof strategy === 'string' ? strategy : JSON.stringify(strategy, null, 2);
	card.style.display = '';
}

function renderReputation(r) {
	const card = document.getElementById('ad-reputation-card');
	document.getElementById('ad-rep-avg').textContent = r.average ? Number(r.average).toFixed(2) : '0.00';
	document.getElementById('ad-rep-count').textContent = String(r.count || 0);
	if (r.total_stake_wei && r.total_stake_wei !== '0') {
		document.getElementById('ad-rep-stake-row').style.display = '';
		const wei = BigInt(r.total_stake_wei);
		const eth = Number(wei) / 1e18;
		document.getElementById('ad-rep-stake').textContent = `${eth.toFixed(4)} ETH`;
	}
	card.style.display = '';
}

function renderEmbedPolicy(p) {
	if (!p || typeof p !== 'object') return;
	const card = document.getElementById('ad-embed-policy-card');
	const host = document.getElementById('ad-embed-policy');
	host.innerHTML = '';

	const allowEmbed = p.allow_embed === false ? 'No' : 'Yes';
	const allowedOrigins = Array.isArray(p.allowed_origins) ? p.allowed_origins : [];
	const monthlyQuota = p?.brain?.monthly_quota;

	host.appendChild(el('div', { class: 'ad-row ad-row-split' }, [
		el('span', { class: 'ad-muted', text: 'Embeddable' }),
		el('span', { text: allowEmbed }),
	]));
	if (allowedOrigins.length) {
		host.appendChild(el('div', { class: 'ad-row ad-row-split' }, [
			el('span', { class: 'ad-muted', text: 'Allowed origins' }),
			el('span', { class: 'ad-mono', style: 'font-size:11px;text-align:right', text: allowedOrigins.slice(0, 3).join(', ') + (allowedOrigins.length > 3 ? ` +${allowedOrigins.length - 3}` : '') }),
		]));
	} else if (allowEmbed === 'Yes') {
		host.appendChild(el('div', { class: 'ad-row ad-row-split' }, [
			el('span', { class: 'ad-muted', text: 'Allowed origins' }),
			el('span', { text: 'any' }),
		]));
	}
	if (monthlyQuota != null) {
		host.appendChild(el('div', { class: 'ad-row ad-row-split' }, [
			el('span', { class: 'ad-muted', text: 'Monthly LLM quota' }),
			el('span', { text: String(monthlyQuota) }),
		]));
	}
	card.style.display = '';
}

function bindWalletActions() {
	const receiveBtn = document.getElementById('receive-btn');
	const withdrawBtn = document.getElementById('withdraw-btn');
	const swapBtn = document.getElementById('swap-btn');
	const qrCodeContainer = document.getElementById('qr-code-container');
	const qrCodeCanvas = document.getElementById('qr-code');
	const walletAddressSpan = document.getElementById('ad-holdings-addr');
	const modal = document.getElementById('withdraw-modal');
	const closeModalBtn = document.getElementById('close-modal-btn');
	const cancelWithdrawBtn = document.getElementById('cancel-withdraw-btn');
	const confirmWithdrawBtn = document.getElementById('confirm-withdraw-btn');
	const withdrawAmountInput = document.getElementById('withdraw-amount');
	const recipientAddressInput = document.getElementById('recipient-address');

	receiveBtn.addEventListener('click', () => {
			const walletAddress = walletAddressSpan.dataset.full;
			if (walletAddress) {
					qrCodeContainer.classList.toggle('hidden');
					if (!qrCodeContainer.classList.contains('hidden')) {
							new QRious({
									element: qrCodeCanvas,
									value: walletAddress,
									size: 160,
							});
					}
			}
	});

	withdrawBtn.addEventListener('click', () => {
		modal.classList.remove('hidden');
	});

	closeModalBtn.addEventListener('click', () => {
		modal.classList.add('hidden');
	});

	cancelWithdrawBtn.addEventListener('click', () => {
		modal.classList.add('hidden');
	});

	confirmWithdrawBtn.addEventListener('click', async () => {
		if (!wallet) {
			alert('Please connect your wallet first.');
			return;
		}

		const amount = parseFloat(withdrawAmountInput.value);
		const recipientAddress = recipientAddressInput.value;

		if (isNaN(amount) || amount <= 0) {
			alert('Please enter a valid amount.');
			return;
		}

		if (!recipientAddress) {
			alert('Please enter a recipient address.');
			return;
		}

		try {
			const recipientPubKey = new solanaWeb3.PublicKey(recipientAddress);
			const transaction = new solanaWeb3.Transaction().add(
				solanaWeb3.SystemProgram.transfer({
					fromPubkey: wallet,
					toPubkey: recipientPubKey,
					lamports: amount * solanaWeb3.LAMPORTS_PER_SOL,
				})
			);

			transaction.feePayer = wallet;
			const { blockhash } = await connection.getRecentBlockhash();
			transaction.recentBlockhash = blockhash;

			const provider = getProvider();
			const signedTransaction = await provider.signTransaction(transaction);
			const signature = await connection.sendRawTransaction(signedTransaction.serialize());
			await connection.confirmTransaction(signature);

			alert(`Withdrawal of ${amount} SOL to ${recipientAddress} successful!`);

			modal.classList.add('hidden');
			withdrawAmountInput.value = '';
			recipientAddressInput.value = '';

		} catch (error) {
			console.error('Withdrawal failed:', error);
			alert(`Withdrawal failed: ${error.message}`);
		}
	});

	swapBtn.addEventListener('click', () => {
		openSwapModal({ wallet, getProvider });
	});
}

function renderNotFound(id, reason) {
	document.title = 'Agent not found — three.ws';
	const main = document.querySelector('.ad-main');
	main.innerHTML = `
		<div class="ad-banner"><span>S1 Powered by Torque · $250K rewards</span></div>
		<div style="padding:60px 24px;text-align:center;">
			<h1 style="margin:0 0 8px;font-size:22px;font-weight:600;">Agent not found</h1>
			<p style="color:rgba(231,233,238,0.55);font-size:14px;margin:0 0 22px;">
				${reason || 'No agent registered with id'} <code style="font-family:ui-monospace,monospace;color:#e7e9ee;">${id || '(none)'}</code>.
			</p>
			<a class="ad-cta" style="display:inline-block;padding:10px 22px;" href="/agents">← Back to Registry</a>
		</div>
	`;
}

document.addEventListener('click', (e) => {
	const btn = e.target.closest('.ad-copy[data-copy-target]');
	if (!btn) return;
	const id = btn.getAttribute('data-copy-target');
	const node = document.getElementById(id);
	const value = node?.dataset?.full || node?.textContent || '';
	if (value && value !== '—') navigator.clipboard?.writeText(value);
});

async function fetchJson(url) {
	const res = await fetch(url, { credentials: 'include' });
	if (!res.ok) {
		const err = new Error(`${url} → HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

/**
 * Inflate the /api/agents/:id record into the detail-page shape.
 * `meta.onchain`, `rec.token`, and `rec.payments` are surfaced when present.
 */
function normalize(rec, avatar) {
	const meta = rec.meta || {};
	const onchain = rec.onchain || meta.onchain || {};

	const trust = [];
	if (rec.payments || rec.is_registered) trust.push('Reputation');
	if (rec.token) trust.push('Crypto-Economic');

	const services = [];
	if (rec.home_url) {
		services.push({
			type: 'web',
			url: new URL(rec.home_url, location.origin).href,
		});
	}
	if (rec.skills?.length) {
		services.push({
			type: 'a2a',
			version: meta.a2a_version || '0.3.0',
			url: `${location.origin}/agent/${rec.id}`,
			skills: rec.skills.map((s) => (typeof s === 'string' ? s : s.name || s.id)).filter(Boolean),
			domains: meta.domains || undefined,
		});
	}
	if (rec.token?.mint) {
		services.push({
			type: 'token',
			label: rec.token.symbol || rec.token.name,
			url: `https://birdeye.so/token/${rec.token.mint}?chain=solana`,
		});
		services.push({
			type: 'chart',
			url: `https://dexscreener.com/solana/${rec.token.mint}`,
		});
	}

	const protocols = [];
	if (rec.home_url) protocols.push('WEB');
	if (rec.skills?.length) protocols.push(`A2A ${meta.a2a_version || '0.3.0'}`);
	if (rec.token?.symbol) protocols.push(`TOKEN ${rec.token.symbol}`);
	if (onchain?.chain_id || rec.chain_id) protocols.push(`CHAIN ${onchain?.chain_id ?? rec.chain_id}`);

	const wallet = rec.wallet_address || onchain.wallet || meta.solana_wallet || '';

	const explorerUrl =
		(rec.token?.mint && `https://solscan.io/token/${rec.token.mint}`) ||
		(wallet && `https://solscan.io/account/${wallet}`) ||
		'#';

	const registries = [];
	if (rec.erc8004_registry) {
		registries.push(`ERC-8004 #${rec.erc8004_agent_id ?? '?'}`);
	}
	if (rec.is_registered) registries.push('three.ws');

	return {
		id: rec.id,
		name: rec.name || 'Unnamed agent',
		assetKind: rec.is_registered ? 'Core Asset' : 'Off-chain',
		active: !!rec.is_registered,
		avatar: avatar?.image_url || avatar?.thumbnail_url || avatar?.preview_url || null,
		description: rec.description || '',
		trust,
		wallet,
		owner: rec.user_id || onchain.owner || '',
		authority: onchain.authority || rec.erc8004_registry || '',
		solBalance: meta.sol_balance ?? 0,
		creatorRewards: meta.creator_rewards ?? 0,
		x402: !!(rec.payments?.accepted_tokens?.length),
		registries,
		protocols,
		explorerUrl,
		tradeUrl: rec.token?.mint ? `https://magiceden.io/marketplace/${rec.token.mint}` : '#',
		token: rec.token || null,
		services,
		// The /api/agents/:id endpoint only includes `user_id` in the response when
		// the requester is the owner — see api/agents.js decorate(row, isOwner).
		isOwner: !!rec.user_id,
		rawMetadata: rec,
	};
}

async function loadAgent(id) {
	if (!id) return { error: 'missing id', agent: null };
	if (!UUID_RE.test(id)) return { error: 'invalid id (expected UUID)', agent: null };

	let rec;
	try {
		const json = await fetchJson(`/api/agents/${encodeURIComponent(id)}`);
		rec = json.agent;
	} catch (e) {
		return { error: e.status === 404 ? 'No agent with id' : `Fetch failed: ${e.message}`, agent: null };
	}
	if (!rec) return { error: 'No agent with id', agent: null };

	let avatar = null;
	if (rec.avatar_id) {
		try {
			const json = await fetchJson(`/api/avatars/${encodeURIComponent(rec.avatar_id)}`);
			avatar = json.avatar || null;
		} catch (e) {
			console.warn('[agent-detail] avatar fetch failed:', e.message);
		}
	}

	return { agent: normalize(rec, avatar), error: null };
}

// --- Wallet Integration ---

const getProvider = () => {
	if ('phantom' in window) {
		const provider = window.phantom?.solana;
		if (provider?.isPhantom) {
			return provider;
		}
	}
	window.open('https://phantom.app/', '_blank');
	return null;
};

let wallet = null;
// Route through our same-origin proxy. Public devnet RPC is also rate-limited
// from browsers; the proxy keeps both clusters consistent.
const _rpcOrigin = window.location?.origin || 'https://three.ws';
const connection = new solanaWeb3.Connection(`${_rpcOrigin}/api/solana-rpc?net=devnet`, 'confirmed');
const connectWalletBtn = document.getElementById('connect-wallet-btn');

connectWalletBtn.addEventListener('click', async () => {
	const provider = getProvider();
	if (provider) {
		try {
			const resp = await provider.connect();
			wallet = resp.publicKey;

			connectWalletBtn.textContent = `${wallet.toString().slice(0, 4)}...${wallet.toString().slice(-4)}`;
		} catch (err) {
			console.error('Failed to connect to wallet:', err);
		}
	}
});


const id = new URLSearchParams(location.search).get('id') || location.pathname.match(/\/agents\/([^/]+)/)?.[1];
loadAgent(id)
	.then(({ agent, error }) => {
		if (!agent) return renderNotFound(id, error);
		render(agent);
	})
	.catch((e) => {
		console.error('[agent-detail] load failed', e);
		renderNotFound(id, 'Unexpected error loading');
	});
