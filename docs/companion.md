# The Companion

**A 3D character that tells you the things worth interrupting you for, in person.**

Your phone buzzes forty times a day. Two of those mattered. Every notification
system ever built has optimised the buzz; none of them has ever taken
responsibility for the judgement. The Companion is the other half of the
problem: it reads what comes in, decides what a person would actually want a tap
on the shoulder for, and then a character walks over and says it out loud, in
the body and the voice of whoever it came from.

Set it up at **[three.ws/companion](https://three.ws/companion)**.

- It runs on **your own keys**. A Telegram bot you created, an iCal URL you can
  revoke, an app password scoped to mail, or nothing at all but a token your
  phone posts to.
- It has **a bar**, and you set it. Everything under the bar is kept in a feed
  instead of being spoken. Quiet hours are absolute.
- Anyone you give a face to **arrives in that face**. A message from Sarah is
  delivered by Sarah's avatar, in the voice you picked for her.
- It shows up **where you are**: on three.ws, as a push on your phone, and on
  your desktop as a character that lives there.

---

## Five minutes to your first delivery

1. Open [three.ws/companion](https://three.ws/companion) and copy your **bridge
   token** from the "Phone and Mac" card.
2. Press **Send a test**. A character appears and says it. That is the whole
   delivery path, proven, before you connect anything real.
3. Connect a source: paste a Telegram bot token, a calendar URL, or IMAP
   details. Each one is verified against the real provider before it is saved,
   so a typo fails in front of you instead of at 3am.
4. Add a **contact**: the handle or address of someone who matters, a name, an
   avatar, a voice. Now their messages arrive as them.
5. Set your **threshold** and **quiet hours**.

---

## Where messages come from

### The bridge (your phone, your Mac, anything that can POST)

The universal lane. One endpoint, one token, no integration:

```bash
curl -X POST https://three.ws/api/companion/ingest \
  -H "Authorization: Bearer cmp_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Sarah is at the door","sender":"Sarah","app":"Messages","priority":"high"}'
```

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | One line: what happened. |
| `body` | no | The longer text. |
| `sender` | no | Display name, matched against your contacts. |
| `sender_id` | no | Handle, address, or number. Matched first, and more precisely. |
| `app` | no | Where it came from, e.g. `Messages`, `Slack`. |
| `url` | no | Somewhere to open; becomes a button. |
| `id` | no | Your own id, which makes retries idempotent. |
| `priority` | no | `high` / `normal` / `low`: what the sending device already knew. |
| `occurred_at` | no | ISO timestamp, if it is not "now". |

Ready-made bridges live in
[`docs/companion/bridges/`](https://github.com/nirholas/three.ws/tree/main/docs/companion/bridges):

- **[`notify.sh`](https://github.com/nirholas/three.ws/blob/main/docs/companion/bridges/notify.sh)** -
  one curl, no dependencies. Put it at the end of a build, a backup, a cron job:
  `make release || ./notify.sh "Release build failed" --priority high`.
- **[`gmail-apps-script.gs`](https://github.com/nirholas/three.ws/blob/main/docs/companion/bridges/gmail-apps-script.gs)** -
  runs inside your own Google account on a 5-minute trigger. three.ws never sees
  your mailbox or your credentials, and `REDACT_BODY = true` sends only sender
  and subject.
- **[`macos-mail-rule.applescript`](https://github.com/nirholas/three.ws/blob/main/docs/companion/bridges/macos-mail-rule.applescript)** -
  an Apple Mail rule. Point it at a VIP sender, or at everything and let the
  triage do the filtering.
- **Android**: MacroDroid or Tasker have a real notification-listener trigger.
  Trigger: *Notification Received*. Action: *HTTP Request* → POST the JSON above,
  mapping the notification's app, title and text into `app`, `sender`, `title`.
  That is the closest thing to full phone mirroring that exists without writing
  an app.
- **iOS**: Shortcuts automations (time of day, arriving somewhere, an app
  opening, an NFC tag, a focus change) can post the same JSON with the *Get
  Contents of URL* action, and a Share Sheet shortcut lets you forward anything
  you are looking at by hand. iOS does not expose a general "any notification"
  trigger to Shortcuts, so full mirroring needs the calendar and email lanes, or
  a third-party forwarder app, rather than a Shortcut.
- **Anything else**: Zapier, n8n, Make, a webhook from your own service. The
  body above is the whole contract.

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), paste the
token, then message that bot or add it to a group. Telegram gives no read access
to a human account's chats and no OAuth for one, so a bot you own is the real
supported path: it costs nothing, it can only see what you add it to, and
revoking the token ends the connection with nothing to clean up.

### Calendar

Paste the private iCal URL your calendar already publishes:

- **Google Calendar** → Settings for my calendars → *Secret address in iCal format*
- **Apple / iCloud** → share the calendar → copy the `webcal://` link (pasted as-is; it is converted)
- **Outlook / Microsoft 365** → *Publish a calendar* → ICS
- Any CalDAV server, Fastmail, Proton, Zoho: all publish one.

Events are announced as they approach, once each, inside a window you choose (10
minutes to 2 hours). Recurring series are expanded correctly, cancelled entries
are skipped, and a moved instance is announced at its new time.

### Email

IMAP with an **app password**, never your account password. Gmail, iCloud,
Fastmail, Proton Bridge and Outlook all issue one per app and let you revoke it
independently.

- The mailbox is opened **read-only**: your unread state is never touched.
- Only headers and a short text preview are read.
- The first check records where the mailbox is *now*, so connecting an inbox with
  40,000 messages does not announce 40,000 of them.

Prefer that your mail never leaves your machine at all? See
[local privacy mode](#local-privacy-mode-triage-on-your-own-machine).

---

## How it decides

Every message is scored 0 to 100. Two passes, and the first always runs:

**1. The rules.** Deterministic, instant, no key, no cost. They read:

| Signal | Effect |
|---|---|
| From a saved contact | +18, plus that contact's own priority (-100 to +100) |
| Looks like a one-time code or a login alert | +40 (the most perishable message there is) |
| Urgent language ("asap", "deadline", "final notice") | +22 |
| Asks you directly ("call me", "I'm outside", "where are you") | +18 |
| Money, invoices, declined payments, fraud | +14 |
| Flights, deliveries, cancellations, appointments | +12 |
| Ends in a question | +6 |
| Reads like marketing, or came from `noreply@` | -28 / -20 |
| A calendar event starting within 5 / 15 / 60 minutes | +32 / +24 / +12 |
| Priority the sending device already assigned | ±20 |

Each lane starts from a different baseline, because a calendar entry is on your
own calendar and a stranger's email is not.

**2. A language model, if one is available.** It can move the score and rewrite
the spoken line into something a person would actually say. It runs on **your own
Anthropic key** when you have stored one in your dashboard (BYOK), and on the
platform's free lanes otherwise. If it is over quota, wrong, or absent, the
deterministic verdict stands: nothing is ever lost to a model being unavailable.

The message text is treated as untrusted data at every step. It is passed to the
model inside a delimiter, the model is told it may not follow instructions found
there, and only a number and two short strings are read back. Nothing a message
says can make the companion do anything.

Above your threshold and outside quiet hours, it is **spoken**. Below it, it is
**kept**, with the score and the reason, in the feed on
[/companion](https://three.ws/companion).

---

## Who gets a face

A contact maps an identity (`@sarah`, `sarah@example.com`, `+14155550100`) to:

- a **display name**, used instead of a raw handle,
- an **avatar** (any of yours, or one you make from a selfie at
  [/create-selfie](https://three.ws/create-selfie)),
- a **voice** from the [Voice Lab](https://three.ws/voice) catalogue,
- a **priority** that is added to every message from that person.

Identities are normalised, so the same person resolves whether they wrote from
Telegram, email, or your phone.

When a contact's message is delivered, the walking companion **swaps into their
body for the length of the message and swaps back afterwards**: your own
companion stays yours, and the message still arrives as them.

---

## Where it shows up

### On three.ws

Any page. The corner companion turns to you, waves, and speaks
(`src/notification-herald.js`). Muting it for a browser, or turning the whole
category off account-wide, both live in
[/dashboard/settings](https://three.ws/dashboard/settings) under **Companion
deliveries**.

### On your phone

Web Push, from the same delivery. Turn it on from the settings card on
[/companion](https://three.ws/companion). On iOS, add three.ws to your home
screen first: that is what makes push available.

### On your desktop

[`apps/desktop`](https://github.com/nirholas/three.ws/tree/main/apps/desktop) is
a small Electron app: a transparent, click-through, always-on-top character that
strolls across the bottom of your screen, and walks over to deliver.

```bash
cd apps/desktop && npm install && npm start
```

It signs in with the same bridge token, holds no other credential, and is
click-through everywhere except the character and its bubble.

### Anywhere you write code

```js
import { createCompanionClient, createCompanionStage } from '@three-ws/companion';

const client = createCompanionClient({ token: 'cmp_…' });
createCompanionStage({ client }).listen();
```

Full SDK reference:
[`packages/companion-sdk`](https://github.com/nirholas/three.ws/tree/main/packages/companion-sdk).

---

## Let an agent interrupt you

An agent that finds something genuinely urgent should not write it into a log
nobody reads. With the companion's MCP server it becomes a character standing in
front of the person who needed to know:

```jsonc
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

Tools: `deliver_message`, `list_deliveries`, `score_message`. The agent does not
get to decide whether you are interrupted: its message goes through the same
triage, the same threshold, and the same quiet hours as everything else.

---

## Local privacy mode: triage on your own machine

```bash
npm install -g @three-ws/companion imapflow
companion login --token cmp_…
companion watch-imap --host imap.fastmail.com --user you@fastmail.com --redact
```

This connects to your inbox **locally**, scores every new message with exactly
the rules above on your own hardware (`@three-ws/companion/triage` is the same
module the server runs), and posts only what clears the bar, with the body
redacted. The service never sees the mailbox, the password, or the messages that
did not matter.

---

## The API

Everything the page does, you can do. Session cookie or bridge token.

| Endpoint | Method | What it does |
|---|---|---|
| `/api/companion/ingest` | POST | Hand it a message (bridge token). Returns the triage verdict. |
| `/api/companion/stream` | GET | Live deliveries as Server-Sent Events. |
| `/api/companion/events` | GET | The feed, with scores and reasons. |
| `/api/companion/events/:id` | PATCH | Mark delivered or dismissed. |
| `/api/companion/sources` | GET, POST | List or connect a source (verified before saving). |
| `/api/companion/sources/:id` | PATCH, DELETE, POST | Rename, pause, disconnect, or check now. |
| `/api/companion/contacts` | GET, POST | The people who get a face. |
| `/api/companion/contacts/:id` | DELETE | Forget one. |
| `/api/companion/settings` | GET, PATCH, POST | Threshold, quiet hours, default body and voice; POST rotates the bridge token. |
| `/api/companion/poll` | POST | Poll every connected source now. |

A delivery on the stream carries everything a body needs to perform it:

```jsonc
{
  "id": "…",
  "speaker": "Sarah",
  "spoken_line": "Sarah says she is downstairs and cannot find your door.",
  "importance": 88,
  "reason": "from Sarah, a saved contact; asks you for something directly",
  "avatar_glb_url": "https://three.ws/api/avatars/…/glb",
  "voice": "nova",
  "source_kind": "telegram",
  "created_at": "2026-08-28T12:04:11.221Z"
}
```

---

## What is stored, and what is not

- **Credentials** (bot token, IMAP password, calendar URL) are encrypted with
  AES-256-GCM before they touch the database, and the UI only ever shows you
  enough to recognise which account is connected.
- **Messages** are stored as the title, a short preview, the score, and the
  reason, so the feed can explain itself. Email bodies are truncated to a
  preview and never fetched in full.
- **The bridge token** is the one credential a device needs. Rotating it at
  [/companion](https://three.ws/companion) revokes every device at once.
- Disconnecting a source **deletes its stored credential**.

## Troubleshooting

| What you see | What it means |
|---|---|
| A source says **needs attention** | The provider's own error is shown on the card: an expired bot token, an ICS URL that returns HTML, an IMAP login the server refused. Fix it and press **Check now**. |
| Telegram connected, nothing arrives | The bot only sees what you add it to. Message the bot directly, or add it to the group, and press **Check now**. |
| Calendar connected, nothing arrives | Events are only announced as they approach. Widen the lookahead, or wait for the next one. |
| Everything is **held**, nothing spoken | Your threshold is above what those messages scored. The feed shows each score and reason; lower the bar, or give the sender a contact card with a priority. |
| Nothing is spoken at night | That is quiet hours doing its job. |
| The desktop app says **Not signed in** | Paste the bridge token in the tray menu, or run `companion login`. |
| `companion doctor` | Prints the token in use, whether the API is reachable, and the health of every connected source. |

## Related

- [`packages/companion-sdk`](https://github.com/nirholas/three.ws/tree/main/packages/companion-sdk) - client, triage rules, CLI, MCP server.
- [`apps/desktop`](https://github.com/nirholas/three.ws/tree/main/apps/desktop) - the desktop companion.
- [Walk embed API](https://three.ws/docs/walk-embed-api) - the postMessage contract the bodies are driven with.
- [Notifications](https://three.ws/notifications) - every delivery, and everything else, in one inbox.
