// `create_agent_wallet`: the whole custody setup in one call.
//
// Generates the agent's keypair, derives its vault from the owner's address,
// creates the vault, and delegates a capped allowance to the agent. The owner
// signs once. After this the agent can spend up to the allowance and not one
// unit more, and the owner can take it all back at any time.

import { z } from 'zod';
import { Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

import { NETWORK } from '../config.js';
import { connectionFor, mintDecimals, tokenProgramFor, toBaseUnits, fromBaseUnits, USDC_MINT, toPublicKey, accountLink } from '../lib/solana.js';
import { assertAgentId, createVaultInstructions, vaultAddress, readVault } from '../lib/vault.js';
import { normalizePolicy } from '../lib/policy.js';
import { readState, updateState } from '../lib/store.js';
import { ownerAction, resolveOwner, summarize } from '../lib/execute.js';

export const def = {
	name: 'create_agent_wallet',
	title: 'Give an agent a wallet with an on-chain spending limit',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Create an agent wallet on Solana. Generates a fresh keypair for the agent, creates a vault token account ' +
		'that YOU own (derived deterministically from your address plus the agent id), and delegates a capped ' +
		'allowance over it to the agent. The SPL Token program enforces that cap: the agent cannot spend past it, ' +
		'and every spend decrements it. You keep custody, you can revoke in one instruction, and you can withdraw ' +
		'the balance without the agent. Set guardrails (per_tx, daily, allowlists, expiry) in the same call. ' +
		'Signs with OWNER_SECRET_KEY if configured, otherwise returns an unsigned transaction for Phantom, ' +
		'Solflare, Backpack, or a Ledger. Requires confirm:true to broadcast.',
	inputSchema: {
		id: z
			.string()
			.min(1)
			.max(27)
			.describe('Short slug naming the agent, lowercase letters/digits/hyphens. Becomes the on-chain vault seed.'),
		allowance: z
			.string()
			.describe('The on-chain ceiling, in whole tokens (e.g. "100"). The agent can never spend more than this without a new approval.'),
		label: z.string().max(120).optional().describe('Human-readable name for your own reference.'),
		owner: z
			.string()
			.optional()
			.describe('Your wallet address. Omit to use the configured OWNER_SECRET_KEY. Pass it to keep the key off this machine and sign in your wallet.'),
		mint: z.string().optional().describe(`SPL mint to spend. Defaults to USDC (${USDC_MINT.mainnet} on mainnet).`),
		fee_sol: z
			.string()
			.optional()
			.describe('SOL to send the agent so it can pay its own transaction fees. Default "0.02". This is the only value the agent itself holds.'),
		per_tx: z.string().optional().describe('Guardrail: maximum single spend, in tokens.'),
		daily: z.string().optional().describe('Guardrail: maximum spend per rolling 24 hours, in tokens.'),
		confirm_over: z.string().optional().describe('Guardrail: spends above this amount need an explicit confirm:true from a human.'),
		allow_recipients: z.array(z.string()).optional().describe('Guardrail: only these addresses may receive funds. Empty means unrestricted.'),
		allow_hosts: z.array(z.string()).optional().describe('Guardrail: only these hosts may be paid over x402. Subdomains included. Empty means unrestricted.'),
		expires_at: z.string().optional().describe('Guardrail: ISO timestamp after which every spend is refused.'),
		agent_secret: z.string().optional().describe('Reuse an existing agent keypair (base58 or JSON array) instead of generating one.'),
		secret: z.string().optional().describe('Owner secret key for this call only, overriding OWNER_SECRET_KEY.'),
		confirm: z.boolean().optional().describe('Set true to actually build and broadcast. Without it you get the summary only.'),
	},
	async handler(args) {
		const id = assertAgentId(args.id);
		const owner = resolveOwner({ owner: args.owner, secret: args.secret });
		const connection = connectionFor(NETWORK);
		const mint = args.mint ? toPublicKey(args.mint, 'mint').toBase58() : USDC_MINT[NETWORK];
		const programId = await tokenProgramFor(connection, mint);
		const decimals = await mintDecimals(connection, mint, programId);

		const existing = readState().agents[id];
		if (existing && existing.owner !== owner) {
			throw Object.assign(
				new Error(`agent "${id}" already exists under owner ${existing.owner}. Pick a different id.`),
				{ code: 'agent_exists' },
			);
		}

		const vault = (await vaultAddress(owner, id, programId)).toBase58();
		const onchain = await readVault({ connection, vault, programId });
		if (onchain.exists) {
			throw Object.assign(
				new Error(
					`the vault for "${id}" already exists at ${vault}. Use approve_agent_allowance to change its ceiling, ` +
						'or fund_agent_wallet to top it up.',
				),
				{ code: 'vault_exists' },
			);
		}

		// The delegate pubkey is baked into the approval, so the keypair must be
		// stable between the preview call and the confirmed one. Generate and
		// persist it now; this touches no chain and moves no funds.
		const keypair = args.agent_secret
			? Keypair.fromSecretKey(
					args.agent_secret.trim().startsWith('[')
						? Uint8Array.from(JSON.parse(args.agent_secret))
						: bs58.decode(args.agent_secret.trim()),
				)
			: existing?.agent_secret
				? Keypair.fromSecretKey(bs58.decode(existing.agent_secret))
				: Keypair.generate();
		const agentPubkey = keypair.publicKey.toBase58();

		const policy = normalizePolicy({
			per_tx: args.per_tx,
			daily: args.daily,
			confirm_over: args.confirm_over,
			allow_recipients: args.allow_recipients,
			allow_hosts: args.allow_hosts,
			expires_at: args.expires_at,
		});

		const allowanceUnits = toBaseUnits(args.allowance, decimals);
		if (allowanceUnits <= 0n) {
			throw Object.assign(new Error('allowance must be greater than zero'), { code: 'bad_amount' });
		}
		const feeSol = args.fee_sol === undefined ? '0.02' : String(args.fee_sol);
		const feeLamports = BigInt(toBaseUnits(feeSol, 9));

		updateState((state) => {
			state.agents[id] = {
				id,
				label: args.label || null,
				network: NETWORK,
				owner,
				agent_pubkey: agentPubkey,
				agent_secret: bs58.encode(keypair.secretKey),
				mint,
				vault,
				seed: `oaw1:${id}`,
				policy,
				created_at: existing?.created_at || new Date().toISOString(),
				deployment: existing?.deployment || null,
			};
		});

		const { instructions, rentLamports } = await createVaultInstructions({
			connection,
			owner,
			agentId: id,
			mint,
			delegate: agentPubkey,
			allowance: allowanceUnits,
			decimals,
			programId,
		});
		if (feeLamports > 0n) {
			instructions.push(
				SystemProgram.transfer({
					fromPubkey: toPublicKey(owner, 'owner'),
					toPubkey: keypair.publicKey,
					lamports: Number(feeLamports),
				}),
			);
		}

		const summary = summarize({
			action: `Create the "${id}" agent wallet and delegate ${args.allowance} to it`,
			network: NETWORK,
			extra: {
				owner,
				agent_address: agentPubkey,
				vault,
				asset: mint === USDC_MINT[NETWORK] ? 'USDC' : mint,
				allowance: `${fromBaseUnits(allowanceUnits, decimals)} (the on-chain ceiling)`,
				sol_to_agent: `${feeSol} SOL for the agent's own transaction fees`,
				rent: `${fromBaseUnits(BigInt(rentLamports), 9)} SOL, recoverable when you close the vault`,
				guardrails: policy,
				custody: 'The vault is owned by you. The agent is only a delegate, capped at the allowance.',
			},
		});

		const result = await ownerAction({
			connection,
			owner,
			instructions,
			confirm: args.confirm === true,
			secret: args.secret,
			summary,
			network: NETWORK,
			note: `create agent wallet "${id}"`,
		});

		return {
			...result,
			agent: {
				id,
				agent_address: agentPubkey,
				vault,
				vault_link: accountLink(vault, NETWORK),
				mint,
				allowance: fromBaseUnits(allowanceUnits, decimals),
				policy,
			},
			next_steps:
				result.action === 'confirm_required'
					? ['Re-issue with confirm:true to create the wallet.']
					: [
							'fund_agent_wallet: move tokens into the vault so the allowance is actually backed.',
							'agent_wallet_status: see live balances, the remaining allowance, and the guardrails.',
							'pay_x402 / agent_pay: let the agent spend inside its limits.',
							'revoke_agent_wallet: kill the delegation instantly, any time.',
						],
		};
	},
};
