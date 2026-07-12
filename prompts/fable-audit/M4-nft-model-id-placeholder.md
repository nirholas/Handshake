# M4 — Medium: Stale model id minted into immutable on-chain NFT metadata

**Severity:** Medium · **Area:** Skills / on-chain metadata · **Commit-gate:** ⚠ commit-gate

## The defect
`data/skills/protocol/erc8004-agent-creation-guide/SKILL.md:47` sets
`model: "claude-3.5-sonnet"` and `:63` says `"Claude 3.5 Sonnet"`; the same value is
duplicated in `data/skills/seed.json:101`. Unlike doc prose, this string is uploaded
to IPFS and **minted into immutable NFT metadata** — the staleness becomes permanent
and public. Every agent created via this guide is stamped with an outdated model id.

## The fix
Replace the hardcoded model id with a version-agnostic placeholder filled at mint
time from live config, e.g.:
- In the guide, describe the field as *"the current default model (resolve at mint
  time from platform config / the caller's selection), not a hardcoded id."*
- If a concrete example is needed, use a clearly-templated token like
  `"<current-default-model>"` rather than a real id.

Apply the identical change to the `seed.json:101` copy (see LEAN item — `seed.json`
duplicates ~115 skill bodies; fix both until the generation step exists).

## Commit-gate
This file is under `data/skills/protocol/` and the ERC-8004 guide references the
broader agent-identity ecosystem. Confirm whether the diff references any non-$THREE
crypto project; if it does, **get owner approval before staging.** The model-id
change itself is $THREE-neutral, so if the surrounding file is clean this can land
without the gate — verify the `git diff` first.

## Verification
1. Grep confirms no concrete `claude-3.5-sonnet` (or any dated model id) remains in
   the guide or its `seed.json` copy.
2. A mint dry-run resolves the model from config, not the literal.

## Done checklist
- [ ] Guide uses a resolve-at-mint placeholder.
- [ ] `seed.json` copy updated to match.
- [ ] `git diff` checked against the commit gate before staging.
