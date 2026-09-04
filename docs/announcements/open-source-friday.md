# Announcement pack: approved for Open Source Friday

**Surface:** [`/rig-doctor`](https://three.ws/rig-doctor) · **Ledger key:** `/rig-doctor` · **Stage:** drafted
· **Approved:** 2026-09-04 ([open-source-friday#254](https://github.com/githubevents/open-source-friday/issues/254) carries the `approved` label)
· **Announced externally:** never

Written against [the announcement voice](../announce-voice.md). This is the beat the
[stream plan](../open-source-friday-plan.md) does not have: its sequence runs T-14 application,
T-7 ask, T-1 reminder, T-0 live, T+1 replay, all anchored to a stream date that is not booked yet.
Approval is its own news and it is public the moment the label lands, so this post fills the gap
between the application post and the date post without spending either.

It deliberately is not a "we got approved" brag. Section 5 of the plan measured GitHub's own OSF
posts at 7.1 average engagement and falling, and found their best-performing non-showcase format
is a call to action with a deadline. So the approval is the reason, and the ask is the post: claim
a first issue now and it gets merged on air.

---

## The claim, and where it is checked

> Rig Doctor recognises 11 rig conventions. Teaching it a 12th is an open first issue, and it
> gets merged live on the stream.

| Part of the claim | Where it is real |
|---|---|
| Approved for Open Source Friday | The `approved` label on [issue #254](https://github.com/githubevents/open-source-friday/issues/254) |
| 11 rig conventions | On screen in the captured frame, from `CONVENTIONS` in [`src/rig-report.js`](../../src/rig-report.js). This is the fingerprint list, which is a narrower thing than the 19 name-variant families [`src/glb-canonicalize.js`](../../src/glb-canonicalize.js) can map. The post cites the on-screen number, per voice rule 3. |
| Teaching it a 12th is an open first issue | [#110](https://github.com/nirholas/three.ws/issues/110) (Apple / ARKit `_joint`), [#111](https://github.com/nirholas/three.ws/issues/111) (Kinect trailing-side), [#112](https://github.com/nirholas/three.ws/issues/112) (Reallusion numbered spine), all open and labelled `good first issue`, each naming its file and verification command |
| We merge it live | The owner is the reviewer on this repo, so a PR opened on stream can be reviewed and merged on stream. This is section 4 of the runsheet. |

The 0-of-10-joints framing belongs to #110 and #111 only. #112 is a two-joint spine gap on an
otherwise-mapped skeleton, so do not describe it as a convention that maps nothing.

## Media

Captured from the live route by `npm run announce:media`. Provenance (route, commit, time, sha256)
is in [`public/announce/media-manifest.json`](../../public/announce/media-manifest.json).

| Shot | File | Notes |
|---|---|---|
| `rig-doctor-hero` | `/announce/img/rig-doctor-hero.webp` | 1800x1013. The headline asks the question the post answers, and the stat bar carries the 11 the post cites. |

**Alt text, required on the post:**

> three.ws Rig Doctor: drop in any humanoid GLB and it names the skeleton convention, then lists
> joint by joint which bones will animate and which will not move.

## The post

The bytes that ship are [`open-source-friday.post.txt`](./open-source-friday.post.txt), 175
weighted characters, inside the 100 to 179 band that measures 3.0x on the archive.

## Do not

- **Do not name a stream date.** None is booked. The date is a separate post, and it is the one
  that carries the Twitch link and the time in ET.
- **Do not tag @github or the program maintainers.** They have not scheduled us yet, and the
  plan's read is that their announcement is weak anyway. Reach comes from our side.
- **Do not claim a convention count above 11 in the post.** The frame says 11. A number the image
  does not support fails voice rule 3 even when a source file agrees with it.

## After it is posted

The next beat is the date, which needs the booking at https://gh.io/osf-booking and a reply on
[#254](https://github.com/githubevents/open-source-friday/issues/254) saying which Friday was
taken. Then the plan's T-7, T-1, T-0 and T+1 posts run as written.
