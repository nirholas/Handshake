// `wallet_create` — generate a fresh Solana keypair locally and (optionally)
// attach it to an avatar session. With `vanityPrefix` / `vanitySuffix` the
// tool grinds keys until the base58 pubkey matches — useful for spawning a
// "three…" or "…wsai" themed wallet on the fly.
//
// The secret is returned base58-encoded ONCE. The MCP server does not
// persist it. The caller is responsible for storing it safely.

import { Keypair } from '@solana/web3.js';
import { z } from 'zod';

import { bs58encode, grindVanity } from '../lib/solana.js';
import { getSession, updateSession } from '../lib/avatars.js';

export const def = {
	name: 'wallet_create',
	title: 'Create a Solana wallet (optionally vanity-grinded)',
	description:
		'Generate a Solana keypair locally. Optionally grind for a base58 prefix/suffix (e.g. "three") and/or attach it to an avatar session. Returns the base58 pubkey and secret ONCE — store the secret yourself; the MCP does not persist it.',
	inputSchema: {
		sessionId: z.string().optional().describe('If set, the wallet is attached to this avatar session.'),
		vanityPrefix: z.string().max(8).optional().describe('Base58 prefix to grind for (e.g. "three"). Up to 8 chars.'),
		vanitySuffix: z.string().max(8).optional().describe('Base58 suffix to grind for. Up to 8 chars.'),
		caseSensitive: z.boolean().optional().describe('Match case-sensitively (default true). Base58 has no 0OIl so set false to be permissive.'),
		maxAttempts: z.number().int().min(1).max(2_000_000).optional()
			.describe('Cap on grind attempts (default 500_000). Bump for longer prefixes.'),
	},
	async handler(args) {
		const { sessionId, vanityPrefix, vanitySuffix, caseSensitive = true, maxAttempts } = args || {};

		let pubkey;
		let secret;
		let grind = null;
		if (vanityPrefix || vanitySuffix) {
			grind = grindVanity({ prefix: vanityPrefix, suffix: vanitySuffix, caseSensitive, maxAttempts: maxAttempts || 500_000 });
			if (!grind.found) {
				return { ok: false, error: 'vanity_not_found', ...grind };
			}
			pubkey = grind.pubkey;
			secret = grind.secret;
		} else {
			const kp = Keypair.generate();
			pubkey = kp.publicKey.toBase58();
			secret = bs58encode(kp.secretKey);
		}

		let session = null;
		if (sessionId) {
			session = getSession(sessionId);
			if (!session) {
				return { ok: false, error: 'unknown_session', message: `No session ${sessionId}.` };
			}
			updateSession(sessionId, { wallet: { pubkey, hasSecret: true } });
		}

		return {
			ok: true,
			pubkey,
			secret,
			warning:
				'This secret is shown ONCE. The MCP server does not persist it. Store it in a password manager or hardware wallet; treat it like cash.',
			sessionId: session?.id || null,
			vanity: grind ? { attempts: grind.attempts, durationMs: grind.durationMs } : null,
			explorer: `https://solscan.io/account/${pubkey}`,
		};
	},
};
