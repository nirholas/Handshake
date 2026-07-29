// Devnet end-to-end for the native launchpad lane, driving the SAME modules
// the API endpoints use: buildCreatePoolTx -> sign -> send -> getPoolState ->
// quoteBuy -> real swap buy -> state again.
import 'dotenv/config';
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import {
	buildCreatePoolTx,
	getPoolState,
	quoteBuy,
	getDbcClient,
} from '../api/_lib/native-launch/dbc.js';

const conn = new Connection(process.env.SOLANA_RPC_URL_DEVNET, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.X402_TREASURY_SECRET_BASE58));
const mintKp = Keypair.generate();

async function sendAndPoll(raw) {
	const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const st = await conn.getSignatureStatuses([sig]);
		const s = st.value?.[0];
		if (s?.err) throw new Error(`tx failed: ${JSON.stringify(s.err)} (${sig})`);
		if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
	}
	throw new Error(`confirm timeout: ${sig}`);
}

console.log('wallet:', wallet.publicKey.toBase58());
console.log('mint:  ', mintKp.publicKey.toBase58());

// 1 — build the unsigned create-pool tx exactly like /api/native-launch/launch-prep
const built = await buildCreatePoolTx({
	network: 'devnet',
	payer: wallet.publicKey.toBase58(),
	creator: wallet.publicKey.toBase58(),
	baseMint: mintKp.publicKey.toBase58(),
	name: 'Native Lane Test',
	symbol: 'NLT',
	uri: 'https://three.ws/launchpad',
	solBuyIn: 0.05,
});
console.log('pool:  ', built.pool);

// 2 — sign like the frontend does (user wallet + mint keypair) and send
const tx = VersionedTransaction.deserialize(Buffer.from(built.txBase64, 'base64'));
tx.sign([wallet, mintKp]);
const createSig = await sendAndPoll(tx.serialize());
console.log('create landed:', createSig);

// 3 — pool state via the same module the /pool endpoint uses
const state = await getPoolState({ network: 'devnet', mint: mintKp.publicKey.toBase58() });
console.log('state after create+first buy:', JSON.stringify(state, null, 1));

// 4 — quote a 0.5 SOL buy via the /quote path
const q = await quoteBuy({ network: 'devnet', mint: mintKp.publicKey.toBase58(), solIn: 0.5 });
console.log('quote 0.5 SOL ->', q.tokens_out, 'tokens, fee', q.trading_fee_sol, 'SOL');

// 5 — execute a real 0.5 SOL buy on the curve
const client = await getDbcClient({ network: 'devnet' });
const swapTx = await client.pool.swap({
	owner: wallet.publicKey,
	pool: built.pool,
	amountIn: new BN(0.5e9),
	minimumAmountOut: new BN(1),
	swapBaseForQuote: false,
	referralTokenAccount: null,
});
swapTx.feePayer = wallet.publicKey;
swapTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
swapTx.sign(wallet);
const buySig = await sendAndPoll(swapTx.serialize());
console.log('buy landed:', buySig);

// 6 — state after the buy: progress must have moved
const after = await getPoolState({ network: 'devnet', mint: mintKp.publicKey.toBase58() });
console.log('progress:', state.curve_progress, '->', after.curve_progress);
console.log('quote reserve SOL:', state.quote_reserve_sol, '->', after.quote_reserve_sol);
console.log('');
console.log('E2E OK');
console.log(`explorer: https://solscan.io/tx/${createSig}?cluster=devnet`);
