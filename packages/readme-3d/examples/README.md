# Examples

Each page embeds a live, draggable 3D model - GitHub renders them natively, no plugins.

| Example | Facets | Block size | Shows |
| --- | ---: | ---: | --- |
| [Cube](cube.md) | 12 | 1.7 KB | the minimal hand-writable case |
| [Torus](torus.md) | 700 | 101 KB | parametric mesh, 70% simplification |
| [Avatar](avatar.md) | 1,200 | 172 KB | AI-generated character, 88% simplification |

The source ASCII STL files live in [`models/`](models/) - GitHub's file viewer renders those interactively too (click one).

Regenerate any of them from the repo root:

```bash
node bin/readme3d.js examples/models/torus.stl --facets 700 --name torus -o examples/torus.md
```

(The `.md` files here add context around the CLI output; the STL blocks themselves are verbatim CLI output.)
