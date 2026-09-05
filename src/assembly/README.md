# Machine Atlas geometry (`src/assembly/`)

The code behind [three.ws/assembly](https://three.ws/assembly). Two machines,
no model files: everything on that page is generated in the browser from a
handful of dimensions when the page loads, and regenerated whenever a slider
moves.

If you have only read the page, the short version is: dimensions become
profiles, profiles get revolved or extruded, a few surfaces are lofted, and the
motion is solved from the same numbers rather than played back from a clip.

## Layout

| File | What it holds |
|---|---|
| `parts.js` | The parametric vocabulary: revolves, extrusions, sweeps, lofts, merging. No machine knowledge. |
| `rig.js` | The explode runtime and the linkage solvers (`slider`, `circleIntersect`, `slideOnLine`, `placeLink`, `alignSegment`). |
| `materials.js` | One shared palette. Machines own their geometry but never their materials. |
| `radial-engine.js` | Machine 01: a single-row air-cooled radial aero engine. |
| `locomotive.js` | Machine 02: an outside-cylinder steam locomotive with return-crank valve gear. |

The page shell (`src/assembly.js`, `src/assembly.css`, `pages/assembly.html`)
owns the renderer, the panels and the URL state. It knows nothing about either
machine beyond the contract below.

## The machine contract

Every machine module exports three things:

```js
export const spec = {
  id: 'radial',                    // stable, used in the ?m= query parameter
  name: 'Radial Nine',
  subtitle: 'Air-cooled radial aero engine',
  era: '1932',
  blurb: '...',                    // one paragraph, shown under the title
  facts: [['Layout', 'Single-row radial, four-stroke']],
  params: [                        // one slider each, in panel order
    { key: 'bore', label: 'Bore', min: 110, max: 175, step: 1, value: 155, unit: 'mm' },
  ],
  camera: { position: [2.7, 1.15, 1.55], target: [0, 0, 0.15], radius: 2.1 },
};

// Pure: the seven values the user controls in, every dimension the builder
// needs out. Keeping it pure is what makes the readout, the code panel and the
// geometry agree by construction.
export function derive(values) { /* ... */ }

// The Source panel. Printed from the live values, so it cannot drift away from
// the geometry the way a pasted snippet would.
export function codeFor(values) {
  return [{ label: 'Cylinder barrel', code: 'finnedBarrel({ ... })' }];
}

// Build the tree. `update(angle)` is called every frame with the crank angle in
// radians; `readout` is the derived-values list shown under the sliders.
export function build(values) {
  return { root: THREE.Group, update(angle) {}, readout: [['Displacement', '29.7 L']] };
}
```

Register a new machine by adding it to the `MACHINES` array in
`src/assembly.js`. Nothing else in the page needs to change: the tabs, the
sliders, the parts list, the readout, the code panel, the URL state and the GLB
export all read from the contract.

## Building a part

`parts.js` covers the four ways a machine part gets made. A worked example of
each:

```js
import { lathe, finnedBarrel, roundedBox, rodGeometry, railGeometry, loftedBlade } from './parts.js';

// Revolve a profile about +Y. Profiles are [radius, axial] pairs.
const dome = lathe([[0, 0], [0.34, 0], [0.36, 0.16], [0.24, 0.4], [0, 0.42]]);

// A sawtooth revolve: the fins are part of the same surface as the barrel,
// which is how a real casting works.
const barrel = finnedBarrel({ bore: 0.155, finRoot: 0.086, finTip: 0.114, length: 0.31, fins: 30 });

// Extrude a cross-section. A rail is one closed profile swept down the track.
const rail = railGeometry(21.0);

// A waisted stadium: a connecting rod running +X from a big end at the origin.
const rod = rodGeometry({ length: 0.35, bigEndR: 0.037, smallEndR: 0.019, thickness: 0.025 });

// Loft NACA sections with twist and taper into a propeller blade.
const blade = loftedBlade({ span: 1.0, chordRoot: 0.19, chordTip: 0.1, twistRoot: 34, twistTip: 8 });
```

Everything is in metres. A driving wheel really is 1.68 m across.

## Solving motion instead of animating it

`rig.js` holds the three solvers the machines share. They are the reason the
page behaves like a mechanism rather than like a loop:

```js
import { slider, slideOnLine, circleIntersect } from './rig.js';

// Piston on a cylinder axis, driven by a crankpin: the exact planar
// slider-crank, so a long rod visibly dwells at top dead centre.
const c = slider(crankpin, cylinderAxis, rodLength);

// A pin constrained to a horizontal line, reached by a link: the crosshead and
// the valve spindle both ride lines like this.
const crosshead = slideOnLine(crankpin, centrelineY, mainRodLength);

// Close a four-bar chain. Returns null when the links cannot reach, so a bad
// parameter set holds its last pose instead of producing NaN geometry.
const lowPin = circleIntersect(eccentricPin, eccRodLen, pivot, armLength, branch);
```

Pick the intersection branch once, at build time, and keep it. A branch chosen
per frame flips at dead centre and snaps the linkage through itself.

One consequence worth knowing if you add a machine with valve gear: the return
crank has to be nearly as long as the main crank and set well past a right
angle. The eccentric the gear actually sees is the vector sum of the two, and
that sum has to be small. `RETURN_CRANK_ANGLE` in `locomotive.js` is where that
lives.

## Explode

Parts carry their own explode vector, so taking a machine apart is one lerp over
the tree rather than a hand-keyed animation:

```js
import { part, applyExplode } from './rig.js';

group.add(part(geometry, MATERIALS.castIron, {
  name: 'barrel',              // shown when the part is hovered
  group: 'cylinders',          // subassembly, shown as a toggle chip
  explode: new THREE.Vector3(0, 0.16, 0),   // where it goes at factor 1
}));

applyExplode(root, 0.5);       // halfway apart
```

A part whose position is written every frame by `update()` must copy its new
position into `userData.rest`, or the next explode will pull it back to where it
was at build time. `placeLink` and `alignSegment` do this for you.

## Tests

`tests/assembly-machines.test.js` covers the two failure modes that matter: a
build that produces non-finite vertices at some parameter combination, and a
linkage that cannot close. Both machines are built at every parameter extreme
and the locomotive's four-bar is solved through a full revolution for each.

```bash
npx vitest run tests/assembly-machines.test.js
```

## Related

- `/assembly` is listed in `data/pages.json` under the `labs` section.
- `STRUCTURE.md` maps this directory to the surface it powers.
- The GLB export uses three's `GLTFExporter`; the result opens in `/viewer`.
