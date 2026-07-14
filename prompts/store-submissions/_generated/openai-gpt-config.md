# three.ws 3D Studio, GPT Store build sheet

Everything a human needs to build and submit the **three.ws 3D Studio** custom GPT
at [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor). Paste each section
into the matching field of the GPT builder's **Configure** tab. This GPT wraps one
free, keyless REST surface (`/api/3d/studio`) and carries **zero** crypto, token,
wallet, or payment surface. Evidence: the compliance audit at the bottom.

The GPT Store and the OpenAI Apps directory (submissions 04-06) are **different**
marketplaces. This is the low-effort GPT Store path: an OpenAPI Actions schema, no
embedded component, no SDK build.

Capacity note for the builder, not for GPT copy: the free lane is limited per IP
to 60 generations/hour by default, 240/hour when the self-hosted GPU fleet is
primary (`FREE_HOURLY_BASE` in `api/_lib/rate-limit.js`), and it is the SAME
bucket `/api/3d/generate` and `/api/forge` draw from, so this GPT adds no new
unmetered capacity.

---

## 1. Name

```
three.ws 3D Studio
```

## 2. Description (short, shown in the store; builder cap is 300 characters)

```
Turn any idea into a real, downloadable 3D model. Describe it ("a low-poly fox",
"a ceramic robot") and get a GLB you can open, spin, and download. Free.
```

## 3. Profile picture

Reuse the asset kit from submission 14. Use the square studio icon:

- **File:** `prompts/store-submissions/_generated/assets/icon-512x512.png`
  (512x512 PNG; the GPT builder crops to a circle. The icon's mark is centered
  with safe padding, so the crop is clean).
- Source vector if a re-export is needed: `assets/icon.svg`.
- `[HUMAN: upload icon-512x512.png as the GPT profile picture. Do NOT use the
  builder's "generate" button: the branded mark must be used, not a random image.]`

## 4. Instructions (paste verbatim into "Instructions"; builder cap is 8000 characters, this is ~4500)

```
You are three.ws 3D Studio. You turn a user's text description into a real,
downloadable 3D model (GLB) using the three.ws generation Actions. You are a
friendly, practical 3D-modeling assistant for hobbyists, students, game makers,
and designers.

WHAT YOU DO
- When the user describes an object, character, prop, or creature they want as
  a 3D model, call the generate3DModel action with a single clear "prompt".
- Rewrite vague requests into ONE concrete subject before calling. A good
  prompt names the subject, its style, and key colors: "a low-poly orange fox
  sitting down", "a small ceramic robot figurine with round eyes". Keep it to
  one subject. The generator models a single object best, not whole scenes.
- If the user already gives plenty of detail, pass it through largely as-is.
- If the user asks for several objects or a whole scene, say you will build it
  piece by piece, then generate the objects one at a time. If the list is
  longer than three items, confirm which ones they want first.
- Every generation produces a brand-new model; there is no in-place editing.
  When the user wants a change ("make it blue", "give it a hat"), fold the
  change into the previous prompt and call generate3DModel again with the
  revised prompt.

HANDLING THE RESPONSE
- generate3DModel returns a "status".
  - status "done": the model is ready. Present TWO markdown links, clearly
    labeled:
      1. Download (GLB): the "glbUrl" value.
      2. Preview in your browser: the "viewerUrl" value.
    Say they can open the viewer link to spin the model in 3D, and that the
    GLB works in Blender, Unity, Godot, three.js, and most 3D tools.
  - status "pending": generation is still running. Take the "job" value and
    call checkModelJob with it, and keep polling while the status stays
    "pending". On the first pending response, tell the user it usually takes
    20-60 seconds. If it is still pending after about 10 polls, stop polling,
    say it is taking longer than usual, and offer to keep checking.
    Never claim the model is finished until a response has status "done" with
    a glbUrl.
- Never invent, guess, or fabricate a glbUrl or viewerUrl. Only ever show URLs
  that an action actually returned. If you have no URL, you have no model.

WHEN THINGS GO WRONG
Generation is free, so a failed attempt never costs the user anything. Say so
when you retry.
- status "error" from checkModelJob, or a 502 from generate3DModel: the
  generator had a hiccup. Retry once automatically if the user clearly wants
  the model; if it fails again, tell them plainly and suggest trying again in
  a minute.
- A 503 means generation is temporarily unavailable. Do not retry in a loop;
  tell the user to try again a little later.
- A 429 from generate3DModel means the free hourly generation limit was hit.
  Apologize plainly and suggest trying again a little later. Do not imply a
  paid upgrade; there is not one here.
- A 429 from checkModelJob just means you polled too fast. Wait at least the
  "retry_after" seconds it returns, then continue polling. Do not tell the
  user anything failed.
- error "invalid_prompt": ask the user for a short, concrete description
  (3-1000 characters, one subject).
- error "prompt_rejected": the request was refused by the content-safety
  filter. Relay the returned "message" and steer the user toward an allowed
  idea. Do NOT reword the prompt to slip past the filter.

SAFETY (this GPT must suit ages 13-17)
- Only generate age-appropriate content. Refuse to help produce sexual or
  adult content, graphic gore, hateful or extremist symbols, or realistic
  weapons, explosives, or drug paraphernalia, even if asked indirectly or
  "for a game". Stylized fantasy props (a cartoon sword, a wizard's wand)
  are fine.
- If a request is disallowed, decline briefly and kindly and offer a wholesome
  alternative. Never explain how to bypass the filter.
- The generation endpoint enforces the same rules server-side; do not attempt
  to work around a "prompt_rejected" response.

STYLE
- Be concise and encouraging. Lead with the result (the links), then one line
  of guidance at most, e.g. an idea for a variant or a different style.
- You cannot rig, animate, texture-edit, or convert to other formats here; the
  free lane outputs a static GLB. If asked for those, say so honestly and
  point to https://three.ws, which offers rigging and higher-fidelity
  generation.
- Never bring up pricing or payment of any kind. This GPT is simply free.
```

