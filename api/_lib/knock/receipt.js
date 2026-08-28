// A knock receipt token: the sender's proof that a specific knock is theirs.
//
// Knock is a one-way door. The sender pays, the message lands, and the owner
// may or may not answer. Without a way to look back, "did they reply" would
// mean handing the sender an account, an email address, or a webhook, all of
// which reopen the door the price exists to close. Instead every accepted
// knock returns a receipt URL: an unguessable HMAC over its id, readable by
// whoever holds it and by nobody else, exposing exactly two things: the
// status, and the reply text if one was written.
//
// No new column: the token is derived, so it survives a restart, needs no
// storage, and cannot be leaked from the database on its own.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

const VERSION = 'knock-receipt-v1';

export function receiptToken(knockId) {
	return createHmac('sha256', env.JWT_SECRET)
		.update(`${VERSION}:${knockId}`)
		.digest('base64url')
		.slice(0, 32);
}

export function receiptValid(knockId, token) {
	const expected = Buffer.from(receiptToken(knockId));
	const given = Buffer.from(String(token || ''));
	// timingSafeEqual throws on a length mismatch, which is itself the answer.
	if (expected.length !== given.length) return false;
	return timingSafeEqual(expected, given);
}

export function receiptUrl(knockId) {
	return `${env.APP_ORIGIN}/api/knock/reply?id=${knockId}&token=${receiptToken(knockId)}`;
}
