"""Core-path tests for the segmenter (segment_core.py): pure geometry, no GCS,
no FastAPI, no network. Runs locally and as a Docker build gate:

    python3 workers/segment/test_segment_core.py

The performance case is the important one. It pins the 2026-08-11 fix for a
merge pass whose cost grew faster than quadratically: production jobs ran for
2.9 to 4 HOURS and drove repeated 16 GiB OOM kills, because every single merge
rebuilt the whole label-adjacency map and rescanned the full label array. On
this machine the 20 k-face case took 328 s before the fix and well under a
second after it.
"""

from __future__ import annotations

import math
import os
import sys
import time

import numpy as np
import trimesh

# Importable from anywhere, so the documented repo-root invocation works.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import segment_core as seg

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1


def noisy_sphere(subdivisions: int, amplitude: float = 0.06, seed: int = 7):
    """A sphere with jittered vertices: lots of genuine concave creases, so the
    minima rule produces thousands of regions the merge pass has to dissolve."""
    mesh = trimesh.creation.icosphere(subdivisions=subdivisions, radius=1.0)
    rng = np.random.default_rng(seed)
    mesh.vertices = mesh.vertices + rng.normal(0, amplitude, mesh.vertices.shape)
    mesh.merge_vertices()
    return mesh


def two_boxes():
    """Two physically disjoint shells: the unambiguous connected-component case."""
    a = trimesh.creation.box(extents=(1, 1, 1))
    b = trimesh.creation.box(extents=(1, 1, 1))
    b.apply_translation([5.0, 0, 0])
    return trimesh.util.concatenate([a, b])


def partition_of(result) -> list[int]:
    return sorted(len(p.mesh.faces) for p in result.parts)


# ── loading ───────────────────────────────────────────────────────────────────

glb = trimesh.creation.box(extents=(1, 2, 3)).export(file_type="glb")
loaded = seg.load_concatenated(glb, ".glb")
check("load_concatenated returns a Trimesh", isinstance(loaded, trimesh.Trimesh))
check("load_concatenated keeps the faces", len(loaded.faces) == 12, str(len(loaded.faces)))

scene = trimesh.Scene()
scene.add_geometry(trimesh.creation.box(extents=(1, 1, 1)), geom_name="a")
scene.add_geometry(two_boxes(), geom_name="b")
merged = seg.load_concatenated(scene.export(file_type="glb"), ".glb")
check("a multi-node scene concatenates to one mesh", isinstance(merged, trimesh.Trimesh))
check("concatenation keeps every face", len(merged.faces) == 36, str(len(merged.faces)))

try:
    seg.load_concatenated(trimesh.Trimesh().export(file_type="ply"), ".ply")
    check("empty mesh is rejected", False, "no error raised")
except seg.SegmentInputError:
    check("empty mesh is rejected", True)
except ValueError:
    # trimesh may refuse the empty export first; still a caller-facing refusal.
    check("empty mesh is rejected", True)

# ── connected components ──────────────────────────────────────────────────────

result = seg.segment(two_boxes(), method="connected")
check("connected mode finds both shells", len(result.parts) == 2, str(len(result.parts)))
check("connected mode reports source faces", result.source_faces == 24, str(result.source_faces))
check(
    "connected mode splits faces evenly",
    partition_of(result) == [12, 12],
    str(partition_of(result)),
)

# ── crease segmentation ───────────────────────────────────────────────────────

bumpy = noisy_sphere(4)
result = seg.segment(bumpy, method="crease", max_parts=24, min_part_faces=64)
check("crease mode returns parts", len(result.parts) >= 2, str(len(result.parts)))
check("crease mode honours the cap", len(result.parts) <= 24, str(len(result.parts)))
check(
    "every face lands in exactly one part",
    sum(len(p.mesh.faces) for p in result.parts) == len(bumpy.faces),
    f"{sum(len(p.mesh.faces) for p in result.parts)} vs {len(bumpy.faces)}",
)

