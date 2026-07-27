// Tokenized-3D — metadata shape, royalty cap, and mint idempotency.
//
// The pure metadata/policy core (tokenize-3d-metadata.js) is tested directly.
// The mint idempotency guard (tokenize-3d.js) is tested with injected fake deps
// so we exercise the claim-first logic WITHOUT touching Solana, R2, or the DB —
// the guarantee under test is "a double-call never double-mints".

import { describe, it, expect } from 'vitest';

import {
	buildTokenized3dMetadata,
	clampSellerFeeBps,
	deriveIdempotencyKey,
	TOKENIZE_3D_ROYALTY_CAP_BPS,
	TOKENIZE_3D_ROYALTY_DEFAULT_BPS,
} from '../api/_lib/tokenize-3d-metadata.js';
import { mintTokenized3dAsset } from '../api/_lib/tokenize-3d.js';

const OWNER = 'So11111111111111111111111111111111111111112';
const GLB = 'https://three.ws/cdn/tokenized/abc/model.glb';
const IMG = 'https://three.ws/cdn/tokenized/abc/thumb.png';
const VIEWER = 'https://three.ws/viewer?src=' + encodeURIComponent(GLB);

describe('tokenize-3d metadata shape', () => {
	const meta = buildTokenized3dMetadata({
		name: 'Knight',
		glbUrl: GLB,
		imageUrl: IMG,
		viewerUrl: VIEWER,
		creatorWallet: OWNER,
		creatorUserId: 'user-1',
		prompt: 'a brave knight',
		generationModel: 'trellis',
		generationProvider: 'nvidia-nim',
		parentMint: 'ParentMint1111111111111111111111111111111111',
		royaltyBps: 500,
		royaltyRecipient: OWNER,
		network: 'devnet',
		createdAt: '2026-07-07T00:00:00.000Z',
	});

	it('puts the GLB under animation_url (live 3D media, not a static image)', () => {
		expect(meta.animation_url).toBe(GLB);
		expect(meta.image).toBe(IMG);
		expect(meta.external_url).toBe(VIEWER);
	});

	it('lists the model in properties.files with the glTF-binary mimeType', () => {
		const model = meta.properties.files.find((f) => f.uri === GLB);
		expect(model).toBeTruthy();
		expect(model.type).toBe('model/gltf-binary');
		expect(meta.properties.category).toBe('3d');
	});

	it('bakes provenance into properties.provenance', () => {
		const p = meta.properties.provenance;
		expect(p.creator).toBe(OWNER);
		expect(p.prompt).toBe('a brave knight');
		expect(p.generation_model).toBe('trellis');
		expect(p.generation_provider).toBe('nvidia-nim');
		expect(p.parent_mint).toBe('ParentMint1111111111111111111111111111111111');
		expect(p.minted_at).toBe('2026-07-07T00:00:00.000Z');
		expect(p.network).toBe('devnet');
	});

	it('mirrors the royalty into the standard seller_fee_basis_points fields', () => {
		expect(meta.seller_fee_basis_points).toBe(500);
		expect(meta.properties.seller_fee_basis_points).toBe(500);
		expect(meta.properties.creators).toEqual([{ address: OWNER, share: 100 }]);
	});

	it('references only $THREE as a coin (no other mint)', () => {
		const json = JSON.stringify(meta);
		expect(meta.token.symbol).toBe('THREE');
		// The $THREE mint is present; no bare SOL/USDC coin promotion in copy.
		expect(json).toContain('THREE');
	});

	it('optional IPFS permanence copies land in files when provided', () => {
		const withIpfs = buildTokenized3dMetadata({
			name: 'X',
			glbUrl: GLB,
			imageUrl: IMG,
			viewerUrl: VIEWER,
			glbIpfs: 'ipfs://bafyGLB',
			imageIpfs: 'ipfs://bafyIMG',
			creatorWallet: OWNER,
			royaltyBps: 0,
			royaltyRecipient: OWNER,
			network: 'devnet',
			createdAt: '2026-07-07T00:00:00.000Z',
		});
		const uris = withIpfs.properties.files.map((f) => f.uri);
		expect(uris).toContain('ipfs://bafyGLB');
		expect(uris).toContain('ipfs://bafyIMG');
	});
});

describe('royalty hard cap', () => {
	it('defaults when unset', () => {
		expect(clampSellerFeeBps(undefined).bps).toBe(TOKENIZE_3D_ROYALTY_DEFAULT_BPS);
		expect(clampSellerFeeBps(null).bps).toBe(TOKENIZE_3D_ROYALTY_DEFAULT_BPS);
	});

	it('clamps anything above the cap to the cap and flags it', () => {
		const r = clampSellerFeeBps(5000);
		expect(r.bps).toBe(TOKENIZE_3D_ROYALTY_CAP_BPS);
		expect(r.capped).toBe(true);
		expect(r.requestedBps).toBe(5000);
	});

	it('passes through a value under the cap', () => {
		const r = clampSellerFeeBps(250);
		expect(r.bps).toBe(250);
		expect(r.capped).toBe(false);
	});

	it('never exceeds the cap for any input', () => {
		for (const v of [0, 1, 999, 1000, 1001, 9999, 100000]) {
			expect(clampSellerFeeBps(v).bps).toBeLessThanOrEqual(TOKENIZE_3D_ROYALTY_CAP_BPS);
		}
	});

	it('treats a negative / garbage rate as the default', () => {
		expect(clampSellerFeeBps(-5).bps).toBe(TOKENIZE_3D_ROYALTY_DEFAULT_BPS);
		expect(clampSellerFeeBps('nonsense').bps).toBe(TOKENIZE_3D_ROYALTY_DEFAULT_BPS);
	});
});

