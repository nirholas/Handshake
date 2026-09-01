# EV-08: Event closeout: record what ran, count the souvenirs, recap, retire the pack

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/event/08-event-closeout.md`". Read
[00-CONTEXT.md](00-CONTEXT.md) and `CLAUDE.md` first.

Rewritten 2026-09-01 to its remainder. The original order's first task (freeze the leaderboard
standings before their one-week Redis TTL) can no longer be done: nobody ran it, the board key
`event:lb:three-first-meetup` carried `BOARD_TTL_S = 7d` from its last write
(`api/_lib/event-leaderboard-store.js`), so it expired no later than 2026-08-16 19:30 UTC, and
`app_settings` holds no event, standing, or leaderboard key (verified by a read-only query).
The standings are gone. Say so; do not reconstruct them.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Delete this file when the
   definition of done is verified and log the outcome in [PROGRESS.md](PROGRESS.md); any
   remainder gets a follow-up file or an OWNER-ACTIONS row in
   [../production-100/OWNER-ACTIONS.md](../production-100/OWNER-ACTIONS.md) first.
2. **No prize is ever paid by code.** Winner settlement is the owner's decision, and with the
   board gone it is a decision, not a lookup.
3. Hard rules: no mocks, explicit-path commits, no em-dash characters.
4. The log reads below have a deadline: Cloud Run keeps logs 30 days by default, so the
   multiplayer log lines from the 2026-08-09 window disappear around 2026-09-08. Run them
   first.

## Step 0: re-derive the state

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
curl -s https://three.ws/api/version                       # what is live now
curl -s https://three.ws/event.json | head -c 400           # the explicit no-event state
git show 5616ff9b8^:public/event.json                        # the window that ran: 2026-08-09 17:00 to 19:30 UTC
gcloud run revisions list --service three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --format='table(name,metadata.creationTimestamp)' | head -20
gcloud run revisions list --service hyperfy-world --region us-central1 --project aerial-vehicle-466722-p5 --format='table(name,metadata.creationTimestamp)' | head -20
```

If `gcloud` auth is dead, revive it in-session (`gcloud auth login --no-launch-browser` fed
through a fifo; the CLAUDE.md never-blocked table names this) before anything else. This
order is the one case where the cloud read is the deliverable, so route around a dead auth
by reviving it, not by skipping the read.

Decide which world the event happened in from the revision timestamps: (a) the event build
(`2bae5d8c2` or later, per the preflight entry in [PROGRESS.md](PROGRESS.md)) was serving
both the API and the multiplayer server before 2026-08-09 17:00 UTC, so the quests, drop,
and leaderboard were live for visitors; or (b) it was not, and visitors saw the pre-event
world. Both get an honest closeout.

## Tasks

1. **Count what was granted.** The souvenir grant logs one line per attendee in the
   multiplayer service (`souvenir laurel-meetup -> <account>`, format documented in
   `docs/event-souvenirs.md`). Read the window with
   `gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="hyperfy-world" textPayload:"souvenir laurel-meetup"' --freshness=30d --project aerial-vehicle-466722-p5`
   and record the distinct-account count. Read `/population` and event-job completions the
   same way if the lines exist. In world (b) the count is zero by construction; record that.
2. **Write the closeout entry** in [PROGRESS.md](PROGRESS.md): which world, the revision
   evidence, the grant count, the fact that the standings expired unexported and when, and
   the one-line lesson (the export must be a cron or a post-window hook, never a manual
   order). Add one OWNER-ACTIONS row: winners cannot be settled from the board; the owner
   decides whether to settle from the souvenir list, re-run the event, or close it out.
3. **Recap for the community, only if the event ran.** In world (a), one `data/changelog.json`
   entry in plain language (what happened, how many attended, what was dropped), tag
   `feature`. In world (b), no entry; a recap of an event nobody could join would be fake.
4. **Retire the pack.** Verify [02-play-polish-sweep.md](02-play-polish-sweep.md) and
   [06-photo-mode-share.md](06-photo-mode-share.md) against their deliverables (the
   retirement policy in [../README.md](../README.md)); run whichever still has agent-doable
   work, then delete them and this file. Delete the directory when nothing numbered is left
   and record the retirement in [../README.md](../README.md).

## Definition of done

- [ ] World (a) or (b) determined from revision timestamps, not from memory, and recorded.
- [ ] Souvenir grant count (distinct accounts) recorded with the exact log query used.
- [ ] PROGRESS.md closeout entry written; OWNER-ACTIONS row added.
- [ ] Changelog entry present in world (a) and absent in world (b).
- [ ] 02 and 06 either shipped and retired or rewritten to their remainder.
- [ ] `npm run check:rules -- --paths <files you touched>` exits 0.

## Never blocked

| Blocker | Resolution (act, do not ask) |
|---|---|
| `gcloud` auth dead | Revive it in-session per the CLAUDE.md playbook. If the Workspace reauth policy refuses non-interactively, write the exact commands into the PROGRESS entry, add an OWNER-ACTIONS row for the read, and finish tasks 2 through 4 with the facts you have. |
| Logs already rotated (after about 2026-09-08) | Record that the count is unrecoverable and why, with the retention math. That is a complete answer. |
| `app_settings` schema question | Read-only queries only; this order writes nothing to the database. |

## Report format

World determination with revision names and timestamps; the log query and its distinct
count; the PROGRESS entry text; the OWNER-ACTIONS row text; which of 02 and 06 were run,
retired, or rewritten; the commit SHAs. No trailing questions.
