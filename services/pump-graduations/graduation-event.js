/**
 * CompleteEvent parsing, shared by every graduation source in this service.
 *
 * Pump emits an Anchor CPI event named `CompleteEvent` when a token finishes
 * its bonding curve. It arrives on the program's log stream as a single
 * `Program data: <base64>` line whose first 8 bytes are the Anchor event
 * discriminator, `sha256("event:CompleteEvent")[..8]` — the same fixed bytes
 * `@pumpkit/core` matches on.
 *
 * Both index.js (legacy `conn.onLogs`) and carbon-source.js parse with these
 * functions, so the two sources can never drift apart on layout or dedupe.
 */

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export const COMPLETE_EVENT_DISCRIMINATOR = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);

// discriminator(8) user(32) mint(32) bondingCurve(32) timestamp(i64)
const COMPLETE_EVENT_LEN = 8 + 32 + 32 + 32 + 8;

/**
 * Decode the first CompleteEvent found in a batch of program log lines.
 *
 * @param {string} signature Transaction signature the logs came from.
 * @param {string[]} logs Raw log lines as delivered by `logsSubscribe`.
 * @returns {{signature: string, mint: string, user: string, bondingCurve: string, timestamp: number}|null}
 */
export function parseCompleteEvent(signature, logs) {
	for (const line of logs || []) {
		const m = /^Program data: (.+)$/.exec(line);
		if (!m) continue;
		const data = Buffer.from(m[1], 'base64');
		if (data.length < COMPLETE_EVENT_LEN) continue;
		if (!data.subarray(0, 8).equals(COMPLETE_EVENT_DISCRIMINATOR)) continue;

		let off = 8;
		const user = bs58.encode(data.subarray(off, off + 32)); off += 32;
		const mint = bs58.encode(data.subarray(off, off + 32)); off += 32;
		const bondingCurve = bs58.encode(data.subarray(off, off + 32)); off += 32;
		const timestamp = Number(data.readBigInt64LE(off));

		return { signature, mint, user, bondingCurve, timestamp };
	}
	return null;
}

/**
 * True when a log entry is worth decoding at all: it landed successfully and
 * carries at least one Anchor event line.
 *
 * @param {{err: unknown, logs?: string[]}} entry
 */
export function isCandidateEntry(entry) {
	if (!entry || entry.err) return false;
	return Boolean(entry.logs?.some((l) => l.startsWith('Program data: ')));
}

/**
 * Bounded signature dedupe. Pump replays a log entry after a WS hiccup, and an
 * unbounded Set would grow for the life of the process.
 *
 * Drops the oldest quarter when full rather than clearing outright, so a
 * signature seen one event ago still dedupes right after a trim.
 */
export class SeenSignatures {
	constructor(limit = 5000) {
		this._limit = limit;
		this._sigs = new Set();
	}

	/** @returns {boolean} true the first time a signature is offered. */
	add(signature) {
		if (!signature || this._sigs.has(signature)) return false;
		this._sigs.add(signature);
		if (this._sigs.size > this._limit) {
			const drop = Math.floor(this._limit / 4);
			const it = this._sigs.values();
			for (let i = 0; i < drop; i++) this._sigs.delete(it.next().value);
		}
		return true;
	}

	get size() {
		return this._sigs.size;
	}
}
