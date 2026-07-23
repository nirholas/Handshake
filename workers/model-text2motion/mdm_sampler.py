"""MDM (Motion Diffusion Model) sampler adapter.

Thin wrapper around GuyTevet/motion-diffusion-model (MIT) that turns a text
prompt into SMPL-skeleton motion: per-frame local joint rotations (axis-angle,
24 joints) plus a root translation. Everything torch/MDM-specific is imported
lazily inside `sample()` so this module imports cleanly in environments without
the GPU stack (the worker's pure conversion path + tests). Loaded once per
container by main.py's `_load_model()`.

The MDM repo is cloned into the image (see Dockerfile) and put on PYTHONPATH;
checkpoints are mounted from the weights bucket at `model_dir`.
"""

from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("text2motion.mdm")

# HumanML3D motion is sampled at 20 fps; we resample to the requested fps in the
# worker via the clip times. MDM's max horizon for the HumanML3D checkpoint.
HUMANML_FPS = 20
MAX_MOTION_LEN = 196


class MdmSampler:
    def __init__(self, model_dir: str, device: str = "cuda"):
        self.model_dir = model_dir
        self.device = device
        self._model = None
        self._diffusion = None
        self._load()

    def _load(self) -> None:
        # Imports are GPU-only — kept here so the module imports without torch.
        import json
        import os
        from types import SimpleNamespace

        import torch
        import torch.nn as nn
        import model.mdm as mdm_module
        from model.cfg_sampler import ClassifierFreeSampleModel
        from utils.model_util import create_model_and_diffusion, load_model_wo_clip

        # MDM.__init__ unconditionally builds `self.rot2xyz = Rotation2xyz(...)`,
        # whose constructor loads the real SMPL body model (a .pkl gated behind
        # SMPL's own registration/license at smpl.is.tue.mpg.de — not something
        # an automated pipeline can fetch). This worker never calls
        # `rot2xyz(...)` (the thing that would actually need real SMPL data):
        # motion comes back from the diffusion sampler as HumanML3D feature
        # vectors, decoded via `recover_from_ric` + this module's own
        # direction-alignment IK (`_positions_to_local_quats`), never via
        # rotation2xyz. But `MDM._apply`/`MDM.train` (invoked by the
        # `.to(device)`/`.eval()` calls below, which is how the model actually
        # loads onto the GPU) reach into `self.rot2xyz.smpl_model._apply`/
        # `.train`, so it still needs to be a real `nn.Module` — just one that
        # never had to load a license-gated file to exist. Patched on the
        # already-imported `model.mdm` module object so it takes effect
        # regardless of import order.
        class _StubSmplModel(nn.Module):
            def forward(self, *a, **kw):
                raise RuntimeError("SMPL rotation2xyz output is not used by this worker")

        class _StubRotation2xyz:
            def __init__(self, device, dataset="amass"):
                self.device = device
                self.dataset = dataset
                self.smpl_model = _StubSmplModel().to(device)

            def __call__(self, *a, **kw):
                raise RuntimeError("Rotation2xyz.__call__ is not used by this worker")

        mdm_module.Rotation2xyz = _StubRotation2xyz

        # utils.parser_util.generate_args() takes no parameters and parses
        # sys.argv (a CLI-only entry point, not usable from a server process —
        # a prior version of this file called it as `generate_args(model_path=...)`,
        # which doesn't match its signature at all). The released checkpoints
        # ship an `args.json` sibling to the `.pt` file with every field the
        # model/diffusion constructors need (see MDM's own
        # `load_args_from_model`); load that directly into a plain namespace.
        with open(os.path.join(self.model_dir, "args.json")) as fh:
            args = SimpleNamespace(**json.load(fh))
        self._args = args
        self._guidance_param = getattr(args, "guidance_param", 2.5)

        # create_model_and_diffusion()'s `data` param is only consulted for
        # `data.dataset.num_actions` (action-conditioned datasets); passing
        # None crashes on that attribute access before the humanml/text-cond
        # branch (which doesn't need it) is ever reached.
        dummy_data = SimpleNamespace(dataset=SimpleNamespace())
        model, diffusion = create_model_and_diffusion(args, dummy_data)
        state = torch.load(os.path.join(self.model_dir, "model.pt"), map_location="cpu")
        load_model_wo_clip(model, state)
        # NOT `model.to(device).eval()`: torch's Module.to() returns
        # `self._apply(convert)` (verified against torch 2.3.1's own source),
        # but MDM's `_apply` override (`def _apply(self, fn): super()._apply(fn);
        # self.rot2xyz.smpl_model._apply(fn)`) never returns `self` — an
        # upstream bug that makes `.to()` return None regardless of which
        # smpl_model is attached. `model` itself is still correctly mutated
        # in place, so call `.to()`/`.eval()` for their side effects only and
        # keep using the original reference.
        model.to(self.device)
        model.eval()
        # Classifier-free guidance sampling wrapper — matches sample/generate.py's
        # own gating (skip the wrapper entirely when guidance_param == 1).
        if self._guidance_param != 1:
            model = ClassifierFreeSampleModel(model)
        self._model = model
        self._diffusion = diffusion
        log.info(
            "MDM model + diffusion ready on %s (arch=%s, diffusion_steps=%s, guidance=%s)",
            self.device, args.arch, args.diffusion_steps, self._guidance_param,
        )

    def sample(self, prompt: str, n_frames: int):
        """Text → (poses (T,24,3) axis-angle, trans (T,3)).

        Samples HumanML3D motion for `prompt`, recovers SMPL joint rotations and
        root translation, and resamples to `n_frames`.
        """
        import torch

        horizon = min(MAX_MOTION_LEN, max(2, int(round(n_frames * HUMANML_FPS / max(n_frames, 1))) or n_frames))
        horizon = min(MAX_MOTION_LEN, max(2, n_frames))

        # MDM.forward reads `y['mask'].shape[-1]` unconditionally (see model/mdm.py:
        # `is_valid_mask = y['mask'].shape[-1] > 1`) even though this deployment's
        # checkpoint has mask_frames=False, so the key must exist regardless. A
        # single unpadded prompt at exactly `horizon` frames has no padding, so
        # the honest mask a real (non-padded) batch's collate would produce is
        # all-ones over the full length — shape (bs, 1, 1, horizon), matching
        # sample/generate.py's own `model_kwargs['y']['mask']` convention.
        mask = torch.ones((1, 1, 1, horizon), dtype=torch.bool, device=self.device)
        model_kwargs = {
            "y": {"text": [prompt], "lengths": torch.tensor([horizon], device=self.device), "mask": mask}
        }
        if self._guidance_param != 1:
            model_kwargs["y"]["scale"] = torch.ones(1, device=self.device) * self._guidance_param
        sample_fn = self._diffusion.p_sample_loop
        with torch.no_grad():
            sample = sample_fn(
                self._model,
                (1, self._model.njoints, self._model.nfeats, horizon),
                clip_denoised=False,
                model_kwargs=model_kwargs,
                progress=False,
            )

        # Decode the HumanML3D vector representation back to joint rotations +
        # root translation, then to SMPL-indexed axis-angle.
        poses, trans = _decode_to_smpl(sample)
        poses = np.asarray(poses, dtype=np.float64)
        trans = np.asarray(trans, dtype=np.float64)
        poses, trans = _resample(poses, trans, n_frames)
        return poses, trans


