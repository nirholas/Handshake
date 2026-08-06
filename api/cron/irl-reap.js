// @ts-check
// GET /api/cron/irl-reap — IRL placement reaper (D4).
//
// Keeps the irl_pins table and every geocell density count lean by deleting dead
// rows the nearby/mine queries already filter out:
//
//   1. Expired anonymous pins, one day past expiry — long enough that a brief
//      clock skew or a viewer mid-session never loses a still-relevant pin, short
//      enough that ghosts don't accumulate. Signed-in permanent pins (expires_at
//      IS NULL) are NEVER reaped.
//   2. Reports tied to pins that no longer exist — once the pin is gone the report
//      trail is moot, so it's purged to keep irl_pin_reports bounded.
//   3. Interactions (taps/views/messages/pays) whose pin is gone, and interactions
//      older than the retention window regardless of pin state. An interaction row
//      is a record that "device X was at coordinate Y at time T" (it snapshots the
//      pin's lat/lng + a viewer_device), so it is exactly the location trail data
//      minimization should not let accumulate. We cascade-delete it the moment its
//      pin dies, and age it out at INTERACTION_RETENTION_DAYS so even a permanent
//      (signed-in) pin's encounter trail can't grow unbounded.
//   4. Usage-analytics events (irl_events, api/_lib/irl-analytics.js) older than 90
//      days, regardless of pin state — coarse telemetry (geocell7 + hashed device
//      prefix, no FK to irl_pins by design) but still a passive trail, so it's
//      bounded the same way interactions are.
//
// Retention window — interactions: 180 days. Rationale: long enough that an owner's
// dashboard inbox + the earnings history a `pay` row backs stay useful across a
// reasonable review horizon, short enough that the location trail has a hard, known
// ceiling. The geo-bearing columns (lat/lng) duplicate the pin's own location and
// are kept only for the lifetime of the row precisely because the row is bounded by
// this window + the orphan cascade; we age out the raw row rather than null its
// coordinates so nothing about a months-old encounter survives. `pay` rows age out
// on the same clock — the durable earnings signal an owner cares about is recent,
// and a 180-day-old settlement is already on-chain (the source of truth), so we do
// not keep a stale geo-tagged copy of it indefinitely.
//
// Hidden pins are NOT deleted here: a moderation-hidden pin is queued for review +
// owner appeal, not garbage. It's reaped only when its own expiry passes (anon) or
// never (signed-in) — the same rule as any other pin.
//
// Runs hourly. Idempotent: re-running deletes nothing new once the table is clean.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { requireCron } from '../_lib/cron-auth.js';

// A single hourly run that deletes more than this many rows is anomalous: a steady
// state reaps a handful of expired anon pins + their trail, so a four-figure sweep
// means a mass-expiry (clock jump, bulk backfill, or a delete bug) worth a human
// look. Tuned well above normal hourly volume so a healthy sweep stays silent.
export const REAP_SPIKE_THRESHOLD = 1000;

