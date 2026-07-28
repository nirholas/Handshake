# apps-sdk/embodiment - the living-agent-body engine

The `EmbodimentStage` engine and its chrome: a generated, rigged avatar that renders inline in a panel, lip-syncs the assistant's replies, shows the matching emotion, plays body gestures, idles between turns, and reacts while a tool runs. Framework-agnostic: give it a DOM container and a persona (name + GLB URL) and it mounts and drives a Three.js scene.

Full documentation for this directory lives one level up in [../README.md](../README.md) (the `embodiment` section), including what does NOT live here (the ChatGPT inline `<model-viewer>` widget is [api/_mcp-studio/component.js](../../api/_mcp-studio/component.js)). This file is the in-place map:

| File | What it does |
| --- | --- |
| [embodiment-stage.js](./embodiment-stage.js) | `EmbodimentStage`, the engine. State machine loading → idle ⇄ listening ⇄ thinking ⇄ speaking → (error), observable via `opts.onState`. Body animation rides the platform canonicalize/retarget pipeline so any humanoid rig plays the baked clip library; non-humanoid rigs get a gentle alive-idle, never a frozen T-pose. |
| [overlay.js](./overlay.js) | The designed DOM chrome around the body: name plate, conversational-state chip, loading skeleton, actionable error card. Pure DOM + CSS, reduced-motion aware. |
| [chain-visuals.js](./chain-visuals.js) | Pure mapping from a persona's on-chain identity ([api/_lib/persona-wallet.js](../../api/_lib/persona-wallet.js)) to visuals: reputation tier → aura, holdings tier → badge, low balance → muted state. No DOM, no network; unit-testable on its own. |
| [face-expression.js](./face-expression.js) | Re-export of the canonical `FaceExpression` from [src/embodiment/face-expression.js](../../src/embodiment/face-expression.js) so there is one implementation in the codebase. |

Consumed by the hosted embed [pages/embodiment/embed.html](../../pages/embodiment/embed.html) (`/embodiment/embed`, framable by ChatGPT, Claude, and any other host). The reply-to-rig core (lip-sync lanes, emotion classifier, rig-mode gate) lives in [src/embodiment/](../../src/embodiment/) with its own [README](../../src/embodiment/README.md).
