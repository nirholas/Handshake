# Task 34 — Section Narration: Avatar Reads Sections of three.ws Pages

## Priority: MEDIUM

## Objective
Adapt the Chrome-extension narrator (task 09) for use inside three.ws itself: when walk mode is on, the companion avatar reads the section of the page currently in view, with the same speech-bubble + TTS treatment.

## Scope
- Module: `src/walk-companion-narrator.js`
- Use the same DOM section extraction as task 09 but tuned for three.ws marked-up content:
  - Honor `data-walk-narrate="<id>"` attribute on three.ws sections — authors mark what should be read
  - For unmarked pages, fall back to heading-based extraction
- Each marked section optionally carries `data-walk-script` with a custom script to be read (better copy than just innerText)
- IntersectionObserver triggers narration as sections come into view
- Avatar walks to the section's location on screen (companion canvas can move within bottom strip) before starting narration
- Skip narration on sections with `data-walk-narrate="skip"`
- Settings toggle in companion HUD: "Read sections aloud"

## Definition of Done
- Mark sections on `/features` with `data-walk-narrate` → avatar reads them as user scrolls
- Custom `data-walk-script` is used when provided
- Skip sections respected
- Toggle off mutes immediately
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real TTS, real DOM extraction. Wire end-to-end.
