// The custody loss measurement (api/_lib/custodial-key-health.js): the one
// number the CLI audit and the ops board both read.
//
// Every fence here is a defect that already shipped:
//
//  1. an unread balance summed as a confirmed zero, so the audit certified
//     "0 SOL stranded" on 2026-08-09 while two wallets held 0.12 SOL behind a
//     dead key. A wallet with no balance read must never reach a total.
//  2. the audit carried its own ownership predicate with a different house
//     account address than the reclaim leg enforces in SQL, filing 12 platform
//     wallets as CUSTOMER ones. The split feeds a customer support obligation,
//     so it has to be the reclaim leg's exact boundary.
//  3. the board must not turn a polled dashboard into a fleet-wide RPC scan:
//     the panel is snapshot-cached and concurrent reads share one scan.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ sql: async () => [] }));
vi.mock('../api/_lib/secret-box.js', () => ({
	decryptSecret: async () => 'plaintext',
	secretBoxKeyCandidates: () => ['key'],
}));

const {
	isPlatformOwnedAgent,
	classifyCustodialSecrets,
	summarizeCustodialKeyHealth,
	buildStrandedPanel,
	strandedCustodyPanel,
	resetStrandedCustodyCache,
	PLATFORM_AGENT_OWNER_EMAIL,
} = await import('../api/_lib/custodial-key-health.js');

const wallet = (address, owner, decryptable, extra = {}) => ({
	agent_id: `ag-${address}`,
	name: address,
	address,
	owner,
	decryptable,
	reason: decryptable ? null : 'wrong_key',
	...extra,
});

const HOUSE = PLATFORM_AGENT_OWNER_EMAIL;
const BOT = 'ashaatlas2@agents.three.ws';
const CUSTOMER = 'sol-525400bf57d11a28@wallet.local';

describe('ownership boundary', () => {
	it('counts the house account and the circulation bots as platform', () => {
		expect(isPlatformOwnedAgent(HOUSE)).toBe(true);
		expect(isPlatformOwnedAgent(BOT)).toBe(true);
		expect(isPlatformOwnedAgent(' ASHAATLAS2@AGENTS.THREE.WS ')).toBe(true);
	});

	it('counts everything else as a customer, including a lookalike domain', () => {
		expect(isPlatformOwnedAgent(CUSTOMER)).toBe(false);
		expect(isPlatformOwnedAgent('someone@users.three.ws.local')).toBe(false);
		// The suffix must match at the end, not anywhere: an attacker-chosen
		// local part must never buy platform classification.
		expect(isPlatformOwnedAgent('x@agents.three.ws.evil.com')).toBe(false);
		expect(isPlatformOwnedAgent(null)).toBe(false);
		expect(isPlatformOwnedAgent(undefined)).toBe(false);
	});
});

describe('secret classification', () => {
	it('marks a wallet undecryptable with the WebCrypto failure named, not a generic error', async () => {
		const rows = [{ secret: 'sealed' }, { secret: 'fine' }];
		const err = Object.assign(new Error('The operation failed'), { name: 'OperationError' });
		const rowsOut = await classifyCustodialSecrets(rows, async (s) => {
			if (s === 'sealed') throw err;
			return 'plaintext';
		});
		expect(rowsOut[0].decryptable).toBe(false);
		expect(rowsOut[0].reason).toBe('wrong_key');
		expect(rowsOut[1].decryptable).toBe(true);
		expect(rowsOut[1].reason).toBe(null);
	});

	it('treats an empty plaintext as undecryptable rather than a healthy wallet', async () => {
		const rows = await classifyCustodialSecrets([{ secret: 'empty' }], async () => '');
		expect(rows[0].decryptable).toBe(false);
		expect(rows[0].reason).toBe('empty_plaintext');
	});
});

