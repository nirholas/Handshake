// An on-chain agent's avatar and image live behind ONE IPFS gateway in the
// manifest the resolver produces, and public gateways go down routinely. When
// ipfs.io was unreachable the agent rendered with no body and no picture, and
// the consumer had nothing to retry against: resolveUrlCandidates() existed but
// had zero callers, and toManifest() fed the single-URL resolveUrl() into both
// fields.
//
// This pins the two halves of the fix: the manifest now carries the full
// ordered chain next to the single URLs (which are unchanged, so no consumer
// breaks), and the resolver no longer keeps its own gateway list beside the
// canonical one in src/ipfs.js.
import { describe, it, expect } from 'vitest';
import { resolveUrl, resolveUrlCandidates, toManifest } from '../src/erc8004/resolver.js';
import { uriCandidates, IPFS_GATEWAYS } from '../src/ipfs.js';

const CID = 'bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr';

describe('resolveUrlCandidates', () => {
	it('starts with exactly what resolveUrl returned', () => {
		// A consumer holding the single URL must be able to find it in the list
		// and continue past it, rather than restarting on a different gateway.
		const list = resolveUrlCandidates(`ipfs://${CID}`);
		expect(list[0]).toBe(resolveUrl(`ipfs://${CID}`));
	});

	it('offers every live gateway, not the resolver\'s own stale copy of the list', () => {
		const list = resolveUrlCandidates(`ipfs://${CID}`);
		expect(list.length).toBe(IPFS_GATEWAYS.length);
		for (const gw of IPFS_GATEWAYS) {
			expect(list).toContain(gw + CID);
		}
	});

	it('delegates to uriCandidates so the two can never drift apart', () => {
		expect(resolveUrlCandidates(`ipfs://${CID}`)).toEqual(uriCandidates(resolveUrl(`ipfs://${CID}`)));
	});

	it('passes an ar:// URI and a plain https URL straight through', () => {
		expect(resolveUrlCandidates('ar://tx123')).toEqual(['https://arweave.net/tx123']);
		expect(resolveUrlCandidates('https://cdn.example/model.glb')).toEqual(['https://cdn.example/model.glb']);
	});

	it('returns an empty list for an absent URI instead of a list of one empty string', () => {
		expect(resolveUrlCandidates('')).toEqual([]);
		expect(resolveUrlCandidates(null)).toEqual([]);
	});
});

function resolved(overrides = {}) {
	return {
		ref: { agentId: '42', chainId: 8453, registry: '0x0000000000000000000000000000000000000001' },
		caip: 'eip155:8453:0x0000000000000000000000000000000000000001:42',
		onchain: { owner: '0x0000000000000000000000000000000000000002' },
		metadataUrl: `https://ipfs.io/ipfs/${CID}/manifest.json`,
		name: 'Test Agent',
		description: '',
		services: [],
		metadata: {},
		...overrides,
	};
}

describe('toManifest gateway candidates', () => {
	it('leaves image and body.uri exactly as they were', () => {
		const m = toManifest(resolved({ image: `ipfs://${CID}/a.png`, glbUrl: `ipfs://${CID}/a.glb` }));
		expect(m.image).toBe(`https://ipfs.io/ipfs/${CID}/a.png`);
		expect(m.body.uri).toBe(`https://ipfs.io/ipfs/${CID}/a.glb`);
	});

	it('adds a retry chain whose first entry is the single URL beside it', () => {
		const m = toManifest(resolved({ image: `ipfs://${CID}/a.png`, glbUrl: `ipfs://${CID}/a.glb` }));
		expect(m._gatewayCandidates.body[0]).toBe(m.body.uri);
		expect(m._gatewayCandidates.image[0]).toBe(m.image);
		expect(m._gatewayCandidates.body.length).toBeGreaterThan(1);
	});

	it('falls back to the image for the body chain, matching body.uri', () => {
		// An agent with a picture but no GLB renders the picture as its body;
		// the retry chain has to follow that same choice or it retries nothing.
		const m = toManifest(resolved({ image: `ipfs://${CID}/a.png`, glbUrl: null }));
		expect(m.body.uri).toBe(m.image);
		expect(m._gatewayCandidates.body).toEqual(m._gatewayCandidates.image);
	});

	it('emits empty chains, never undefined, for an agent with no off-chain art', () => {
		const m = toManifest(resolved({ image: null, glbUrl: null }));
		expect(m._gatewayCandidates).toEqual({ body: [], image: [] });
	});
});