// Pure: is this run's deletion volume anomalous? Sums the three sweep counts and
// compares to the threshold. Exported for unit testing — no I/O, no clock.
export function reapTotal(counts) {
	return (counts?.pins || 0) + (counts?.reports || 0) + (counts?.interactions || 0) +
		(counts?.worldLines || 0) + (counts?.proofs || 0) + (counts?.events || 0);
}
export function isReapSpike(counts, threshold = REAP_SPIKE_THRESHOLD) {
	return reapTotal(counts) >= threshold;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	// Both tables are created lazily by their write endpoints (irl_pins by
	// api/irl/pins.js, irl_pin_reports by api/irl/report.js), so on a fresh
	// deployment — or before the first pin is placed / first report is filed —
	// they may not exist yet. A reaper that hard-depended on them would throw
	// `relation does not exist` and 500 the hourly cron. Probe with to_regclass
	// and treat a missing table as "nothing to reap" rather than an error.
	const [{ pins, reports, interactions, worldlines, proofs, events }] = await sql`
		SELECT
			to_regclass('public.irl_pins')             AS pins,
			to_regclass('public.irl_pin_reports')      AS reports,
			to_regclass('public.irl_interactions')     AS interactions,
			to_regclass('public.irl_world_lines')      AS worldlines,
			to_regclass('public.irl_presence_proofs')  AS proofs,
			to_regclass('public.irl_events')           AS events
	`;

	// Expired anon pins, ≥ 1 day past expiry. expires_at IS NULL ⇒ permanent ⇒ kept.
	const reapedPins = pins
		? await sql`
			DELETE FROM irl_pins
			WHERE expires_at IS NOT NULL
			  AND expires_at < NOW() - INTERVAL '1 day'
			RETURNING id
		`
		: [];

	// Orphaned reports — their pin is gone, so the trail is moot. If the pins
	// table itself is absent, every report is an orphan, so purge them all.
	let reapedReports = [];
	if (reports) {
		reapedReports = pins
			? await sql`
				DELETE FROM irl_pin_reports r
				WHERE NOT EXISTS (SELECT 1 FROM irl_pins p WHERE p.id = r.pin_id)
				RETURNING r.id
			`
			: await sql`DELETE FROM irl_pin_reports RETURNING id`;
	}

	// Interactions — the location trail. Two sweeps, both existence-guarded so a
	// fresh DB never 500s:
	//   a. orphaned — the pin is gone, so the encounter record is moot (mirrors the
	//      report orphan sweep). With no pins table at all, every interaction is an
	//      orphan, so purge them all.
	//   b. aged-out — older than the retention window regardless of pin state, so a
	//      permanent pin's trail can't accumulate forever.
	// A single re-run after a clean sweep deletes nothing new (idempotent): both
	// predicates are empty once the table holds only live, in-window rows.
	let reapedInteractions = [];
	if (interactions) {
		const orphaned = pins
			? await sql`
				DELETE FROM irl_interactions ix
				WHERE NOT EXISTS (SELECT 1 FROM irl_pins p WHERE p.id = ix.pin_id)
				RETURNING ix.id
			`
			: await sql`DELETE FROM irl_interactions RETURNING id`;
		const aged = await sql`
			DELETE FROM irl_interactions
			WHERE created_at < NOW() - INTERVAL '180 days'
			RETURNING id
		`;
		reapedInteractions = [...orphaned, ...aged];
	}

	// World Lines (proof-of-presence AR quests) + their presence proofs. A World Line
	// always carries an expiry (creator-bounded, ≤ 90 days), so it's reaped one day past
	// it — the same grace as anon pins. A presence proof is the visitor's ownable, coarse
	// "I was there" collectible: it carries only a ~1.1 km cell + a salted completer hash
	// (never a coordinate, never a raw device token), so it is NOT a precise location
	// trail to age out — instead it lives as long as its quest and is cascade-deleted the
	// moment the quest is gone, plus an orphan sweep for any proof whose quest vanished.
	// Both are existence-guarded so a fresh DB never 500s.
	let reapedWorldLines = [];
	if (worldlines) {
		reapedWorldLines = await sql`
			DELETE FROM irl_world_lines
			WHERE expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '1 day'
			RETURNING id
		`;
	}
	let reapedProofs = [];
	if (proofs) {
		reapedProofs = worldlines
			? await sql`
				DELETE FROM irl_presence_proofs pr
				WHERE NOT EXISTS (SELECT 1 FROM irl_world_lines w WHERE w.id = pr.world_line_id)
				RETURNING pr.id
			`
			: await sql`DELETE FROM irl_presence_proofs RETURNING id`;
	}

	// Usage-analytics events (api/_lib/irl-analytics.js) — coarse telemetry
	// (geocell7 + a hashed device prefix, never a raw coordinate or token) with
	// no FK to irl_pins by design: a pin can expire while its historical placement
	// trend stays queryable. Still bounded like every other passive trail here —
	// aged out at 90 days regardless of pin state.
	let reapedEvents = [];
	if (events) {
		reapedEvents = await sql`
			DELETE FROM irl_events
			WHERE created_at < NOW() - INTERVAL '90 days'
			RETURNING id
		`;
	}

	const counts = {
		pins: reapedPins.length,
		reports: reapedReports.length,
		interactions: reapedInteractions.length,
		worldLines: reapedWorldLines.length,
		proofs: reapedProofs.length,
		events: reapedEvents.length,
	};
	const total = reapTotal(counts);

	// Per-run telemetry (task 14): one structured line every run so the sweep is
	// observable and a reaper that silently stopped deleting (or started deleting
	// far too much) is diagnosable from the logs. No PII — counts only.
	console.log('[irl-reap] swept', { ...counts, total, ts: new Date().toISOString() });

	// Anomalous-spike alert. A run far above steady state is surfaced to ops once
	// (deduped by hour bucket inside sendOpsAlert). Repeated hard FAILURES are
	// already covered: this handler is wrapped, and wrap() fires an unhandled-5xx
	// ops alert if any query throws, so a reaper that keeps crashing self-reports.
	if (isReapSpike(counts)) {
		sendOpsAlert(
			'IRL reaper spike',
			`The IRL reaper deleted ${total} rows in one run (pins ${counts.pins}, reports ${counts.reports}, interactions ${counts.interactions}, worldLines ${counts.worldLines}, proofs ${counts.proofs}, events ${counts.events}) — above the ${REAP_SPIKE_THRESHOLD} anomaly threshold. Possible mass-expiry, backfill, or delete bug.`,
			{ signature: `irl-reap:spike:${Math.floor(Date.now() / 3_600_000)}` },
		);
	}

	return json(res, 200, {
		ok: true,
		reapedPins: counts.pins,
		reapedReports: counts.reports,
		reapedInteractions: counts.interactions,
		reapedWorldLines: counts.worldLines,
		reapedProofs: counts.proofs,
		reapedEvents: counts.events,
		ts: Date.now(),
	});
});
