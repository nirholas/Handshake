# Build a 3D asset pipeline

Generating one 3D model is a party trick. Shipping a hundred of them, on a
schedule, without a bad one reaching a user, is a pipeline. This tutorial builds
that pipeline in four stages, each one a working command by the end of its
section.

You will finish with a folder you can regenerate at any time, a manifest that
records exactly what was built, and a CI check that refuses to let a broken model
through.

**Prerequisites:** Python 3.10 or newer. That is the whole list. The
[3D API](/docs/3d-api) is free and keyless, so there is no account to make and no
key to store.

Every stage uses a file from the [Cookbook](/cookbook). Download them into one
working directory as you go.

**Want to see it before you build it?** The
[Pipeline Studio](/cookbook/pipeline) runs all four stages in a browser tab, on
the same free API, with no install at all. It is the fastest way to understand
what you are about to write, and it hands you the exact commands below when it
finishes.

![The Pipeline Studio after a real three-model run: prompts and a budget on the left, every model rendered and graded on the right](figure:img:/cookbook/media/pipeline-studio-run.png)

---

## Stage 1: one model, from the command line

Grab [`text_to_3d.py`](/cookbook/recipes/text_to_3d.py) and run it:

```bash
python3 text_to_3d.py "a wooden treasure chest with iron bands"
```

```
prompt: a wooden treasure chest with iron bands
  glb:    https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/.../176ed971.glb
  viewer: https://three.ws/viewer?src=...
  ar:     https://three.ws/api/ar?src=...  (open on a phone to place it in your room)
saved 1651 KB to a-wooden-treasure-chest-with-iron-bands.glb
```

Open the viewer URL to look at it, or the AR URL on a phone to stand it on your
desk. This is the model that command produced:

![The treasure chest built by this exact command, rendered through the platform renderer](figure:img:/cookbook/posters/text-to-3d-cli.png)

**What to learn here:** the API answers in two shapes, not one. It returns the
finished model inline when the draft is quick, and a job handle when the shared
GPU lane is busy. Any client you write has to handle both, and has to respect the
`retryAfter` hint that comes back with a queued job. The
[recipe page](/cookbook/text-to-3d-cli) walks through exactly why, and what
happens when you ignore it.

**If the command prints `rate_limited` instead:** every free rung was saturated at
that moment, which is a busy signal rather than your quota, and it can land on the
very first call of the day. The response carries `retry_after` in seconds. Wait
that long and run the command again; at peak it can take several tries. That is
also why the batching stage below caps its workers instead of fanning out wide.

**Prompting for this tier.** The free lane is single-subject. "a brass watering
can" produces a watering can. "a kitchen with a table, three chairs and a window"
produces a blob. Describe one object, with material and shape, and stop there.

---

## Stage 2: a whole pack, in parallel

One at a time does not scale. Add
[`asset_pack.py`](/cookbook/recipes/asset_pack.py) to the same folder (it imports
`text_to_3d.py`, so they must sit together) and write your prompt list:

```text
# props.txt
a clay flower pot with a saucer
a woven wicker basket
a brass watering can
```

```bash
python3 asset_pack.py --prompts-file props.txt --out ./garden-pack
```

```
building 3 models with 3 workers into garden-pack/
  [ok  ] a clay flower pot with a saucer                         82s
  [ok  ] a woven wicker basket                                   85s
  [ok  ] a brass watering can                                   101s

3/3 built in 101s
open garden-pack/index.html
```

101 seconds instead of 268. Open `garden-pack/index.html` and you have an
interactive gallery you can send to someone.

![One of the three garden props, generated in the same parallel run](figure:img:/cookbook/posters/parallel-asset-pack.png)

**What to learn here:** concurrency is deliberately low, at three. The free lane
is a shared GPU pool, so twenty simultaneous jobs do not finish faster, they
queue behind each other and burn poll requests. Details, plus the failure-handling
rules, live on the [recipe page](/cookbook/parallel-asset-pack).

The file that matters most is `garden-pack/manifest.json`. It records every
prompt, its URL, its local path, its duration, and its error if it failed. That
file is what makes the next two stages possible.

---

