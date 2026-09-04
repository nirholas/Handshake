// POST /api/knock/escrowed
//
// The escrowed lane. A stranger pays a door's price into an on-chain vault the
// recipient cannot touch until they answer, and this endpoint delivers the
// message against that escrow.
//
// The other two lanes both settle before the recipient has done anything: the
// free lane charges nothing, and the x402 lane sends the USDC straight to the
// recipient's wallet the instant it clears. Between people who already know
// each other that is right. Between strangers it is the whole risk, because a
// door can bank every knock and answer none, and the sender has no recourse.
//
// Here the sender signs the `knock` instruction themselves on the knock_escrow
// program (contracts/knock-escrow) BEFORE calling this, which parks their
// payment in a vault owned by the knock's own PDA. Then exactly three things
// can happen to that money, and three.ws is not one of them:
//
//   - the owner answers inside the window and is paid;
//   - the owner refuses and the sender is refunded in full, with no fee;
//   - the window lapses and anyone at all can crank the refund.
//
// So this handler has no custody and no signing key in the path. All it does is
// read the chain, refuse anything the chain does not back, and deliver. The
// sender is told the escrow's deadline in the response, because the one thing
// they need to know afterwards is when to stop waiting.
//
// The order of operations is the same as the paid lane's and for the same
// reason: the door's own limits are checked BEFORE the escrow is read, so a
// message that was going to be rejected for being too long, or aimed at a door
// that is shut or full for the day, is refused without the sender ever being
// told their escrow was accepted.

import { z } from 'zod';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { normalizeHandle } from '../_lib/knock/policy.js';
import { publicDoorByHandle, payoutFor, findByEscrowKnock } from '../_lib/knock/store.js';
import { checkDoor, deliverKnock } from '../_lib/knock/deliver.js';
import { receiptUrl } from '../_lib/knock/receipt.js';
import { rpcFallbackFromEnv } from '../_lib/solana/rpc-fallback.js';
import { verifyEscrowedKnock, EscrowRejected, KNOCK_ESCROW_PROGRAM_ID } from '../_lib/knock/escrow.js';

const body = z.object({
	to: z.string().trim().min(1).max(40),
	from: z.string().trim().min(1).max(64),
	message: z.string().min(1).max(2000),
	subject: z.string().trim().max(120).optional(),
	url: z.string().trim().max(400).optional(),
	sender_kind: z.enum(['agent', 'human', 'unknown']).optional(),
	request_id: z.string().trim().max(80).optional(),
	// The wallet that signed the on-chain knock. Together with the door and the
	// nonce this is what derives the knock's address; it is not trusted for
	// anything else, because the account it points at either exists with the
	// right contents or the request is refused.
	sender_wallet: z.string().trim().min(32).max(44),
	nonce: z.union([z.number().int().min(0), z.string().regex(/^\d{1,20}$/)]),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Same bucket as the free lane. An escrowed knock costs the sender real
	// money, but deriving and reading an account costs US an RPC round trip, and
	// a caller can make that call with no escrow at all.
	const rl = await limits.knockSendIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many escrow checks from one address');

	const input = parse(body, await readJson(req));
	const handle = normalizeHandle(input.to);
	const door = await publicDoorByHandle(handle);
	if (!door) return error(res, 404, 'no_door', 'no open door for that handle');
	if (!door.escrow_enabled) {
		return error(res, 409, 'escrow_not_enabled', `${door.display_name || handle} does not take escrowed knocks`, {
			lane: String(door.price_atomics) === '0' ? 'free' : 'x402',
			endpoint:
				String(door.price_atomics) === '0'
					? '/api/knock/send'
					: `/api/x402/knock?to=${encodeURIComponent(handle)}`,
		});
	}

	// The recipient's Solana address is both where an answer pays out and the
	// owner half of the door's PDA, so a door with no address has no on-chain
	// door to knock at.
	const payout = await payoutFor(door.user_id);
	if (!payout?.pay_to_solana) {
		return error(res, 409, 'no_payout_wallet', 'that door has no Solana address, so it has no on-chain door');
	}

	// Door limits first: never tell a sender their escrow was accepted for a
	// message this door was always going to refuse.
	const { clean } = await checkDoor(door.user_id, { ...input, payer_wallet: input.sender_wallet });

	let escrow;
	try {
		const rpc = rpcFallbackFromEnv({ network: 'mainnet' });
		escrow = await rpc.withFallback((connection) =>
			verifyEscrowedKnock(connection, {
				ownerWallet: payout.pay_to_solana,
				handle,
				sender: input.sender_wallet,
				nonce: input.nonce,
				message: clean.message,
				minPriceAtomics: BigInt(door.price_atomics),
			}),
		);
	} catch (err) {
		if (err instanceof EscrowRejected) {
			// 402 for "there is no payment here", 409 for "there is one and it is
			// not usable". The difference tells a client whether to go and knock
			// on-chain or to stop retrying.
			const status = err.code === 'knock_not_found' ? 402 : 409;
			return error(res, status, err.code, err.message, {
				...err.detail,
				program: KNOCK_ESCROW_PROGRAM_ID,
			});
		}
		throw err;
	}

	// One escrowed knock buys exactly one message. The unique index enforces it;
	// this returns the original delivery rather than a constraint violation.
	const already = await findByEscrowKnock(escrow.knock);
	if (already) {
		return json(res, 200, {
			ok: true,
			duplicate: true,
			knock_id: already.id,
			escrow: { knock: escrow.knock, state: escrow.stateName, expires_at: escrow.expiresAt },
			receipt: receiptUrl(already.id),
		});
	}

	const { knock, duplicate } = await deliverKnock({
		userId: door.user_id,
		clean,
		payment: {
			payerWallet: input.sender_wallet,
			network: 'solana',
			amountAtomics: String(escrow.amount),
			asset: escrow.mint,
			escrowKnock: escrow.knock,
			escrowExpiresAt: escrow.expiresAt,
			escrowState: escrow.stateName,
		},
	});

	return json(res, duplicate ? 200 : 201, {
		ok: true,
		duplicate,
		knock_id: knock.id,
		delivered_to: door.display_name || handle,
		escrow: {
			knock: escrow.knock,
			vault: escrow.vault,
			program: KNOCK_ESCROW_PROGRAM_ID,
			amount_atomics: String(escrow.amount),
			state: escrow.stateName,
			expires_at: escrow.expiresAt,
			expires_in_seconds: escrow.expiresInSeconds,
			// Said plainly, because it is the reason to use this lane at all.
			guarantee:
				'If this is not answered before the window closes, anyone can crank the refund and every unit returns to you.',
		},
		receipt: receiptUrl(knock.id),
	});
});
