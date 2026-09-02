# Route audit: /hacks (DeFi Hacks Database)

How to run: paste this file's repo path into a fresh Claude Code chat in this
repository and say "run this work order". This file is fully self-contained:
it depends on no other prompt file anywhere. If sibling swarm-100 files in
prompts/finish/ are gone, that work is done; if present, ignore them.
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

1. This route's declared entry (path, description, added date):

       node -e "const p=require('./data/pages.json');for(const s of p.sections)for(const g of s.pages)if(g.path==='/hacks')console.log(JSON.stringify(g,null,2))"

2. Find the serving implementation: grep "/hacks" in vercel.json (the live
   route table server/index.mjs boots from), then list matching files in
   pages/ and src/. STRUCTURE.md maps every surface to its directory if the
   grep is ambiguous.
3. Production right now:

       curl -so /dev/null -w '%{http_code}\n' https://three.ws/hacks

4. Start (or reuse) the local dev server: npm run dev (vite, port 3000).

## Task: audit this one route end to end, then fix everything found

Route: /hacks ("DeFi Hacks Database", section "crypto").
Declared purpose: A searchable database of every major DeFi exploit: amount stolen, classification, technique, chains affected, whether it was a bridge hack, and the source, with all-time and trailing-12-month totals. Live from DeFiLlama.

Drive the page in a real headless browser. Playwright is already a dev
dependency; keep your probe script in the session scratchpad, never in the
repo.

1. Load http://localhost:3000/hacks. Record the HTTP status, every console
   error and warning, and every failed network request.
2. Exercise it like a first-time user: click the primary actions, run the
   primary flow if one exists, follow the page's internal links. Every button
   must do something real; every link must resolve. If the page renders data,
   prove in the network log that it came from a live endpoint, not a baked-in
   fallback array.
3. States: verify populated, empty, loading, and error states are designed and
   reachable. Block the page's primary fetch in Playwright and confirm an
   actionable error state appears, not a blank void or a raw exception.
4. Responsive: render at 320, 768, and 1440 px. No horizontal page scroll, no
   overlapping or clipped controls.
5. Accessibility basics: one h1; interactive elements are real buttons or
   links with visible focus states; images carry alt text; form fields have
   labels.
6. Head: a specific title tag and meta description that match the declared
   purpose above.
7. Fix every defect at its root in the page's real source files and re-run the
   probe until clean. Defects in shared modules are in scope when this route
   exercises them.

## Definition of done

- [ ] Local load of /hacks: HTTP 200, zero console errors, zero unhandled
      failed requests (a third-party outage must land in a designed fallback,
      not a broken page).
- [ ] No dead interactive element on the page: no stub href="#", no button
      without a handler, no link to a missing path.
- [ ] Empty, loading, error, and populated states verified.
- [ ] 320 / 768 / 1440 px renders verified clean.
- [ ] Title and meta description present and specific.
- [ ] npm test passes; npm run check:rules -- --paths <touched files> exits 0.
- [ ] Production status from step 0 recorded in the report; if production
      needs a deploy to pick up a fix, the report says so (deploys stay
      owner-gated).

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

       git rm prompts/finish/swarm-100-route-hacks.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
