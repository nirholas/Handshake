# Cars in `/play`: the Trench Car, ambient traffic, and the drivable fleet

Every coin world in [`/play`](https://three.ws/play) has cars in it. They are not scenery
you walk past: the same car that drives by you on the ring road is the car parked at the
plaza that you can get into and drive across town.

The car is the **Trench Car**, a community model published to the three.ws
avatar gallery ([avatar `e702d59a-d29f-4f21-af8a-6400dd1a2c6f`](https://three.ws/avatars/e702d59a-d29f-4f21-af8a-6400dd1a2c6f),
slug `trench-car`), and it is the *only* car in the world: it is what ambient traffic drives
in every town (frontier ones included), what is parked in all six vehicle bays, and what an
unknown vehicle type falls back to. There is no fleet of mismatched shapes; four procedural
box cars (coupe, sedan, pickup, buggy) used to share the road with it and were retired on
2026-08-17.

## Driving one

1. Walk up to a parked car. Inside 3.4 m a prompt appears over it: **Drive the Trench Car**.
2. Press `F` to take the wheel. On a touch device, tap the car itself.
3. `W` / `S` are throttle and brake (brake from a standstill reverses), `A` / `D` steer,
   `Space` is the handbrake. On touch you get an on-screen pedal and steering cluster
   instead, and the walking joystick steps aside while you drive.
4. The speedometer sits bottom-right and reads real km/h off the simulation.
5. Press `F` again (or tap **Exit**) to step out. You are dropped beside the driver's door.

While you are driving, your avatar sits in the car's seat in a seated pose, and every other
player in the world sees you sitting in it, because the server carries your position and
your `drive` motion with the car.

Roll it onto its roof and it rights itself after a couple of seconds. Drive it at a
pedestrian and they are shoved out of the way rather than driven through.

### Driving jobs

Two of the world's jobs are real driving missions: `cross-town-delivery` (North depot to
South) and `east-west-express`. Both legs only complete if you arrive **in a car**, checked
server-side against the authoritative driver map, so walking to a depot never counts. The
depots sit on the avenue vehicle spawns, so a car is always parked at the start of the run.

## How a car is put together

A car is three things that all have to agree, or it looks wrong or drives wrong:

| Piece | Where it lives | What it owns |
|---|---|---|
| Handling spec | [multiplayer/src/vehicles.js](../multiplayer/src/vehicles.js) | Mass, forces, top speed, dimensions, wheel geometry, suspension, seat. Shared by client and server, so "feels fast" and "rejected as cheating" can never drift apart. |
| Physics chassis | [src/physics/physics-world.js](../src/physics/physics-world.js) | A Rapier raycast vehicle controller built from that spec. |
| The mesh | [src/game/vehicle-mesh.js](../src/game/vehicle-mesh.js), [src/game/vehicle-model.js](../src/game/vehicle-model.js) | What you look at: the GLB, plus the procedural stand-in silhouette that holds its place while the model downloads. |

The mesh group's origin is the **chassis centre**, `+z` is forward, and the four wheels are
pivot/spinner pairs the vehicle controller writes suspension, steering and roll into every
frame. A GLB is authored with its contact patch on the road, so it is dropped into chassis
space by `vehicleRestHeight()`.

A car never blocks the world on a download. `buildVehicleMesh()` returns its
procedural stand-in immediately and swaps the GLB body and wheels into the *same* group and
the *same* wheel pivots when the model lands, so a car that upgrades mid-drive keeps its
physics, its camera and its driver. If the model cannot be fetched at all, the stand-in
stays and the car is still completely drivable.

One template is downloaded and parsed per model for the whole world. Every car clones it,
sharing geometry and textures, and clones only its own brake-light material so one car
braking does not light up the rest.

## Staging the model

The gallery master is a 16 MB studio model: two oversized textures and 263k triangles. That
is unusable on a page every visitor loads, so it is staged into the repo:

```bash
npm run build:trench-car          # fetch from the avatar API, optimize, write public/vehicles/
npm run build:trench-car -- --dry # report the sizes, write nothing
```

[scripts/build-trench-car.mjs](../scripts/build-trench-car.mjs) pulls the master through the
live avatar API (so a re-upload of the same avatar re-stages cleanly, with no storage URL
hardcoded anywhere), decimates the geometry to a game budget, caps the body wrap at 2048px
and the metal-roughness map at 1024px, and writes
`public/vehicles/trench-car.glb` at about 1.4 MB and 99k triangles.

## Adding another car model

1. Publish or pick a GLB whose wheels are four separate nodes named `wheel…` and whose body
   sits with its contact patch at `y = 0`, facing `+z`. Stage it into `public/vehicles/`.
2. Add a type to `VEHICLE_TYPES` with a `model` key, and measure `dims`, `wheel` and
   `suspension` off the mesh. `dims.h` is road-to-roof, not the body's own bounding box.
   Nothing spawns it until a `VEHICLE_SPAWNS` bay names it, and
   `tests/vehicles-trench-car.test.js` pins the fleet as Trench-Car-only, so a second car in
   the world is a deliberate change to that test, not an accident.
3. Check the clearance rule: the chassis collider's underside sits `1.3 * (h / 2)` below the
   body origin, so `vehicleRestHeight()` has to clear it. Too little and the hull rests on
   the road and its own friction pins the car, whatever the engine force says.
4. Map the model key to its URL in `MODEL_URLS` in
   [src/game/vehicle-mesh.js](../src/game/vehicle-mesh.js).
5. Prove it, do not eyeball it:
   ```bash
   node scripts/verify-w02-physics-core.mjs <type>   # real Rapier: does it accelerate, steer, stop?
   npx vitest run tests/vehicles-trench-car.test.js  # spec vs. the staged asset
   npx playwright test tests/e2e/play-vehicles.spec.js
   ```

## Related

- [`/play` NPCs and world life](../src/game/npc/ambient-life.js) drives the ambient lane.
- [The in-game economy](in-game-economy.md) covers what you earn on those delivery runs.
- [`/play` safety and lifecycle invariants](play-hardening.md).
