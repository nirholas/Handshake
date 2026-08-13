import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk';
import {
	COMPLETE_EVENT_DISCRIMINATOR,
	PUMP_PROGRAM_ID,
	SeenSignatures,
	isCandidateEntry,
	parseCompleteEvent,
} from '../services/pump-graduations/graduation-event.js';
import {
	canonicalPumpPoolAddress,
	decodeMetaplexMetadata,
	decodeToken2022Metadata,
	fetchTokenMetadata,
	metaplexMetadataAddress,
} from '../services/pump-graduations/token-info.js';
import {
	DEFAULT_LIST_KEY,
	buildGraduationRecord,
	createGraduationHandler,
	pushGraduation,
} from '../services/pump-graduations/index.js';

// $THREE, the platform's own coin and a real graduated pump.fun mint. Used as
// the fixture so the committed test never names a third-party project.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const THREE_MINT_BYTES = Buffer.from(bs58.decode(THREE_MINT));
const SIG = 'testSig1111111111111111111111111111111111111111111111111111111111';
const TS = 1_700_000_000;

/** Build the exact `Program data:` line Pump emits for a CompleteEvent. */
function completeEventEntry({ mintBytes = THREE_MINT_BYTES, ts = TS, signature = SIG } = {}) {
	const buf = Buffer.alloc(8 + 32 + 32 + 32 + 8);
	COMPLETE_EVENT_DISCRIMINATOR.copy(buf, 0);
	mintBytes.copy(buf, 8 + 32);
	buf.writeBigInt64LE(BigInt(ts), 8 + 32 + 32 + 32);
	return { signature, err: null, logs: [`Program data: ${buf.toString('base64')}`] };
}

/** A Token-2022 mint carrying the inline TokenMetadata extension (type 19). */
function token2022Mint({ name, symbol, uri = 'https://example.invalid/m.json' }) {
	const str = (s) => {
		const b = Buffer.from(s, 'utf8');
		const out = Buffer.alloc(4 + b.length);
		out.writeUInt32LE(b.length);
		b.copy(out, 4);
		return out;
	};
	const value = Buffer.concat([
		Buffer.alloc(64), // updateAuthority(32) + mint(32)
		str(name),
		str(symbol),
		str(uri),
		Buffer.alloc(4), // empty additionalMetadata vec
	]);
	const header = Buffer.alloc(4);
	header.writeUInt16LE(19, 0);
	header.writeUInt16LE(value.length, 2);
	return Buffer.concat([Buffer.alloc(166), header, value]);
}

/** In-memory stand-in for the Upstash REST client's list + pubsub commands. */
function recordingRedis() {
	const lists = new Map();
	const published = [];
	return {
		lists,
		published,
		async lpush(key, value) {
			const arr = lists.get(key) || [];
			arr.unshift(value);
			lists.set(key, arr);
			return arr.length;
		},
		async ltrim(key, start, stop) {
			lists.set(key, (lists.get(key) || []).slice(start, stop + 1));
			return 'OK';
		},
		async publish(channel, message) {
			published.push({ channel, message });
			return 1;
		},
	};
}

describe('COMPLETE_EVENT_DISCRIMINATOR', () => {
	it('is the Anchor discriminator for CompleteEvent, not a hand-copied constant', () => {
		expect(COMPLETE_EVENT_DISCRIMINATOR).toEqual(
			createHash('sha256').update('event:CompleteEvent').digest().subarray(0, 8),
		);
	});

	it('does not match the trade event that dominates the Pump log stream', () => {
		// bddb7fd34ee661ee is Pump's TradeEvent discriminator: 4559 of the 5019
		// event-carrying entries in a four-minute live capture of the program's
		// logs. Decoding one as a graduation would flood the feed.
		const trade = Buffer.alloc(8 + 32 + 32 + 32 + 8);
		Buffer.from('bddb7fd34ee661ee', 'hex').copy(trade, 0);
		expect(parseCompleteEvent(SIG, [`Program data: ${trade.toString('base64')}`])).toBeNull();
	});
});

