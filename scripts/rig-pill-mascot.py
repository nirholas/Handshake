#!/usr/bin/env python3
"""Auto-rig a capsule-body mascot GLB (pump.fun pill, and anything shaped like it).

The platform's humanoid auto-rigger (workers/rig, Make-It-Animatable) predicts a
Mixamo skeleton from a humanoid silhouette: head on a neck, two long arms, two
long legs. A mascot built as one fat capsule with four stubby nubs has none of
those landmarks, so the prediction lands nowhere useful. This script rigs that
shape from its own geometry instead:

  1. Voxelize the mesh and take its euclidean distance transform. The body is
     everything thicker than a limb; the four nubs fall out as the connected
     components left over once the body and its fillet are removed.
  2. Trace each nub's medial axis back into the body with a minimum-cost path
     that prefers thick interior (skimage.graph.route_through_array), which
     gives the limb's real curve rather than a straight-line guess.
  3. Drop a full 52-bone Mixamo-named skeleton onto those curves. The names are
     what matter platform-side: src/glb-canonicalize.js maps `mixamorig:*` 1:1
     onto the canonical bone set, so the pre-baked clip library retargets onto
     the result at full coverage.
  4. Skin it with geodesic-in-volume falloff, so weight travels through the mesh
     rather than across the gap between a raised arm and the belly behind it.
  5. Write the skeleton in a NEUTRAL standing pose while binding against the
     sculpted pose. glTF keeps those separate (node transforms vs inverse bind
     matrices), and the platform's retargeter replays clip motion as a delta on
     the rest pose -- so a walk clip has to start from legs-under-hips, not from
     the mid-stride pose the model was sculpted in.
  6. Bake mascot-proportioned clips (idle, walk, run, wave, jump, dance) into the
     GLB for surfaces that play a model's own animations.

Usage:
    python3 scripts/rig-pill-mascot.py public/avatars/pumpfun-pill-cupsey.glb \
        --out public/avatars/pumpfun-pill-cupsey-rigged.glb --debug

Dependencies (not in the repo's npm tree; install once):
    pip install numpy scipy scikit-image trimesh pygltflib Pillow
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
import trimesh
from scipy import ndimage
from skimage.graph import route_through_array

VOXEL = 0.012          # voxel edge, in model units
BODY_THICKNESS = 0.26  # medial thickness above which we are inside the body core
LIMB_FLARE = 1.35      # thickness multiple that marks where a nub joins the body


# --------------------------------------------------------------------------
# Stage 1: volume + limb discovery
# --------------------------------------------------------------------------

def build_volume(mesh):
    """Solid voxel occupancy for the mesh, plus its medial thickness field.

    Rasterizing the vertex list alone leaves pinholes wherever the source mesh
    samples thinner than a voxel, and a single pinhole makes the flood fill leak
    and the whole analysis collapse. Sampling the triangles instead guarantees a
    sealed shell at any voxel size.
    """
    vertices = np.asarray(mesh.vertices)
    lo = vertices.min(0) - 6 * VOXEL
    hi = vertices.max(0) + 6 * VOXEL
    dims = np.ceil((hi - lo) / VOXEL).astype(int) + 1
    count = int(max(len(vertices) * 4, mesh.area / (VOXEL * VOXEL) * 6))
    points = trimesh.sample.sample_surface(mesh, count)[0]
    idx = np.floor((np.vstack([vertices, points]) - lo) / VOXEL).astype(int)
    occ = np.zeros(dims, bool)
    occ[idx[:, 0], idx[:, 1], idx[:, 2]] = True
    filled = ndimage.binary_fill_holes(occ)
    if filled.sum() < occ.sum() * 3:
        raise SystemExit('flood fill leaked -- the shell has a hole larger than a voxel')
    thickness = ndimage.distance_transform_edt(filled) * VOXEL
    return lo, filled, thickness


def find_limbs(filled, thickness):
    """The four nubs: what is left of the solid once body + fillet are removed."""
    core = thickness > BODY_THICKNESS
    to_core = ndimage.distance_transform_edt(~core) * VOXEL
    body = (to_core <= BODY_THICKNESS * 1.15) & filled
    labels, count = ndimage.label(filled & ~body, structure=ndimage.generate_binary_structure(3, 3))
    if count < 4:
        raise SystemExit(f'expected 4 limb nubs, found {count} -- is this a capsule mascot?')
    sizes = np.bincount(labels.ravel())[1:]
    biggest = np.argsort(sizes)[::-1][:4]
    return core, [labels == i + 1 for i in biggest]


def medial_path(cost, thickness, seed, core_centroid):
    """Nub tip -> body core along the thickest available interior route."""
    voxels = np.array(np.nonzero(seed)).T
    tip = tuple(voxels[np.argmax(np.linalg.norm(voxels - core_centroid, axis=1))])
    path, _ = route_through_array(
        cost, tip, tuple(np.round(core_centroid).astype(int)),
        fully_connected=True, geometric=True,
    )
    path = np.array(path)
    return path, np.array([thickness[tuple(p)] for p in path])


# --------------------------------------------------------------------------
# Stage 2: joint placement
# --------------------------------------------------------------------------

def limb_chain(path_world, path_thickness):
    """Cut a nub's medial curve at the body, and resample it root -> tip.

    Returns the curve running from the joint that anchors the limb in the body
    out to its tip, plus the nub's own thickness (used later as a skin radius).
    """
    nub = float(np.median(path_thickness[: max(4, len(path_thickness) // 3)][2:]))
    flare = np.nonzero(path_thickness > max(nub * LIMB_FLARE, BODY_THICKNESS * 0.62))[0]
    cut = int(flare[0]) if len(flare) else len(path_thickness) - 1
    # Seat the root joint a little deeper than the flare, where a real shoulder
    # or hip would sit: outside-in this is the first point the mesh reads as body.
    cut = min(cut + int(round(nub * 0.9 / VOXEL)), len(path_world) - 1)
    curve = path_world[: cut + 1][::-1]           # root -> tip
    return curve, nub


def arc_lengths(curve):
    seg = np.linalg.norm(np.diff(curve, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(seg)])


def sample_curve(curve, t):
    """Point at normalized arc position t in [0, 1]."""
    s = arc_lengths(curve)
    return np.array([np.interp(t * s[-1], s, curve[:, i]) for i in range(3)])


# --------------------------------------------------------------------------
# Quaternion / transform helpers (xyzw, matching glTF's component order)
# --------------------------------------------------------------------------

def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def q_conj(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def q_rotate(q, v):
    t = 2.0 * np.cross(q[:3], v)
    return v + q[3] * t + np.cross(q[:3], t)


def q_axis_angle(axis, angle):
    axis = np.asarray(axis, float)
    n = np.linalg.norm(axis)
    if n < 1e-12:
        return np.array([0.0, 0.0, 0.0, 1.0])
    axis = axis / n
    s = np.sin(angle * 0.5)
    return np.array([axis[0] * s, axis[1] * s, axis[2] * s, np.cos(angle * 0.5)])


def q_from_to(a, b):
    """Shortest-arc rotation taking unit vector a onto unit vector b."""
    a = a / (np.linalg.norm(a) + 1e-12)
    b = b / (np.linalg.norm(b) + 1e-12)
    d = float(np.dot(a, b))
    if d > 1.0 - 1e-9:
        return np.array([0.0, 0.0, 0.0, 1.0])
    if d < -1.0 + 1e-9:
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0.0, 1.0, 0.0])
        return q_axis_angle(axis, np.pi)
    axis = np.cross(a, b)
    q = np.array([axis[0], axis[1], axis[2], 1.0 + d])
    return q / np.linalg.norm(q)


def q_slerp_norm(q):
    return q / (np.linalg.norm(q) + 1e-12)


def unit(v):
    v = np.asarray(v, float)
    return v / (np.linalg.norm(v) + 1e-12)


# --------------------------------------------------------------------------
# Skeleton
# --------------------------------------------------------------------------

class Bone:
    __slots__ = ('name', 'parent', 'head', 'tail', 'radius', 'children', 'index')

    def __init__(self, name, parent, head, tail, radius):
        self.name = name
        self.parent = parent
        self.head = np.asarray(head, float)
        self.tail = np.asarray(tail, float)
        self.radius = float(radius)
        self.children = []
        self.index = -1


class Skeleton:
    def __init__(self):
        self.bones = []
        self.by_name = {}

    def add(self, name, parent, head, tail, radius):
        bone = Bone(name, parent, head, tail, radius)
        bone.index = len(self.bones)
        self.bones.append(bone)
        self.by_name[name] = bone
        if parent:
            self.by_name[parent].children.append(name)
        return bone

    def order(self):
        """Parents always before children -- insertion order already guarantees it."""
        return self.bones

    def local_rest_translation(self, bone):
        if not bone.parent:
            return bone.head.copy()
        return bone.head - self.by_name[bone.parent].head

    def solve(self, aims, twists=None, hips_offset=None):
        """Forward-kinematic aim solve.

        `aims` maps a bone name to the world-space direction its bone should
        point in this pose. Bones are visited parent-first, each one rotated by
        the shortest arc from where its child currently sits to where the pose
        wants it, so a shoulder rotation carries the whole arm with it. Returns
        world rotations and world head positions for every bone.
        """
        twists = twists or {}
        world_q = {}
        world_p = {}

        def refresh(name):
            bone = self.by_name[name]
            parent = self.by_name[bone.parent] if bone.parent else None
            if parent is None:
                world_p[name] = bone.head + (hips_offset if hips_offset is not None else 0.0)
                world_q.setdefault(name, np.array([0.0, 0.0, 0.0, 1.0]))
            else:
                world_p[name] = world_p[parent.name] + q_rotate(
                    world_q[parent.name], bone.head - parent.head)
                world_q[name] = q_mul(world_q[parent.name], world_q.get(name + '/local',
                                                                       np.array([0., 0., 0., 1.])))
            for child in bone.children:
                refresh(child)

        # Seed every bone with an identity local rotation, then aim them in order.
        for bone in self.bones:
            world_q[bone.name + '/local'] = np.array([0.0, 0.0, 0.0, 1.0])
        refresh(self.bones[0].name)

        for bone in self.bones:
            target = aims.get(bone.name)
            twist = twists.get(bone.name)
            if target is None and twist is None:
                continue
            delta = np.array([0.0, 0.0, 0.0, 1.0])
            if target is not None:
                tip = self._tip_world(bone, world_p, world_q)
                current = unit(tip - world_p[bone.name])
                delta = q_from_to(current, unit(target))
            if twist is not None:
                axis = unit(target) if target is not None else unit(
                    self._tip_world(bone, world_p, world_q) - world_p[bone.name])
                delta = q_mul(q_axis_angle(axis, twist), delta)
            world_q[bone.name] = q_mul(delta, world_q[bone.name])
            parent = self.by_name[bone.parent] if bone.parent else None
            parent_q = world_q[parent.name] if parent else np.array([0.0, 0.0, 0.0, 1.0])
            world_q[bone.name + '/local'] = q_mul(q_conj(parent_q), world_q[bone.name])
            refresh(bone.name)

        locals_ = {b.name: q_slerp_norm(world_q[b.name + '/local']) for b in self.bones}
        return locals_, world_p, {b.name: world_q[b.name] for b in self.bones}

    def _tip_world(self, bone, world_p, world_q):
        """Where this bone currently points: its first child, or its own tail."""
        if bone.children:
            return world_p[bone.children[0]]
        return world_p[bone.name] + q_rotate(world_q[bone.name], bone.tail - bone.head)


FINGERS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')


def add_hand(skel, side, wrist, tip, radius):
    """Five three-joint chains fanned inside the mitt.

    A mascot nub has no fingers, but the platform's clip library does: 30 of the
    53 tracks in every baked clip address a finger joint, and animation-retarget.js
    drops a clip whose coverage falls under 50%. Stub chains inside the mitt carry
    those tracks (and give the nub a soft squish when a clip curls a hand) instead
    of throwing the whole library away.
    """
    forward = unit(tip - wrist)
    span = float(np.linalg.norm(tip - wrist))
    side_axis = np.cross(forward, [0.0, 1.0, 0.0])
    if np.linalg.norm(side_axis) < 1e-4:
        side_axis = np.cross(forward, [0.0, 0.0, 1.0])
    side_axis = unit(side_axis)
    up_axis = unit(np.cross(side_axis, forward))
    parent = f'{side}Hand'
    for f, finger in enumerate(FINGERS):
        spread = (f - 2.0) / 2.0                        # -1 .. +1 across the mitt
        lift = -0.55 if finger == 'Thumb' else 0.0      # thumb sits low and wide
        base = wrist + forward * span * 0.45 \
            + side_axis * spread * radius * 0.62 \
            + up_axis * lift * radius * 0.62
        direction = unit(forward + side_axis * spread * 0.45 + up_axis * lift * 0.7)
        seg = span * 0.20 if finger != 'Thumb' else span * 0.17
        head = base
        for j in (1, 2, 3):
            name = f'{side}Hand{finger}{j}'
            skel.add(name, parent, head, head + direction * seg, radius * 0.30)
            parent = name
            head = head + direction * seg
        parent = f'{side}Hand'


def build_skeleton(limbs, roots, body_axis, body_y0, body_y1):
    """Lay the 52-bone Mixamo skeleton onto the traced limb curves."""
    skel = Skeleton()
    height = body_y1 - body_y0

    def axis_at(y):
        return np.array([np.interp(y, body_axis[:, 1], body_axis[:, 0]),
                         y,
                         np.interp(y, body_axis[:, 1], body_axis[:, 2])])

    spine_stops = {
        'Hips': 0.20, 'Spine': 0.31, 'Spine1': 0.41, 'Spine2': 0.50,
        'Neck': 0.56, 'Head': 0.61,
    }
    parent = None
    for name, t in spine_stops.items():
        head = axis_at(body_y0 + t * height)
        tail = axis_at(body_y0 + (t + 0.06) * height)
        skel.add(name, parent, head, tail, height * 0.30)
        parent = name
    skel.by_name['Head'].tail = axis_at(body_y1 - height * 0.04)

    for side in ('Left', 'Right'):
        curve, nub = limbs[f'{side}Arm']
        shoulder = roots[f'{side}Arm']
        chest = axis_at(shoulder[1])
        skel.add(f'{side}Shoulder', 'Spine2',
                 chest + (shoulder - chest) * 0.42, shoulder, nub * 1.2)
        skel.add(f'{side}Arm', f'{side}Shoulder', shoulder, sample_curve(curve, 0.42), nub)
        skel.add(f'{side}ForeArm', f'{side}Arm', sample_curve(curve, 0.42),
                 sample_curve(curve, 0.76), nub)
        wrist = sample_curve(curve, 0.76)
        tip = curve[-1]
        skel.add(f'{side}Hand', f'{side}ForeArm', wrist, tip, nub)
        add_hand(skel, side, wrist, tip, nub)

    for side in ('Left', 'Right'):
        curve, nub, ankle_t, toe = limbs[f'{side}Leg']
        hip = roots[f'{side}Leg']
        skel.add(f'{side}UpLeg', 'Hips', hip, sample_curve(curve, ankle_t * 0.52), nub)
        skel.add(f'{side}Leg', f'{side}UpLeg', sample_curve(curve, ankle_t * 0.52),
                 sample_curve(curve, ankle_t), nub)
        ankle = sample_curve(curve, ankle_t)
        skel.add(f'{side}Foot', f'{side}Leg', ankle, ankle + (toe - ankle) * 0.62, nub)
        skel.add(f'{side}ToeBase', f'{side}Foot', ankle + (toe - ankle) * 0.62, toe, nub * 0.8)

    return skel


# --------------------------------------------------------------------------
# Stage 1b: read the character off the mesh (facing, body axis, limb roles)
# --------------------------------------------------------------------------

def sample_base_color(mesh, gltf, blob):
    """Per-vertex base colour, used to find the face and the head/body split."""
    from PIL import Image
    import io
    tex = gltf.materials[0].pbrMetallicRoughness.baseColorTexture
    image = gltf.images[gltf.textures[tex.index].source]
    view = gltf.bufferViews[image.bufferView]
    start = view.byteOffset or 0
    img = Image.open(io.BytesIO(blob[start:start + view.byteLength])).convert('RGB')
    pixels = np.asarray(img).astype(np.float32) / 255.0
    h, w, _ = pixels.shape
    uv = np.asarray(mesh.visual.uv)
    u = np.clip((uv[:, 0] % 1.0 * w).astype(int), 0, w - 1)
    v = np.clip(((1.0 - uv[:, 1] % 1.0) * h).astype(int), 0, h - 1)
    return pixels[v, u]


def detect_facing(vertices, colors, axis, body_y0, body_y1):
    """Which way the mascot looks: toward the painted face.

    Eyes and mouth are the only near-black pixels on the head, so their centroid,
    measured off the body's own centre axis, gives the forward direction. The
    result is snapped to the nearest world axis when it is close to one: this
    pill's face is painted about 13 degrees off centre, and the platform's
    convention (and every clip in the library) is that an avatar faces +Z.
    """
    head = vertices[:, 1] > body_y0 + 0.55 * (body_y1 - body_y0)
    face = head & (colors.max(1) < 0.30)
    if face.sum() < 50:
        return np.array([0.0, 0.0, 1.0]), 0, 0.0
    centroid = vertices[face].mean(0)
    on_axis = np.array([np.interp(centroid[1], axis[:, 1], axis[:, 0]), centroid[1],
                        np.interp(centroid[1], axis[:, 1], axis[:, 2])])
    d = unit(np.array([centroid[0] - on_axis[0], 0.0, centroid[2] - on_axis[2]]))
    for cardinal in ([0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]):
        cardinal = np.array(cardinal, float)
        skew = float(np.degrees(np.arccos(np.clip(np.dot(d, cardinal), -1, 1))))
        if skew < 30.0:
            return cardinal, int(face.sum()), skew
    return d, int(face.sum()), 0.0


def analyse(mesh, gltf, blob):
    vertices = np.asarray(mesh.vertices)
    lo, filled, thickness = build_volume(mesh)
    core, seeds = find_limbs(filled, thickness)

    core_idx = np.array(np.nonzero(core)).T
    core_centroid = core_idx.mean(0)

    body_mask = np.ones(len(vertices), bool)
    vidx = np.floor((vertices - lo) / VOXEL).astype(int)
    for seed in seeds:
        body_mask &= ~seed[vidx[:, 0], vidx[:, 1], vidx[:, 2]]
    body_v = vertices[body_mask]
    body_y0, body_y1 = float(body_v[:, 1].min()), float(body_v[:, 1].max())

    axis = []
    for y in np.linspace(body_y0, body_y1, 40):
        band = core_idx[(np.abs((core_idx[:, 1] * VOXEL + lo[1]) - y)) < 0.05]
        if len(band) < 20:
            continue
        p = band.mean(0) * VOXEL + lo
        axis.append([p[0], y, p[2]])
    axis = np.array(axis)

    colors = sample_base_color(mesh, gltf, blob)
    facing, face_px, face_skew = detect_facing(vertices, colors, axis, body_y0, body_y1)

    cost = np.full(thickness.shape, 1e6)
    cost[filled] = 1.0 / (thickness[filled] ** 3 + 1e-4)

    traced = []
    for seed in seeds:
        path, thick = medial_path(cost, thickness, seed, core_centroid)
        curve, nub = limb_chain(path * VOXEL + lo, thick)
        traced.append({'curve': curve, 'nub': nub,
                       'seed_vertices': vertices[seed[vidx[:, 0], vidx[:, 1], vidx[:, 2]]]})

    # Legs are the two limbs whose tips reach lowest; sides split across the
    # body axis, with the mascot's left on +X when it faces +Z.
    traced.sort(key=lambda t: t['curve'][-1][1])
    left_of = np.cross([0.0, 1.0, 0.0], facing)   # points to the character's left
    limbs = {}
    for role, pair in (('Leg', traced[:2]), ('Arm', traced[2:])):
        pair = sorted(pair, key=lambda t: float(np.dot(t['curve'][-1], left_of)))
        for side, limb in zip(('Right', 'Left'), pair):
            limbs[f'{side}{role}'] = limb

    for side in ('Left', 'Right'):
        limb = limbs[f'{side}Leg']
        curve, nub = limb['curve'], limb['nub']
        limb['ankle_t'] = find_ankle(curve)
        ankle = sample_curve(curve, limb['ankle_t'])
        limb['toe'] = find_toe(limb['seed_vertices'], ankle, facing, nub)
        limbs[f'{side}Leg'] = (curve, nub, limb['ankle_t'], limb['toe'])
    for side in ('Left', 'Right'):
        limb = limbs[f'{side}Arm']
        limbs[f'{side}Arm'] = (limb['curve'], limb['nub'])

    return {
        'lo': lo, 'filled': filled, 'thickness': thickness, 'core': core,
        'body_axis': axis, 'body_y0': body_y0, 'body_y1': body_y1,
        'facing': facing, 'face_px': face_px, 'face_skew': face_skew,
        'colors': colors, 'limbs': limbs,
    }


def find_ankle(curve):
    """Where the leg stops running straight and the foot breaks away from it.

    Measured as the first tangent along the curve that deviates more than 28
    degrees from the leg's own proximal direction, which finds the break whether
    the foot lifts (a raised mid-stride foot) or drops (a planted one).
    """
    s = arc_lengths(curve)
    total = s[-1]
    window = max(2, int(round(0.05 / VOXEL)))
    proximal = unit(sample_curve(curve, 0.45) - sample_curve(curve, 0.10))
    for i in range(window, len(curve) - window):
        tangent = unit(curve[i + window] - curve[i - window])
        if float(np.dot(tangent, proximal)) < np.cos(np.radians(28)) and s[i] / total > 0.45:
            return float(min(s[i] / total, 0.88))
    return 0.78


def find_toe(limb_vertices, ankle, facing, nub):
    """Tip of the foot: the point of the nub reaching furthest forward, low down."""
    below = limb_vertices[limb_vertices[:, 1] < ankle[1] + nub * 0.75]
    if len(below) < 20:
        below = limb_vertices
    reach = (below - ankle) @ facing
    front = below[reach > np.quantile(reach, 0.98)]
    return front.mean(0)


# --------------------------------------------------------------------------
# Stage 3: skin weights
# --------------------------------------------------------------------------

SPINE_CHAIN = ('Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head')
MAX_INFLUENCES = 4


def point_segment_distance(points, a, b):
    """Distance from each point to segment ab, plus where along ab it lands."""
    ab = b - a
    length2 = float(ab @ ab)
    if length2 < 1e-12:
        return np.linalg.norm(points - a, axis=1), np.zeros(len(points))
    t = np.clip((points - a) @ ab / length2, 0.0, 1.0)
    closest = a + t[:, None] * ab
    return np.linalg.norm(points - closest, axis=1), t


def sample_thickness(field, lo, points):
    idx = np.clip(np.floor((points - lo) / VOXEL).astype(int), 0,
                  np.array(field.shape) - 1)
    return field[idx[:, 0], idx[:, 1], idx[:, 2]]


def torso_weights(vertices, skel, thickness, lo):
    """Split the body along the spine, by arc position rather than by radius.

    A fat capsule is wider than it is tall between spine joints, so plain
    distance-to-bone hands every torso vertex almost the same distance to every
    spine bone and the head ends up driving a fifth of its own dome. Projecting
    onto the spine polyline and splitting between the two joints that bracket the
    projection is what a hand-painted torso actually looks like: the dome rides
    the head, the belly bends across Spine/Spine1, nothing smears.
    """
    joints = [skel.by_name[n].head for n in SPINE_CHAIN]
    line = np.array(joints + [skel.by_name['Head'].tail])
    arc = arc_lengths(line)

    best_d = np.full(len(vertices), np.inf)
    best_u = np.zeros(len(vertices))
    for i in range(len(line) - 1):
        d, t = point_segment_distance(vertices, line[i], line[i + 1])
        closer = d < best_d
        best_d[closer] = d[closer]
        best_u[closer] = arc[i] + t[closer] * (arc[i + 1] - arc[i])

    weights = np.zeros((len(vertices), len(SPINE_CHAIN)))
    for i in range(len(line) - 1):
        span = arc[i + 1] - arc[i]
        inside = (best_u >= arc[i]) & (best_u <= arc[i + 1] + 1e-9)
        t = np.clip((best_u[inside] - arc[i]) / max(span, 1e-9), 0.0, 1.0)
        if i < len(SPINE_CHAIN) - 1:
            weights[inside, i] += 1.0 - t
            weights[inside, i + 1] += t
        else:
            weights[inside, i] += 1.0          # head -> crown runs on Head alone
    return weights, line


def trilinear(field, lo, points):
    """Smooth sample of a scalar or vector voxel field at world positions."""
    grid = (points - lo) / VOXEL
    shape = np.array(field.shape[:3])
    base = np.floor(grid).astype(int)
    frac = grid - base
    out = np.zeros((len(points),) + field.shape[3:], field.dtype)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                idx = np.clip(base + (dx, dy, dz), 0, shape - 1)
                w = (np.where(dx, frac[:, 0], 1 - frac[:, 0])
                     * np.where(dy, frac[:, 1], 1 - frac[:, 1])
                     * np.where(dz, frac[:, 2], 1 - frac[:, 2]))
                sample = field[idx[:, 0], idx[:, 1], idx[:, 2]]
                out += sample * (w[:, None] if sample.ndim > 1 else w)
    return out


def medial_anchors(vertices, thickness, lo, steps=70):
    """Walk each vertex inward to the medial axis of the part it sits on.

    Which limb a vertex belongs to is a question about the mesh's interior, not
    its surface: the mascot's raised hand rests against the side of its head, so
    those two surfaces are neighbours under any distance measure, straight-line
    or through-the-mesh, and skinning them by proximity welds the head to the
    hand. Climbing the thickness field's gradient from a vertex ends on the axis
    of whichever part that vertex is skin for -- the hand's own axis for the
    hand, the body's for the head -- and those are half a body apart.

    Gradient ascent rather than a march along the vertex normal, because this
    mesh is 286 separately-wound shells and one flipped normal would march a
    patch straight out of the model.
    """
    gradient = np.stack(np.gradient(thickness), axis=-1)
    point = vertices.copy()
    best = point.copy()
    best_thickness = trilinear(thickness, lo, point)
    for _ in range(steps):
        g = trilinear(gradient, lo, point)
        point = point + g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9) * VOXEL
        here = trilinear(thickness, lo, point)
        better = here > best_thickness
        best[better] = point[better]
        best_thickness = np.maximum(best_thickness, here)
    return best


def polyline_distance(points, line):
    best = np.full(len(points), np.inf)
    for i in range(len(line) - 1):
        d, _ = point_segment_distance(points, line[i], line[i + 1])
        best = np.minimum(best, d)
    return best


BRANCH_BLUR = 0.20


def branch_membership(anchors, spine_line, limb_curves):
    """Soft split of every vertex across the medial branches it could belong to.

    Each limb's branch is measured from its root joint, not from where the nub
    visibly leaves the body: the fillet between a splayed leg and the capsule is
    real geometry that has to travel with the leg, and anchoring on the visible
    nub alone leaves it behind as a flap when the leg swings under the hips.
    """
    scores = [np.exp(-(polyline_distance(anchors, spine_line) / BRANCH_BLUR) ** 2)]
    for curve in limb_curves:
        scores.append(np.exp(-(polyline_distance(anchors, curve) / BRANCH_BLUR) ** 2))
    scores = np.stack(scores, axis=1)
    return scores / np.maximum(scores.sum(1, keepdims=True), 1e-9)


def geodesic_from_segment(mcp, lo, shape, a, b):
    """Distance from a bone segment to every voxel, measured *through the mesh*.

    Straight-line distance is what makes an auto-rig dent a face: on this model
    the raised hand sits 5 cm from the side of the head, so a euclidean envelope
    binds head to hand and lowering the arm drags a crater across the cheek.
    Through the mesh that same hand is a whole arm plus half a torso away, so the
    head keeps still and only the arm moves.
    """
    steps = max(2, int(np.ceil(np.linalg.norm(b - a) / (VOXEL * 0.5))))
    points = a + (b - a) * np.linspace(0, 1, steps)[:, None]
    idx = np.clip(np.floor((points - lo) / VOXEL).astype(int), 0, np.array(shape) - 1)
    starts = list({tuple(v) for v in idx})
    cumulative, _ = mcp.find_costs(starts)
    return cumulative * VOXEL


def limb_envelope(distance, along, bone, root_radius):
    """Soft tube around one limb bone, fattest where it enters the body.

    The tube widens toward the root so the fillet where a nub meets the capsule
    travels with the nub instead of creasing, and is capped there so a shoulder
    bone buried in the body cannot claim the belly behind it.
    """
    near = max(min(root_radius, bone.radius * 1.9), bone.radius)
    far = bone.radius * 1.35
    radius = near + (far - near) * along
    return np.exp(-np.clip(distance / radius, 0, 6) ** 4)


def smooth_weights(vertices, weights, rounds=2, k=8, reach=0.02):
    """Average each vertex's weights with its close spatial neighbours.

    Spatial, not topological: this mesh is 286 disconnected shells, so a
    face-adjacency graph would leave seams unsmoothed exactly where two shells
    meet. The reach is deliberately tight -- wide enough to weld the shells,
    narrow enough that the hand cannot smooth its weights onto the head it is
    raised beside.
    """
    from scipy.spatial import cKDTree
    tree = cKDTree(vertices)
    _, idx = tree.query(vertices, k=k, distance_upper_bound=reach)
    missing = idx >= len(vertices)
    idx[missing] = np.arange(len(vertices))[:, None].repeat(k, 1)[missing]
    for _ in range(rounds):
        weights = 0.35 * weights + 0.65 * weights[idx].mean(axis=1)
    return weights


def skin(vertices, skel, filled, thickness, lo, limbs, roots):
    from skimage.graph import MCP_Geometric

    names = [b.name for b in skel.bones]
    weights = np.zeros((len(vertices), len(names)), np.float32)
    index = np.clip(np.floor((vertices - lo) / VOXEL).astype(int), 0,
                    np.array(filled.shape) - 1)

    _, spine_line = torso_weights(vertices[:1], skel, thickness, lo)
    limb_names = ('LeftArm', 'RightArm', 'LeftLeg', 'RightLeg')
    anchors = medial_anchors(vertices, thickness, lo)
    member = branch_membership(anchors, spine_line,
                               [np.vstack([roots[n], limbs[n][0]]) for n in limb_names])
    # Gradient ascent is a watershed, and a watershed has hard edges: two
    # neighbouring vertices on the crotch webbing can climb to different ridges
    # and end up in different limbs. Unsmoothed, that seam tears into a fin the
    # moment the leg swings. Blurring the classification over the surface first
    # turns the seam into a gradient.
    member = smooth_weights(vertices, member, rounds=6, k=14, reach=0.05)
    member /= np.maximum(member.sum(1, keepdims=True), 1e-9)
    branch_of = {name: 0 for name in SPINE_CHAIN}
    for i, limb in enumerate(limb_names):
        prefix = 'Left' if limb.startswith('Left') else 'Right'
        chain = ((f'{prefix}Shoulder', f'{prefix}Arm', f'{prefix}ForeArm', f'{prefix}Hand')
                 if limb.endswith('Arm') else
                 (f'{prefix}UpLeg', f'{prefix}Leg', f'{prefix}Foot', f'{prefix}ToeBase'))
        for bone in chain:
            branch_of[bone] = i + 1
        if limb.endswith('Arm'):
            for finger in FINGERS:
                for j in (1, 2, 3):
                    branch_of[f'{prefix}Hand{finger}{j}'] = i + 1

    torso, _ = torso_weights(vertices, skel, thickness, lo)
    for i, name in enumerate(SPINE_CHAIN):
        weights[:, names.index(name)] = torso[:, i] * member[:, 0]

    mcp = MCP_Geometric(np.where(filled, 1.0, np.inf), fully_connected=True)
    for bone in skel.bones:
        if bone.name in SPINE_CHAIN:
            continue
        field = geodesic_from_segment(mcp, lo, filled.shape, bone.head, bone.tail)
        distance = field[index[:, 0], index[:, 1], index[:, 2]]
        distance[~np.isfinite(distance)] = 1e3
        _, along = point_segment_distance(vertices, bone.head, bone.tail)
        root = float(sample_thickness(thickness, lo, bone.head[None, :])[0])
        envelope = limb_envelope(distance, along, bone, root)
        weights[:, bone.index] = envelope * member[:, branch_of[bone.name]]

    weights = smooth_weights(vertices, weights)
    order = np.argsort(weights, axis=1)[:, ::-1][:, :MAX_INFLUENCES]
    kept = np.take_along_axis(weights, order, axis=1)
    total = kept.sum(1, keepdims=True)
    orphan = total[:, 0] < 1e-6
    if orphan.any():
        # Nothing claimed these. Fall back inside the branch the vertex was
        # traced to, never across the whole skeleton: at the back of the head
        # the nearest bone by centre distance is a coin toss between Head and
        # RightForeArm, and a coin toss tears the mesh along that seam.
        branch = np.argmax(member[orphan], axis=1)
        for b in range(member.shape[1]):
            pick = branch == b
            if not pick.any():
                continue
            candidates = [bone for bone in skel.bones
                          if branch_of.get(bone.name, 0) == b]
            points = vertices[orphan][pick]
            best = np.full(len(points), np.inf)
            chosen = np.zeros(len(points), int)
            for bone in candidates:
                d, _ = point_segment_distance(points, bone.head, bone.tail)
                closer = d < best
                best[closer] = d[closer]
                chosen[closer] = bone.index
            rows = np.where(orphan)[0][pick]
            order[rows, 0] = chosen
            kept[rows] = 0.0
            kept[rows, 0] = 1.0
            total[rows] = 1.0
    return order.astype(np.uint16), (kept / total).astype(np.float32)



# --------------------------------------------------------------------------
# Stage 4: the neutral standing pose
# --------------------------------------------------------------------------

def symmetrize_roots(limbs, axis_x, axis_z):
    """Average each limb pair's attachment across the body so the rig is even.

    The nubs are sculpted mid-action: the right arm is thrown up beside the head
    and the right leg is kicked out, so the traced attachments sit 0.24 apart in
    height and 0.4 apart in reach. Binding to those raw points gives a rig that
    walks lopsided. Averaging the pair and mirroring it about the body axis costs
    a little fidelity at the nub base and buys a skeleton that poses.
    """
    out = {}
    for role in ('Arm', 'Leg'):
        left, right = limbs[f'Left{role}'][0][0], limbs[f'Right{role}'][0][0]
        reach = 0.5 * (abs(left[0] - axis_x) + abs(right[0] - axis_x))
        y = 0.5 * (left[1] + right[1])
        z = 0.5 * (left[2] + right[2])
        out[f'Left{role}'] = np.array([axis_x + reach, y, z])
        out[f'Right{role}'] = np.array([axis_x - reach, y, z])
    return out


# A capsule this wide leaves nowhere for an arm to hang: dropped past about 25
# degrees the nub is inside the belly, so the mascot's rest is arms-out.
NEUTRAL_ARM_DROP = np.radians(22.0)
NEUTRAL_ARM_FORWARD = 0.14


def neutral_pose(skel):
    """Arms out, legs under the hips, facing +Z: the rest every clip starts from."""
    drop = -np.sin(NEUTRAL_ARM_DROP)
    reach = np.cos(NEUTRAL_ARM_DROP)
    aims = {name: np.array([0.0, 1.0, 0.0]) for name in SPINE_CHAIN}
    for side, sx in (('Left', 1.0), ('Right', -1.0)):
        aims[f'{side}Shoulder'] = np.array([sx, 0.0, 0.0])
        for bone in ('Arm', 'ForeArm', 'Hand'):
            aims[f'{side}{bone}'] = unit([sx * reach, drop, NEUTRAL_ARM_FORWARD])
        aims[f'{side}UpLeg'] = unit([-sx * 0.05, -1.0, 0.02])
        aims[f'{side}Leg'] = np.array([0.0, -1.0, 0.03])
        aims[f'{side}Foot'] = unit([0.0, -0.42, 1.0])
    return aims


# --------------------------------------------------------------------------
# Stage 5: write the rigged GLB
# --------------------------------------------------------------------------

def pad4(blob):
    return blob + b'\x00' * (-len(blob) % 4)


class BufferWriter:
    """Appends accessors to a GLB's single binary chunk."""

    def __init__(self, gltf, blob):
        self.gltf = gltf
        self.chunks = [pad4(blob)]
        self.offset = len(self.chunks[0])

    def add(self, array, component_type, accessor_type, target=None, minmax=False):
        import pygltflib
        array = np.ascontiguousarray(array)
        raw = array.tobytes()
        self.gltf.bufferViews.append(pygltflib.BufferView(
            buffer=0, byteOffset=self.offset, byteLength=len(raw), target=target))
        self.chunks.append(pad4(raw))
        self.offset += len(pad4(raw))
        count = array.shape[0]
        accessor = pygltflib.Accessor(bufferView=len(self.gltf.bufferViews) - 1,
                                      componentType=component_type, count=count,
                                      type=accessor_type)
        if minmax:
            flat = array.reshape(count, -1)
            accessor.min = flat.min(0).tolist()
            accessor.max = flat.max(0).tolist()
        self.gltf.accessors.append(accessor)
        return len(self.gltf.accessors) - 1

    def finish(self):
        blob = b''.join(self.chunks)
        self.gltf.buffers[0].byteLength = len(blob)
        self.gltf.set_binary_blob(blob)


