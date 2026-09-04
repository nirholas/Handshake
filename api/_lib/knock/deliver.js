// Turning a paid knock into a person walking on screen.
//
// One function, called by both lanes (the x402 endpoint for priced doors and
// /api/knock/send for free ones), so a knock behaves identically however it
// was paid for. The order matters:
//
//   1. refuse early  -- closed door, daily cap, block list. Nothing is charged
//      by this module, but the paid lane calls checkDoor() BEFORE the 402
//      challenge is issued, so a refused knock never takes money.
//   2. write the companion event  -- this is what makes the avatar walk on.
//      Its importance comes from the price, so the sender's own money decides
//      whether the owner is interrupted (api/_lib/knock/policy.js).
//   3. write the knock row, linked to that event, so the inbox and the
//      companion feed are two views of one thing.
//   4. notify  -- 'knock_received' rides the normal preference matrix, which
//      is what puts the line in the bell, the push, and the corner avatar on
//      whatever page the owner happens to be on.
//
// Steps 2 and 4 are best-effort: a knock that has been paid for is recorded
// even if the companion feed or the bell is having a bad minute. Losing the
// delivery animation is a degraded experience; losing a paid message is theft.

import { insertEvent } from '../companion/store.js';
import { insertNotification } from '../notify.js';
import {
	KNOCK_SOURCE_KIND,
	blockKeysFor,
	doorRefusal,
	importanceFor,
	spokenLineFor,
	titleFor,
	validateKnock,
} from './policy.js';
import { getDoor, isBlocked, knocksToday, recordKnock, findByRequestId } from './store.js';

/**
 * Everything that can refuse a knock before money moves.
 * @returns {Promise<{door: object}>} the owner's full door row on success.
 * @throws {Error} coded + statused by policy.knockError.
 */
export async function checkDoor(userId, input) {
	const door = await getDoor(userId);
	const refusal = doorRefusal(door, { knocksToday: await knocksToday(userId) });
	if (refusal) throw refusal;

	const clean = validateKnock(input, door);
	const keys = blockKeysFor({ payerWallet: input?.payer_wallet, senderName: clean.senderName });
	if (await isBlocked(userId, keys)) {
		// Deliberately the same shape as a closed door. A blocked sender who can
		// tell they were blocked specifically just knocks again under a new name.
		throw doorRefusal({ ...door, open: false }, {});
	}
	return { door, clean };
}

/**
 * Record and deliver one knock. Assumes checkDoor() already passed and, on the
 * paid lane, that the payment has settled.
 *
 * @param {object} args
 * @param {string} args.userId          recipient
 * @param {object} args.clean           the output of validateKnock()
 * @param {object} [args.payment]       { payerWallet, network, txHash, amountAtomics, asset }
 *                                      plus { escrowKnock, escrowExpiresAt, escrowState } on
 *                                      the escrowed lane, where the money is parked on-chain
 *                                      rather than already in the recipient's wallet.
 * @returns {Promise<{knock: object, duplicate: boolean, importance: number}>}
 */
export async function deliverKnock({ userId, clean, payment = {} }) {
	const amountAtomics = String(payment.amountAtomics ?? 0);
	const importance = importanceFor(amountAtomics);
	const spoken = spokenLineFor({
		senderName: clean.senderName,
		amountAtomics,
		subject: clean.subject,
	});
	const title = titleFor({ senderName: clean.senderName, amountAtomics, subject: clean.subject });

	// An idempotency key that has already been used means this exact knock was
	// delivered on an earlier attempt. Return that one rather than staging a
	// second performance for a message the owner already heard.
	if (clean.requestId) {
		const existing = await findByRequestId(userId, clean.requestId);
		if (existing) return { knock: existing, duplicate: true, importance };
	}

	const event = await safeEvent(userId, {
		source_kind: KNOCK_SOURCE_KIND,
		// The knock has no stable upstream id of its own, so the dedupe key is
		// the caller's request id when they supplied one, and a fresh uuid when
		// they did not. Two knocks with no request id are two knocks.
		external_id: clean.requestId || crypto.randomUUID(),
		sender: clean.senderName,
		sender_id: payment.payerWallet ?? null,
		title,
		body: clean.message,
		url: clean.senderUrl,
		importance,
		reason: amountAtomics === '0' ? 'free door' : `paid ${amountAtomics} atomics to knock`,
		spoken_line: spoken,
		triage_engine: 'knock',
	});

	const knock = await recordKnock(userId, {
		...clean,
		payerWallet: payment.payerWallet ?? null,
		network: payment.network ?? null,
		txHash: payment.txHash ?? null,
		amountAtomics,
		asset: payment.asset ?? null,
		companionEventId: event?.id ?? null,
		// Only the escrowed lane sets these; both other lanes leave them null.
		escrowKnock: payment.escrowKnock ?? null,
		escrowExpiresAt: payment.escrowExpiresAt ?? null,
		escrowState: payment.escrowState ?? null,
	});

	// recordKnock returns null only on the request-id conflict, which the check
	// above almost always catches first. Losing that race is still a duplicate.
	if (!knock) {
		const existing = await findByRequestId(userId, clean.requestId);
		return { knock: existing, duplicate: true, importance };
	}

	insertNotification(userId, 'knock_received', {
		title,
		body: clean.message.slice(0, 240),
		spoken_line: spoken,
		knock_id: knock.id,
		sender: clean.senderName,
		amount_atomics: amountAtomics,
		url: '/knock',
	});

	return { knock, duplicate: false, importance };
}

async function safeEvent(userId, event) {
	try {
		return await insertEvent(userId, event);
	} catch (err) {
		console.error('[knock] companion event insert failed:', err.message);
		return null;
	}
}
