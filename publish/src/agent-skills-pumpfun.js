/**
 * Pump.fun skills for Solana agents
 * ---------------------------------
 * Wraps the official @pump-fun SDKs so an agent can:
 *   - launch a token (bonding curve)        → pumpfun-create
 *   - launch one auto-derived from identity → pumpfun-launch-from-agent
 *   - trade on the curve                    → pumpfun-buy / pumpfun-sell
 *   - trade on the AMM (post-graduation)    → pumpfun-amm-buy / pumpfun-amm-sell
 *   - read live curve state                 → pumpfun-status
 *   - claim creator fees                    → pumpfun-claim-fees
 *   - accept paid invocations               → pumpfun-accept-payment
 *
 * Wallet: uses the same injected Solana wallet as src/erc8004/solana-deploy.js
 * (Phantom / Backpack / Solflare). All txs are signed by the agent owner;
 * this module never holds keys.
 *
 * SDKs are loaded lazily so non-Solana agents don't pay the import cost.
 */

import { detectSolanaWallet, SOLANA_RPC } from './erc8004/solana-deploy.js';

const DEFAULT_NETWORK = 'mainnet';
const DEFAULT_SLIPPAGE_BPS = 500;

async function loadCore() {
	const [pump, web3, BN, splToken] = await Promise.all([
		import('@pump-fun/pump-sdk'),
		import('@solana/web3.js'),
		import('bn.js').then((m) => m.default || m),
		import('@solana/spl-token').catch(() => null),
	]);
	return { pump, web3, BN, splToken };
}

async function loadAmm() {
	const [amm, web3, BN] = await Promise.all([
		import('@pump-fun/pump-swap-sdk'),
		import('@solana/web3.js'),
		import('bn.js').then((m) => m.default || m),
	]);
	return { amm, web3, BN };
}

async function loadAgentPayments() {
	const [pay, web3] = await Promise.all([
		import('@pump-fun/agent-payments-sdk'),
		import('@solana/web3.js'),
	]);
	return { pay, web3 };
}

function getConnection(web3, network) {
	const url = SOLANA_RPC[network] || SOLANA_RPC[DEFAULT_NETWORK];
	return new web3.Connection(url, 'confirmed');
}

async function requireWallet() {
	const wallet = detectSolanaWallet();
	if (!wallet) throw new Error('No Solana wallet detected. Install Phantom to continue.');
	if (!wallet.isConnected) await wallet.connect();
	const pubkey = wallet.publicKey;
	if (!pubkey) throw new Error('Could not read Solana wallet address.');
	return { wallet, pubkey };
}

async function sendIxs({ web3, connection, wallet, payer, instructions, extraSigners = [] }) {
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
	const tx = new web3.Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
	tx.add(...instructions);
	// Phantom Lighthouse requires the wallet to sign FIRST when there are
	// multiple signers; additional signers must sign afterward.
	const signed = await wallet.signTransaction(tx);
	if (extraSigners.length) signed.partialSign(...extraSigners);
	const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
	await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
	return sig;
}

/**
 * Run the prep → wallet-sign → confirm round-trip against three.ws server-side
 * pump.fun endpoints. The server validates ownership + builds the unsigned tx;
 * the wallet only signs. Useful for clients that want server-enforced policy
 * (rate-limit, agent ownership) without re-implementing pump SDK glue.
 *
 * @param {Object} opts
 * @param {string} opts.prepPath — e.g. '/api/pump/buy-prep'
 * @param {Object} opts.body — request body for the prep endpoint
 * @param {string} [opts.confirmPath] — e.g. '/api/pump/launch-confirm'; if set,
 *                 calls confirm with `{ tx_signature, ...confirmExtra }`
 * @param {Object} [opts.confirmExtra] — additional fields to include in confirm body
 * @param {string} [opts.origin] — defaults to current page origin
 * @returns {Promise<{ signature: string, prep: Object, confirm: Object|null }>}
 */
