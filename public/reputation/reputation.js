/**
 * Reputation page — view and submit on-chain attestations for any agent address.
 *
 * Reading:  EAS (Ethereum Attestation Service) via EASScan GraphQL — no wallet required.
 * Writing:  EAS SDK — requires MetaMask/wallet + a small amount of gas.
 *
 * URL params:
 *   ?address=0x...        attestations for an Ethereum address
 *   ?address=name.eth     ENS name (resolved automatically)
 *   ?chain=8453           which EAS chain (default: 8453 Base mainnet)
 *   ?agent=N:M            legacy: ERC-8004 agent on chain N with ID M
 */

import { BrowserProvider, JsonRpcProvider, isAddress, getAddress } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';
import { CHAIN_META, switchChain } from '../../src/erc8004/chain-meta.js';
import { REGISTRY_DEPLOYMENTS, IDENTITY_REGISTRY_ABI, REPUTATION_REGISTRY_ABI } from '../../src/erc8004/abi.js';
import { getReputation, submitReputation } from '../../src/erc8004/reputation.js';
import { Contract } from 'ethers';

// ── EAS per-chain config ─────────────────────────────────────────────────────

const EAS_CHAINS = {
	8453:  {
		name: 'Base',
		graphql: 'https://base.easscan.org/graphql',
		contract: '0x4200000000000000000000000000000000000021',
		easscan: 'https://base.easscan.org',
		explorer: 'https://basescan.org',
		hexId: '0x2105',
		rpcUrl: 'https://mainnet.base.org',
	},
	84532: {
		name: 'Base Sepolia',
		graphql: 'https://base-sepolia.easscan.org/graphql',
		contract: '0x4200000000000000000000000000000000000021',
		easscan: 'https://base-sepolia.easscan.org',
		explorer: 'https://sepolia.basescan.org',
		hexId: '0x14a34',
		rpcUrl: 'https://sepolia.base.org',
		schemaUid: '0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe',
	},
	1: {
		name: 'Ethereum',
		graphql: 'https://easscan.org/graphql',
		contract: '0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587',
		easscan: 'https://easscan.org',
		explorer: 'https://etherscan.io',
		hexId: '0x1',
		rpcUrl: 'https://ethereum-rpc.publicnode.com',
	},
	10: {
		name: 'Optimism',
		graphql: 'https://optimism.easscan.org/graphql',
		contract: '0x4200000000000000000000000000000000000021',
		easscan: 'https://optimism.easscan.org',
		explorer: 'https://optimistic.etherscan.io',
		hexId: '0xa',
		rpcUrl: 'https://mainnet.optimism.io',
	},
	42161: {
		name: 'Arbitrum',
		graphql: 'https://arbitrum.easscan.org/graphql',
		contract: '0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458',
		easscan: 'https://arbitrum.easscan.org',
		explorer: 'https://arbiscan.io',
		hexId: '0xa4b1',
		rpcUrl: 'https://arb1.arbitrum.io/rpc',
	},
	137: {
		name: 'Polygon',
		graphql: 'https://polygon.easscan.org/graphql',
		contract: '0x5E634ef5355f45A855d02D66eCD687b1502AF790',
		easscan: 'https://polygon.easscan.org',
		explorer: 'https://polygonscan.com',
		hexId: '0x89',
		rpcUrl: 'https://polygon-rpc.com',
	},
};

const SCHEMA_STRING = 'address agent, uint8 score, string comment';
const DEFAULT_READ_CHAIN = 8453;   // Base mainnet
const DEFAULT_WRITE_CHAIN = 84532; // Base Sepolia (testnet, free ETH)
const ENS_PROVIDER_URL = 'https://ethereum-rpc.publicnode.com'; // For ENS resolution

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}

