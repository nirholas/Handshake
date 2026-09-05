# Pocket Console

[**`/pocket`**](https://three.ws/pocket) is a handheld console with a real 3D
agent living inside the screen. The D-pad walks it. A waves, B jumps. L and R
change the cartridge, which means changing which public three.ws agent is loaded.
START swaps the screen between the agent walking, its live stats, and a menu of
every public agent you can slot in. And one `<iframe>` puts the whole device,
your agent included, on any website.

Nothing on the device is a picture of a device. The screen is a live
[`/walk-embed`](https://three.ws/walk-embed) frame running the same renderer,
retargeting and animation library the rest of the platform uses, so the body in
there is the agent's actual rigged GLB, animated by the shared clip library.

## Using it

| Control | Keyboard | Gamepad | What it does |
| --- | --- | --- | --- |
| D-pad | `W` `A` `S` `D` / arrows | left stick or D-pad | Walks the agent. On the SELECT cartridge it moves the highlight instead. |
| Run | `Shift` | either trigger | Holds a run while you steer. |
| A | `K` | A | Waves. On the SELECT cartridge it loads the highlighted agent. |
| B | `J` | B | Jumps. From a menu cartridge it drops back to PLAY. |
| START | `Enter` | Start | Next cartridge: PLAY, STATS, SELECT. |
| SELECT | `Space` | Select | Next scene: night, studio, sunset, grid. |
| L / R | `Q` / `E` | LB / RB | Previous / next agent on the shelf. |
| Power | `P` | none | Turns the screen off, and off means off: the frame is unmounted and the WebGL context goes with it. |

Plug a controller in and the pill on the shell lights up; the on-screen buttons
animate with your presses either way. Everything also works by touch, which is
the point of a handheld.

## The three cartridges

- **PLAY** is the agent walking around a small world. It is the default.
- **STATS** reads the agent record live: skills, how many of them are paid
  (priced through [x402](x402.md)), conversations, whether it has a rigged body,
  its on-chain identity if it has one, and the day it was created.
- **SELECT** is a game menu of the public agent index. Steer it with the D-pad,
  press A to slot one in.

The shelf under the device does the same job with a mouse. Both read
`GET /api/agents/public`, so every cartridge is an agent somebody actually
built and published.

## Sharing one

The URL carries the console's state, so a link is the device exactly as you left
it:

```
https://three.ws/pocket?agent=<agent id>&shell=indigo&env=sunset
```

| Param | Values | Effect |
| --- | --- | --- |
| `agent` | any public agent id | Which agent boots. A link to an agent outside the first page of the index still works: the page reads that one record directly and puts it at the head of the shelf. |
| `shell` | `graphite` `bone` `clear` `indigo` | The plastic. |
| `env` | `night` `studio` `sunset` `grid` | The scene inside the screen. |
| `cart` | `play` `stats` `select` | Which cartridge is mounted. |
| `chrome` | `off` | Embed mode: the device alone, transparent background, no nav, no footer, no language pill. |

**Copy share link** and **Post on X** in the header both build that URL from
whatever is currently loaded.

## Embedding it

`chrome=off` is the whole embed API. The device fills the frame, the background
is transparent so it sits on your own page's colour, and it runs on any origin:

```html
<iframe
  src="https://three.ws/pocket?agent=<agent id>&shell=graphite&env=night&chrome=off"
  width="440" height="640"
  title="My agent on three.ws"
  style="border:0;background:transparent"
  allow="xr-spatial-tracking"
  loading="lazy"></iframe>
```

The **Copy embed code** button on the page writes exactly that snippet with your
current agent, shell and scene already in it.

Two details worth knowing if you are embedding rather than linking:

- The console addresses the body by avatar id, which streams the GLB through the
  same-origin proxy (`/api/avatars/:id/glb`). That is why an embedded console
  renders the same on your domain as it does on three.ws: the raw model URL is
  served from a bucket that only answers three.ws.
- The screen runs the walk embed at `zoom=0.74`. A chase camera framed for a
  full-bleed hero leaves a lot of empty sky in a 4:3 handheld window; the
  [`zoom` param](tutorials/walk-companion.md#embed-query-params) pulls it in.

## Where it fits

- [`/walk`](https://three.ws/walk) is the same engine full-bleed, with the
  one-tag iframe and the postMessage contract documented in
  [the walk embed API](https://three.ws/docs/walk-embed-api).
- [`/agents/:id`](https://three.ws/agents) is the canonical page for any agent
  you meet on a cartridge.
- [`/create`](https://three.ws/create) is where a new one comes from. An agent
  with a rigged body shows up on the shelf as soon as it is public.

Source: [`pages/pocket.html`](../pages/pocket.html),
[`src/pocket.js`](../src/pocket.js), [`src/pocket.css`](../src/pocket.css).
