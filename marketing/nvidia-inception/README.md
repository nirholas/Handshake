# marketing/nvidia-inception/

Outreach pack for getting three.ws listed on NVIDIA's surfaces as an Inception
member. The membership itself is already done (accepted July 2026, documented at
[docs/nvidia-inception.md](../../docs/nvidia-inception.md) and rendered at
`/docs/nvidia-inception`). This directory is about the next step: a **product
listing**, which is a separate thing NVIDIA does not grant automatically.

| File | What it is |
| --- | --- |
| [listing-request-email.md](listing-request-email.md) | The ready-to-send email to `inceptionprogram@nvidia.com`, plus a follow-up for the no-reply case and the rules for whoever sends it. |

---

## Where a listing can actually happen

Researched 2026-08-17 against NVIDIA's live pages. There is no public
self-serve "list my product" form on any of these, which is why the route is an
email.

| Surface | What it lists | How you get on it | Fit for three.ws |
| --- | --- | --- | --- |
| **Inception Startup Showcase** (`nvidia.com/en-us/startups/showcase/`) | Member companies and their products, plus feature slots in NVIDIA newsletters, campaigns, and case studies | No public form. The page's only stated contact is `inceptionprogram@nvidia.com` (`inception_cn@nvidia.com` for China). Selection reads the member profile in the Inception portal, so that profile is the real prerequisite. | **Primary target.** This is the listing the email asks for. |
| **Inception portal** (`programs.nvidia.com/phoenix/`) | Our own company and product record inside NVIDIA | Log in and complete it. NVIDIA states members must keep product and company details current to stay eligible for benefits. | **Do this regardless of any reply.** It gates the Showcase and costs nothing but an hour. |
| **ACE / digital-human ecosystem pages** | Companies shipping Audio2Face, Riva, and related ACE microservices | No public form found. Ask for the redirect in the same email. | **Strong.** Magpie, Riva, and Audio2Face-3D are all in production, not prototyped. |
| **build.nvidia.com / NGC catalog** | Models, NIM microservices, and containers | Publish an artifact NVIDIA hosts | **Weak today.** We consume NIM, we do not publish a model or container to it. Not worth asking for yet. |
| **Omniverse Exchange** | Omniverse extensions and OpenUSD connectors | Ship an extension, then submit it | **Not yet.** OpenUSD interop is an aspiration in our own membership doc, not shipped code. Do not claim it. |

The honest read: the Showcase is the one real target right now, the portal
profile is the prerequisite nobody has completed, and ACE is the strongest
technical story we have to lead with.

## Facts in the email, and how each was verified

Everything below was checked on 2026-08-17 before the email was written. Recheck
anything that looks stale before sending.

| Claim | Verified how | Result |
| --- | --- | --- |
| 12 GPU deployments, 11 × L4 + 1 × RTX PRO 6000 | `gcloud run services list --project aerial-vehicle-466722-p5 --format="csv[no-heading](metadata.name,region,spec.template.spec.nodeSelector)"`, filtered to rows carrying an `accelerator` node selector | Confirmed. 12 across `us-central1` and `us-east4`. Counting only `us-central1` gives 8, which is the trap: the fleet spans two regions. |
| The NVIDIA-hosted model lanes | [docs/nvidia-models.md](../../docs/nvidia-models.md), one lane per section | Confirmed: TRELLIS, FLUX.1-schnell, Llama/Nemotron chat, Nemotron vision, nv-embedqa-e5-v5, reranker, NemoGuard, Magpie |
| ACE stack in production | [ARCHITECTURE.md](../../ARCHITECTURE.md) endpoint table: `/api/tts/speak` (Magpie), `/api/asr` (Riva), `/api/a2f` (Audio2Face-3D, ARKit 52 blendshapes), `/api/cosmos` | Confirmed |
| Both forum write-ups are live | `curl -o /dev/null -w '%{http_code}'` on each URL | Both 200 |
| Every three.ws link in the email resolves | Same, against `/nvidia`, `/docs/nvidia-inception`, `/docs/nvidia-models`, `/blog/image-to-3d-on-nvidia-l4-and-blackwell`, `/forge` | All 200 |
| Membership timing | [docs/nvidia-inception.md](../../docs/nvidia-inception.md) and the `2026-07-30` changelog entry, "A home for everything three.ws runs on NVIDIA" | July 2026, stated in the email as "since July 2026" rather than a precise day |

Recount the fleet with:

```bash
gcloud run services list --project aerial-vehicle-466722-p5 \
  --format="csv[no-heading](metadata.name,region,spec.template.spec.nodeSelector)" \
  | grep -i accelerator
```

## Status

- [x] Listing routes researched and mapped
- [x] Every claim in the email verified against production
- [x] Email drafted, with a follow-up for the no-reply case
- [ ] **Sent.** Owner-gated: outreach to an external party needs the owner to send it, per the approval rules in [CLAUDE.md](../../CLAUDE.md).
- [ ] Inception portal profile completed at `programs.nvidia.com/phoenix/`. Worth doing before the email goes out, since the Showcase is curated from it.

## Related

- [docs/nvidia-inception.md](../../docs/nvidia-inception.md): the membership itself, and the rule that it is a program and not a partnership
- [docs/nvidia-models.md](../../docs/nvidia-models.md): the free hosted inference layer, model by model
- [marketing/openai-select-partner/](../openai-select-partner/README.md): the same shape of pack for OpenAI, and the precedent this one follows