def _decode_to_smpl(sample):
    """Decode an MDM sample tensor to (poses (T,22,3) axis-angle, trans (T,3)).

    MDM's HumanML3D checkpoint emits a 263-dim feature vector per frame.
    `recover_from_ric` (upstream, real) turns that back into global joint
    *positions* on the 22-joint HumanML3D skeleton — the SMPL body joints 0-21
    under the same kinematic tree (paramUtil.t2m_kinematic_chain).

    There is no upstream `positions_to_smpl_poses` in the MDM repo (a prior
    version of this file imported one that does not exist — verified against
    github.com/GuyTevet/motion-diffusion-model). Converting positions to local
    joint *rotations* is done here directly by `_positions_to_local_quats`: a
    joint's local rotation is recovered from where ITS OWN children ended up
    (not its own position, which under standard FK only depends on ancestor
    rotations), via a best-fit (Kabsch) rotation from each child's rest
    direction (`paramUtil.t2m_raw_offsets`, upstream data) to its measured
    direction. This carries no twist signal (same limitation HumanML3D's
    output has generally) — `smpl_to_clip`'s `rest_offsets` param is the
    intended place to calibrate the residual SMPL-rest vs. Wolf3D-rest
    orientation offset.
    """
    import torch
    from data_loaders.humanml.scripts.motion_process import recover_from_ric
    from data_loaders.humanml.utils import paramUtil

    n_joints = 22

    # sample: (1, njoints=263, nfeats=1, T) → (T, 263). NOT
    # `.squeeze(0).permute(2,0,1)` (a prior version of this code did that): that
    # reorders to (T, 263, 1) and leaves the size-1 nfeats axis trailing, so
    # `recover_from_ric`'s `data[..., 0]` etc. (which assume the LAST dim is the
    # 263-wide feature vector) silently slice the wrong axis instead of failing
    # loudly. `.squeeze(1)` first removes nfeats, then permute puts T first.
    feats = sample.squeeze(0).squeeze(1).permute(1, 0).float()  # (T, 263)

    # The diffusion model samples in HumanML3D's NORMALIZED feature space
    # (zero mean / unit std over the training set) — recover_from_ric expects
    # real units. Denormalize with the checkpoint-independent HumanML3D dataset
    # stats MDM ships in its own repo (`dataset/t2m_{mean,std}.npy`, small
    # precomputed arrays, not a license-gated model file), exactly the
    # `inv_transform` upstream's own sample/generate.py applies before calling
    # this same recover_from_ric.
    # PYTHONPATH=/opt/mdm is fixed by the Dockerfile's `git clone ... /opt/mdm`.
    mean = torch.from_numpy(np.load("/opt/mdm/dataset/t2m_mean.npy")).float().to(feats.device)
    std = torch.from_numpy(np.load("/opt/mdm/dataset/t2m_std.npy")).float().to(feats.device)
    feats = feats * std + mean

    positions = recover_from_ric(feats, n_joints)  # (T, 22, 3)
    positions = positions.cpu().numpy().astype(np.float64)

    parents = _parents_from_kinematic_chain(paramUtil.t2m_kinematic_chain, n_joints)
    rest_dirs = paramUtil.t2m_raw_offsets.astype(np.float64)  # (22, 3), joint 0 unused

    local_quat = _positions_to_local_quats(positions, parents, rest_dirs)  # (T, 22, 4) xyzw
    poses = _quat_to_axis_angle(local_quat)  # (T, 22, 3)
    trans = positions[:, 0, :]  # root joint IS the world root position
    return poses, trans