function shortAddr(addr) {
	if (!addr || addr.length < 10) return addr || '';
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relativeTime(unixSeconds) {
	const diff = Date.now() / 1000 - unixSeconds;
	if (diff < 60) return 'just now';
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
	if (diff < 86400 * 365) return `${Math.floor(diff / 30 / 86400)}mo ago`;
	return `${Math.floor(diff / 365 / 86400)}y ago`;
}

function scoreToStars(score) {
	if (!score || score <= 0) return 0;
	if (score > 5) return Math.max(1, Math.min(5, Math.round(score / 20)));
	return Math.max(1, Math.min(5, Math.round(score)));
}

function starsHtml(stars, size = 15) {
	let out = `<span class="rep-stars-row" aria-label="${stars} out of 5 stars">`;
	for (let i = 1; i <= 5; i++) {
		out += `<svg width="${size}" height="${size}" viewBox="0 0 20 20" class="rep-star ${i <= stars ? 'filled' : 'empty'}" aria-hidden="true">
			<path d="M10 1l2.39 4.84 5.34.78-3.87 3.77.91 5.32L10 13.27l-4.77 2.51.91-5.32L2.27 6.62l5.34-.78z"/>
		</svg>`;
	}
	return out + '</span>';
}

function identiconHtml(addr, size = 28) {
	if (!addr) return '';
	let h = 0;
	for (let i = 0; i < addr.length; i++) h = ((h << 5) - h + addr.charCodeAt(i)) | 0;
	const hue = Math.abs(h) % 360;
	const sat = 50 + (Math.abs(h >> 8) % 20);
	const lit = 32 + (Math.abs(h >> 16) % 12);
	const initials = addr.slice(2, 4).toUpperCase();
	return `<span class="rep-identicon" style="width:${size}px;height:${size}px;background:hsl(${hue},${sat}%,${lit}%)" aria-hidden="true">${initials}</span>`;
}

function decodeAttestationData(decodedDataJson) {
	try {
		const fields = JSON.parse(decodedDataJson || '[]');
		const out = {};
		for (const f of fields) {
			const val = f.value?.value ?? f.value;
			out[f.name] = val;
		}
		return out;
	} catch {
		return {};
	}
}

function scoreColor(avg) {
	if (avg >= 70) return '#22d17a';
	if (avg >= 40) return '#f5a623';
	return '#ff5a5a';
}

// ── EAS GraphQL read ─────────────────────────────────────────────────────────

async function fetchAttestations(address, chainId) {
	const chain = EAS_CHAINS[chainId];
	if (!chain) throw new Error(`No EAS support for chain ${chainId}`);

	const checksummed = getAddress(address);
	const query = `
		query Attestations($where: AttestationWhereInput!) {
			attestations(
				where: $where
				orderBy: [{ time: desc }]
				take: 100
			) {
				id
				attester
				recipient
				schemaId
				time
				revoked
				txid
				decodedDataJson
				schema { schema }
			}
		}
	`;

	const where = { recipient: { equals: checksummed }, revoked: { equals: false } };
	const res = await fetch(chain.graphql, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables: { where } }),
	});
	if (!res.ok) throw new Error(`EASScan API error: ${res.status}`);
	const body = await res.json();
	if (body.errors) throw new Error(body.errors[0]?.message || 'GraphQL error');
	return (body.data?.attestations || []).map((a) => ({
		uid: a.id,
		attester: a.attester,
		recipient: a.recipient,
		schemaId: a.schemaId,
		schemaString: a.schema?.schema || '',
		time: Number(a.time),
		txid: a.txid,
		decoded: decodeAttestationData(a.decodedDataJson),
	}));
}

async function resolveENS(name) {
	try {
		const provider = new JsonRpcProvider(ENS_PROVIDER_URL);
		const addr = await provider.resolveName(name);
		return addr;
	} catch {
		return null;
	}
}

// ── ERC-8004 agent ID lookup by wallet address ───────────────────────────────

async function findAgentIdForAddress(address, chainId) {
	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	const meta = CHAIN_META[chainId];
	if (!deployment?.identityRegistry || !meta?.rpcUrl) return null;
	try {
		const provider = new JsonRpcProvider(meta.rpcUrl, chainId, { staticNetwork: true });
		const registry = new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
		const checksummed = getAddress(address);
		const balance = await registry.balanceOf(checksummed);
		if (Number(balance) === 0) return null;
		const agentId = await registry.tokenOfOwnerByIndex(checksummed, 0);
		return Number(agentId);
	} catch {
		return null;
	}
}

async function fetchErc8004Reputation(agentId, chainId) {
	const meta = CHAIN_META[chainId];
	if (!meta?.rpcUrl) return null;
	try {
		const provider = new JsonRpcProvider(meta.rpcUrl, chainId, { staticNetwork: true });
		return await getReputation({ agentId, runner: provider, chainId });
	} catch {
		return null;
	}
}

// ── URL parsing ───────────────────────────────────────────────────────────────