## Stage 3: refuse to ship a bad model

Here is the failure this stage exists for: a model downloads fine, validates
against the glTF spec perfectly, and is a 147,617-triangle monster that will drop
a phone to single-digit frame rates. Nothing so far has complained, because
nothing so far was asked to.

Add [`asset_gate.py`](/cookbook/recipes/asset_gate.py) and point it at the pack:

```bash
python3 asset_gate.py garden-pack/models/*.glb --max-triangles 100000
```

```
PASS  a-brass-watering-can.glb                       46,348 tris     0.6 MB   0 mat   0 tex
      note: no materials: likely vertex-colored geometry ...
PASS  a-clay-flower-pot-with-a-saucer.glb            76,555 tris     1.0 MB   0 mat   0 tex
FAIL  a-woven-wicker-basket.glb                     147,617 tris     2.8 MB   0 mat   0 tex
      fail: 147,617 triangles exceeds the budget of 100,000
```

Exit code 1. In CI, that fails the build. The basket is the one that busted the
budget, and it does not look like a problem, which is the entire point of gating
on numbers rather than on a glance:

![The wicker basket that failed the gate at 147,617 triangles](figure:img:/cookbook/posters/asset-quality-gate.png)

**What to learn here:** the difference between a failure and an advisory. The
basket busting the triangle budget is a failure, because it will visibly hurt a
user. Zero materials is an advisory, because the free lane routinely produces
vertex-colored geometry that renders in full color without a material at all. A
gate that treats the second case as a failure cries wolf and gets switched off
within a week. The [recipe page](/cookbook/asset-quality-gate) tells the story of
that exact bug, because this gate had it.

Wire it into CI:

```yaml
- name: Gate 3D assets
  run: python3 asset_gate.py assets/**/*.glb --max-triangles 80000 --max-size-mb 5
```

---

## Stage 4: put the pipeline in the hands of an agent

The three stages above are yours to run. The last one hands them to an assistant.

[`mcp_3d_server.mjs`](/cookbook/recipes/mcp_3d_server.mjs) is a Model Context
Protocol server exposing two tools: generate a model, and render one to an image.

```bash
npm install @modelcontextprotocol/sdk zod
claude mcp add three-ws-3d -- node /absolute/path/to/mcp_3d_server.mjs
```

Now your assistant can build a model when you ask for one, and, because the
render tool returns the PNG inline as image content, it can actually look at the
result before showing it to you.

**What to learn here:** a tool's description is its real interface. The model
never reads your code, so "takes roughly 60 to 120 seconds" in the description is
what stops a client from firing a duplicate call because it assumed the first
had hung. The [recipe page](/cookbook/mcp-3d-tool) covers annotations and the
smoke test that saves you from debugging a dead server from inside a chat client.

---

## Closing the loop: let the model judge its own output

Stage 3 gates on numbers: triangles, bytes, materials. Numbers cannot tell you
that you asked for a cactus and got a shrub.

The [self-correcting 3D collectible set](/cookbook/self-correcting-3d) recipe
closes that gap. An art director model designs a themed set, issues parallel
function calls to generate every prop, renders each one, inspects the render with
vision, grades it against the original brief into a strict structured-output
schema, and rebuilds anything that missed, once, from the critic's own revised
prompt.

That is the same pipeline you just built, with a vision model where your
judgement used to be. It needs an OpenAI API key, and it is the natural next
step once the mechanical stages are running.

---

## What you built

| Stage | File | What it guarantees |
|---|---|---|
| 1 | `text_to_3d.py` | One prompt reliably becomes one downloaded model |
| 2 | `asset_pack.py` | Many prompts finish in parallel, with a manifest recording each |
| 3 | `asset_gate.py` | No model over budget reaches a user |
| 4 | `mcp_3d_server.mjs` | Your assistant can run stages 1 and 2 on request |

## Where to go next

- **Every recipe, with the reasoning** → [Cookbook](/cookbook)
- **The endpoints underneath** → [3D API reference](/docs/3d-api)
- **Higher quality and rigged output** → the paid tiers linked in every API response
- **Put a model on your page** → [Share and embed](/docs/share-and-embed)
