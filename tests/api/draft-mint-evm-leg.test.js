// Unit tests for the draft mint's chain legs themselves (api/_lib/draft-mint.js),
// as opposed to the orchestration around them (tests/api/draft-mint.test.js,
// which injects both legs as fakes and therefore never executes their bodies).
//
// The ERC-8004 leg's broadcast branch is the dangerous one to leave uncovered:
// it runs AFTER register(string) has already landed on chain, so a defect there
// cannot be undone by retrying. Everything below the leg (RPC, wallet custody,
// pinning, ethers' signer/contract) is a boundary and is injected; the calldata
// encoder stays real so the register(string) selector is genuinely exercised.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const AGENT_WALLET = '0x1111111111111111111111111111111111111111';

const sqlMock = vi.fn(async (strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM agent_identities ai/.test(q)) {
		return [{ id: 'agent-1', user_id: 'u1', meta: { encrypted_wallet_key: 'enc:agent-1' } }];
	}
	if (/SELECT meta FROM agent_identities/.test(q)) return [{ meta: { keep: 'me' } }];
	return [];
});

vi.mock('../../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../../api/_lib/agent-identity.js', () => ({
	resolveOrCreateAgentForAvatar: vi.fn(async () => null),
}));
vi.mock('../../api/_lib/erc8004-chains.js', () => ({
	CHAIN_BY_ID: {
		84532: { name: 'Base Sepolia', registry: REGISTRY, explorer: 'https://sepolia.basescan.org' },
	},
}));
vi.mock('../../api/_lib/ipfs-pin.js', () => ({
	pinToIPFS: vi.fn(async () => ({ uri: 'ipfs://bafyDraftCard' })),
}));
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: vi.fn(async () => {}),
	publicUrl: (key) => `https://three.ws/cdn/${key}`,
	thumbnailUrl: (key) => (key ? `https://three.ws/cdn/${key}` : null),
}));

const providerMock = {
	getBalance: vi.fn(async () => 10n ** 18n),
	estimateGas: vi.fn(async () => 120_000n),
};
vi.mock('../../api/_lib/evm/rpc.js', () => ({
	evmFallbackProvider: vi.fn(async () => providerMock),
}));
vi.mock('../../api/_lib/agent-wallet.js', () => ({
	getOrCreateAgentEvmWallet: vi.fn(async () => ({ address: AGENT_WALLET })),
	recoverAgentKey: vi.fn(async () => `0x${'ab'.repeat(32)}`),
}));

const receipt = {
	hash: `0x${'fe'.repeat(32)}`,
	blockNumber: 9_100_200,
	logs: [{ topics: [], data: '0x' }],
};
const registerCalls = [];

// Only the signer/contract boundary is replaced. Interface, parseEther and
// formatEther stay real so the encoded calldata under test is the real thing.
vi.mock('ethers', async (importOriginal) => {
	const actual = await importOriginal();
	class Wallet {
		constructor(key, provider) {
			this.address = `0x${'22'.repeat(20)}`;
			this.provider = provider;
		}
		sendTransaction = vi.fn(async () => ({ wait: async () => ({}) }));
	}
	class Contract {
		constructor(address, abi, signer) {
			this.target = address;
			this.signer = signer;
			this.interface = {
				parseLog: () => ({ name: 'Registered', args: ['42'] }),
			};
			this['register(string)'] = async (uri) => {
				registerCalls.push(uri);
				return { wait: async () => receipt };
			};
		}
	}
	return { ...actual, Wallet, Contract };
});

const { evmDraftMint, solanaDraftMint } = await import('../../api/_lib/draft-mint.js');

const agent = {
	id: 'agent-1',
	user_id: 'u1',
	name: 'Me',
	description: 'A reconstructed agent',
	meta: {},
	avatar_id: 'avatar-1',
	thumbnail_key: 'u/u1/a/thumb.png',
	storage_key: 'u/u1/a/model.glb',
};

beforeEach(() => {
	vi.clearAllMocks();
	registerCalls.length = 0;
	vi.unstubAllEnvs();
});

