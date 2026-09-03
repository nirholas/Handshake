# 17. Accessibility, 87 locales, mobile and PWA

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[05](home-05-connect-flow.md) to [08](home-08-voice-loop.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
ls public/locales | wc -l                                # the locale count to match
npm run i18n:lint
head -30 tests/e2e/a11y-top-pages.spec.js                # the existing axe gate and its rule sets
grep -n "priority" data/pages.json | head -3
npx playwright test tests/e2e/a11y-top-pages.spec.js 2>&1 | tail -10
```

## Why accessibility is load-bearing here specifically

A voice-controlled home is, for a lot of people, an assistive technology. Someone who cannot
easily reach a light switch is exactly the user for whom this product is not a convenience.
Shipping a home controller that a screen-reader user cannot operate would be a particular kind of
failure, and it is also the case where the 2D fallback from order 06 stops being a nicety.

## The accessibility bar

WCAG 2.1 AA, enforced by the existing axe gate (`wcag2a`, `wcag2aa`, `wcag21aa` rule sets, no
best-practice rules, so it stays a hard gate and not a taste argument). Add every home route to
that spec's page list.

Beyond what axe can see, and each verified by hand:

| Requirement | Verified by |
|---|---|
| The whole lane is operable by keyboard alone | walk connect, act, confirm, floorplan, disconnect with no mouse |
| Focus is visible at every step and never trapped | including inside the 3D canvas and the confirmation card |
| The confirmation card takes focus when it appears and announces itself | it is the safety control; a user must not be able to miss it |
| Screen reader announces state changes | a light turning on, a home going stale, a confirmation pending. Use a polite live region; the confirmation uses assertive. |
| The 3D scene has a complete non-visual equivalent | order 06's 2D fallback plus a semantic room and device list. A canvas is opaque to a screen reader, so the fallback is the accessible path, not a downgrade. |
| Nothing depends on colour alone | locked versus unlocked, on versus off, stale versus live all carry a shape or a label |
| Reduced motion respected | `prefers-reduced-motion` disables scene transitions and any animation |
| Target sizes | 44px minimum on touch for every control, including in the floorplan editor |
| Contrast | AA on every state, including the desaturated stale state, which is the one most likely to fail |

## Internationalisation

87 locales exist. Everything user-visible goes through the existing extraction path.

- `npm run i18n:extract` then `npm run i18n:translate`, then `npm run i18n:lint` clean.
- **Entity names, area names and scene names are never translated.** They are the user's own
  words. Make sure the extractor does not capture them and that no string concatenation puts a
  translated fragment inside a user-supplied name.
- Plurals and number formatting through the existing i18n mechanism, not string concatenation.
  "3 rooms" and "1 room" both come from the catalog.
- Temperature units follow the Home Assistant instance's own configuration, which it reports.
  Never assume Celsius and never guess from the locale: read what the house says.
- RTL: the connect flow, the manage view, the floorplan editor and the scene all work in an RTL
  locale. Test with a real RTL locale from `public/locales`, not with a CSS override.
- Voice (order 08): the language of the wake word and the ASR lane follows the existing
  `TALK_LANGUAGES` mechanism in `src/voice/talk-languages.js`. Do not add a second language store.

## Mobile

The phone is a primary surface here, not a secondary one. Someone standing in a doorway is on a
phone.

- 320px, 375px, 768px and 1440px all correct, on every state of orders 05, 06, 07.
- The 3D scene holds its frame budget on a mid-range phone or routes to the fallback automatically
  and says so.
- One-handed reach: the primary action on each screen is in the lower half.
- The confirmation card is unmissable on a small screen and cannot be dismissed by an accidental
  tap. It requires a deliberate action.
- Safe areas respected on notched devices.
- Installable as a PWA if the platform already has a manifest path; if it does not, say so and
  do not invent one for this lane alone.
- Wake-lock behaviour for a wall display: state the decision. A kitchen tablet showing the home
  scene should not sleep mid-use, and a phone should not be held awake by a background tab.

## Tasks

| # | Task |
|---|---|
| 1 | Add every home route to `tests/e2e/a11y-top-pages.spec.js` (or the lane's own axe spec) and fix every violation. |
| 2 | The keyboard walkthrough, the focus management on the confirmation card, and the live regions. |
| 3 | The semantic non-visual equivalent of the 3D scene. |
| 4 | Reduced motion, colour-independence, target sizes, contrast on the stale state. |
| 5 | Full i18n extraction and lint, with the never-translate rule for user data. |
| 6 | Temperature units from the instance. |
| 7 | RTL pass. |
| 8 | The four breakpoints on every state, plus the one-handed and safe-area work. |
| 9 | The wake-lock decision, implemented and documented. |

## Definition of done

- [ ] axe passes on every home route with the `wcag2a`, `wcag2aa`, `wcag21aa` rule sets. Paste the run.
- [ ] A recorded keyboard-only walkthrough of connect, act, guarded confirm, and disconnect.
- [ ] A screen-reader transcript (VoiceOver or NVDA) of: a light turning on, a home going stale, and a confirmation appearing. The confirmation must be announced assertively.
- [ ] The 2D fallback is operable by screen reader and can control the house. Recorded.
- [ ] `prefers-reduced-motion: reduce` disables scene animation. Screenshot the setting and the behaviour.
- [ ] Contrast checked on the stale and desaturated states specifically, with the measured ratios.
- [ ] `npm run i18n:lint` clean. Paste it.
- [ ] A user-supplied entity name is untouched in a non-English locale. Screenshot in two locales.
- [ ] A Fahrenheit-configured Home Assistant shows Fahrenheit regardless of browser locale. Screenshot both.
- [ ] An RTL locale renders connect, manage, scene and floorplan correctly. Four screenshots.
- [ ] All states at 320px, 375px, 768px, 1440px. The screenshot set.
- [ ] The confirmation card cannot be dismissed by a stray tap on a phone. Demonstrate.
- [ ] `npx playwright test tests/e2e/` passes with no new failures.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| No screen reader available in this environment | Use the platform's own tooling where possible and say exactly what you could and could not verify. Never claim a screen-reader pass you did not perform. |
| axe flags something inside the 3D canvas | A canvas is not accessible by nature; the fallback is the answer, and the canvas gets `aria-hidden` with the equivalent content adjacent. Do not suppress the rule. |
| The i18n extractor picks up entity names | Fix the call site so the user's data is passed as an interpolated value, never as part of a translatable string. |
| 87 locales seems like a lot of new strings | The pipeline handles it (`i18n:translate`). Your job is to make sure every string goes through it, not to translate by hand. |
| A phone cannot hold the frame budget | Route it to the fallback automatically, tell the user why in one sentence, and record the device class in your report. |

## Report format

1. The axe run.
2. The keyboard and screen-reader recordings and transcripts.
3. The reduced-motion and contrast evidence.
4. The i18n lint output and the two-locale entity-name screenshots.
5. The temperature-unit screenshots.
6. The RTL set and the four-breakpoint set.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-17-a11y-i18n-mobile.md

Never delete it on a partial.
