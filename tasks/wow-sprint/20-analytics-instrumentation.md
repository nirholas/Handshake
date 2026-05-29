# Task: Real analytics instrumentation + conversion funnel

You can't improve what you don't measure. Instrument the key user journeys with
real event tracking so the team can see the funnel and where holders/users drop.

## Anchor files
- Existing analytics: `src/analytics.js` (read it first — extend, don't replace). Confirm what provider/sink it targets (check `.env.example` for keys: PostHog/GA/Segment/custom `api/`).
- If events currently go nowhere real, wire them to a real sink: a provider already configured in env, or a real `api/` collector endpoint that persists to the DB (`api/_lib/db.js`). No console-only "analytics".

## What to instrument (real events, consistent naming)
1. **Acquisition** — landing view, CTA clicks on `home`, source/referrer capture.
2. **Activation** — wallet connect started/succeeded/failed, agent created, first embed generated.
3. **$three funnel** — token page view → buy clicked → quote shown → swap confirmed → success. This is the holder funnel; capture each step with the outcome.
4. **Engagement** — marketplace search/filter use, agent profile views, visualizer/dashboard opens.
5. **Errors** — client errors and failed API calls (the boundary failures), so reliability is visible.

## Requirements
- One typed `track(event, props)` helper in `src/analytics.js` with a documented event taxonomy (names + props) at the top of the file. Every call site uses it.
- Respect privacy/consent: no PII beyond what's necessary; honor any existing consent gate; truncate wallet addresses.
- Batch/queue events; never block the UI on a tracking call; fail silently at the boundary (analytics must never break the app).

## Constraints
- Real sink only — events must actually arrive somewhere queryable. Verify in the network tab / sink.
- No double-firing; no tracking in obvious dev/test loops.

## Definition of done
- `npm run dev`: performing each journey fires the documented events to a real sink (shown in network tab / provider).
- Event taxonomy documented in `src/analytics.js`. Zero console errors; no UI blocking.
- `npm run build` clean. Run the **completionist** subagent.
- Report: the event taxonomy, the sink used, and the funnel it now captures.
