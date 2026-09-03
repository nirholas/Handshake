# The live 3D home

`/smart-home/<home id>` is a live 3D model of your house, driven by your own
Home Assistant. Every room is lit the way the real room is lit, every door and
lock is drawn in the state it is really in, and your agent stands in it.

It is also, deliberately, a house you can operate: click anything, act on it,
and the physical-action gate asks before it opens anything. The same page in its
2D view does all of that without a GPU.

**Related:** [three.ws Home](smart-home.md) (why any of this exists),
[connecting a house](tutorials/connect-your-home.md),
[households and roles](home-households.md), [home security](home-security.md).

---

## Getting there

| URL | What it is |
|---|---|
| `/smart-home` | your connected homes, and the form that adds one |
| `/smart-home/<id>` | this page: the live house |
| `/smart-home/<id>/settings` | that home's grants, action log and disconnect |
| `/home/<id>` | the same live house, at the campaign's own address |

You need a connected home first. [The tutorial](tutorials/connect-your-home.md)
takes about three minutes.

## What you are looking at

Home Assistant does not store any geometry. It stores four flat registries:
floors, areas, devices and entities. Everything spatial on this page is derived
from those, by [`src/home/scene-model.js`](../src/home/scene-model.js), which is
a pure function with no Three.js in it and a test suite that asserts the layout
of a real recorded house without a GPU.

| What the house says | What the scene draws |
|---|---|
| a floor, with a level | a slab; floors stack in level order, 4.6 m apart |
| an area | a room on that slab, packed in a grid, ordered by name |
| the room's lights (how many on, mean brightness, mean colour) | that room's actual light: colour, intensity, and genuinely dark when they are all off |
| the room's temperature | a readable value on the room's label, and a warm or cool tint on its thermostat |
| the room's locks, covers and door sensors | the outline around the room: green when it is buttoned up, amber the moment something is unlocked or open |
| a light, lock, cover, climate, media player, fan, camera, vacuum, switch or alarm | an object placed on the ceiling, a wall or the floor, in that room |
| a numeric sensor | a line in the room's readout, not an object |
| `unavailable` | the object, drawn as a ghost of itself with a marker. Never omitted. |

### Why a room does not draw everything in it

A room with sixty entities is not sixty objects. What a person cares about is
ranked: lights, locks, covers, climate, alarms, media, fans, cameras, then
everything else. The room draws up to six ceiling objects, ten wall objects and
six floor objects, cutting from the bottom of that ranking, and reports the rest
as "N more devices in this room". Sensors never become objects at all; they
become numbers.

### A house where nothing is in a room

Very common, and it is a designed state rather than an empty screen. Every
unfiled entity goes into one room called "Everything", with the same lighting,
climate and security rollups a real room gets, and the page offers a link
straight to Home Assistant's own Areas screen. The house is fully usable before
anyone has filed a thing.

## Reactivity

The page holds one Server-Sent Events subscription to
`GET /api/home/<id>/stream` ([the API reference](api-reference.md)). It never
polls.

Measured against a real Home Assistant on the same machine:

| Leg | Measured |
|---|---|
| Home Assistant service call to the SSE `graph` frame | 86 ms median, 92 ms worst of six |
| that frame to the painted frame carrying it | 10 to 23 ms median across a ten minute run |
| the page's own per-frame work, 6 rooms and 35 objects | 0.1 to 0.3 ms |