describe('evmDraftMint', () => {
	it('skips a chain the registry map does not cover', async () => {
		const out = await evmDraftMint({ agent, userId: 'u1', chainId: 999_999 });
		expect(out).toEqual({ status: 'skipped', reason: 'unsupported_chain', chainId: 999_999 });
	});

	it('short-circuits to already when the agent carries this chain registration', async () => {
		const minted = {
			...agent,
			meta: { onchain: { chain: 'eip155:84532', onchain_id: '7', tx_hash: '0xdead' } },
		};
		const out = await evmDraftMint({ agent: minted, userId: 'u1', chainId: 84532 });
		expect(out).toEqual({ status: 'already', chainId: 84532, onchainId: '7', txHash: '0xdead' });
		expect(registerCalls).toHaveLength(0);
	});

	it('dry-runs with real register(string) calldata when no treasury key is configured', async () => {
		vi.stubEnv('EVM_TREASURY_PRIVATE_KEY', '');
		const out = await evmDraftMint({ agent, userId: 'u1', chainId: 84532 });

		expect(out.status).toBe('dry_run');
		expect(out.missing).toBe('EVM_TREASURY_PRIVATE_KEY');
		expect(out.to).toBe(REGISTRY);
		expect(out.from).toBe(AGENT_WALLET);
		expect(out.metadataUri).toBe('ipfs://bafyDraftCard');
		// f2c298be is the real keccak selector for register(string).
		expect(out.data.startsWith('0xf2c298be')).toBe(true);
		expect(out.data).toContain(Buffer.from('ipfs://bafyDraftCard').toString('hex'));
		expect(out.estimatedGas).toBe('120000');
		// A dry run must never broadcast.
		expect(registerCalls).toHaveLength(0);
	});

	it('reports the on-chain id after a real registration', async () => {
		// Regression guard: this branch runs only after register(string) has
		// already been broadcast, so a bad reference here throws with the
		// transaction irreversibly on chain and the avatar stamp never written.
		vi.stubEnv('EVM_TREASURY_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
		const out = await evmDraftMint({ agent, userId: 'u1', chainId: 84532 });

		expect(out.status).toBe('minted');
		expect(out.onchainId).toBe('42');
		expect(out.txHash).toBe(receipt.hash);
		expect(out.chainId).toBe(84532);
		expect(out.chain).toBe('Base Sepolia');
		expect(out.registry).toBe(REGISTRY);
		expect(out.owner).toBe(AGENT_WALLET);
		expect(out.metadataUri).toBe('ipfs://bafyDraftCard');
		expect(out.explorer).toBe(`https://sepolia.basescan.org/tx/${receipt.hash}`);
		expect(registerCalls).toEqual(['ipfs://bafyDraftCard']);
	});

	it('persists the draft registration as an index row and a merged meta.onchain block', async () => {
		vi.stubEnv('EVM_TREASURY_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
		await evmDraftMint({ agent, userId: 'u1', chainId: 84532 });

		const queries = sqlMock.mock.calls.map(([strings]) => strings.join('?'));
		expect(queries.some((q) => /INSERT INTO\s+erc8004_agents_index/.test(q))).toBe(true);

		const updateCall = sqlMock.mock.calls.find(([strings]) =>
			/UPDATE agent_identities/.test(strings.join('?')),
		);
		expect(updateCall).toBeTruthy();
		const meta = JSON.parse(updateCall[1]);
		expect(meta.keep).toBe('me'); // pre-existing meta survives the merge
		expect(meta.onchain).toMatchObject({
			chain: 'eip155:84532',
			family: 'evm',
			onchain_id: '42',
			tx_hash: receipt.hash,
			contract_or_mint: REGISTRY,
			wallet: AGENT_WALLET.toLowerCase(),
			draft: true,
		});
	});

	it('does not broadcast when the agent has no recoverable custody key', async () => {
		vi.stubEnv('EVM_TREASURY_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
		sqlMock.mockImplementationOnce(async () => [{ id: 'agent-1', meta: {} }]);
		const out = await evmDraftMint({ agent, userId: 'u1', chainId: 84532 });
		expect(out).toEqual({ status: 'skipped', reason: 'no_evm_key', chainId: 84532 });
		expect(registerCalls).toHaveLength(0);
	});
});

describe('solanaDraftMint', () => {
	it('short-circuits a devnet draft without loading the mint stack', async () => {
		const out = await solanaDraftMint({
			agent: { ...agent, meta: { devnet: { sol_mint_address: 'DevAsset111' } } },
			network: 'devnet',
		});
		expect(out).toEqual({ status: 'already', network: 'devnet', asset: 'DevAsset111' });
	});

	it('keeps devnet and mainnet drafts in separate namespaces', async () => {
		// A devnet asset must never satisfy the mainnet idempotency check, or an
		// operator flipping the flag to mainnet would silently mint nothing.
		const devnetOnly = { ...agent, meta: { devnet: { sol_mint_address: 'DevAsset111' } } };
		const out = await solanaDraftMint({ agent: devnetOnly, network: 'mainnet' });
		expect(out.status).not.toBe('already');
	});
});