function parseUrl() {
	const params = new URLSearchParams(window.location.search);
	const addressParam = params.get('address');
	const chainParam = params.get('chain');
	const agentParam = params.get('agent');

	if (agentParam) {
		const parts = agentParam.split(':');
		if (parts.length === 2) {
			return { mode: 'agent', chainId: Number(parts[0]), agentId: Number(parts[1]) };
		}
	}

	if (addressParam) {
		return {
			mode: 'address',
			address: addressParam,
			chainId: Number(chainParam) || DEFAULT_READ_CHAIN,
		};
	}

	return null;
}

// ── Aggregate stats from attestations ────────────────────────────────────────

function computeStats(attestations) {
	const scored = attestations.filter((a) => {
		const s = a.decoded?.score;
		return s !== undefined && s !== null && Number.isFinite(Number(s));
	});
	if (!scored.length) return { count: 0, average: 0, avgStars: 0, scoreMap: {} };

	let total = 0;
	const scoreMap = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	for (const a of scored) {
		const raw = Number(a.decoded.score);
		total += raw;
		const stars = scoreToStars(raw);
		scoreMap[stars] = (scoreMap[stars] || 0) + 1;
	}
	const average = total / scored.length;
	return { count: scored.length, average, avgStars: scoreToStars(average), scoreMap };
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderStatBar(scoreMap, total) {
	if (!total) return '';
	return [5, 4, 3, 2, 1].map((n) => {
		const count = scoreMap[n] || 0;
		const pct = total ? Math.round((count / total) * 100) : 0;
		return `
			<div class="rep-dist-row">
				${starsHtml(n, 11)}
				<div class="rep-dist-bar-wrap">
					<div class="rep-dist-bar-fill" style="width:${pct}%"></div>
				</div>
				<span class="rep-dist-num">${count}</span>
			</div>`;
	}).join('');
}

function renderReviewCard(a, chainId) {
	const chain = EAS_CHAINS[chainId] || {};
	const score = a.decoded?.score;
	const comment = a.decoded?.comment;
	const stars = (score !== undefined && score !== null) ? scoreToStars(Number(score)) : null;
	const ts = relativeTime(a.time);
	const txUrl = a.txid ? `${chain.explorer}/tx/${a.txid}` : null;
	const uidUrl = a.uid ? `${chain.easscan}/attestation/view/${a.uid}` : null;

	return `
		<div class="rep-review-card">
			<div class="rep-review-top">
				<div class="rep-reviewer-row">
					${identiconHtml(a.attester)}
					<span class="rep-reviewer-addr" title="${esc(a.attester)}">${esc(shortAddr(a.attester))}</span>
				</div>
				<div class="rep-review-meta-right">
					${stars !== null ? starsHtml(stars, 13) : ''}
					${score !== null && score !== undefined ? `<span class="rep-score-badge">${Number(score) > 5 ? Math.round(Number(score)) + '/100' : stars + '/5'}</span>` : ''}
				</div>
			</div>
			${comment ? `<p class="rep-review-comment">${esc(String(comment))}</p>` : ''}
			<div class="rep-review-footer">
				<span class="rep-review-time">${esc(ts)}</span>
				<div class="rep-review-links">
					${txUrl ? `<a href="${esc(txUrl)}" target="_blank" rel="noopener">tx ↗</a>` : ''}
					${uidUrl ? `<a href="${esc(uidUrl)}" target="_blank" rel="noopener">attestation ↗</a>` : ''}
				</div>
			</div>
		</div>`;
}

function renderEmpty(msg) {
	return `<div class="rep-empty-state">
		<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
		<p>${esc(msg)}</p>
	</div>`;
}

// ── Submit form ───────────────────────────────────────────────────────────────

function mountSubmitForm(container, { recipientAddress, chainId }) {
	const writeChain = EAS_CHAINS[DEFAULT_WRITE_CHAIN];

	container.innerHTML = `
		<div class="rep-submit-card">
			<div class="rep-submit-header">
				<div>
					<h3 class="rep-submit-title">Write a review</h3>
					<p class="rep-submit-sub">Signed on-chain · permanently public · ${esc(writeChain.name)}</p>
				</div>
			</div>

			<div id="rep-wallet-area">
				<button class="rep-connect-btn" id="rep-connect-btn">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
					Connect wallet to review
				</button>
			</div>

			<div id="rep-form-area" style="display:none">
				<div id="rep-wallet-info" class="rep-wallet-info"></div>

				<div class="rep-form-section">
					<label class="rep-form-label">Your rating</label>
					<div class="rep-star-picker" id="rep-star-picker" role="radiogroup" aria-label="Star rating">
						${[5,4,3,2,1].map((n) => {
							const labels = ['Terrible', 'Poor', 'Okay', 'Good', 'Excellent'];
							return `<button class="rep-star-btn" data-stars="${n}" data-score="${n * 20}" role="radio" aria-checked="false" type="button">
								<span class="rep-star-btn-stars">${starsHtml(n, 18)}</span>
								<span class="rep-star-btn-label">${labels[n - 1]}</span>
							</button>`;
						}).join('')}
					</div>
				</div>

				<div class="rep-form-section">
					<label class="rep-form-label" for="rep-comment-input">Comment <span class="rep-optional">(optional)</span></label>
					<textarea id="rep-comment-input" class="rep-textarea" rows="3" placeholder="Describe your experience with this agent…" maxlength="280"></textarea>
					<div class="rep-char-count"><span id="rep-char-num">0</span>/280</div>
				</div>

				<div id="rep-submit-status" style="display:none"></div>

				<button class="rep-submit-btn-primary" id="rep-submit-btn" disabled type="button">
					Sign &amp; submit review
				</button>
				<p class="rep-submit-note">
					Requires ~0.001 ${esc(writeChain.name)} ETH for gas.
					${writeChain.name === 'Base Sepolia' ? `Get free testnet ETH at <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noopener">Alchemy faucet</a>.` : ''}
				</p>
			</div>
		</div>
	`;

	const connectBtn = container.querySelector('#rep-connect-btn');
	const walletArea = container.querySelector('#rep-wallet-area');
	const formArea = container.querySelector('#rep-form-area');
	const walletInfo = container.querySelector('#rep-wallet-info');
	const starPicker = container.querySelector('#rep-star-picker');
	const commentInput = container.querySelector('#rep-comment-input');
	const charNum = container.querySelector('#rep-char-num');
	const submitBtn = container.querySelector('#rep-submit-btn');
	const statusEl = container.querySelector('#rep-submit-status');

	let selectedScore = null;
	let connectedAddress = null;

	commentInput.addEventListener('input', () => {
		charNum.textContent = commentInput.value.length;
	});

	starPicker.addEventListener('click', (e) => {
		const btn = e.target.closest('.rep-star-btn');
		if (!btn) return;
		starPicker.querySelectorAll('.rep-star-btn').forEach((b) => {
			b.classList.remove('selected');
			b.setAttribute('aria-checked', 'false');
		});
		btn.classList.add('selected');
		btn.setAttribute('aria-checked', 'true');
		selectedScore = Number(btn.dataset.score);
		submitBtn.disabled = false;
	});

	connectBtn.addEventListener('click', async () => {
		if (!window.ethereum) {
			showStatus('No wallet found. Install MetaMask or a compatible wallet.', 'error');
			return;
		}
		try {
			connectBtn.disabled = true;
			connectBtn.textContent = 'Connecting…';
			const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
			connectedAddress = accounts[0];
			walletArea.innerHTML = '';
			walletInfo.innerHTML = `
				<div class="rep-connected-badge">
					${identiconHtml(connectedAddress, 22)}
					<span>${esc(shortAddr(connectedAddress))}</span>
					<span class="rep-chain-tag">${esc(writeChain.name)}</span>
				</div>`;
			formArea.style.display = '';
		} catch (err) {
			connectBtn.disabled = false;
			connectBtn.textContent = 'Connect wallet to review';
			showStatus(`Wallet error: ${err.message || 'Unknown error'}`, 'error');
		}
	});

	submitBtn.addEventListener('click', async () => {
		if (!connectedAddress || selectedScore === null) return;

		submitBtn.disabled = true;
		submitBtn.textContent = 'Signing…';
		showStatus('Preparing transaction…', 'info');

		try {
			const provider = new BrowserProvider(window.ethereum);
			const network = await provider.getNetwork();
			if (Number(network.chainId) !== DEFAULT_WRITE_CHAIN) {
				showStatus(`Switching to ${writeChain.name}…`, 'info');
				await window.ethereum.request({
					method: 'wallet_switchEthereumChain',
					params: [{ chainId: writeChain.hexId }],
				}).catch(async (err) => {
					if (err.code === 4902) {
						await window.ethereum.request({
							method: 'wallet_addEthereumChain',
							params: [{
								chainId: writeChain.hexId,
								chainName: writeChain.name,
								nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
								rpcUrls: [writeChain.rpcUrl],
								blockExplorerUrls: [writeChain.explorer],
							}],
						});
					} else throw err;
				});
			}

			const freshProvider = new BrowserProvider(window.ethereum);
			const signer = await freshProvider.getSigner();

			showStatus('Awaiting wallet signature…', 'info');

			const easInstance = new EAS(writeChain.contract);
			easInstance.connect(signer);

			const encoder = new SchemaEncoder(SCHEMA_STRING);
			const recipient = getAddress(recipientAddress);
			const encodedData = encoder.encodeData([
				{ name: 'agent',   value: recipient,        type: 'address' },
				{ name: 'score',   value: selectedScore,    type: 'uint8'   },
				{ name: 'comment', value: commentInput.value.trim(), type: 'string' },
			]);

			if (!EAS_CHAINS[DEFAULT_WRITE_CHAIN].schemaUid) {
				throw new Error('Schema not registered on this chain. Visit EASScan to register the schema first.');
			}

			const tx = await easInstance.attest({
				schema: EAS_CHAINS[DEFAULT_WRITE_CHAIN].schemaUid,
				data: {
					recipient,
					expirationTime: 0n,
					revocable: true,
					data: encodedData,
				},
			});

			showStatus('Transaction submitted. Waiting for confirmation…', 'info');
			const txHash = tx.tx?.hash || tx.hash;
			const newUid = await tx.wait();

			formArea.innerHTML = `
				<div class="rep-success-card">
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22d17a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
					<div>
						<strong>Review submitted</strong>
						<div class="rep-success-links">
							<a href="${esc(writeChain.explorer)}/tx/${esc(txHash)}" target="_blank" rel="noopener">View transaction ↗</a>
							<a href="${esc(writeChain.easscan)}/attestation/view/${esc(newUid)}" target="_blank" rel="noopener">View attestation ↗</a>
						</div>
					</div>
				</div>`;
			return;
		} catch (err) {
			if (err.code === 4001 || /user rejected|user denied/i.test(err.message || '')) {
				showStatus('Cancelled by user.', 'info');
			} else {
				showStatus(`Failed: ${err.shortMessage || err.reason || err.message || 'Unknown error'}`, 'error');
			}
			submitBtn.disabled = false;
			submitBtn.textContent = 'Sign & submit review';
		}
	});

	function showStatus(msg, type) {
		statusEl.style.display = '';
		statusEl.className = `rep-form-status rep-form-status--${type}`;
		statusEl.textContent = msg;
	}
}

// ── Search / lookup form ──────────────────────────────────────────────────────

function showSearchForm(appEl) {
	appEl.innerHTML = `
		<div class="rep-search-wrap">
			<div class="rep-search-hero">
				<div class="rep-search-glow" aria-hidden="true"></div>
				<h1 class="rep-search-title">Agent Reputation</h1>
				<p class="rep-search-sub">Search on-chain reviews for any AI agent or Ethereum address.</p>

				<form class="rep-search-form" id="rep-search-form" autocomplete="off" novalidate>
					<div class="rep-search-input-wrap">
						<svg class="rep-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
						<input
							class="rep-search-input"
							id="rep-search-input"
							type="text"
							placeholder="0x address or ENS name (vitalik.eth)…"
							spellcheck="false"
							autocorrect="off"
							autocapitalize="none"
						/>
					</div>
					<div class="rep-search-chain-row">
						<label class="rep-chain-label" for="rep-chain-select">Network</label>
						<select class="rep-chain-select" id="rep-chain-select">
							<option value="8453" selected>Base (mainnet)</option>
							<option value="84532">Base Sepolia (testnet)</option>
							<option value="1">Ethereum</option>
							<option value="10">Optimism</option>
							<option value="42161">Arbitrum</option>
							<option value="137">Polygon</option>
						</select>
					</div>
					<button class="rep-search-btn" type="submit">Look up</button>
				</form>

				<div class="rep-search-examples">
					<span class="rep-examples-label">Try:</span>
					<button class="rep-example-chip" data-addr="vitalik.eth">vitalik.eth</button>
					<button class="rep-example-chip" data-addr="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045">Vitalik (0x…)</button>
				</div>
			</div>

			<div class="rep-info-cards">
				<div class="rep-info-card">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
					<div>
						<strong>On-chain reviews</strong>
						<p>Attestations are signed transactions — permanent, public, and tamper-proof.</p>
					</div>
				</div>
				<div class="rep-info-card">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3dc1ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
					<div>
						<strong>Any address</strong>
						<p>Search any Ethereum address or ENS name — no registration required.</p>
					</div>
				</div>
				<div class="rep-info-card">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22d17a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
					<div>
						<strong>EAS-powered</strong>
						<p>Built on Ethereum Attestation Service — the open standard for on-chain trust.</p>
					</div>
				</div>
			</div>
		</div>
	`;

	const form = appEl.querySelector('#rep-search-form');
	const input = appEl.querySelector('#rep-search-input');
	const chainSelect = appEl.querySelector('#rep-chain-select');

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const val = input.value.trim();
		if (!val) { input.focus(); return; }
		const chain = chainSelect.value;
		window.location.search = `?address=${encodeURIComponent(val)}&chain=${chain}`;
	});

	appEl.querySelectorAll('.rep-example-chip').forEach((chip) => {
		chip.addEventListener('click', () => {
			input.value = chip.dataset.addr;
			input.focus();
		});
	});
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function showSkeleton(appEl, address) {
	appEl.innerHTML = `
		<div class="rep-loading-header">
			<div class="rep-skel rep-skel-lg"></div>
			<div class="rep-skel rep-skel-sm"></div>
		</div>
		<div class="rep-skel-stats">
			${[1,2,3].map(() => `<div class="rep-skel-stat"><div class="rep-skel rep-skel-val"></div><div class="rep-skel rep-skel-lbl"></div></div>`).join('')}
		</div>
		<div class="rep-skel-cards">
			${[1,2,3].map(() => `<div class="rep-skel-card"><div class="rep-skel-card-top"><div class="rep-skel rep-skel-avatar"></div><div class="rep-skel rep-skel-name"></div></div><div class="rep-skel rep-skel-body"></div></div>`).join('')}
		</div>
	`;
}

// ── Main profile render ───────────────────────────────────────────────────────

async function renderProfile(appEl, { address, chainId }) {
	const chain = EAS_CHAINS[chainId];
	if (!chain) {
		appEl.innerHTML = `<div class="rep-error-card"><strong>Unsupported network</strong><p>EAS is not available on chain ${chainId}. Try Base (8453), Ethereum (1), or Optimism (10).</p></div>`;
		return;
	}

	showSkeleton(appEl);

	// Resolve ENS if needed
	let resolvedAddress = address;
	let displayName = address;
	let isEns = false;

	if (!isAddress(address)) {
		if (!address.includes('.')) {
			appEl.innerHTML = `<div class="rep-error-card"><strong>Invalid address</strong><p>"${esc(address)}" is not a valid Ethereum address or ENS name.</p><a href="/reputation" class="rep-back-link">← Search again</a></div>`;
			return;
		}
		isEns = true;
		displayName = address;
		try {
			const resolved = await resolveENS(address);
			if (!resolved) {
				appEl.innerHTML = `<div class="rep-error-card"><strong>ENS not found</strong><p>Could not resolve "${esc(address)}" to an Ethereum address.</p><a href="/reputation" class="rep-back-link">← Search again</a></div>`;
				return;
			}
			resolvedAddress = resolved;
		} catch (err) {
			appEl.innerHTML = `<div class="rep-error-card"><strong>ENS resolution failed</strong><p>${esc(err.message)}</p><a href="/reputation" class="rep-back-link">← Search again</a></div>`;
			return;
		}
	}

	resolvedAddress = getAddress(resolvedAddress);

	// Parallel fetch: EAS attestations + ERC-8004 agent lookup
	const [attestations, agentId] = await Promise.all([
		fetchAttestations(resolvedAddress, chainId).catch(() => []),
		findAgentIdForAddress(resolvedAddress, chainId).catch(() => null),
	]);

	// ERC-8004 reputation (if agent is registered)
	let erc8004Rep = null;
	if (agentId !== null) {
		erc8004Rep = await fetchErc8004Reputation(agentId, chainId).catch(() => null);
	}

	const stats = computeStats(attestations);
	const hasScores = stats.count > 0;

	// Share URL
	const shareUrl = `${window.location.origin}/reputation?address=${encodeURIComponent(resolvedAddress)}&chain=${chainId}`;
	const tweetText = encodeURIComponent(
		`On-chain reputation for ${displayName} on @trythreews — ${stats.count} review${stats.count !== 1 ? 's' : ''}${hasScores ? `, avg ${stats.avgStars}/5 stars` : ''}\n${shareUrl}`
	);
	const tweetUrl = `https://x.com/intent/tweet?text=${tweetText}`;

	// Choose color for score bar
	const barColor = hasScores ? scoreColor(stats.average) : 'rgba(255,255,255,0.1)';
	const barWidth = hasScores ? Math.min(100, stats.average > 5 ? stats.average : stats.average * 20) : 0;

	// Filter tabs
	const all = attestations;
	const withComment = attestations.filter((a) => a.decoded?.comment);

	appEl.innerHTML = `
		<div class="rep-profile">
			<div class="rep-profile-header">
				<div class="rep-profile-identity">
					${identiconHtml(resolvedAddress, 48)}
					<div>
						${isEns ? `<div class="rep-ens-name">${esc(displayName)}</div>` : ''}
						<div class="rep-address-display">
							<code class="rep-address-code">${esc(resolvedAddress)}</code>
							<button class="rep-copy-addr" data-copy="${esc(resolvedAddress)}" title="Copy address" type="button">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
							</button>
						</div>
						<div class="rep-profile-meta">
							${agentId !== null ? `<span class="rep-agent-tag">ERC-8004 Agent #${agentId}</span>` : ''}
							<a class="rep-explorer-link" href="${esc(chain.explorer)}/address/${esc(resolvedAddress)}" target="_blank" rel="noopener">${esc(chain.name)} ↗</a>
						</div>
					</div>
				</div>
				<div class="rep-profile-actions">
					<a href="${esc(tweetUrl)}" class="rep-action-btn" target="_blank" rel="noopener">
						<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
						Share
					</a>
					<button class="rep-action-btn" id="rep-copy-link" type="button">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="3" r="1.5"/><circle cx="12" cy="13" r="1.5"/><circle cx="3" cy="8" r="1.5"/><line x1="10.6" y1="3.9" x2="4.4" y2="7.1"/><line x1="10.6" y1="12.1" x2="4.4" y2="8.9"/></svg>
						Copy link
					</button>
					<a href="/reputation" class="rep-action-btn">← Search</a>
				</div>
			</div>

			<div class="rep-stats-grid">
				<div class="rep-stat-card">
					<div class="rep-stat-label">Avg Rating</div>
					<div class="rep-stat-value">${hasScores ? stats.avgStars : '—'}<span class="rep-stat-denom">${hasScores ? ' / 5' : ''}</span></div>
					<div class="rep-stars-display">${hasScores ? starsHtml(stats.avgStars, 16) : '<span class="rep-no-data">No reviews yet</span>'}</div>
				</div>
				<div class="rep-stat-card">
					<div class="rep-stat-label">Total Reviews</div>
					<div class="rep-stat-value">${attestations.length}</div>
					<div class="rep-stat-sub">${stats.count} scored · ${withComment.length} with comments</div>
				</div>
				<div class="rep-stat-card">
					<div class="rep-stat-label">Score Distribution</div>
					<div class="rep-dist-mini">
						${hasScores ? renderStatBar(stats.scoreMap, stats.count) : '<span class="rep-no-data">—</span>'}
					</div>
				</div>
			</div>

			${erc8004Rep && erc8004Rep.count > 0 ? `
				<div class="rep-erc8004-badge">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
					ERC-8004 registry: ${erc8004Rep.count} vote${erc8004Rep.count !== 1 ? 's' : ''} · avg ${erc8004Rep.average.toFixed(1)}/100
					<a href="/reputation?agent=${chainId}:${agentId}" class="rep-erc8004-link">View ERC-8004 ↗</a>
				</div>
			` : ''}

			<div class="rep-reviews-section">
				<div class="rep-tabs" role="tablist">
					<button class="rep-tab active" data-filter="all" role="tab" aria-selected="true">
						All <span class="rep-tab-badge">${all.length}</span>
					</button>
					<button class="rep-tab" data-filter="scored" role="tab" aria-selected="false">
						Scored <span class="rep-tab-badge">${stats.count}</span>
					</button>
					<button class="rep-tab" data-filter="commented" role="tab" aria-selected="false">
						With comments <span class="rep-tab-badge">${withComment.length}</span>
					</button>
				</div>
				<div id="rep-review-list" class="rep-review-list">
					${attestations.length === 0
						? renderEmpty('No attestations found for this address on ' + chain.name + '. Be the first to review!')
						: all.slice(0, 30).map((a) => renderReviewCard(a, chainId)).join('')}
				</div>
			</div>

			<div id="rep-submit-section"></div>
		</div>
	`;

	// Wire filter tabs
	const filterData = { all, scored: attestations.filter((a) => a.decoded?.score !== undefined), commented: withComment };
	appEl.querySelectorAll('.rep-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			appEl.querySelectorAll('.rep-tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
			tab.classList.add('active');
			tab.setAttribute('aria-selected', 'true');
			const list = filterData[tab.dataset.filter] || [];
			document.getElementById('rep-review-list').innerHTML = list.length
				? list.slice(0, 30).map((a) => renderReviewCard(a, chainId)).join('')
				: renderEmpty('No reviews in this category.');
		});
	});

	// Copy link
	appEl.querySelector('#rep-copy-link')?.addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		try { await navigator.clipboard.writeText(shareUrl); } catch { /* fallback not needed */ }
		btn.textContent = 'Copied!';
		setTimeout(() => { btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="3" r="1.5"/><circle cx="12" cy="13" r="1.5"/><circle cx="3" cy="8" r="1.5"/><line x1="10.6" y1="3.9" x2="4.4" y2="7.1"/><line x1="10.6" y1="12.1" x2="4.4" y2="8.9"/></svg> Copy link`; }, 2000);
	});

	// Copy address
	appEl.querySelector('.rep-copy-addr')?.addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		try { await navigator.clipboard.writeText(resolvedAddress); } catch { /* */ }
		btn.title = 'Copied!';
		setTimeout(() => { btn.title = 'Copy address'; }, 2000);
	});

	// Mount submit form
	mountSubmitForm(appEl.querySelector('#rep-submit-section'), { recipientAddress: resolvedAddress, chainId });
}

