# Avatar Artifact: the standalone viewer

[three.ws/avatar-artifact](https://three.ws/avatar-artifact) is one page that renders one avatar and nothing else. No app shell, no sign-in, no navigation to get lost in: a URL you can paste into an `<iframe>` on any site, or send to someone who has never heard of three.ws, and it renders a live 3D avatar in their browser.

It is deliberately the smallest viewer we ship. [The full 3D viewer](./viewer.md) is the engine behind `/app` and every `<agent-3d>` embed, with camera rigs, material editing and a clip panel. This page has one job: show the artifact, beautifully, from a link.

---

## The three modes

| URL | What renders |
| --- | --- |
| `/avatar-artifact` | The house portrait: a procedural figure that follows your cursor. The page's own identity, and what a bare link shows. |
| `/avatar-artifact?agent=<uuid>` | That agent's avatar, resolved live from `GET /api/agents/<uuid>`. |
| `/avatar-artifact?model=<glb url>` | Any GLB served from an allowed host. No agent, no persona, just the model. |

Passing both `agent` and `model` is an error, the same rule [the Claude artifact endpoint](../specs/CLAUDE_ARTIFACT.md) applies. The page says so and offers a way out rather than guessing.

### Viewing an agent

```
https://three.ws/avatar-artifact?agent=27a0f649-3b59-4552-bb0b-faf616ac448b
```

The page fetches the agent's public record, reads `avatar_model_url`, and renders it. The agent's name becomes the page heading and the document title, and an **Open profile** link appears next to the controls so the viewer is never a dead end.

Only avatars whose visibility is `public` or `unlisted` carry a model URL in the public API. An agent whose avatar is private renders a designed message saying so and links to the profile, which stays public.

### Viewing a raw model

```
https://three.ws/avatar-artifact?model=https://three.ws/avatars/michelle.glb
```

The model URL must be `https:` on one of these hosts, or same-origin:

- `*.r2.dev`, `*.r2.cloudflarestorage.com`
- `*.amazonaws.com`, `*.cloudfront.net`
- `storage.googleapis.com`
- `*.blob.core.windows.net`
- `three.ws`, `*.vercel.app`

Anything else is refused with an explanation instead of rendered. This is the same allowlist `/api/artifact` enforces server-side, for the same reason: an indexed page on our origin must not become a renderer for arbitrary third-party payloads.

---

## Embedding it

Click **Copy embed** on the page and you get an iframe pointed at exactly what you are looking at, artifact parameters included:

```html
<iframe
  src="https://three.ws/avatar-artifact?agent=27a0f649-3b59-4552-bb0b-faf616ac448b"
  width="100%"
  height="600"
  style="border:0"
  loading="lazy"
  title="Avatar Artifact"
></iframe>
```

If the clipboard is unavailable (a cross-origin frame, or Safari) the page reveals the snippet in a text field instead of failing silently.

Two properties make this safe to drop on someone else's page:

- **No third-party CDN.** three.js ships with the bundle. An embed host never picks up a cross-origin script tag it did not agree to.
- **It stops when it is not visible.** A hidden tab suspends the render loop, so an embedded viewer never burns a host page's GPU in the background.

For a full chat widget or a token-gated embed, use [Share and embed](./share-and-embed.md) instead. This page is the plain viewer.

---

## Interaction

Every input drives one look-target, so the page works with a mouse, a finger or a keyboard alone:

| Input | Effect |
| --- | --- |
| Move the cursor | Turn the subject |
| Drag (touch) | Same, on a phone |
| Arrow keys, or `WASD` | Same, without a pointer |
| `+` / `-`, or the wheel | Zoom (artifact modes only) |

`prefers-reduced-motion` removes the idle sway, breathing and drift; the avatar still responds to input.

---

## Animation

If the GLB carries its own animation clips, the page plays one: whichever is named for an idle, or the first clip. The author's intent wins.

Most three.ws avatars carry no baked clips, because motion lives in the [shared clip library](./animations.md) and is retargeted onto whatever skeleton the rig uses. The page does exactly that: it attaches an `AnimationManager`, loads the `idle` clip and retargets it. Any humanoid rig the canonicalizer recognises comes to life; a rig that genuinely cannot be skeleton-driven (a static prop, a non-humanoid mesh) simply stands still. Nothing renders in a bind-pose T-pose.

---

## When something goes wrong

Every failure has its own sentence and its own next move. There is no blank screen and no raw exception:

| What happened | What the page says |
| --- | --- |
| The 3D runtime never loaded | Network hiccup, offers a retry |
| The browser has no WebGL | Names the cause, suggests another browser |
| No agent with that id | The link may be old, offers **Browse agents** |
| The agent lookup failed | Network hiccup, offers a retry |
| The agent has no avatar yet | Explains, links to the profile |
| The agent's avatar is private | Explains, links to the (public) profile |
| The model host is not allowed | Names the rule |
| The model failed to load | Moved, or a compression format this viewer does not carry |

A large model on a slow connection is not a failure: the loading overlay reports byte progress, and the watchdog re-arms on every progress tick so a download that is genuinely still running is never called dead.

---

## Where the code lives

- Page markup and copy: [pages/avatar-artifact.html](../pages/avatar-artifact.html)
- Scene, artifact resolution and loading: [src/avatar-artifact.js](../src/avatar-artifact.js)
- Clip retargeting: [src/animation-manager.js](../src/animation-manager.js)

## Related

- [The 3D viewer](./viewer.md): the full engine behind `/app` and `<agent-3d>`
- [Share and embed](./share-and-embed.md): widgets, web components and embed policy
- [Claude artifact contract](../specs/CLAUDE_ARTIFACT.md): the self-contained HTML lane for Claude.ai, which shares this page's parameter shape
- [Animations](./animations.md): the clip library this page retargets from