describe('summary counting rules', () => {
	it('never sums a wallet whose balance was not read', () => {
		const wallets = [
			wallet('SEALED_READ', CUSTOMER, false),
			wallet('SEALED_UNREAD', CUSTOMER, false),
			wallet('OK', HOUSE, true),
		];
		const balances = new Map([['SEALED_READ', 0.25], ['OK', 1]]);
		const r = summarizeCustodialKeyHealth({
			wallets, balances,
			readErrors: [{ address: 'SEALED_UNREAD', reason: 'rpc_error: 403' }],
		});
		// 0.25, not 0.25 plus an invented zero for the wallet nobody could read.
		expect(r.sol.stranded).toBe(0.25);
		expect(r.counts.stranded_unread).toBe(1);
		expect(r.counts.stranded_funded).toBe(1);
		expect(r.unread_stranded.map((w) => w.address)).toEqual(['SEALED_UNREAD']);
		expect(r.read_errors).toBe(1);
	});

	it('splits stranded SOL by the reclaim leg’s ownership boundary', () => {
		const wallets = [
			wallet('BOT', BOT, false),
			wallet('HOUSE', HOUSE, false),
			wallet('CUST', CUSTOMER, false),
		];
		const balances = new Map([['BOT', 0.07], ['HOUSE', 0.03], ['CUST', 0.35]]);
		const r = summarizeCustodialKeyHealth({ wallets, balances });
		expect(r.counts.stranded_platform).toBe(2);
		expect(r.counts.stranded_customer).toBe(1);
		expect(r.sol.stranded_platform).toBe(0.1);
		expect(r.sol.stranded_customer).toBe(0.35);
		expect(r.sol.stranded).toBe(0.45);
	});

	it('ranks the stranded list by balance and keeps every wallet identifiable', () => {
		const wallets = [wallet('SMALL', CUSTOMER, false), wallet('BIG', CUSTOMER, false)];
		const balances = new Map([['SMALL', 0.01], ['BIG', 1.2]]);
		const r = summarizeCustodialKeyHealth({ wallets, balances });
		expect(r.top_stranded.map((w) => w.address)).toEqual(['BIG', 'SMALL']);
		expect(r.top_stranded[0]).toMatchObject({ sol: 1.2, platform: false, reason: 'wrong_key' });
		expect(r.top_stranded[0].agent_id).toBe('ag-BIG');
	});

	it('reports a zero-balance sealed wallet as sealed but NOT funded', () => {
		const wallets = [wallet('EMPTY', CUSTOMER, false)];
		const r = summarizeCustodialKeyHealth({ wallets, balances: new Map([['EMPTY', 0]]) });
		expect(r.undecryptable).toBe(1);
		expect(r.counts.stranded_funded).toBe(0);
		expect(r.counts.stranded_unread).toBe(0);
		expect(r.sol.stranded).toBe(0);
	});
});

