/**
 * Materialize certificates: hashing, atomic edition claiming, memo shape,
 * cluster gating, and the visibility rule on the public read.
 *
 * The database boundary is a faithful in-memory double rather than a stub that
 * returns whatever the assertion wants: it enforces the two unique indexes the
 * migration declares and, in the concurrency test, deliberately interleaves two
 * writers between reading `max(edition_no)` and inserting, which is precisely
 * the race the HAVING clause plus the unique index exist to survive. A stub
 * that could not lose that race would prove nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { sql: null };
vi.mock('../api/_lib/db.js', () => ({
	get sql() {
		return db.sql;
	},
}));

const {
	sha256Hex,
	buildCertificateMemo,
	claimEdition,
	certCluster,
	mainnetAttestationAllowed,
	explorerTxUrl,
	newCertificateId,
	pickPrintAsset,
	getPublicCertificate,
	certificateUrl,
	CERT_ID_RE,
	CERT_MEMO_KIND,
} = await import('../api/_lib/print/certificate.js');

const {
	normalizeEditionLimit,
	seriesKeyFor,
	assertEditionAvailable,
	PrintEditionError,
} = await import('../api/_lib/print/editions.js');

// ── an in-memory print_certificates that behaves like the real table ─────────

class UniqueViolation extends Error {
	constructor(constraint) {
		super(`duplicate key value violates unique constraint "${constraint}"`);
		this.code = '23505';
		this.constraint = constraint;
	}
}

/**
 * @param {object[]} rows      shared table contents
 * @param {() => Promise<void>} [yieldPoint] awaited between reading max() and
 *   inserting, so a test can interleave two writers at exactly the racy moment.
 */
function makeCertificateSql(rows, yieldPoint = null) {
	return async (strings, ...values) => {
		const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();

		if (text.startsWith('insert into print_certificates')) {
			const [
				id, orderId, creationId, seriesKey, editionOf,
				glbSha256, glbBytes, printAssetKind, printAssetKey, printAssetSha256,
				materialId, materialLabel, network, whereSeries, havingA, havingB,
			] = values;
			const max = rows
				.filter((r) => r.series_key === whereSeries)
				.reduce((m, r) => Math.max(m, r.edition_no), 0);
			const next = max + 1;
			if (yieldPoint) await yieldPoint();
			if (havingA !== null && havingB !== null && next > Number(havingB)) return [];
			if (rows.some((r) => r.order_id === orderId)) {
				throw new UniqueViolation('print_certificates_order_uniq');
			}
			if (rows.some((r) => r.series_key === seriesKey && r.edition_no === next)) {
				throw new UniqueViolation('print_certificates_series_edition_uniq');
			}
			const row = {
				id, order_id: orderId, creation_id: creationId, series_key: seriesKey,
				edition_no: next, edition_of: editionOf, glb_sha256: glbSha256,
				glb_bytes: glbBytes, print_asset_kind: printAssetKind,
				print_asset_key: printAssetKey, print_asset_sha256: printAssetSha256,
				material_id: materialId, material_label: materialLabel,
				network, memo: '', solana_signature: null,
			};
			rows.push(row);
			return [row];
		}

		if (text.startsWith('select * from print_certificates where order_id')) {
			const found = rows.filter((r) => r.order_id === values[0]);
			return found.length ? [found[0]] : [];
		}

		if (text.includes('count(*)::int as n from print_certificates')) {
			return [{ n: rows.filter((r) => r.series_key === values[0]).length }];
		}

		throw new Error(`unhandled query in test double: ${text}`);
	};
}

function certRow(overrides = {}) {
	return {
		id: newCertificateId(),
		order_id: `order-${Math.random().toString(36).slice(2, 10)}`,
		creation_id: '11111111-1111-4111-8111-111111111111',
		series_key: '11111111-1111-4111-8111-111111111111',
		edition_of: null,
		glb_sha256: 'a'.repeat(64),
		glb_bytes: 1024,
		print_asset_kind: null,
		print_asset_key: null,
		print_asset_sha256: null,
		material_id: 'resin-standard',
		material_label: 'Standard resin',
		network: 'devnet',
		...overrides,
	};
}

beforeEach(() => {
	db.sql = null;
	delete process.env.PRINT_CERT_CLUSTER;
	delete process.env.PRINT_CERT_MAINNET_APPROVAL;
});