// ── Legacy ERC-8004 agent route ───────────────────────────────────────────────

async function renderLegacyAgent(appEl, { chainId, agentId }) {
	const meta = CHAIN_META[chainId];
	const deployment = REGISTRY_DEPLOYMENTS[chainId];

	if (!meta?.rpcUrl || !deployment?.identityRegistry) {
		appEl.innerHTML = `<div class="rep-error-card"><strong>Network not supported</strong><p>ERC-8004 is not deployed on chain ${chainId}.</p><a href="/reputation" class="rep-back-link">← Search</a></div>`;
		return;
	}

	showSkeleton(appEl);

	try {
		const provider = new JsonRpcProvider(meta.rpcUrl, chainId, { staticNetwork: true });
		const registry = new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
		let ownerAddress = null;
		try {
			ownerAddress = await registry.ownerOf(agentId);
		} catch { /* agent may not exist */ }

		if (ownerAddress) {
			window.location.replace(`/reputation?address=${encodeURIComponent(ownerAddress)}&chain=${chainId}`);
		} else {
			appEl.innerHTML = `<div class="rep-error-card"><strong>Agent #${agentId} not found</strong><p>This agent ID does not exist on ${meta.name}.</p><a href="/reputation" class="rep-back-link">← Search</a></div>`;
		}
	} catch (err) {
		appEl.innerHTML = `<div class="rep-error-card"><strong>Load failed</strong><p>${esc(err.message)}</p><a href="/reputation" class="rep-back-link">← Search</a></div>`;
	}
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
	const appEl = document.getElementById('app');
	if (!appEl) return;

	try {
		const parsed = parseUrl();

		if (!parsed) {
			showSearchForm(appEl);
			return;
		}

		if (parsed.mode === 'agent') {
			await renderLegacyAgent(appEl, parsed);
			return;
		}

		if (parsed.mode === 'address') {
			await renderProfile(appEl, { address: parsed.address, chainId: parsed.chainId });
			return;
		}
	} catch (err) {
		console.error('[reputation] fatal:', err);
		document.getElementById('app').innerHTML = `
			<div class="rep-error-card">
				<strong>Something went wrong</strong>
				<p>${esc(err.message || 'Unknown error')}</p>
				<a href="/reputation" class="rep-back-link">← Try again</a>
			</div>`;
	}
}

main();
