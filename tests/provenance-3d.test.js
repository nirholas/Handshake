import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import {
	PROVENANCE_3D_VERSION,
	PROVENANCE_3D_VERSIONS,
	sha256Hex,
	buildCredential,
	signCredential,
	verifyCredentialSignature,
	credentialHash,
	decideVerdict,
	provenanceKey,
	explorerTxUrl,
	credentialCanonicalBytes,
} from '../api/_lib/provenance-3d.js';
import { gradeSimReadiness, signedGradeSubset, SIM_READINESS_VERSION } from '../api/_lib/sim-readiness.js';

// A deterministic test issuer (32-byte seed) so signatures are reproducible.
const SEED = new Uint8Array(32).fill(7);
const PUB = bs58.encode(ed25519.getPublicKey(SEED));
const GLB = Buffer.from('a fake but stable GLB payload v1');
const GLB_HASH = sha256Hex(GLB);

function makeEnvelope(overrides = {}) {
	const credential = buildCredential({
		glbSha256: GLB_HASH,
		createdAt: '2026-07-08T00:00:00.000Z',
		creator: 'creator-1',
		prompt: 'a friendly robot',
		model: 'TRELLIS',
		provider: 'nvidia',
		...overrides.credentialFields,
	});
	const { signature, issuer } = signCredential(credential, SEED);
	return { credential, signature, issuer, ...overrides.envelope };
}

describe('sha256Hex', () => {
	it('is deterministic and 64 hex chars', () => {
		expect(GLB_HASH).toMatch(/^[0-9a-f]{64}$/);
		expect(sha256Hex(GLB)).toBe(GLB_HASH);
	});
	it('changes when a single byte changes (tamper sensitivity)', () => {
		expect(sha256Hex(Buffer.concat([GLB, Buffer.from('!')]))).not.toBe(GLB_HASH);
	});
});

describe('buildCredential', () => {
	it('requires a valid 64-hex glbSha256 and a createdAt', () => {
		expect(() => buildCredential({ glbSha256: 'nope', createdAt: 'x' })).toThrow(/sha256/);
		expect(() => buildCredential({ glbSha256: GLB_HASH })).toThrow(/createdAt/);
	});
	it('stamps the version and includes only provided optional fields', () => {
		const c = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x', prompt: 'p' });
		expect(c.version).toBe(PROVENANCE_3D_VERSION);
		expect(c.prompt).toBe('p');
		expect(c.creator).toBeUndefined();
	});
});

describe('sign / verify', () => {
	it('a freshly signed credential verifies against its issuer', () => {
		const c = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x', prompt: 'p' });
		const { signature, issuer } = signCredential(c, SEED);
		expect(issuer).toBe(PUB);
		expect(verifyCredentialSignature(c, signature, issuer)).toBe(true);
	});
	it('fails if the credential body is altered after signing', () => {
		const c = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x', prompt: 'p' });
		const { signature, issuer } = signCredential(c, SEED);
		expect(verifyCredentialSignature({ ...c, prompt: 'DIFFERENT' }, signature, issuer)).toBe(false);
	});
	it('fails against a different issuer key', () => {
		const c = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x' });
		const { signature } = signCredential(c, SEED);
		const otherPub = bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
		expect(verifyCredentialSignature(c, signature, otherPub)).toBe(false);
	});
	it('credentialHash is stable and 64 hex', () => {
		const c = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x' });
		expect(credentialHash(c)).toMatch(/^[0-9a-f]{64}$/);
		expect(credentialHash(c)).toBe(credentialHash({ ...c })); // key order independent
	});
});

describe('decideVerdict', () => {
	it('verified — signature valid and bytes match', () => {
		expect(decideVerdict(GLB_HASH, makeEnvelope()).status).toBe('verified');
	});
	it('unknown — no credential on record', () => {
		expect(decideVerdict(GLB_HASH, null).status).toBe('unknown');
	});
	it('tampered — the served bytes do not match the signed hash', () => {
		const otherHash = sha256Hex(Buffer.from('modified bytes'));
		expect(decideVerdict(otherHash, makeEnvelope()).status).toBe('tampered');
	});
	it('tampered — the credential signature was forged/altered', () => {
		const env = makeEnvelope();
		env.credential.prompt = 'silently changed after signing';
		expect(decideVerdict(GLB_HASH, env).status).toBe('tampered');
	});
});

