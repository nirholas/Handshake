# Coach Leo

A complete, minimal example of a three.ws agent defined entirely as files: a
[manifest](./manifest.json) pointing at a 3D body, a brain, a voice, a memory
policy, and one installed skill. Coach Leo is a football coach who waves when
you greet him, comments on your form, and remembers what you tell him across
sessions.

Use this directory as the template for your own agent: copy it, swap the GLB,
rewrite the instructions, and pick your skills.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | The agent definition (`agent-manifest/0.1`): body GLB, brain model, voice, skills, memory, tools. |
| [instructions.md](./instructions.md) | The system prompt. Frontmatter (`name`, `model`, `temperature`) mirrors the manifest; the body defines personality and tool-usage rules. |
| [SKILL.md](./SKILL.md) | Top-level capability summary surfaced to hosts that index agents by skill. |

## How the manifest is wired

- **Body**: `/avatars/cz.glb`, a Mixamo-rigged GLB served by the main app (`boundingBoxHeight: 1.78`).
- **Brain**: Anthropic `claude-opus-4-6` with `instructions.md` as the prompt, temperature `0.8`.
- **Voice**: browser TTS and STT (`en-US`), speech rate `1.05`.
- **Skills**: one entry, the starter [wave skill](../skills/wave/) at `../skills/wave/`. The instructions tell the model to call `wave()` on greetings.
- **Memory**: `mode: "local"` with an 8192-token budget, indexed at `memory/MEMORY.md`.
- **Tools**: `wave`, `lookAt`, `play_clip`, `setExpression`, `speak`, `remember`.

## Run it

From the repo root:

```bash
npm run dev
```

Then load the manifest into any agent surface, for example the web component:

```html
<agent-3d manifest="/examples/coach-leo/manifest.json"></agent-3d>
```

Greet him. Per [instructions.md](./instructions.md) he calls `wave()`, sets a
focused expression while explaining drills, and calls `remember()` when you
share your position, goals, injuries, or schedule.

## Related

- [examples/three-concierge/](../three-concierge/): a richer agent on manifest spec 0.2 with pump.fun skills and an agent card.
- [examples/skills/wave/](../skills/wave/): the skill this agent installs.
