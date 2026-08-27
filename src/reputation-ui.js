/**
 * ReputationDashboard — UI controller for on-chain agent reviews.
 *
 * Fetches reputation data (aggregated stats + recent reviews) from the ERC-8004
 * Reputation Registry, renders them into a container, and handles wallet-gated
 * review submissions with optimistic updates.
 */

import { getEvmProvider } from './shared/evm-rpc-fallback.js';
import { getReputation, getRecentReviews, submitReputation, getTotalStake } from './erc8004/reputation.js';
import { ensureWallet } from './erc8004/agent-registry.js';
import { REGISTRY_DEPLOYMENTS } from './erc8004/abi.js';
import { log } from './shared/log.js';

const CHAIN_NAMES = {
	1: 'Ethereum',
	10: 'Optimism',
	56: 'BSC',
	100: 'Gnosis',
	137: 'Polygon',
	250: 'Fantom',
	324: 'zkSync Era',
	1284: 'Moonbeam',
	5000: 'Mantle',
	8453: 'Base',
	42161: 'Arbitrum One',
	42220: 'Celo',
	43114: 'Avalanche',
	59144: 'Linea',
	534352: 'Scroll',
	97: 'BSC Testnet',
	11155111: 'Ethereum Sepolia',
	84532: 'Base Sepolia',
	421614: 'Arbitrum Sepolia',
	11155420: 'Optimism Sepolia',
	80002: 'Polygon Amoy',
	43113: 'Avalanche Fuji',
};

function getExplorerUrl(chainId, txHash) {
	const base = {
		1: 'https://etherscan.io',
		10: 'https://optimistic.etherscan.io',
		56: 'https://bscscan.com',
		100: 'https://gnosisscan.io',
		137: 'https://polygonscan.com',
		250: 'https://ftmscan.com',
		324: 'https://explorer.zksync.io',
		1284: 'https://moonscan.io',
		5000: 'https://explorer.mantle.xyz',
		8453: 'https://basescan.org',
		42161: 'https://arbiscan.io',
		42220: 'https://celoscan.io',
		43114: 'https://snowtrace.io',
		59144: 'https://lineascan.build',
		534352: 'https://scrollscan.com',
		97: 'https://testnet.bscscan.com',
		11155111: 'https://sepolia.etherscan.io',
		84532: 'https://sepolia.basescan.org',
		421614: 'https://sepolia.arbiscan.io',
		11155420: 'https://sepolia-optimism.etherscan.io',
		80002: 'https://amoy.polygonscan.com',
		43113: 'https://testnet.snowtrace.io',
	}[chainId];

	if (!base) return null;
	return `${base}/tx/${txHash}`;
}

export class ReputationDashboard {
	constructor(container, { agentId, chainId = 84532 }) {
		this.container = container;
		this.agentId = agentId;
		this.chainId = chainId;
		this.reviews = [];
		this.reputation = { total: 0, count: 0, average: 0 };
		this.totalStakeWei = 0n;
		this.stakerEvents = [];
		this.connectedAddress = null;
		this.reviewListeners = [];
		this.pollInterval = null;
		this.lastTxHash = null;
	}

	/**
	 * Load reputation data and render.
	 */
	async load() {
		try {
			await this._fetchReputation();
			this._render();
		} catch (err) {
			log.error('[ReputationDashboard] load failed:', err);
			this._renderError(err);
		}
	}

