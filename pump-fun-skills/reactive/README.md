# pump-fun-reactive

Skill that drives live `<agent-3d>` avatar movement from the real pump.fun
market feed. It opens a WebSocket to PumpPortal (`wss://pumpportal.fun/api/data`),
subscribes to new-token launches and bonding-curve migrations, and converts the
stream into avatar gestures, emotes, and speech every two seconds. No LLM is in
the loop: the reactions are pure event logic, so they are instant and free.

This is coin-agnostic plumbing: it reacts to whatever the public feed emits at
runtime and hardcodes no mint.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Skill identity (`pump-fun-reactive`), `sandboxPolicy: "trusted-main-thread"`, provided tools. |
| [tools.json](./tools.json) | JSON-Schema definitions for the two tools (both take no arguments). |
| [handlers.js](./handlers.js) | WebSocket lifecycle, 2-second aggregation window, event-to-reaction mapping, exponential-backoff reconnect. |
| [SKILL.md](./SKILL.md) | The skill doc the agent runtime loads. |

## Tools

- `enable_live_reactions`: connects, subscribes (`subscribeNewToken`, `subscribeMigration`), and starts the 2-second flush loop. Returns `{ ok: true, started: true }`, or `{ ok: true, already: true }` if already running. Reconnects automatically on disconnect (exponential backoff, capped at 30s, up to 10 attempts). Requires `ctx.protocol`: an `AgentProtocol` instance (any object with an `emit(action)` method works).
- `disable_live_reactions`: closes the socket, clears timers and buffer. Returns `{ ok: true, stopped: true }`.

## Reaction logic (per 2-second window)

Priority order, from [handlers.js](./handlers.js):

1. Any migration event (`txType: 'migrate'`): celebrate gesture + celebration emote + spoken "graduated!" line.
2. A create event with an initial buy above 5 SOL: curiosity emote + a spoken line naming the size of the opening buy.
3. Otherwise, by count of create events in the window: 0 -> patience emote; 1-2 -> curiosity + look at user; 3-9 -> wave + curiosity; 10+ -> wave + celebration + a spoken launch-rate line.

Every emitted action carries `sourceSkill: 'pump-fun-reactive'`.

## Usage

```js
await registry.install({ uri: './pump-fun-skills/reactive/' });
const skill = registry.findSkillForTool('enable_live_reactions');
await skill.invoke('enable_live_reactions', {}, { protocol });
// ...later
await skill.invoke('disable_live_reactions', {}, {});
```

## Testing

`_setWsUrl(url)` is exported from [handlers.js](./handlers.js) solely so tests
can point the skill at a local WebSocket server; production code never calls it.

## Related

- The other pump.fun skills in this collection: [../README.md](../README.md).
