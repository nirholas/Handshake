# 21. Matter direct control: past the house

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. This is the **horizon**
order: run it only after [20](home-20-launch-readiness.md) has returned a go and the lane is in
steady operation. Running it earlier trades a shipped product for a research project.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**This order is allowed to conclude "not yet".** It is the only one in the campaign that is. If
the measured evidence says the value is not there, say so with the evidence and stop; a proven
negative is a completed order here. What is not allowed is a half-built controller left on disk.

---

## Step 0: re-derive the current state

```bash
npm view @matter/main version
node -e "console.log(require('./package.json').dependencies['@matter/main'] || 'not installed')"
grep -rn "matter" docs/smart-home.md | head
curl -s https://api.github.com/repos/matter-js/matter.js | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.stargazers_count,r.license.spdx_id,r.pushed_at)})"
```

The campaign's landscape data was measured on 2026-09-02: matter.js at 894 stars, Apache-2.0,
actively pushed, and Home Assistant migrating its own Matter integration onto it. **Re-measure.**
That is the whole point of Step 0 and this order is the one most likely to have moved.

## The two capabilities, and they are different

### A. three.ws as a Matter controller (no hub)

A user with Matter devices and no Home Assistant could connect them directly: commissioning over
BLE or Thread, then control. It removes the Home Assistant prerequisite.

**Be honest about the cost.** Commissioning needs BLE or Thread radio access on the same network
as the device, which a browser tab and a Cloud Run container both lack. It therefore requires
local software on the user's network, which is exactly what order 10 already ships, and which the
user could equally point at a Home Assistant that already does all of this and more.

The question to answer with evidence, not opinion: **is there a real user who has Matter devices,
wants an agent, and will not install Home Assistant?** Size it before building it.

### B. three.ws as a Matter device (the interesting half)

The inverse, and the one with no substitute: a three.ws agent **presents itself** as a Matter
device on the user's network. Then any Matter controller (Home Assistant, and the major consumer
ecosystems) can see the agent as a first-class thing in the house, put it in a room, and include
it in an automation.

That makes the agent addressable by infrastructure the user already owns, rather than requiring
them to come to us. [`Luligu/matterbridge`](https://github.com/Luligu/matterbridge) (Apache-2.0)
is the best worked example of matter.js used in this direction; read it before designing anything.

**B is the better bet.** A is a substitute for something the user already has; B is something
nobody offers. Weight the evaluation accordingly, and if you disagree after reading the evidence,
say why in your report.

## The kernel to prove first (one session, before any product work)

Do not design a product until this is proven, and let the result decide the rest of the order:

1. Stand up a matter.js device node in a container on a real network.
2. Commission it into a real Home Assistant Matter integration.
3. Expose one endpoint that means something for an agent: an occupancy or presence signal, or a
   switch that triggers an agent action.
4. Prove the round trip in both directions: Home Assistant sees the agent's state change, and an
   automation in Home Assistant reaches the agent.
5. Measure: commissioning time, steady-state resource cost, and what happens across a restart of
   each side.

If step 2 or step 4 cannot be made to work in a session against real software, that is the
finding. Write it down with the exact failure and stop.

## If the kernel holds

Then, and only then:

| # | Task |
|---|---|
| 1 | `services/home-matter/` with its `README.md` (required by CLAUDE.md), the device node, and its container. |
| 2 | The endpoint model: exactly which Matter device types the agent presents, and why each one. Fewer is better. |
| 3 | Pairing and identity: which three.ws agent this node is, bound the way orders 09 and 10 bind theirs. |
| 4 | Persistence of the Matter fabric across restarts. A device that needs re-commissioning after every deploy is not shippable. |
| 5 | The safety rule, unchanged: a Matter command reaching the agent is a request, and anything guarded still mints a confirmation. **A Matter fabric is not a human saying yes.** |
| 6 | `STRUCTURE.md`, `docs/`, `data/changelog.json`. |
| 7 | Tests against a real controller. |

## Definition of done

Either the negative or the positive, completely.

**If concluding "not yet":**
- [ ] The kernel was attempted against real software, and the exact failure or the exact cost is documented with transcripts.
- [ ] `docs/smart-home.md` phase 4 is rewritten to say what was tried, what was measured, and what would have to change for this to be worth doing.
- [ ] Nothing half-built remains on disk. `git status` clean of experiments.
- [ ] The re-measured landscape numbers are recorded, so the next attempt starts from data and not from this file.

**If building it:**
- [ ] A real Home Assistant commissioned the three.ws Matter node. Screenshot from Home Assistant.
- [ ] Both directions of the round trip demonstrated, recorded.
- [ ] The node survives a restart of each side without re-commissioning. Prove both.
- [ ] Commissioning time and steady-state resource cost measured.
- [ ] A guarded action triggered through a Matter automation still requires a human confirmation and does not execute without one. This is the line that matters most in this order.
- [ ] `services/home-matter/README.md` exists; `npm run audit:docs` clean.
- [ ] `npx vitest run --root .` shows no new failures.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Commissioning needs BLE or Thread hardware | For capability B over IP on the local network, it usually does not. If it does for your path, say so with the exact requirement; that is a finding about the cost, not a blocker to route around. |
| matter.js has moved or renamed since 2026-09-02 | Re-measure in Step 0 and trust what you find. The campaign's numbers are a snapshot with a date on them. |
| The value case looks weak | Then write the negative with the evidence. That is a completed order. Do not build it to avoid writing "not yet". |
| Someone proposes replacing the Home Assistant path with Matter | Refuse. Home Assistant covers 1,500 integrations; Matter covers a subset of new devices. Matter is an addition, never a replacement, and the context file's "we write no device code" rule still holds for everything else. |
| A Matter automation should be allowed to skip the confirmation "because the user set it up" | Refuse. The user set up an automation, not this specific unlock at this moment. The gate is unchanged. |

## Report format

1. The re-measured landscape numbers, with dates.
2. The kernel attempt: what worked, what did not, with transcripts.
3. The recommendation, A or B or neither, with the evidence behind it.
4. If built: the commissioning screenshot, the round-trip recording, the restart proofs, the measured costs, and the guarded-action proof.
5. If not built: the rewritten `docs/smart-home.md` phase 4 and confirmation that nothing was left half-built.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-21-matter-direct.md

A documented "not yet" retires this file the same as a shipped feature does, provided the
evidence and the rewritten phase 4 are committed. Never delete it on a partial.