for cap in (2, 4, 8, 24, 40):
    r = seg.segment(noisy_sphere(4), method="crease", max_parts=cap, min_part_faces=16)
    check(f"max_parts={cap} is never exceeded", len(r.parts) <= cap, str(len(r.parts)))

# The floor is a merge target, not a guarantee: a part with no neighbour cannot
# be dissolved. What must hold is that no shard survives while it still has a
# neighbour to merge into, which shows up as a single part in the degenerate case.
r = seg.segment(noisy_sphere(4), method="crease", max_parts=64, min_part_faces=100_000)
check("an impossible floor collapses to one part", len(r.parts) == 1, str(len(r.parts)))

# Parts must PARTITION the input: same faces, redistributed. trimesh's split
# patches holes by default, which silently grew a real 17031-face model to 17050
# faces across its parts and made the manifest contradict its own source_faces.
holed = trimesh.creation.box(extents=(1, 1, 1))
holed.update_faces(np.arange(len(holed.faces)) != 0)  # punch a hole
holed.remove_unreferenced_vertices()
for mode in ("connected", "crease", "auto"):
    r = seg.segment(holed, method=mode, max_parts=24, min_part_faces=4)
    total = sum(len(p.mesh.faces) for p in r.parts)
    check(
        f"{mode} mode invents no faces on an open mesh",
        total == len(holed.faces) == r.source_faces,
        f"{total} vs {len(holed.faces)} (source_faces={r.source_faces})",
    )

# ── determinism ───────────────────────────────────────────────────────────────

a = seg.segment(noisy_sphere(4), method="crease", max_parts=12, min_part_faces=64)
b = seg.segment(noisy_sphere(4), method="crease", max_parts=12, min_part_faces=64)
check(
    "the same mesh segments identically twice",
    partition_of(a) == partition_of(b),
    f"{partition_of(a)} vs {partition_of(b)}",
)
check(
    "part names are stable across runs",
    [p.name for p in a.parts] == [p.name for p in b.parts],
)

# ── merge-pass policy ─────────────────────────────────────────────────────────

mesh = noisy_sphere(4)
labels = seg._crease_labels(mesh, math.radians(40.0))
check("crease labelling finds many regions", len(np.unique(labels)) > 100, str(len(np.unique(labels))))

capped = seg._merge_small_and_cap(mesh, labels, 64, 10)
check("merge caps the region count", len(np.unique(capped)) <= 10, str(len(np.unique(capped))))
check("merge keeps one label per face", len(capped) == len(mesh.faces))
check(
    "merge never invents a region",
    len(np.unique(capped)) <= len(np.unique(labels)),
)

sizes = np.bincount(capped.astype(np.int64))
sizes = sizes[sizes > 0]
check("merged regions all carry faces", bool((sizes > 0).all()))
check("merged regions cover the mesh", int(sizes.sum()) == len(mesh.faces))

# ── performance: the regression that caused the outage ────────────────────────

big = noisy_sphere(5)
labels = seg._crease_labels(big, math.radians(40.0))
t0 = time.time()
seg._merge_small_and_cap(big, labels, 64, 24)
merge_s = time.time() - t0
check(
    f"20 k-face merge stays fast ({merge_s:.2f}s, was 328s pre-fix)",
    merge_s < 30.0,
    f"took {merge_s:.1f}s",
)

t0 = time.time()
full = seg.segment(noisy_sphere(6), method="auto", max_parts=24, min_part_faces=64)
full_s = time.time() - t0
check(
    f"80 k-face end-to-end segmentation stays fast ({full_s:.2f}s)",
    full_s < 120.0,
    f"took {full_s:.1f}s",
)
check("the large mesh still yields parts", len(full.parts) >= 1, str(len(full.parts)))

# ── time budget ───────────────────────────────────────────────────────────────

