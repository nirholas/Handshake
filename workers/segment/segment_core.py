"""
Geometry-based part segmentation for triangle meshes.

Why geometry, not a learned model
---------------------------------
A learned 3D part-segmentation network (e.g. PartField / SAM-3D via a GPU
worker) can attach human labels ("head", "arm") but it brings a hard GPU
dependency, non-determinism, and an external-availability risk — and it still
fails on the long tail of stylised, low-poly, or non-organic meshes the forge
pipeline produces. Convex decomposition (CoACD/VHACD) over-fragments organic
shapes into dozens of convex shards that are not the parts a human would name.

We instead segment on the geometry the mesh already carries, which is fast,
deterministic, GPU-free (consistent with the CPU remesh worker), and works on
any topology:

  1. Connected components first. Anything physically disjoint — wheels, eyes,
     a weapon, loose accessories — separates immediately and perfectly.

  2. The minima rule within each connected component. Human shape perception
     segments objects at concave creases (Hoffman & Richards, 1984). We cut the
     face-adjacency graph along strong concave edges, then take the connected
     components of what remains. This finds the natural seam between a limb and
     a torso, a handle and a body, a wheel-arch and a fender.

  3. Cleanup. Tiny shards are merged back into their largest neighbour, and the
     part count is capped by repeatedly merging the smallest part into its
     largest neighbour — so the output is a handful of meaningful parts, not a
     thousand crease fragments.

Parts are named by their spatial region (top / lower-left / core …) so the
labels read meaningfully in the viewer, and each part is tinted a distinct hue
so segmentation is visible even on an untextured mesh.
"""

from __future__ import annotations

import colorsys
import heapq
import math
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


class SegmentInputError(ValueError):
    """A caller's fault, described in terms the caller can act on.

    Distinct from a bare ValueError so the service can echo THESE messages
    verbatim while keeping every unexpected failure opaque. A library-internal
    ValueError must never reach a client; "part 'part_99' not found. Available:
    ..." always should.
    """


class SegmentTimeout(RuntimeError):
    """Raised when segmentation exceeds its wall-clock budget.

    A segmentation nobody is still waiting for is worse than a failure: the
    caller has long since given up, but the job keeps a worker slot and its
    memory pinned. We stop and say so instead.
    """


def _check_deadline(deadline: Optional[float], stage: str) -> None:
    if deadline is not None and time.monotonic() > deadline:
        raise SegmentTimeout(
            f"segmentation exceeded its time budget during {stage}; "
            "retry with a lower max_parts, a higher min_part_faces, or a "
            "decimated mesh"
        )

# A perceptually spread palette — distinct adjacent hues, golden-ratio stepped
# so even 20+ parts stay visually separable.
_GOLDEN = 0.61803398875


def _palette(n: int) -> list[tuple[int, int, int]]:
    colors = []
    h = 0.08
    for _ in range(max(n, 1)):
        r, g, b = colorsys.hsv_to_rgb(h % 1.0, 0.62, 0.95)
        colors.append((int(r * 255), int(g * 255), int(b * 255)))
        h += _GOLDEN
    return colors


@dataclass
class Part:
    index: int
    name: str
    mesh: "trimesh.Trimesh"
    color: tuple[int, int, int]
    region: str

    def manifest(self) -> dict:
        b = self.mesh.bounds  # (2,3) min,max
        centroid = self.mesh.centroid
        return {
            "id": f"part_{self.index:02d}",
            "name": self.name,
            "region": self.region,
            "face_count": int(len(self.mesh.faces)),
            "vertex_count": int(len(self.mesh.vertices)),
            "bbox": {
                "min": [float(x) for x in b[0]],
                "max": [float(x) for x in b[1]],
            },
            "centroid": [float(x) for x in centroid],
            "volume": float(abs(self.mesh.volume)) if self.mesh.is_volume else 0.0,
            "color": "#%02x%02x%02x" % self.color,
        }


@dataclass
class SegmentationResult:
    parts: list[Part]
    source_faces: int
    method: str
    warnings: list[str] = field(default_factory=list)


# ── mesh loading / normalisation ──────────────────────────────────────────────


def load_concatenated(data: bytes, suffix: str) -> "trimesh.Trimesh":
    """Load a mesh or scene and return a single Trimesh.

    A glTF scene's own node split is *not* a reliable part split — exporters
    routinely emit a whole character as one node, or shatter it into per-material
    nodes. We concatenate to a single mesh and re-derive parts from geometry so
    the result is consistent regardless of how the source was authored.
    """
    import io

    loaded = trimesh.load(
        io.BytesIO(data),
        file_type=suffix.lstrip("."),
        force="mesh",
        process=True,
    )
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise SegmentInputError("no triangle geometry found in the model")
        mesh = trimesh.util.concatenate(meshes)
    else:
        mesh = loaded
    if mesh.faces is None or len(mesh.faces) == 0:
        raise SegmentInputError("mesh has no faces to segment")
    mesh.merge_vertices()
    return mesh