describe('parseCompleteEvent', () => {
	it('decodes the CompleteEvent layout off a real-shaped log line', () => {
		const ev = parseCompleteEvent(SIG, completeEventEntry().logs);
		expect(ev).toEqual({
			signature: SIG,
			mint: THREE_MINT,
			user: bs58.encode(Buffer.alloc(32)),
			bondingCurve: bs58.encode(Buffer.alloc(32)),
			timestamp: TS,
		});
	});

	it('returns null for a Program data line with a different discriminator', () => {
		const buf = Buffer.alloc(112);
		buf.writeUInt8(0xff, 0);
		expect(parseCompleteEvent(SIG, [`Program data: ${buf.toString('base64')}`])).toBeNull();
	});

	it('returns null when the payload is truncated below the event size', () => {
		const buf = Buffer.alloc(40);
		COMPLETE_EVENT_DISCRIMINATOR.copy(buf, 0);
		expect(parseCompleteEvent(SIG, [`Program data: ${buf.toString('base64')}`])).toBeNull();
	});

	it('returns null when no Program data line is present', () => {
		expect(parseCompleteEvent(SIG, ['Program log: instruction: Buy'])).toBeNull();
	});
});

describe('isCandidateEntry', () => {
	it('accepts a successful entry carrying an event line', () => {
		expect(isCandidateEntry(completeEventEntry())).toBe(true);
	});

	it('rejects failed transactions', () => {
		expect(isCandidateEntry({ ...completeEventEntry(), err: { InstructionError: [0, 'Custom'] } })).toBe(false);
	});

	it('rejects entries with no event line', () => {
		expect(isCandidateEntry({ signature: SIG, err: null, logs: ['Program log: hi'] })).toBe(false);
	});
});

describe('SeenSignatures', () => {
	it('admits a signature once', () => {
		const seen = new SeenSignatures();
		expect(seen.add(SIG)).toBe(true);
		expect(seen.add(SIG)).toBe(false);
	});

	it('evicts the oldest quarter at the limit instead of clearing outright', () => {
		const seen = new SeenSignatures(8);
		for (let i = 0; i < 9; i++) seen.add(`sig-${i}`);
		expect(seen.size).toBe(7); // 9 added, oldest 2 dropped
		expect(seen.add('sig-0')).toBe(true); // evicted, so it is new again
		expect(seen.add('sig-8')).toBe(false); // most recent, still deduped
	});
});

describe('canonicalPumpPoolAddress', () => {
	it('matches canonicalPumpPoolPda from @pump-fun/pump-swap-sdk', () => {
		expect(canonicalPumpPoolAddress(THREE_MINT)).toBe(
			canonicalPumpPoolPda(new PublicKey(THREE_MINT)).toBase58(),
		);
	});

	it('derives the live PumpSwap pool for $THREE', () => {
		// Verified on mainnet: this account exists and is owned by
		// pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA.
		expect(canonicalPumpPoolAddress(THREE_MINT)).toBe('5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z');
	});
});

describe('token metadata decoding', () => {
	it('reads name and symbol out of a Token-2022 TokenMetadata extension', () => {
		expect(decodeToken2022Metadata(token2022Mint({ name: 'three.ws', symbol: 'three' }))).toEqual({
			name: 'three.ws',
			symbol: 'three',
		});
	});

	it('returns null for a mint with no extensions', () => {
		expect(decodeToken2022Metadata(Buffer.alloc(82))).toBeNull();
	});

	it('reads NUL-padded name and symbol out of a Metaplex metadata account', () => {
		const data = Buffer.alloc(1 + 32 + 32 + 4 + 32 + 4 + 10);
		let off = 1 + 32 + 32;
		data.writeUInt32LE(32, off); off += 4;
		Buffer.from('three.ws', 'utf8').copy(data, off); off += 32;
		data.writeUInt32LE(10, off); off += 4;
		Buffer.from('three', 'utf8').copy(data, off);
		expect(decodeMetaplexMetadata(data)).toEqual({ name: 'three.ws', symbol: 'three' });
	});

	it('falls back to the Metaplex account when the mint carries no extension', async () => {
		const metaPda = metaplexMetadataAddress(THREE_MINT).toBase58();
		const legacy = Buffer.alloc(1 + 32 + 32 + 4 + 8 + 4 + 5);
		let off = 1 + 32 + 32;
		legacy.writeUInt32LE(8, off); off += 4;
		Buffer.from('three.ws', 'utf8').copy(legacy, off); off += 8;
		legacy.writeUInt32LE(5, off); off += 4;
		Buffer.from('three', 'utf8').copy(legacy, off);

		const connection = {
			getAccountInfo: vi.fn(async (pk) =>
				pk.toBase58() === metaPda ? { data: legacy } : { data: Buffer.alloc(82) },
			),
		};
		await expect(fetchTokenMetadata(connection, THREE_MINT)).resolves.toEqual({
			name: 'three.ws',
			symbol: 'three',
		});
	});

	it('returns nulls rather than throwing when both reads fail', async () => {
		const connection = { getAccountInfo: vi.fn(async () => { throw new Error('rpc down'); }) };
		await expect(fetchTokenMetadata(connection, THREE_MINT)).resolves.toEqual({
			name: null,
			symbol: null,
		});
	});
});