BONE_PREFIX = 'mixamorig:'


def write_rig(gltf, blob, skel, joint_index, weights, rest_locals, clips):
    """Graft skeleton, skin and clips onto the source GLB, bytes intact.

    The mesh, its materials and its three 2K textures are never touched: the
    original buffer is kept verbatim and everything new is appended after it, so
    the rigged file is the same model rather than a re-export of it.
    """
    import pygltflib
    writer = BufferWriter(gltf, blob)

    mesh_node = next(i for i, n in enumerate(gltf.nodes) if n.mesh is not None)
    first_bone = len(gltf.nodes)
    for bone in skel.bones:
        q = rest_locals[bone.name]
        gltf.nodes.append(pygltflib.Node(
            name=BONE_PREFIX + bone.name,
            translation=[float(v) for v in skel.local_rest_translation(bone)],
            rotation=[float(v) for v in q],
            children=[first_bone + skel.by_name[c].index for c in bone.children] or None,
        ))

    inverse_bind = np.zeros((len(skel.bones), 16), np.float32)
    for bone in skel.bones:
        m = np.eye(4, dtype=np.float32)
        m[3, :3] = -bone.head            # column-major identity-rotation inverse
        inverse_bind[bone.index] = m.reshape(-1)

    ibm = writer.add(inverse_bind, pygltflib.FLOAT, 'MAT4')
    joints = writer.add(joint_index, pygltflib.UNSIGNED_SHORT, 'VEC4',
                        target=pygltflib.ARRAY_BUFFER)
    skin_weights = writer.add(weights, pygltflib.FLOAT, 'VEC4',
                              target=pygltflib.ARRAY_BUFFER)

    gltf.skins.append(pygltflib.Skin(
        name='pill-rig', inverseBindMatrices=ibm, skeleton=first_bone,
        joints=[first_bone + b.index for b in skel.bones]))
    gltf.nodes[mesh_node].skin = len(gltf.skins) - 1
    primitive = gltf.meshes[gltf.nodes[mesh_node].mesh].primitives[0]
    primitive.attributes.JOINTS_0 = joints
    primitive.attributes.WEIGHTS_0 = skin_weights

    scene = gltf.scenes[gltf.scene or 0]
    if first_bone not in scene.nodes:
        scene.nodes.append(first_bone)
    # A skinned mesh node must not inherit the skeleton's motion, or every bone
    # transform is applied twice. Its own transform is the identity already.
    gltf.nodes[mesh_node].matrix = None

    for clip in clips:
        animation = pygltflib.Animation(name=clip['name'], samplers=[], channels=[])
        times = writer.add(clip['times'].astype(np.float32), pygltflib.FLOAT, 'SCALAR',
                           minmax=True)
        for bone_name, track in clip['rotation'].items():
            sampler = len(animation.samplers)
            animation.samplers.append(pygltflib.AnimationSampler(
                input=times, interpolation='LINEAR',
                output=writer.add(track.astype(np.float32), pygltflib.FLOAT, 'VEC4')))
            animation.channels.append(pygltflib.AnimationChannel(
                sampler=sampler,
                target=pygltflib.AnimationChannelTarget(
                    node=first_bone + skel.by_name[bone_name].index, path='rotation')))
        for bone_name, track in clip.get('translation', {}).items():
            sampler = len(animation.samplers)
            animation.samplers.append(pygltflib.AnimationSampler(
                input=times, interpolation='LINEAR',
                output=writer.add(track.astype(np.float32), pygltflib.FLOAT, 'VEC3')))
            animation.channels.append(pygltflib.AnimationChannel(
                sampler=sampler,
                target=pygltflib.AnimationChannelTarget(
                    node=first_bone + skel.by_name[bone_name].index, path='translation')))
        gltf.animations.append(animation)

    writer.finish()
    return first_bone


