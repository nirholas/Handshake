// Feedback persistence: capture, the triage queue, and the clusters a human
// reads. Everything a visitor typed lives in `body` and is treated as untrusted
// data everywhere downstream (see triage.js for why that rule is load-bearing).

import { createHash } from 'node:crypto';
import { sql } from '../db.js';
import { isUuid } from '../validate.js';

export const KINDS = ['bug', 'broken-link', 'confusing', 'copy', 'idea', 'praise', 'spam'];
export const STATUSES = ['new', 'triaged', 'accepted', 'dismissed', 'fixed'];

// Anonymous reporters are identified by a browser-generated key that we never
// store raw, exactly like /forge does for its creations. Enough to thread a
// follow-up and rate-limit; not enough to be a tracking identifier.
export function hashClient(raw) {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value) return null;
	return createHash('sha256').update(`feedback:${value}`).digest('hex').slice(0, 32);
}

function clampText(value, max) {
	if (typeof value !== 'string') return null;
	const flat = value.replace(/\s+/g, ' ').trim();
	if (!flat) return null;
	return flat.length > max ? flat.slice(0, max) : flat;
}

// Only the fields we asked the page for, each capped. A client that posts a
// megabyte of "console errors" gets the first few, not a row we cannot read.
function clampList(value, { max = 5, length = 400 } = {}) {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, max)
		.map((item) => clampText(typeof item === 'string' ? item : JSON.stringify(item), length))
		.filter(Boolean);
}

// A trace is machine-written, so it is validated by SHAPE rather than trusted
// by origin: anyone can POST to the report endpoint. Anything past these caps
// is a client that is broken or lying, and either way the row must stay small
// enough to read. Values a person typed are never in here by construction
// (packages/witness/src/redact.js), so there is nothing to strip, only to bound.
const MAX_TRACE_EVENTS = 80;
const TRACE_EVENT_TYPES = new Set([
	'goto', 'navigate', 'click', 'fill', 'check', 'select', 'submit', 'key', 'xhr', 'error', 'rejection', 'resource',
]);

export function normalizeTrace(raw) {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) return null;
	const events = [];
	for (const event of raw.events.slice(0, MAX_TRACE_EVENTS)) {
		if (!event || typeof event !== 'object') continue;
		if (!TRACE_EVENT_TYPES.has(event.type)) continue;
		const out = { type: event.type };
		const detail = clampText(event.detail, 300);
		if (detail) out.detail = detail;
		if (Number.isInteger(event.count) && event.count > 1) out.count = Math.min(event.count, 9999);
		if (event.fatal === true) out.fatal = true;
		if (event.el && typeof event.el === 'object') {
			out.el = {
				tag: clampText(event.el.tag, 20),
				strategy: clampText(event.el.strategy, 20),
				value: clampText(event.el.value, 200),
				css: clampText(event.el.css, 300),
				role: clampText(event.el.role, 40),
				name: clampText(event.el.name, 120),
				attr: clampText(event.el.attr, 40),
				confidence: Number.isFinite(event.el.confidence) ? Math.max(0, Math.min(100, Math.round(event.el.confidence))) : null,
			};
		}
		events.push(out);
	}
	if (!events.length) return null;
	const env = raw.environment && typeof raw.environment === 'object' ? raw.environment : {};
	const viewport = env.viewport && typeof env.viewport === 'object' ? env.viewport : {};
	return {
		version: 1,
		environment: {
			url: clampText(env.url, 300),
			locale: clampText(env.locale, 40),
			userAgent: clampText(env.userAgent, 300),
			touch: env.touch === true,
			reducedMotion: env.reducedMotion === true,
			viewport: {
				width: Number.isFinite(viewport.width) ? Math.round(viewport.width) : null,
				height: Number.isFinite(viewport.height) ? Math.round(viewport.height) : null,
				dpr: Number.isFinite(viewport.dpr) ? Number(viewport.dpr.toFixed(2)) : null,
			},
		},
		recordedMs: Number.isFinite(raw.recordedMs) ? Math.max(0, Math.round(raw.recordedMs)) : 0,
		events,
	};
}

export function normalizeReport(input = {}) {
	return {
		trace: normalizeTrace(input.trace),
		body: clampText(input.body, 4000),
		transport: input.transport === 'voice' ? 'voice' : 'text',
		route: clampText(input.route, 300),
		page_title: clampText(input.page_title, 200),
		build_sha: clampText(input.build_sha, 64),
		viewport: clampText(input.viewport, 40),
		locale: clampText(input.locale, 40),
		console_errors: clampList(input.console_errors),
		failed_requests: clampList(input.failed_requests),
	};
}

export async function insertReport({ userId = null, clientKey = null, userAgent = null, report }) {
	// The two trace summaries are denormalized on write so the queue can rank by
	// "is this replayable" without opening every document.
	const summary = report.trace ? summarizeTrace(report.trace) : { steps: null, confidence: null };
	const [row] = await sql`
		insert into feedback_reports
			(user_id, client_key, body, transport, route, page_title, build_sha,
			 viewport, user_agent, locale, console_errors, failed_requests,
			 trace, trace_steps, replay_confidence)
		values (${userId}, ${clientKey}, ${report.body}, ${report.transport}, ${report.route},
		        ${report.page_title}, ${report.build_sha}, ${report.viewport},
		        ${clampText(userAgent, 400)}, ${report.locale},
		        ${JSON.stringify(report.console_errors)}::jsonb,
		        ${JSON.stringify(report.failed_requests)}::jsonb,
		        ${report.trace ? JSON.stringify(report.trace) : null}::jsonb,
		        ${summary.steps}, ${summary.confidence})
		returning id, created_at
	`;
	return row || null;
}

