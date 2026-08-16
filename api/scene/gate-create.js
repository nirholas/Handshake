// POST /api/scene/gate-create
//
// Turns a chat scene share into a token-gated one: the caller supplies the scene
// ref (a sync.three.ws short id or an inline blob) plus a holding requirement, and
// gets back a share URL carrying the gate id. Visitors opening that URL must prove
// the holding through api/scene/gate-check.js before the scene loads.
//
// The gate asset is a runtime parameter (the coin-agnostic plumbing exception in
// CLAUDE.md) so any community can gate with its own token or collection; this
// endpoint never defaults to or suggests a mint.
//
// chain and kind are validated as a PAIR. A gate stored as solana/erc20 would pass
// per-field validation and then be unverifiable forever, since gate-check reads
// Solana kinds on Solana and EVM kinds on Ethereum. Rejecting the combination here
// is the only place it can be caught before it becomes a dead share link.
import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { parse } from '../_lib/validate.js';
import { randomToken } from '../_lib/crypto.js';

const KINDS_BY_CHAIN = {
	solana: ['spl', 'collection'],
	evm: ['erc20', 'erc721'],
};

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const bodySchema = z
	.object({
		sceneRef: z.string().trim().min(1).max(8000),
		gate: z.object({
			chain: z.enum(['solana', 'evm']),
			kind: z.enum(['spl', 'collection', 'erc20', 'erc721']),
			address: z.string().trim().min(1).max(128),
			minBalance: z.number().positive().default(1),
		}),
	})
	.superRefine((value, ctx) => {
		const { chain, kind, address } = value.gate;
		if (!KINDS_BY_CHAIN[chain].includes(kind)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['gate', 'kind'],
				message: `kind must be one of ${KINDS_BY_CHAIN[chain].join(', ')} for chain ${chain}`,
			});
		}
		const addressOk = chain === 'solana' ? SOLANA_ADDRESS_RE.test(address) : EVM_ADDRESS_RE.test(address);
		if (!addressOk) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['gate', 'address'],
				message: chain === 'solana' ? 'address must be a base58 Solana address' : 'address must be a 0x-prefixed EVM address',
			});
		}
	});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(bodySchema, await readJson(req));

	let gateId = '';
	while (gateId.length < 12) {
		gateId += randomToken(16).replace(/[^A-Za-z0-9]/g, '');
	}
	gateId = gateId.slice(0, 12);

	await sql`
		insert into scene_gates (id, user_id, scene_ref, chain, kind, address, min_balance)
		values (${gateId}, ${userId}, ${body.sceneRef}, ${body.gate.chain}, ${body.gate.kind}, ${body.gate.address}, ${body.gate.minBalance})
	`;

	// Short refs (sync.three.ws shortIds) are up to 40 alphanumeric chars; blobs are much longer
	const isShortRef = body.sceneRef.length <= 40 && /^[A-Za-z0-9_-]+$/.test(body.sceneRef);
	const shareUrl = isShortRef
		? `${env.APP_ORIGIN}/chat?sl=${body.sceneRef}&gate=${gateId}`
		: `${env.APP_ORIGIN}/chat?s=${encodeURIComponent(body.sceneRef)}&gate=${gateId}`;

	return json(res, 201, { shareUrl, gateId });
});
