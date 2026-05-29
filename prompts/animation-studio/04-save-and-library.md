# Task 4 — Save animations to account + "My animations" library in the editor

> Read `prompts/animation-studio/00-README.md` first. Follow `CLAUDE.md`. No mocks, real APIs,
> wire 100%, design every state, verify in a real browser.
>
> **Depends on Task 2** (timeline + `bake()`/`serializeClip()`/`captureThumbnail()` accessors and
> the editing-document shape) and **Task 3** (`/api/animations` CRUD + request/response shapes).
> Read both tasks' handoff notes before starting.

You are connecting the in-browser animation editor to the user's account: save, load, manage, and
re-edit animations. This is what makes the studio a real tool instead of a one-shot exporter.

## Outcome

On `/pose`, a signed-in user can:
1. **Save** the current animation to their account (name, description, tags, visibility, linked
   avatar, thumbnail) via `POST /api/animations/clips`.
2. Open a **"My animations"** library (drawer/modal) listing their saved clips with thumbnails,
   open one back into the editor to continue editing, **update** it (`PATCH`), or **delete** it.
3. See proper auth handling: a signed-out user who tries to save is prompted to sign in, then
   returns to their work intact.

## What to build

### 1. Save flow
- A **"Save"** button in the toolbar. On click:
  - If not signed in → show a sign-in prompt. Use the existing auth/session mechanism the rest of
    the app uses (session cookie via `credentials: 'include'`; check how other authed pages detect
    sign-in — search for the session/me endpoint and the `authenticate-wallet` flow). Do **not**
    invent a new auth path. Preserve the in-progress editing document across sign-in (e.g. keep it
    in memory / sessionStorage and restore on return).
  - If signed in → open a **save dialog**: name (required), description, tags, visibility
    (private/unlisted/public), and the linked avatar (default to the currently loaded avatar's id
    when one is loaded; otherwise none/mannequin).
- On submit: call `serializeClip()` (Task 2) for the `clip` payload, `captureThumbnail()` for the
  thumbnail, and POST to `/api/animations/clips` with the metadata. Upload the thumbnail using the
  same mechanism mocap/avatars use for thumbnails (check `thumbnail_key` handling in
  [api/mocap/clips.js](../../api/mocap/clips.js) / the avatars upload path) — real upload, not a
  placeholder.
- After save: switch the editor into "editing saved clip" state (store the returned id), so
  subsequent saves **PATCH** the existing clip and offer "Save as copy" to create a new one.
- Loading + success + error states on the save action (disable button while in flight, real
  spinner, surfaced API errors).

### 2. "My animations" library
- A button opening a drawer/modal that fetches `GET /api/animations/clips` (own clips; offer a
  tab/toggle for public/community clips via `include_public=true`).
- Render each clip as a card: thumbnail, name, duration, visibility badge, tags, updated date.
  Actions per card: **Open** (loads the clip's keyframes back into the editor — see below),
  **Rename/edit metadata** (PATCH), **Delete** (soft delete with confirm), **Export**, and (stub
  the hook for) **Sell** which Task 6 will fully wire.
- States: loading (skeletons), empty ("You haven't saved any animations yet — create one and press
  Save" with a clear CTA), error (retry).

### 3. Re-open a saved clip into the editor
- Opening a saved clip must reconstruct the **editing document** (keyframes/duration/fps/loop), not
  just play a baked clip. Two paths — pick the one consistent with how Task 2 stored things:
  - If Task 2 persists the keyframe document (preferred), save that alongside the baked `clip` (add
    it to the create payload as part of `clip` metadata or a sibling field) so it can be restored
    losslessly for editing.
  - Otherwise, reconstruct an editable keyframe document from the baked clip's tracks (sample each
    track at its keyframe times back into per-bone pose snapshots).
  Coordinate with Task 2's document shape; if you need to extend the saved payload to make
  re-editing lossless, do it and update Task 3's create handler/validation accordingly (keep it
  backward compatible).
- After opening, the correct avatar/mannequin should be loaded (use the clip's `avatar_id`); if the
  avatar can't be loaded (deleted/not owned), fall back to the mannequin with a clear notice.

### 4. UX + accessibility
- Match existing design tokens. Hover/active/focus states + ARIA on every control. Keyboard:
  `Ctrl/Cmd+S` to save. Confirm-before-delete. Toasts/inline status for save/update/delete results.
- Optimistic UI is fine but must reconcile with the server response; never show a fake success.

## Definition of done
- A signed-in user saves an animation; it appears in "My animations" with a real thumbnail; the row
  exists in `animation_clips` (verify via the API/DB). Re-saving PATCHes; "Save as copy" creates a
  new clip.
- Opening a saved clip restores an **editable** animation (keyframes intact) on the right rig, then
  plays correctly.
- Signed-out save prompts sign-in and restores the in-progress work afterward.
- Rename/edit-metadata and delete work and respect ownership (verify a second account can't see
  private clips).
- All states designed; no console errors; network tab shows real `/api/animations` calls.
- `npm test` green. Run `completionist`; fix all findings.
- Handoff note: confirm the saved payload shape (esp. how the editable keyframe document is stored)
  for Task 5 (playback) and Task 6 (selling).

Do not implement payments/pricing here — leave the "Sell" affordance as a clearly-labeled hook for
Task 6. Do not push unless the user explicitly approves (then both remotes per CLAUDE.md).
