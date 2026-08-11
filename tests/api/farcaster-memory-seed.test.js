// The seeding transform behind consent-first Farcaster memory seeding
// (api/agents/[id]/memory-seed-farcaster.js).
//
// Everything asserted here is pure: message construction, upstream
// normalisation, cast selection, and the memory rows written to agent_memories.
// The signature checks use real ed25519 and secp256k1 keys generated in-test, so
// the verification path the endpoint runs is exercised for real rather than
// stood in for. No third-party Farcaster identity appears in the fixtures: the
// wallets are freshly generated and the fid is synthetic.

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { Wallet, verifyMessage } from 'ethers';
import { verifySiwsSignature } from '../../api/_lib/siws.js';
import {
	CONSENT_SCOPE,
	FARCASTER_EPOCH_MS,
	MEMORY_SOURCE,
	addressMatches,
	buildConsentMessage,
	buildSeedMemories,
	distillationInput,
	farcasterTimeToMs,
	normalizeAddress,
	normalizeHubCasts,
	normalizeHubUserData,
	normalizeNeynarCasts,
	normalizeVerifications,
	parseConsentMessage,
	parseDistilledFacts,
	selectSeedCasts,
	substantiveText,
} from '../../api/_lib/farcaster-seed.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const CONSENT_ID = '22222222-2222-4222-8222-222222222222';
const FID = 987654;

function solanaKeypair() {
	const secret = ed25519.utils.randomSecretKey();
	const publicKey = ed25519.getPublicKey(secret);
	return { secret, address: bs58.encode(publicKey) };
}

function consentArgs(overrides = {}) {
	return {
		domain: 'three.ws',
		agentId: AGENT_ID,
		fid: FID,
		fname: 'threewsdemo',
		address: 'So1anaAddressPlaceholder1111111111111111111',
		chain: 'solana',
		nonce: 'nonce0000000000000000abc',
		issuedAt: '2026-08-11T12:00:00.000Z',
		expiresAt: '2026-08-11T12:10:00.000Z',
		castLimit: 100,
		...overrides,
	};
}

describe('consent message', () => {
	it('round-trips every field a grant is checked against', () => {
		const args = consentArgs();
		const parsed = parseConsentMessage(buildConsentMessage(args));

		expect(parsed).toMatchObject({
			domain: 'three.ws',
			agentId: AGENT_ID,
			fid: FID,
			fname: 'threewsdemo',
			address: args.address,
			chain: 'solana',
			scope: CONSENT_SCOPE,
			castLimit: 100,
			nonce: args.nonce,
			issuedAt: args.issuedAt,
			expiresAt: args.expiresAt,
		});
	});

	it('names the scope as read-only, so the wallet prompt cannot imply write access', () => {
		expect(CONSENT_SCOPE).toBe('farcaster:profile.read farcaster:casts.read');
		const message = buildConsentMessage(consentArgs());
		expect(message).toContain('read my public Farcaster profile and casts');
		expect(message).toContain('Revoking this grant deletes every memory seeded from it.');
	});

	it('renders a missing fname without leaving the field blank', () => {
		const parsed = parseConsentMessage(buildConsentMessage(consentArgs({ fname: null })));
		expect(parsed.fname).toBeNull();
	});

	it('refuses to build a message that is missing a binding field', () => {
		expect(() => buildConsentMessage(consentArgs({ agentId: null }))).toThrow(/agentId/);
		expect(() => buildConsentMessage(consentArgs({ fid: 0 }))).toThrow(/fid/);
		expect(() => buildConsentMessage(consentArgs({ chain: 'bitcoin' }))).toThrow(/unsupported chain/);
	});

	it('rejects text that is not a consent message', () => {
		expect(parseConsentMessage('three.ws wants you to sign in with your Solana account:')).toBeNull();
		expect(parseConsentMessage(null)).toBeNull();
		expect(parseConsentMessage('')).toBeNull();
	});

	it('is deterministic, so the server can rebuild and compare byte for byte', () => {
		expect(buildConsentMessage(consentArgs())).toBe(buildConsentMessage(consentArgs()));
	});
});

