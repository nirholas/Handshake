// Generalized "enabled but silent" tripwire.
//
// The original x402 ring outage went unnoticed for days because a money loop was
// configured-active yet producing zero volume and NOTHING alarmed on the silence.
// The ring now has a dedicated tripwire (ring-reconciliation.js); this generalizes
// the pattern so ANY money subsystem can declare "if I'm enabled and I've been
// silent past my window, page ops". Pure decision + a thin DB/alert wrapper.

import { sql } from './db.js';
import { sendOpsAlert } from './alerts.js';

/**
 * Pure: is a subsystem enabled-but-silent right now?
 *
 * @param {{ configured: boolean, lastActivityMs: number|null, windowMs: number, now: number }} p
 * @returns {{ silent: boolean, ageMinutes: number|null }}
 */
export function evaluateTripwire({ configured, lastActivityMs, windowMs, now }) {
	if (!configured) return { silent: false, ageMinutes: null };
	if (lastActivityMs == null) {
		// Configured but has NEVER produced activity — that is the strongest silent
		// signal, not an exemption.
		return { silent: true, ageMinutes: null };
	}
	const ageMs = Math.max(0, now - lastActivityMs);
	return { silent: ageMs >= windowMs, ageMinutes: Math.round(ageMs / 60_000) };
}

/**
 * Run a tripwire and, when silent, write a WARN verdict + page ops (throttled by
 * sendOpsAlert's per-signature 1/hour dedup). Never throws into a caller.
 *
 * @param {object} p
 * @param {string} p.subsystem   short id, e.g. 'launcher' | 'buyback'
 * @param {boolean} p.configured is the subsystem armed/enabled?
 * @param {number|null} p.lastActivityMs epoch ms of the last real activity, or null
 * @param {number} [p.windowMinutes] silence threshold (default 60)
 * @param {number} p.now epoch ms (pass explicitly; the cron clock)
 * @param {string} [p.runId]
 * @returns {Promise<{ silent: boolean, ageMinutes: number|null }>}
 */
export async function runTripwire({ subsystem, configured, lastActivityMs, windowMinutes = 60, now, runId = null }) {
	const windowMs = Math.max(1, windowMinutes) * 60_000;
	const verdict = evaluateTripwire({ configured, lastActivityMs, windowMs, now });
	try {
		if (verdict.silent) {
			await upsertTripwireVerdict({
				subsystem, reconciled: false, runId,
				detail: `${subsystem} is enabled but has produced no activity ${verdict.ageMinutes == null ? 'ever' : `in ${verdict.ageMinutes} min`} (window ${windowMinutes} min).`,
			});
			await sendOpsAlert(
				`🔕 ${subsystem} enabled but SILENT`,
				`The ${subsystem} money loop is configured active but has been silent ${verdict.ageMinutes == null ? '(no activity on record)' : `for ~${verdict.ageMinutes} min`}. Something may have quietly stopped — investigate before it goes unnoticed for days.`,
				{ signature: `tripwire-silent:${subsystem}` },
			);
		} else if (configured) {
			// Self-heal: clear a prior silent verdict once activity resumes.
			await upsertTripwireVerdict({ subsystem, reconciled: true, runId, detail: `${subsystem} active (last activity ${verdict.ageMinutes ?? 0} min ago).` });
		}
	} catch (err) {
		console.warn('[tripwire] write failed', { subsystem, message: err?.message });
	}
	return verdict;
}

async function upsertTripwireVerdict({ subsystem, reconciled, runId, detail }) {
	await sql`
		INSERT INTO payment_reconciliation
			(source, source_ref, tx_signature, network, amount_atomic,
			 db_status, chain_status, reconciled, discrepancy, detail, run_id, checked_at)
		VALUES
			('financial_tripwire', ${`silent:${subsystem}`}, null, 'mainnet', null,
			 'enabled', ${reconciled ? 'active' : 'silent'}, ${reconciled},
			 ${reconciled ? null : detail}, ${JSON.stringify({ subsystem })}, ${runId}, now())
		ON CONFLICT (source, source_ref) DO UPDATE SET
			db_status = EXCLUDED.db_status, chain_status = EXCLUDED.chain_status,
			reconciled = EXCLUDED.reconciled, discrepancy = EXCLUDED.discrepancy,
			detail = EXCLUDED.detail, run_id = EXCLUDED.run_id, checked_at = now()
	`;
}

/** Last-activity epoch ms from a table's newest timestamp column, or null. */
export async function lastActivityMs(table, tsColumn = 'created_at') {
	try {
		// table/column are internal literals, never user input.
		const rows = await sql(`SELECT extract(epoch from max(${tsColumn})) * 1000 AS ms FROM ${table}`);
		const ms = rows?.[0]?.ms;
		return ms != null ? Number(ms) : null;
	} catch {
		return null; // table absent / empty → treat as no activity on record
	}
}
