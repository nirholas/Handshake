# Task 50 — Walk QA Pass: Completionist Audit & Launch Checklist

## Priority: URGENT (run last — gate before public launch)

## Objective
Perform a full system QA pass across every walk-related feature before announcing the walking avatar publicly. This task is a gate: nothing ships to the walk landing page or gets tweeted until every item below is checked off with real evidence.

## Scope

### Functional QA (check all with real browser, not just unit tests)

#### Core Walk Page
- [ ] `/walk?avatar=<id>` loads correct avatar (real API fetch confirmed in network tab)
- [ ] WASD + arrow keys work smoothly (task 11)
- [ ] Mobile joystick works on real iOS + real Android (task 12)
- [ ] All four camera modes switch smoothly (task 13)
- [ ] All 8 gestures play without T-pose flash (task 14)
- [ ] Speech bubbles track avatar off-screen correctly (task 15)
- [ ] Voice chat: full loop mic → STT → LLM → TTS → bubble (task 16)
- [ ] Multiplayer: two windows see each other (task 17)
- [ ] All 6 environments load + lighting correct (task 18)
- [ ] NPCs wander + react correctly (task 19)
- [ ] Screenshot + GIF record + share to X works (task 20)

#### Embed & SDK
- [ ] `/walk-embed?avatar=<id>&controls=joystick` loads in iframe with no X-Frame-Options block (task 03)
- [ ] walk-embed-sdk.js script tag embeds floating avatar on a blank page (task 04)
- [ ] postMessage events all fire correctly in host window (task 48)
- [ ] Inbound commands execute within 100ms (task 48)
- [ ] Embed snippet generator `/embed/walk` produces copy-pasteable correct code (task 44)

#### Chrome Extension
- [ ] Extension installs from `dist/extension/` without warnings (task 05)
- [ ] Avatar appears on google.com after toggle (task 06)
- [ ] Popup avatar picker shows real avatars from API (task 07)
- [ ] Settings page persists and syncs (task 08)
- [ ] Page narration reads section text via real TTS (task 09)

#### Site-wide Integration
- [ ] Homepage hero avatar animates within 3s on 4G (task 02)
- [ ] Agent detail page shows walking preview inline (task 23)
- [ ] Agent embed `mode=walking` works cross-origin (task 24)
- [ ] Dashboard topbar avatar idles and reacts to notifications (task 27)
- [ ] Profile page hero stage interactive (task 28)

#### Walk Companion (site-wide mode)
- [ ] Walk companion appears on every page when enabled (task 31)
- [ ] Survives page navigation with state continuity (task 31 + 32)
- [ ] Page section narration fires on features page (task 34)

#### Backend & Analytics
- [ ] Session persistence: close + reopen `/walk` resumes (task 38)
- [ ] Leaderboard shows real data, correct sort (task 39)
- [ ] Analytics dashboard shows real embed session data (task 40)
- [ ] Programmatic API control works via curl (task 47)

#### Performance
- [ ] 60 FPS on iPhone 12 in gallery environment (task 41)
- [ ] Walk page installs as PWA on Android (task 42)
- [ ] OG image unfurls correctly in Twitter card validator (task 45)
- [ ] Walk landing page Lighthouse ≥ 90 Performance + SEO (task 46)

### Pre-Launch Checks
- [ ] `git diff` reviewed — no TODOs, no commented-out code, no stubs
- [ ] All console errors from any walk-related page resolved
- [ ] `npm test` passes
- [ ] `vercel --prod --dry-run` succeeds with no route conflicts
- [ ] Privacy policy covers extension data usage (task 10)
- [ ] Analytics opt-out mechanism exists and works
- [ ] Rate limits on `/api/walk/control` tested and enforced
- [ ] No hardcoded secrets in any extension or embed file

### Launch Sequence (execute in order)
1. Merge all walk tasks to `main`
2. Push to both remotes (`git push threeD main && git push threews main`)
3. Verify Vercel deploy preview passes
4. Promote to production
5. Submit Chrome extension to Web Store
6. Tweet launch thread from @threews

## Definition of Done
Every checkbox above is checked off with real evidence. A completionist run of each task's "Definition of Done" must pass. No partial credit — this is the launch gate.

## Rules
Complete 100%. No stubs. No fake data. This is the QA gate before public launch. Do not mark this task done until every checkbox is genuinely passing in production.
