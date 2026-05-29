// Solana Attestation Service (SAS) helpers — server-side issuance.
//
// Used to issue *credentialed* attestations: things only three.ws (or our
// authorized validators) can write. Permissionless attestations (general
// feedback, task lifecycle, dispute, revoke) keep using SPL Memos — see
// solana-attestations.js.
//
// The authority secret signs every SAS attestation written by this server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import {
	createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
	address, generateKeyPair, getAddressFromPublicKey,
	pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
	signTransactionMessageWithSigners, getSignatureFromTransaction,
	sendAndConfirmTransactionFactory,
} from '@solana/kit';
import {
	deriveAttestationPda, getCreateAttestationInstruction, getCloseAttestationInstruction,
	deriveEventAuthorityAddress,
} from 'sas-lib';
import { BorshSchema } from 'borsher';

// Resolve sas-config.json in a bundle-safe way. scripts/bundle-api.mjs inlines
// this module into each API entry with esbuild, which rewrites import.meta.url
// to the OUTPUT file's location — so an import.meta-relative `../../sdk/src/...`
// resolves to a bogus api/sdk/src/... path and ENOENTs at load. process.cwd() is
// /var/task on Vercel (the file ships via vercel.json includeFiles) and the repo
// root in dev; the import.meta path stays as a fallback for unbundled callers.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_CANDIDATES = [
	path.join(process.cwd(), 'sdk', 'src', 'sas-config.json'),
	path.join(__dirname, '..', '..', 'sdk', 'src', 'sas-config.json'),
];
const CONFIG = (() => {
	let lastErr;
	for (const candidate of CONFIG_CANDIDATES) {
		try {
			return JSON.parse(fs.readFileSync(candidate, 'utf8'));
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
})();

const RPC = {
	mainnet: process.env.SOLANA_RPC_URL        || 'https://api.mainnet-beta.solana.com',
	devnet:  process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com',
};

const TYPE_TO_BORSH = {
	0: BorshSchema.u8, 10: BorshSchema.bool, 12: BorshSchema.String,
};

function buildBorsh(layout, fieldNames) {
	const fields = {};
	layout.forEach((b, i) => {
		const t = TYPE_TO_BORSH[b];
		if (!t) throw new Error(`unsupported layout byte ${b}`);
		fields[fieldNames[i]] = t;
	});
	return BorshSchema.Struct(fields);
}

function authoritySigner() {
	const secret = process.env.SAS_AUTHORITY_SECRET;
	if (!secret) throw new Error('SAS_AUTHORITY_SECRET not configured');
	return createKeyPairSignerFromBytes(bs58.decode(secret));
}

function pdas(network) {
	const p = CONFIG.pdas?.[network];
	if (!p?.credential) throw new Error(`SAS not bootstrapped for ${network} — run scripts/sas-bootstrap.js ${network}`);
	return p;
}

/**
 * Issue a SAS attestation under one of our schemas.
 *
 * @param {object} opts
 * @param {string} opts.kind     — e.g. 'threews.verified-client.v1'
 * @param {string} opts.subject  — base58 pubkey the attestation is about (used as nonce)
 * @param {object} opts.data     — fields matching the schema's layout
 * @param {bigint|number} [opts.expiry=0]  — unix seconds; 0 = no expiry
 * @param {'mainnet'|'devnet'} opts.network
 * @returns {Promise<{signature, attestation_pda, schema_pda, credential_pda}>}
 */
export async function sasIssue({ kind, subject, data, expiry = 0, network }) {
	const def = CONFIG.schemas[kind];
	if (!def) throw new Error(`unknown schema kind ${kind}`);
	const p = pdas(network);
	const schemaPda = p.schemas[kind];
	if (!schemaPda) throw new Error(`schema ${kind} not registered on ${network}`);

	const borsh = buildBorsh(def.layout, def.fieldNames);
	const dataBytes = borsh.serialize(data);

	const authority = await authoritySigner();
	const subjectAddr = address(subject);
	const [attestationPda] = await deriveAttestationPda({
		credential: address(p.credential),
		schema:     address(schemaPda),
		nonce:      subjectAddr,
	});

	const ix = getCreateAttestationInstruction({
		payer:       authority,
		authority,
		credential:  address(p.credential),
		schema:      address(schemaPda),
		attestation: attestationPda,
		nonce:       subjectAddr,
		data:        dataBytes,
		expiry:      BigInt(expiry),
	});

	const sig = await sendIx(network, authority, ix);
	return {
		signature: sig,
		attestation_pda: attestationPda,
		schema_pda: schemaPda,
		credential_pda: p.credential,
	};
}

/**
 * Close (revoke) a SAS attestation we issued. Only the credential authority
 * can close.
 */
export async function sasClose({ kind, subject, network }) {
	const p = pdas(network);
	const schemaPda = p.schemas[kind];
	const authority = await authoritySigner();
	const [attestationPda] = await deriveAttestationPda({
		credential: address(p.credential),
		schema:     address(schemaPda),
		nonce:      address(subject),
	});
	const eventAuthority = await deriveEventAuthorityAddress();

	const ix = getCloseAttestationInstruction({
		payer:          authority,
		authority,
		credential:     address(p.credential),
		attestation:    attestationPda,
		eventAuthority,
		attestationProgram: undefined,
	});
	const sig = await sendIx(network, authority, ix);
	return { signature: sig, attestation_pda: attestationPda };
}

async function sendIx(network, payer, ix) {
	const rpcUrl = RPC[network];
	const rpc      = createSolanaRpc(rpcUrl);
	const rpcSubs  = createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, 'ws'));
	const send     = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubs });

	const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
	const msg = pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(payer, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
		(m) => appendTransactionMessageInstructions([ix], m),
	);
	const signed = await signTransactionMessageWithSigners(msg);
	await send(signed, { commitment: 'confirmed' });
	return getSignatureFromTransaction(signed);
}

export const SAS_CONFIG = CONFIG;
