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


def build_skeleton(limbs, body_axis, body_y0, body_y1):
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
        shoulder = sample_curve(curve, 0.0)
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
        hip = sample_curve(curve, 0.0)
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

    radius = np.interp(best_u, arc, sample_thickness(thickness, lo, line))
    claim = np.exp(-np.clip(best_d / np.maximum(radius * 1.25, 1e-4), 0, 6) ** 4)
    return weights, claim


def limb_envelope(vertices, bone, root_radius):
    """Soft tube around one limb bone, fattest where it enters the body.

    The tube widens toward the root so the fillet where a nub meets the capsule
    travels with the nub instead of creasing, and is capped there so a shoulder
    bone buried in the body cannot claim the belly behind it.
    """
    d, t = point_segment_distance(vertices, bone.head, bone.tail)
    near = min(root_radius, bone.radius * 1.9)
    far = bone.radius * 1.35
    radius = near + (far - near) * t
    return np.exp(-np.clip(d / radius, 0, 6) ** 4)


def smooth_weights(vertices, weights, rounds=2, k=10):
    """Average each vertex's weights with its spatial neighbours.

    Spatial, not topological: this mesh is 286 disconnected shells, so a
    face-adjacency graph would leave seams unsmoothed exactly where two shells
    meet. Nearest neighbours in space weld them.
    """
    from scipy.spatial import cKDTree
    tree = cKDTree(vertices)
    _, idx = tree.query(vertices, k=k)
    for _ in range(rounds):
        weights = 0.35 * weights + 0.65 * weights[idx].mean(axis=1)
    return weights


def skin(vertices, skel, thickness, lo):
    names = [b.name for b in skel.bones]
    weights = np.zeros((len(vertices), len(names)), np.float32)

    torso, claim = torso_weights(vertices, skel, thickness, lo)
    for i, name in enumerate(SPINE_CHAIN):
        weights[:, names.index(name)] = torso[:, i] * claim

    for bone in skel.bones:
        if bone.name in SPINE_CHAIN:
            continue
        root = float(sample_thickness(thickness, lo, bone.head[None, :])[0])
        weights[:, bone.index] = limb_envelope(vertices, bone, root)

    weights = smooth_weights(vertices, weights)
    order = np.argsort(weights, axis=1)[:, ::-1][:, :MAX_INFLUENCES]
    kept = np.take_along_axis(weights, order, axis=1)
    total = kept.sum(1, keepdims=True)
    orphan = (total[:, 0] < 1e-6)
    if orphan.any():
        # Nothing claimed these -- park them on the nearest bone rather than
        # letting a zero-weight vertex collapse to the origin.
        centres = np.array([(b.head + b.tail) * 0.5 for b in skel.bones])
        nearest = np.argmin(((vertices[orphan][:, None, :] - centres) ** 2).sum(2), axis=1)
        order[orphan, 0] = nearest
        kept[orphan] = 0.0
        kept[orphan, 0] = 1.0
        total[orphan] = 1.0
    return order.astype(np.uint16), (kept / total).astype(np.float32)



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
        curve, nub = limb[0], limb[1]
        print(f"  {name:10s} root {np.round(curve[0], 3)} tip {np.round(curve[-1], 3)} r={nub:.3f}"
              + (f" ankle_t={limb[2]:.2f} toe {np.round(limb[3], 3)}" if len(limb) > 2 else ''))

    skel = build_skeleton(a['limbs'], a['body_axis'], a['body_y0'], a['body_y1'])
    print(f'  skeleton: {len(skel.bones)} bones')
    if args.debug_dir:
        Path(args.debug_dir).mkdir(parents=True, exist_ok=True)
        debug_overlay(Path(args.debug_dir) / 'bind.png', vertices, a['colors'], skel,
                      title='bind (sculpted)')
        print(f"  wrote {Path(args.debug_dir) / 'bind.png'}")


if __name__ == '__main__':
    main()