// ── hashing ─────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
	it('matches the published SHA-256 vectors byte for byte', () => {
		expect(sha256Hex(Buffer.from('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		expect(sha256Hex(Buffer.alloc(0))).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
		expect(sha256Hex(Buffer.from('three.ws'))).toBe(
			'cb73ad9077afe7f5456a1473320974ef441820fce9c05c95101290480156a67e',
		);
	});

	it('hashes bytes, not their encoding: a Uint8Array and a Buffer agree', () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
		expect(sha256Hex(bytes)).toBe(sha256Hex(Buffer.from(bytes)));
	});

	it('separates one byte of difference', () => {
		expect(sha256Hex(Buffer.from([1, 2, 3]))).not.toBe(sha256Hex(Buffer.from([1, 2, 4])));
	});
});

describe('newCertificateId', () => {
	it('produces 24 lowercase hex characters that the route regex accepts', () => {
		for (let i = 0; i < 50; i++) {
			const id = newCertificateId();
			expect(id).toMatch(CERT_ID_RE);
			expect(id).toMatch(/^[0-9a-f]{24}$/);
		}
	});

	it('does not repeat across a batch', () => {
		const ids = new Set(Array.from({ length: 500 }, () => newCertificateId()));
		expect(ids.size).toBe(500);
	});
});

// ── memo payload ────────────────────────────────────────────────────────────

describe('buildCertificateMemo', () => {
	it('carries the certificate, the hash, and the edition in a versioned envelope', () => {
		const memo = buildCertificateMemo({
			id: 'abcdef0123456789abcdef01',
			glb_sha256: 'b'.repeat(64),
			edition_no: 3,
			edition_of: 25,
			creation_id: '11111111-1111-4111-8111-111111111111',
			printed_at: '2026-09-02T12:00:00.000Z',
		});
		const parsed = JSON.parse(memo);
		expect(parsed).toEqual({
			v: 1,
			kind: CERT_MEMO_KIND,
			cert: 'abcdef0123456789abcdef01',
			sha256: 'b'.repeat(64),
			ed: 3,
			of: 25,
			ts: 1788350400,
			creation: '11111111-1111-4111-8111-111111111111',
		});
	});

	it('records an open edition as an explicit null rather than omitting it', () => {
		const parsed = JSON.parse(buildCertificateMemo({ id: 'a'.repeat(24), glb_sha256: 'c'.repeat(64), edition_no: 1, edition_of: null }));
		expect(parsed.of).toBeNull();
		expect(Object.prototype.hasOwnProperty.call(parsed, 'of')).toBe(true);
	});

	it('omits the creation key for a direct upload that has no forge row', () => {
		const parsed = JSON.parse(buildCertificateMemo({ id: 'a'.repeat(24), glb_sha256: 'c'.repeat(64), edition_no: 1, creation_id: null }));
		expect(Object.prototype.hasOwnProperty.call(parsed, 'creation')).toBe(false);
	});

	it('adds the manufacturing file hash only when both its kind and hash are known', () => {
		const withPrint = JSON.parse(
			buildCertificateMemo({
				id: 'a'.repeat(24), glb_sha256: 'c'.repeat(64), edition_no: 1,
				print_asset_kind: '3mf', print_asset_sha256: 'd'.repeat(64),
			}),
		);
		expect(withPrint.print).toBe(`3mf:${'d'.repeat(64)}`);
		const withoutKind = JSON.parse(
			buildCertificateMemo({ id: 'a'.repeat(24), glb_sha256: 'c'.repeat(64), edition_no: 1, print_asset_sha256: 'd'.repeat(64) }),
		);
		expect(withoutKind.print).toBeUndefined();
	});

	it('stays well inside the SPL Memo per-transaction ceiling', () => {
		const memo = buildCertificateMemo({
			id: 'f'.repeat(24), glb_sha256: 'e'.repeat(64), edition_no: 9999, edition_of: 10000,
			creation_id: '11111111-1111-4111-8111-111111111111',
			print_asset_kind: '3mf', print_asset_sha256: 'd'.repeat(64),
		});
		expect(Buffer.byteLength(memo, 'utf8')).toBeLessThan(566);
	});
});

// ── cluster and the mainnet gate ────────────────────────────────────────────

