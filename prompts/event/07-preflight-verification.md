# 07 · Event-eve preflight: prove everything works, then stage the ship

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/event/07-preflight-verification.md`. Read [00-CONTEXT.md](00-CONTEXT.md) first. Run this LAST, after every other order that is going to land has landed.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind. Two gates apply here and only here: `git push` and the production deploy itself need the owner's go (unless the owner's current instruction is itself that approval). EVERYTHING up to those two commands is yours to finish: fix what the sweeps find, commit it, and stage the ship so each gate is one command.

## Step 0 · Re-derive the current state

```bash
git log --oneline -15
git status --short
cat public/event.json
curl -s https://three.ws/api/version
```

Note which event orders landed (PROGRESS.md) and what is still uncommitted in the shared worktree (do not sweep other agents' files into your commits).

## The sweep, in order

Each stage: run, fix every failure you can root-cause, rerun until green. A failure in code you did not touch still blocks the event; fix it, do not mask it.

1. **Unit + integration:** `npm test` (never piped through `tail`; the vitest stage gates Playwright).
2. **Repo gates:** `npm run gate`, `npm run audit:docs`, `npm run audit:links`.
3. **Local walkthrough:** `npm run dev:walk-all`, then in a real browser the full player journey in the $THREE world: lobby, avatar create, enter, move, chat, emote, store, bank, wheel, jobs board (including any event jobs from order 04), friends, countdown surfaces (01), photo mode (06) if landed. Desktop and 375px. Zero console errors.
4. **Production sweep, unauthenticated:** `npm run audit:web`.
5. **Production sweep, authenticated:** `npm run audit:web:login` (the QA account is `AUDIT_EMAIL`/`AUDIT_PASSWORD` in `.env`).
6. **Production game infra:** confirm the multiplayer host answers (the `game-server` meta in [pages/play.html](../../pages/play.html) names it; a websocket handshake or its health endpoint is proof), and `curl -s https://three.ws/api/healthz`. If anything is degraded, run the gcp-triage skill flow and fix what it allows.
7. **Event config sanity:** `public/event.json` times are the owner-confirmed window, in UTC, start before end, and the live site will serve the NEW config only after deploy: note that explicitly in the report so nobody expects the banner before the ship.
8. **Deploy preflight:** run the `deploy-preflight` subagent. Resolve everything it flags.
9. **Stage the ship:** clean deploy worktree per the CLAUDE.md runbook steps 0 and 1, `npm run build:gcp` green, then STOP. Report the exact two commands the owner runs (or run them if the owner's instruction already granted the ship).

## Definition of done

- [ ] Every stage above green, with the actual command output quoted (trimmed) in the report; no stage skipped silently. If a stage cannot run here (e.g. no browser), say so and what you did instead.
- [ ] Every fix you made committed with explicit paths and honest messages; `git status` shows none of YOUR work uncommitted.
- [ ] The ship is one owner command per gate, and the report says exactly which.
- [ ] PROGRESS.md appended with the go/no-go verdict.

## Never blocked

| Blocker | Resolution |
|---|---|
| A test fails in a subsystem another agent has mid-edit | Root-cause it. If their uncommitted diff is the cause, report the file + failure precisely as in-flight, verify the committed baseline passes (`git stash` is forbidden on a shared tree; test in a clean worktree instead), and continue. |
| Disk full during worktree prep | `npm run clean:worktrees -- --apply` (the runbook's step 0 exists because of this exact failure). |
| gcloud auth or PATH problems | Both are known and solved in the agent memory/runbooks: `export PATH="$HOME/google-cloud-sdk/bin:$PATH"`; reauth is drivable non-interactively. |
| Production log access | `gcloud logging read` recipes are in CLAUDE.md's self-unblock table. |
| An audit finds a defect owned by an unrun event order | Fix it if small; otherwise it goes in the report as a named, sized residual with its owner. Never a vague "some issues remain". |

## Report format

Go/no-go verdict first. Then per stage: command, outcome, fixes made. Then the ship: the staged state and the exact owner commands. Then residuals, each named and sized.
