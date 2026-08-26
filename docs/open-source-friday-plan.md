# Open Source Friday: application and stream plan

**Goal:** get three.ws booked on GitHub's Open Source Friday livestream (Twitch/github, Fridays 1:00 PM ET) with Andrea Griffiths (@AndreaGriffiths11 / @acolombiadev), who invited us to open the request issue on 2026-08-21.

**Program page:** https://github.com/githubevents/open-source-friday
**Criteria:** [admin/project-criteria.md](https://github.com/githubevents/open-source-friday/blob/main/admin/project-criteria.md)
**Request form:** https://github.com/githubevents/open-source-friday/issues/new?template=osf-guest-invite.yml
**Our request:** https://github.com/githubevents/open-source-friday/issues/254 (opened 2026-08-25)

---

## 1. Where we stand against the criteria

Verified against `gh repo view nirholas/three.ws` and the working tree, not from memory. Last re-checked 2026-08-25.

| Criterion | Status | Evidence |
|---|---|---|
| Code of conduct | PASS | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md), Contributor Covenant, detected by GitHub |
| Contributing guide | PASS | [CONTRIBUTING.md](../CONTRIBUTING.md), now opening with the community table and the 15-minute onboarding path |
| License | **PASS** | Relicensed to Apache-2.0 on 2026-08-21. Verbatim [LICENSE](../LICENSE), a [NOTICE](../NOTICE) covering vendored and derived code, and all 102 first-party manifests set to `"license": "Apache-2.0"`. |
| 100+ stars, hosted on GitHub | **PASS** | 104 stargazers, 26 forks as of 2026-08-25 (98 on 2026-08-21; the relicense closed the gap without a campaign) |
| Open to outside contributions | PASS | 11 contributors, issue and PR templates, CODEOWNERS, and six curated open issues (see below) |
| *Preferred:* community channel | **PASS** | Telegram community, X community, IBM Community group, GitHub Discussions (seeded 2026-08-25: [Welcome #122](https://github.com/nirholas/three.ws/discussions/122), [Show and tell #123](https://github.com/nirholas/three.ws/discussions/123), [Roadmap #124](https://github.com/nirholas/three.ws/discussions/124)), release channel. All five documented in [docs/community.md](community.md) and wired into the README, CONTRIBUTING, and the new-issue chooser. |
| *Preferred:* triage team / contributor onboarding | **PASS** | [docs/triage.md](triage.md) (labels, claiming, published response targets) and [docs/first-contribution.md](first-contribution.md) (clone to PR in 15 minutes, worked example) |
| Guest available Friday 1:00 PM ET | Owner to confirm | Pre-recording is allowed as an exception |
| Booked at least two weeks ahead | Plan for it | Earliest realistic slot: **2026-09-11** |

### License: done

Relicensed to **Apache-2.0** on 2026-08-21, which was the last hard failure against the criteria.

Before, the repo shipped a proprietary LICENSE ("All rights reserved... may not be used, copied, modified, distributed") while its own description said "Open-source 3D AI agent framework" and CONTRIBUTING.md told contributors their work was Apache-2.0. Three statements, no two of which agreed. A reviewer who opened LICENSE stopped there.

What landed:

- [LICENSE](../LICENSE) is now the verbatim Apache-2.0 text, byte-identical to the canonical copy apart from the copyright line, verified by diff against a reference copy in the dependency tree.
- [NOTICE](../NOTICE) records attribution for the vendored and derived code that keeps its own license: the forked avatar builder, the vendored three.js editor, the animation clip library, and the club assets. Every path in it was checked to exist.
- All **102** first-party `package.json` manifests moved from `"SEE LICENSE IN LICENSE"` to `"license": "Apache-2.0"`, each re-parsed as JSON before it was written. Vendored third-party trees were never in scope: the sweep only touched manifests carrying our own proprietary marker.
- The README License section now explains what the license actually permits instead of asserting the opposite.

Apache-2.0 over MIT for two reasons: CONTRIBUTING.md already promised it to every contributor to date, so this makes that promise true rather than changing the terms under them; and its explicit patent grant matters with on-chain contracts in the repo.

### The star gap: closed

On 2026-08-21 the repo sat at 98. The call was to treat that as noise rather than run a campaign, because a suspicious star curve reads worse to a reviewer than being two short. Four days and one relicense later it is 104, with no asks made. Every hard criterion in the table above now holds.

---

## 2. Pre-flight work

### Done on 2026-08-21

- **Community channels documented and wired.** [docs/community.md](community.md) lists all five rooms with guidance on which fits which question, plus the house rules. Linked from the README (new Community section, in the table of contents), CONTRIBUTING.md, and the GitHub new-issue chooser (`.github/ISSUE_TEMPLATE/config.yml`).
- **Contributor onboarding written.** [docs/first-contribution.md](first-contribution.md) goes clone to open PR in about 15 minutes, with a complete worked example: teaching the avatar retargeter a bone-naming convention, the test that proves it, and the two mistakes that cost a review round.
- **Triage documented.** [docs/triage.md](triage.md) publishes response targets (2 business days for a new issue or a first-time contributor's PR, 24 hours for a security advisory), what every label means, how to claim work, and how someone becomes a maintainer.
- **Six curated issues opened**, every one with a named file and a verification command:
  - [#110](https://github.com/nirholas/three.ws/issues/110) Rig: Apple / ARKit `_joint`-suffixed skeletons (verified: 0 of 10 joints map today)
  - [#111](https://github.com/nirholas/three.ws/issues/111) Rig: Kinect trailing-side bone names (verified: 0 of 10)
  - [#112](https://github.com/nirholas/three.ws/issues/112) Rig: Reallusion CC3/CC4 numbered spine (verified gap)
  - [#113](https://github.com/nirholas/three.ws/issues/113) Animation: bake a real `bow` clip (the repo's own tracked `known_issue`)
  - [#114](https://github.com/nirholas/three.ws/issues/114) Tests: drift guard between supported and documented rig conventions
  - [#115](https://github.com/nirholas/three.ws/issues/115) Rig: teach the retargeter any convention it does not know (open-ended, `help wanted`)
- **Labels added:** `area: rig`, `area: animation`, `area: docs`, `area: tests`, `triage`.
- **MMD rig support shipped**, so the worked example in the onboarding doc points at real merged code rather than a hypothetical. MikuMikuDance names every bone in Japanese and mapped zero joints before; the full PMX skeleton now maps (fingers and toes included), Rig Doctor fingerprints the convention on sight, and the IK and twist bones are deliberately left unmapped. 471 tests pass across the two affected suites.

### Still to do

1. **Pin the Welcome discussion.** The three seed threads are live ([#122](https://github.com/nirholas/three.ws/discussions/122), [#123](https://github.com/nirholas/three.ws/discussions/123), [#124](https://github.com/nirholas/three.ws/discussions/124)). GitHub exposes no API for pinning, so #122 needs one click from the Discussions tab.
2. **The README front door is better than its file size suggests.** 8,402 of its 11,372 lines are one inline STL model that GitHub renders as an interactive 3D viewer, so a reader on github.com sees a widget, not 8,000 lines of vertex data. The prose is about 3,000 lines. The first screen now carries the license and good-first-issue badges and a contributor CTA alongside the user one. What is still worth doing is a 10-second demo GIF above the fold, since the current hero is a video attachment that does not autoplay in every context.
3. **Record a 45-second demo clip** (prompt to rigged avatar to embedded on a page). Reusable: README, the issue body, and every amplification post. Per section 5, video and images are what move GitHub's own numbers.

---

## 3. The issue: exact field-by-field content (submitted as [#254](https://github.com/githubevents/open-source-friday/issues/254))

The form (`osf-guest-invite.yml`) auto-titles as `Open Source Friday - [PROJECT NAME] - [MM-DD-YYYY]`, labels `open-source-friday, open-source, twitch, pending`, and assigns @AndreaGriffiths11, @KevinCrosby, @marlenezw, @madebygps. A date is not required to submit: check "Not yet" and they send the booking link on approval.

**Title:** `Open Source Friday - three.ws - 09-11-2026`

**Name:** Nich (owner to confirm the name they want on air)

**GitHub Handle:** `@nirholas`

**Tell us about yourself:**
> I build three.ws, an open source framework for 3D AI agents on the web. Background is full-stack and real-time graphics; most of my work now sits at the seam between Three.js rendering and agent runtimes, which is a place where very little tooling existed until recently. I maintain the project day to day: triage, reviews, releases, and docs.

**Project Name:** `three.ws`

**Project Repo Link:** `github.com/nirholas/three.ws`

**Stream Date:** "Not yet" (unless the owner already booked at https://gh.io/osf-booking)

**Dates:** leave blank unless booked

**Twitter URL:** `@nichxbt`

**LinkedIn URL:** owner to supply, or leave blank

**Additional Information:**
> three.ws turns a text prompt into a rigged, animation-ready 3D avatar and lets you drop it into any website with a single web component tag. It is browser-native (Three.js, glTF/GLB, no plugin, no game engine), and it ships an MCP server so coding agents can create and control avatars directly.
>
> What I would like to show live:
> 1. Prompt to rigged avatar in about a minute, then the same avatar animated by our retargeting layer.
> 2. Embedding it on a blank HTML page with one `<agent-3d>` tag, and driving its mood and animation from page JavaScript.
> 3. The part I most want contributors on: universal rig support. Every humanoid GLB in the wild uses a different bone naming convention (Mixamo, VRM, Daz, MakeHuman, Unreal, MikuMikuDance, plain Blender, and a dozen more). We map them all to one canonical skeleton so a shared clip library retargets onto anything. Adding a convention is a genuinely self-contained first contribution: a mapping entry, a test, and a docs row. We keep a curated list of them open, each naming the file to change and the command that proves it worked, and I would like to do one live on the stream.
>
> Community: GitHub Discussions, a Telegram community, an X community, an IBM Community group, and a public changelog that ships to a Telegram channel on every release. Contributor onboarding and our triage process, including the response times we hold ourselves to, are documented at /docs/first-contribution and /docs/triage. Happy to pre-record if a Friday slot is tight, though live is preferred.

**Follow-up:** reply to Andrea's thread on X with the issue link once it is open. She asked for the issue; closing that loop publicly is the point.

---

## 4. Stream runsheet (45 to 60 min, live at 1:00 PM ET)

Demo early, code live, end with a concrete ask.

| Time | Segment | Notes |
|---|---|---|
| 0:00-0:05 | Intro, who I am, what three.ws is | One sentence, then get to pixels |
| 0:05-0:12 | Live demo: prompt to rigged avatar | Real generation, no pre-baked cache. Fallback GLB staged in case a worker is slow |
| 0:12-0:20 | Embed it: one tag on a blank page | Blank `index.html` in a live editor, add `<agent-3d>`, avatar appears, drive mood from the console |
| 0:20-0:28 | Under the hood: canonical skeleton and retargeting | The technical spine of the project, and the setup for the contribution ask |
| 0:28-0:42 | Live contribution: add a rig convention | Take [#110](https://github.com/nirholas/three.ws/issues/110) or [#111](https://github.com/nirholas/three.ws/issues/111) live: write the mapping, write the test, run `npx vitest run tests/glb-canonicalize.test.js`, open the PR on air |
| 0:42-0:50 | MCP server: an agent creating an avatar | Ties into the AI-agent audience the program has leaned toward in 2026 |
| 0:50-0:60 | How to contribute, good first issues, Q&A | End on the issue list, on screen, by number |

**Prep checklist:** clean clone on a second machine or a fresh worktree so the demo path is the one a viewer gets; workers warm; fallback GLB staged; browser zoom up for readability; no `.env` and no wallet UI on screen at any point.

**Downplay on stream:** the on-chain and payments surfaces. They are real and they are in the repo, but this audience is maintainers and contributors, and leading with crypto costs credibility with exactly the people we want opening PRs. If it comes up, one honest sentence: agents can hold a wallet and pay for their own compute, it is optional, here is where the code lives.

---

## 5. What GitHub's own account tells us about promotion

Analysis of 500 posts from @GitHubCommunity (`GitHubCommunity_tweets_2026-08-21.json`, scraped 2026-08-21). Engagement scored as likes + 3x retweets + replies.

**Media is the single biggest lever.**

| Format | Posts | Avg engagement | Median |
|---|---|---|---|
| Image | 73 | 31.0 | 13 |
| Link card | 30 | 27.4 | 12 |
| Video | 37 | 20.6 | 8 |
| Plain text | 360 | 10.5 | 8 |

An image post averages roughly 3x a plain text post on that account.

**Their own OSF announcements are underpowered, and that is our opening.**

141 posts mention Open Source Friday. 134 are the same bare template: `Open Source Friday with <Project>` plus a broadcast link, averaging 9.9 engagement. The 7 carrying an image or video average 16.4. The yearly trend on OSF posts is straight down: 16.6 (2023), 10.5 (2024), 8.7 (2025), 7.1 (2026 to date). Their whole account fell the same way, 27.5 in 2022 to 6.4 in 2026.

Read: **do not rely on GitHub's post to carry the episode.** Their announcement will be a plain link reaching a few hundred views. Reach has to come from our side, and our post is the one that should have the video.

**What actually broke out for them** (the top of the 500): projects with visible output. Game Off showcases with playable browser games (146 likes, 40 K views), Godot game roundups (126 likes, 73 K views), an open source game launch with a funding pool (90 likes, 23 RTs). Every one is "here is a thing you can look at, and then go run yourself". That is our shape exactly: a 3D avatar is a screenshot that explains itself. The second cluster is calls to action with a deadline (Git Merge CFP, conference booth applications, 30 to 48 engagement each).

**Post plan around the episode** (finals go in `docs/x-posts/`, one file each, per repo convention):

1. **T-14, application:** "We just applied to be on GitHub's Open Source Friday" plus the issue link and the 45-second demo clip. Reply into Andrea's thread rather than posting cold.
2. **T-7, the ask:** the `good first issue` list as a readable numbered image, CTA to claim one before the stream so we can review it live. This is the Git Merge CFP pattern, their best-performing non-showcase format.
3. **T-1, reminder:** short, image, exact time in ET plus one converted timezone, Twitch link.
4. **T-0, live:** quote-post GitHub's announcement the minute it goes up, so our audience gets it with a face on it instead of a bare link.
5. **T+1, replay:** the best 30 seconds of the stream as a standalone clip, plus the merged PR from the live contribution segment. The replay clip usually outperforms the live post because it is watchable on its own.

Every one carries an image or video. No plain-text posts in this sequence. Cross-post each to the [X community](https://x.com/i/communities/1923523161230078106) and the [Telegram community](https://t.me/three_ws_community); the IBM Community group gets the T-7 and T+1 posts only, since it is an enterprise audience and reminder spam reads badly there.

---

## 6. Timeline

Every hard criterion is met, stars included. What remains is one click, polish, and scheduling.

| Date | Milestone | Owner |
|---|---|---|
| 2026-08-21 | Community docs, triage, onboarding, six curated issues, labels, MMD rig support | Done |
| 2026-08-21 | Relicensed to Apache-2.0: LICENSE, NOTICE, 102 manifests, README, changelog | Done |
| 2026-08-25 | Three seed Discussions posted (#122, #123, #124) | Done |
| 2026-08-25 | Pin #122 | Owner, one click |
| 2026-08-26 | README front door trimmed, demo clip recorded | Agent |
| 2026-08-25 | **Issue submitted**: [open-source-friday#254](https://github.com/githubevents/open-source-friday/issues/254) | Done |
| 2026-08-25 | Reply to Andrea's X thread with the issue link (draft: [x-posts/osf-issue-reply.md](x-posts/osf-issue-reply.md)) | Owner |
| 2026-08-28+ | Booking link arrives on approval, book the slot | Owner |
| ~2026-09-11 | Stream (earliest date satisfying the two-week rule) | Owner |

---

## 7. Open questions for the owner

One, and it is genuinely yours to call:

**Fridays 1:00 PM ET: live or pre-recorded?** The form allows either. Live is better for the contributor-pipeline story, because the live-contribution segment is the whole pitch.

The license question that used to sit here is resolved: Apache-2.0, shipped 2026-08-21.
