# Blog audit batch 02

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

       for p in /blog/three-ws-alibaba-cloud-partnership /blog/x402-stripe-for-agent-payments /blog/see-your-3d-in-ar /blog/text-to-3d-is-live /blog/3d-ai-crypto-convergence /blog/three-ws-dextools-social-boost-buyback /blog/three-ws-featured-on-alibaba-cloud-marketplace-blog /blog/three-ws-ibm-collaboration /blog/three-ws-play-coin-communities /blog/three-ws-aws-partner; do printf '%s ' "$p"; curl -so /dev/null -w '%{http_code}\n' "https://three.ws$p"; done

## Task: audit this batch of blog pages, then fix everything found

Pages in this batch:

- /blog/three-ws-alibaba-cloud-partnership ("three.ws Joins the Alibaba Cloud Partner Network")
- /blog/x402-stripe-for-agent-payments ("The Stripe of x402: How three.ws Turned Agent Payments Into One Line of Code")
- /blog/see-your-3d-in-ar ("See Your 3D Avatar in the Real World: AR Lands on three.ws")
- /blog/text-to-3d-is-live ("Text to 3D Is Live: Type a Prompt, Download a 3D Model")
- /blog/3d-ai-crypto-convergence ("3D + AI + Web3 Just Converged: three.ws Shipped the Whole Stack")
- /blog/three-ws-dextools-social-boost-buyback ("three.ws Wins DEXTools Social Boost: $5,543 $three Buyback")
- /blog/three-ws-featured-on-alibaba-cloud-marketplace-blog ("three.ws Featured on the Alibaba Cloud Marketplace Blog")
- /blog/three-ws-ibm-collaboration ("Showcasing the three.ws × IBM Partnership")
- /blog/three-ws-play-coin-communities ("We turned every memecoin into a live 3D world you can walk into")
- /blog/three-ws-aws-partner ("three.ws Joins the AWS Partner Network")

For every page, in a real headless browser against localhost:

1. HTTP 200, zero console errors, zero unhandled failed requests.
2. Every link on the page resolves (internal paths exist in the route table;
   anchors have targets). Fix or remove dead ones.
3. Rendering integrity only: images load, layout is intact at 320 and 1440 px, dates and metadata render. Do not rewrite editorial voice; fix mechanics.
4. Title tag and meta description present and specific.
5. Fix defects at their root and re-run until clean.

## Definition of done

- [ ] Every page in the batch loads locally with HTTP 200 and zero console
      errors.
- [ ] Zero dead links across the batch.
- [ ] Layout verified at 320 and 1440 px on every page.
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

       git rm prompts/swarm-100/blog-batch-02.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