describe('certCluster', () => {
	it('defaults to devnet when nothing is configured', () => {
		expect(certCluster()).toBe('devnet');
	});

	it('stays on devnet for anything that is not exactly mainnet', () => {
		for (const value of ['', 'testnet', 'main', 'MAINNET-BETA', 'true', 'yes']) {
			process.env.PRINT_CERT_CLUSTER = value;
			expect(certCluster()).toBe('devnet');
		}
	});

	it('selects mainnet only on the explicit flag, case and padding tolerant', () => {
		process.env.PRINT_CERT_CLUSTER = ' MainNet ';
		expect(certCluster()).toBe('mainnet');
	});
});

describe('mainnetAttestationAllowed', () => {
	it('refuses without a recorded owner approval', () => {
		const gate = mainnetAttestationAllowed();
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('PRINT_CERT_MAINNET_APPROVAL');
	});

	it('allows once the approval is recorded', () => {
		process.env.PRINT_CERT_MAINNET_APPROVAL = 'owner-approved-2026-09-02';
		expect(mainnetAttestationAllowed().allowed).toBe(true);
	});

	it('treats whitespace as no approval at all', () => {
		process.env.PRINT_CERT_MAINNET_APPROVAL = '   ';
		expect(mainnetAttestationAllowed().allowed).toBe(false);
	});
});

describe('explorerTxUrl', () => {
	it('marks devnet signatures with the cluster query and leaves mainnet bare', () => {
		expect(explorerTxUrl('sig123', 'devnet')).toBe('https://explorer.solana.com/tx/sig123?cluster=devnet');
		expect(explorerTxUrl('sig123', 'mainnet')).toBe('https://explorer.solana.com/tx/sig123');
	});
});

describe('certificateUrl', () => {
	it('builds the address the QR encodes', () => {
		expect(certificateUrl('abcdef0123456789abcdef01')).toMatch(/\/cert\/abcdef0123456789abcdef01$/);
	});
});

describe('pickPrintAsset', () => {
	it('prefers the richest manufacturing format the prepare step produced', () => {
		expect(pickPrintAsset({ glb: 'g', stl: 's', '3mf': 'm' })).toEqual({ kind: '3mf', url: 'm' });
		expect(pickPrintAsset({ glb: 'g', stl: 's' })).toEqual({ kind: 'stl', url: 's' });
		expect(pickPrintAsset({ glb: 'g' })).toEqual({ kind: 'glb', url: 'g' });
		expect(pickPrintAsset({})).toBeNull();
		expect(pickPrintAsset(null)).toBeNull();
	});
});

// ── edition claiming ────────────────────────────────────────────────────────

