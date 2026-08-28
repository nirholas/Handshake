# @three-ws/companion

**Give a person's notifications a body.**

Software has spent thirty years getting better at buzzing. It has not got any
better at telling you which buzz mattered. This package is the other half: a
harness that decides what is worth interrupting a human for, and a 3D character
that walks over and says it out loud, in the voice and the body of whoever it
came from.

```js
import { createCompanionClient } from '@three-ws/companion';

const companion = createCompanionClient({ token: process.env.COMPANION_TOKEN });

await companion.send({
  title: 'Production deploy failed on main',
  sender: 'CI',
  priority: 'high',
  url: 'https://github.com/acme/api/actions/runs/1234',
});
// → the character on their desktop turns around and says it.
```

It ships four things that compose:

| | What it is |
|---|---|
| **Client** | `createCompanionClient()` - push messages in, stream triaged deliveries out (auto-reconnecting SSE, works in Node, browsers, and Electron). |
| **Triage** | `scoreByRules()` / `decide()` - the same interrupt-or-not judgement the hosted service makes, locally, with no key and no network. |
| **Stage** | `createCompanionStage()` - drops a 3D body into any page and has it deliver, with a real voice. |
| **CLI** | `companion send / stream / watch-imap / mcp / doctor` - including an MCP server, so any agent can interrupt a human in person. |

Install:

```bash
npm install @three-ws/companion
```