// v2 adds one optional field and nothing else. The permanent obligation the
// version bump creates is that a credential signed under v1, before the field
// existed, keeps verifying byte for byte forever: a credential is evidence, and
// re-issuing evidence is not an option.
describe('credential versioning (v1 keeps verifying under v2)', () => {
	// A v1 credential exactly as the pre-v2 code emitted it, signed over its own
	// canonical bytes. Hand-built rather than produced by buildCredential, which
	// now stamps v2 and could never regress into emitting this again.
	function v1Envelope() {
		const credential = {
			version: 'threews.provenance.3d.v1',
			glbSha256: GLB_HASH,
			createdAt: '2026-07-08T00:00:00.000Z',
			creator: 'creator-1',
			prompt: 'a friendly robot',
			model: 'TRELLIS',
			provider: 'nvidia',
		};
		const { signature, issuer } = signCredential(credential, SEED);
		return { credential, signature, issuer };
	}

	it('the current version is v2 and both versions are implemented', () => {
		expect(PROVENANCE_3D_VERSION).toBe('threews.provenance.3d.v2');
		expect(PROVENANCE_3D_VERSIONS).toContain('threews.provenance.3d.v1');
		expect(PROVENANCE_3D_VERSIONS).toContain('threews.provenance.3d.v2');
	});

	it('a v1 credential signed before v2 existed still verifies', () => {
		const verdict = decideVerdict(GLB_HASH, v1Envelope());
		expect(verdict.status).toBe('verified');
		expect(verdict.version).toBe('threews.provenance.3d.v1');
		// v1 predates the field, so nothing may be read back as a signed grade.
		expect(verdict.simReadiness).toBeNull();
	});

	it('a v1 credential is still tamper-evident', () => {
		const env = v1Envelope();
		env.credential.prompt = 'silently changed after signing';
		expect(decideVerdict(GLB_HASH, env).status).toBe('tampered');
	});

	it('reports unknown for a version this verifier does not implement', () => {
		const credential = { version: 'threews.provenance.3d.v9', glbSha256: GLB_HASH, createdAt: 'x' };
		const { signature, issuer } = signCredential(credential, SEED);
		const verdict = decideVerdict(GLB_HASH, { credential, signature, issuer });
		expect(verdict.status).toBe('unknown');
		expect(verdict.reason).toContain('v9');
	});
});

describe('the signed simulation-readiness grade', () => {
	// The grade signed into a credential is the real grader's output over a real
	// mesh, not a hand-written object: the subset has to survive the actual
	// report shape, which is the only thing that can drift.
	async function realGrade() {
		const { Document, NodeIO } = await import('@gltf-transform/core');
		const h = 0.2;
		const positions = [-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h];
		const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
		const doc = new Document();
		const buffer = doc.createBuffer();
		const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
		const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(faces)).setBuffer(buffer);
		const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);
		doc.createScene('s').addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
		return gradeSimReadiness(Buffer.from(await new NodeIO().writeBinary(doc)));
	}

	it('signs only the documented subset, and it survives sign/verify', async () => {
		const report = await realGrade();
		const subset = signedGradeSubset(report);
		expect(subset.grader).toBe(SIM_READINESS_VERSION);
		expect(subset.verdict).toBe('simulation_ready');
		expect(subset.inertiaUnitDensity).toHaveLength(9);
		// The full report never enters the credential: the canonical bytes have to
		// stay small and stable, and every signed field is one a future grader
		// could contradict.
		expect(Object.keys(subset).sort()).toEqual([
			'blockers', 'convexityRatio', 'grader', 'inertiaUnitDensity', 'longestAxisMeters', 'verdict', 'volumeM3',
		]);
		expect(subset.topology).toBeUndefined();
		expect(subset.bounds).toBeUndefined();

		const credential = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x', simReadiness: subset });
		expect(credential.version).toBe('threews.provenance.3d.v2');
		expect(credential.simReadiness).toEqual(subset);
		const { signature, issuer } = signCredential(credential, SEED);
		const verdict = decideVerdict(GLB_HASH, { credential, signature, issuer });
		expect(verdict.status).toBe('verified');
		expect(verdict.simReadiness.verdict).toBe('simulation_ready');
	});

	it('a grade altered after signing breaks the signature', async () => {
		const subset = signedGradeSubset(await realGrade());
		const credential = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x', simReadiness: subset });
		const { signature, issuer } = signCredential(credential, SEED);
		credential.simReadiness.verdict = 'simulation_ready';
		credential.simReadiness.volumeM3 = 999;
		expect(decideVerdict(GLB_HASH, { credential, signature, issuer }).status).toBe('tampered');
	});

	it('omits the field rather than signing an unusable or absent grade', async () => {
		expect(signedGradeSubset(null)).toBeNull();
		expect(signedGradeSubset({ readable: false, verdict: 'unreadable', blockers: ['unreadable_glb'] })).toBeNull();
		const c = buildCredential({ glbSha256: GLB_HASH, createdAt: 'x', simReadiness: null });
		expect(c.simReadiness).toBeUndefined();
		// An undocumented key can never reach the signed bytes, because another
		// implementation reproducing the canonical form would not know to add it.
		const smuggled = buildCredential({
			glbSha256: GLB_HASH,
			createdAt: 'x',
			simReadiness: { grader: SIM_READINESS_VERSION, verdict: 'simulation_ready', note: 'trust me' },
		});
		expect(smuggled.simReadiness.note).toBeUndefined();
		expect(credentialCanonicalBytes(smuggled).toString('utf8')).not.toContain('trust me');
	});
});