def _parents_from_kinematic_chain(kinematic_chain, n_joints: int) -> np.ndarray:
    """Flatten paramUtil's per-limb chains (each starting at the root, joint 0)
    into a single parent-index array, e.g. [-1, 2, 5, 8, ...] for a 22-joint
    skeleton. Every joint in the topology appears in exactly one chain."""
    parents = np.full(n_joints, -1, dtype=np.int64)
    for chain in kinematic_chain:
        for i in range(1, len(chain)):
            parents[chain[i]] = chain[i - 1]
    return parents


def _quat_conjugate(q: np.ndarray) -> np.ndarray:
    return np.concatenate([-q[..., :3], q[..., 3:4]], axis=-1)


def _quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        axis=-1,
    )


def _quat_rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    qv = np.concatenate([v, np.zeros_like(v[..., :1])], axis=-1)
    return _quat_multiply(_quat_multiply(q, qv), _quat_conjugate(q))[..., :3]


def _rotation_matrix_to_quat(r: np.ndarray) -> np.ndarray:
    """(...,3,3) proper rotation matrices → (...,4) xyzw quaternions."""
    m00, m01, m02 = r[..., 0, 0], r[..., 0, 1], r[..., 0, 2]
    m10, m11, m12 = r[..., 1, 0], r[..., 1, 1], r[..., 1, 2]
    m20, m21, m22 = r[..., 2, 0], r[..., 2, 1], r[..., 2, 2]
    trace = m00 + m11 + m22
    w = 0.5 * np.sqrt(np.maximum(1.0 + trace, 1e-12))
    safe_w = np.where(w < 1e-6, 1.0, w)
    x = (m21 - m12) / (4.0 * safe_w)
    y = (m02 - m20) / (4.0 * safe_w)
    z = (m10 - m01) / (4.0 * safe_w)
    quat = np.stack([x, y, z, w], axis=-1)
    norm = np.linalg.norm(quat, axis=-1, keepdims=True)
    return quat / np.where(norm < 1e-8, 1.0, norm)


def _kabsch_quat(sources: np.ndarray, targets: np.ndarray) -> np.ndarray:
    """Best-fit rotation quaternion mapping unit-vector set `sources` onto
    `targets`, batched over frames. `sources`/`targets`: (T, K, 3). Minimizes
    sum_k |R @ sources[k] - targets[k]|^2 (Kabsch/Procrustes, reflection-
    corrected so R is always a proper rotation). K == 1 degenerates to a
    shortest-arc rotation with an unconstrained twist about that one axis —
    the same ambiguity single-child joints have regardless of method, since
    HumanML3D position data carries no twist signal for any joint."""
    h = np.einsum("tka,tkb->tab", sources, targets)  # (T,3,3)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(np.einsum("tab,tbc->tac", vt.transpose(0, 2, 1), u.transpose(0, 2, 1))))
    diag = np.tile(np.eye(3), (h.shape[0], 1, 1))
    diag[:, 2, 2] = d
    r = np.einsum("tab,tbc,tcd->tad", vt.transpose(0, 2, 1), diag, u.transpose(0, 2, 1))
    return _rotation_matrix_to_quat(r)


