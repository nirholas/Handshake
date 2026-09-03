# Club venue asset provenance

This file records the source + license of every third-party asset bundled
under `public/club/venue/`. Required by the project's commercial-use rules
(see `/CLAUDE.md` and the club campaign's venue work order, retired from
`prompts/` once shipped; it is readable in git history).

Each entry must include:

- **File** — the path under `public/club/venue/`.
- **Source** — original URL or product page.
- **Author / Studio** — credit line as required by the license.
- **License** — full SPDX identifier or named license. Must permit
  commercial use + redistribution as part of a bundled web app.
- **Modifications** — any edits made in Blender (named-empty injection,
  scale normalisation, AO bake, draco compression, etc.).

## Required slots

The `/club` runtime expects the following files. Each is loaded
unconditionally — a 404 surfaces an error in the UI; the page does not
fall back to primitives.

### `club-venue.glb`

The authored nightclub interior. Required contents:

- Floor with PBR varnish material (scuffed roughness map).
- Four perimeter walls with alcove offsets.
- Ceiling with exposed beams, ducts, and a lighting truss.
- Bar geometry with bottles + neon backsplash.
- Backstage door / curtain props on the deep wall, one per dancer slot.
- Crowd silhouettes lining the perimeter (instanced).

Required named empties (the runtime reads world positions from these).
Names use underscores rather than dots — three.js's `PropertyBinding`
sanitizer strips `[`, `]`, `.`, `:`, `/` from every loaded node name,
so a Blender empty called `truss.spot.01` arrives at runtime as
`trussspot01`. Author with the underscored form.

- `truss_mirrorball` — anchor for the disco ball (prompt 04).
- `truss_spot_01`–`truss_spot_04` — fixture mounts for the four
  per-pole spotlights (overrides the analytical `layout.x, 6, layout.z`
  in `src/club.js`).
- `stage_01`–`stage_04` — center of each pole stage. Overrides the
  analytical `STAGE_RADIUS`-based positions.
- `backstage_door_01`–`backstage_door_04` — dancer spawn points,
  one per slot. Overrides `backstageX, backstageZ`.
- `bar_backsplash_neon` — anchor for the emissive strip behind the bar
  (prompt 04).

### `club-hdri.hdr`

Equirectangular HDR for `scene.environment`. Affects PBR reflections
only — `scene.background` stays the dark fog color. Suggested sources:

- Polyhaven (CC0): https://polyhaven.com/hdris/indoor/nightlife
- Greg Zaal nightclub set (CC0).

---

## Entries

<!--
Append one block per file in the form:

### `<filename>`
- **Source**: <url>
- **Author**: <name>
- **License**: <SPDX or named>
- **Modifications**: <list>
-->

_No assets recorded yet. Once `club-venue.glb` and `club-hdri.hdr` are
dropped into `public/club/venue/`, fill in the entries above with
provenance for each file before pushing._