describe('helpers', () => {
	it('provenanceKey addresses by hash', () => {
		expect(provenanceKey(GLB_HASH)).toBe(`provenance/${GLB_HASH}.json`);
	});
	it('explorerTxUrl includes the cluster for devnet only', () => {
		expect(explorerTxUrl('SIG', 'devnet')).toContain('?cluster=devnet');
		expect(explorerTxUrl('SIG', 'mainnet')).not.toContain('cluster');
	});
});

// The free verify tool, with R2 + GLB-fetch mocked. Proves the tool wires the
// pure verdict correctly and returns a coin-clean, public envelope.
describe('verify_provenance tool', () => {
	beforeEach(() => vi.resetModules());

	async function loadToolWithMocks({ glbBytes = GLB, stored = undefined } = {}) {
		vi.doMock('../api/_lib/ssrf-guard.js', () => ({
			fetchSafePublicUrl: vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => glbBytes })),
			assertSafePublicUrl: vi.fn(),
			SsrfBlockedError: class extends Error {},
		}));
		vi.doMock('../api/_lib/r2.js', () => ({
			getObjectBuffer: vi.fn(async () => (stored ? Buffer.from(JSON.stringify(stored), 'utf8') : null)),
			putObject: vi.fn(async () => ({})),
		}));
		vi.doMock('../api/_lib/provenance-anchor.js', () => ({
			anchorCredentialHash: vi.fn(),
			confirmAnchor: vi.fn(async () => true),
		}));
		const mod = await import('../api/_mcp3d/tools/provenance.js');
		return mod.toolDefs.find((d) => d.name === 'verify_provenance');
	}

	it('returns verified for a stored, signed, matching credential', async () => {
		const tool = await loadToolWithMocks({ stored: makeEnvelope() });
		const r = await tool.handler({ glb_url: 'https://three.ws/model.glb' });
		expect(r.structuredContent.status).toBe('verified');
		expect(r.structuredContent.badge).toBe('Verified · three.ws');
		expect(r.structuredContent.credential.prompt).toBe('a friendly robot');
	});

	it('returns unknown when no credential is stored', async () => {
		const tool = await loadToolWithMocks({ stored: undefined });
		const r = await tool.handler({ glb_url: 'https://three.ws/model.glb' });
		expect(r.structuredContent.status).toBe('unknown');
	});

	it('returns tampered when the served bytes differ from the signed hash', async () => {
		const tool = await loadToolWithMocks({ glbBytes: Buffer.from('DIFFERENT bytes'), stored: makeEnvelope() });
		const r = await tool.handler({ glb_url: 'https://three.ws/model.glb' });
		expect(r.structuredContent.status).toBe('tampered');
	});

	it('surfaces the on-chain anchor when present', async () => {
		const env = makeEnvelope({ envelope: { anchor: { signature: 'ANCHORSIG', cluster: 'devnet' } } });
		const tool = await loadToolWithMocks({ stored: env });
		const r = await tool.handler({ glb_url: 'https://three.ws/model.glb' });
		expect(r.structuredContent.anchor.tx).toBe('ANCHORSIG');
		expect(r.structuredContent.anchor.explorerUrl).toContain('explorer.solana.com');
	});

	it('rejects a request with neither glb_url nor a valid hash', async () => {
		const tool = await loadToolWithMocks({});
		const r = await tool.handler({});
		expect(r.isError).toBe(true);
	});

	it('the verify response carries no payment/coin/wallet surface (OpenAI-safe)', async () => {
		const tool = await loadToolWithMocks({ stored: makeEnvelope() });
		const r = await tool.handler({ glb_url: 'https://three.ws/model.glb' });
		const FORBIDDEN = /x402|payment|wallet|usdc|\$three|price|\bpaid\b|\btoken\b|\bcoin\b/i;
		expect(FORBIDDEN.test(JSON.stringify(r))).toBe(false);
	});
});
