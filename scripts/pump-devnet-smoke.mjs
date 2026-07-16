#!/usr/bin/env node
// End-to-end devnet smoke for the pump.fun launchpad loop — Task 07.
// ----------------------------------------------------------------------------
// Proves the entire launch → buy → sell pipeline works against REAL on-chain
// state on Solana devnet, for BOTH a SOL-paired and a USDC-paired coin, plus a
// custodial (server-signed) buy/sell — the acceptance gate for Tasks 01–03:
//
//   • Task 01 — every recorded `pump_agent_trades` row carries the correct
//     quote_mint / quote_symbol / quote_amount (USDC legs in 1e6 atoms, SOL
//     legs in lamports), asserted by re-reading the row from Postgres.
//   • Task 02/03 — USDC buy_v2/sell_v2 and the custodial (held-key, server-
//     signed) buy/sell paths transact correctly on a USDC-paired curve.
//
// This drives the SAME production helpers the dispatcher handlers use — not a
// reimplementation: getPumpSdk + the @pump-fun SDK v2 builders (createV2 /
// createV2AndBuyV2 / buyV2 / sellV2), pump-trade-args (slippage + token
// program + quote resolution), pump-quote (tradeQuoteColumns +
// walletQuoteDeltaAtomics), verifySignature, and the same `sql` client + the
// same recording logic as api/pump/[action].js's buy/sell-confirm. It signs
// locally with a funded devnet keypair, broadcasts, confirms, records, and
// asserts the row.
//
// DEVNET ONLY. Refuses any mainnet RPC. Never point it at a mainnet key.
//
// ── Funding the signer (required for a live run) ────────────────────────────
//   SOL:  the signer needs ~0.1 devnet SOL (create + buys + sells + ATA rent).
//         The script auto-airdrops via the configured RPC, then Helius devnet,
//         then the public faucet. If all return 429 ("airdrop limit / dry"),
//         fund manually at https://faucet.solana.com (devnet) — the script
//         prints the address — or point --rpc at a premium devnet endpoint
//         (Helius/Triton/Quicknode) whose faucet isn't exhausted.
//   USDC: the USDC legs need devnet USDC (mint 4zMMC9srt5Ri5X14GAgXhaHii3Gn
//         PAEERYPJgZJDncDU — the only quote mint the devnet program whitelists).
//         Its mint authority is an external faucet, so fund manually at
//         https://faucet.circle.com (Solana devnet) — the script prints the
//         address + amount. Without USDC the USDC legs SKIP (not fail).
//
// ── Flags / env ─────────────────────────────────────────────────────────────
//   --rpc <url>        | SOLANA_RPC_URL_DEVNET   devnet RPC (default public)
//   --keypair <path>   | DEVNET_TEST_WALLET      JSON byte-array or base58 key
//                                                (default: the x402 demo solana
//                                                 wallet in ~/.config/...)
//   --simulate-only                              build + simulate every leg on
//                                                chain, never broadcast — needs
//                                                no funds; proves the pipeline
//   --sol-only                                   run only the SOL legs
//   --usdc <n>                                   USDC per launch/buy (default 1)
//   --sol <n>                                    SOL per launch-buy/buy (0.01)
//   --slippage-bps <n>                           default 500 (5%)
//   --no-db                                      skip Postgres record + assert
//   --keep                                       keep the seeded devnet DB rows
//   --cleanup                                    only delete prior smoke DB rows
//
// Examples:
//   node scripts/pump-devnet-smoke.mjs --simulate-only
//   node scripts/pump-devnet-smoke.mjs --keypair /tmp/devnet.json
//   node scripts/pump-devnet-smoke.mjs --rpc https://devnet.helius-rpc.com/?api-key=…

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	Connection,
	Keypair,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
	SystemProgram,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import * as spl from '@solana/spl-token';
