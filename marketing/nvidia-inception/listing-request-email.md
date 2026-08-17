# NVIDIA listing request: the email

Ready to send. Every number and link in the body below was verified against
production and against NVIDIA's live pages on 2026-08-17 (see
[README.md](README.md) for the verification log).

- **To:** `inceptionprogram@nvidia.com`
- **From:** `nich@three.ws` (Nicholas Resendez, Founder)
- **Cc:** `partnerships@three.ws`
- **Subject:** `Inception member three.ws: request to be listed in the Startup Showcase`

Send it as plain text or lightly formatted HTML. Do not attach anything: every
claim in the email is a link NVIDIA can open itself, which is the point.

---

## The body

Hi NVIDIA Inception team,

I am Nicholas Resendez, founder of three.ws, an Inception member since July 2026.
I would like to get three.ws listed in the Inception Startup Showcase, and I want
to check what you need from us to make that happen.

**What three.ws is.** A browser-native platform for 3D AI agents. You type a
prompt, we generate a textured, rigged 3D avatar, you give it an LLM brain and a
voice, and you embed it anywhere with one HTML tag. No plugins, no installs, no
server uploads. The generation tier is free and needs no account, so anyone
evaluating it can go from a text prompt to a downloadable GLB in under a minute
at https://three.ws/forge.

**Why we think it is a fit for the Showcase.** three.ws is not a product that
mentions NVIDIA in a slide. Every compute-bound path in it runs on NVIDIA:

- **A self-hosted GPU fleet on Cloud Run:** 12 GPU service deployments across
  us-central1 and us-east4, 11 on NVIDIA L4 and one on RTX PRO 6000 Blackwell.
  They cover text-to-3D and image-to-3D (TRELLIS, TripoSR, TripoSG,
  Hunyuan3D 2.1), auto-rigging, and text-to-motion.
- **The NVIDIA-hosted model layer**, all behind a single build.nvidia.com key:
  TRELLIS for text-to-3D, FLUX.1-schnell, the Llama and Nemotron chat lineup,
  Nemotron vision, nv-embedqa-e5-v5, the reranker, and NemoGuard. The model by
  model map is public at https://three.ws/docs/nvidia-models.
- **The ACE digital-human stack in production, not in a prototype:** Magpie for
  text-to-speech, Riva for speech recognition, and Audio2Face-3D driving ARKit 52
  blendshapes on live avatars in the browser. Cosmos powers our text-to-world
  video lane.

We also write up what we learn on your forums rather than only on our own blog:

- How Nemotron made our text-to-3D pipeline usable:
  https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445
- How we translate a web app into 100 languages with NVIDIA NIM:
  https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379
- The engineering detail on the fleet itself, including memory ceilings, sm_120
  kernels, and regional GPU quota:
  https://three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell

**What I am asking for.** Three things, in the order that matters to us:

1. **A Showcase listing for three.ws.** If that is curated from our Inception
   portal profile, tell me which fields you read and I will have the profile
   complete the same day. If it needs a separate submission, point me at the form
   or tell me what to send and in what format: description, category, industry,
   logo, screenshots, a demo link, whatever the template wants.
2. **Consideration for the ACE and digital-human ecosystem pages.** We are
   already shipping Audio2Face-3D, Riva, and Magpie to real users in a browser,
   which seems like the exact story those pages exist to tell. If there is a
   different intake for that, I am happy to be redirected.
3. **The right contact for developer-ecosystem or co-marketing work**, if that
   sits with someone other than you. We have the material and we would rather
   route it correctly than send it to the wrong inbox twice.

Everything we run on NVIDIA is collected at https://three.ws/nvidia, and our
membership page is at https://three.ws/docs/nvidia-inception. The platform is
source-available at https://github.com/nirholas/three.ws.

Happy to do a live walkthrough, or to send anything else you need in whatever
format the Showcase template expects.

Thanks,

Nicholas Resendez
Founder, three.ws
nich@three.ws
https://three.ws

---

## If you get no reply in 10 business days

Send this as a reply on the same thread rather than as a new email, so the
history stays in one place.

Hi again,

Following up on the Showcase listing request below. If the Startup Showcase is
curated rather than open to requests, that is a completely fine answer and I will
stop asking: I would just like to know so I can put the effort into the portal
profile or into the ACE ecosystem route instead.

One line if it is easier than a paragraph: is a Showcase listing something we can
request, and if so, what do you need from us?

Thanks,
Nicholas

---

## Notes for whoever sends this

- **Do not claim a partnership.** Inception is a startup program. The words to
  use are "Inception member" and "member since July 2026". Never "NVIDIA
  partner", never "backed by NVIDIA", never anything implying endorsement or
  investment. This is the same rule the badge already follows in the site footer,
  and getting it wrong in an email to NVIDIA itself is the worst place to get it
  wrong.
- **Keep the token out of it.** Nothing in this thread should mention the coin.
  The ask is a GPU and digital-human product listing, and every sentence should
  earn its place against that ask.
- **The numbers are load-bearing.** If the GPU fleet changes shape before this
  goes out, recount it with the command in [README.md](README.md) and edit the
  body. Sending NVIDIA a stale GPU count is a self-inflicted credibility problem.