# ── core segmentation ─────────────────────────────────────────────────────────


def _crease_labels(mesh: "trimesh.Trimesh", crease_angle_rad: float) -> np.ndarray:
    """Label faces by minima-rule region growing.

    Faces stay connected across an edge unless that edge is concave and its
    dihedral angle exceeds the threshold; the connected components of the
    surviving graph are the regions.
    """
    n_faces = len(mesh.faces)
    adjacency = mesh.face_adjacency  # (E, 2)
    if len(adjacency) == 0:
        return np.zeros(n_faces, dtype=np.int64)

    angles = mesh.face_adjacency_angles  # (E,) radians, unsigned
    convex = mesh.face_adjacency_convex  # (E,) bool, True where the edge bulges out

    # The minima rule: cut only at *concave* creases sharper than the threshold.
    cut = (~convex) & (angles > crease_angle_rad)
    keep = adjacency[~cut]

    if len(keep) == 0:
        # Every interior edge is a sharp concave crease — nothing to grow.
        return np.arange(n_faces, dtype=np.int64)

    rows = np.concatenate([keep[:, 0], keep[:, 1]])
    cols = np.concatenate([keep[:, 1], keep[:, 0]])
    data = np.ones(len(rows), dtype=np.uint8)
    graph = coo_matrix((data, (rows, cols)), shape=(n_faces, n_faces))
    _, labels = connected_components(graph, directed=False)
    return labels


def _label_adjacency(mesh: "trimesh.Trimesh", labels: np.ndarray) -> dict[int, set[int]]:
    """Which labels touch which, via the full face-adjacency graph.

    Vectorised: the unique boundary label-pairs are computed in numpy, so the
    Python loop runs once per distinct pair rather than once per boundary edge.
    """
    neighbours: dict[int, set[int]] = {}
    fa = mesh.face_adjacency
    if len(fa) == 0:
        return neighbours
    la = labels[fa[:, 0]]
    lb = labels[fa[:, 1]]
    diff = la != lb
    if not diff.any():
        return neighbours
    lo = np.minimum(la[diff], lb[diff])
    hi = np.maximum(la[diff], lb[diff])
    pairs = np.unique(np.stack([lo, hi], axis=1), axis=0)
    for a, b in pairs:
        neighbours.setdefault(int(a), set()).add(int(b))
        neighbours.setdefault(int(b), set()).add(int(a))
    return neighbours


