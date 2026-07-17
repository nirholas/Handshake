/**
 * SolanaAdapter — Phantom / Backpack / Solflare via window injection.
 *
 * Two responsibilities the EVM adapter doesn't have:
 *  1. Inline SIWS linking. If the wallet isn't yet linked to the user's
 *     account, this adapter runs the SIWS challenge as part of `connect()` so
 *     the deploy flow stays single-click. Implementation mirrors
 *     public/wallet/connect-button-solana.js but is callable headlessly.
 *  2. Cluster control. We always submit the signed tx through a Connection we
 *     construct on the chosen cluster, never via the wallet's
 *     signAndSendTransaction default — the wallet's RPC may be on a different
 *     cluster than the one the user picked in the UI.
 */

import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import { solana } from '../chain-ref.js';

// Route through our same-origin proxy. The public mainnet RPC returns 403 to
// most browser origins; the proxy forwards server-side to Helius when
// HELIUS_API_KEY is set. Absolute URL because Connection() derives a WS URL.
const RPC_ORIGIN =
	typeof window !== 'undefined' && window.location?.origin
		? window.location.origin
		: 'https://three.ws';
const RPC = {
	mainnet: `${RPC_ORIGIN}/api/solana-rpc`,
	devnet: `${RPC_ORIGIN}/api/solana-rpc?net=devnet`,
};

function detect(preferred) {
	if (typeof window === 'undefined') return null;
	if (preferred === 'phantom') return window.phantom?.solana || window.solana || null;
	if (preferred === 'backpack') return window.backpack?.solana || null;
	if (preferred === 'solflare') return window.solflare || null;
	// Seeker / Saga: solana-mobile/src/index.js installs an MWA-backed wallet
	// at window.threeWsWallet (and mirrors it onto window.solana). It has
	// isThreeWs=true and isPhantom=false, so we check for it first when no
	// specific provider was requested.
	if (window.threeWsWallet?.isThreeWs) return window.threeWsWallet;
	if (window.solana?.isThreeWs) return window.solana;
	if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
	if (window.solana?.isPhantom) return window.solana;
	if (window.backpack?.solana) return window.backpack.solana;
	if (window.solflare?.isSolflare) return window.solflare;
	return null;
}

function toBase64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}

function decodeTx(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	try {
		return VersionedTransaction.deserialize(bytes);
	} catch {
		return Transaction.from(bytes);
	}
}

/** @implements {import('./base.js').WalletAdapter} */
export class SolanaAdapter {
	#provider = null;
	#address = null;
	#preferred;

	constructor({ preferredWallet = null } = {}) {
		this.#preferred = preferredWallet;
	}

	get family() {
		return 'solana';
	}

