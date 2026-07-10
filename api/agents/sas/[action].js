// Consolidated SAS credential endpoints (credentials + issue-credential).

import { sql } from '../../_lib/db.js';
import { cors, json, method, readJson, wrap, error, rateLimited, serverError } from '../../_lib/http.js';
import { parse } from '../../_lib/validate.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { requireAdmin } from '../../_lib/admin.js';
import { sasIssue, SAS_CONFIG } from '../../_lib/sas.js';
import { z } from 'zod';

// ── credentials (GET) ─────────────────────────────────────────────────────────

async function handleCredentials(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const subject = url.searchParams.get('subject');
	const network = url.searchParams.get('network') === 'mainnet' ? 'mainnet' : 'devnet';
	const kind = url.searchParams.get('kind') || null;
	const includeClosed = url.searchParams.get('include_closed') === '1';

	if (!subject) return error(res, 400, 'validation_error', 'subject required');

	const rows = kind
		? await sql`select attestation_pda, schema_pda, credential_pda, kind, subject, issuer_signature, data, expiry, closed, issued_at from solana_credentials where subject = ${subject} and network = ${network} and kind = ${kind} and (${includeClosed} or closed = false) and (expiry is null or expiry > now()) order by issued_at desc`
		: await sql`select attestation_pda, schema_pda, credential_pda, kind, subject, issuer_signature, data, expiry, closed, issued_at from solana_credentials where subject = ${subject} and network = ${network} and (${includeClosed} or closed = false) and (expiry is null or expiry > now()) order by issued_at desc`;

	return json(res, 200, { subject, network, kind, count: rows.length, data: rows });
}

// ── issue-credential (POST, admin-only) ───────────────────────────────────────

const SCHEMAS = Object.keys(SAS_CONFIG.schemas);

const issueSchema = z.object({
	kind:    z.enum(SCHEMAS),
	subject: z.string().min(32).max(44),
	data:    z.record(z.any()).default({}),
	expiry:  z.number().int().nonnegative().default(0),
	network: z.enum(['devnet', 'mainnet']).default('devnet'),
});

async function handleIssueCredential(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const admin = await requireAdmin(req, res);
	if (!admin) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(issueSchema, await readJson(req));
	const def = SAS_CONFIG.schemas[body.kind];
	for (let i = 0; i < def.fieldNames.length; i++) {
		const fname = def.fieldNames[i];
		const v = body.data[fname];
		if (v === undefined) return error(res, 400, 'validation_error', `missing field: ${fname}`);
		const t = def.layout[i];
		if (t === 12 && typeof v !== 'string') return error(res, 400, 'validation_error', `${fname} must be string`);
		if (t === 10 && typeof v !== 'boolean') return error(res, 400, 'validation_error', `${fname} must be bool`);
		if (t === 0 && (!Number.isInteger(v) || v < 0 || v > 255)) return error(res, 400, 'validation_error', `${fname} must be u8`);
	}

	let result;
	try { result = await sasIssue({ kind: body.kind, subject: body.subject, data: body.data, expiry: body.expiry, network: body.network }); }
	catch (e) { console.error('[agents/sas] issue failed', e?.message || e); return serverError(res, 500, 'sas_issue_failed', e); }

	const expiryDate = body.expiry > 0 ? new Date(body.expiry * 1000) : null;
	await sql`insert into solana_credentials (attestation_pda, network, schema_pda, credential_pda, kind, subject, issuer_signature, data, expiry) values (${result.attestation_pda}, ${body.network}, ${result.schema_pda}, ${result.credential_pda}, ${body.kind}, ${body.subject}, ${result.signature}, ${JSON.stringify(body.data)}::jsonb, ${expiryDate}) on conflict (attestation_pda) do update set data=excluded.data, expiry=excluded.expiry, issuer_signature=excluded.issuer_signature, closed=false, closed_at=null`;

	return json(res, 201, { signature: result.signature, attestation_pda: result.attestation_pda, schema_pda: result.schema_pda, credential_pda: result.credential_pda, kind: body.kind, subject: body.subject });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = { credentials: handleCredentials, 'issue-credential': handleIssueCredential };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown sas action: ${action}`);
	return fn(req, res);
});
