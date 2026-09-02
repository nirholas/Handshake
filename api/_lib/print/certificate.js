// @ts-check
// Materialize certificates: the on-chain proof a physical print carries.
//
// When an order ships, three things are frozen together and never move again:
//
//   1. the SHA-256 of the exact bytes that were printed (and of the prepared
//      GLB the certificate page renders),
//   2. the edition number claimed out of that model's series, claimed
//      atomically so two simultaneous shipments cannot both be "number 7",
//   3. a Solana memo transaction carrying both, signed by the platform.
//
// The QR on the package resolves to /cert/<id>, which renders the original
// model, the lineage, the edition, and the RAW memo payload. That last part is
// the point: a buyer verifies a print by hashing the file and comparing it to
// the string in the transaction, with no dependency on this database, this
// company, or any block explorer staying online.
//
// Cluster policy. Devnet is the default and needs no approval: it proves the
// pipeline end to end. Mainnet is gated twice on purpose (CLAUDE.md gate 1
// covers irreversible on-chain actions): PRINT_CERT_CLUSTER must say mainnet
// AND PRINT_CERT_MAINNET_APPROVAL must carry the owner's recorded approval. A
// missing approval does not silently downgrade to devnet, because a devnet
// signature printed on a mainnet certificate would be a lie; it leaves the
// certificate unattested, records why, and lets the sweep retry once the
// approval lands.
//
// Failure policy. Issuance never blocks a shipment. The row is written first;
// the QR and the memo are best-effort and retried by the print reconciliation
// sweep (api/cron/print-orders-sync.js). A certificate with a null signature is
// a real certificate whose proof is still in flight, and the page says so.

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import QRCode from 'qrcode';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import { sql } from '../db.js';
import { getObjectBuffer, keyFromPublicUrl, putObject, publicUrl, objectStorageConfigured } from '../r2.js';
import { solanaConnection } from '../solana/connection.js';
import { sendAndConfirm } from '../solana/confirm.js';
import { decodeAttesterSecret } from '../attest-event.js';
import { RPC } from '../solana-attestations.js';
import { seriesKeyFor, editionLimitFor, PrintEditionError } from './editions.js';

/** SPL Memo v2. Same program the agent attestations use. */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TX_TIMEOUT_MS = 20_000;
/** The memo schema version. Bumping it is a wire-format change, not a tweak. */
export const CERT_MEMO_KIND = 'threews.print.v1';
/** Bounded so a claim race cannot spin: 12 shipments of one model at once. */
const EDITION_CLAIM_ATTEMPTS = 12;

export const CERT_ID_RE = /^[0-9a-f]{24}$/;

/** Typed failure so handlers map a cause to a status code, never a bare 500. */
export class PrintCertificateError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [extra]
	 */
	constructor(code, message, extra = {}) {
		super(message);
		this.name = 'PrintCertificateError';
		this.code = code;
		Object.assign(this, extra);
	}
}

/** 24 lowercase hex characters: short enough to print, wide enough to be unguessable. */
export function newCertificateId() {
	return crypto.randomBytes(12).toString('hex');
}

