#!/usr/bin/env bash
# Extract packages/readme-3d into the standalone nirholas/readme-3d repository.
# Run from the three.ws repo root with gh authenticated as an account that can
# create repos under nirholas (the codespace token cannot).
#
#   bash packages/readme-3d/scripts/extract-standalone.sh
#
# Idempotent: re-running force-updates the standalone main from the current
# subtree state. After the first run, enable Pages + topics are already set.
set -euo pipefail

OWNER=nirholas
REPO=readme-3d
PREFIX=packages/readme-3d

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "run from inside the three.ws repo" >&2; exit 1
fi
cd "$(git rev-parse --show-toplevel)"

if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" --public \
   --description "Put interactive, rotatable 3D models in your GitHub README - GLB/glTF/OBJ/STL to the ASCII STL markdown blocks GitHub renders natively. CLI + library + tutorials." \
   --homepage "https://nirholas.github.io/readme-3d/"
fi

echo "splitting subtree $PREFIX ..."
SPLIT_SHA=$(git subtree split --prefix="$PREFIX" HEAD)
git push --force "https://github.com/$OWNER/$REPO.git" "$SPLIT_SHA:refs/heads/main"

echo "configuring repo metadata ..."
gh api -X PUT "repos/$OWNER/$REPO/topics" \
 -f 'names[]=readme' -f 'names[]=markdown' -f 'names[]=3d' -f 'names[]=stl' \
 -f 'names[]=glb' -f 'names[]=gltf' -f 'names[]=github-readme' -f 'names[]=3d-models' \
 -f 'names[]=mesh-simplification' -f 'names[]=ascii-stl' -f 'names[]=readme-badge' \
 -f 'names[]=claude-skill' >/dev/null

# GitHub Pages from /docs on main (no Actions involved)
gh api -X POST "repos/$OWNER/$REPO/pages" \
 -f 'source[branch]=main' -f 'source[path]=/docs' >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO/pages" \
      -f 'source[branch]=main' -f 'source[path]=/docs' >/dev/null

echo "done:"
echo "  repo   https://github.com/$OWNER/$REPO"
echo "  pages  https://nirholas.github.io/$REPO/  (first build takes a minute)"
echo
echo "npm publish (needs npm login as an owner of the readme-3d name):"
echo "  cd $PREFIX && npm publish --access public"