describe('claimEdition', () => {
	it('numbers a series from one and keeps counting', async () => {
		const rows = [];
		db.sql = makeCertificateSql(rows);
		const first = await claimEdition(certRow());
		const second = await claimEdition(certRow());
		expect([first.edition_no, second.edition_no]).toEqual([1, 2]);
	});

	it('numbers separate series independently', async () => {
		const rows = [];
		db.sql = makeCertificateSql(rows);
		await claimEdition(certRow({ series_key: 'model-a' }));
		const other = await claimEdition(certRow({ series_key: 'model-b' }));
		expect(other.edition_no).toBe(1);
	});

	it('returns the existing certificate when an order is claimed twice', async () => {
		const rows = [];
		db.sql = makeCertificateSql(rows);
		const row = certRow();
		const first = await claimEdition(row);
		const again = await claimEdition({ ...certRow(), order_id: row.order_id });
		expect(again.id).toBe(first.id);
		expect(rows).toHaveLength(1);
	});

	it('issues no duplicate edition number when two shipments race', async () => {
		const rows = [];
		// Both writers read max(edition_no) before either inserts: the exact
		// interleaving the unique index has to survive.
		let waiting = null;
		const yieldPoint = () =>
			new Promise((resolve) => {
				if (waiting) {
					const other = waiting;
					waiting = null;
					other();
					resolve();
				} else {
					waiting = resolve;
					setTimeout(() => {
						if (waiting === resolve) {
							waiting = null;
							resolve();
						}
					}, 5);
				}
			});
		db.sql = makeCertificateSql(rows, yieldPoint);

		const [a, b] = await Promise.all([claimEdition(certRow()), claimEdition(certRow())]);
		expect(new Set([a.edition_no, b.edition_no]).size).toBe(2);
		expect([a.edition_no, b.edition_no].sort()).toEqual([1, 2]);
		expect(rows).toHaveLength(2);
	});

	it('survives a wider stampede without repeating a number', async () => {
		const rows = [];
		db.sql = makeCertificateSql(rows, () => new Promise((r) => setTimeout(r, 1)));
		const claims = await Promise.all(Array.from({ length: 8 }, () => claimEdition(certRow())));
		const numbers = claims.map((c) => c.edition_no).sort((x, y) => x - y);
		expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('refuses to over-number a capped edition', async () => {
		const rows = [];
		db.sql = makeCertificateSql(rows);
		await claimEdition(certRow({ edition_of: 2 }));
		await claimEdition(certRow({ edition_of: 2 }));
		await expect(claimEdition(certRow({ edition_of: 2 }))).rejects.toMatchObject({
			code: 'edition_sold_out',
		});
		expect(rows).toHaveLength(2);
	});

	it('lets a capped edition fill exactly to its last copy under a race', async () => {
		const rows = [];
		db.sql = makeCertificateSql(rows, () => new Promise((r) => setTimeout(r, 1)));
		const settled = await Promise.allSettled([
			claimEdition(certRow({ edition_of: 1 })),
			claimEdition(certRow({ edition_of: 1 })),
		]);
		expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
		expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
		expect(rows).toHaveLength(1);
	});
});

// ── editions module ─────────────────────────────────────────────────────────

describe('normalizeEditionLimit', () => {
	it('reads an absent cap as an open edition', () => {
		for (const value of [null, undefined, '']) expect(normalizeEditionLimit(value)).toBeNull();
	});

	it('accepts a whole number inside the band', () => {
		expect(normalizeEditionLimit(25)).toBe(25);
		expect(normalizeEditionLimit(' 7 ')).toBe(7);
		expect(normalizeEditionLimit(10000)).toBe(10000);
	});

	it('refuses fractions, zero, negatives, and anything past the ceiling', () => {
		for (const bad of [2.5, 0, -1, 10001, 'many']) {
			expect(() => normalizeEditionLimit(bad)).toThrow(PrintEditionError);
		}
	});
});

describe('seriesKeyFor', () => {
	it('keys a forge print by its creation', () => {
		expect(seriesKeyFor({ creationId: 'abc' })).toBe('abc');
	});

	it('keys a direct upload by its content hash so identical bytes share one series', () => {
		expect(seriesKeyFor({ glbSha256: 'a'.repeat(64) })).toBe(`sha256:${'a'.repeat(64)}`);
	});

	it('refuses to invent a series from nothing', () => {
		expect(() => seriesKeyFor({})).toThrow(PrintEditionError);
		expect(() => seriesKeyFor({ glbSha256: 'not-a-hash' })).toThrow(PrintEditionError);
	});
});

describe('assertEditionAvailable', () => {
	function editionSql({ limit, issued }) {
		return async (strings, ...values) => {
			const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
			if (text.includes('print_edition_limit from forge_creations')) return [{ print_edition_limit: limit }];
			if (text.includes('count(*)::int as n from print_certificates')) return [{ n: issued }];
			throw new Error(`unhandled query: ${text}`);
		};
	}

	it('lets an open edition through at any quantity', async () => {
		db.sql = editionSql({ limit: null, issued: 900 });
		const state = await assertEditionAvailable({ creationId: 'c1', quantity: 50 });
		expect(state.limit).toBeNull();
		expect(state.soldOut).toBe(false);
	});

	it('lets a partly-filled edition through', async () => {
		db.sql = editionSql({ limit: 25, issued: 3 });
		const state = await assertEditionAvailable({ creationId: 'c1', quantity: 2 });
		expect(state.remaining).toBe(22);
	});

	it('refuses a quote once the last copy has shipped', async () => {
		db.sql = editionSql({ limit: 5, issued: 5 });
		await expect(assertEditionAvailable({ creationId: 'c1' })).rejects.toMatchObject({
			code: 'edition_sold_out',
		});
	});

	it('refuses a quantity larger than what is left, and says how many remain', async () => {
		db.sql = editionSql({ limit: 5, issued: 4 });
		await expect(assertEditionAvailable({ creationId: 'c1', quantity: 3 })).rejects.toThrow(/Only 1 of this 5-piece edition is left/);
	});

	it('reports a sold-out series in language a buyer can act on', async () => {
		db.sql = editionSql({ limit: 5, issued: 5 });
		await expect(assertEditionAvailable({ creationId: 'c1' })).rejects.toThrow(/sold out. All 5 copies have shipped/);
	});
});

// ── the public read and its visibility rule ─────────────────────────────────

describe('getPublicCertificate', () => {
	function readSql(row) {
		return async (strings, ...values) => {
			const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
			if (text.includes('from print_certificates c join print_orders o')) return row ? [row] : [];
			if (text.includes('count(*)::int as n from print_certificates')) return [{ n: 4 }];
			throw new Error(`unhandled query: ${text}`);
		};
	}

	const base = {
		id: 'abcdef0123456789abcdef01',
		order_id: 'order-1',
		creation_id: '11111111-1111-4111-8111-111111111111',
		series_key: '11111111-1111-4111-8111-111111111111',
		edition_no: 3,
		edition_of: 25,
		glb_sha256: 'a'.repeat(64),
		glb_bytes: 4096,
		print_asset_kind: '3mf',
		print_asset_sha256: 'b'.repeat(64),
		material_id: 'resin-standard',
		material_label: 'Standard resin',
		printed_at: '2026-09-02T00:00:00.000Z',
		network: 'devnet',
		memo: '{"v":1}',
		solana_signature: 'sig-1',
		attested_at: '2026-09-02T00:01:00.000Z',
		qr_url: 'https://cdn.example.com/print/certs/x/qr.png',
		creation_prompt: 'a brass orrery',
		creation_visibility: null,
		creation_glb_url: 'https://cdn.example.com/model.glb',
		creation_preview_url: 'https://cdn.example.com/model.png',
		creation_parent_id: '22222222-2222-4222-8222-222222222222',
		creation_refine_instruction: 'more brass',
		creator_username: 'ada',
		creator_display_name: 'Ada',
	};

	it('rejects a malformed id without touching the database', async () => {
		db.sql = () => {
			throw new Error('should not query');
		};
		expect(await getPublicCertificate('nope')).toBeNull();
		expect(await getPublicCertificate('')).toBeNull();
		expect(await getPublicCertificate('ABCDEF0123456789ABCDEF01')).toBeNull();
	});

	it('returns null for an unknown certificate', async () => {
		db.sql = readSql(null);
		expect(await getPublicCertificate('abcdef0123456789abcdef01')).toBeNull();
	});

	it('renders a public model in full, prompt included', async () => {
		db.sql = readSql(base);
		const cert = await getPublicCertificate(base.id);
		expect(cert.creation.prompt).toBe('a brass orrery');
		expect(cert.creation.prompt_withheld).toBe(false);
		expect(cert.creation.model_url).toBe('/m/11111111-1111-4111-8111-111111111111');
		expect(cert.creation.creator_username).toBe('ada');
		expect(cert.edition_no).toBe(3);
		expect(cert.edition_of).toBe(25);
		expect(cert.explorer_url).toContain('cluster=devnet');
	});

	it('withholds a private model prompt while still issuing the certificate', async () => {
		db.sql = readSql({ ...base, creation_visibility: 'private' });
		const cert = await getPublicCertificate(base.id);
		expect(cert.creation.prompt).toBeNull();
		expect(cert.creation.prompt_withheld).toBe(true);
		expect(cert.creation.refine_instruction).toBeNull();
		expect(cert.creation.parent_creation_id).toBeNull();
		expect(cert.creation.creator_username).toBeNull();
		expect(cert.creation.model_url).toBeNull();
		// The proof itself is never withheld: the holder of the object owns it.
		expect(cert.glb_sha256).toBe('a'.repeat(64));
		expect(cert.memo).toBe('{"v":1}');
		expect(cert.solana_signature).toBe('sig-1');
		expect(cert.edition_no).toBe(3);
	});

	it('treats an unlisted model as public for its own certificate', async () => {
		db.sql = readSql({ ...base, creation_visibility: 'unlisted' });
		const cert = await getPublicCertificate(base.id);
		expect(cert.creation.prompt).toBe('a brass orrery');
		expect(cert.creation.prompt_withheld).toBe(false);
	});

	it('carries no order id, buyer, or shipping detail', async () => {
		db.sql = readSql(base);
		const cert = await getPublicCertificate(base.id);
		const serialized = JSON.stringify(cert);
		expect(serialized).not.toContain('order-1');
		expect(cert.order_id).toBeUndefined();
		expect(cert.shipping).toBeUndefined();
	});

	it('reports an unattested certificate honestly instead of inventing a link', async () => {
		db.sql = readSql({ ...base, solana_signature: null, attested_at: null });
		const cert = await getPublicCertificate(base.id);
		expect(cert.solana_signature).toBeNull();
		expect(cert.explorer_url).toBeNull();
		expect(cert.memo).toBe('{"v":1}');
	});
});