Get a bridge token at **[three.ws/companion](https://three.ws/companion)**. It is
the only credential anything here needs, it is per person, and rotating it on
that page disconnects every device at once.

---

## 1. Send something worth hearing

Anything that can make an HTTP request can hand the companion a message: a CI
job, a home server, a trading bot, a Raspberry Pi in the hallway, an agent.

```js
const result = await companion.send({
  title: 'Sarah is at the door',   // required
  body: 'She says the gate code did not work',
  sender: 'Sarah',                  // matched against the person's contacts
  sender_id: '+14155550100',        // matched first, and more precisely
  app: 'Messages',
  url: 'https://…',                 // optional, becomes an Open button
  priority: 'high',                 // what the sending device already knew
  id: 'doorbell-2026-08-28T12:04',  // optional, makes retries idempotent
});

result.event.importance;  // 92
result.event.reason;      // "from Sarah, a saved contact; asks you for something directly"
result.event.line;        // "Sarah is at the door and says the gate code did not work."
result.event.delivered;   // true - it cleared their bar and was spoken
```

Nothing you send is guaranteed to be spoken, and that is the point: the person
sets the bar, their quiet hours are respected, and everything below it is kept
in their feed instead of shouted at them.

## 2. Listen for deliveries

```js
const stop = companion.stream({
  onOpen: (hello) => console.log('threshold is', hello.threshold),
  onDelivery: (delivery) => {
    console.log(`${delivery.speaker}: ${delivery.spoken_line}`);
    companion.markDelivered(delivery.id);   // so no other device repeats it
  },
  onError: (err) => console.warn(err.message),
});

// later
stop();
```

A delivery carries everything a body needs to perform it:

```jsonc
{
  "id": "…",
  "source_kind": "telegram",
  "speaker": "Sarah",
  "spoken_line": "Sarah says she is downstairs and cannot find your door.",
  "importance": 88,
  "reason": "from Sarah, a saved contact; asks you for something directly",
  "avatar_glb_url": "https://three.ws/api/avatars/…/glb",  // her own body
  "voice": "nova",                                          // her own voice
  "url": null,
  "created_at": "2026-08-28T12:04:11.221Z"
}
```

The stream reconnects on its own and resumes from the last delivery it saw, so a
laptop that slept wakes up and catches what it missed (bounded server side to
the last few hours, because a monologue is not a delivery).

## 3. Answer it

A delivery whose lane can carry an answer comes back with `can_reply: true`:

```js
await companion.reply(delivery.id, 'on my way down');
```

It goes back through the same connection the message arrived on, into the same
conversation, quoting the message it answers. Today that is Telegram, through
the user's own bot; a calendar reminder and a phone notification have nothing to
reply to and are refused with `not_repliable` rather than failing silently.

## 4. Put a body on a page

```js
import { createCompanionClient, createCompanionStage } from '@three-ws/companion';

const client = createCompanionClient({ token });
const stage = createCompanionStage({ client, corner: 'bottom-right' });
stage.listen();
```

That is the whole integration. The stage loads the published `<agent-3d>` web
component from three.ws, shows a speech bubble, speaks the line through the
platform voice lanes (falling back to the browser's own speech synthesis), and
swaps to the sender's avatar for the length of the delivery.

Drive it yourself if you would rather:

```js
stage.deliver({
  speaker: 'CI',
  spoken_line: 'The deploy finished. Everything is green.',
  avatar_glb_url: 'https://example.com/robot.glb',
});
```

Inside a page that is already signed in to three.ws, omit the token entirely and
the browser's session cookie is used instead.

## 5. Judge a message locally, with no key

The triage rules are the same code the server runs. Import them when you want
the judgement without sending anything anywhere:

```js
import { decide } from '@three-ws/companion/triage';

const verdict = decide(
  { source_kind: 'email', sender_id: 'security@bank.example', title: 'Your verification code is 220913' },
  { threshold: 60, settings: { quiet_start: 22, quiet_end: 7, timezone: 'Europe/Berlin' } },
);

verdict.importance;  // 70
verdict.signals;     // ['security_code']
verdict.speak;       // true, unless it is the middle of their night
verdict.line;        // what the companion would say
```

Signals it reads today: a saved contact (and their priority), one-time codes,
urgent language, direct requests, money, travel and delivery, a trailing
question, bulk/marketing wording, unattended senders, how close a calendar event
is, and whatever priority the sending device already assigned.

This is what makes a **local privacy mode** possible: score on your own machine,
and send only the one line that earned an interruption.

## 6. The command line

```bash
npx @three-ws/companion login --token cmp_…

companion send "Backup finished" --from "home-server" --priority low
companion stream --say                # tail deliveries, speak them (macOS)
companion list --limit 10
companion check                       # poll every connected source now
companion score "Your code is 1234" --lane email
companion doctor                      # token, reachability, per-source health
```

### Local IMAP mode: your mail password never leaves the machine

```bash
npm install imapflow
companion watch-imap --host imap.fastmail.com --user you@fastmail.com --redact
```

This connects to your inbox **locally**, scores every new message with the rules
above on your own hardware, and posts only what clears the bar, with the body
redacted if you ask. The hosted service never sees the mailbox, the password, or
the messages that did not matter.

### MCP: let an agent interrupt a human, in person

```bash
companion mcp        # stdio MCP server
```

```jsonc
// claude_desktop_config.json / any MCP client
{
  "mcpServers": {
    "companion": {
      "command": "npx",
      "args": ["-y", "@three-ws/companion", "mcp"],
      "env": { "COMPANION_TOKEN": "cmp_…" }
    }
  }
}
```

Tools: `deliver_message` (walk on screen and say it out loud), `list_deliveries`
(what the human has heard recently), and `score_message` (ask how urgent
something would be judged before deciding to send it). An agent that finds
something genuinely urgent stops writing into a log nobody reads and becomes a
character standing in front of the person who needed to know.

Needs `@modelcontextprotocol/sdk` installed alongside this package.

---

## API

### `createCompanionClient(options)`

| Option | Default | Meaning |
|---|---|---|
| `apiBase` | `https://three.ws` | Where the API lives. |
| `token` | none | Bridge token. Omit in a signed-in first-party page. |
| `fetch` | platform | Override, for tests or a proxy. |
| `retryMs` | `3000` | Stream reconnect delay. |

Returns `{ send, list, markDelivered, dismiss, reply, contacts, checkNow, stream }`.
Every method rejects with a `CompanionError` carrying `.status` and `.code`.

### `createCompanionStage(options)`

| Option | Default | Meaning |
|---|---|---|
| `client` | none | Needed for `.listen()`. |
| `apiBase` | `https://three.ws` | Origin for the 3D element and the voice lanes. |
| `corner` | `bottom-right` | Which corner it lives in. |
| `defaultAvatarUrl` | platform default | Body used when a sender has none. |
| `voice` | `true` | Speak the line as well as showing it. |
| `onOpen` | opens a tab | Handler for the delivery's Open button. |

Returns `{ deliver, listen, hide, destroy, element }`.

### `@three-ws/companion/triage`

`scoreByRules(event, contact?, { now })`, `decide(event, { contact, threshold, settings, now })`,
`inQuietHours(settings, now)`, `defaultLine(event, contact)`, `shorten(text, max)`,
`minutesUntil(when, now)`, `clampScore(n)`, `LANE_BASELINE`.

### `@three-ws/companion/config`

`resolveCredentials()`, `readConfig()`, `writeConfig(patch)`, `configPath()` -
the small 0600 JSON file the CLI and the desktop app share, so signing in once
signs in everything on that machine.

---

## Where the messages come from

You can send everything yourself, or connect a source at
[three.ws/companion](https://three.ws/companion) and let the platform poll it:

- **Telegram** - a bot you create with @BotFather, relaying the chats you add it to.
- **Calendar** - the private iCal URL Google, Apple, Outlook and CalDAV all publish.
- **Email** - IMAP with an app password, headers and a short preview only.
- **The bridge** - this package, an iOS Shortcut, an Android profile, a Mail rule, an Apps Script, a webhook.

Full recipes: [three.ws/docs/companion](https://three.ws/docs/companion).

## Related

- [`three.ws/companion`](https://three.ws/companion) - the control room: sources, contacts, threshold, quiet hours.
- [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk) - the walking avatar this uses as a body.
- [`apps/desktop`](https://github.com/nirholas/three.ws/tree/main/apps/desktop) - the companion that lives on your desktop.

## License

Apache-2.0
