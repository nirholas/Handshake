// GET/POST /api/cron/sniper-loops-health: the row-count watchdog over the
// fleet's autonomous learning loops.
//
// Born from the July 2026 audit's ugliest finding: the optimizer and evolution
// loops ran dead for two days behind green health checks, because every check
// looked at status codes and none looked at side effects. This cron asks each
// loop the one question that cannot lie — "when did you last write a row?" —
// and pages the ops channel (with per-signature dedup) when any answer is too
// old. The loop declarations and staleness policy are pure and unit-tested in
// api/_lib/sniper-loops-health.js.
//
// A degraded probe (table missing, query error) is reported as its own alert
// rather than swallowed: an unqueryable ledger is exactly the kind of silence
// this watchdog exists to catch.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { LOOPS, classifyLoopHealth, describeStale } from '../_lib/sniper-loops-health.js';

const NETWORK = 'mainnet';

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { error(res, 401, 'unauthorized', 'invalid cron secret'); return false; }
	return true;
}

// One freshest-row probe per loop. Table/column names come from the static
// LOOPS declaration (never user input), so the interpolation here is safe; the
// only runtime value, the network, is parameterized.
async function probeLoop(loop) {
	try {
		const where = loop.networkColumn ? `where ${loop.networkColumn} = $1` : '';
		const params = loop.networkColumn ? [NETWORK] : [];
		const rows = await sql.query(
			`select max(${loop.column}) as last_at from ${loop.table} ${where}`,
			params,
		);
		return { name: loop.name, lastAt: rows?.[0]?.last_at ?? null };
	} catch (err) {
		return { name: loop.name, lastAt: null, probeError: err?.message || 'query failed' };
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const probes = await Promise.all(LOOPS.map(probeLoop));
	const broken = probes.filter((p) => p.probeError);
	const { ok, stale } = classifyLoopHealth(probes.filter((p) => !p.probeError), Date.now());

	if (stale.length) {
		// One alert per run covering every stale loop, deduped hourly on a stable
		// signature so a dead loop pages once an hour until it produces rows again.
		const body = stale.map(describeStale).join('\n');
		await Promise.resolve(sendOpsAlert(
			`🎯 agent-sniper — ${stale.length} learning loop(s) STALE (rows, not status codes)`,
			body,
			{ signature: 'sniper:loops-stale' },
		)).catch(() => {});
	}
	if (broken.length) {
		await Promise.resolve(sendOpsAlert(
			'🎯 agent-sniper — loops-health probe failed',
			broken.map((b) => `${b.name}: ${b.probeError}`).join('\n'),
			{ signature: 'sniper:loops-probe-failed' },
		)).catch(() => {});
	}

	return json(res, 200, {
		ok: stale.length === 0 && broken.length === 0,
		checked: probes.length,
		stale: stale.map((s) => ({ name: s.name, last_at: s.lastAt, age_h: s.ageMs === Infinity ? null : Math.round(s.ageMs / 3600_000 * 10) / 10 })),
		healthy: ok.map((s) => s.name),
		probe_errors: broken.map((b) => ({ name: b.name, error: b.probeError })),
	});
});
