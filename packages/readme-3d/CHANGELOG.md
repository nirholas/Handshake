# Changelog

## 0.1.0 - 2026-07-13

Initial release.

- Convert GLB, glTF (incl. Draco and meshopt compression), OBJ, binary STL, and ASCII STL into GitHub-renderable ASCII STL markdown blocks.
- Mesh welding + three-stage simplification (meshoptimizer) to a `--facets` or `--budget` target: floater pruning, quadric simplification, and a topology-ignoring sloppy fallback that guarantees the target on disconnected meshes.
- Coordinate normalization, Y-up → Z-up correction, precision trimming.
- `readme-3d check` - size-check any markdown file against GitHub's 512 KB render limit.
- Library API: `convert`, `toMarkdown`, `checkMarkdownFile`, plus geometry/parser primitives.
- Tutorials, examples, a GitHub Pages site, and a Claude Code skill.
