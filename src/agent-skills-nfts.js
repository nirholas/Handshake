/**
 * NFT portfolio & wallet activity skills
 * ----------------------------------------
 * Wraps the Helius DAS API (via /api/agents/nfts) so an agent can:
 *   - nft-portfolio    → list NFTs owned by a wallet address
 *   - wallet-activity  → show recent parsed transactions for a wallet
 *
 * Both skills are read-only and require HELIUS_API_KEY server-side.
 * The agent can display NFT image previews and describe on-chain activity
 * in plain language.
 *
 * Powered by: helius-sdk / Helius DAS API
 * Docs: https://docs.helius.dev/compression-and-das-api/digital-asset-standard-api
 */

// Bounded so a stalled DAS query cannot hang the agent's turn: the skill
// awaits this inline, and without a deadline the chat sits mid-reply forever.
async function fetchJson(url, { timeout = 8000 } = {}) {
	const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(timeout) });
	if (!r.ok) throw new Error(`request failed: ${r.status}`);
	return r.json();
}

function formatNftList(items) {
	if (!items.length) return 'No NFTs found for this wallet.';
	return items
		.slice(0, 10)
		.map((nft, i) => {
			const col = nft.collectionName ? ` [${nft.collectionName}]` : '';
			return `${i + 1}. ${nft.name}${col}`;
		})
		.join('\n');
}

function formatActivity(items) {
	if (!items.length) return 'No recent transactions found.';
	return items
		.slice(0, 8)
		.map((tx) => {
			const time = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleDateString() : '—';
			const desc = tx.description || tx.type || 'transaction';
			return `• ${time}: ${desc}`;
		})
		.join('\n');
}

/**
 * Register NFT portfolio and wallet activity skills onto an AgentSkills instance.
 * @param {import('./agent-skills.js').AgentSkills} skills
 */
export function registerNftSkills(skills) {
	// ── nft-portfolio ────────────────────────────────────────────────────────
	skills.register({
		name: 'nft-portfolio',
		description: 'List NFTs owned by a Solana wallet address using Helius DAS.',
		instruction:
			'Returns the NFT portfolio for a given Solana wallet. Shows names, collections, and image URLs. Useful for displaying what digital assets a user owns.',
		animationHint: 'curiosity',
		voicePattern: 'Looking up NFTs for {{wallet}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				wallet: {
					type: 'string',
					description: 'Solana wallet address (base58) or SNS name (e.g. "satoshi.sol")',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 50,
					default: 20,
					description: 'Max NFTs to return',
				},
			},
			required: ['wallet'],
		},
		handler: async (args) => {
			const wallet = String(args?.wallet || '').trim();
			if (!wallet) return { success: false, output: 'wallet address required', sentiment: -0.2 };
			const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
			try {
				const data = await fetchJson(
					`/api/agents/nfts?op=portfolio&wallet=${encodeURIComponent(wallet)}&limit=${limit}`,
				);
				const items = data.items || [];
				const summary = formatNftList(items);
				const total = data.total ?? items.length;
				return {
					success: true,
					output:
						items.length === 0
							? `No NFTs found for ${wallet.slice(0, 8)}…`
							: `Found ${total} NFT${total !== 1 ? 's' : ''} for ${wallet.slice(0, 8)}…:\n${summary}`,
					sentiment: items.length > 0 ? 0.4 : 0.0,
					data: { wallet, total, items },
				};
			} catch (err) {
				return {
					success: false,
					output: `Could not fetch NFTs: ${err.message}`,
					sentiment: -0.3,
				};
			}
		},
	});

	// ── wallet-activity ──────────────────────────────────────────────────────
	skills.register({
		name: 'wallet-activity',
		description: 'Show recent parsed on-chain transactions for a Solana wallet.',
		instruction:
			'Returns the latest transactions for a wallet in plain English using Helius enhanced transaction parsing. Useful for summarizing recent on-chain activity.',
		animationHint: 'think',
		voicePattern: 'Checking recent activity for {{wallet}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				wallet: {
					type: 'string',
					description: 'Solana wallet address (base58)',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 20,
					default: 10,
					description: 'Max transactions to return',
				},
			},
			required: ['wallet'],
		},
		handler: async (args) => {
			const wallet = String(args?.wallet || '').trim();
			if (!wallet) return { success: false, output: 'wallet address required', sentiment: -0.2 };
			const limit = Math.min(20, Math.max(1, Number(args?.limit) || 10));
			try {
				const data = await fetchJson(
					`/api/agents/nfts?op=activity&wallet=${encodeURIComponent(wallet)}&limit=${limit}`,
				);
				const items = data.items || [];
				const summary = formatActivity(items);
				return {
					success: true,
					output: items.length === 0
						? `No recent transactions found for ${wallet.slice(0, 8)}…`
						: `Recent activity for ${wallet.slice(0, 8)}…:\n${summary}`,
					sentiment: 0.1,
					data: { wallet, items },
				};
			} catch (err) {
				return {
					success: false,
					output: `Could not fetch wallet activity: ${err.message}`,
					sentiment: -0.3,
				};
			}
		},
	});
}