export async function runServerFlow({
	prepPath,
	body,
	confirmPath,
	confirmExtra = {},
	origin = '',
}) {
	const [{ VersionedTransaction }] = await Promise.all([import('@solana/web3.js')]);
	const { wallet } = await requireWallet();
	const network = body.network || DEFAULT_NETWORK;

	const prepRes = await fetch(`${origin}${prepPath}`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const prep = await prepRes.json();
	if (!prepRes.ok) {
		throw new Error(prep.error_description || prep.error || `prep failed: ${prepRes.status}`);
	}
	if (!prep.tx_base64) throw new Error('prep response missing tx_base64');

	const tx = VersionedTransaction.deserialize(
		Uint8Array.from(atob(prep.tx_base64), (c) => c.charCodeAt(0)),
	);
	const signed = await wallet.signTransaction(tx);

	const { Connection } = await import('@solana/web3.js');
	const url = SOLANA_RPC[network] || SOLANA_RPC[DEFAULT_NETWORK];
	const connection = new Connection(url, 'confirmed');
	const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
	const latest = await connection.getLatestBlockhash();
	await connection.confirmTransaction(
		{
			signature: sig,
			blockhash: latest.blockhash,
			lastValidBlockHeight: latest.lastValidBlockHeight,
		},
		'confirmed',
	);

	let confirmJson = null;
	if (confirmPath) {
		const extra = typeof confirmExtra === 'function' ? confirmExtra(prep) : confirmExtra;
		const confirmRes = await fetch(`${origin}${confirmPath}`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tx_signature: sig, ...extra }),
		});
		confirmJson = await confirmRes.json();
		if (!confirmRes.ok) {
			throw new Error(
				confirmJson.error_description ||
					confirmJson.error ||
					`confirm failed: ${confirmRes.status}`,
			);
		}
	}

	return { signature: sig, prep, confirm: confirmJson };
}

function deriveSymbol(name) {
	return (
		String(name || 'AGENT')
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 10) || 'AGENT'
	);
}

/**
 * Register pump.fun skills onto an AgentSkills instance.
 * @param {import('./agent-skills.js').AgentSkills} skills
 */