describe('consent signatures', () => {
	it('verifies a real Solana wallet signature over the exact message', () => {
		const { secret, address } = solanaKeypair();
		const message = buildConsentMessage(consentArgs({ address }));
		const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));

		expect(verifySiwsSignature(message, signature, address)).toBe(true);
	});

	it('rejects the signature when a single field of the message is altered', () => {
		const { secret, address } = solanaKeypair();
		const message = buildConsentMessage(consentArgs({ address }));
		const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));
		const tampered = message.replace(`Farcaster FID: ${FID}`, `Farcaster FID: ${FID + 1}`);

		expect(tampered).not.toBe(message);
		expect(verifySiwsSignature(tampered, signature, address)).toBe(false);
	});

	it('rejects a signature from a wallet other than the one in the message', () => {
		const signer = solanaKeypair();
		const other = solanaKeypair();
		const message = buildConsentMessage(consentArgs({ address: other.address }));
		const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), signer.secret));

		expect(verifySiwsSignature(message, signature, other.address)).toBe(false);
	});

	it('verifies the EVM leg with a real secp256k1 signature', async () => {
		const wallet = Wallet.createRandom();
		const message = buildConsentMessage(consentArgs({ address: wallet.address.toLowerCase(), chain: 'ethereum' }));
		const signature = await wallet.signMessage(message);

		expect(normalizeAddress(verifyMessage(message, signature), 'ethereum')).toBe(
			normalizeAddress(wallet.address, 'ethereum'),
		);
	});
});

describe('verified address matching', () => {
	it('splits hub verifications by protocol and lowercases only the EVM side', () => {
		const verified = normalizeVerifications([
			{
				data: {
					verificationAddAddressBody: {
						address: 'So1anaAddressPlaceholder1111111111111111111',
						protocol: 'PROTOCOL_SOLANA',
					},
				},
			},
			{
				data: {
					verificationAddAddressBody: {
						address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
						protocol: 'PROTOCOL_ETHEREUM',
					},
				},
			},
			{
				data: {
					verificationAddAddressBody: {
						address: '0xabcdef0123456789abcdef0123456789abcdef01',
						protocol: 'PROTOCOL_ETHEREUM',
					},
				},
			},
		]);

		expect(verified.solana).toEqual(['So1anaAddressPlaceholder1111111111111111111']);
		expect(verified.ethereum).toEqual(['0xabcdef0123456789abcdef0123456789abcdef01']);
	});

	it('ignores messages with no address', () => {
		expect(normalizeVerifications([{ data: {} }, {}, null])).toEqual({ solana: [], ethereum: [] });
	});

	it('matches an EVM address case-insensitively but a Solana address exactly', () => {
		const evm = ['0xabcdef0123456789abcdef0123456789abcdef01'];
		expect(addressMatches('0xABCDEF0123456789ABCDEF0123456789ABCDEF01', evm, 'ethereum')).toBe(true);

		const sol = ['So1anaAddressPlaceholder1111111111111111111'];
		expect(addressMatches('So1anaAddressPlaceholder1111111111111111111', sol, 'solana')).toBe(true);
		expect(addressMatches('so1anaaddressplaceholder1111111111111111111', sol, 'solana')).toBe(false);
	});

	it('never matches an empty or missing address', () => {
		expect(addressMatches('', ['0xabc'], 'ethereum')).toBe(false);
		expect(addressMatches(null, ['0xabc'], 'ethereum')).toBe(false);
		expect(addressMatches('0xabc', [], 'ethereum')).toBe(false);
	});
});

describe('upstream normalisation', () => {
	it('converts hub timestamps out of the Farcaster epoch', () => {
		expect(farcasterTimeToMs(0)).toBe(FARCASTER_EPOCH_MS);
		expect(new Date(farcasterTimeToMs(100_000_000)).toISOString()).toBe('2024-03-03T09:46:40.000Z');
		expect(farcasterTimeToMs('not a number')).toBeNull();
	});

	it('folds hub user data messages into a flat profile', () => {
		const profile = normalizeHubUserData([
			{ data: { userDataBody: { type: 'USER_DATA_TYPE_DISPLAY', value: 'Demo Agent' } } },
			{ data: { userDataBody: { type: 'USER_DATA_TYPE_BIO', value: 'Building on Solana' } } },
			{ data: { userDataBody: { type: 'USER_DATA_TYPE_USERNAME', value: 'threewsdemo' } } },
			{ data: { userDataBody: { type: 'USER_DATA_TYPE_TWITTER', value: 'ignored' } } },
		]);

		expect(profile).toMatchObject({
			displayName: 'Demo Agent',
			bio: 'Building on Solana',
			fname: 'threewsdemo',
			pfpUrl: null,
		});
	});

	it('keeps only cast-add messages and flags replies', () => {
		const casts = normalizeHubCasts([
			{ hash: '0xaaa', data: { type: 'MESSAGE_TYPE_CAST_ADD', timestamp: 150_000_000, castAddBody: { text: 'a top level cast' } } },
			{ hash: '0xbbb', data: { type: 'MESSAGE_TYPE_CAST_ADD', timestamp: 150_000_001, castAddBody: { text: 'a reply', parentCastId: { fid: 1, hash: '0x1' } } } },
			{ hash: '0xccc', data: { type: 'MESSAGE_TYPE_REACTION_ADD', reactionBody: {} } },
		]);

		expect(casts).toHaveLength(2);
		expect(casts[0]).toMatchObject({ hash: '0xaaa', text: 'a top level cast', isReply: false, engagement: null });
		expect(casts[1].isReply).toBe(true);
	});

	it('carries Neynar engagement counts across into the shared shape', () => {
		const casts = normalizeNeynarCasts([
			{
				hash: '0xddd',
				text: 'an indexed cast',
				timestamp: '2026-08-01T00:00:00.000Z',
				reactions: { likes_count: 4, recasts_count: 2 },
				replies: { count: 3 },
			},
		]);

		expect(casts[0]).toMatchObject({ hash: '0xddd', engagement: 4 + 2 * 2 + 3 * 3 });
		expect(new Date(casts[0].timestamp).toISOString()).toBe('2026-08-01T00:00:00.000Z');
	});
});

