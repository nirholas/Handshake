# Docs audit batch 32: /docs/security through /docs/token-gated-3d-embeds

How to run: paste this file's repo path into a fresh Claude Code chat in this
repository and say "run this work order". This file is fully self-contained:
it depends on no other prompt file anywhere. If neighboring files in
prompts/swarm-100/ are gone, that work is done; if present, ignore them.
Every claim below rots; step 0 re-measures, and what you measure wins.

## Operating clause (binding)

- Read CLAUDE.md first. Its rules override everything, including this file.
- Finish 100% in this session. Never end the turn with a question, an option
  list, or an unexecuted plan. A judgment call goes in one line of the final
  report; it never becomes a question that halts work.
- The only permitted stops are the CLAUDE.md stop-and-ask gates: spending real
  funds or any irreversible on-chain write, git push or a production deploy,
  committing content that references a crypto project other than $THREE, and
  destroying unrecoverable data.
- No mocks, no fake data, no placeholder stubs, no unfinished-work markers, no
  commented-out code. Real APIs and real integrations only.
- The em-dash and en-dash characters are banned in everything you write.
- Concurrent agents share this worktree: stage explicit paths only (never a
  bare add-everything), and commit finished work promptly.
- Before committing, run: npm run check:rules -- --paths <files you touched>.
  It must exit 0.

## Step 0: re-derive the current state

1. Confirm each path below still exists in data/pages.json; a path that was
   removed there is out of scope (note it in the report, skip it).
2. Start (or reuse) the local dev server: npm run dev (vite, port 3000).
3. Probe production for each path:

       for p in /docs/security /docs/seed-quality /docs/shared-utilities /docs/sign-language /docs/smart-contracts /docs/solana /docs/spatial-mcp /docs/token-gated-3d-embeds; do printf '%s ' "$p"; curl -so /dev/null -w '%{http_code}\n' "https://three.ws$p"; done

## Task: audit this batch of docs pages, then fix everything found

Pages in this batch:

- /docs/security ("Docs · Security")
- /docs/seed-quality ("Docs · The catalog quality gate")
- /docs/shared-utilities ("Docs · Shared utilities")
- /docs/sign-language ("Docs · Sign language, avatars that sign")
- /docs/smart-contracts ("Docs · ERC-8004 smart contracts")
- /docs/solana ("Docs · Solana agents")
- /docs/spatial-mcp ("Docs · Spatial MCP")
- /docs/token-gated-3d-embeds ("Docs · Token-gated 3D embeds")

For every page, in a real headless browser against localhost:

1. HTTP 200, zero console errors, zero unhandled failed requests.
2. Every link on the page resolves (internal paths exist in the route table;
   anchors have targets). Fix or remove dead ones.
3. Content accuracy: the page documents current behavior. Spot-check its claims against the code it describes; where it names a command, run the command; where it shows a code sample, the sample must actually run. Fix stale claims in the same change.
4. Title tag and meta description present and specific.
5. Fix defects at their root and re-run until clean.

## Definition of done

- [ ] Every page in the batch loads locally with HTTP 200 and zero console
      errors.
- [ ] Zero dead links across the batch.
- [ ] Every named command and code sample on these pages verified runnable, or corrected.
- [ ] Title and meta description verified on every page.
- [ ] npm run check:rules -- --paths <touched files> exits 0; npm test passes
      if you touched code.
- [ ] Production status per page recorded in the report.

## Never blocked

| Blocker | Resolution (act, do not ask) |
|---|---|
| Missing env var or credential | Check .env and .env.local, then the Cloud Run service env, then Secret Manager (the CLAUDE.md self-unblock playbook has the exact commands). If it truly exists nowhere, wire the code fully behind the env var, prove the wiring with a dry run, and name the single missing var in the report. |
| gcloud not on PATH | Run: export PATH="$HOME/google-cloud-sdk/bin:$PATH" |
| Dev server port 3000 busy | Another agent may be serving this repo; probe it and reuse if so. Otherwise start your own on a free port: npx vite --port 3101 |
| Playwright browser missing | npx playwright install chromium |
| A surface needs a signed-in user | Register a fresh account through the real /register flow against the real API and use it. Never mock the session. |
| A defect sits in code you did not touch | Fix it if it blocks a Definition of done line (root cause it, never mask it). Otherwise note it in the report and continue. |
| An unrelated test is red | Same rule. Never pipe npm test through tail; it masks exit codes. |

## Close out (required)

1. Verify every Definition of done line with the actual command output in
   front of you. Never claim a line you did not verify.
2. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares).
3. Delete this prompt file in that same commit:

       git rm prompts/swarm-100/docs-batch-32.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
