<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/avatar</h1>

<p align="center"><strong>3D avatar viewer, creator iframe, and emotion + lipsync runtime — a drop-in replacement for hosted avatar SDKs.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/avatar"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/avatar?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/avatar"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/avatar?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/avatar?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/avatar?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#entry-points">Entry points</a> ·
  <a href="#react">React</a> ·
  <a href="#api">API</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/avatar` is the official three.ws avatar SDK. It ships a self-contained
> `<agent-3d>` web component with a built-in chat/voice loop, emotion morphs, and
> audio-driven viseme lipsync; a lightweight `<three-ws-viewer>` element for pure
> 3D previews; a programmatic `AvatarCreator` iframe modal that resolves to a GLB
> Blob; and first-class React bindings. It's for anyone replacing a winding-down
> hosted avatar SDK with self-hostable, web-standard parts.

## Install

```bash
npm install @three-ws/avatar three
```

`three` (`>=0.150.0`) is a required peer dependency. `react` (`>=18`) is an optional
peer dependency, needed only for the [`./react`](#react) entry point.

## Quick start

Importing the package registers the `<agent-3d>` custom element as a side effect.

```html
<script type="module">
  import '@three-ws/avatar';
</script>

<!-- Resolve a three.ws avatar by id… -->
<agent-3d avatar-id="0f25b676-e27b-4929-875c-4135fea0f635"></agent-3d>

<!-- …or point at a GLB directly -->
<agent-3d src="https://three.ws/avatars/michelle.glb"></agent-3d>

<!-- Add brain="free" and the avatar holds a real conversation — no API key,
     no backend, no per-token cost. Routed through three.ws's host-paid free
     tier (OpenRouter/Groq/NVIDIA, whichever is healthy). -->
<agent-3d
  src="https://three.ws/avatars/michelle.glb"
  brain="free"
  instructions="You are Maya, a friendly guide to this site."
></agent-3d>
```

Need only a 3D preview — no chat, no voice, no 3 MB runtime? Use the light viewer:

```html
<script type="module">
  import '@three-ws/avatar/viewer';
</script>

<three-ws-viewer
  src="https://three.ws/avatars/default.glb"
  alt="The three.ws default avatar"
  background="transparent"
  ar