describe('cast selection', () => {
	const at = (isoDay) => Date.parse(`${isoDay}T00:00:00.000Z`);

	it('strips links and mentions before judging whether a cast says anything', () => {
		expect(substantiveText('look at this https://example.com/thing @someone')).toBe('look at this');
	});

	it('drops replies, link-only posts, and duplicate text', () => {
		const selected = selectSeedCasts([
			{ hash: '1', text: 'a genuinely substantive opinion about rendering', timestamp: at('2026-08-01'), isReply: false, engagement: null },
			{ hash: '2', text: 'https://example.com/only-a-link', timestamp: at('2026-08-02'), isReply: false, engagement: null },
			{ hash: '3', text: 'a genuinely substantive opinion about rendering', timestamp: at('2026-08-03'), isReply: false, engagement: null },
			{ hash: '4', text: 'this one is a reply and long enough to pass', timestamp: at('2026-08-04'), isReply: true, engagement: null },
		]);

		expect(selected.map((c) => c.hash)).toEqual(['1']);
	});

	it('ranks by recency when the lane reports no engagement', () => {
		const selected = selectSeedCasts([
			{ hash: 'older', text: 'the older cast with plenty of words', timestamp: at('2026-07-01'), isReply: false, engagement: null },
			{ hash: 'newer', text: 'the newer cast with plenty of words', timestamp: at('2026-08-01'), isReply: false, engagement: null },
		]);

		expect(selected.map((c) => c.hash)).toEqual(['newer', 'older']);
	});

	it('ranks by engagement when the indexed lane provides it', () => {
		const selected = selectSeedCasts([
			{ hash: 'quiet', text: 'the newer but quieter cast with words', timestamp: at('2026-08-01'), isReply: false, engagement: 1 },
			{ hash: 'loud', text: 'the older but louder cast with words', timestamp: at('2026-07-01'), isReply: false, engagement: 90 },
		]);

		expect(selected.map((c) => c.hash)).toEqual(['loud', 'quiet']);
	});

	it('honours the limit', () => {
		const casts = Array.from({ length: 30 }, (_, i) => ({
			hash: String(i),
			text: `a distinct cast body number ${i} with enough words`,
			timestamp: at('2026-08-01') + i,
			isReply: false,
			engagement: null,
		}));

		expect(selectSeedCasts(casts, { limit: 5 })).toHaveLength(5);
		expect(selectSeedCasts(casts, { limit: 0 })).toHaveLength(0);
	});

	it('can include replies when asked', () => {
		const casts = [{ hash: 'r', text: 'a reply that is long enough to keep', timestamp: at('2026-08-01'), isReply: true, engagement: null }];
		expect(selectSeedCasts(casts)).toHaveLength(0);
		expect(selectSeedCasts(casts, { includeReplies: true })).toHaveLength(1);
	});
});

