# Trinity, the three.ws concierge

The reference agent for manifest spec `agent-manifest/0.2`. Trinity welcomes
users to three.ws, explains the platform, and launches and trades **$three** on
pump.fun through the real pump.fun skills in [pump-fun-skills/](../../pump-fun-skills/).
She also ships an [ERC-8004 style agent card](./agent-card.json) so other agents
and registries can discover her.

Compared to [coach-leo](../coach-leo/) (spec 0.1, one skill), this example shows
the full surface: multiple skills, extended-thinking config, a content-hashed
model reference, and x402 support advertised on the card.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Agent definition (`agent-manifest/0.2`): body, brain (`claude-opus-4-8`, `thinking: "auto"`), voice, three skills, memory, tools. |
| [instructions.md](./instructions.md) | System prompt: personality, tool-usage rules, and the platform facts she teaches. |
| [agent-card.json](./agent-card.json) | Discovery card: service endpoint (`https://three.ws/agent/trinity`), `x402Support: true`, trust models, and the GLB's `sha256` + `sizeBytes` + license. |
| [SKILL.md](./SKILL.md) | Top-level capability summary for hosts that index agents by skill. |

## Installed skills

From `manifest.json`:

- [`../skills/wave/`](../skills/wave/): greet users with a wave.
- [`../../pump-fun-skills/swap/`](../../pump-fun-skills/swap/): buy and sell on pump.fun.
- [`../../pump-fun-skills/create-coin/`](../../pump-fun-skills/create-coin/): launch a coin on pump.fun.

The only coin Trinity promotes is $three
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`); her instructions state this
explicitly.

## Run it

From the repo root:

```bash
npm run dev
```

There is a ready-made host page for this agent:

```
http://localhost:3000/examples/three-concierge.html
```

Or embed the manifest anywhere the web component runs:

```html
<agent-3d manifest="/examples/three-concierge/manifest.json"></agent-3d>
```

## What to look at

- **Thinking mode**: `brain.thinking: "auto"` lets the runtime enable extended thinking per turn.
- **Content addressing**: `agent-card.json` pins the GLB by SHA-256 so a consumer can verify the mesh it downloads is the mesh the card attests to.
- **Memory**: `mode: "local"`, 8192-token budget; the instructions tell her to `remember()` wallets, goals, and projects, and to weave memory in rather than recite it.