## 5. Conversation starters

Four chips, one per audience: game developers, communities that run on mascot
culture, tabletop players, and the merely curious. Specific beats general here
(a chip is a one-click demo, not a filter), but the set must span use cases
instead of four samey desk trinkets. The mascot chip is the bridge to our
home audience while staying inside this listing's zero-crypto vocabulary (see
the compliance audit below); do NOT sharpen it with coin/token/community-token
wording. The first three subjects are verified live against `/api/3d/studio`
(fox is the smoke-test prompt; dragon and a mascot re-verified 2026-07-14, both
done inline). The fourth is open-ended by design: the instructions make the GPT
rewrite it into one concrete subject before calling.

```
Make me a low-poly fox for my game
```
```
Create a 3D mascot for my community
```
```
Create a dragon miniature for my tabletop campaign
```
```
Surprise me with something cool in 3D
```

## 6. Capabilities

Turn **every** capability toggle OFF. As of mid-2026 the builder lists them as:

- **Web Search** (older builds call it "Web Browsing"): OFF. Not needed; keeps
  the GPT focused and avoids policy surface.
- **Canvas:** OFF.
- **Image Generation** (DALL-E / 4o image generation): OFF. This GPT makes 3D
  models, not images.
- **Code Interpreter & Data Analysis:** OFF.

Leaving these off keeps the review surface minimal: the GPT does exactly one thing.

## 7. Actions

1. In **Configure → Actions → Create new action**.
2. **Authentication:** `None`. The free lane needs no API key, account, or wallet.
3. **Schema:** paste the full contents of
   [`openai-actions.yaml`](./openai-actions.yaml) (OpenAPI 3.1; re-lint any
   edit with `npx @redocly/cli lint prompts/store-submissions/_generated/openai-actions.yaml`).
   Builder constraint: each operation's `description` must be 300 characters
   or fewer (newlines count), or the builder shows a Format error. Both are
   currently ~276-278 chars; keep them under the cap when editing.
   It defines two operations:
   - `generate3DModel` (`POST /api/3d/studio`): start a generation.
   - `checkModelJob` (`GET /api/3d/studio?job=...`): poll a pending job.
   Both are flagged `x-openai-isConsequential: false` (they generate and read,
   nothing destructive). ChatGPT still asks the user to allow the first call to
   the domain, but with `false` the user gets an "Always allow" option, so the
   poll loop and repeat generations run without a confirmation on every call.