Nothing pops. Every visual quantity (a light's intensity and colour, a cover's
openness, a lock's colour, the stale fade) is a spring toward a target, damped
framerate-independently, so a light comes up rather than snapping on.

`window.__homeScene` exposes `model`, `status`, `latency` and `stats()` for
anyone measuring this themselves.

## When the house goes away

The rule that outranks everything else on this page: **the house never empties.**

A connection that drops greys the scene, keeps every room exactly as it was, and
says how old it is ("Last seen 28 seconds ago"). A person watching their home
should see it go grey, not watch it vanish.

The status pill has four states, and the distinction between the middle two is
deliberate:

| Pill | Means |
|---|---|
| Live | the stream is delivering |
| Stale | the house dropped and the platform is retrying. Nothing for you to do but read the age. |
| Disconnected | nobody is retrying: the token stopped working, or this browser's stream is gone. This is the state with a button. |
| Connecting | opening |

A house that is unplugged sends no goodbye, so the socket looks open until TCP
gives up: 42 seconds, measured. The bridge therefore pings the house every ten
seconds with a five second deadline, which brings that down to 15 seconds worst
case. Killing a real container mid-stream and watching the raw event feed:

```
+  6.6s >>> docker kill (abrupt: no FIN, exactly what an unplugged house looks like)
+ 21.4s event: status {"status":"unreachable","connected":false,"stale":true,...}
+ 46.3s >>> docker start
+ 59.4s event: status {"status":"connected","connected":true,"stale":false}
+ 59.5s event: graph  rooms=5 entities=67
```

Nothing in the browser did anything in between, and the house was on screen the
whole time.

## Acting on the house

Click any object, or any row in the 2D view, and the panel offers what that
device can actually do. Reads are free. Writes that open the house stop and ask.

A guarded action answers `409` with the resolved entity, and the page renders
the question **on the thing it would move**, not in a toast in a corner:

> **OPENS YOUR HOME**
> unlock Front Door?
> "unlock" on lock.front_door cannot be safely undone remotely.
> [Yes, do it] [Cancel]  ☐ Do not ask again for Front Door

Ticking that box writes a standing allowance for that one entity, through
`POST /api/home/<id>/grants`. It is per entity and per direction, never per
domain: letting the agent open the office door has nothing to do with the front
door.

Locking up, closing a cover and arming an alarm never ask.

## The 2D house

Not a consolation prize. It renders the same scene model with real rows and real
buttons, it can read and operate the whole house, and it is the accessibility
path, the old-device path and the "WebGL is blocked by policy" path.

You reach it three ways:

1. The **2D** button in the top bar, or `?view=2d`. The choice is remembered.
2. **Automatically**, when the browser has no WebGL at all. The page says so
   rather than showing a black canvas.
3. **Automatically**, when this device measurably cannot hold 18 frames a second
   after six seconds of trying. It says what it measured. If you asked for the
   3D view explicitly, it tells you the number and leaves your choice alone.

## Performance

| Quantity | Where it stands |
|---|---|
| Draw calls, 6 rooms and 35 objects | 108 |
| Geometries / textures | 25 / 34 |
| Per-frame update work | 0.1 to 0.3 ms |
| Heap over ten minutes of live updates, 144 real device changes | flat at 45.20 MB, object count, geometry count and texture count all unchanged |

Geometry is shared per kind, materials are per object and disposed with it, a
room's four walls are one merged geometry rather than four meshes, and the
"unreachable" marker is built the first time a device actually goes missing, so
a healthy house pays nothing for it. Updates are diffed by entity id: a burst of
a hundred entity changes touches a hundred numbers and rebuilds nothing.

The frame rate is governed: 60 focused, 30 in a background tab, 30 under the
platform-wide power-saver switch.

## Keyboard and screen readers

The room rail is a list of real buttons, in floor order. Every action is a
button with an accessible name that includes the device and its room ("Turn off
Kitchen Lights in Kitchen"). The confirmation is an `alertdialog` that takes
focus, answers Escape, and is dismissed by Cancel. Every state change the person
did not cause is announced through one polite live region: a light that changed,
a stream that dropped, a device that stopped answering, a frame rate that forced
the 2D view.

## Motion, the screen, and the notch

**Reduced motion.** `prefers-reduced-motion: reduce` turns every transition in
the scene off without freezing it. The house is a live readout, so the values
keep updating; they stop travelling to their new state. Every damped quantity in
the render loop (light intensity, room highlight, the security tint, the stale
desaturation, and each room's colour) passes through one `damp()` call, which
returns the target directly under the preference, and OrbitControls stops
coasting after a drag. The preference is watched, not read once: turning it on
in the OS takes effect without a reload.

**The screen stays awake, and only here.** A kitchen tablet showing the house is
the surface this page was built for, and a display that blanks every thirty
seconds is not a display. `/home/:id` takes a [Screen Wake
Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
while it is visible. None of the other home pages do: they are read-and-leave
surfaces. The lock is released the moment the document is hidden and re-taken
when it comes back, so a phone is never held awake by a tab nobody is looking
at. Absent API, or a refusal on low battery, changes nothing about the scene and
is never surfaced.

**Right-to-left and the notch.** The stylesheet is direction-agnostic: the rail
and inspector dividers, list indents and notice accents are logical properties,
so an Arabic or Hebrew locale mirrors the whole layout from `dir` alone. The
page opts into `viewport-fit=cover` so the house can fill a notched phone edge
to edge, which means the bar, rail and inspector carry `env(safe-area-inset-*)`
padding through `max()`: full bleed on a notched device, ordinary padding
everywhere the inset is zero.

## Extending it

- **`src/home/scene-model.js`** is pure. A new domain becomes a case in
  `placementOf`, `kindOf` and `activityOf`, plus a test in
  `tests/home-scene-model.test.js` against the recorded house.
- **`src/home/scene-render.js`** owns Three.js. A new visual kind is a case in
  `buildObject` (its meshes) and one in `commitObject` (what its state does to
  them).
- **`src/home/scene-fallback.js`** owns the 2D house. A newly controllable
  domain is one entry in its `CONTROLS` table.
- An authored floorplan overrides the default packing: pass
  `buildSceneModel(graph, { layout: { [roomId]: { x, z, w, d } } })`. That is
  the seam the floorplan editor writes into.

## Tests

```bash
npx vitest run tests/home-scene-model.test.js   # the layout of a real house, no GPU
npm run test:home:e2e                            # the whole lane, including tests/e2e/home-scene.spec.js
```

The e2e journeys drive a real Home Assistant container: the scene renders the
real house, a real light changed in Home Assistant reaches the rendered scene,
the house survives its connection being killed, a browser with no WebGL can
still operate it, and a burst of twenty real service calls grows nothing.