def _positions_to_local_quats(
    positions: np.ndarray, parents: np.ndarray, rest_dirs: np.ndarray
) -> np.ndarray:
    """(T,J,3) global positions → (T,J,4) local xyzw quaternions per the
    `parents`/`rest_dirs` topology.

    A joint's local rotation `R_j` is NOT observable from its own position —
    under standard skeletal FK (global_j = global_parent(j) * R_j, and the
    *fixed* rest offset rotates with the PARENT's global orientation only:
    pos[j] - pos[parent(j)] = rotate(global_parent(j), rest_dirs[j])) that
    offset doesn't involve R_j at all. R_j only shows up in where j's OWN
    children end up. So this recovers R_j, per joint, from the directions to
    j's children: best-fit (Kabsch) rotation mapping each child's rest
    direction (in j's parent-relative frame) onto its measured direction,
    across however many children j has (root and the chest joint branch into
    3; most joints have exactly 1, where Kabsch degenerates to a shortest-arc
    solve). Leaf joints (hands, feet, head) have no children and no positional
    evidence for their own twist, so they get an identity local rotation.
    """
    n_frames, n_joints, _ = positions.shape
    local_quat = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (n_frames, n_joints, 1))
    global_quat = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (n_frames, n_joints, 1))

    children_of = [[] for _ in range(n_joints)]
    for j in range(1, n_joints):
        children_of[parents[j]].append(j)

    # Single top-down pass: `parents[j] < j` for this topology (verified — the
    # kinematic chains are built root-outward), so global_quat[parents[j]] is
    # always already resolved by the time joint j is processed.
    for j in range(n_joints):
        kids = children_of[j]
        if kids:
            rest = rest_dirs[np.array(kids)]  # (K,3)
            rest = rest / np.linalg.norm(rest, axis=-1, keepdims=True)
            rest = np.broadcast_to(rest, (n_frames,) + rest.shape).copy()  # (T,K,3)

            measured = positions[:, kids, :] - positions[:, j : j + 1, :]  # (T,K,3)
            measured = measured / np.linalg.norm(measured, axis=-1, keepdims=True)

            if j == 0:
                targets_in_parent_frame = measured  # root: parent frame == world
            else:
                p = parents[j]
                k = measured.shape[1]
                parent_conj = np.broadcast_to(_quat_conjugate(global_quat[:, p])[:, None, :], (n_frames, k, 4))
                targets_in_parent_frame = _quat_rotate(parent_conj, measured)

            local_quat[:, j] = _kabsch_quat(rest, targets_in_parent_frame)
        # else: leaf joint, no positional evidence for its own twist — identity.

        global_quat[:, j] = (
            local_quat[:, j] if j == 0 else _quat_multiply(global_quat[:, parents[j]], local_quat[:, j])
        )

    return local_quat


def _quat_to_axis_angle(q: np.ndarray) -> np.ndarray:
    """(...,4) xyzw quaternion → (...,3) axis-angle."""
    q = q / np.where(np.linalg.norm(q, axis=-1, keepdims=True) < 1e-8, 1.0, np.linalg.norm(q, axis=-1, keepdims=True))
    w = np.clip(q[..., 3], -1.0, 1.0)
    angle = 2.0 * np.arccos(w)
    sin_half = np.sqrt(np.maximum(1.0 - w * w, 0.0))
    safe_sin = np.where(sin_half < 1e-8, 1.0, sin_half)
    axis = q[..., :3] / safe_sin[..., None]
    aa = axis * angle[..., None]
    return np.where(sin_half[..., None] < 1e-8, 0.0, aa)


def _resample(poses: np.ndarray, trans: np.ndarray, n_frames: int):
    """Linear-resample motion to exactly `n_frames` frames."""
    src = poses.shape[0]
    if src == n_frames:
        return poses, trans
    src_t = np.linspace(0.0, 1.0, src)
    dst_t = np.linspace(0.0, 1.0, n_frames)
    out_poses = np.empty((n_frames,) + poses.shape[1:], dtype=poses.dtype)
    flat = poses.reshape(src, -1)
    out = np.empty((n_frames, flat.shape[1]), dtype=poses.dtype)
    for c in range(flat.shape[1]):
        out[:, c] = np.interp(dst_t, src_t, flat[:, c])
    out_poses = out.reshape((n_frames,) + poses.shape[1:])
    out_trans = np.empty((n_frames, 3), dtype=trans.dtype)
    for c in range(3):
        out_trans[:, c] = np.interp(dst_t, src_t, trans[:, c])
    return out_poses, out_trans
