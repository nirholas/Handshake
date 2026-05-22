// Atomic pump.fun token launch via a Jito bundle.
//
// Ported from nirholas/atomic's fire-jito.js. Two-tx bundle:
//   Tx 1 (funder pays fee + tip): transfer rent SOL to creator + Jito tip
//   Tx 2 (creator pays fee):     pump.fun createV2 instruction
//
// Both txs share the same recent blockhash and are submitted as a bundle to
// Jito's mainnet block engine. Either both land or neither does — so no
// MEV searcher can interleave, and the creator wallet doesn't need to hold
// SOL before the launch.
//
// This is the "real launch" path: the on-chain `creator` field on the mint
// is the creator wallet, not the funder. That matters because pump.fun's
// creator-fee accrual follows the creator key.

import {
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import FormData from 'form-data';

import { bs58encode, bs58decode, getConnection, keypairFromSecret } from './solana.js';
import { JITO_TIP_ACCOUNTS, randomTipAccount, submitBundle, waitForSignatures } from './jito.js';

const PUMP_IPFS_URL = 'https://pump.fun/api/ipfs';

// Upload token metadata + image to pump.fun's IPFS endpoint. Returns the
// metadata URI you feed into createV2. If no imageUrl is provided we use a
// 1x1 transparent PNG placeholder so the form is valid; pass an imageUrl
// to use a real image fetched at upload time.
export async function uploadPumpMetadata({ name, symbol, description = '', twitter = '', telegram = '', website = '', imageUrl, showName = true }) {
	if (!name) throw new Error('uploadPumpMetadata: name is required');
	if (!symbol) throw new Error('uploadPumpMetadata: symbol is required');
	const form = new FormData();
	let imageBuf;
	let imageName = 'placeholder.png';
	let imageType = 'image/png';
	if (imageUrl) {
		const r = await fetch(imageUrl);
		if (!r.ok) throw new Error(`Failed to fetch imageUrl: HTTP ${r.status}`);
		imageBuf = Buffer.from(await r.arrayBuffer());
		const ext = (imageUrl.split('?')[0].split('.').pop() || 'png').toLowerCase();
		imageName = `image.${ext}`;
		imageType = r.headers.get('content-type') || imageType;
	} else {
		imageBuf = Buffer.from(
			'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154' +
			'78da63fcffff3f0305000601018a0c1d990000000049454e44ae426082',
			'hex',
		);
	}
	form.append('file', imageBuf, { filename: imageName, contentType: imageType });
	form.append('name', name);
	form.append('symbol', symbol);
	form.append('description', description);
	form.append('twitter', twitter);
	form.append('telegram', telegram);
	form.append('website', website);
	form.append('showName', String(showName));

	const res = await fetch(PUMP_IPFS_URL, {
		method: 'POST',
		body: form,
		headers: form.getHeaders(),
	});
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		throw new Error(`pump.fun IPFS upload failed (${res.status}): ${txt.slice(0, 300)}`);
	}
	const json = await res.json();
	return {
		uri: json.metadataUri || json.metadata_uri || null,
		raw: json,
	};
}

export async function atomicLaunch({
	name,
	symbol,
	uri,
	funderSecret,
	creatorSecret,
	mintSecret,
	rentSol = 0.035,
	jitoTipSol = 0.005,
	priorityMicroLamports = 2_000_000,
	mayhemMode = false,
	cashback = false,
}) {
	if (!name) throw new Error('atomicLaunch: name is required');
	if (!symbol) throw new Error('atomicLaunch: symbol is required');
	if (!uri) throw new Error('atomicLaunch: uri is required (call uploadPumpMetadata first or pass an existing one)');

	const funder = keypairFromSecret(funderSecret);
	const creator = keypairFromSecret(creatorSecret);
	const mint = mintSecret
		? Keypair.fromSecretKey(bs58decode(mintSecret))
		: Keypair.generate();

	// pump-sdk is a CJS module — import dynamically so this file can stay ESM.
	const pumpSdkPkg = await import('@nirholas/pump-sdk');
	const PUMP_SDK = pumpSdkPkg.PUMP_SDK || pumpSdkPkg.default?.PUMP_SDK;
	if (!PUMP_SDK || typeof PUMP_SDK.createV2Instruction !== 'function') {
		throw new Error('@nirholas/pump-sdk: PUMP_SDK.createV2Instruction not found in installed version');
	}

	const conn = getConnection();
	const funderBal = await conn.getBalance(funder.publicKey, 'confirmed');
	const needed = (rentSol + jitoTipSol + 0.002) * LAMPORTS_PER_SOL;
	if (funderBal < needed) {
		const err = new Error(
			`Funder needs >= ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL; has ${(funderBal / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
		);
		err.code = 'insufficient_funds';
		throw err;
	}

	const tipAccount = randomTipAccount();
	const { blockhash } = await conn.getLatestBlockhash('confirmed');

	const tx1Msg = new TransactionMessage({
		payerKey: funder.publicKey,
		recentBlockhash: blockhash,
		instructions: [
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
			ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
			SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creator.publicKey, lamports: Math.floor(rentSol * LAMPORTS_PER_SOL) }),
			SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: tipAccount, lamports: Math.floor(jitoTipSol * LAMPORTS_PER_SOL) }),
		],
	}).compileToV0Message();
	const tx1 = new VersionedTransaction(tx1Msg);
	tx1.sign([funder]);

	const createIx = await PUMP_SDK.createV2Instruction({
		mint: mint.publicKey,
		name,
		symbol,
		uri,
		creator: creator.publicKey,
		user: creator.publicKey,
		mayhemMode,
		cashback,
	});
	const tx2Msg = new TransactionMessage({
		payerKey: creator.publicKey,
		recentBlockhash: blockhash,
		instructions: [
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
			ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
			createIx,
		],
	}).compileToV0Message();
	const tx2 = new VersionedTransaction(tx2Msg);
	tx2.sign([creator, mint]);

	const bundle = [bs58encode(tx1.serialize()), bs58encode(tx2.serialize())];
	const { bundleId, explorer } = await submitBundle(bundle);

	const sig1 = bs58encode(tx1.signatures[0]);
	const sig2 = bs58encode(tx2.signatures[0]);
	const wait = await waitForSignatures(conn, [sig1, sig2], { timeoutMs: 60_000, intervalMs: 2_000 });

	return {
		ok: wait.ok,
		bundleId,
		bundleExplorer: explorer,
		mint: mint.publicKey.toBase58(),
		mintSecret: bs58encode(mint.secretKey),
		creator: creator.publicKey.toBase58(),
		funder: funder.publicKey.toBase58(),
		tx1Signature: sig1,
		tx2Signature: sig2,
		statuses: wait.statuses,
		err: wait.err,
		pumpUrl: `https://pump.fun/coin/${mint.publicKey.toBase58()}`,
		fundingTxExplorer: `https://solscan.io/tx/${sig1}`,
		createTxExplorer: `https://solscan.io/tx/${sig2}`,
	};
}
