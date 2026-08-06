-- The registration prep pipeline stores the manifest in R2 (a plain HTTPS
-- metadata URI) when no IPFS pinning provider is configured, which is the
-- default deployment shape. There is no CID in that case, but the column was
-- NOT NULL, so every prep 500'd at the insert. Make cid nullable; metadata_uri
-- remains the authoritative pointer either way.
alter table agent_registrations_pending alter column cid drop not null;
