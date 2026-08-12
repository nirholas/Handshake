-- forge_seed_jobs.gate_attempts: how many times the catalog quality gate has
-- tried to judge this generation.
--
-- The gate's error branch was terminal on the FIRST fault: one transient read
-- from object storage ("We encountered an internal error. Please try again.")
-- moved a finished, GPU-paid mesh to status 'gate_error' forever, and nothing
-- ever revisits that state. Two seed jobs were buried that way on 2026-08-12
-- inside a single day. A gate fault is infrastructure, not a quality verdict,
-- so it deserves a retry; the counter is what bounds that retry, so a mesh that
-- genuinely cannot be gated still reaches a terminal state instead of cycling
-- through the gate batch forever.

ALTER TABLE forge_seed_jobs ADD COLUMN IF NOT EXISTS gate_attempts smallint NOT NULL DEFAULT 0;
