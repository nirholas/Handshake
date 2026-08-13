// Shared sanitizer for uncaught MCP tool errors.
//
// Tool handlers reach out to Postgres, internal RPC nodes, and other services.
// When one of those throws, the raw `err.message` frequently carries internals
// we must never echo to an untrusted MCP caller: Postgres driver text + SQLSTATE
// codes, connection strings, internal hostnames/IPs, or stack-derived paths.
//
// `sanitizeToolError` returns a generic, caller-safe message plus a short log id
// that ties the response back to the full detail we write to stderr. Both the
// main /api/mcp dispatcher and the shared payment-free dispatcher
// (mcp-3d / mcp-bazaar) funnel uncaught tool errors through this so the two can
// never diverge in what they leak.

import { randomBytes } from 'node:crypto';
import { isDbUnavailableError, isDbCapacityError } from './db.js';

// Postgres driver errors carry a `severity` and/or SQLSTATE-ish `code` plus
// fields like `schema`, `table`, `column`, `routine`. Treat anything with those
// markers as a DB error whose message must be suppressed wholesale.
function isPostgresError(err) {
	if (!err || typeof err !== 'object') return false;
	if (err.severity !== undefined || err.schema !== undefined) return true;
	if (err.routine !== undefined || err.table !== undefined || err.column !== undefined)
		return true;
	// SQLSTATE codes are 5-char alphanumeric strings (e.g. '42P01', '23505').
	if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return true;
	return false;
}

// Internal hostnames / connection strings that must never leave the server,
// even when an error message is otherwise handler-authored. If a tool error's
// message contains one of these markers we suppress it wholesale.
const INTERNAL_LEAK = [
	/postgres(?:ql)?:\/\//i,
	/redis:\/\//i,
	/\b(?:127\.0\.0\.1|localhost)\b/i,
	/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // RFC1918 10/8
	/\b192\.168\.\d{1,3}\.\d{1,3}\b/, // RFC1918 192.168/16
	/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, // RFC1918 172.16/12
	/\.internal\b/i,
	/ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENOTFOUND/,
];

function leaksInternalText(message) {
	if (!message) return false;
	return INTERNAL_LEAK.some((re) => re.test(message));
}

/**
 * Decide whether an uncaught tool error's own message is safe to surface, log
 * the full detail to stderr keyed by a short id, and return a caller-safe
 * payload.
 *
 * Returns `{ message }` where `message` is the text safe to send to the MCP
 * caller. Postgres/driver errors and any message containing internal markers
 * are replaced with a generic `… (ref <logId>)` string; handler-authored
 * messages that are already safe (e.g. `fetch failed: … (private_address)`)
 * pass through unchanged so existing tool contracts hold.
 *
 * @param {unknown} err           the thrown error
 * @param {object}  ctx
 * @param {string}  ctx.tool      tool name (for the log line)
 * @param {string}  ctx.server    server/log namespace (for the log line)
 * @param {{ error: Function }} [ctx.log]  logger; falls back to console.error
 * @returns {{ message: string, logId: string }}
 */
export function sanitizeToolError(err, { tool, server, log } = {}) {
	const logId = randomBytes(6).toString('hex');
	const rawMessage = err?.message || String(err);
	const detail = err?.stack || rawMessage;
	const meta = { tool, server, log_id: logId, pg_code: err?.code, detail };
	if (log && typeof log.error === 'function') log.error('tool_error', meta);
	else console.error(`[${server || 'mcp'}] tool_error`, meta);

	// A DB outage is transient, not a fault in the caller's request. The Neon HTTP
	// driver reports it as a plain Error whose message ("Error connecting to
	// database: fetch failed") carries no SQLSTATE and trips none of the internal
	// markers above, so it used to reach MCP callers verbatim: driver text an
	// agent cannot act on. Answer with the same designed, actionable contract the
	// REST boundary already uses (api/_lib/http.js wrap answers 503 "database
	// temporarily unavailable, retry shortly"), so an agent retries instead of
	// concluding the tool is broken. Checked BEFORE the suppression branch: a
	// capacity error carries SQLSTATE 53100 and would otherwise collapse into the
	// opaque generic message.
	if (isDbUnavailableError(err) || isDbCapacityError(err)) {
		return { message: `database temporarily unavailable, retry shortly (ref ${logId})`, logId };
	}

	if (isPostgresError(err) || leaksInternalText(rawMessage)) {
		return { message: `internal error (ref ${logId})`, logId };
	}
	// Handler-authored messages reach here already safe (they are written for
	// callers, not derived from driver internals). Surface them verbatim so the
	// existing tool error contracts (e.g. `fetch failed: …`) are preserved.
	return { message: rawMessage || `tool call failed (ref ${logId})`, logId };
}
