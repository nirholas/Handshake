# Your first contribution

Clone to open pull request in about 15 minutes. No prior knowledge of the codebase assumed.

If you get stuck at any step, ask in [Discussions](https://github.com/nirholas/three.ws/discussions) or the [Telegram community](https://t.me/three_ws_community). A stuck contributor is a bug in this document and we want to hear about it.

---

## 1. Get it running (5 minutes)

```bash
git clone https://github.com/nirholas/three.ws.git
cd three.ws
npm install
npm run setup
npm run dev
```

Open http://localhost:3000. You should see a 3D avatar you can orbit with the mouse.

`npm run setup` is not optional and not the same as `npm install`. It builds the local `solana-agent-sdk` (linked as a `file:` dependency with no prebuilt `dist/`) and generates the gitignored `data/_generated/*` artifacts that the app, the sitemap, and the test suite read. It is idempotent, so re-running it is always safe.

You do **not** need any API keys, a wallet, or a database to work on the rendering, rigging, animation, or docs layers. Those layers are pure client-side JavaScript and their tests run offline.

## 2. Find something to work on

Browse [`good first issue`](https://github.com/nirholas/three.ws/labels/good%20first%20issue). Every one of them names the file to change and the command that proves the change worked.

**Comment on the issue before you start.** One line ("taking this") is enough. It stops two people doing the same work, and it means a maintainer can hand you context before you have written code rather than after.

## 3. A worked example: teach the retargeter a new rig

This is the highest-value first contribution in the project, so here is the whole thing end to end.

### The problem

three.ws ships one library of pre-baked animation clips and plays them on *any* humanoid avatar a user uploads. That only works because every rig gets rewritten to one canonical skeleton first. The trouble is that no two tools name bones the same way. Mixamo says `LeftArm`, Unreal says `upperarm_l`, VRoid says `J_Bip_L_UpperArm`, Daz says `lShldr`.

[`src/glb-canonicalize.js`](../src/glb-canonicalize.js) is the map that reconciles them. Every convention it knows about is a rig that animates; every convention it does not know about falls back to a default body. Adding a convention is a self-contained, high-leverage change with a fast test loop.

### Check what is missing

```js
// scratch.mjs
import { canonicalizeBoneName } from './src/glb-canonicalize.js';
console.log(canonicalizeBoneName('左腕'));   // null  → not supported yet
console.log(canonicalizeBoneName('upperarm_l')); // 'LeftArm' → already supported
```

```bash
node scratch.mjs
```

`null` means the bone would be dropped and the rig would score below the retarget coverage floor.

### Make the change

Bone-name variants live in the `EXTRA_ALIASES` map in [`src/glb-canonicalize.js`](../src/glb-canonicalize.js). Entries are keyed by a separator-stripped, lowercased form, and the `put()` helper does that normalization for you. First spelling wins, so listing order is priority order.

A MikuMikuDance rig, for example, names bones in Japanese with a 左 / 右 side prefix:

```js
// MikuMikuDance (MMD) skeletons name bones in Japanese, side-prefixed
// with 左 (left) / 右 (right). Extremely common in the VRM/anime avatar
// ecosystem, and none of these spellings share a stem with any Latin rig.
for (const [v, c] of [
	['センター', 'Hips'], ['上半身', 'Spine'], ['上半身2', 'Spine1'],
	['首', 'Neck'], ['頭', 'Head'],
]) put(v, c);
for (const [side, prefix] of [['左', 'Left'], ['右', 'Right']]) {
	put(`${side}肩`,   `${prefix}Shoulder`);
	put(`${side}腕`,   `${prefix}Arm`);
	put(`${side}ひじ`, `${prefix}ForeArm`);
	put(`${side}手首`, `${prefix}Hand`);
	put(`${side}足`,   `${prefix}UpLeg`);
	put(`${side}ひざ`, `${prefix}Leg`);
	put(`${side}足首`, `${prefix}Foot`);
	put(`${side}つま先`, `${prefix}ToeBase`);
}
```

### Prove it

Add a case to [`tests/glb-canonicalize.test.js`](../tests/glb-canonicalize.test.js) beside the existing per-convention blocks:

```js
it('maps an MMD (Japanese) skeleton', () => {
	expect(canonicalizeBoneName('センター')).toBe('Hips');
	expect(canonicalizeBoneName('左腕')).toBe('LeftArm');
	expect(canonicalizeBoneName('右ひざ')).toBe('RightLeg');
});

it('never crosses sides', () => {
	expect(canonicalizeBoneName('左足首')).toBe('LeftFoot');
	expect(canonicalizeBoneName('右足首')).toBe('RightFoot');
});
```

Run just that file. It takes about a second:

```bash
npx vitest run tests/glb-canonicalize.test.js
```

Then run the whole suite before you open the PR:

```bash
npm test
```

Two rules that will save you a review round:

- **Never cross sides.** A mapping that sends a left bone to a right canonical name tears the avatar apart in motion, and it is the single most common mistake in this file. Test both sides, always.
- **Do not map bones that are not skeleton joints.** Constraint-driven control rigs, tracker nodes, and metacarpal scaffolding are deliberately left unmapped. The header comment in `glb-canonicalize.js` explains why in detail. Read it before you widen a match.

## 4. Open the pull request

```bash
git checkout -b feat/mmd-bone-names
npx prettier --write src/glb-canonicalize.js tests/glb-canonicalize.test.js
git add src/glb-canonicalize.js tests/glb-canonicalize.test.js
git commit -m "feat(rig): map MikuMikuDance Japanese bone names to the canonical skeleton"
git push origin feat/mmd-bone-names
```

Then open the PR on GitHub. In the description say what changed, what you tested it against, and paste the test output. If you have a real GLB that exercises the change, link it.

**Commit message format:** `type(scope): what changed and why a reader would care`. Plain language, specific to your diff. `wip`, `update`, and `changes` are rejected.

## 5. What happens next

See [Triage](triage.md) for the full flow and response targets. In short: a maintainer reads it, you get real review comments, and merged work shows up in the [public changelog](https://three.ws/changelog).

---

## Other good places to start

- **Animation.** Add a clip to the shared library, or improve the retarget quality in [`src/animation-retarget.js`](../src/animation-retarget.js).
- **Docs.** Run `npm run audit:docs`. Anything it reports is a real, mechanically verified defect and a legitimate PR.
- **MCP tools.** Every package under `packages/*-mcp` follows the same shape. Copy the closest one and you have a working new tool.
- **Whatever annoyed you.** If something in the product felt wrong the first time you used it, that reaction is worth more than any list we could write. Open an issue describing it.