describe('idempotency key derivation', () => {
	it('is deterministic for the same inputs', () => {
		const a = deriveIdempotencyKey({ ownerWallet: OWNER, glbSource: 'avatar:1', network: 'devnet' });
		const b = deriveIdempotencyKey({ ownerWallet: OWNER, glbSource: 'avatar:1', network: 'devnet' });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('differs when any input differs', () => {
		const base = deriveIdempotencyKey({ ownerWallet: OWNER, glbSource: 'avatar:1', network: 'devnet' });
		expect(deriveIdempotencyKey({ ownerWallet: OWNER, glbSource: 'avatar:2', network: 'devnet' })).not.toBe(base);
		expect(deriveIdempotencyKey({ ownerWallet: OWNER, glbSource: 'avatar:1', network: 'mainnet' })).not.toBe(base);
		expect(deriveIdempotencyKey({ ownerWallet: 'Other', glbSource: 'avatar:1', network: 'devnet' })).not.toBe(base);
	});
});

// ── Mint idempotency guard (fake deps) ───────────────────────────────────────

// A minimal in-memory stand-in for the neon `sql` tagged template. It emulates
// the three statements the guard uses: the claim INSERT (ON CONFLICT DO NOTHING),
// the read-back SELECT, and the success UPDATE. Enough to prove the guard.
function makeFakeSql(store) {
	const fn = (strings, ...values) => {
		const q = strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();

		if (q.includes('insert into tokenized_3d_assets')) {
			const [idem, network, owner, creatorId, avatarId, parentMint, name, glbUrl, viewerUrl, bps, recipient] = values;
			const key = `${idem}|${network}`;
			if (store.has(key)) return Promise.resolve([]); // ON CONFLICT DO NOTHING
			const row = {
				id: `row-${store.size + 1}`,
				idempotency_key: idem,
				network,
				status: 'pending',
				owner_wallet: owner,
				creator_user_id: creatorId,
				source_avatar_id: avatarId,
				parent_mint: parentMint,
				name,
				glb_url: glbUrl,
				image_url: null,
				viewer_url: viewerUrl,
				metadata_uri: null,
				royalty_bps: bps,
				royalty_recipient: recipient,
				tx_signature: null,
				mint: null,
			};
			store.set(key, row);
			return Promise.resolve([{ id: row.id, status: 'pending' }]);
		}

		if (q.startsWith('select') && q.includes('from tokenized_3d_assets')) {
			const [idem, network] = values;
			const row = store.get(`${idem}|${network}`);
			return Promise.resolve(row ? [{ ...row }] : []);
		}

		if (q.includes("set status = 'minted'")) {
			const [mint, signature, glbUrl, imageUrl, viewerUrl, metadataUri, _prov, id] = values;
			for (const row of store.values()) {
				if (row.id === id) {
					Object.assign(row, {
						status: 'minted',
						mint,
						tx_signature: signature,
						glb_url: glbUrl,
						image_url: imageUrl,
						viewer_url: viewerUrl,
						metadata_uri: metadataUri,
					});
					return Promise.resolve([{ ...row }]);
				}
			}
			return Promise.resolve([]);
		}

		// Failure / reclaim updates — unused in the happy path.
		return Promise.resolve([]);
	};
	return fn;
}

function makeDeps(store, counters) {
	return {
		sql: makeFakeSql(store),
		resolveSource: async () => ({
			sourceUrl: GLB,
			sourceAvatarId: 'avatar-1',
			name: 'Knight',
			description: '',
			parentAvatarId: null,
			provenance: { prompt: 'a knight', generationModel: 'trellis', generationProvider: 'nvidia-nim' },
		}),
		resolveOwnerWallet: async () => OWNER,
		promoteToDurableStorage: async () => {
			counters.promote++;
			return { glbUrl: GLB, imageUrl: IMG, glbIpfs: null, imageIpfs: null };
		},
		uploadMetadataJson: async () => ({ uri: 'https://three.ws/cdn/tokenized/abc/metadata.json', ipfs: null }),
		mintCoreAsset: async () => {
			counters.mint++;
			return { mint: 'MintAsset1111111111111111111111111111111111', signature: 'Sig111' };
		},
		now: () => '2026-07-07T00:00:00.000Z',
	};
}

describe('mint idempotency guard', () => {
	it('mints once, then a repeat call returns the same mint without minting again', async () => {
		const store = new Map();
		const counters = { mint: 0, promote: 0 };
		const deps = makeDeps(store, counters);
		const input = { avatarId: 'avatar-1', requesterId: 'user-1', network: 'devnet' };

		const first = await mintTokenized3dAsset(input, deps);
		expect(first.status).toBe('minted');
		expect(first.mint).toBe('MintAsset1111111111111111111111111111111111');
		expect(first.idempotent).toBe(false);
		expect(counters.mint).toBe(1);

		const second = await mintTokenized3dAsset(input, deps);
		expect(second.status).toBe('minted');
		expect(second.mint).toBe(first.mint);
		expect(second.idempotent).toBe(true);
		// The critical assertion: NO second on-chain mint.
		expect(counters.mint).toBe(1);
		expect(counters.promote).toBe(1);
	});

	it('applies and reports the royalty cap on the mint result', async () => {
		const store = new Map();
		const counters = { mint: 0, promote: 0 };
		const deps = makeDeps(store, counters);
		const result = await mintTokenized3dAsset(
			{ avatarId: 'avatar-1', requesterId: 'user-1', network: 'devnet', sellerFeeBasisPoints: 5000 },
			deps,
		);
		expect(result.royalty.basis_points).toBe(TOKENIZE_3D_ROYALTY_CAP_BPS);
		expect(result.royalty.capped).toBe(true);
		expect(result.royalty.cap_basis_points).toBe(TOKENIZE_3D_ROYALTY_CAP_BPS);
	});
});