describe('memory rows', () => {
	const profile = { displayName: 'Demo Agent', fname: 'threewsdemo', bio: 'Building on Solana', followerCount: 42 };
	const casts = [
		{ hash: '0x1', body: 'the loudest thing this person says', timestamp: Date.parse('2026-08-01T00:00:00.000Z') },
		{ hash: '0x2', body: 'the second thing this person says', timestamp: Date.parse('2026-07-01T00:00:00.000Z') },
	];

	it('writes a profile row, one row per distilled fact, and one row per cast', () => {
		const rows = buildSeedMemories({
			fid: FID,
			fname: 'threewsdemo',
			profile,
			casts,
			facts: ['Prefers Solana over EVM chains', 'Ships 3D tooling'],
			consentId: CONSENT_ID,
		});

		expect(rows.map((r) => r.context.kind)).toEqual(['profile', 'fact', 'fact', 'cast', 'cast']);
		expect(rows[0].content).toContain('Demo Agent');
		expect(rows[0].content).toContain(`FID ${FID}`);
		expect(rows[0].content).toContain('Followers: 42');
		expect(rows[3].content).toBe('The user cast on 2026-08-01 on Farcaster: "the loudest thing this person says"');
	});

	it('stamps every row with the source and consent id revocation deletes by', () => {
		const rows = buildSeedMemories({ fid: FID, profile, casts, facts: ['one fact'], consentId: CONSENT_ID });

		for (const row of rows) {
			expect(row.context.source).toBe(MEMORY_SOURCE);
			expect(row.context.consent_id).toBe(CONSENT_ID);
			expect(row.context.fid).toBe(FID);
			expect(row.tags).toContain('farcaster');
		}
	});

	it('still produces real memory when the distillation lane returned nothing', () => {
		const rows = buildSeedMemories({ fid: FID, profile, casts, facts: [], consentId: CONSENT_ID });

		expect(rows.length).toBe(1 + casts.length);
		expect(rows.some((r) => r.context.kind === 'fact')).toBe(false);
	});

	it('ranks facts above raw casts and decays cast salience by rank', () => {
		const rows = buildSeedMemories({ fid: FID, profile, casts, facts: ['a fact'], consentId: CONSENT_ID });
		const factRow = rows.find((r) => r.context.kind === 'fact');
		const castRows = rows.filter((r) => r.context.kind === 'cast');

		expect(factRow.salience).toBeGreaterThan(castRows[0].salience);
		expect(castRows[0].salience).toBeGreaterThan(castRows[1].salience);
		expect(castRows.every((r) => r.type === 'reference')).toBe(true);
		expect(factRow.type).toBe('user');
	});

	it('caps how many casts become memories', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ hash: String(i), body: `cast body ${i}`, timestamp: Date.now() }));
		const rows = buildSeedMemories({ fid: FID, profile, casts: many, facts: [], consentId: CONSENT_ID, castMemoryLimit: 3 });

		expect(rows.filter((r) => r.context.kind === 'cast')).toHaveLength(3);
	});

	it('clips content to the memory store limit', () => {
		const rows = buildSeedMemories({
			fid: FID,
			profile,
			casts: [{ hash: '0x9', body: 'x'.repeat(12_000), timestamp: Date.now() }],
			facts: [],
			consentId: CONSENT_ID,
		});

		expect(rows.every((r) => r.content.length <= 10_000)).toBe(true);
	});

	it('refuses to build rows without the fields revocation depends on', () => {
		expect(() => buildSeedMemories({ fid: FID, consentId: null })).toThrow(/consentId/);
		expect(() => buildSeedMemories({ fid: 0, consentId: CONSENT_ID })).toThrow(/fid/);
	});
});

describe('distillation input and output', () => {
	it('feeds the model the stripped cast bodies, bounded', () => {
		const input = distillationInput({
			profile: { displayName: 'Demo Agent', fname: 'threewsdemo', followerCount: 42 },
			casts: Array.from({ length: 80 }, (_, i) => ({ text: `cast ${i} https://example.com/x` })),
			maxCasts: 10,
		});

		expect(input.header).toContain('Demo Agent');
		expect(input.casts).toHaveLength(10);
		expect(input.casts[0]).toBe('cast 0');
	});

	it('parses a fenced JSON array and bounds the fact count', () => {
		const facts = parseDistilledFacts('```json\n["one", "two", "", 7]\n```');
		expect(facts).toEqual(['one', 'two']);
		expect(parseDistilledFacts(JSON.stringify(Array.from({ length: 40 }, (_, i) => `f${i}`)))).toHaveLength(15);
	});

	it('returns nothing rather than throwing on unusable model output', () => {
		expect(parseDistilledFacts('sorry, I cannot do that')).toEqual([]);
		expect(parseDistilledFacts('{"facts":[]}')).toEqual([]);
		expect(parseDistilledFacts(null)).toEqual([]);
	});
});
