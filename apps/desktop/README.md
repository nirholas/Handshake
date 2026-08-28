# three.ws Companion for desktop

A 3D character that lives on your desktop, strolls across the bottom of your
screen, and walks over to tell you the things worth interrupting you for.

Not a notification center. Not another window to manage. A small person who
knows which of your messages matter, arrives in the body of whoever sent them,
and says it out loud.

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│   your actual desktop, untouched                                  │
│                                                                   │
│                    ╭───────────────────────────────╮              │
│                    │ SARAH                         │              │
│                    │ Sarah says she is downstairs  │              │
│                    │ and cannot find your door.    │              │
│                    │ 88/100 · saved contact; asks  │              │
│                    │ you for something directly    │              │
│                    │  [ Open ]  [ Got it ]         │              │
│                    ╰───────────────╮───────────────╯              │
│                              🚶 ← walks over, waves, speaks       │
└───────────────────────────────────────────────────────────────────┘
```

## What it does

- **Lives on top of everything**, on every workspace, including over full-screen
  apps, and is click-through everywhere except the character and its bubble. You
  never have to move it, and it never eats a click meant for your editor.
- **Wanders.** It walks to a new spot every half minute or so, facing the way it
  is going, then idles. It is alive, not a widget.
- **Delivers in person.** When something clears your bar (a message from a saved
  contact, a meeting about to start, a one-time code, an agent that decided you
  need to know), it walks to the middle of the screen, waves, shows the line and
  says it aloud in that sender's voice, wearing that sender's avatar.
- **Respects the bar you set.** Threshold, quiet hours, per-contact priority and
  which sources are connected all live at
  [three.ws/companion](https://three.ws/companion). This app is a body, not a
  second set of rules.
- **Pauses from the tray**, and can start at login.

## Install and run

```bash
cd apps/desktop
npm install
npm start
```

Then either sign in from the window that opens, or, if you already use the CLI:

```bash
npx @three-ws/companion login --token cmp_…
```

Both read the same file (`~/.config/three-ws/companion.json`, or
`~/Library/Application Support/three-ws/companion.json` on macOS), so signing in
once signs in everything on that machine. Get the token from
[three.ws/companion](https://three.ws/companion); rotating it there disconnects
every device at once.

### Build an installer

```bash
npm run dist          # for the platform you are on
npm run dist:mac      # dmg + zip
npm run dist:win      # nsis
npm run dist:linux    # AppImage + deb
```

## How it works

```
three.ws  ──SSE──▶  main process  ──IPC──▶  transparent window
  triage            @three-ws/companion      walk-embed iframe
                    stream + token           postMessage contract
```

- **`src/main.js`** owns the transparent always-on-top window, the tray menu,
  the delivery stream (`@three-ws/companion`), and the OS-level fallbacks
  (native notification, `say` on macOS). It hands mouse input back to the OS
  everywhere the renderer says nothing clickable is.
- **`src/preload.cjs`** is the only bridge into the renderer: context isolation
  on, node integration off, six calls exposed and nothing else. The renderer
  embeds remote content, so it gets no filesystem and no process access.
- **`src/renderer/`** is the stage. The body is the published three.ws walking
  avatar embed driven over its
  [documented postMessage contract](https://three.ws/docs/walk-embed-api), so
  this app carries no 3D code of its own and inherits every avatar, rig and
  animation the platform ships.

## Privacy

- The app holds one credential: your bridge token. No mail password, no bot
  token, no calendar URL ever reaches it.
- It makes exactly two kinds of outbound request: the delivery stream, and the
  voice lane that speaks a line. Both go to the server you configured.
- If you would rather your own inbox never leave your machine at all, run
  `companion watch-imap --redact` from `@three-ws/companion`: it triages mail
  locally and sends only the sentence that earned an interruption.

## Platform notes

- **macOS**: the window is a `panel`, so it floats over full-screen apps. The
  dock icon is hidden; the app lives in the menu bar. `say` is the last-resort
  voice if the hosted lanes and the built-in speech synthesis both fail.
- **Windows / Linux**: always-on-top with click-through. Transparent windows
  need a compositor; on a bare X11 session without one the window falls back to
  an opaque strip, and the tray menu still works.
- Multi-monitor: the stage tracks the primary display's work area and follows
  resolution changes.

## Related

- [`packages/companion-sdk`](../../packages/companion-sdk) - the client, the triage rules, the CLI, the MCP server.
- [`three.ws/companion`](https://three.ws/companion) - sources, contacts, threshold, quiet hours.
- [`docs/companion.md`](../../docs/companion.md) - the whole system, and every bridge recipe.

## License

Apache-2.0
