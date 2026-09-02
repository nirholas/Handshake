# @three-ws/home-bridge

**Connect a three.ws agent to a real home.**

This is the layer between a three.ws agent and [Home Assistant](https://www.home-assistant.io):
live entity state, safe service calls, a room graph the 3D scene can render, and the optional
Model Context Protocol channel.

It deliberately implements **no device support at all**. Zigbee, Z-Wave, Matter, Thread, BLE,
and the long tail of 1,500 integrations are Home Assistant's job, and it does that job better
than anything we would write. This package is the 200 lines in the middle that were missing.

Why this exists, what else was evaluated, and where it goes next:
[docs/smart-home.md](../../docs/smart-home.md).

## Install

```bash
npm install @three-ws/home-bridge
```

The Model Context Protocol channel is optional. Install `@modelcontextprotocol/sdk` alongside
this package if you want it; everything else works without it.

## What you need from the user

A **base URL** and a **long-lived access token** (Home Assistant, Profile, Security,
Long-lived access tokens, Create token).

The URL has to be one your code can actually reach. A page served over https cannot open a
plain-http LAN address, and a cloud server cannot route to `192.168.x.x` at all, so a home
that is only on its own network needs a remote https URL (Home Assistant Cloud, or the
user's own reverse proxy). `normalizeBaseUrl` and `isPrivateHost` let you say that up front
instead of after a timeout.

## Use it

```js
import { HomeBridge } from '@three-ws/home-bridge';

const home = new HomeBridge({
	baseUrl: 'https://abc123.ui.nabu.casa',
	token: process.env.HOME_ASSISTANT_TOKEN,
});

// connect() opens the state socket, reads the floor/area/device/entity
// registries, and resolves once the room graph is ready.
const graph = await home.connect();

for (const room of graph.rooms) {
	console.log(room.name, room.lighting, room.climate, room.secured);
}
// Bedroom  { total: 1, on: 1, brightness: 0.157, rgb: [255,164,82] }  null  null
// Living Room  { total: 2, on: 2, ... }  { temperature: 23, sources: 1 }  { locks: 1, unlocked: [], openings: 1, open: ['cover.living_room_window'], secure: false }

// The graph rebuilds itself on every state push, so a 3D scene can just redraw.
home.on('graph', (next) => scene.apply(next));

await home.call('light', 'turn_on', { entity_id: 'light.kitchen_lights', brightness_pct: 40 });

home.close();
```

### "Good night" is a scene the user already built

Household macros are not something this package invents. They are `scene.*` and `script.*`
entities the user made in an editor they already know, and their own "Bedtime" scene knows
about the plant light and the fish tank in a way no amount of reasoning over an entity list
will. `activate()` finds it:

```js
const { ran, match } = await home.activate('good night');
// match: { entityId: 'scene.bedtime', macro: 'good_night', confidence: 0.95,
//   reason: '"good night" is the Good night macro, and Bedtime is this home\'s version of it.' }
```

Phrases resolve through a synonym table (`good night`, `goodnight`, `bedtime`, `time for bed`
all reach the same place) and then through fuzzy matching on the scene names. A house with no
matching scene returns `{ ran: false, match: null }` rather than firing the closest thing it
can find. Pass `{ dryRun: true }` to resolve without running.

## The physical-action gate

**Reads are free. Writes that open the house stop and ask.** The rule is asymmetric on
purpose: locking up, closing the garage, and arming the alarm move the house toward safety and
never prompt; unlocking, opening, and disarming always do.

```js
try {
	await home.call('lock', 'unlock', { entity_id: 'lock.front_door' });
} catch (err) {
	if (err.code === 'needs_confirmation') {
		// err.pending: { domain, service, data, risk: 'security', entityId }
		// Show the user what is about to happen, then repeat with the flag.
		await home.call('lock', 'unlock', { entity_id: 'lock.front_door' }, { confirmed: true });
	}
}
```

`confirmed: true` represents a human saying yes. Never set it from model output.

A standing allowance is per entity and per direction, never per domain: a user who lets the
agent open the office door has not let it open the front door.

```js
home.allowList.add('lock.office_door');
```

## The MCP channel

Home Assistant's first-party [`mcp_server`](https://www.home-assistant.io/integrations/mcp_server/)
integration exposes the exact tools the user chose to give their own LLM. When a home has it
enabled, an agent gets that curated surface for free.

```js
import { connectHomeMcp, flattenEntities } from '@three-ws/home-bridge';

const mcp = await connectHomeMcp({
	baseUrl,
	token,
	entities: () => flattenEntities(home.graph),
	isAllowed: (id) => home.allowList.has(id),
});

console.log(mcp.tools.map((t) => t.name));
// intent__HassTurnOn, intent__HassTurnOff, light__HassLightSet, climate__HassClimateSetTemperature, ...

await mcp.callTool({ name: 'light__HassLightSet', arguments: { name: 'Kitchen Lights', brightness: 30 } });
```

**Pass `entities` or the gate is off, and you need the gate here more than anywhere else.**
Home Assistant's own description of `intent__HassTurnOff` reads: *"Turns off/closes a device
or entity. For locks, this performs an 'unlock' action."* A model told to turn something off
can unlock a front door, and nothing in the tool name says so. `classifyMcpCall` resolves the
call's targets against the live entity list, works out the service each one would really
perform, and applies the same rule the WebSocket path uses. This is verified against a live
instance in `tests/live-home.test.js`.

An instance without the integration set up throws `ERR.NO_MCP`, which is an ordinary state to
be in and not an outage. The WebSocket channel works on every instance with nothing but a
token, so the MCP channel is always an upgrade and never a requirement.

## Errors

Every failure carries a `code`, because a connect screen has to tell "your token is wrong"
apart from "your house is offline".

| `code` | Means | What to tell the user |
|---|---|---|
| `bad_url` | Not a URL, or plain http from an https page | Use your remote https URL |
| `auth` | Home Assistant rejected the token | Create a new long-lived token |
| `unreachable` | No answer at all | The home may be LAN-only |
| `needs_confirmation` | A guarded action, no explicit yes | Show `err.pending`, then confirm |
| `no_mcp` | `mcp_server` is not enabled | Optional: offer to add it |
| `call_failed` | Connected, request failed | Surface the message |
| `not_connected` | Used before `connect()` | A bug in the caller |

## API

| Export | What it does |
|---|---|
| `HomeBridge` | One live connection: `connect`, `call`, `activate`, `macros`, `graph`, `states`, `on`, `close` |
| `connectHomeMcp` | The optional MCP capability channel, gated |
| `buildHomeGraph` | Registries plus states to the room graph. Pure |
| `flattenEntities` | The room graph to one flat entity list |
| `summarizeLighting` / `summarizeClimate` / `summarizeSecurity` | Per-room rollups the 3D scene reads |
| `resolveIntent` / `matchMacro` / `MACROS` | Phrase to an existing scene or script |
| `classifyCall` / `classifyMcpCall` / `createAllowList` | The physical-action gate |
| `normalizeBaseUrl` / `isPrivateHost` | URL handling and the LAN reachability check |

## Tests

```bash
npx vitest run packages/home-bridge
```

The default suite runs against `tests/fixtures/home.json`, a recording of a real Home
Assistant instance rather than hand-written shapes (regenerate it with
`scripts/capture-home-fixture.mjs`). Set `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_TOKEN` to
also run the live suite, which changes real state on a real instance:

```bash
docker run -d --name ha -p 8123:8123 ghcr.io/home-assistant/home-assistant:stable
# add `demo:` to its configuration.yaml for a house full of entities, then restart
HOME_ASSISTANT_URL=http://localhost:8123 HOME_ASSISTANT_TOKEN=... npx vitest run packages/home-bridge
```

## License

Apache-2.0. Built on [`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket)
(Apache-2.0) and [`@leeoniya/ufuzzy`](https://github.com/leeoniya/uFuzzy) (MIT).