/** How many replayable steps a trace holds, and how well its weakest step is anchored. */
export function summarizeTrace(trace) {
	const events = trace?.events || [];
	const actions = events.filter((e) => ['click', 'fill', 'check', 'select', 'submit', 'key', 'navigate'].includes(e.type));
	const described = actions.filter((e) => e.el && Number.isFinite(e.el.confidence));
	const confidence = described.length ? Math.min(...described.map((e) => e.el.confidence)) : null;
	return { steps: Math.min(actions.length, 32767), confidence };
}

export async function untriagedReports(limit = 20) {
	return sql`
		select id, body, transport, route, page_title, build_sha, viewport, locale,
		       console_errors, failed_requests, created_at
		from feedback_reports
		where triaged_at is null
		order by created_at asc
		limit ${limit}
	`;
}

export async function saveTriage(id, verdict) {
	const [row] = await sql`
		update feedback_reports set
			status = case when status = 'new' then 'triaged' else status end,
			severity = ${verdict.severity},
			kind = ${verdict.kind},
			subsystem = ${verdict.subsystem},
			summary = ${verdict.summary},
			repro = ${verdict.repro},
			cluster_key = ${verdict.cluster_key},
			triage_model = ${verdict.engine},
			triaged_at = now()
		where id = ${id}
		returning id, cluster_key, severity, kind
	`;
	return row || null;
}

/**
 * The review queue, grouped the way a maintainer wants to read it: one row per
 * cluster, loudest first, with the newest example and how many people hit it.
 */
export async function listClusters({ status = 'open', limit = 50 } = {}) {
	const statusClause =
		status === 'all'
			? sql``
			: status === 'open'
				? sql`and status in ('new', 'triaged', 'accepted')`
				: sql`and status = ${status}`;
	return sql`
		select coalesce(cluster_key, 'ungrouped:' || id::text) as cluster_key,
		       count(*)::int                                   as reports,
		       max(severity)                                   as severity,
		       min(created_at)                                 as first_seen,
		       max(created_at)                                 as last_seen,
		       (array_agg(kind order by created_at desc))[1]      as kind,
		       (array_agg(subsystem order by created_at desc))[1] as subsystem,
		       (array_agg(summary order by created_at desc))[1]   as summary,
		       (array_agg(repro order by created_at desc))[1]     as repro,
		       (array_agg(status order by created_at desc))[1]    as status,
		       (array_agg(route order by created_at desc))[1]     as route,
		       (array_agg(build_sha order by created_at desc))[1] as build_sha,
		       (array_agg(id order by created_at desc))[1]        as latest_id,
		       max(replay_confidence)                             as replay_confidence,
		       count(*) filter (where trace is not null)::int      as traced,
		       count(distinct coalesce(user_id::text, client_key))::int as reporters
		from feedback_reports
		where true ${statusClause}
		group by 1
		order by max(severity) desc nulls last, count(*) desc, max(created_at) desc
		limit ${limit}
	`;
}

export async function listReports({ clusterKey = null, limit = 50 } = {}) {
	const target = clusterKey ? targetFromClusterKey(clusterKey) : {};
	const clusterClause = target.id
		? sql`and id = ${target.id}`
		: target.clusterKey
			? sql`and cluster_key = ${target.clusterKey}`
			: sql``;
	return sql`
		select id, body, transport, route, page_title, build_sha, viewport, locale,
		       console_errors, failed_requests, status, severity, kind, subsystem,
		       summary, repro, cluster_key, resolution, created_at, triaged_at, resolved_at,
		       trace, trace_steps, replay_confidence,
		       user_id is not null as signed_in
		from feedback_reports
		where true ${clusterClause}
		order by created_at desc
		limit ${limit}
	`;
}

// A report the triage cron has not reached yet has no cluster_key, so the queue
// renders it under the synthetic key `ungrouped:<id>` (see listClusters). Acting
// on such a row must resolve back to that one report, or the button would report
// success while matching nothing.
export function targetFromClusterKey(clusterKey) {
	const key = String(clusterKey || '');
	if (!key.startsWith('ungrouped:')) return { clusterKey: key };
	// A malformed synthetic key must not reach Postgres as a uuid comparison,
	// which would 500 rather than simply matching nothing.
	const id = key.slice('ungrouped:'.length);
	return isUuid(id) ? { id } : {};
}

/** One report with its full trace, for the repro compiler. */
export async function reportWithTrace(id) {
	const [row] = await sql`
		select id, body, summary, route, build_sha, trace, trace_steps, replay_confidence, created_at
		from feedback_reports
		where id = ${id}
	`;
	return row || null;
}

export async function setStatus({ id = null, clusterKey = null, status, resolution = null }) {
	if (!STATUSES.includes(status)) return 0;
	const closing = status === 'fixed' || status === 'dismissed';
	if (!id && clusterKey) {
		const resolved = targetFromClusterKey(clusterKey);
		id = resolved.id ?? null;
		clusterKey = resolved.clusterKey ?? null;
	}
	if (!id && !clusterKey) return 0;
	const target = id ? sql`id = ${id}` : sql`cluster_key = ${clusterKey}`;
	const rows = await sql`
		update feedback_reports set
			status = ${status},
			resolution = coalesce(${clampText(resolution, 500)}, resolution),
			resolved_at = ${closing ? sql`now()` : sql`null`}
		where ${target}
		returning id
	`;
	return rows.length;
}

export async function feedbackStats() {
	const [row] = await sql`
		select count(*) filter (where status in ('new', 'triaged', 'accepted'))::int as open,
		       count(*) filter (where triaged_at is null)::int           as untriaged,
		       count(*) filter (where created_at > now() - interval '24 hours')::int as today,
		       count(*)::int                                             as total
		from feedback_reports
	`;
	return row || { open: 0, untriaged: 0, today: 0, total: 0 };
}