export function registerPumpFunSkills(skills) {
	// ── pumpfun-create ────────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-create',
		description:
			'Launch a pump.fun token on Solana. Owner signs. Returns mint address + tx signature.',
		instruction: 'Mint a new pump.fun token using the official @pump-fun/pump-sdk.',
		animationHint: 'celebrate',
		voicePattern: 'Launching {{symbol}} on pump.fun…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				symbol: { type: 'string', description: '≤10 chars' },
				uri: { type: 'string', description: 'Metaplex metadata URI' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
				initialBuySol: { type: 'number', description: 'Optional dev-buy in same tx (SOL)' },
				mintPublicKey: {
					type: 'string',
					description: 'Optional pre-ground vanity mint pubkey',
				},
				mintSecretKeyB64: {
					type: 'string',
					description: 'Base64 64-byte secret key paired with mintPublicKey',
				},
			},
			required: ['symbol', 'uri'],
		},
		handler: async (args, ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const tokenName = args.name || ctx.identity?.name || 'Agent';
			const symbol = deriveSymbol(args.symbol);

			const { pump, web3, BN } = await loadCore();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			let mintKeypair;
			if (args.mintPublicKey && args.mintSecretKeyB64) {
				const bin = atob(args.mintSecretKeyB64);
				const secret = Uint8Array.from(bin, (c) => c.charCodeAt(0));
				mintKeypair = web3.Keypair.fromSecretKey(secret);
			} else {
				mintKeypair = web3.Keypair.generate();
			}
			const offline = new pump.PumpSdk();
			let instructions;

			if (args.initialBuySol && args.initialBuySol > 0) {
				const onlineSdk = new pump.OnlinePumpSdk(connection);
				const global = await onlineSdk.fetchGlobal();
				const solLamports = new BN(Math.floor(args.initialBuySol * web3.LAMPORTS_PER_SOL));
				instructions = await offline.createV2AndBuyInstructions({
					global,
					mint: mintKeypair.publicKey,
					name: tokenName,
					symbol,
					uri: args.uri,
					creator: pubkey,
					user: pubkey,
					amount: new BN(0),
					solAmount: solLamports,
					mayhemMode: false,
				});
			} else {
				instructions = [
					await offline.createV2Instruction({
						mint: mintKeypair.publicKey,
						name: tokenName,
						symbol,
						uri: args.uri,
						creator: pubkey,
						user: pubkey,
						mayhemMode: false,
					}),
				];
			}

			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions,
				extraSigners: [mintKeypair],
			});

			return {
				success: true,
				output: `Launched ${symbol} on pump.fun. Mint: ${mintKeypair.publicKey.toBase58()}`,
				sentiment: 0.9,
				data: {
					mint: mintKeypair.publicKey.toBase58(),
					signature: sig,
					network,
					name: tokenName,
					symbol,
				},
			};
		},
	});

	// ── pumpfun-launch-from-agent ─────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-launch-from-agent',
		description:
			'One-shot: launch a pump.fun token whose metadata is auto-generated from this agent (name, GLB, bio).',
		instruction: 'Resolves the agent metadata URL, then calls pumpfun-create.',
		animationHint: 'celebrate',
		voicePattern: 'Launching myself on pump.fun…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				symbol: { type: 'string' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
				initialBuySol: { type: 'number' },
				mintPublicKey: { type: 'string' },
				mintSecretKeyB64: { type: 'string' },
			},
		},
		handler: async (args, ctx) => {
			const id = ctx.identity?.id;
			if (!id) {
				return {
					success: false,
					output: 'No agent identity. Register the agent first.',
					sentiment: -0.3,
				};
			}
			const origin = (typeof window !== 'undefined' && window.location?.origin) || '';
			const uri = `${origin}/api/agents/pumpfun-metadata?id=${encodeURIComponent(id)}`;
			const symbol = args.symbol || deriveSymbol(ctx.identity?.name);
			return skills.perform(
				'pumpfun-create',
				{
					name: ctx.identity?.name,
					symbol,
					uri,
					network: args.network,
					initialBuySol: args.initialBuySol,
					mintPublicKey: args.mintPublicKey,
					mintSecretKeyB64: args.mintSecretKeyB64,
				},
				ctx,
			);
		},
	});

	// ── pumpfun-buy ───────────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-buy',
		description: 'Buy a pump.fun token with SOL on the bonding curve.',
		instruction: 'Bonding-curve buy. Reverts if the token has graduated — use pumpfun-amm-buy.',
		animationHint: 'gesture',
		voicePattern: 'Buying {{solAmount}} SOL of {{mint}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				solAmount: { type: 'number' },
				slippageBps: { type: 'number' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['mint', 'solAmount'],
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

			if (args.serverFlow) {
				const { pubkey: pk } = await requireWallet();
				const r = await runServerFlow({
					prepPath: '/api/pump/buy-prep',
					body: {
						mint: args.mint,
						network,
						sol: args.solAmount,
						slippage_bps: slippageBps,
						wallet_address: pk.toBase58(),
					},
					confirmPath: '/api/pump/buy-confirm',
					confirmExtra: (prep) => ({
						mint: args.mint,
						network,
						wallet_address: pk.toBase58(),
						sol: args.solAmount,
						slippage_bps: slippageBps,
						route: prep.route,
					}),
				});
				const route = r.prep.route;
				return {
					success: true,
					output: `Bought ~${args.solAmount} SOL of ${args.mint.slice(0, 8)}… via ${route}.`,
					sentiment: 0.6,
					data: {
						signature: r.signature,
						route,
						mint: args.mint,
						network,
						tracked: r.confirm?.tracked,
					},
				};
			}

			const { pump, web3, BN } = await loadCore();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			const mint = new web3.PublicKey(args.mint);
			const onlineSdk = new pump.OnlinePumpSdk(connection);
			const offline = new pump.PumpSdk();

			const global = await onlineSdk.fetchGlobal();
			const state = await onlineSdk.fetchBuyState(mint, pubkey);
			const solLamports = new BN(Math.floor(args.solAmount * web3.LAMPORTS_PER_SOL));
			const expected = pump.getBuyTokenAmountFromSolAmount({
				global,
				feeConfig: null,
				mintSupply: state.bondingCurve.tokenTotalSupply,
				bondingCurve: state.bondingCurve,
				amount: solLamports,
			});

			const buyIxs = await offline.buyInstructions({
				global,
				bondingCurveAccountInfo: state.bondingCurveAccountInfo,
				bondingCurve: state.bondingCurve,
				associatedUserAccountInfo: state.associatedUserAccountInfo,
				mint,
				user: pubkey,
				amount: expected,
				solAmount: solLamports,
				slippage: slippageBps / 10_000,
				tokenProgram:
					web3.TOKEN_PROGRAM_ID || (await import('@solana/spl-token')).TOKEN_PROGRAM_ID,
			});

			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions: buyIxs,
			});
			return {
				success: true,
				output: `Bought ~${expected.toString()} units of ${args.mint.slice(0, 8)}… for ${args.solAmount} SOL.`,
				sentiment: 0.6,
				data: { signature: sig, mint: args.mint, solAmount: args.solAmount, network },
			};
		},
	});

	// ── pumpfun-sell ──────────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-sell',
		description: 'Sell a pump.fun token back to the bonding curve for SOL.',
		instruction: 'Bonding-curve sell. Reverts if graduated — use pumpfun-amm-sell.',
		animationHint: 'gesture',
		voicePattern: 'Selling {{tokenAmount}} of {{mint}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				tokenAmount: { type: 'string', description: 'Base-unit integer string' },
				slippageBps: { type: 'number' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['mint', 'tokenAmount'],
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

			if (args.serverFlow) {
				const { pubkey: pk } = await requireWallet();
				const r = await runServerFlow({
					prepPath: '/api/pump/sell-prep',
					body: {
						mint: args.mint,
						network,
						tokens: String(args.tokenAmount),
						slippage_bps: slippageBps,
						wallet_address: pk.toBase58(),
					},
					confirmPath: '/api/pump/sell-confirm',
					confirmExtra: (prep) => ({
						mint: args.mint,
						network,
						wallet_address: pk.toBase58(),
						tokens: String(args.tokenAmount),
						slippage_bps: slippageBps,
						route: prep.route,
					}),
				});
				const route = r.prep.route;
				return {
					success: true,
					output: `Sold ${args.tokenAmount} of ${args.mint.slice(0, 8)}… via ${route}.`,
					sentiment: 0.4,
					data: {
						signature: r.signature,
						route,
						mint: args.mint,
						network,
						tracked: r.confirm?.tracked,
					},
				};
			}

			const { pump, web3, BN } = await loadCore();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			const mint = new web3.PublicKey(args.mint);
			const onlineSdk = new pump.OnlinePumpSdk(connection);
			const offline = new pump.PumpSdk();
			const global = await onlineSdk.fetchGlobal();
			const state = await onlineSdk.fetchSellState(mint, pubkey);

			const tokenAmount = new BN(args.tokenAmount);
			const expectedSol = pump.getSellSolAmountFromTokenAmount({
				global,
				feeConfig: null,
				mintSupply: state.bondingCurve.tokenTotalSupply,
				bondingCurve: state.bondingCurve,
				amount: tokenAmount,
			});

			const sellIxs = await offline.sellInstructions({
				global,
				bondingCurveAccountInfo: state.bondingCurveAccountInfo,
				bondingCurve: state.bondingCurve,
				mint,
				user: pubkey,
				amount: tokenAmount,
				solAmount: expectedSol,
				slippage: slippageBps / 10_000,
				tokenProgram: (await import('@solana/spl-token')).TOKEN_PROGRAM_ID,
				mayhemMode: false,
			});

			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions: sellIxs,
			});
			return {
				success: true,
				output: `Sold ${args.tokenAmount} of ${args.mint.slice(0, 8)}…`,
				sentiment: 0.4,
				data: { signature: sig, mint: args.mint, network },
			};
		},
	});

	// ── pumpfun-status ────────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-status',
		description: 'Read live state for a pump.fun mint: market cap, graduation status.',
		instruction: 'Read-only. No wallet required.',
		animationHint: 'inspect',
		voicePattern: '{{mint}} status',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['mint'],
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const { pump, web3, splToken } = await loadCore();
			const connection = getConnection(web3, network);
			const onlineSdk = new pump.OnlinePumpSdk(connection);
			const mint = new web3.PublicKey(args.mint);

			const curve = await onlineSdk.fetchBondingCurve(mint);
			const global = await onlineSdk.fetchGlobal();
			const graduated = !!curve.complete;
			const marketCap = pump.bondingCurveMarketCap({
				global,
				bondingCurve: curve,
			});

			let userBalance = '0';
			let owner = null;
			try {
				const wallet = detectSolanaWallet();
				if (wallet?.publicKey && splToken) {
					owner = wallet.publicKey;
					const ata = await splToken.getAssociatedTokenAddress(mint, owner);
					const acct = await connection.getTokenAccountBalance(ata).catch(() => null);
					userBalance = acct?.value?.amount ?? '0';
				}
			} catch {}

			return {
				success: true,
				output: graduated
					? `Graduated to AMM. Market cap ~${marketCap.toString()} lamports.`
					: `On bonding curve. Market cap ~${marketCap.toString()} lamports.`,
				sentiment: graduated ? 0.7 : 0.2,
				data: {
					mint: args.mint,
					marketCap: marketCap.toString(),
					graduated,
					userBalance,
					owner: owner ? owner.toBase58() : null,
					network,
				},
			};
		},
	});

	// ── pumpfun-amm-buy ───────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-amm-buy',
		description: 'Buy a graduated pump.fun token from the AMM pool with SOL.',
		instruction: 'AMM buy via @pump-fun/pump-swap-sdk. Use after graduation.',
		animationHint: 'gesture',
		voicePattern: 'AMM buy {{solAmount}} SOL of {{mint}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				solAmount: { type: 'number' },
				slippageBps: { type: 'number' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['mint', 'solAmount'],
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const slippage = (args.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000;
			const { amm, web3, BN } = await loadAmm();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			const mint = new web3.PublicKey(args.mint);
			const sdk = new amm.OnlinePumpAmmSdk(connection);
			const solLamports = new BN(Math.floor(args.solAmount * web3.LAMPORTS_PER_SOL));

			const ixs = await sdk.swapAutocompleteBaseFromQuote({
				pool: amm.canonicalPumpPoolPda(mint)[0],
				quote: solLamports,
				slippage,
				direction: 'quoteToBase',
				user: pubkey,
			});

			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions: Array.isArray(ixs) ? ixs : ixs.instructions || [],
			});

			return {
				success: true,
				output: `AMM-bought ${args.mint.slice(0, 8)}… for ${args.solAmount} SOL.`,
				sentiment: 0.6,
				data: { signature: sig, mint: args.mint, network },
			};
		},
	});

	// ── pumpfun-amm-sell ──────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-amm-sell',
		description: 'Sell a graduated pump.fun token to the AMM pool for SOL.',
		instruction: 'AMM sell via @pump-fun/pump-swap-sdk.',
		animationHint: 'gesture',
		voicePattern: 'AMM sell {{tokenAmount}} of {{mint}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				tokenAmount: { type: 'string' },
				slippageBps: { type: 'number' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['mint', 'tokenAmount'],
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const slippage = (args.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000;
			const { amm, web3, BN } = await loadAmm();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			const mint = new web3.PublicKey(args.mint);
			const sdk = new amm.OnlinePumpAmmSdk(connection);
			const tokenAmount = new BN(args.tokenAmount);

			const ixs = await sdk.swapAutocompleteQuoteFromBase({
				pool: amm.canonicalPumpPoolPda(mint)[0],
				base: tokenAmount,
				slippage,
				direction: 'baseToQuote',
				user: pubkey,
			});

			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions: Array.isArray(ixs) ? ixs : ixs.instructions || [],
			});

			return {
				success: true,
				output: `AMM-sold ${args.tokenAmount} of ${args.mint.slice(0, 8)}…`,
				sentiment: 0.4,
				data: { signature: sig, mint: args.mint, network },
			};
		},
	});

	// ── pumpfun-claim-fees ────────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-claim-fees',
		description:
			'Claim accumulated creator fees from the agent-creator vault to the agent owner wallet.',
		instruction: 'Calls collectCoinCreatorFeeInstructions on OnlinePumpSdk.',
		animationHint: 'celebrate',
		voicePattern: 'Claiming creator fees…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: { network: { type: 'string', enum: ['mainnet', 'devnet'] } },
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const { pump, web3 } = await loadCore();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			const onlineSdk = new pump.OnlinePumpSdk(connection);
			const balance = await onlineSdk.getCreatorVaultBalanceBothPrograms(pubkey);
			if (balance.isZero?.() || balance.toString() === '0') {
				return {
					success: true,
					output: 'No creator fees to claim right now.',
					sentiment: 0.1,
					data: { lamports: '0' },
				};
			}

			const ixs = await onlineSdk.collectCoinCreatorFeeInstructions(pubkey, pubkey);
			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions: ixs,
			});
			return {
				success: true,
				output: `Claimed ${balance.toString()} lamports of creator fees.`,
				sentiment: 0.8,
				data: { signature: sig, lamports: balance.toString(), network },
			};
		},
	});

	// ── pumpfun-accept-payment ────────────────────────────────────────────────
	skills.register({
		name: 'pumpfun-accept-payment',
		description:
			'Accept a paid invocation of this agent via @pump-fun/agent-payments-sdk. Splits revenue per the on-chain sharing config.',
		instruction:
			'Builds an accept_payment tx for a fixed price in a given currency mint. Caller signs as `user`.',
		animationHint: 'gesture',
		voicePattern: 'Invoicing {{amount}} for service {{memo}}…',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				agentMint: {
					type: 'string',
					description: 'The agent token mint registered with PumpAgent',
				},
				currencyMint: {
					type: 'string',
					description: 'Currency mint (USDC, SOL wrapper, etc.)',
				},
				amount: {
					type: 'string',
					description: 'Amount in base units (string-encoded bigint)',
				},
				memo: { type: 'string', description: 'Invoice memo / nonce (uint)' },
				durationSeconds: { type: 'number', description: 'Validity window (default 600)' },
				network: { type: 'string', enum: ['mainnet', 'devnet'] },
			},
			required: ['agentMint', 'currencyMint', 'amount', 'memo'],
		},
		handler: async (args, _ctx) => {
			const network = args.network || DEFAULT_NETWORK;
			const duration = args.durationSeconds ?? 600;
			const { pay, web3 } = await loadAgentPayments();
			const { wallet, pubkey } = await requireWallet();
			const connection = getConnection(web3, network);

			const agentMint = new web3.PublicKey(args.agentMint);
			const currencyMint = new web3.PublicKey(args.currencyMint);
			const env = network === 'devnet' ? 'devnet' : 'mainnet-beta';

			const agent = new pay.PumpAgent(agentMint, env, connection);
			const now = Math.floor(Date.now() / 1000);

			const ixs = await agent.buildAcceptPaymentInstructions({
				user: pubkey,
				currencyMint,
				amount: args.amount,
				memo: args.memo,
				startTime: now,
				endTime: now + duration,
			});

			const sig = await sendIxs({
				web3,
				connection,
				wallet,
				payer: pubkey,
				instructions: ixs,
			});
			return {
				success: true,
				output: `Payment of ${args.amount} accepted. Memo ${args.memo}.`,
				sentiment: 0.7,
				data: {
					signature: sig,
					agentMint: args.agentMint,
					currencyMint: args.currencyMint,
					amount: args.amount,
					memo: args.memo,
					network,
				},
			};
		},
	});
}