></three-ws-viewer>
```

## Entry points

The package exposes focused subpath exports so you only ship what you use.

| Import | Provides |
|---|---|
| `@three-ws/avatar` | Registers `<agent-3d>` (the full runtime). |
| `@three-ws/avatar/agent` | `ensureAgent3D()` — lazy-load + register `<agent-3d>` on demand. |
| `@three-ws/avatar/viewer` | Registers `<three-ws-viewer>` (lightweight GLB preview element). |
| `@three-ws/avatar/creator` | `AvatarCreator` class + `saveBlob()` upload helper. |
| `@three-ws/avatar/react` | `<Avatar>`, `<AgentAvatar>`, `<AvatarCreator>`, `useAvatar()`. |
| `@three-ws/avatar/element` | Alias of the root entry, for code that imports the element explicitly. |
| `@three-ws/avatar/runtime/choreography.js` | Routine format + `RoutinePlayer`, `encodeRoutine`, `decodeRoutine`, `PRESET_ROUTINES`. Dependency-free. |
| `@three-ws/avatar/runtime/animation-slots.js` | Canonical animation `SLOTS`, `DEFAULT_ANIMATION_MAP`, `resolveHint()`, `resolveSlot()`. Dependency-free. |
| `@three-ws/avatar/style.css` | No-op stylesheet stub (the element injects its own styles). |

The two `runtime/*` entries carry no Three.js and no DOM, so an app driving its
own renderer can reuse the gesture vocabulary and the routine sequencer without
loading a second WebGL context.

### `<three-ws-viewer>`

A minimal viewer element: loads a GLB at `src`, frames it, and renders with
`OrbitControls` and real photographic HDRI image-based lighting (patch:
previously a procedural `RoomEnvironment`; now fetches a curated HDRI from
three.ws and falls back to the procedural room on a slow network or a
CSP-blocked embed). Supports `EXT_meshopt_compression` and
`KHR_draco_mesh_compression` GLBs transparently (both decoders are
lazy-loaded on first use).

| Attribute | Description |
|---|---|
| `src` | GLB URL to load. |
| `alt` | Accessibility label; also rendered as an on-canvas caption. Defaults to `"3D model viewer"` when unset. |
| `background` | CSS color, or `transparent` (default) for an alpha canvas. |
| `auto-rotate` | Opt-in boolean. Slowly spins the model when idle, which also signals it's interactive. Absent by default; ignored under `prefers-reduced-motion: reduce`. |
| `ar` | Opt-in boolean. Adds a "View in AR" button that opens `three.ws/api/ar` in a new tab (device-aware AR: Android Scene Viewer / iOS Quick Look / desktop viewer fallback). Absent by default. |

**Built-in states.** The viewer ships its own designed load lifecycle so the host
page never has to paper over a blank canvas:

- **Loading**: a spinner with a live byte-progress percent (an indeterminate
  spinner when the server omits `Content-Length`).
- **Error**: a card with a **Try again** button and a **Download GLB** fallback
  link, shown when the model fails to load.
- **Empty**: a placeholder prompt when no `src` is set.
- **Ready**: the model fades in, and a one-time "Drag to rotate" cue appears.

It dispatches a `progress` event (`detail: { url, loaded, total, percent }`,
where `percent` is `null` when the download size is unknown) while loading, a
`load` event (`detail: { url }`) on success, an `error` event
(`detail: { url, error }`) on failure, and an `ar-launch` event
(`detail: { src, launchUrl }`) when the AR button is activated.

**Accessibility.** The canvas is keyboard-focusable (`role="img"`, matching
`<model-viewer>`'s own convention) — Arrow keys orbit, `+`/`-`/PageUp/PageDown
zoom, and a visible focus ring appears on `:focus-visible`. Orbit damping is
disabled under `prefers-reduced-motion: reduce`.

**Performance.** On a detected low-power device (coarse pointer + ≤4 CPU cores
or ≤4GB `deviceMemory`) the viewer starts at pixel ratio 1 and skips MSAA and
the PMREM environment prefilter. Independently, if live frame time shows
sustained <~24fps for about 1.5s, pixel ratio is stepped down once at runtime.
Both are transparent — no attribute needed, and desktop behavior is unchanged.

### `<agent-3d>`

The full runtime element. Set `avatar-id` to resolve a server-hosted avatar, or
`src`/`body` for a direct GLB. Other attributes: `ios-src` (USDZ for iOS AR Quick Look)
and `kiosk` (hide the debug GUI). The element is configured through attributes,
so use `setAttribute()` (or plain HTML) rather than assigning properties.

Instance methods, grouped by what they drive:

| Method | Does |
|---|---|
| `say(text, opts?)` / `ask(text, opts?)` | Send a message through the brain and speak the reply. `ask` resolves when the reply is done. |
| `speak(text, opts?)` | Play a talking animation sized to `text`, without calling the brain. |
| `clearConversation()` | Drop the in-memory conversation history. |
| `playClip(name, { fade_ms?, userInitiated? })` | Play a clip with embed defaults (honors the clip's loop flag and `prefers-reduced-motion`). |
| `play(name, opts?)` / `wave(opts?)` / `playEmote(name, intensity?)` | Raw clip playback, the wave animation, and the emote chain (`cheer`, `flinch`, `celebrate`). |
| `lookAt(target)` | Aim the avatar's gaze. |
| `expressEmotion(trigger, weight?)` | One emotion stimulus: `celebration`, `concern`, `curiosity`, `empathy`, `patience`. |
| `setMood(valence, arousal, opts?)` | Sustained mood driving resting expression and posture. |
| `playRoutine(nameOrRoutine, opts?)` / `stopRoutine()` / `getRoutines()` | Named, replayable clip sequences. |
| `notify(message, { priority?, duration? })` | Slide into frame, speak, retreat. Queued. |
| `installSkill(uri)` / `uninstallSkill(name)` | Manage skills at runtime. |
| `setMode(mode)` / `setPosition(pos, offset?)` / `setSize(w, h)` | Layout controls. |
| `enableAvatarChat()` / `disableAvatarChat()` / `enableAvatarWalk()` / `disableAvatarWalk()` | Toggle the inline chat layout and the walk animation. |
| `pause()` / `resume()` / `destroy()` | Runtime lifecycle. |

Read-only accessors: `skills`, `memory`, `manifest`, `runtime`.

**Conversation (`brain`)** — with no `brain` attribute the avatar is a silent 3D
decoration. Set one to give it a voice:

| `brain` value | Behavior |
|---|---|
| *(unset)* | Silent — no chat, no LLM calls. |
| `free` | Zero-config free chat. Routed through three.ws's host-paid `/api/llm/anthropic` proxy, which resolves to whichever free tier is healthy (OpenRouter, Groq, or NVIDIA NIM). No API key, no backend code, no per-token cost to you. |
| any other model id (e.g. `claude-sonnet-4-6`) | Passed through as a literal model id on the same proxy — use your own Anthropic key via the three.ws dashboard for a paid Claude model. |

Pair `brain` with `instructions` (a system prompt string) and `memory` (`local`
by default) to give the agent a persona and durable facts — see the
[Personal AI site tutorial](https://three.ws/tutorials/personal-ai-site) for a
full worked example.

## Open the avatar creator

`AvatarCreator` opens a modal iframe pointing at the three.ws Avatar Studio (or an
Avaturn edit session), listens for the `export` postMessage from the trusted
origin, and resolves with a GLB `Blob`. `saveBlob()` then uploads it to a
three.ws-compatible backend via presigned R2 upload.

```js
import { AvatarCreator, saveBlob } from '@three-ws/avatar/creator';

const creator = new AvatarCreator({
  onExport: async (glbBlob) => {
    const avatar = await saveBlob(glbBlob, {
      bearerToken: process.env.THREE_WS_TOKEN, // scope: avatars:write
      name: 'My Avatar',
      visibility: 'public',
    });
    console.log('Saved:', avatar.id, avatar.url, avatar.slug);
  },
});

await creator.open();
```

Pass `avaturnSessionUrl` to re-open an existing avatar in edit mode. Call
`creator.close()` / `creator.dispose()` to tear the modal down.

## React

The `./react` entry is a client-only module (`'use client'`).

```jsx
import { Avatar, AgentAvatar, AvatarCreator, useAvatar } from '@three-ws/avatar/react';

function Profile({ id }) {
  const { avatar, loading, error } = useAvatar(id);

  if (loading) return <p>Loading avatar…</p>;
  if (error) return <p>Could not load avatar.</p>;

  return (
    <>
      {/* Pure-visual viewer */}
      <Avatar src={avatar.model_url} alt={avatar.name} background="transparent" />

      {/* Full runtime (lazy-loads the 3 MB monolith on mount) */}
      <AgentAvatar avatarId={id} kiosk />
    </>
  );
}
```

| Export | Signature |
|---|---|
| `<Avatar>` | `{ src, alt?, background?, style?, className?, onLoad?, onError? }` — wraps `<three-ws-viewer>`. |
| `<AgentAvatar>` | `{ avatarId?, src?, iosSrc?, kiosk?, style?, className? }` — wraps `<agent-3d>`, lazy-loaded. |
| `<AvatarCreator>` | `{ open, onExport?, onClose?, studioUrl?, sessionUrl? }` — declarative wrapper around the class. |
| `useAvatar(id, opts?)` | Returns `{ avatar, loading, error }`; fetches `/api/avatars/:id`, aborts on unmount. `opts.apiOrigin` overrides the host. |

## API

### `ensureAgent3D(): Promise<void>`

From `@three-ws/avatar/agent`. Lazily imports and registers the `<agent-3d>`
element, resolving once it's ready. Idempotent and cached. Importing the module
also kicks off the load eagerly in the browser.

### `saveBlob(blob, opts): Promise<{ id, url, slug }>`

From `@three-ws/avatar/creator`. Uploads a GLB `Blob` to a three.ws-compatible
backend: requests a presigned URL, PUTs the bytes to R2, then creates the avatar
record. Computes a SHA-256 checksum client-side.

| Option | Type | Notes |
|---|---|---|
| `bearerToken` | `string` | **Required.** Token with `avatars:write` scope. |
| `apiOrigin` | `string` | Defaults to `https://three.ws`. |
| `name` | `string` | Display name. |
| `description` | `string` | Optional. |
| `tags` | `string[]` | Optional. |
| `visibility` | `'public' \| 'unlisted' \| 'private'` | Defaults to `public`. |
| `source` | `string` | Provenance label recorded on the avatar. Defaults to `sdk`. |

## Examples

A runnable, build-free demo page (CDN load, `ensureAgent3D()`, one live avatar) lives in [`examples/`](./examples).

## Requirements

- Node `>=18` (for tooling; the runtime targets modern browsers).
- Peer dependency: `three` `>=0.150.0` (required), `react` `>=18` (optional, for `./react`).
- `saveBlob()` needs a bearer token with `avatars:write` scope and a three.ws-compatible API origin.

> **SSR note.** The root (`@three-ws/avatar`) and `./viewer` entries bundle the
> 3D runtime and touch `window` at module load — import them **client-side only**.
> In Next.js / SSR, use the `./react` entry (it lazy-loads the runtime in an
> effect, so it's server-safe), or dynamically `import()` the viewer in a client
> component.

## Related packages

- [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) — the on-chain manifest format these avatars resolve from.
- [`@three-ws/viewer-presets`](https://www.npmjs.com/package/@three-ws/viewer-presets) — tuned light rig, floor reflection, and bloom configs for your own viewer.
- [`@three-ws/avatar-cli`](https://www.npmjs.com/package/@three-ws/avatar-cli) — scaffold, validate, hash, and preview avatar manifests from your shell.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: proprietary, all rights reserved. See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