	isAvailable() {
		return !!detect(this.#preferred);
	}

	installUrl() {
		if (this.#preferred === 'backpack') return 'https://www.backpack.app';
		if (this.#preferred === 'solflare') return 'https://solflare.com';
		return 'https://phantom.app';
	}

	/**
	 * Connect, and if the wallet isn't linked to the current session, run SIWS
	 * inline so the caller doesn't have to redirect the user.
	 * @param {{ ensureLinked?: boolean, cluster?: 'mainnet'|'devnet' }} [opts]
	 */
	async connect({ ensureLinked = true, cluster = 'mainnet' } = {}) {
		const provider = detect(this.#preferred);
		if (!provider) {
			const err = new Error('No Solana wallet detected.');
			err.code = 'NO_PROVIDER';
			throw err;
		}
		this.#provider = provider;

		let resp;
		try {
			resp = await provider.connect();
		} catch (e) {
			if (e?.code === 4001 || /reject/i.test(e?.message || '')) {
				const err = new Error('Connection cancelled.');
				err.code = 'USER_REJECTED';
				throw err;
			}
			throw e;
		}
		this.#address = (resp?.publicKey || provider.publicKey)?.toString();
		if (!this.#address) throw new Error('Could not read Solana wallet address.');

		if (ensureLinked) {
			await this.#ensureLinkedViaSiws(cluster);
		}

		return { address: this.#address, ref: solana(cluster) };
	}

	async switchTo(ref) {
		// Solana wallets don't expose a switchCluster RPC. We respect the user's
		// selection by sending the tx to our own Connection on the chosen
		// cluster (see signAndSend). Nothing to do here.
		if (ref.family !== 'solana') throw new Error('SolanaAdapter cannot switch to non-Solana');
	}

	async signAndSend(prep, ref) {
		if (ref.family !== 'solana') throw new Error('SolanaAdapter expects a Solana ChainRef');
		if (!this.#provider) throw new Error('Wallet not connected');
		if (!prep.txBase64) throw new Error('Solana prep missing txBase64');

		const tx = decodeTx(prep.txBase64);
		const conn = new Connection(RPC[ref.cluster], 'confirmed');

		// Always go through signTransaction + our own Connection so we control
		// which cluster the tx lands on. Avoids the silent mismatch where
		// Phantom is set to mainnet but the user picked devnet (or vice versa).
		let signed;
		try {
			signed = await this.#provider.signTransaction(tx);
		} catch (e) {
			if (e?.code === 4001 || /reject/i.test(e?.message || '')) {
				const err = new Error('Signature cancelled.');
				err.code = 'USER_REJECTED';
				throw err;
			}
			throw e;
		}

		const raw = signed.serialize();
		const signature = await conn.sendRawTransaction(raw, {
			skipPreflight: false,
			preflightCommitment: 'confirmed',
		});

		// Poll signature status with a real deadline. confirmTransaction is
		// deprecated and unreliable on devnet.
		await this.#waitForConfirmation(conn, signature, 60_000);

		return { txHash: signature, onchainId: prep.assetPubkey || null };
	}

	async #waitForConfirmation(conn, signature, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { value } = await conn.getSignatureStatuses([signature]);
			const status = value?.[0];
			if (status) {
				if (status.err) {
					const e = new Error(`Tx failed: ${JSON.stringify(status.err)}`);
					e.code = 'TX_FAILED';
					throw e;
				}
				if (
					status.confirmationStatus === 'confirmed' ||
					status.confirmationStatus === 'finalized'
				) {
					return;
				}
			}
			await new Promise((r) => setTimeout(r, 1_000));
		}
		const e = new Error('Confirmation timed out after 60s. Tx may still land — check explorer.');
		e.code = 'TX_TIMEOUT';
		throw e;
	}

	async #ensureLinkedViaSiws(cluster) {
		// Cheap pre-check: if already linked for this user+address, skip the
		// signature prompt. Uses an existing endpoint that returns 200 if the
		// session has any linked Solana wallet, 404 otherwise. We tolerate any
		// non-200 here and fall through to the SIWS path.
		try {
			const r = await fetch(
				`/api/auth/wallets/check?chain_type=solana&address=${encodeURIComponent(this.#address)}`,
				{ credentials: 'include' },
			);
			if (r.ok) {
				const data = await r.json().catch(() => ({}));
				if (data?.linked) return;
			}
		} catch {
			/* non-fatal — proceed with SIWS */
		}

		const nonceRes = await fetch('/api/auth/siws/nonce', { credentials: 'include' });
		if (!nonceRes.ok) throw new Error('Could not start wallet linking: nonce request failed.');
		const { nonce, csrf } = await nonceRes.json();

		const domain = location.host;
		const uri = location.origin;
		const issuedAt = new Date().toISOString();
		const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
		const statement =
			'Link this wallet to deploy your agent on Solana. No fees, no transaction. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).';

		// One-tap path (Seeker / Seed Vault via MWA): authorize + SIWS signature
		// in a single wallet interaction. The wallet builds the canonical SIWS
		// message itself, so we forward the exact bytes it signed to /verify.
		// Any wallet without supportsSignIn (Phantom, Backpack, Solflare) skips
		// straight to the two-step path below; a one-tap failure that ISN'T a
		// user rejection also falls through, so linking degrades gracefully.
		if (this.#provider.supportsSignIn && typeof this.#provider.signIn === 'function') {
			try {
				const siws = await this.#provider.signIn({
					domain, statement, uri, version: '1',
					chainId: cluster, nonce, issuedAt, expirationTime,
				});
				if (siws?.signedMessageText && siws.signature) {
					const verifyRes = await fetch('/api/auth/siws/verify', {
						method: 'POST',
						credentials: 'include',
						headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
						body: JSON.stringify({
							message: siws.signedMessageText,
							signature: toBase64(siws.signature),
							tosAccepted: true,
						}),
					});
					if (verifyRes.ok) return;
					// Server couldn't verify the wallet-built message — burn was
					// on the nonce, so re-fetch a fresh one for the fallback.
					const retry = await fetch('/api/auth/siws/nonce', { credentials: 'include' });
					if (retry.ok) {
						const next = await retry.json();
						return this.#linkWithSignMessage(cluster, next.nonce, next.csrf, {
							domain, uri, statement,
						});
					}
				}
			} catch (e) {
				if (e?.code === 4001 || e?.reason === 'USER_REJECTED' || /reject/i.test(e?.message || '')) {
					const err = new Error('Wallet linking cancelled.');
					err.code = 'USER_REJECTED';
					throw err;
				}
				// Non-rejection failure: fall through to the two-step path.
			}
		}

		return this.#linkWithSignMessage(cluster, nonce, csrf, { domain, uri, statement });
	}

	// Two-step SIWS: build the message, prompt signMessage, verify. Used by
	// injected wallets and as the Seed Vault fallback.
	async #linkWithSignMessage(cluster, nonce, csrf, { domain, uri, statement }) {
		const issuedAt = new Date().toISOString();
		const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
		const message = [
			`${domain} wants you to sign in with your Solana account:`,
			this.#address,
			'',
			statement,
			'',
			`URI: ${uri}`,
			'Version: 1',
			`Chain ID: ${cluster}`,
			`Nonce: ${nonce}`,
			`Issued At: ${issuedAt}`,
			`Expiration Time: ${expirationTime}`,
		].join('\n');

		const msgBytes = new TextEncoder().encode(message);
		let sig;
		try {
			const out = await this.#provider.signMessage(msgBytes, 'utf8');
			sig = out.signature;
		} catch (e) {
			if (e?.code === 4001 || /reject/i.test(e?.message || '')) {
				const err = new Error('Wallet linking cancelled.');
				err.code = 'USER_REJECTED';
				throw err;
			}
			throw e;
		}

		const verifyRes = await fetch('/api/auth/siws/verify', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
			// tosAccepted: the signed statement carries the agreement; the flag
			// tells the server to stamp acceptance on the user record.
			body: JSON.stringify({ message, signature: toBase64(sig), tosAccepted: true }),
		});
		if (!verifyRes.ok) {
			const data = await verifyRes.json().catch(() => ({}));
			throw new Error(data.error_description || 'Wallet linking failed.');
		}
	}
}