def _merge_small_and_cap(
    mesh: "trimesh.Trimesh",
    labels: np.ndarray,
    min_part_faces: int,
    max_parts: int,
    deadline: Optional[float] = None,
) -> np.ndarray:
    """Merge sub-threshold parts into their largest neighbour, then cap count.

    Both passes preserve the same policy the segmenter has always applied:
    always dissolve the SMALLEST offending region first, always into its
    LARGEST neighbour. Only the bookkeeping changed.

    The obvious implementation of that policy is accidentally cubic, and it
    took production down: it rebuilt the whole label-adjacency map and rescanned
    the full label array on every single merge, so a mesh with R crease regions
    paid O(R) merges x O(F + E) rebuild. Measured on a noisy sphere: 5 k faces
    took 7 s, 20 k faces took 328 s, and real forge meshes (100 k+ faces, tens
    of thousands of crease shards) ran for 2.9 to 4 HOURS per job, long past any
    caller's patience, and pushed the 16 GiB instance into repeated OOM kills.

    Instead we keep the regions in a union-find, keep their neighbour sets
    incrementally (small-set-into-large, so the total set work stays near
    linear), and drive both passes off one lazily-invalidated min-heap. The
    label array is rewritten exactly ONCE, at the end. Same output, and the
    20 k-face case drops from 328 s to well under a second.
    """
    labels = np.asarray(labels)
    # Work in a dense 0..K-1 label space so sizes and parents can be arrays.
    uniq, compact = np.unique(labels, return_inverse=True)
    compact = compact.reshape(-1).astype(np.int64)
    k = int(len(uniq))
    if k <= 1:
        return compact

    sizes = np.bincount(compact, minlength=k).astype(np.int64)
    adjacency = _label_adjacency(mesh, compact)
    adj: dict[int, set[int]] = {i: adjacency.get(i, set()) for i in range(k)}

    parent = list(range(k))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:  # path compression
            parent[x], x = root, parent[x]
        return root

    alive = set(range(k))
    heap: list[tuple[int, int]] = [(int(sizes[i]), i) for i in range(k)]
    heapq.heapify(heap)

    def largest(candidates) -> int:
        """The biggest region among `candidates`, ties broken by lowest label.

        The tie-break is not cosmetic. Picking the winner by iterating a Python
        set makes the choice depend on hash order, so two runs over the same
        mesh could return differently grouped parts. Segmentation is a user
        visible result; it has to be reproducible.
        """
        return max(candidates, key=lambda c: (int(sizes[c]), -c))

    def live_neighbours(root: int) -> set[int]:
        """Neighbour roots of `root`, resolved through the union-find.

        Stale entries are rewritten in place, so each one is only ever
        resolved once and repeated reads stay cheap.
        """
        resolved = {find(n) for n in adj[root]}
        resolved.discard(root)
        adj[root] = resolved
        return resolved

    def merge(src: int, dst: int) -> None:
        """Fold region `src` into `dst`; `dst` survives."""
        parent[src] = dst
        sizes[dst] += sizes[src]
        sizes[src] = 0
        alive.discard(src)
        src_adj = adj.pop(src)
        dst_adj = adj[dst]
        # Union the smaller set into the larger one so the total work across
        # all merges stays near linear rather than quadratic.
        if len(src_adj) > len(dst_adj):
            src_adj, dst_adj = dst_adj, src_adj
        for n in src_adj:
            root = find(n)
            if root != dst:
                dst_adj.add(root)
        dst_adj.discard(dst)
        adj[dst] = dst_adj
        heapq.heappush(heap, (int(sizes[dst]), dst))

    def pop_smallest_live() -> Optional[tuple[int, int]]:
        """Smallest live region as (size, label), skipping stale heap entries.

        Every merge pushes a fresh entry for the survivor, so a live region has
        exactly one current entry: any popped entry that disagrees with the
        live size, or names an absorbed region, is stale and discarded.
        """
        while heap:
            size, label = heapq.heappop(heap)
            if label in alive and size == int(sizes[label]):
                return size, label
        return None

    # Regions with no neighbour left to merge into: parked so the passes below
    # can never spin on them.
    stuck: set[int] = set()

    def park(entry: tuple[int, int]) -> None:
        stuck.add(entry[1])

    # Pass 1: dissolve shards below the face floor, smallest first.
    while len(alive) - len(stuck) > 1:
        _check_deadline(deadline, "small-part merge")
        entry = pop_smallest_live()
        if entry is None:
            break
        size, label = entry
        if label in stuck:
            continue
        if size >= min_part_faces:
            heapq.heappush(heap, entry)  # nothing smaller is left to dissolve
            break
        neighbours = live_neighbours(label)
        if not neighbours:
            park(entry)
            continue
        merge(label, largest(neighbours))

    # Islands parked above still count against the cap, so give them back to
    # the heap before pass 2 can be asked to fold them.
    for label in stuck:
        heapq.heappush(heap, (int(sizes[label]), label))
    stuck.clear()

    # Pass 2: cap the part count, again smallest into largest neighbour.
    while len(alive) > max_parts:
        _check_deadline(deadline, "part-count cap")
        entry = pop_smallest_live()
        if entry is None:
            break
        _, label = entry
        neighbours = live_neighbours(label)
        if neighbours:
            merge(label, largest(neighbours))
            continue
        # An island with no shared edge (faces meeting only at a vertex): fold
        # it into the largest region overall so the cap still converges.
        others = alive - {label}
        if not others:
            break
        merge(label, largest(others))

    roots = np.fromiter((find(i) for i in range(k)), dtype=np.int64, count=k)
    return roots[compact]


def _region_name(centroid: np.ndarray, bounds: np.ndarray) -> str:
    """A human-readable spatial label from a part centroid within the bbox.

    Y is up (glTF convention). Vertical band dominates the name (top/lower/…);
    a left/right/front/back qualifier is added when the part sits clearly off
    the central axis.
    """
    span = bounds[1] - bounds[0]
    span[span == 0] = 1.0
    rel = (centroid - bounds[0]) / span  # 0..1 per axis

    y = rel[1]
    if y >= 0.78:
        vert = "top"
    elif y >= 0.58:
        vert = "upper"
    elif y >= 0.42:
        vert = "mid"
    elif y >= 0.22:
        vert = "lower"
    else:
        vert = "bottom"

    quals = []
    x = rel[0]
    if x <= 0.34:
        quals.append("left")
    elif x >= 0.66:
        quals.append("right")
    z = rel[2]
    if z <= 0.30:
        quals.append("back")
    elif z >= 0.70:
        quals.append("front")

    return "-".join([vert, *quals]) if quals else ("core" if vert == "mid" else vert)