	/**
	 * Fetch getReputation + getRecentReviews using ethers.js provider.
	 */
	async _fetchReputation() {
		if (!REGISTRY_DEPLOYMENTS[this.chainId]) {
			throw new Error(`Chain ${this.chainId} is not supported.`);
		}

		// Same-origin /api/evm-rpc proxy first, then the chain's public hosts.
		const provider = await getEvmProvider(this.chainId);

		const [reputation, reviews, totalStakeWei] = await Promise.all([
			getReputation({ agentId: this.agentId, runner: provider, chainId: this.chainId }),
			getRecentReviews({ agentId: this.agentId, runner: provider, chainId: this.chainId, fromBlock: 0 }),
			getTotalStake({ agentId: this.agentId, runner: provider, chainId: this.chainId }).catch(() => 0n),
		]);

		this.reputation = reputation;
		this.reviews = reviews.sort((a, b) => b.blockNumber - a.blockNumber);
		this.totalStakeWei = totalStakeWei;

		// Fetch staker events for leaderboard (last 1000 blocks to avoid timeout).
		if (totalStakeWei > 0n) {
			try {
				const { REGISTRY_DEPLOYMENTS: deps, REPUTATION_REGISTRY_ABI } = await import('./erc8004/abi.js');
				const { Contract } = await import('ethers');
				const contract = new Contract(deps[this.chainId].reputationRegistry, REPUTATION_REGISTRY_ABI, provider);
				const head = await provider.getBlockNumber();
				const fromBlock = Math.max(0, head - 1000);
				const events = await contract.queryFilter(contract.filters.ReputationStaked(this.agentId), fromBlock, 'latest');
				this.stakerEvents = events.map((ev) => ({
					staker: ev.args.staker,
					score: Number(ev.args.score),
					value: ev.args.value,
				}));
			} catch {
				this.stakerEvents = [];
			}
		}
	}

	/**
	 * Submit a reputation review.
	 */
	async submit({ rating, comment }) {
		if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
			throw new Error('Rating must be 1-5.');
		}

