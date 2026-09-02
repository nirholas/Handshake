# NGC Catalog listing: the one NVIDIA directory with a self-serve door

[nvidia-visibility-map.md](./nvidia-visibility-map.md) records that no self-serve
"list my product" form exists on any NVIDIA surface. That is true of every
surface except one. The [NGC Software Partner program](https://www.nvidia.com/en-us/gpu-cloud/ngc-software-partners/)
publishes a **Become an NGC Software Partner** form, and a container published
through it lands in [catalog.ngc.nvidia.com](https://catalog.ngc.nvidia.com/)
permanently, hosted by NVIDIA, on NVIDIA's domain, in front of NVIDIA's
enterprise audience.

The Accelerated Apps Catalog is a marketing listing of the company. An NGC
listing is a distribution channel for the software itself. They are worth
pursuing in parallel and this doc covers only the second; the first has its own
kit in [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md).

Prerequisites and process below were re-fetched from NVIDIA's page on
2026-09-02. Every claim about our own containers is cited to the file that
proves it.

---

## Verdict

**Publishable candidate: [workers/model-trellis](../workers/model-trellis).**
Single image in, textured GLB out, on one L4. It is the strongest of the GPU
fleet for an outside user because its model is MIT-licensed, its weights are not
baked into the image, and it collects nothing.

**Three of NVIDIA's four prerequisites are met today. The fourth (the EULA) is
met by this change.** What actually blocks a submission is not NVIDIA's list, it
is that the container currently assumes it is running inside our Google Cloud
project. An NGC user has no `GCS_BUCKET`, so the image as built refuses to start
for them. That is [gate 1](#gate-1-the-container-must-run-outside-our-cloud-project)
below, and it is the only substantial piece of work between here and a
submission.

## Prerequisite audit

NVIDIA's four published prerequisites, each against the code:

| NVIDIA prerequisite | Status | Evidence |
|---|---|---|
| Containerized using the CUDA 9 or later base container | **Met** | `FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04` in [workers/model-trellis/Dockerfile](../workers/model-trellis/Dockerfile). Eight GPU workers in the tree are built on `nvidia/cuda` 12.1 to 12.8. |
| GPU accelerated, automatically multi-GPU capable, runs on Pascal or newer | **Partly met** | GPU acceleration is the whole point of the image: TRELLIS with nvdiffrast, diffoctreerast, diff-gaussian-rasterization and NVIDIA Kaolin, all compiled with nvcc at build time. It is single-GPU by design (`MAX_CONCURRENT` defaults to 1, one L4 fits exactly one inference) and its kernels are compiled for `sm_89` only. See [gate 2](#gate-2-the-kernels-are-compiled-for-one-gpu-generation). |
| An end-user license agreement for the application | **Met by this change** | [NVIDIA NGC Container EULA](https://three.ws/legal/nvidia-ngc-eula), source at [public/legal/nvidia-ngc-eula.html](../public/legal/nvidia-ngc-eula.html). It covers the Apache-2.0 code, the third-party components, and the fact that the image ships no weights. |
| Container does not collect personal data or violate GDPR | **Met** | The worker has no analytics, telemetry, or reporting of any kind: a search of [workers/model-trellis](../workers/model-trellis) for `posthog`, `analytics`, `telemetry`, `mixpanel`, and `sentry` returns nothing. The only outbound calls it makes are the ones the caller asks for, and those go through the SSRF guard in [worker_security.py](../workers/model-trellis/worker_security.py). |

## Why this container and not the others

| Worker | Model license | Verdict for NGC |
|---|---|---|
| [model-trellis](../workers/model-trellis) | Microsoft TRELLIS, MIT | **Candidate.** Commercial-safe upstream, weights fetched by the user. |
| [model-text2motion](../workers/model-text2motion) | MDM, MIT | **Second candidate.** Commercial-safe code and model, but the deployed HumanML3D checkpoint inherits research-only dataset terms, so the listing would have to point users at the upstream checkpoint and say so plainly. |
| [model-hunyuan3d](../workers/model-hunyuan3d) | Tencent Hunyuan **non-commercial** | **Not publishable.** The license is documented in [its README](../workers/model-hunyuan3d/README.md). Publishing a serving image for it into an enterprise catalog invites exactly the use the license forbids. |
| [model-triposg](../workers/model-triposg), [model-triposr](../workers/model-triposr), [model-video2scene](../workers/model-video2scene), [avatar-reconstruction](../workers/avatar-reconstruction), [longcat](../workers/longcat) | Mixed | Not first. Each carries its own upstream terms to clear, and one clean listing beats five contested ones. |

None of these images bake weights, which is what makes any of this possible: the
container is our serving code plus a CUDA build, and the user brings the model.

## The gates

### Gate 1: the container must run outside our cloud project

[main.py](../workers/model-trellis/main.py) reads `GCS_BUCKET = os.environ["GCS_BUCKET"]`
at import and uploads every finished mesh with `storage.Client()`. On an NGC
user's machine there is no bucket and no credential, so the process exits before
it serves a request. Weights are already fine: `WEIGHTS_DIR` defaults to a local
path and `WEIGHTS_GCS_URI` staging is optional, so a user who downloads the
TRELLIS weights from Hugging Face and mounts them is served by the existing code
path.

What the listing needs is an output backend selected by configuration:

- Keep the current behaviour byte-for-byte when `GCS_BUCKET` is set, so nothing
  about the production forge lane changes.
- When it is unset, write the GLB to `OUTPUT_DIR` (default `/output`, a mounted
  volume) and return a path plus a `GET /results/{task_id}.glb` download route
  instead of a `storage.googleapis.com` URL.
- Report the active backend in `GET /health` so an operator can tell which mode
  the instance came up in.

The worker's tests run inside the built image (`docker run --rm model-trellis
python3 test_app_contract.py`), so this change is verified by a GPU build, not
from a laptop. Budget one Cloud Build run for it.

### Gate 2: the kernels are compiled for one GPU generation

The Dockerfile sets `TORCH_CUDA_ARCH_LIST="8.9"`, deliberately, to keep our own
builds fast on the L4 fleet. An image compiled for `sm_89` alone does not run on
the Ampere, Hopper, or Blackwell hardware an NGC user is most likely to have,
and NVIDIA's prerequisite reads "Pascal or newer".

The fix is a build argument and a wider arch list for the published image only,
but the arch matrix has to be decided by an actual build: the compiled
extensions (diffoctreerast, diff-gaussian-rasterization, nvdiffrast) are not all
buildable on every architecture in that range, and a list that fails to compile
is worse than a narrow one that works. Determine the real matrix in the same
Cloud Build run as gate 1 and pin what compiles.

### Gate 3: the NGC partner legal agreement

Owner action. It is step 1 of NVIDIA's published process and nothing technical
depends on it, so it can be signed while gates 1 and 2 are being built.

## The publishing process, as NVIDIA documents it

1. Sign the NGC Partner Legal Agreement.
2. Push the container to an NGC private staging repository.
3. Pass container security scanning and quality-assurance testing.
4. Complete final sign-off, after which the image goes live in the catalog.

Step 3 is the one to prepare for. A `devel` CUDA base ships a compiler and a
large package surface, so expect the scan to flag CVEs in build tooling we do
not need at run time. If it does, the answer is a two-stage build that compiles
the CUDA extensions in the `devel` image and copies them into a `runtime` base,
which also cuts the published image size.

## Listing content, paste-ready

**Publisher:** three.ws

**Container name:** `three-ws/trellis-mesh-server`

**Display name:** three.ws TRELLIS Mesh Server

**Short description (about 120 characters)**

> A GPU inference server that turns a single image into a textured, ready-to-use 3D mesh with Microsoft TRELLIS.

**Overview**

> This container serves single-image 3D reconstruction over HTTP. Post one image (or up to six turnaround views of the same subject) and it returns a textured GLB, generated with Microsoft TRELLIS on one NVIDIA GPU, through the same serving code that runs the free text-to-3D and image-to-3D lanes on three.ws.
>
> It is the production server, not a demo wrapper: asynchronous job handling with a task API, four quality tiers from draft to max, optional background matting before reconstruction, an SSRF guard on every caller-supplied image URL, and a health endpoint that reports whether the pipeline finished loading so an orchestrator can route around a cold instance.
>
> Model weights are not included. Download `TRELLIS-image-large` from Microsoft's Hugging Face repository and mount it at `/weights/trellis-large`. TRELLIS is MIT licensed; this container is licensed under the three.ws NVIDIA NGC Container EULA and its source is Apache-2.0 at github.com/nirholas/three.ws.

**Tags:** 3D, generative AI, mesh generation, inference server, digital humans, TRELLIS, computer vision

**Labels:** framework PyTorch, task Image to 3D, precision FP16, architecture Ada and newer (final list set by the build in gate 2)

**Links**

- Publisher: https://three.ws
- Live product using this container: https://three.ws/forge
- Source: https://github.com/nirholas/three.ws/tree/main/workers/model-trellis
- EULA: https://three.ws/legal/nvidia-ngc-eula
- Upstream model: https://github.com/microsoft/TRELLIS

**Quick start (goes in the listing body, once gate 1 lands)**

```bash
docker run --gpus all -p 8080:8080 \
  -e API_KEY=choose-a-secret \
  -v /path/to/trellis-image-large:/weights/trellis-large:ro \
  -v /path/to/output:/output \
  nvcr.io/three-ws/trellis-mesh-server:latest

curl -X POST http://localhost:8080/infer \
  -H "Authorization: Bearer choose-a-secret" \
  -H 'Content-Type: application/json' \
  -d '{"images":["https://three.ws/avatars/thumbs/default.png"],"tier":"standard"}'
```

## What is owner-gated

Everything that leaves the machine. Submitting the partner form, signing the
legal agreement, and pushing to the staging repository are all outward-facing
and none of them are an agent's call:

1. Submit **Become an NGC Software Partner** at [nvidia.com/en-us/gpu-cloud/ngc-software-partners](https://www.nvidia.com/en-us/gpu-cloud/ngc-software-partners/). Mention the Inception membership in the form; it is the same company record.
2. Sign the NGC Partner Legal Agreement when it comes back.
3. Approve the Cloud Build run that produces the publishable image (gates 1 and 2).

## Verification log

| Claim | Checked how | Result |
|---|---|---|
| NGC prerequisites and the four-step process | `WebFetch` on the NGC Software Partners page, 2026-09-02 | Quoted verbatim in the audit table above |
| A self-serve intake form exists | Same fetch | "Become an NGC Software Partner" form on that page; no email address published |
| Base images are CUDA 12.x | `grep FROM workers/*/Dockerfile` | Eight GPU workers on `nvidia/cuda` 12.1 to 12.8 |
| The container collects nothing | `grep -rniE "posthog|analytics|telemetry|mixpanel|sentry" workers/model-trellis` | No matches |
| Weights are not baked into the image | [workers/model-trellis/README.md](../workers/model-trellis/README.md) and the Dockerfile | Weights mount at `/weights`; no `COPY` of any checkpoint |
| `GCS_BUCKET` is a hard requirement | [main.py](../workers/model-trellis/main.py) | `os.environ["GCS_BUCKET"]` at import, no fallback |
| Kernels are `sm_89` only | [Dockerfile](../workers/model-trellis/Dockerfile) | `TORCH_CUDA_ARCH_LIST="8.9"`, no PTX |
| Upstream licenses | Worker READMEs | TRELLIS MIT, MDM MIT, Hunyuan3D non-commercial |

## Related

- [NVIDIA visibility map](./nvidia-visibility-map.md): every other NVIDIA surface and its intake route
- [Accelerated Apps Catalog listing kit](./nvidia-apps-catalog-listing.md) and [inclusion request](./nvidia-apps-catalog-request.md)
- [NVIDIA Inception membership](./nvidia-inception.md): what membership is, and the rule that it is not an endorsement
- [NVIDIA models on three.ws](./nvidia-models.md): the source of truth for every NVIDIA technical claim
- [Listings and distribution](./listings.md): the canonical program and directory inventory