describe('graduation core path', () => {
	const connectionWithMetadata = () => ({
		getAccountInfo: vi.fn(async () => ({ data: token2022Mint({ name: 'three.ws', symbol: 'three' }) })),
	});

	it('builds the record shape api/_lib/pumpfun-mcp.js reads', async () => {
		const record = await buildGraduationRecord(connectionWithMetadata(), {
			signature: SIG,
			mint: THREE_MINT,
			timestamp: TS,
		});
		expect(record).toEqual({
			signature: SIG,
			mint: THREE_MINT,
			tokenName: 'three.ws',
			tokenSymbol: 'three',
			poolAddress: '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z',
			timestamp: TS,
		});
	});

	it('stamps the current time when the event carries no timestamp', async () => {
		const before = Math.floor(Date.now() / 1000);
		const record = await buildGraduationRecord(connectionWithMetadata(), { signature: SIG, mint: THREE_MINT });
		expect(record.timestamp).toBeGreaterThanOrEqual(before);
	});

	it('lpushes, trims and publishes on the documented keys', async () => {
		const redis = recordingRedis();
		const record = { signature: SIG, mint: THREE_MINT, timestamp: TS };
		await pushGraduation(redis, record, { listKey: 'pf:test', maxLen: 2 });
		await pushGraduation(redis, { ...record, signature: 'b' }, { listKey: 'pf:test', maxLen: 2 });
		await pushGraduation(redis, { ...record, signature: 'c' }, { listKey: 'pf:test', maxLen: 2 });

		const list = redis.lists.get('pf:test');
		expect(list).toHaveLength(2);
		expect(JSON.parse(list[0]).signature).toBe('c');
		expect(redis.published).toHaveLength(3);
		expect(redis.published[0].channel).toBe('pf:test:pub');
		expect(JSON.parse(redis.published[0].message).mint).toBe(THREE_MINT);
	});

	it('runs log line to Redis end to end and dedupes replays', async () => {
		const redis = recordingRedis();
		const handler = createGraduationHandler({ connection: connectionWithMetadata(), redis });
		const entry = completeEventEntry();

		expect(isCandidateEntry(entry)).toBe(true);
		const parsed = parseCompleteEvent(entry.signature, entry.logs);
		const record = await handler(parsed);
		expect(await handler(parsed)).toBeNull(); // replayed signature

		expect(record.tokenSymbol).toBe('three');
		expect(redis.lists.get(DEFAULT_LIST_KEY)).toHaveLength(1);
		expect(redis.published).toHaveLength(1);
		expect(JSON.parse(redis.lists.get(DEFAULT_LIST_KEY)[0])).toEqual(record);
	});

	it('swallows a Redis failure so one bad push cannot kill the subscription', async () => {
		const redis = { ...recordingRedis(), lpush: async () => { throw new Error('redis unreachable'); } };
		const handler = createGraduationHandler({ connection: connectionWithMetadata(), redis });
		await expect(handler({ signature: SIG, mint: THREE_MINT, timestamp: TS })).resolves.toBeNull();
	});

	it('subscribes to the Pump program id', () => {
		expect(PUMP_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
	});
});
