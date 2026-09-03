# 15. Privacy, retention, export and deletion

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[01](home-01-connection-store.md) to [08](home-08-voice-loop.md) must have landed, because this
order is an inventory of what they created.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
ls api/_lib/migrations | grep -i home
grep -rn "logHomeAction\|logAudit" api/_lib/home/ api/home/ --include=*.js | wc -l
grep -rn "console.log\|log(" api/_lib/home/ --include=*.js | head -20   # what reaches the logs
grep -rn "retention\|deleteUser\|export" api/ --include=*.js -l | grep -iE "account|user|gdpr|privacy" | head
```

That last grep matters: if the platform already has an account-deletion or data-export path, this
lane must join it rather than build a parallel one. Find it before you write anything.

## The inventory (build it first, it is the deliverable)

Enumerate every piece of data this lane creates, where it lives, why it exists, and how long it
stays. Publish it as a table in `docs/home-privacy.md`. Nothing may be missing; an
undocumented data class is the finding.

| Data | Table or store | Why it exists | Retention | Deleted by |
|---|---|---|---|---|
| Home access token | `home_connections.access_token_enc` | to reach the house | until revoked; scrubbed to `''` on revoke | revoke, account deletion |
| Base URL | `home_connections.base_url` | to reach the house | same | same |
| Entity and area names | in-memory graph only | to render and to reason | **never persisted** | n/a |
| Entity states | in-memory graph only | to render | **never persisted** | n/a |
| Room layout | `home_layouts.layout` | the user authored it | until deleted | user, account deletion |
| Standing allowances | `home_entity_grants` | the user granted them | until revoked or expired | user, member removal, account deletion |
| Action log | `home_action_log` | "what did my agent do in my house" | **decide and justify below** | retention job, account deletion |
| Confirmations | `home_confirmations` | the safety gate | 90 s TTL, then purged | retention job |
| Voice audio | nowhere | n/a | **never stored** | n/a |
| Voice transcripts | conversation state only | the turn | cleared with the conversation | user |
| Membership | `home_members` | roles | until removed | user, account deletion |

**"Entity states are never persisted" is a promise, and it is the most important line in the
table.** A log of every time a light went on in someone's bedroom is an occupancy record. The
in-memory graph is a cache that dies with the instance, and it must stay that way. If any order
introduced a persisted state history, find it and remove it, or justify it explicitly with a
retention period and a user-facing disclosure.

## The action log retention decision

`home_action_log` is the one genuinely difficult call. It is the audit trail the enterprise case
needs and it is also a behavioural record of a household.

Decide, justify in the doc, and implement:

- A default retention (90 days is the recommendation: long enough for "what happened last month",
  short enough not to be a surveillance archive).
- A user-visible control to shorten it, and for the enterprise case, an admin control to extend it
  with a stated reason.
- A purge job (a cron in `vercel.json`, synced by `scripts/create-gcp-scheduler.mjs`), not a
  promise.

## Logging hygiene

Home data reaching application logs is a leak with a long tail, because logs go to a different
system with different retention and different access.

- No entity name, area name, scene name, base URL or token in any log line. `api/_lib/scrub-secrets.js`
  exists; read it and use it.
- Log entity **ids** where you must correlate, never friendly names. An id is opaque enough; a
  name is "Sarah's Bedroom Camera".
- Error messages returned to the user may name an entity (they need to). Error messages sent to
  logs and alerts must not.
- Audit the actual log output, not the code: run the lane and read what came out.

## Export and deletion

- **Export**: a user can download everything this lane holds about them, in JSON, through the
  platform's existing export path if one exists. It must include every row in the inventory.
- **Deletion**: deleting an account removes every row. Prove it with a per-table count before and
  after, over a real account with data in every table.
- **Deleting one home** removes its layout, grants, members, confirmations and action log, and
  scrubs its credential. Cascades handle most of it; assert them rather than trusting them.
- Deletion must be idempotent and must not orphan rows in any table added by this campaign.

## Disclosure

Write the user-facing text, not just the internal doc:

- On the connect screen (order 05), a plain sentence about what the token can do and what we
  store. Not a link to a policy, a sentence in front of them.
- On the voice opt-in (order 08), what is processed locally and what leaves the device.
- In `docs/home-privacy.md`, the whole inventory, for the reader who wants detail.
- If the platform has a privacy policy page, this lane's data classes must appear in it. Find it
  and update it, or state plainly that none exists.

## Tasks

| # | Task |
|---|---|
| 1 | Build the inventory by reading the migrations and the code, not by copying the table above. Reconcile any difference and say what you found. |
| 2 | `docs/home-privacy.md`, linked from `docs/start-here.md` and `docs/smart-home.md`. |
| 3 | The retention decision, the user control, and the purge cron. |
| 4 | The logging audit and every fix it produces. |
| 5 | Export and deletion, joined to the platform's existing paths. |
| 6 | The user-facing disclosure copy on both surfaces. |
| 7 | Tests: deletion completeness, purge correctness, and a log-scrubbing assertion. |

## Definition of done

- [ ] The inventory in `docs/home-privacy.md` matches the schema exactly. Prove it by listing every table created by this campaign and showing each appears in the table.
- [ ] No persisted entity-state history exists anywhere in the lane. Prove it with the schema listing.
- [ ] Account deletion over a real account with rows in every table leaves zero rows. Paste per-table counts before and after.
- [ ] Deleting one home leaves the user's other homes untouched, and removes all of that home's rows. Counts before and after.
- [ ] Export returns every inventory row for a real account. Paste the JSON keys.
- [ ] The purge job deletes action-log rows past retention and nothing else. Run it against seeded old and new rows and paste the counts.
- [ ] The log audit: run a full connect, act, guarded-refusal and confirm cycle, then grep the captured logs for the base URL, the token, and three entity friendly names. Zero hits, pasted.
- [ ] The disclosure copy is on both surfaces, screenshotted.
- [ ] `npm run check:cron-drift` and `npm run check:claude` pass if a cron was added.
- [ ] `npm run audit:docs` clean, `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| No platform export or deletion path exists | Then this lane builds its own, scoped to home data, and your report names the gap so the platform-wide one can be built later. Do not skip it. |
| The action log retention decision feels like a product call | Make it (90 days), implement the controls, and write the justification. A shipped default with a control beats an unanswered question. |
| Grep finds entity names in logs from an earlier order | That is this order's job to fix. Fix it there, add the assertion here. |
| Someone proposes storing state history "for analytics" or "for the agent's memory" | Refuse by default. If a genuine product need appears, it needs its own explicit opt-in, its own retention, and its own disclosure, and it is not part of this campaign. |
| Legal wording feels out of scope | The plain-language sentences are in scope and are what users actually read. Policy language is the owner's; write the sentences and flag the policy page in your report. |

## Report format

1. The reconciled inventory and any difference from the table above.
2. The deletion and per-home deletion counts.
3. The export key listing.
4. The purge run counts.
5. The log-grep zero-hit proof.
6. The disclosure screenshots.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-15-privacy-retention.md

Never delete it on a partial.