describe('ops panel verdict', () => {
	const report = (over = {}) => ({
		checked_at: '2026-09-02T00:00:00.000Z',
		wallets: 725,
		key_candidates: 1,
		undecryptable: 8,
		sol: { stranded: 0.49, stranded_platform: 0.14, stranded_customer: 0.35 },
		counts: { stranded_funded: 8, stranded_unread: 0 },
		top_stranded: [
			{ address: 'A', sol: 0.35, platform: false, reason: 'wrong_key' },
			{ address: 'B', sol: 0.14, platform: true, reason: 'wrong_key' },
		],
		...over,
	});

	it('says stranded, splits the SOL, and points at the owner decision brief', () => {
		const p = buildStrandedPanel(report());
		expect(p.status).toBe('stranded');
		expect(p.sol_stranded_customer).toBe(0.35);
		expect(p.customer_wallets_stranded).toBe(1);
		expect(p.brief).toBe('docs/ops/stranded-wallets.md');
	});

	it('refuses to call a partial read a measurement', () => {
		const p = buildStrandedPanel(report({ counts: { stranded_funded: 8, stranded_unread: 3 } }));
		expect(p.status).toBe('unknown');
		expect(p.reason).toBe('partial_read');
		expect(p.detail).toMatch(/floor, not a measurement/);
	});

	it('refuses to read a keyless process as a fleet of sealed wallets', () => {
		// secret-box fails closed in production, so a zero-candidate process is a
		// misconfigured non-prod one. Reporting its 100% failure rate as custody
		// loss would manufacture an incident out of a missing env var.
		const p = buildStrandedPanel(report({ key_candidates: 0, undecryptable: 725, counts: { stranded_funded: 700, stranded_unread: 0 } }));
		expect(p.status).toBe('unknown');
		expect(p.reason).toBe('no_decryption_key');
		// The SOL figure is withheld, not published with a caveat: an
		// unattributable total is exactly the phantom number this surface exists
		// to stop shipping.
		expect(p.sol_stranded).toBe(null);
		expect(p.top_stranded).toEqual([]);
	});

	it('calls a fleet-wide decrypt failure a wrong key, not a mass customer incident', () => {
		const p = buildStrandedPanel(report({ undecryptable: 725, counts: { stranded_funded: 168, stranded_unread: 0 } }));
		expect(p.status).toBe('unknown');
		expect(p.reason).toBe('key_mismatch');
		expect(p.sol_stranded_customer).toBe(null);
		expect(p.brief).toBe(null);
	});

	it('says clear only when nothing funded is sealed, and then names no brief', () => {
		const p = buildStrandedPanel(report({
			undecryptable: 0, counts: { stranded_funded: 0, stranded_unread: 0 },
			sol: { stranded: 0, stranded_platform: 0, stranded_customer: 0 }, top_stranded: [],
		}));
		expect(p.status).toBe('clear');
		expect(p.brief).toBe(null);
	});
});

describe('snapshot cache', () => {
	beforeEach(() => resetStrandedCustodyCache());

	it('scans once and serves the snapshot for the whole TTL', async () => {
		const gather = vi.fn(async () => ({ wallets: 3, undecryptable: 0, key_candidates: 1, counts: { stranded_funded: 0, stranded_unread: 0 }, sol: {} }));
		await strandedCustodyPanel({ gather, now: 1_000 });
		const second = await strandedCustodyPanel({ gather, now: 1_000 + 60_000 });
		expect(gather).toHaveBeenCalledTimes(1);
		expect(second.cache_age_seconds).toBe(60);
	});

	it('rescans once the snapshot ages past the TTL', async () => {
		const gather = vi.fn(async () => ({ wallets: 3, undecryptable: 0, key_candidates: 1, counts: { stranded_funded: 0, stranded_unread: 0 }, sol: {} }));
		await strandedCustodyPanel({ gather, ttlMs: 1_000, now: 0 });
		await strandedCustodyPanel({ gather, ttlMs: 1_000, now: Date.now() + 5_000 });
		expect(gather).toHaveBeenCalledTimes(2);
	});

	it('collapses concurrent reads into one fleet scan', async () => {
		let release;
		const gate = new Promise((r) => { release = r; });
		const gather = vi.fn(async () => {
			await gate;
			return { wallets: 3, undecryptable: 0, key_candidates: 1, counts: { stranded_funded: 0, stranded_unread: 0 }, sol: {} };
		});
		const both = Promise.all([strandedCustodyPanel({ gather }), strandedCustodyPanel({ gather })]);
		release();
		await both;
		expect(gather).toHaveBeenCalledTimes(1);
	});

	it('does not cache a failed scan, so a transient outage is retried not frozen', async () => {
		const gather = vi.fn()
			.mockRejectedValueOnce(new Error('rpc down'))
			.mockResolvedValueOnce({ wallets: 3, undecryptable: 0, key_candidates: 1, counts: { stranded_funded: 0, stranded_unread: 0 }, sol: {} });
		await expect(strandedCustodyPanel({ gather })).rejects.toThrow('rpc down');
		await expect(strandedCustodyPanel({ gather })).resolves.toMatchObject({ status: 'clear' });
		expect(gather).toHaveBeenCalledTimes(2);
	});
});