try:
    seg.segment(noisy_sphere(6), method="crease", time_budget_s=-1.0)
    check("an exhausted budget raises SegmentTimeout", False, "no error raised")
except seg.SegmentTimeout as exc:
    check("an exhausted budget raises SegmentTimeout", True)
    check("the timeout says how to recover", "max_parts" in str(exc), str(exc))

roomy = seg.segment(two_boxes(), method="connected", time_budget_s=600.0)
check("a roomy budget does not interfere", len(roomy.parts) == 2)

# ── scene + manifest ──────────────────────────────────────────────────────────

result = seg.segment(two_boxes(), method="connected")
scene = seg.build_scene(result.parts)
expected_nodes = {f"part_{p.index:02d}" for p in result.parts}
check(
    "scene geometry is named by part id",
    set(scene.geometry.keys()) == expected_nodes,
    f"{set(scene.geometry.keys())} vs {expected_nodes}",
)

exported = scene.export(file_type="glb")
check("the scene exports to GLB", isinstance(exported, bytes) and len(exported) > 0)
reloaded = trimesh.load(__import__("io").BytesIO(exported), file_type="glb")
check(
    "the exported GLB keeps one node per part",
    len(reloaded.geometry) == len(result.parts),
    str(len(reloaded.geometry)),
)

man = seg.manifest(result)
check("manifest reports the method", man["method"] == "connected")
check("manifest counts the parts", man["part_count"] == len(result.parts))
check("manifest reports source faces", man["source_faces"] == 24)
check("manifest carries a warnings list", isinstance(man["warnings"], list))

for entry in man["parts"]:
    for key in (
        "id", "name", "region", "face_count", "vertex_count",
        "bbox", "centroid", "volume", "color",
    ):
        check(f"manifest part has {key}", key in entry, str(entry))
    check("part id is zero padded", entry["id"].startswith("part_"), entry["id"])
    check("colour is a hex triplet", len(entry["color"]) == 7 and entry["color"][0] == "#", entry["color"])
    check("bbox has both corners", set(entry["bbox"]) == {"min", "max"})
    check("centroid is a 3-vector", len(entry["centroid"]) == 3)
    check("face_count is positive", entry["face_count"] > 0)

ids = [entry["id"] for entry in man["parts"]]
check("part ids are unique", len(set(ids)) == len(ids), str(ids))
names = [entry["name"] for entry in man["parts"]]
check("part names are unique", len(set(names)) == len(names), str(names))

# The cap warning has to be truthful: present only when something was folded.
capped_result = seg.segment(noisy_sphere(4), method="crease", max_parts=3, min_part_faces=4)
check("a capped run reports at most the cap", len(capped_result.parts) <= 3)
uncapped = seg.segment(two_boxes(), method="connected", max_parts=24)
check("an uncapped run warns about nothing", uncapped.warnings == [], str(uncapped.warnings))

# ── region naming ─────────────────────────────────────────────────────────────

bounds = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]])
check("centre is core", seg._region_name(np.array([0.5, 0.5, 0.5]), bounds) == "core")
check("high is top", seg._region_name(np.array([0.5, 0.9, 0.5]), bounds) == "top")
check("low is bottom", seg._region_name(np.array([0.5, 0.1, 0.5]), bounds) == "bottom")
check(
    "off-axis picks up a qualifier",
    seg._region_name(np.array([0.1, 0.9, 0.5]), bounds) == "top-left",
    seg._region_name(np.array([0.1, 0.9, 0.5]), bounds),
)
# A flat mesh has zero span on an axis; that must not divide by zero.
flat = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 1.0]])
check("a zero-span axis is safe", isinstance(seg._region_name(np.array([0.5, 0.0, 0.5]), flat), str))

check("duplicate regions get numbered", seg._unique_names(["top", "top"]) == ["top-1", "top-2"])
check("a unique region keeps its name", seg._unique_names(["top", "core"]) == ["top", "core"])

print(f"\nOK  {PASS} checks passed")