/** @param {Buffer|Uint8Array} bytes */
export function sha256Hex(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function siteOrigin() {
	return (process.env.PUBLIC_BASE_URL || 'https://three.ws').replace(/\/$/, '');
}

/** @param {string} certId */
export function certificateUrl(certId) {
	return `${siteOrigin()}/cert/${certId}`;
}

/**
 * Which cluster certificates attest on. Devnet unless the deployment says
 * otherwise; anything unrecognised is devnet, never a silent mainnet spend.
 * @returns {'mainnet'|'devnet'}
 */
export function certCluster() {
	return String(process.env.PRINT_CERT_CLUSTER || '').trim().toLowerCase() === 'mainnet'
		? 'mainnet'
		: 'devnet';
}

/**
 * The owner gate on real-money attestation. Mainnet sends are irreversible
 * on-chain actions, so they require an explicit recorded approval on top of
 * the cluster flag.
 * @returns {{ allowed: boolean, reason: string }}
 */
export function mainnetAttestationAllowed() {
	const approval = String(process.env.PRINT_CERT_MAINNET_APPROVAL || '').trim();
	if (!approval) {
		return {
			allowed: false,
			reason:
				'mainnet attestation is owner-gated: set PRINT_CERT_MAINNET_APPROVAL to the recorded approval before certificates attest on mainnet',
		};
	}
	return { allowed: true, reason: '' };
}

/** The keypair that signs certificate memos. */
export function loadCertAttester() {
	const raw = process.env.PRINT_CERT_ATTESTER_SECRET || process.env.ATTEST_AGENT_SECRET_KEY;
	if (!raw) {
		throw new PrintCertificateError(
			'attester_unconfigured',
			'no certificate attester key: set PRINT_CERT_ATTESTER_SECRET (or ATTEST_AGENT_SECRET_KEY)',
		);
	}
	const bytes = decodeAttesterSecret(raw);
	if (!bytes) {
		throw new PrintCertificateError(
			'attester_key_undecodable',
			'the certificate attester key is set but is not a decodable ed25519 secret key',
		);
	}
	return Keypair.fromSecretKey(bytes);
}

/**
 * The exact JSON a certificate's memo transaction carries. Compact on purpose:
 * SPL Memo is capped per transaction, and every byte here is printed on the
 * certificate page for a human to compare against the chain.
 *
 * @param {{ id: string, glb_sha256: string, print_asset_sha256?: string|null, print_asset_kind?: string|null,
 *           edition_no: number, edition_of?: number|null, creation_id?: string|null, printed_at?: Date|string|null }} cert
 * @returns {string}
 */
export function buildCertificateMemo(cert) {
	/** @type {Record<string, unknown>} */
	const payload = {
		v: 1,
		kind: CERT_MEMO_KIND,
		cert: cert.id,
		sha256: cert.glb_sha256,
		ed: cert.edition_no,
		of: cert.edition_of ?? null,
		ts: Math.floor(new Date(cert.printed_at || Date.now()).getTime() / 1000),
	};
	if (cert.creation_id) payload.creation = cert.creation_id;
	if (cert.print_asset_sha256 && cert.print_asset_kind) {
		payload.print = `${cert.print_asset_kind}:${cert.print_asset_sha256}`;
	}
	return JSON.stringify(payload);
}

/**
 * Pick the manufacturing asset an order was actually printed from. STL and 3MF
 * are what a bureau loads; the GLB is the viewable original and is hashed
 * separately. Returns null when the order carries neither.
 * @param {Record<string, string>} assets
 */
export function pickPrintAsset(assets) {
	for (const kind of ['3mf', 'stl', 'glb']) {
		const url = assets?.[kind];
		if (typeof url === 'string' && url) return { kind, url };
	}
	return null;
}

/**
 * Read an asset by its public URL and return its bytes plus the storage key.
 * @param {string} url
 */
async function readAsset(url) {
	const key = keyFromPublicUrl(url);
	if (!key) {
		throw new PrintCertificateError(
			'asset_not_in_bucket',
			`prepared asset ${url} does not live in this deployment's object storage, so its bytes cannot be hashed`,
		);
	}
	const bytes = await getObjectBuffer(key);
	return { key, bytes };
}

/**
 * Claim the next edition number for a series and insert the certificate in one
 * statement, retrying the collision a concurrent claim produces.
 *
 * Two things make this atomic without a transaction, which matters because the
 * serverless driver has none: the unique index on (series_key, edition_no)
 * means only one of two simultaneous "max + 1" writers can win, and the HAVING
 * clause means a full series selects zero rows rather than writing an
 * over-numbered certificate. The loser recomputes and takes the next number, or
 * is told the edition is sold out. Exported because it is the primitive the
 * concurrency test exercises directly.
 *
 * @param {object} row
 * @returns {Promise<any>} the inserted certificate, or the one that already
 *   existed for this order.
 */
export async function claimEdition(row) {
	for (let attempt = 1; attempt <= EDITION_CLAIM_ATTEMPTS; attempt++) {
		try {
			const inserted = await sql`
				insert into print_certificates (
					id, order_id, creation_id, series_key, edition_no, edition_of,
					glb_sha256, glb_bytes, print_asset_kind, print_asset_key, print_asset_sha256,
					material_id, material_label, network, memo
				)
				select
					${row.id}, ${row.order_id}, ${row.creation_id}, ${row.series_key},
					coalesce(max(edition_no), 0) + 1, ${row.edition_of},
					${row.glb_sha256}, ${row.glb_bytes}, ${row.print_asset_kind},
					${row.print_asset_key}, ${row.print_asset_sha256},
					${row.material_id}, ${row.material_label}, ${row.network}, ''
				from print_certificates
				where series_key = ${row.series_key}
				having ${row.edition_of}::int is null
					or coalesce(max(edition_no), 0) + 1 <= ${row.edition_of}::int
				returning *
			`;
			if (inserted.length === 0) {
				throw new PrintEditionError(
					'edition_sold_out',
					`this edition is capped at ${row.edition_of} and every copy has already been certified`,
					{ limit: row.edition_of },
				);
			}
			return inserted[0];
		} catch (err) {
			if (err?.code !== '23505') throw err;
			// A unique violation is one of two things, and the row tells us which:
			// this order was already certified (the idempotent answer), or a
			// concurrent claim took the number we computed (recompute and retry).
			const [existing] = await sql`select * from print_certificates where order_id = ${row.order_id} limit 1`;
			if (existing) return existing;
			if (attempt >= EDITION_CLAIM_ATTEMPTS) throw err;
		}
	}
	throw new PrintCertificateError(
		'edition_claim_contended',
		'could not claim an edition number after repeated concurrent collisions',
	);
}

/**
 * Render the certificate's QR as a PNG and store it beside the prepared assets.
 * Best-effort: a certificate without its QR is still a valid certificate, and
 * the sweep regenerates it.
 * @param {{ id: string }} cert
 * @returns {Promise<{ qr_key: string, qr_url: string }|null>}
 */
export async function generateCertificateQr(cert) {
	if (!objectStorageConfigured()) return null;
	const png = await QRCode.toBuffer(certificateUrl(cert.id), {
		type: 'png',
		errorCorrectionLevel: 'Q',
		margin: 2,
		width: 720,
		color: { dark: '#000000ff', light: '#ffffffff' },
	});
	const key = `print/certs/${cert.id}/qr.png`;
	await putObject({ key, body: png, contentType: 'image/png' });
	const url = publicUrl(key);
	await sql`update print_certificates set qr_key = ${key}, qr_url = ${url} where id = ${cert.id}`;
	return { qr_key: key, qr_url: url };
}

/**
 * Send the certificate's memo transaction and record its signature.
 *
 * @param {any} cert a print_certificates row
 * @returns {Promise<{ status: 'attested'|'already'|'refused', signature: string|null, reason?: string }>}
 */
export async function attestCertificate(cert) {
	if (cert.solana_signature) {
		return { status: 'already', signature: cert.solana_signature };
	}
	const network = cert.network === 'mainnet' ? 'mainnet' : 'devnet';
	if (network === 'mainnet') {
		const gate = mainnetAttestationAllowed();
		if (!gate.allowed) {
			await sql`
				update print_certificates
				set attest_error = ${gate.reason}, attest_attempts = attest_attempts + 1
				where id = ${cert.id}
			`;
			return { status: 'refused', signature: null, reason: gate.reason };
		}
	}

	const memo = cert.memo && cert.memo !== '' ? cert.memo : buildCertificateMemo(cert);
	const attester = loadCertAttester();
	const conn = solanaConnection({ url: RPC[network], commitment: 'confirmed' });
	const ix = new TransactionInstruction({
		programId: MEMO_PROGRAM_ID,
		keys: [{ pubkey: attester.publicKey, isSigner: true, isWritable: true }],
		data: Buffer.from(memo, 'utf8'),
	});

	let signature;
	try {
		signature = await withTimeout(
			sendAndConfirm(conn, new Transaction().add(ix), [attester], { commitment: 'confirmed' }),
			TX_TIMEOUT_MS,
		);
	} catch (err) {
		await sql`
			update print_certificates
			set attest_error = ${String(err?.message || err).slice(0, 500)},
			    attest_attempts = attest_attempts + 1
			where id = ${cert.id}
		`;
		throw err;
	}

	await sql`
		update print_certificates
		set solana_signature = ${signature}, attested_at = now(), attest_error = null,
		    memo = ${memo}, attest_attempts = attest_attempts + 1
		where id = ${cert.id}
	`;
	return { status: 'attested', signature };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(Object.assign(new Error(`solana rpc timeout after ${ms}ms`), { code: 'RPC_TIMEOUT' })),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Issue the certificate for a shipped order. Idempotent: a second call returns
 * the certificate the first one wrote.
 *
 * @param {{ orderId: string, attest?: boolean, qr?: boolean }} input
 * @returns {Promise<{ certificate: any, created: boolean, attestation: { status: string, signature: string|null, reason?: string }|null }>}
 */
export async function issueCertificateForOrder({ orderId, attest = true, qr = true }) {
	const [existing] = await sql`select * from print_certificates where order_id = ${orderId} limit 1`;
	if (existing) {
		return { certificate: existing, created: false, attestation: null };
	}

	const [order] = await sql`
		select id, creation_id, source_glb_url, prepared_asset_urls, material_id, quote, user_id
		from print_orders where id = ${orderId} limit 1
	`;
	if (!order) throw new PrintCertificateError('order_not_found', `no print order ${orderId}`);

	const assets = order.prepared_asset_urls || {};
	const glbUrl = assets.glb || order.source_glb_url;
	if (!glbUrl) {
		throw new PrintCertificateError(
			'order_has_no_asset',
			'this order carries neither a prepared GLB nor a source GLB, so there are no bytes to certify',
		);
	}

	const glb = await readAsset(glbUrl);
	const glbSha256 = sha256Hex(glb.bytes);

	// The manufacturing file, when the prepare step produced one distinct from
	// the GLB. Hashing it is what makes "these exact bytes were printed"
	// checkable, rather than only "this model was printed".
	let printAsset = null;
	const picked = pickPrintAsset(assets);
	if (picked && picked.url !== glbUrl) {
		const read = await readAsset(picked.url);
		printAsset = { kind: picked.kind, key: read.key, sha256: sha256Hex(read.bytes) };
	}

	const seriesKey = seriesKeyFor({ creationId: order.creation_id, glbSha256 });
	const editionOf = await editionLimitFor(order.creation_id);
	const materialLabel = order.quote?.material?.label || order.quote?.material_label || null;

	const claimed = await claimEdition({
		id: newCertificateId(),
		order_id: order.id,
		creation_id: order.creation_id ?? null,
		series_key: seriesKey,
		edition_of: editionOf,
		glb_sha256: glbSha256,
		glb_bytes: glb.bytes.length,
		print_asset_kind: printAsset?.kind ?? null,
		print_asset_key: printAsset?.key ?? null,
		print_asset_sha256: printAsset?.sha256 ?? null,
		material_id: order.material_id ?? null,
		material_label: materialLabel,
		network: certCluster(),
	});

	// A claim that resolved to an existing row (the order unique index won a
	// race) is already complete; do not re-run its side effects.
	if (claimed.memo) {
		return { certificate: claimed, created: false, attestation: null };
	}

	const memo = buildCertificateMemo(claimed);
	await sql`update print_certificates set memo = ${memo} where id = ${claimed.id}`;
	let certificate = { ...claimed, memo };

	if (qr) {
		try {
			const stored = await generateCertificateQr(certificate);
			if (stored) certificate = { ...certificate, ...stored };
		} catch (err) {
			console.error('[print-certificate] qr generation failed:', err?.message);
		}
	}

	let attestation = null;
	if (attest) {
		try {
			attestation = await attestCertificate(certificate);
			if (attestation.signature) {
				certificate = { ...certificate, solana_signature: attestation.signature, attested_at: new Date() };
			}
		} catch (err) {
			console.error('[print-certificate] attestation failed:', err?.message);
			attestation = { status: 'failed', signature: null, reason: String(err?.message || err) };
		}
	}

	return { certificate, created: true, attestation };
}

/**
 * The retry path the print reconciliation sweep runs: certificates whose memo
 * never landed, oldest first, with their QR backfilled on the way past.
 *
 * @param {{ limit?: number, maxAttempts?: number }} [opts]
 */
export async function retryPendingAttestations({ limit = 10, maxAttempts = 8 } = {}) {
	const pending = await sql`
		select * from print_certificates
		where solana_signature is null and attest_attempts < ${maxAttempts}
		order by created_at asc
		limit ${limit}
	`;
	const result = { scanned: pending.length, attested: 0, refused: 0, failed: 0, qrBackfilled: 0 };
	for (const cert of pending) {
		if (!cert.qr_url) {
			try {
				if (await generateCertificateQr(cert)) result.qrBackfilled += 1;
			} catch (err) {
				console.error('[print-certificate] qr backfill failed:', err?.message);
			}
		}
		try {
			const out = await attestCertificate(cert);
			if (out.status === 'attested') result.attested += 1;
			else if (out.status === 'refused') result.refused += 1;
		} catch {
			result.failed += 1;
		}
	}
	return result;
}

/**
 * Public read shape. `prompt` is withheld for a private creation: the
 * certificate always renders (the buyer holds the object and the proof), but a
 * private model's lineage stays private.
 *
 * @param {string} certId
 * @returns {Promise<object|null>}
 */
export async function getPublicCertificate(certId) {
	if (!CERT_ID_RE.test(String(certId || ''))) return null;
	const [row] = await sql`
		select c.*,
			o.material_id as order_material_id,
			o.quantity as order_quantity,
			fc.prompt as creation_prompt,
			fc.visibility as creation_visibility,
			fc.glb_url as creation_glb_url,
			fc.preview_image_url as creation_preview_url,
			fc.model_category as creation_category,
			fc.parent_creation_id as creation_parent_id,
			fc.refine_instruction as creation_refine_instruction,
			fc.created_at as creation_created_at,
			fc.print_edition_limit as creation_edition_limit,
			u.username as creator_username,
			u.display_name as creator_display_name
		from print_certificates c
		join print_orders o on o.id = c.order_id
		left join forge_creations fc on fc.id = c.creation_id
		left join users u on u.id = fc.user_id and u.deleted_at is null
		where c.id = ${certId}
		limit 1
	`;
	if (!row) return null;

	const isPrivate = row.creation_visibility === 'private';
	const [issued] = await sql`
		select count(*)::int as n from print_certificates where series_key = ${row.series_key}
	`;

	return {
		id: row.id,
		edition_no: row.edition_no,
		edition_of: row.edition_of ?? null,
		edition_issued: issued?.n ?? row.edition_no,
		printed_at: row.printed_at,
		material_id: row.material_id ?? row.order_material_id ?? null,
		material_label: row.material_label ?? null,
		glb_sha256: row.glb_sha256,
		glb_bytes: row.glb_bytes ?? null,
		print_asset_kind: row.print_asset_kind ?? null,
		print_asset_sha256: row.print_asset_sha256 ?? null,
		network: row.network,
		memo: row.memo,
		solana_signature: row.solana_signature ?? null,
		attested_at: row.attested_at ?? null,
		explorer_url: row.solana_signature ? explorerTxUrl(row.solana_signature, row.network) : null,
		qr_url: row.qr_url ?? null,
		certificate_url: certificateUrl(row.id),
		creation: row.creation_id
			? {
					id: row.creation_id,
					// A private model still shows its object: the holder of the print
					// owns that. Its prompt is the creator's, and stays theirs.
					prompt: isPrivate ? null : (row.creation_prompt ?? null),
					prompt_withheld: isPrivate,
					glb_url: row.creation_glb_url ?? null,
					preview_image_url: row.creation_preview_url ?? null,
					category: row.creation_category ?? null,
					parent_creation_id: isPrivate ? null : (row.creation_parent_id ?? null),
					refine_instruction: isPrivate ? null : (row.creation_refine_instruction ?? null),
					created_at: row.creation_created_at ?? null,
					visibility: row.creation_visibility ?? null,
					model_url: isPrivate ? null : `/m/${row.creation_id}`,
					creator_username: isPrivate ? null : (row.creator_username ?? null),
					creator_display_name: isPrivate ? null : (row.creator_display_name ?? null),
				}
			: null,
	};
}

/**
 * A public explorer link for a signature. The certificate page renders the raw
 * memo beside it, so the page keeps working when the explorer does not.
 * @param {string} signature
 * @param {string} network
 */
export function explorerTxUrl(signature, network) {
	const cluster = network === 'mainnet' ? '' : '?cluster=devnet';
	return `https://explorer.solana.com/tx/${signature}${cluster}`;
}
