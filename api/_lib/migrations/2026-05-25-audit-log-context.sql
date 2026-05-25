-- Migration: capture request context (IP + user agent) on audit_log rows.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/2026-05-25-audit-log-context.sql
-- Idempotent.
--
-- Rationale: the per-user audit feed on /dashboard-next/account exposes
-- IP and user-agent columns. Existing audit_log rows had no slot for
-- either. Both columns are nullable so rows written before this migration
-- (or by callers that don't yet pass req) remain valid.
--
-- Length caps mirror what we already accept in sessions.user_agent and
-- sessions.ip — keep the audit row representation aligned with how we
-- already store request metadata elsewhere.

alter table audit_log
    add column if not exists ip text,
    add column if not exists user_agent text;
