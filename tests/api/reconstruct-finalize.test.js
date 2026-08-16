// Unit tests for the shared selfie → 3D finalize stage: the rig-or-materialize
// decision, the auto-rig chain, and the never-empty-handed fallbacks. Providers
// and storage are mocked so the control flow is exercised without live ML.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks ──────────────────────────────────────────────────────────────────
const sqlMock = vi.fn(async () => []);
vi.mock('../../api/_lib/db.js', () => ({ sql: (...args) => sqlMock(...args), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const putObjectMock = vi.fn(async () => undefined);
const publicUrlMock = vi.fn((key) => `https://cdn.test/${key}`);
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...a) => putObjectMock(...a),
	publicUrl: (...a) => publicUrlMock(...a),
}));

const createAvatarMock = vi.fn(async ({ input }) => ({ id: 'avatar-1', name: input.name, slug: input.slug }));
vi.mock('../../api/_lib/avatars.js', () => ({
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}/m.glb`,
	createAvatar: (...a) => createAvatarMock(...a),
}));

const inspectGlbMock = vi.fn();
vi.mock('../../api/_lib/glb-inspect.js', () => ({
	inspectGlb: (...a) => inspectGlbMock(...a),
	isValidGlbHeader: () => true,
}));

vi.mock('../../api/_lib/webhook-dispatch.js', () => ({ dispatchWebhooks: async () => {} }));

// Every terminal materialize also registers the result in the Forge store so
// galleries/share pages see reconstructions; mocked here so the control flow
// (and its never-blocks-delivery contract) is what's under test.
const registerReconstructionCreationMock = vi.fn(async () => 'creation-1');
vi.mock('../../api/_lib/forge-store.js', () => ({
	registerReconstructionCreation: (...a) => registerReconstructionCreationMock(...a),
}));

// Roadmap Phase 1 draft mint fires on every materialize; mocked here so the
// finalize control flow is what's under test (the mint orchestration itself is
// covered by tests/api/draft-mint.test.js).
const mintDraftAgentIdentityMock = vi.fn(async () => ({ status: 'ok' }));
vi.mock('../../api/_lib/draft-mint.js', () => ({
	mintDraftAgentIdentity: (...a) => mintDraftAgentIdentityMock(...a),
}));

const providerMock = { name: 'replicate', instance: null };
vi.mock('../../api/_lib/regen-provider.js', () => ({
	getRegenProvider: async () => providerMock,
	// Mirror the real resolver: return the provider only when it supports the mode.
	getRegenProviderForMode: async (mode) =>
		providerMock.instance?.supportsMode?.(mode) ? providerMock : { name: 'none', instance: null },
}));

// Provider/result GLBs (the reconstruct output, the rigged result, and the bare
// unrigged mesh) are now fetched through the shared guard, which uses raw node
// http rather than the global fetch — so we mock the guarded helper. The real
// host-allowlist + extract logic is covered by tests/provider-result-url.test.js.
const fetchProviderGlbBufferMock = vi.fn(async () => Buffer.from(new Uint8Array([0x67, 0x6c, 0x54, 0x46])));
vi.mock('../../api/_lib/provider-result-url.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, fetchProviderGlbBuffer: (...a) => fetchProviderGlbBufferMock(...a) };
});

const { finalizeReconstructStage, pollRiggingStage, describeDraftMint } = await import('../../api/_lib/reconstruct-finalize.js');

const RIGGED = { isRigged: true, skinCount: 1, skeletonJointCount: 30, nodeCount: 40, meshCount: 1, animationCount: 0, generator: 'test' };
const UNRIGGED = { isRigged: false, skinCount: 0, skeletonJointCount: 0, nodeCount: 2, meshCount: 1, animationCount: 0, generator: 'test' };

const baseJob = { provider: 'replicate', params: { name: 'Me', visibility: 'private' } };

beforeEach(() => {
	vi.clearAllMocks();
	providerMock.instance = null;
});

describe('finalizeReconstructStage', () => {
	it('materializes immediately when the mesh is already rigged', async () => {
		inspectGlbMock.mockReturnValue(RIGGED);
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out).toEqual({ status: 'done', resultAvatarId: 'avatar-1' });
		expect(createAvatarMock).toHaveBeenCalledOnce();
		// No 'unrigged' tag on a rigged mesh.
		expect(createAvatarMock.mock.calls[0][0].input.tags).not.toContain('unrigged');
	});

	it('materializes unrigged (tagged) when no rig model is configured', async () => {
		inspectGlbMock.mockReturnValue(UNRIGGED);
		providerMock.instance = { supportsMode: () => false }; // rerig unavailable
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out.status).toBe('done');
		expect(createAvatarMock.mock.calls[0][0].input.tags).toContain('unrigged');
	});

	it('chains an auto-rig job when the mesh is unrigged and a rig model exists', async () => {
		inspectGlbMock.mockReturnValue(UNRIGGED);
		const submit = vi.fn(async () => ({ extJobId: 'rig-ext-1' }));
		providerMock.instance = { supportsMode: (m) => m === 'rerig', submit };
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out).toEqual({ status: 'rigging' });
		expect(submit).toHaveBeenCalledOnce();
		expect(submit.mock.calls[0][0].mode).toBe('rerig');
		// Bare mesh stored so the rig model can fetch it, but NO avatar yet.
		expect(putObjectMock).toHaveBeenCalled();
		expect(createAvatarMock).not.toHaveBeenCalled();
	});

	it('falls back to delivering the bare mesh if the rig job cannot be submitted', async () => {
		inspectGlbMock.mockReturnValue(UNRIGGED);
		providerMock.instance = { supportsMode: () => true, submit: vi.fn(async () => { throw new Error('rig down'); }) };
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out.status).toBe('done');
		expect(createAvatarMock.mock.calls[0][0].input.tags).toContain('unrigged');
	});

	it('registers the delivered avatar in the Forge store with its visibility mirrored', async () => {
		inspectGlbMock.mockReturnValue(RIGGED);
		await finalizeReconstructStage({
			userId: 'u1',
			jobId: 'j1',
			job: { provider: 'gcp', params: { name: 'Me', visibility: 'unlisted' } },
			glbUrl: 'https://x/m.glb',
		});
		expect(registerReconstructionCreationMock).toHaveBeenCalledOnce();
		const reg = registerReconstructionCreationMock.mock.calls[0][0];
		expect(reg.userId).toBe('u1');
		expect(reg.avatarId).toBe('avatar-1');
		expect(reg.jobId).toBe('j1');
		expect(reg.provider).toBe('gcp');
		expect(reg.visibility).toBe('unlisted');
		expect(reg.glbUrl).toMatch(/^https:\/\/cdn\.test\/u\/u1\//);
		// The selfie lane has no prompt: the honest display line is the name.
		expect(reg.prompt).toBe('Me');
	});

	it('still delivers the avatar when Forge-store registration throws', async () => {
		inspectGlbMock.mockReturnValue(RIGGED);
		registerReconstructionCreationMock.mockRejectedValueOnce(new Error('store down'));
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out).toEqual({ status: 'done', resultAvatarId: 'avatar-1' });
	});

	it('fires the draft agent mint for the delivered avatar', async () => {
		inspectGlbMock.mockReturnValue(RIGGED);
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out.status).toBe('done');
		expect(mintDraftAgentIdentityMock).toHaveBeenCalledOnce();
		expect(mintDraftAgentIdentityMock.mock.calls[0][0]).toEqual({ userId: 'u1', avatarId: 'avatar-1', jobId: 'j1' });
	});

	it('still delivers the avatar when the draft mint throws', async () => {
		inspectGlbMock.mockReturnValue(RIGGED);
		mintDraftAgentIdentityMock.mockRejectedValueOnce(new Error('mint down'));
		const out = await finalizeReconstructStage({ userId: 'u1', jobId: 'j1', job: baseJob, glbUrl: 'https://x/m.glb' });
		expect(out).toEqual({ status: 'done', resultAvatarId: 'avatar-1' });
	});
});

describe('pollRiggingStage', () => {
	const rigJob = {
		provider: 'replicate',
		params: { name: 'Me', visibility: 'private', rig: { extJobId: 'rig-ext-1', storageKey: 'u/u1/selfie-x/m.glb', slug: 'selfie-x', unriggedUrl: 'https://cdn.test/bare.glb' } },
	};

	it('materializes the rigged GLB when the rig job completes', async () => {
		inspectGlbMock.mockReturnValue(RIGGED);
		providerMock.instance = { supportsMode: (m) => m === 'rerig', status: vi.fn(async () => ({ status: 'done', resultGlbUrl: 'https://x/rigged.glb' })) };
		const out = await pollRiggingStage({ userId: 'u1', jobId: 'j1', job: rigJob });
		expect(out).toEqual({ status: 'done', resultAvatarId: 'avatar-1' });
		expect(createAvatarMock.mock.calls[0][0].input.source_meta.rigged).toBe(true);
	});

	it('falls back to the bare mesh when the rig job fails', async () => {
		inspectGlbMock.mockReturnValue(UNRIGGED);
		providerMock.instance = { supportsMode: (m) => m === 'rerig', status: vi.fn(async () => ({ status: 'failed', error: 'rig oom' })) };
		const out = await pollRiggingStage({ userId: 'u1', jobId: 'j1', job: rigJob });
		expect(out.status).toBe('done');
		expect(createAvatarMock.mock.calls[0][0].input.tags).toContain('unrigged');
	});

	it('stays in rigging while the rig job is still running', async () => {
		providerMock.instance = { supportsMode: (m) => m === 'rerig', status: vi.fn(async () => ({ status: 'running' })) };
		const out = await pollRiggingStage({ userId: 'u1', jobId: 'j1', job: rigJob });
		expect(out).toEqual({ status: 'rigging' });
		expect(createAvatarMock).not.toHaveBeenCalled();
	});
});
