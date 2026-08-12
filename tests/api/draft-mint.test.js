// Unit tests for the draft agent mint orchestration (api/_lib/draft-mint.js):
// flag parsing, idempotency, the Solana-first leg, the flagged ERC-8004 EVM
// leg, and the best-effort avatar stamp. All chain/storage boundaries are
// injected fakes; no network, no chain, no R2.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../../api/_lib/agent-identity.js', () => ({
	resolveOrCreateAgentForAvatar: vi.fn(async () => null),
}));

const {
	mintDraftAgentIdentity,
	resolveDraftMintNetwork,
	resolveDraftMintEvm,
} = await import('../../api/_lib/draft-mint.js');

function makeDeps(overrides = {}) {
	return {
		resolveAgent: vi.fn(async () => ({ id: 'agent-1', name: 'Me' })),
		loadAgentContext: vi.fn(async () => ({
			id: 'agent-1',
			user_id: 'u1',
			name: 'Me',
			description: null,
			meta: {},
			avatar_id: 'avatar-1',
			thumbnail_key: 'u/u1/a/thumb.png',
			storage_key: 'u/u1/a/m.glb',
		})),
		solanaMint: vi.fn(async () => ({
			status: 'minted',
			network: 'devnet',
			asset: 'Asset111',
			signature: 'Sig111',
			collection: 'Col111',
		})),
		evmMint: vi.fn(async () => ({ status: 'dry_run', chainId: 84532 })),
		persistAvatarDraft: vi.fn(async () => {}),
		network: 'devnet',
		evm: { enabled: false, chainId: 84532 },
		...overrides,
	};
}

beforeEach(() => vi.clearAllMocks());

describe('resolveDraftMintNetwork', () => {
	it('defaults to devnet (the automated proof path)', () => {
		expect(resolveDraftMintNetwork({})).toBe('devnet');
	});
	it('only activates mainnet on an explicit opt-in', () => {
		expect(resolveDraftMintNetwork({ DRAFT_AGENT_MINT_NETWORK: 'mainnet' })).toBe('mainnet');
		expect(resolveDraftMintNetwork({ DRAFT_AGENT_MINT_NETWORK: 'MAINNET' })).toBe('mainnet');
		expect(resolveDraftMintNetwork({ DRAFT_AGENT_MINT_NETWORK: 'prod' })).toBe('devnet');
	});
	it('honours the off switch', () => {
		expect(resolveDraftMintNetwork({ DRAFT_AGENT_MINT_NETWORK: 'off' })).toBe('off');
		expect(resolveDraftMintNetwork({ DRAFT_AGENT_MINT_NETWORK: '0' })).toBe('off');
	});
});

describe('resolveDraftMintEvm', () => {
	it('is disabled by default and targets Base Sepolia', () => {
		expect(resolveDraftMintEvm({})).toEqual({ enabled: false, chainId: 84532 });
	});
	it('enables with a truthy flag and honours a chain override', () => {
		expect(
			resolveDraftMintEvm({ DRAFT_AGENT_MINT_EVM_ENABLED: '1', DRAFT_AGENT_MINT_EVM_CHAIN_ID: '11155111' }),
		).toEqual({ enabled: true, chainId: 11155111 });
	});
});

describe('mintDraftAgentIdentity', () => {
	it('returns no_agent when the avatar cannot resolve to an identity', async () => {
		const deps = makeDeps({ resolveAgent: vi.fn(async () => null) });
		const out = await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1' }, deps);
		expect(out.status).toBe('no_agent');
		expect(deps.solanaMint).not.toHaveBeenCalled();
		expect(deps.persistAvatarDraft).not.toHaveBeenCalled();
	});

	it('mints the Solana draft on devnet by default and stamps the avatar', async () => {
		const deps = makeDeps();
		const out = await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1', jobId: 'j1' }, deps);
		expect(out.status).toBe('ok');
		expect(out.agentId).toBe('agent-1');
		expect(deps.solanaMint).toHaveBeenCalledOnce();
		expect(deps.solanaMint.mock.calls[0][0].network).toBe('devnet');
		expect(out.solana.status).toBe('minted');
		// EVM leg stays dark without its flag.
		expect(deps.evmMint).not.toHaveBeenCalled();
		expect(out.evm).toBeNull();
		expect(deps.persistAvatarDraft).toHaveBeenCalledOnce();
		const stamp = deps.persistAvatarDraft.mock.calls[0][0];
		expect(stamp.avatarId).toBe('a1');
		expect(stamp.jobId).toBe('j1');
		expect(stamp.solana.signature).toBe('Sig111');
	});

	it('never touches a chain when the network flag is off', async () => {
		const deps = makeDeps({ network: 'off' });
		const out = await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1' }, deps);
		expect(out.status).toBe('ok');
		expect(deps.solanaMint).not.toHaveBeenCalled();
		expect(out.solana).toBeNull();
		expect(deps.persistAvatarDraft).not.toHaveBeenCalled();
	});

	it('passes mainnet through unchanged when explicitly requested', async () => {
		const deps = makeDeps({ network: 'mainnet' });
		await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1' }, deps);
		expect(deps.solanaMint.mock.calls[0][0].network).toBe('mainnet');
	});

	it('runs the EVM leg only behind its flag', async () => {
		const deps = makeDeps({ evm: { enabled: true, chainId: 84532 } });
		const out = await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1' }, deps);
		expect(deps.evmMint).toHaveBeenCalledOnce();
		expect(deps.evmMint.mock.calls[0][0].chainId).toBe(84532);
		expect(out.evm.status).toBe('dry_run');
	});

	it('does not stamp the avatar when the Solana leg skipped (no authority)', async () => {
		const deps = makeDeps({
			solanaMint: vi.fn(async () => ({ status: 'skipped', reason: 'authority_unconfigured', network: 'devnet' })),
		});
		const out = await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1' }, deps);
		expect(out.solana.status).toBe('skipped');
		expect(deps.persistAvatarDraft).not.toHaveBeenCalled();
	});

	it('a stamp failure is absorbed (mint result already stands)', async () => {
		const deps = makeDeps({
			persistAvatarDraft: vi.fn(async () => { throw new Error('db down'); }),
		});
		const out = await mintDraftAgentIdentity({ userId: 'u1', avatarId: 'a1' }, deps);
		expect(out.solana.status).toBe('minted');
	});
});
