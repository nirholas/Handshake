# Connect your home

**Goal: your agent runs your actual house. It turns the lights on, sets the thermostat, runs the
scenes you already built, and stops to ask before it unlocks anything.**

You need a [Home Assistant](https://www.home-assistant.io) instance. That is the only requirement,
and it is a hard one: three.ws writes no device code at all. Home Assistant already owns Zigbee,
Z-Wave, Matter, Thread, BLE and 1,500 other integrations, and it does that job better than
anything we would write. Everything below is the layer in between.

Twenty minutes, most of which is Home Assistant asking you to pick a password.

---

## 1. What you need, and how to check you have it

Two things: a Home Assistant your agent can reach, and a long-lived access token.

**Reach is the part that surprises people.** Home Assistant usually lives on your home network, at
an address like `homeassistant.local:8123` or `192.168.1.40:8123`. No server on the internet can
route to that, and a web page served over https cannot open a plain-http address at all. So which
route you take depends on where the agent runs:

| Where the agent runs | What you need |
|---|---|
| On your own machine, on your own network | Nothing. Your LAN address works |
| On three.ws (the 3D agent, the household page) | A remote https URL: [Home Assistant Cloud](https://www.nabucasa.com), or your own reverse proxy |
| Anywhere, with a LAN-only house | The three.ws Home Assistant integration, which dials out from inside your house |

Check what you have. From the machine the agent will run on:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://your-home-url/
```

```
200
```

Anything other than a number means the address is wrong or unreachable from where you ran it. A
`000` from your laptop but a `200` from a machine at home is the LAN problem, and section 8 is
about it.

**No Home Assistant yet, and you just want to see this work?** One command from a clone of this
repo gives you a throwaway house with rooms, lights, locks and scenes in it:

```bash
node scripts/home-test-instance.mjs --up --onboard --seed --json
```

```json
{
	"ok": true,
	"action": "ready",
	"haVersion": "2026.9.0",
	"baseUrl": "http://127.0.0.1:42125",
	"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
	"seeded": true
}
```

It prints a URL and a token, which is exactly what sections 2 and 3 are about to ask you for. Take
it down again with `node scripts/home-test-instance.mjs --down`.

## 2. Mint a long-lived access token

In Home Assistant:

1. Click **your own name** at the bottom of the sidebar.
2. Open the **Security** tab.
3. Scroll to **Long-lived access tokens** and click **Create token**.
4. Name it something you will recognise later, like `three.ws`.
5. **Copy it now.** Home Assistant shows it once and never again.

It is documented upstream at [Home Assistant: long-lived access
tokens](https://www.home-assistant.io/docs/authentication/#your-account-profile).

That token carries the full rights of the account that made it. If you want the agent to have less
than you do, make a second Home Assistant user with less access and mint the token as that user.

Check it works:

```bash
curl -s -H "authorization: Bearer $HOME_ASSISTANT_TOKEN" https://your-home-url/api/
```

```json
{"message":"API running."}
```

A wrong token gives you `401` and an empty body. That is the one failure worth telling apart from
every other, and every surface below reports it as `auth` rather than as "your house is offline".

## 3. Connect

### The fastest path: your own assistant, on your own machine

This needs no three.ws account and has no reachability problem, because the server runs where you
are.

```bash
claude mcp add home \
  -e HOME_ASSISTANT_URL=http://127.0.0.1:42125 \
  -e HOME_ASSISTANT_TOKEN=eyJhbGciOi... \
  -- npx -y @three-ws/home-mcp
```

Or, in any client that reads a JSON config (Claude Desktop, Cursor, and most others):

```json
{
  "mcpServers": {
    "home": {
      "command": "npx",
      "args": ["-y", "@three-ws/home-mcp"],
      "env": {
        "HOME_ASSISTANT_URL": "http://127.0.0.1:42125",
        "HOME_ASSISTANT_TOKEN": "eyJhbGciOi..."
      }
    }
  }
}
```

**What connected looks like.** The server prints one line to stderr on start:

```
[home-mcp@0.1.0] connected over stdio with 5 tools, home http://127.0.0.1:42125
```

and your assistant gains five tools: `home_overview`, `list_entities`, `list_macros`,
`call_service`, `run_macro`. Ask it to read the house and you get your own rooms back, in the names
your household already uses:

```json
[
  { "name": "Bedroom",     "floor": "Ground Floor", "entities": 1,
    "lighting": { "total": 1, "on": 1, "brightness": 0.706, "rgb": [255, 164, 82] },
    "climate": null, "security": null },
  { "name": "Living Room", "floor": "Ground Floor", "entities": 2,
    "lighting": { "total": 1, "on": 0, "brightness": 0, "rgb": null },
    "climate": { "temperature": 25, "sources": 1 }, "security": null }
]
```

If instead you see nothing, the server did not start. Run it by hand to see why:

```bash
HOME_ASSISTANT_URL=... HOME_ASSISTANT_TOKEN=... npx -y @three-ws/home-mcp
```

Full reference: [`@three-ws/home-mcp`](../../packages/home-mcp/README.md).

### The three.ws path: a 3D agent standing in your house

Go to [three.ws/smart-home](https://three.ws/smart-home), sign in, and paste the same two things:
your remote https URL and your token. This is the path that gives you the household page, the
member roster and the 3D scene, and it is the one that needs a URL reachable from the public
internet.

Connecting is not a "saved" button. three.ws opens a real connection and **measures** the
instance before storing anything: its version, how many entities it has, its areas and floors, and
whether the optional [Model Context Protocol
Server](https://www.home-assistant.io/integrations/mcp_server/) integration answers. A house it
could not reach never becomes a stored credential, so your list cannot fill up with connections
that have never worked. A capability it did not observe is reported absent, never assumed present.

Your token is encrypted at rest (AES-256-GCM, per-record salt) from the moment it lands.

## 4. Your first command, by text

Ask in plain language. "Turn the kitchen light on to 40 percent." Under the hood that is one
service call:

```json
{ "domain": "light", "service": "turn_on",
  "data": { "entity_id": "light.ceiling_lights", "brightness_pct": 40 } }
```

**But the better first command is a scene you already made.** Say "good night".

```json
{
  "ok": true,
  "ran": true,
  "match": {
    "entity_id": "scene.bedtime",
    "confidence": 0.95,
    "reason": "\"good night\" is the Good night macro, and Bedtime is this home's version of it."
  }
}
```

Nothing invented that macro. `scene.bedtime` is a scene you built in Home Assistant, and your
version of "good night" knows about the plant light and the fish tank in a way no amount of
reasoning over an entity list ever will. Phrases resolve through a synonym table (`good night`,
`goodnight`, `bedtime`, `time for bed` all land in the same place) and then by fuzzy match against
your own scene names.

A phrase that matches nothing runs **nothing**:

```json
{ "ok": true, "ran": false, "match": null,
  "message": "Nothing in this house matches \"launch the shuttle\". Call list_macros to see what it does have, and do not substitute a different scene." }
```

That is deliberate. Firing the nearest scene is how a "good night" turns into an away mode.

## 5. Your first command, by voice

Voice already works in your house, and it is Home Assistant's own: the **Assist** pipeline, with
wake word, speech to text and text to speech all running on your own hardware. three.ws does not
replace any of it. What it adds is a face.

[`services/home-satellite`](../../services/home-satellite/README.md) registers as a
[Wyoming](https://github.com/rhasspy/wyoming) satellite, which is a thing Home Assistant already
knows how to talk to. Run it beside your instance, point Home Assistant's **Wyoming Protocol**
integration at `host:10700`, and assign it to a pipeline like any other satellite. It supplies a
microphone (from a browser showing the agent) and a speaker (that browser's audio, with the
agent's face moving in front of it). Say your wake word, and the agent looks at you and answers.

One rule shapes that whole service: **the pipeline never depends on the face.** Close the browser
tab and Home Assistant keeps working exactly as it did before three.ws was installed. A satellite
that hangs a house because a tab closed is a satellite that breaks somebody's home.

If your assistant client supports speech (Claude Desktop does), the path in section 3 is already a
voice path with no extra parts: talk to your assistant, and it calls the same five tools.

## 6. What it will do on its own, and what it always asks about

**Reads are free. Writes that make the house safer run. Writes that open the house stop and ask.**

| What you say | What happens |
|---|---|
| "Is everything locked?" | Answers. No prompt |
| "Turn the lights off", "set it to 21", "run bedtime" | Runs. No prompt |
| "Lock the front door", "close the garage", "arm the alarm" | **Runs immediately, never prompts, always** |
| "Unlock the front door", "open the garage", "disarm the alarm" | **Stops and asks a person** |

The asymmetry is the point. Locking up moves your house toward safety and there is no version of
this product where it hesitates. Unlocking cannot be undone remotely, and a voice channel that can
open a front door on a misheard phoneme is not a feature.

**Why the door asks every single time.** Home Assistant's own voice tools are polymorphic, and its
published description of `intent__HassTurnOff` reads: *"Turns off/closes a device or entity. For
locks, this performs an 'unlock' action."* An agent told to turn something off can open your front
door, and nothing in the tool's name says so. We verified that against a real instance: with a
lock exposed to Assist, that call really does unlock it.

So the gate does not trust the tool's name. It resolves what each call would actually touch,
works out the real service each target would perform, and applies the same rule on every channel.
And the confirmation is never something the model produces:

- On three.ws, a guarded call **mints a pending confirmation** and returns it as neither a success
  nor an error. You redeem it in your own browser session. Not with a bearer token, not with an
  API key, not from a background agent: a signed-in person, with a CSRF check, in a session. The
  request to confirm carries nothing but the confirmation's id, because the action was frozen
  server-side when it was minted. There is nothing there for a caller to steer.
- On [`@three-ws/home-mcp`](../../packages/home-mcp/README.md), a guarded call is **refused
  outright**, because an MCP client carries no session and has no browser to raise a prompt in.
  There is no confirmation argument in any of its tool schemas, and a model cannot set a field it
  was never handed.

If you want the agent to handle one specific door without asking, you can say so. A standing
allowance is per entity and per direction, never per domain:

```json
{
  "grants": [],
  "confirmation_ttl_seconds": 90,
  "message": "Nothing is pre-approved in this home. Locking, closing, and arming still run immediately; unlocking, opening, and disarming always need a person to confirm."
}
```

Allowing `lock.office_door` does not allow `lock.front_door`. It never will.

## 7. Add somebody else to the household

A house has more than one person in it, and they should not all have the same powers. On the
three.ws path, invite them from your home's page and give them a role:

| Role | Read | Act | Confirm an unlock | Standing allowance | Layout | Invite | Manage | Disconnect |
|---|---|---|---|---|---|---|---|---|
| **owner** | yes | yes | yes | yes | yes | yes | yes | yes |
| **admin** | yes | yes | yes | yes | yes | yes | yes | no |
| **member** | yes | yes | yes | no | yes | no | no | no |
| **guest** | scoped | scoped | **no** | no | no | no | no | no |
| **viewer** | scoped | no | no | no | no | no | no | no |

There is exactly one owner, and the schema enforces it. Ownership is never handed out.

**A guest can turn the lights on and cannot open the door.** That is the shape of the role, and it
is the one most households actually need: someone staying the week, a cleaner, a contractor.
"Scoped" means their reads and their actions are narrowed to the areas or entities you named, so a
guest scoped to the kitchen does not see the bedroom at all, let alone act in it.

A **viewer** is the wall display in the hallway or a monitoring seat: it reads, and it never acts.

## 8. When it says your home is unreachable

This is the most common message in the whole product, and nine times out of ten it is not a fault.

```json
{
  "error": "unreachable",
  "error_description": "127.0.0.1 is a private address. A three.ws server on the public internet cannot route to it. Use your remote https URL, or connect the add-on so your house dials out to us instead."
}
```

Read it literally. It means the address you gave is one nothing outside your house can reach:
`homeassistant.local`, `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, or a loopback address. three.ws
runs on the public internet and cannot route into your home network. That is not a bug we can fix
with a retry, and we say so up front rather than letting you wait out a timeout.

Three real answers, in the order to try them:

1. **Use a remote https URL.** [Home Assistant Cloud](https://www.nabucasa.com) gives you one with
   no configuration, and your own reverse proxy works just as well. Paste that URL instead. This
   is the shortest path and it needs no new software in your house.
2. **Run the agent inside your network.** The MCP path in section 3 runs on your own machine, so
   your LAN address is fine and no traffic leaves the building. Zero latency, fully private.
3. **Let your house dial out.** Install the three.ws integration through
   [HACS](https://hacs.xyz), pair it with a code from your home's page, and it opens one outbound
   WebSocket to us. Nothing listens on your network, no port is forwarded, no inbound firewall
   rule exists, and **no Home Assistant token ever leaves the building**: the integration
   authenticates locally and hands the session over already authenticated. See
   [`home-assistant-integration/`](../../home-assistant-integration) and
   [`services/home-relay`](../../services/home-relay/README.md).

The other error codes, and what each one means:

| Code | Means | What to do |
|---|---|---|
| `bad_url` | Not a URL, or plain http where https is required | Use your remote https URL |
| `auth` | Home Assistant rejected the token | Mint a new long-lived token (section 2) |
| `unreachable` | Nothing answered | The address is LAN-only, or the house is off |
| `no_mcp` | The optional `mcp_server` integration is not enabled | Nothing is broken. Turn it on for extra tools, or ignore it |
| `needs_confirmation` | A guarded action, with no person saying yes | Confirm it, or grant a standing allowance |

`no_mcp` is worth calling out: it is **not** a failure. The state and action channel works on
every instance with nothing but a token. The MCP channel is always an upgrade, never a
requirement.

---

## Read next

- [`@three-ws/home-mcp`](../../packages/home-mcp/README.md): the five tools, and the gate over stdio.
- [`@three-ws/home-bridge`](../../packages/home-bridge/README.md): the library underneath, if you
  are building your own client.
- [docs/smart-home.md](../smart-home.md): why Home Assistant owns the device layer, what else was
  evaluated, and where this goes next.
- [docs/home-households.md](../home-households.md): roles, scopes and invites in full.
- [docs/home-privacy.md](../home-privacy.md): what is kept, for how long, and how to delete it.
