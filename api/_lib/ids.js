// Short, URL-safe IDs with a domain prefix. Mirrors the `wdgt_` prefix the
// widgets table already uses so all surface-level IDs follow the same shape.

import crypto from 'node:crypto';

const RANDOM_BYTES = 9; // 9 raw bytes → 12 base64url chars

export function shortId(prefix) {
	return `${prefix}_${crypto.randomBytes(RANDOM_BYTES).toString('base64url')}`;
}

const PREFIX_RE = /^[a-z]{2,8}_[A-Za-z0-9_-]{8,32}$/;

export function isShortId(s, prefix) {
	if (typeof s !== 'string') return false;
	if (prefix && !s.startsWith(`${prefix}_`)) return false;
	return PREFIX_RE.test(s);
}