		try {
			const walletInfo = await ensureWallet();
			this.connectedAddress = walletInfo.address;

			const txHash = await submitReputation({
				agentId: this.agentId,
				score: rating,
				comment,
				signer: walletInfo.signer,
				chainId: this.chainId,
			});

			this.lastTxHash = txHash;

			// Optimistically add review to list (marked as pending).
			const optimisticReview = {
				agentId: this.agentId,
				from: this.connectedAddress,
				score: rating,
				comment,
				blockNumber: -1, // Pending marker
				txHash,
				pending: true,
			};
			this.reviews.unshift(optimisticReview);

			// Notify listeners
			this.reviewListeners.forEach((fn) => fn(optimisticReview));

			// Start polling to replace pending with confirmed
			this._startPolling();

			return txHash;
		} catch (err) {
			if (err.code === 'ACTION_REJECTED' || err.message.includes('user rejected')) {
				throw new Error('Transaction rejected.');
			}
			throw err;
		}
	}

	_startPolling() {
		if (this.pollInterval) return;
		this.pollInterval = setInterval(() => this._pollForConfirmation(), 5000);
		setTimeout(() => this._stopPolling(), 120000); // Stop after 2 minutes
	}

	_stopPolling() {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	async _pollForConfirmation() {
		try {
			const provider = await getEvmProvider(this.chainId);

			const receipt = await provider.getTransactionReceipt(this.lastTxHash);
			if (receipt) {
				// Transaction confirmed; reload reviews.
				this._clearPollNote();
				await this._fetchReputation();
				this._render();
				this._stopPolling();
			}
		} catch (err) {
			log.warn('[ReputationDashboard] poll failed:', err.message);
			this._showPollNote();
		}
	}

	// A failed confirmation poll used to vanish into the console, leaving the
	// optimistic "pending" review looking stuck forever. Say so on the page.
	_showPollNote() {
		if (!this.container) return;
		let note = this.container.querySelector('.rep-poll-note');
		if (!note) {
			note = document.createElement('p');
			note.className = 'rep-poll-note';
			note.setAttribute('role', 'status');
			this.container.prepend(note);
		}
		note.textContent = 'Could not confirm your review on-chain; refresh to check.';
	}

	_clearPollNote() {
		this.container?.querySelector('.rep-poll-note')?.remove();
	}

	onReviewAdded(fn) {
		this.reviewListeners.push(fn);
	}

	_render() {
		this.container.innerHTML = '';
		this.container.appendChild(this._createHeader());
		this.container.appendChild(this._createStatsRow());
		this.container.appendChild(this._createReviewList());
		if (this.totalStakeWei > 0n) this.container.appendChild(this._createTopStakers());
		this.container.appendChild(this._createSubmitForm());
	}

	_renderError(err) {
		const errorMsg = err.message || String(err);
		this.container.innerHTML = `
			<div class="rep-error">
				<h3>Unable to load reputation</h3>
				<p>${this._escapeHtml(errorMsg)}</p>
				<button data-action="reload">Retry</button>
			</div>
		`;
	}

	_createHeader() {
		const div = document.createElement('div');
		div.className = 'rep-header';

		const chainName = CHAIN_NAMES[this.chainId] || `Chain ${this.chainId}`;
		const agentDisplay = `${chainName} • Agent #${this.agentId}`;

		div.innerHTML = `
			<div class="rep-header-content">
				<h1>Agent Reputation</h1>
				<p class="rep-header-meta">${agentDisplay}</p>
			</div>
		`;

		return div;
	}

	_createStatsRow() {
		const div = document.createElement('div');
		div.className = 'rep-stats';

		const lastReviewTime = this._getLastReviewTime();

		const stakeEth = (Number(this.totalStakeWei) / 1e18).toFixed(4);
		const chainName = CHAIN_NAMES[this.chainId] || `Chain ${this.chainId}`;
		div.innerHTML = `
			<div class="rep-stat">
				<span class="rep-stat-label">Reviews</span>
				<span class="rep-stat-value">${this.reputation.count}</span>
			</div>
			<div class="rep-stat">
				<span class="rep-stat-label">Rating</span>
				<span class="rep-stat-value">${this.reputation.average.toFixed(1)}</span>
			</div>
			<div class="rep-stat">
				<span class="rep-stat-label">Total Staked</span>
				<span class="rep-stat-value">${stakeEth} ETH</span>
				<span class="rep-stat-chain">${chainName}</span>
			</div>
			<div class="rep-stat">
				<span class="rep-stat-label">Last Review</span>
				<span class="rep-stat-value">${lastReviewTime}</span>
			</div>
		`;

		return div;
	}

	_getLastReviewTime() {
		if (this.reviews.length === 0) return '—';
		const blockNum = this.reviews[0].blockNumber;
		if (blockNum < 0) return 'Just now';
		// Approximate: 12s per block
		const secondsAgo = Math.round(Date.now() / 1000) - Math.round(blockNum * 12);
		return this._formatTimeAgo(secondsAgo);
	}

	_formatTimeAgo(seconds) {
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86400)}d ago`;
	}

	_createReviewList() {
		const div = document.createElement('div');
		div.className = 'rep-reviews';

		if (this.reviews.length === 0) {
			div.innerHTML = '<p class="rep-empty">No reviews yet. Be the first!</p>';
			return div;
		}

		const title = document.createElement('h3');
		title.textContent = 'Reviews';
		div.appendChild(title);

		const list = document.createElement('div');
		list.className = 'rep-review-list';

		this.reviews.slice(0, 10).forEach((review) => {
			list.appendChild(this._createReviewItem(review));
		});

		div.appendChild(list);

		if (this.reviews.length > 10) {
			const more = document.createElement('p');
			more.className = 'rep-more-reviews';
			more.textContent = `+${this.reviews.length - 10} more reviews`;
			div.appendChild(more);
		}

		return div;
	}

	_createReviewItem(review) {
		const div = document.createElement('div');
		div.className = `rep-review-item ${review.pending ? 'pending' : ''}`;

		const starHtml = this._renderStars(review.score);
		const explorerUrl = getExplorerUrl(this.chainId, review.txHash);
		const txLink = explorerUrl
			? `<a href="${explorerUrl}" target="_blank" rel="noopener">View tx</a>`
			: `<span class="rep-tx-hash">${review.txHash.slice(0, 10)}…</span>`;

		div.innerHTML = `
			<div class="rep-review-header">
				<span class="rep-reviewer">${this._truncateAddress(review.from)}</span>
				<span class="rep-stars">${starHtml}</span>
			</div>
			${review.comment ? `<p class="rep-comment">${this._escapeHtml(review.comment)}</p>` : ''}
			<div class="rep-review-footer">
				${txLink}
				${review.pending ? '<span class="rep-pending-badge">Pending</span>' : ''}
			</div>
		`;

		return div;
	}

	_renderStars(score) {
		const full = Math.floor(score);
		let html = '';
		for (let i = 0; i < 5; i++) {
			html += i < full ? '★' : '☆';
		}
		return html;
	}

	_truncateAddress(addr) {
		if (!addr) return 'Anonymous';
		return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
	}

	_createTopStakers() {
		const div = document.createElement('div');
		div.className = 'rep-top-stakers';

		const title = document.createElement('h3');
		title.textContent = 'Top Stakers';
		div.appendChild(title);

		if (!this.stakerEvents.length) {
			const empty = document.createElement('p');
			empty.className = 'rep-empty';
			empty.textContent = 'No stakers found in recent blocks.';
			div.appendChild(empty);
			return div;
		}

		const sorted = [...this.stakerEvents]
			.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
			.slice(0, 5);

		const list = document.createElement('div');
		list.className = 'rep-staker-list';
		sorted.forEach((ev) => {
			const row = document.createElement('div');
			row.className = 'rep-staker-row';
			const eth = (Number(ev.value) / 1e18).toFixed(4);
			row.innerHTML = `
				<span class="rep-staker-addr">${this._truncateAddress(ev.staker)}</span>
				<span class="rep-staker-eth">${eth} ETH</span>
				<span class="rep-staker-score">${this._renderStars(ev.score)}</span>
			`;
			list.appendChild(row);
		});
		div.appendChild(list);
		return div;
	}

	_createSubmitForm() {
		const div = document.createElement('div');
		div.className = 'rep-submit-form';

		div.innerHTML = `
			<h3>Leave a Review</h3>
			<form id="rep-form">
				<div class="rep-form-group">
					<label>Rating</label>
					<div class="rep-stars-input">
						${[1, 2, 3, 4, 5]
							.map(
								(n) => `
							<button
								type="button"
								class="rep-star-btn"
								data-rating="${n}"
								title="${n} star${n > 1 ? 's' : ''}"
							>★</button>
						`,
							)
							.join('')}
					</div>
					<input type="hidden" id="rep-rating" name="rating" value="" />
				</div>

				<div class="rep-form-group">
					<label for="rep-comment">Comment (optional)</label>
					<textarea
						id="rep-comment"
						name="comment"
						placeholder="Share your experience…"
						rows="4"
						maxlength="500"
					></textarea>
					<small id="rep-char-count">0/500</small>
				</div>

				<button type="submit" class="rep-submit-btn">Submit Review</button>
				<small class="rep-form-hint">Connect wallet to submit</small>
			</form>
		`;

		const form = div.querySelector('#rep-form');
		const ratingInput = form.querySelector('#rep-rating');
		const commentInput = form.querySelector('#rep-comment');
		const charCount = form.querySelector('#rep-char-count');
		const starBtns = form.querySelectorAll('.rep-star-btn');
		let selectedRating = 0;

		starBtns.forEach((btn) => {
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				selectedRating = Number(btn.dataset.rating);
				ratingInput.value = selectedRating;

				starBtns.forEach((b, i) => {
					b.classList.toggle('selected', i < selectedRating);
				});
			});
		});

		commentInput.addEventListener('input', () => {
			charCount.textContent = `${commentInput.value.length}/500`;
		});

		form.addEventListener('submit', async (e) => {
			e.preventDefault();

			if (!selectedRating) {
				alert('Please select a rating.');
				return;
			}

			const comment = commentInput.value.trim();
			const submitBtn = form.querySelector('button[type="submit"]');
			const originalText = submitBtn.textContent;

			try {
				submitBtn.disabled = true;
				submitBtn.textContent = 'Submitting…';

				await this.submit({ rating: selectedRating, comment });

				commentInput.value = '';
				charCount.textContent = '0/500';
				selectedRating = 0;
				ratingInput.value = '';
				starBtns.forEach((b) => b.classList.remove('selected'));

				submitBtn.textContent = 'Review submitted!';
				setTimeout(() => {
					submitBtn.textContent = originalText;
					submitBtn.disabled = false;
				}, 2000);

				this._render();
			} catch (err) {
				alert(`Error: ${err.message}`);
				submitBtn.textContent = originalText;
				submitBtn.disabled = false;
			}
		});

		return div;
	}

	_escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}
}