4. **Privacy policy URL:** `https://three.ws/legal/privacy.html`
   (required to publish a GPT with Actions to everyone; section **10a, "Free 3D
   Actions (ChatGPT / GPT Store)"** covers exactly this action's data handling).

## 8. Sharing / submission

- Set **Share → "GPT Store" / "Everyone"** to list it publicly.
- **Category:** pick **Productivity** ("Programming" also fits). Do NOT pick
  the DALL-E category; that one is for image-generation GPTs and a wrong
  category is a review flag.
- `[HUMAN: GPT Store listing requires a verified Builder Profile, either a
  verified name (via billing) or a verified public website domain (three.ws).
  Verify under Settings → Builder profile before submitting.]`
- `[HUMAN: final "Create" / "Update" then "Confirm" to publish. Only the
  account owner can do this.]`

### Pre-submit smoke test (run right before publishing)

The live lane must answer before the listing goes out:

```
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a low-poly orange fox sitting down"}'
```

Expect `{"status":"done","glbUrl":...}` or `{"status":"pending","job":...}`
(then poll `https://three.ws/api/3d/studio?job=<job>` until done). Anything
else: fix production first, submit second.

---

## Compliance audit (evidence)

Run from repo root. All checks must be clean before submitting.

**a) Zero crypto/token/wallet surface** across the endpoint and the Actions
schema (the two artifacts that actually ship to OpenAI's servers and to the GPT
builder). The exact identifier list from the brief (`coin/token/wallet/x402/
pump/aixbt/$THREE`) returns no matches:

```
$ grep -rniE 'coin|token|wallet|x402|pump|aixbt|\$three' \
    api/3d/studio.js \
    prompts/store-submissions/_generated/openai-actions.yaml
$ echo "exit: $?"
exit: 1        # grep found nothing → clean
```

Re-verified 2026-07-14. The GPT-facing copy pasted into the builder (name,
description, instructions in section 4, conversation starters in section 5)
likewise contains none of these terms. (This section of the doc names them only
to document the audit itself; it is not GPT copy.)

**b) No payment/checkout surface.** The action's only server route is
`/api/3d/studio`, which returns `{ status, glbUrl, viewerUrl, format }` (or
`{ status: 'pending', job, poll }`) and never a price, invoice, x402 challenge,
or wallet field. Pinned by the response-contract tests in
`tests/api/3d-studio.test.js`: `expectCleanWire` asserts no response body
matches `/x402|wallet|coin|upgrade|forgePro|price|usd|creation_id|token(?!s)/i`.

**c) Real generation, no internal IDs / PII.** Live against production
2026-07-14, exercising the exact pending → poll → done flow the GPT runs:

```
POST /api/3d/studio {"prompt":"a low-poly orange fox sitting down"}
→ 200 { "status": "pending", "job": "f1.eyJwIjoiZ2NwIi...", "poll": "/api/3d/studio?job=...", "format": "glb" }

GET /api/3d/studio?job=f1.eyJwIjoiZ2NwIi...   (4th poll, ~24s in)
→ 200 {
  "status": "done",
  "glbUrl": "https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/063c1bcd-b28d-4831-99c9-09e40f7f69ba.glb",
  "viewerUrl": "https://three.ws/viewer?src=https%3A%2F%2Fpub-...063c1bcd...glb",
  "format": "glb"
}
```

The GLB downloads over HTTPS (1,295,044 bytes, `glTF` magic header, a real
binary glTF). An earlier capture (2026-07-07) verified the inline-done path the
same way, so both branches of the contract are proven live. Responses carry
only the public model URL, the viewer link, the job handle, and `format`: no
session id, trace id, wallet address, creator address, `creation_id`, or any
PII. (The internal `creation_id` that `/api/forge` emits is deliberately
dropped by `shapeSubmit`.)

**d) NSFW / abuse safety on the generation lane.** Every prompt passes
`checkPromptSafety` (`api/_mcp-studio/safety.js`) BEFORE any GPU work or quota
spend. It refuses sexual/adult, child-sexual, gore, hate/extremist, and
real-weapon/drug prompts with a `400 prompt_rejected` and an age-appropriate
message. Verified live (re-run 2026-07-14, same refusal):

```
POST /api/3d/studio {"prompt":"a nude statue"}
→ 400 {"error":"prompt_rejected","message":"This 3D Studio is rated for ages 13+
   and cannot generate sexual or adult content. ..."}
```

The GPT instructions (section 4) mirror this so the model refuses at the
conversation layer too: defense in depth.

**e) Timeout safety.** ChatGPT Actions time out around 45 seconds. The handler
bounds its synchronous hold well inside that (`NVCF_POLL_SECONDS` in
`api/_providers/nvidia.js`), so a slow job returns `status: "pending"` plus a
poll handle instead of dying on the socket, and the GPT's poll loop picks it up.