# --------------------------------------------------------------------------
# Debug overlay
# --------------------------------------------------------------------------

def debug_overlay(path, vertices, colors, skel, pose_world=None, title=''):
    """Three orthographic views with the skeleton drawn over the point cloud."""
    from PIL import Image, ImageDraw
    S, PAD, LIM = 640, 34, 1.12
    views = (('FRONT  x/y', 0, 1), ('SIDE  z/y', 2, 1), ('TOP  x/z', 0, 2))
    sheet = Image.new('RGB', (S * 3, S), (16, 17, 21))
    for k, (label, a, b) in enumerate(views):
        img = Image.new('RGB', (S, S), (16, 17, 21))
        px = img.load()

        def to_px(p):
            u = int((p[a] + LIM) / (2 * LIM) * (S - 2 * PAD) + PAD)
            v = S - int((p[b] + LIM) / (2 * LIM) * (S - 2 * PAD) + PAD)
            return u, v

        step = max(1, len(vertices) // 90000)
        for i in range(0, len(vertices), step):
            u, v = to_px(vertices[i])
            if 0 <= u < S and 0 <= v < S:
                c = colors[i]
                px[u, v] = (int(60 + c[0] * 70), int(60 + c[1] * 70), int(64 + c[2] * 70))
        d = ImageDraw.Draw(img)
        for t in np.arange(-1.0, 1.01, 0.5):
            u, v = to_px({0: [t, t, t]}[0])
            d.line([(u, 0), (u, S)], fill=(38, 39, 46))
            d.line([(0, v), (S, v)], fill=(38, 39, 46))
        for bone in skel.bones:
            head = pose_world[bone.name] if pose_world else bone.head
            if bone.parent:
                parent = pose_world[bone.parent] if pose_world else skel.by_name[bone.parent].head
                d.line([to_px(parent), to_px(head)], fill=(255, 138, 60), width=2)
            u, v = to_px(head)
            d.ellipse([u - 3, v - 3, u + 3, v + 3], fill=(120, 230, 255))
        d.text((10, 10), f'{label}   {title}', fill=(232, 234, 240))
        sheet.paste(img, (k * S, 0))
    sheet.save(path)


def build_clips(skel):
    return []


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source')
    ap.add_argument('--out', required=True)
    ap.add_argument('--debug-dir', default=None,
                    help='write orthographic skeleton overlays here')
    args = ap.parse_args()

    import pygltflib
    gltf = pygltflib.GLTF2().load(args.source)
    blob = gltf.binary_blob()
    mesh = trimesh.load(args.source, force='mesh', process=False)
    vertices = np.asarray(mesh.vertices)
    print(f'{args.source}: {len(vertices)} verts, {len(mesh.faces)} tris')

    a = analyse(mesh, gltf, blob)
    print(f"  facing {np.round(a['facing'], 3)} from {a['face_px']} face pixels"
          f" (painted {a['face_skew']:.1f} deg off axis)")
    print(f"  body y [{a['body_y0']:+.3f}, {a['body_y1']:+.3f}]")
    for name, limb in a['limbs'].items():
        print(f"  {name:10s} root {np.round(limb[0][0], 3)} tip {np.round(limb[0][-1], 3)}"
              f" r={limb[1]:.3f}"
              + (f" ankle={limb[2]:.2f} toe {np.round(limb[3], 3)}" if len(limb) > 2 else ''))

    axis = a['body_axis']
    roots = symmetrize_roots(a['limbs'], float(np.median(axis[:, 0])),
                             float(np.median(axis[:, 2])))
    skel = build_skeleton(a['limbs'], roots, axis, a['body_y0'], a['body_y1'])
    print(f'  skeleton: {len(skel.bones)} bones')

    joint_index, weights = skin(vertices, skel, a['filled'], a['thickness'],
                                a['lo'], a['limbs'], roots)
    used = len(set(joint_index[weights > 0.02].ravel().tolist()))
    print(f'  skinned: {used}/{len(skel.bones)} bones carry weight above 2%')

    rest_locals, rest_world, _ = skel.solve(neutral_pose(skel))
    clips = build_clips(skel)
    print(f"  clips: {', '.join(c['name'] for c in clips)}")

    write_rig(gltf, blob, skel, joint_index, weights, rest_locals, clips)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    gltf.save(args.out)
    print(f'  wrote {args.out} ({Path(args.out).stat().st_size / 1e6:.1f} MB)')

    if args.debug_dir:
        out = Path(args.debug_dir)
        out.mkdir(parents=True, exist_ok=True)
        debug_overlay(out / 'bind.png', vertices, a['colors'], skel, title='bind (sculpted)')
        debug_overlay(out / 'neutral.png', vertices, a['colors'], skel, rest_world,
                      title='rest (neutral)')
        print(f'  wrote {out}/bind.png, {out}/neutral.png')


if __name__ == '__main__':
    main()