def _unique_names(regions: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    counts = {r: regions.count(r) for r in regions}
    for r in regions:
        if counts[r] == 1:
            out.append(r)
        else:
            seen[r] = seen.get(r, 0) + 1
            out.append(f"{r}-{seen[r]}")
    return out


def segment(
    mesh: "trimesh.Trimesh",
    *,
    method: str = "auto",
    max_parts: int = 24,
    min_part_faces: int = 64,
    crease_angle_deg: float = 40.0,
    time_budget_s: Optional[float] = None,
) -> SegmentationResult:
    """Split `mesh` into named parts.

    method:
      - "connected": split only at physically disconnected shells.
      - "crease":    minima-rule crease segmentation over the whole mesh.
      - "auto":      connected components, then crease-split any component large
                     enough to plausibly contain multiple parts. Best default.

    `time_budget_s` bounds the whole run; exceeding it raises `SegmentTimeout`.
    """
    source_faces = int(len(mesh.faces))
    warnings: list[str] = []
    crease_rad = math.radians(max(5.0, min(170.0, crease_angle_deg)))
    deadline = None if time_budget_s is None else time.monotonic() + time_budget_s

    # Step 1 — connected components are always honoured; they are unambiguous parts.
    # repair=False matters: trimesh's default patches holes in each component as
    # it splits, so the parts stop being a partition of the input. A real forge
    # model measured 17031 faces in and 17050 across its parts, which makes the
    # manifest disagree with itself. Segmentation divides geometry; it never
    # invents any.
    components = mesh.split(only_watertight=False, repair=False)
    if len(components) == 0:
        components = [mesh]

    region_meshes: list["trimesh.Trimesh"] = []

    for comp in components:
        _check_deadline(deadline, "component split")
        if method == "connected":
            region_meshes.append(comp)
            continue

        # crease / auto: grow regions inside this component.
        # In auto mode, skip the (expensive, pointless) crease pass on tiny
        # components that are obviously a single part already.
        if method == "auto" and len(comp.faces) < max(min_part_faces * 2, 200):
            region_meshes.append(comp)
            continue

        labels = _crease_labels(comp, crease_rad)
        labels = _merge_small_and_cap(
            comp, labels, min_part_faces, max_parts, deadline=deadline
        )
        for lbl in np.unique(labels):
            face_idx = np.where(labels == lbl)[0]
            sub = comp.submesh([face_idx], append=True, repair=False)
            if isinstance(sub, list):
                sub = sub[0] if sub else None
            if sub is not None and len(sub.faces) > 0:
                region_meshes.append(sub)

    # Global cap across all components combined.
    if len(region_meshes) > max_parts:
        region_meshes.sort(key=lambda m: len(m.faces), reverse=True)
        head = region_meshes[: max_parts - 1]
        tail = region_meshes[max_parts - 1:]
        merged = trimesh.util.concatenate(tail)
        region_meshes = head + [merged]
        warnings.append(
            f"capped to {max_parts} parts; {len(tail)} smaller fragments were combined"
        )

    if not region_meshes:
        region_meshes = [mesh]

    # Order parts top→bottom, then larger→smaller, so the list reads naturally.
    overall_bounds = mesh.bounds

    def sort_key(m: "trimesh.Trimesh"):
        return (-(m.centroid[1]), -len(m.faces))

    region_meshes.sort(key=sort_key)

    regions = [_region_name(m.centroid, overall_bounds) for m in region_meshes]
    names = _unique_names(regions)
    colors = _palette(len(region_meshes))

    parts: list[Part] = []
    for i, (m, name, region, color) in enumerate(zip(region_meshes, names, regions, colors)):
        # Tint each part so segmentation is visible without textures, and so a
        # downstream viewer/exporter has a stable per-part colour to fall back on.
        m.visual = trimesh.visual.ColorVisuals(
            mesh=m, face_colors=np.tile([*color, 255], (len(m.faces), 1))
        )
        parts.append(Part(index=i + 1, name=name, mesh=m, color=color, region=region))

    return SegmentationResult(
        parts=parts, source_faces=source_faces, method=method, warnings=warnings
    )


def build_scene(parts: list[Part]) -> "trimesh.Scene":
    """A scene whose node names are the part ids — so a GLB consumer can address,
    hide, recolour or export each part by name."""
    scene = trimesh.Scene()
    for p in parts:
        node_name = f"part_{p.index:02d}"
        scene.add_geometry(p.mesh, geom_name=node_name, node_name=node_name)
    return scene


def manifest(result: SegmentationResult) -> dict:
    return {
        "method": result.method,
        "source_faces": result.source_faces,
        "part_count": len(result.parts),
        "parts": [p.manifest() for p in result.parts],
        "warnings": result.warnings,
    }