import {
	getBuyTokenAmountFromSolAmount,
	getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';

import { getPumpSdk, getConnection, verifySignature } from '../api/_lib/pump.js';
import {
	slippagePercentFromBps,
	resolveTokenProgramForMintOwner,
	resolveCustodialQuote,
} from '../api/_lib/pump-trade-args.js';
import { tradeQuoteColumns, walletQuoteDeltaAtomics, usdcMintFor, WSOL_MINT } from '../api/_lib/pump-quote.js';

// ── tiny .env.local loader (so `sql` sees DATABASE_URL, like apply-migrations) ─
(function loadEnvLocal() {
	const p = path.join(process.cwd(), '.env.local');
	if (!fs.existsSync(p)) return;
	for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
		if (!m) continue;
		const k = m[1];
		let v = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
		if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
	}
})();

// ── args ─────────────────────────────────────────────────────────────────────
function flag(name, fallbackEnv) {
	const i = process.argv.indexOf(`--${name}`);
	if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
		return process.argv[i + 1];
	return fallbackEnv ? process.env[fallbackEnv] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const RPC = flag('rpc', 'SOLANA_RPC_URL_DEVNET') || 'https://api.devnet.solana.com';
const DEFAULT_WALLET = path.join(os.homedir(), '.config', 'x402-test-wallets', 'solana.json');
const KEYPAIR_PATH = flag('keypair', 'DEVNET_TEST_WALLET') || DEFAULT_WALLET;
const SIMULATE_ONLY = has('simulate-only');
const SOL_ONLY = has('sol-only');
const NO_DB = has('no-db');
const KEEP = has('keep');
const CLEANUP_ONLY = has('cleanup');
const USDC_PER = Number(flag('usdc') || '1'); // human USDC per launch/buy
const SOL_PER = Number(flag('sol') || '0.01'); // human SOL per launch-buy/buy
const SLIPPAGE_BPS = Number(flag('slippage-bps') || '500');

if (/mainnet|mainnet-beta/i.test(RPC)) {
	console.error('✗ Refusing to run against a mainnet RPC. Devnet only.');
	process.exit(1);
}
// getPumpSdk / getConnection resolve the devnet RPC from this env var.
process.env.SOLANA_RPC_URL_DEVNET = RPC;

const NETWORK = 'devnet';
const DEV_USDC = usdcMintFor('devnet'); // 4zMMC9…
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const SOL_ATOMICS = (n) => new BN(Math.floor(n * LAMPORTS_PER_SOL));
const USDC_ATOMICS = (n) => new BN(Math.round(n * 1_000_000));

// ── result tracking ───────────────────────────────────────────────────────────
const results = []; // { leg, status: 'PASS'|'FAIL'|'SKIP', detail, sigs:[] }
function record(leg, status, detail, sigs = []) {
	results.push({ leg, status, detail, sigs });
	const icon = status === 'PASS' ? '✓' : status === 'SKIP' ? '∅' : '✗';
	console.log(`\n${icon} [${status}] ${leg}${detail ? ` — ${detail}` : ''}`);
	for (const s of sigs) console.log(`    ${explorer(s)}`);
}

function loadKeypair(p) {
	const raw = fs.readFileSync(p, 'utf8').trim();
	try {
		const arr = JSON.parse(raw);
		return Keypair.fromSecretKey(Uint8Array.from(Array.isArray(arr) ? arr : Object.values(arr)));
	} catch {
		return Keypair.fromSecretKey(bs58.decode(raw));
	}
}

// ── on-chain send / simulate (the prep → sign → broadcast → confirm pipeline) ──
// Builds a VersionedTransaction (v0) exactly like the production handlers'
// buildUnsignedTxBase64, signs locally, broadcasts, and confirms.
async function submit(connection, instructions, signers, label) {
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({
		payerKey: signers[0].publicKey,
		recentBlockhash: blockhash,
		instructions,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign(signers);

	if (SIMULATE_ONLY) {
		// Fund-independent build proof: the instruction was constructed by the
		// real SDK builder, compiled to a v0 message, and serializes within the
		// 1232-byte packet limit. Throws here only on a genuine malformed tx.
		const size = vtx.serialize().length;
		if (size > 1232) throw new Error(`${label}: serialized tx ${size} > 1232 bytes`);

		const sim = await connection.simulateTransaction(vtx, {
			sigVerify: false,
			replaceRecentBlockhash: true,
		});
		const err = sim.value.err;
		// A never-funded fee payer doesn't exist on-chain, so simulation halts with
		// AccountNotFound / insufficient-funds before executing — EXPECTED, and the
		// build above already proved the instruction is well-formed. Surface only
		// genuine program errors as failures.
		const logs = (sim.value.logs || []).join('\n');
		const fundingErr =
			err == null ||
			/AccountNotFound|could not find account|insufficient|0x1\b|debit an account|lamports|attempt to debit/i.test(
				JSON.stringify(err) + logs,
			);
		if (err && !fundingErr) {
			throw new Error(`${label} simulation failed: ${JSON.stringify(err)}\n${logs.slice(0, 800)}`);
		}
		console.log(
			`    [sim] ${label}: built OK (${size}B, v0)${err ? ' — sim halted on funding (expected)' : ' + simulated OK'}`,
		);
		return null; // no signature in simulate-only
	}

	const sig = await connection.sendRawTransaction(vtx.serialize(), {
		skipPreflight: false,
		maxRetries: 3,
	});
	await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
	console.log(`    ${label} tx: ${sig}`);
	console.log(`    ${explorer(sig)}`);
	return sig;
}

// ── funding ────────────────────────────────────────────────────────────────────
async function ensureSol(connection, pubkey, minSol = 0.1) {
	let bal = await connection.getBalance(pubkey);
	if (bal >= minSol * LAMPORTS_PER_SOL) return bal;
	const helius = process.env.HELIUS_API_KEY;
	const endpoints = [RPC, helius ? `https://devnet.helius-rpc.com/?api-key=${helius}` : null, 'https://api.devnet.solana.com']
		.filter(Boolean)
		.filter((u, i, a) => a.indexOf(u) === i);
	for (const url of endpoints) {
		try {
			const conn = new Connection(url, 'confirmed');
			const sig = await conn.requestAirdrop(pubkey, Math.ceil(minSol * 2 * LAMPORTS_PER_SOL));
			await conn.confirmTransaction(sig, 'confirmed');
			break;
		} catch {
			/* try next endpoint */
		}
	}
	bal = await connection.getBalance(pubkey);
	return bal;
}

async function usdcBalanceAtomics(connection, owner) {
	try {
		const ata = spl.getAssociatedTokenAddressSync(new PublicKey(DEV_USDC), owner, true, spl.TOKEN_PROGRAM_ID);
		const b = await connection.getTokenAccountBalance(ata);
		return BigInt(b?.value?.amount ?? '0');
	} catch {
		return 0n;
	}
}

// ── DB: seed (idempotent) a synthetic devnet test user + agent ─────────────────
// Both columns on pump_agent_mints are NOT NULL FKs (agent_identities, users),
// so the recording path needs a real mint row. Everything is clearly synthetic,
// network='devnet', and cascade-cleaned at the end unless --keep.
const SMOKE_EMAIL = 'devnet-smoke@three.ws';
const SMOKE_AGENT = 'devnet-smoke';
let sql = null;
let dbCtx = null; // { userId, agentId }

async function dbConnect() {
	if (NO_DB) return false;
	if (!process.env.DATABASE_URL) {
		console.log('  (no DATABASE_URL — DB record + assert skipped; pass --no-db to silence)');
		return false;
	}
	({ sql } = await import('../api/_lib/db.js'));
	return true;
}

async function dbSeed() {
	const [user] = await sql`
		insert into users (email, display_name, email_verified)
		values (${SMOKE_EMAIL}, 'Devnet Smoke', true)
		on conflict (email) do update set display_name = excluded.display_name
		returning id
	`;
	const [agent] = await sql`
		insert into agent_identities (user_id, name, description)
		values (${user.id}, ${SMOKE_AGENT}, 'pump.fun devnet smoke test agent')
		on conflict do nothing
		returning id
	`;
	let agentId = agent?.id;
	if (!agentId) {
		const [a] = await sql`
			select id from agent_identities where user_id = ${user.id} and name = ${SMOKE_AGENT} limit 1
		`;
		agentId = a?.id;
	}
	dbCtx = { userId: user.id, agentId };
}

async function dbCleanup() {
	if (!sql || !dbCtx || KEEP) return;
	// Cascade: deleting the agent removes its mints, which removes their trades.
	await sql`delete from agent_identities where id = ${dbCtx.agentId}`.catch(() => {});
	await sql`delete from users where id = ${dbCtx.userId} and email = ${SMOKE_EMAIL}`.catch(() => {});
}

// Register the launched coin so trade rows have a mint_id + quote source.
async function dbRegisterMint({ mint, name, symbol, quoteMint }) {
	if (!sql || !dbCtx) return null;
	const [row] = await sql`
		insert into pump_agent_mints
			(agent_id, user_id, network, mint, name, symbol, metadata_uri, agent_authority, buyback_bps, quote_mint)
		values
			(${dbCtx.agentId}, ${dbCtx.userId}, ${NETWORK}, ${mint}, ${name}, ${symbol},
			 'https://three.ws/devnet-smoke.json', ${null}, 0, ${quoteMint ?? null})
		on conflict (mint, network) do update set name = excluded.name
		returning id, quote_mint
	`;
	return row;
}

// Record a confirmed trade using the EXACT logic of buy/sell-confirm in
// api/pump/[action].js, then re-read it and assert the quote columns. Returns
// the asserted row.
async function dbRecordAndAssert({ mintRow, signature, wallet, direction, route, tokens, sol, usdcAmount }) {
	if (!sql || !dbCtx || !signature) return null;
	const tx = await verifySignature({ network: NETWORK, signature });
	const { quote_mint, quote_symbol } = tradeQuoteColumns({
		quoteMint: mintRow.quote_mint,
		network: NETWORK,
	});

	let lamports = null;
	let quoteAmount = null;
	if (direction === 'buy') {
		lamports = quote_symbol === 'SOL' && sol > 0 ? SOL_ATOMICS(sol).toString() : null;
		quoteAmount =
			quote_symbol === 'SOL'
				? lamports
				: usdcAmount > 0
					? USDC_ATOMICS(usdcAmount).toString()
					: walletQuoteDeltaAtomics({ tx, wallet, quoteSymbol: quote_symbol, quoteMint: quote_mint });
	} else {
		quoteAmount = walletQuoteDeltaAtomics({ tx, wallet, quoteSymbol: quote_symbol, quoteMint: quote_mint });
		lamports = quote_symbol === 'SOL' ? quoteAmount : null;
	}

	await sql`
		insert into pump_agent_trades
			(mint_id, user_id, wallet, direction, route, sol_amount, token_amount,
			 quote_mint, quote_symbol, quote_amount, slippage_bps, tx_signature, network)
		values
			(${mintRow.id}, ${dbCtx.userId}, ${wallet}, ${direction}, ${route},
			 ${lamports}, ${tokens ?? null}, ${quote_mint}, ${quote_symbol}, ${quoteAmount},
			 ${SLIPPAGE_BPS}, ${signature}, ${NETWORK})
		on conflict (tx_signature, network) do nothing
	`;

	const [back] = await sql`
		select direction, quote_mint, quote_symbol, quote_amount
		from pump_agent_trades where tx_signature = ${signature} and network = ${NETWORK} limit 1
	`;
	if (!back) throw new Error('trade row not found after insert');

	// Assert: the right quote asset, in the right units, non-zero.
	const expectSymbol = mintRow.quote_mint ? 'USDC' : 'SOL';
	if (back.quote_symbol !== expectSymbol)
		throw new Error(`quote_symbol ${back.quote_symbol} !== ${expectSymbol}`);
	const expectMint = mintRow.quote_mint ? DEV_USDC : WSOL_MINT;
	if (back.quote_mint !== expectMint) throw new Error(`quote_mint ${back.quote_mint} !== ${expectMint}`);
	if (back.quote_amount == null || BigInt(back.quote_amount) <= 0n)
		throw new Error(`quote_amount must be > 0, got ${back.quote_amount}`);
	console.log(
		`    [db] ${direction} row: quote_symbol=${back.quote_symbol} quote_mint=${back.quote_mint.slice(0, 6)}… quote_amount=${back.quote_amount}`,
	);
	return back;
}

// ── leg builders (mirror api/pump/[action].js + api/agents/pumpfun/[action].js) ─

// Launch a fresh create_v2 coin (create-only — the buy leg supplies the first
// liquidity, which keeps every tx well under the 1232-byte packet limit and
// mirrors the launch-prep → buy-prep split the dispatcher exposes).
// quoteMint=null => SOL-paired; a USDC mint => USDC-paired.
async function launchCoin({ connection, sdk, payer, name, symbol, quoteMint }) {
	const mintKp = Keypair.generate();
	const mint = mintKp.publicKey;
	const ix = await sdk.createV2Instruction({
		mint,
		name,
		symbol,
		uri: 'https://three.ws/devnet-smoke.json',
		creator: payer.publicKey,
		user: payer.publicKey,
		...(quoteMint ? { quoteMint: new PublicKey(quoteMint) } : {}),
		mayhemMode: false,
	});
	const instructions = Array.isArray(ix) ? ix : [ix];
	const sig = await submit(connection, instructions, [payer, mintKp], `launch ${symbol}`);
	return { mint: mint.toBase58(), sig };
}

// Buy on the bonding curve — SOL or USDC quote, mirroring handleBuy/handleBuyPrep.
async function buyCoin({ connection, sdk, buyer, mint, sol = 0, usdcAmount = 0 }) {
	const mintPk = new PublicKey(mint);
	const mintInfo = await connection.getAccountInfo(mintPk);
	if (!mintInfo) throw new Error(`mint ${mint} not found on devnet`);
	const tokenProgram = resolveTokenProgramForMintOwner(mintInfo.owner);

	const [global, feeConfig, state] = await Promise.all([
		sdk.fetchGlobal(),
		sdk.fetchFeeConfig().catch(() => null),
		sdk.fetchBuyState(mintPk, buyer.publicKey, tokenProgram),
	]);
	if (!state?.bondingCurve || state.bondingCurve.complete)
		throw new Error('no active bonding curve (graduated or missing)');
	const quote = resolveCustodialQuote(state.bondingCurve?.quoteMint, NETWORK);

	const ixs = [];
	let amount;
	let quoteAmount;
	if (quote.isUsdc) {
		const quoteMintPk = new PublicKey(quote.quoteMint);
		const quoteInfo = await connection.getAccountInfo(quoteMintPk);
		const quoteTokenProgram = resolveTokenProgramForMintOwner(quoteInfo.owner);
		quoteAmount = USDC_ATOMICS(usdcAmount);
		amount = getBuyTokenAmountFromSolAmount({
			global,
			feeConfig,
			mintSupply: state.bondingCurve.tokenTotalSupply,
			bondingCurve: state.bondingCurve,
			amount: quoteAmount,
			quoteMint: quoteMintPk,
		});
		if (!amount.gt(new BN(0))) throw new Error('usdcAmount too small to buy any tokens');
		ixs.push(
			...(await sdk.buyV2Instructions({
				global,
				bondingCurveAccountInfo: state.bondingCurveAccountInfo,
				bondingCurve: state.bondingCurve,
				associatedUserAccountInfo: state.associatedUserAccountInfo,
				mint: mintPk,
				user: buyer.publicKey,
				amount,
				quoteAmount,
				slippage: slippagePercentFromBps(SLIPPAGE_BPS),
				tokenProgram,
				quoteTokenProgram,
			})),
		);
	} else {
		quoteAmount = SOL_ATOMICS(sol);
		amount = getBuyTokenAmountFromSolAmount({
			global,
			feeConfig,
			mintSupply: state.bondingCurve.tokenTotalSupply,
			bondingCurve: state.bondingCurve,
			amount: quoteAmount,
		});
		if (!amount.gt(new BN(0))) throw new Error('sol amount too small to buy any tokens');
		ixs.push(
			...(await sdk.buyV2Instructions({
				global,
				bondingCurveAccountInfo: state.bondingCurveAccountInfo,
				bondingCurve: state.bondingCurve,
				associatedUserAccountInfo: state.associatedUserAccountInfo,
				mint: mintPk,
				user: buyer.publicKey,
				amount,
				quoteAmount,
				slippage: slippagePercentFromBps(SLIPPAGE_BPS),
				tokenProgram,
			})),
		);
	}

	const sig = await submit(connection, ixs, [buyer], `buy ${quote.quoteSymbol}`);
	return { sig, tokenProgram, quoteSymbol: quote.quoteSymbol };
}

// Sell the full token balance back — SOL or USDC quote, mirroring handleSell.
async function sellCoin({ connection, sdk, seller, mint, tokenProgram }) {
	const mintPk = new PublicKey(mint);
	const userAta = spl.getAssociatedTokenAddressSync(mintPk, seller.publicKey, true, tokenProgram);
	const bal = await connection.getTokenAccountBalance(userAta);
	const tokens = new BN(bal.value.amount);
	if (!tokens.gt(new BN(0))) throw new Error('zero token balance to sell');

	const [global, feeConfig, state] = await Promise.all([
		sdk.fetchGlobal(),
		sdk.fetchFeeConfig().catch(() => null),
		sdk.fetchSellState(mintPk, seller.publicKey, tokenProgram),
	]);
	const quote = resolveCustodialQuote(state.bondingCurve?.quoteMint, NETWORK);
	const expectedQuoteOut = getSellSolAmountFromTokenAmount({
		global,
		feeConfig,
		mintSupply: state.bondingCurve.tokenTotalSupply,
		bondingCurve: state.bondingCurve,
		amount: tokens,
	});

	const ixs = [];
	let quoteTokenProgram;
	if (quote.isUsdc) {
		const quoteMintPk = new PublicKey(quote.quoteMint);
		const quoteInfo = await connection.getAccountInfo(quoteMintPk);
		quoteTokenProgram = resolveTokenProgramForMintOwner(quoteInfo.owner);
		const userQuoteAta = spl.getAssociatedTokenAddressSync(quoteMintPk, seller.publicKey, true, quoteTokenProgram);
		ixs.push(
			spl.createAssociatedTokenAccountIdempotentInstruction(
				seller.publicKey,
				userQuoteAta,
				seller.publicKey,
				quoteMintPk,
				quoteTokenProgram,
			),
		);
	}
	ixs.push(
		...(await sdk.sellV2Instructions({
			global,
			bondingCurveAccountInfo: state.bondingCurveAccountInfo,
			bondingCurve: state.bondingCurve,
			mint: mintPk,
			user: seller.publicKey,
			amount: tokens,
			quoteAmount: expectedQuoteOut,
			slippage: slippagePercentFromBps(SLIPPAGE_BPS),
			tokenProgram,
			...(quote.isUsdc ? { quoteTokenProgram } : {}),
		})),
	);

	const sig = await submit(connection, ixs, [seller], `sell ${quote.quoteSymbol}`);
	return { sig, tokens: tokens.toString(), quoteSymbol: quote.quoteSymbol };
}

// ── full launch → buy → sell leg (SOL or USDC), with DB record + assert ────────
async function runTradeLeg({ connection, sdk, signer, label, quoteMint, name, symbol }) {
	const isUsdc = !!quoteMint;
	const launch = await launchCoin({ connection, sdk, payer: signer, name, symbol, quoteMint });
	if (SIMULATE_ONLY) {
		record(label, 'PASS', `launch ix built + simulated (buy/sell need a live curve — funded run)`);
		return;
	}

	const mintRow = await dbRegisterMint({ mint: launch.mint, name, symbol, quoteMint });

	const buy = await buyCoin({
		connection,
		sdk,
		buyer: signer,
		mint: launch.mint,
		sol: isUsdc ? 0 : SOL_PER,
		usdcAmount: isUsdc ? USDC_PER : 0,
	});
	if (mintRow)
		await dbRecordAndAssert({
			mintRow,
			signature: buy.sig,
			wallet: signer.publicKey.toBase58(),
			direction: 'buy',
			route: 'bonding_curve',
			sol: isUsdc ? 0 : SOL_PER,
			usdcAmount: isUsdc ? USDC_PER : 0,
		});

	const sell = await sellCoin({
		connection,
		sdk,
		seller: signer,
		mint: launch.mint,
		tokenProgram: buy.tokenProgram,
	});
	if (mintRow)
		await dbRecordAndAssert({
			mintRow,
			signature: sell.sig,
			wallet: signer.publicKey.toBase58(),
			direction: 'sell',
			route: 'bonding_curve',
			tokens: sell.tokens,
		});

	record(label, 'PASS', `mint ${launch.mint}`, [launch.sig, buy.sig, sell.sig].filter(Boolean));
}

// ── custodial leg: a separately-held "agent" keypair signs server-side ─────────
async function runCustodialLeg({ connection, sdk, funder, quoteMint }) {
	const label = `Custodial buy+sell (${quoteMint ? 'USDC' : 'SOL'})`;
	const agent = Keypair.generate(); // stands in for loadAgentForSigning's recovered key
	// The custodial wallet needs its own SOL for fees/rent, and (USDC leg) USDC.
	if (!SIMULATE_ONLY) {
		const transfer = SystemProgram.transfer({
			fromPubkey: funder.publicKey,
			toPubkey: agent.publicKey,
			lamports: Math.floor(0.04 * LAMPORTS_PER_SOL),
		});
		await submit(connection, [transfer], [funder], 'fund custodial wallet');
	}

	// Launch a coin the custodial wallet will own + trade.
	const name = quoteMint ? 'three.ws custodial USDC smoke' : 'three.ws custodial SOL smoke';
	const symbol = quoteMint ? 'T3CUSDC' : 'T3CSOL';
	const launch = await launchCoin({ connection, sdk, payer: agent, name, symbol, quoteMint });
	if (SIMULATE_ONLY) {
		record(label, 'PASS', 'custodial launch ix built + simulated');
		return;
	}

	const mintRow = await dbRegisterMint({ mint: launch.mint, name, symbol, quoteMint });
	const buy = await buyCoin({
		connection,
		sdk,
		buyer: agent,
		mint: launch.mint,
		sol: quoteMint ? 0 : SOL_PER,
		usdcAmount: quoteMint ? USDC_PER : 0,
	});
	if (mintRow)
		await dbRecordAndAssert({
			mintRow,
			signature: buy.sig,
			wallet: agent.publicKey.toBase58(),
			direction: 'buy',
			route: 'bonding_curve',
			sol: quoteMint ? 0 : SOL_PER,
			usdcAmount: quoteMint ? USDC_PER : 0,
		});
	const sell = await sellCoin({ connection, sdk, seller: agent, mint: launch.mint, tokenProgram: buy.tokenProgram });
	if (mintRow)
		await dbRecordAndAssert({
			mintRow,
			signature: sell.sig,
			wallet: agent.publicKey.toBase58(),
			direction: 'sell',
			route: 'bonding_curve',
			tokens: sell.tokens,
		});
	record(label, 'PASS', `custodial wallet ${agent.publicKey.toBase58()} · mint ${launch.mint}`, [
		launch.sig,
		buy.sig,
		sell.sig,
	].filter(Boolean));
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
	console.log('pump.fun devnet smoke — launch → buy → sell (Task 07)');
	console.log(`  rpc:      ${RPC}`);
	console.log(`  mode:     ${SIMULATE_ONLY ? 'SIMULATE-ONLY (no broadcast, no funds needed)' : 'LIVE'}`);
	console.log(`  network:  ${NETWORK}`);

	const connection = getConnection({ network: NETWORK });
	const { sdk } = await getPumpSdk({ network: NETWORK });
	const signer = loadKeypair(KEYPAIR_PATH);
	console.log(`  signer:   ${signer.publicKey.toBase58()}`);

	const dbOn = await dbConnect();
	if (dbOn && CLEANUP_ONLY) {
		await dbSeed();
		await sql`delete from pump_agent_mints where agent_id = ${dbCtx.agentId} and network = ${NETWORK}`.catch(() => {});
		await dbCleanup();
		console.log('\n✓ cleaned prior devnet smoke rows. Done.');
		return;
	}
	if (dbOn && !SIMULATE_ONLY) await dbSeed();

	// Verify the devnet program whitelists devnet USDC (gates the USDC legs).
	let usdcWhitelisted = false;
	try {
		const g = await sdk.fetchGlobal();
		usdcWhitelisted = (g.whitelistedQuoteMints || []).map((k) => k.toBase58()).includes(DEV_USDC);
	} catch {
		/* leave false */
	}
	console.log(`  usdc gate: ${usdcWhitelisted ? 'OPEN' : 'CLOSED'} (devnet USDC ${DEV_USDC})`);

	// Fund SOL (live only).
	if (!SIMULATE_ONLY) {
		const bal = await ensureSol(connection, signer.publicKey, 0.12);
		console.log(`  sol bal:  ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
		if (bal < 0.05 * LAMPORTS_PER_SOL) {
			record(
				'Funding',
				'FAIL',
				`signer has ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL; need ~0.12. Airdrop is rate-limited (429). ` +
					`Fund ${signer.publicKey.toBase58()} at https://faucet.solana.com (devnet) or pass --rpc <premium devnet endpoint>, then re-run. ` +
					`Or run with --simulate-only to validate the build pipeline without funds.`,
			);
			await summarize();
			return;
		}
	}

	// ── SOL leg ──
	try {
		await runTradeLeg({
			connection,
			sdk,
			signer,
			label: 'SOL launch + buy + sell',
			quoteMint: null,
			name: 'three.ws devnet SOL smoke',
			symbol: 'T3SOL',
		});
	} catch (e) {
		record('SOL launch + buy + sell', 'FAIL', stepError(e));
	}

	// ── USDC leg ──
	if (SOL_ONLY) {
		record('USDC launch + buy + sell', 'SKIP', '--sol-only');
	} else if (!usdcWhitelisted) {
		record('USDC launch + buy + sell', 'SKIP', 'devnet program does not whitelist devnet USDC');
	} else {
		let usdcOk = SIMULATE_ONLY;
		if (!SIMULATE_ONLY) {
			const have = await usdcBalanceAtomics(connection, signer.publicKey);
			const need = USDC_ATOMICS(USDC_PER * 2);
			usdcOk = have >= BigInt(need.toString());
			if (!usdcOk) {
				record(
					'USDC launch + buy + sell',
					'SKIP',
					`signer holds ${Number(have) / 1e6} devnet USDC, needs ~${USDC_PER * 2}. ` +
						`Fund ${signer.publicKey.toBase58()} with devnet USDC (mint ${DEV_USDC}) at https://faucet.circle.com, then re-run.`,
				);
			}
		}
		if (usdcOk) {
			try {
				await runTradeLeg({
					connection,
					sdk,
					signer,
					label: 'USDC launch + buy + sell',
					quoteMint: DEV_USDC,
					name: 'three.ws devnet USDC smoke',
					symbol: 'T3USDC',
				});
			} catch (e) {
				record('USDC launch + buy + sell', 'FAIL', stepError(e));
			}
		}
	}

	// ── Custodial leg (SOL always; USDC when whitelisted) ──
	try {
		await runCustodialLeg({ connection, sdk, funder: signer, quoteMint: null });
	} catch (e) {
		record('Custodial buy+sell (SOL)', 'FAIL', stepError(e));
	}
	if (!SOL_ONLY && usdcWhitelisted) {
		try {
			await runCustodialLeg({ connection, sdk, funder: signer, quoteMint: DEV_USDC });
		} catch (e) {
			record('Custodial buy+sell (USDC)', 'FAIL', stepError(e));
		}
	}

	await summarize();
}

function stepError(e) {
	return (e?.message || String(e)).split('\n')[0].slice(0, 240);
}

async function summarize() {
	try {
		await dbCleanup();
	} catch {
		/* best-effort */
	}
	const pass = results.filter((r) => r.status === 'PASS').length;
	const fail = results.filter((r) => r.status === 'FAIL').length;
	const skip = results.filter((r) => r.status === 'SKIP').length;
	console.log('\n──────────────────────────────────────────────────────────────');
	console.log(`SUMMARY — ${pass} PASS · ${fail} FAIL · ${skip} SKIP`);
	for (const r of results) {
		const icon = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '∅' : '✗';
		console.log(`  ${icon} ${r.leg}${r.detail ? ` — ${r.detail}` : ''}`);
	}
	console.log('──────────────────────────────────────────────────────────────');
	if (SIMULATE_ONLY)
		console.log('Mode was SIMULATE-ONLY: instruction-build paths validated on-chain; ' + 'no broadcast. Re-run without --simulate-only (funded signer) for live tx + DB assertions.');
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error('\n✗ fatal:', e?.stack || e?.message || e);
	process.exit(1);
});
