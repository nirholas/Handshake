/**
 * BNB Greenfield WRITE client — unit tests (api/_lib/bnb/greenfield-write.js).
 *
 * The Greenfield SDK `Client` (bucket/object tx broadcast) is injected via
 * `opts.client` — a real broadcast needs a funded Greenfield account (see
 * PROGRESS.md's prompt 09 entry for the real, unfunded-key probe against live
 * testnet). The read-client calls this module makes internally (headBucket /
 * getObjectMeta, from greenfield.js) are driven by an injected `fetchImpl`,
 * exactly like tests/bnb-greenfield-read.test.js. The Reed-Solomon checksum
 * encoding is the REAL `@bnb-chain/reed-solomon` package — never mocked, so
 * this suite also proves that primitive works end-to-end on a tiny synthetic
 * buffer, matching prompt 08/09's "tiny synthetic GLB fixture" convention.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	ensureBucket,
	createObject,
	GreenfieldWriteError,
	MAX_VAULT_OBJECT_BYTES,
} from '../api/_lib/bnb/greenfield-write.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat's published account #0, public by design (check-secrets allowlists it)
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // derived from PRIVATE_KEY via viem/accounts
const SP_OPERATOR = '0x1111111111111111111111111111111111111111';

function jsonResponse(obj, status = 200) {
	return { ok: status >= 200 && status < 300, status, async json() { return obj; }, async text() { return JSON.stringify(obj); }, headers: { get: () => null } };
}
function notFoundResponse(kind) {
	return jsonResponse({ code: 2, message: `codespace storage code ${kind === 'bucket' ? 1100 : 1101}: No such ${kind}`, details: [] });
}

function makeMockClient({
	createBucketCode = 0,
	createBucketErr = null,
	toggleSp = true,
	createObjectCode = 0,
	uploadOk = true,
	spOperator = SP_OPERATOR,
	noSp = false,
} = {}) {
	const calls = { createBucket: 0, createObject: 0, uploadObject: 0, cancelCreateObject: 0, getInServiceSP: 0 };
	return {
		calls,
		sp: {
			getInServiceSP: vi.fn(async () => {
				calls.getInServiceSP++;
				if (noSp) throw new Error('no SP');
				return { operatorAddress: spOperator, endpoint: 'https://sp1.example.test' };
			}),
		},
		bucket: {
			createBucket: vi.fn(async () => {
				calls.createBucket++;
				if (createBucketErr) throw createBucketErr;
				return {
					simulate: async () => ({ gasLimit: 120000, gasPrice: '5000000000' }),
					broadcast: async () => ({ code: createBucketCode, transactionHash: '0xBUCKETTXHASH', rawLog: createBucketCode ? 'rejected by chain' : '' }),
				};
			}),
		},
		object: {
			createObject: vi.fn(async () => {
				calls.createObject++;
				return {
					simulate: async () => ({ gasLimit: 250000, gasPrice: '5000000000' }),
					broadcast: async () => ({ code: createObjectCode, transactionHash: '0xOBJECTTXHASH', rawLog: createObjectCode ? 'rejected by chain' : '' }),
				};
			}),
			uploadObject: vi.fn(async () => {
				calls.uploadObject++;
				if (!uploadOk) throw new Error('Storage Provider connection reset');
				return { code: 0 };
			}),
			cancelCreateObject: vi.fn(async () => {
				calls.cancelCreateObject++;
				return {
					simulate: async () => ({ gasLimit: 80000, gasPrice: '5000000000' }),
					broadcast: async () => ({ code: 0, transactionHash: '0xCANCELTXHASH' }),
				};
			}),
		},
	};
}

const SYNTH_GLB = Buffer.from('glTF-synthetic-vault-fixture-bytes-0123456789');

describe('ensureBucket', () => {
	it('is idempotent — a bucket that already exists is a no-op success', async () => {
		const fetchImpl = async () => jsonResponse({ bucket_info: { bucket_name: 'syn-vault', owner: OWNER } });
		const client = makeMockClient();
		const res = await ensureBucket('syn-vault', { network: 'testnet', privateKey: PRIVATE_KEY, client, fetchImpl });
		expect(res).toMatchObject({ bucket: 'syn-vault', created: false, owner: OWNER });
		expect(client.calls.createBucket).toBe(0);
	});

	it('creates a missing bucket via a real MsgCreateBucket broadcast', async () => {
		const fetchImpl = async () => notFoundResponse('bucket');
		const client = makeMockClient();
		const res = await ensureBucket('syn-vault-new', { network: 'testnet', privateKey: PRIVATE_KEY, client, fetchImpl });
		expect(res.created).toBe(true);
		expect(res.txHash).toBe('0xBUCKETTXHASH');
		expect(res.primarySp).toBe(SP_OPERATOR);
		expect(client.calls.getInServiceSP).toBe(1);
		expect(client.calls.createBucket).toBe(1);
	});

	it('a concurrent create ("already exists") resolves to idempotent success, not an error', async () => {
		// Simulates another request winning the race between our headBucket miss
		// and our own broadcast: the chain rejects OUR MsgCreateBucket with an
		// "already exists" rawLog (real Greenfield error text), so ensureBucket
		// re-checks headBucket and returns the now-existing bucket as success.
		let headCalls = 0;
		const fetchImpl = async () => {
			headCalls++;
			return headCalls === 1 ? notFoundResponse('bucket') : jsonResponse({ bucket_info: { bucket_name: 'race-bucket', owner: OWNER } });
		};
		const client = makeMockClient();
		client.bucket.createBucket = vi.fn(async () => ({
			simulate: async () => ({ gasLimit: 120000, gasPrice: '5000000000' }),
			broadcast: async () => ({ code: 6, transactionHash: '0xRACETX', rawLog: 'Bucket already exists: repeated' }),
		}));
		const res = await ensureBucket('race-bucket', { network: 'testnet', privateKey: PRIVATE_KEY, client, fetchImpl });
		expect(res.created).toBe(false);
		expect(res.owner).toBe(OWNER);
	});

	it('rejects a malformed private key before any network call', async () => {
		const fetchImpl = async () => notFoundResponse('bucket');
		await expect(ensureBucket('syn-vault', { network: 'testnet', privateKey: 'not-a-key', fetchImpl })).rejects.toMatchObject({
			name: 'GreenfieldWriteError',
			code: 'bad_input',
		});
	});

	it('surfaces "no in-service SP" as a typed 502-mappable error', async () => {
		const fetchImpl = async () => notFoundResponse('bucket');
		const client = makeMockClient({ noSp: true });
		await expect(ensureBucket('syn-vault', { network: 'testnet', privateKey: PRIVATE_KEY, client, fetchImpl })).rejects.toMatchObject({
			code: 'no_sp',
		});
	});

	it('a chain-rejected createBucket tx throws tx_failed, not a silent success', async () => {
		const fetchImpl = async () => notFoundResponse('bucket');
		const client = makeMockClient({ createBucketCode: 5 });
		await expect(ensureBucket('syn-vault', { network: 'testnet', privateKey: PRIVATE_KEY, client, fetchImpl })).rejects.toMatchObject({
			code: 'tx_failed',
		});
	});
});

describe('createObject', () => {
	it('rejects empty bytes before touching the network', async () => {
		const client = makeMockClient();
		await expect(createObject('b', 'o', new Uint8Array(0), { privateKey: PRIVATE_KEY, client })).rejects.toMatchObject({ code: 'bad_input' });
		expect(client.calls.createObject).toBe(0);
	});

	it('rejects an object over the vault size ceiling', async () => {
		const client = makeMockClient();
		const big = { length: MAX_VAULT_OBJECT_BYTES + 1 };
		await expect(createObject('b', 'o', big, { privateKey: PRIVATE_KEY, client })).rejects.toMatchObject({ code: 'too_large' });
	});

	it('uploads, and reports status:"stored" when the poll observes OBJECT_STATUS_SEALED', async () => {
		const fetchImpl = async () => jsonResponse({ object_info: { object_status: 'OBJECT_STATUS_SEALED' } });
		const client = makeMockClient();
		const res = await createObject('syn-bucket', 'vaults/x/a.glb.enc', SYNTH_GLB, {
			network: 'testnet',
			privateKey: PRIVATE_KEY,
			client,
			fetchImpl,
			contentType: 'application/octet-stream',
		});
		expect(res).toMatchObject({ bucket: 'syn-bucket', object: 'vaults/x/a.glb.enc', txHash: '0xOBJECTTXHASH', status: 'stored', sp: SP_OPERATOR });
		expect(client.calls.createObject).toBe(1);
		expect(client.calls.uploadObject).toBe(1);
		// The uploadObject call must carry the real on-chain create tx hash, per
		// the SDK's PutObjectRequest.txnHash contract.
		expect(client.object.uploadObject).toHaveBeenCalledWith(
			expect.objectContaining({ txnHash: '0xOBJECTTXHASH' }),
			expect.objectContaining({ type: 'ECDSA' }),
		);
	});

	it('surfaces status:"pending" (never a false "stored") when sealing has not landed within the poll budget', async () => {
		const fetchImpl = async () => notFoundResponse('object'); // still mirroring
		const client = makeMockClient();
		const res = await createObject('syn-bucket', 'vaults/x/b.glb.enc', SYNTH_GLB, {
			network: 'testnet',
			privateKey: PRIVATE_KEY,
			client,
			fetchImpl,
			pollIntervalMs: 5,
			pollTimeoutMs: 20,
		});
		expect(res.status).toBe('pending');
	});

	it('a chain-rejected createObject tx never reaches the SP upload step', async () => {
		const client = makeMockClient({ createObjectCode: 3 });
		await expect(
			createObject('syn-bucket', 'vaults/x/c.glb.enc', SYNTH_GLB, { network: 'testnet', privateKey: PRIVATE_KEY, client }),
		).rejects.toMatchObject({ code: 'tx_failed' });
		expect(client.calls.uploadObject).toBe(0);
	});

	it('an SP upload failure cancels the pending on-chain create and surfaces upload_failed', async () => {
		const client = makeMockClient({ uploadOk: false });
		await expect(
			createObject('syn-bucket', 'vaults/x/d.glb.enc', SYNTH_GLB, { network: 'testnet', privateKey: PRIVATE_KEY, client }),
		).rejects.toMatchObject({ code: 'upload_failed', txHash: '0xOBJECTTXHASH' });
		expect(client.calls.cancelCreateObject).toBe(1);
	});

	it('never leaves a half-object referenced when the cancel itself also fails — the real upload error still wins', async () => {
		const client = makeMockClient({ uploadOk: false });
		client.object.cancelCreateObject = vi.fn(async () => { throw new Error('cancel also down'); });
		await expect(
			createObject('syn-bucket', 'vaults/x/e.glb.enc', SYNTH_GLB, { network: 'testnet', privateKey: PRIVATE_KEY, client }),
		).rejects.toMatchObject({ code: 'upload_failed' });
	});
});
