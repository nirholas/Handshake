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

`npm run setup` is not optional and not the same as `npm install`. It builds the local `solana-agent-sdk` (linked as a `file:` dependency with no prebuilt `dist/`), generates the gitignored `data/_generated/*` artifacts that the app, the sitemap, and the test suite read, and installs the repo's pre-push hook into `.git/hooks` (the same one `npm install` sets up through `scripts/setup-git-hooks.mjs`). That hook lints the commits you push against the rules in section 4, so a rejected push is the hook doing its job, not a broken setup. It is idempotent, so re-running it is always safe.

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

No scratch files in the repo root: probe the function straight from the shell.

```bash
node --input-type=module -e "
import { canonicalizeBoneName as c } from './src/glb-canonicalize.js';
for (const n of ['left_arm_joint', 'hips_joint', '左腕', 'upperarm_l']) console.log(n, '->', c(n));
"
```

```
left_arm_joint -> null        Apple / ARKit rigs: not supported yet (issue #110)
hips_joint -> null
左腕 -> LeftArm               MikuMikuDance: supported, added 2026-08-21
upperarm_l -> LeftArm         Unreal mannequin: supported
```

`null` means the bone would be dropped, and a rig with enough of those scores below the retarget coverage floor and falls back to a default body.

### The reference: how MikuMikuDance was added

MMD support is the most recent convention to land, and it is the shape every new one should take. This is the code that actually shipped in [`src/glb-canonicalize.js`](../src/glb-canonicalize.js), inside the `EXTRA_ALIASES` block. Entries are keyed by a separator-stripped, lowercased form, and the `put()` helper does that normalization for you. First spelling wins, so listing order is priority order.

```js
// MikuMikuDance (PMX/PMD) skeletons name every bone in Japanese, with the
// side carried by a leading 左 (left) / 右 (right) character. No spelling
// here shares a stem with any Latin convention, so the whole rig previously
// mapped zero joints and animated nothing. Sides are listed explicitly
// rather than derived, because the SIDED table below swaps Latin side
// tokens (left→right, l→r, L→R) and cannot reach a Japanese prefix.
//
// Deliberately NOT mapped: the IK targets (左足ＩＫ, 左つま先ＩＫ) and the
// twist bones (左腕捩, 左手捩). Neither is a chain joint. MMD drives the leg
// chain from the IK target, so binding a clip to it would fight the chain
// it is supposed to solve, and the twist bones are secondary deformers that
// tear the mesh when rotated as if they were the limb.
for (const [v, c] of [
	['センター', 'Hips'], ['下半身', 'Hips'],
	['上半身', 'Spine'], ['上半身2', 'Spine1'],
	['首', 'Neck'], ['頭', 'Head'],
]) put(v, c);
for (const [jp, side] of [['左', 'Left'], ['右', 'Right']]) {
	for (const [v, c] of [
		['肩', 'Shoulder'], ['腕', 'Arm'], ['ひじ', 'ForeArm'], ['手首', 'Hand'],
		['足', 'UpLeg'], ['ひざ', 'Leg'], ['足首', 'Foot'], ['つま先', 'ToeBase'],
	]) put(`${jp}${v}`, `${side}${c}`);
	// MMD finger chains. 親指 (thumb) is numbered 0-2, every other digit 1-3.
	for (const [jp2, cf] of [['人指', 'Index'], ['人差指', 'Index'], ['中指', 'Middle'], ['薬指', 'Ring'], ['小指', 'Pinky']]) {
		for (let n = 1; n <= 3; n++) put(`${jp}${jp2}${n}`, `${side}Hand${cf}${n}`);
	}
	for (let n = 0; n <= 2; n++) put(`${jp}親指${n}`, `${side}HandThumb${n + 1}`);
}
```

Three things to copy from it, beyond the mapping itself:

- **The comment says what was left out and why.** The IK and twist bones are the interesting decision here, and the next reader needs the reasoning, not just the table.
- **Fingers are not optional.** 30 of the 53 tracks in every clip address a finger joint, so a rig whose hands do not map scores around 40% coverage and gets no animation at all.
- **Rig Doctor learned the name too.** A matching fingerprint went into `CONVENTIONS` in [`src/rig-report.js`](../src/rig-report.js), so an MMD upload is identified on sight instead of reported as unrecognised, and a row went into the table in [`docs/rig-doctor.md`](rig-doctor.md).

The tests that shipped with it, in [`tests/glb-canonicalize.test.js`](../tests/glb-canonicalize.test.js), use the file's `describe` + `it.each` table style. Match it:

```js
describe('MMD (MikuMikuDance) Japanese skeleton', () => {
	it.each([
		['センター', 'Hips'],
		['上半身', 'Spine'],
		['首', 'Neck'],
	])('centre chain: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it.each([
		['左腕', 'LeftArm'],
		['右ひざ', 'RightLeg'],
	])('limbs: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it('leaves IK targets, twist bones, and non-joint control bones unmapped', () => {
		for (const name of ['左足ＩＫ', '左腕捩', '全ての親']) {
			expect(canonicalizeBoneName(name), name).toBeNull();
		}
	});

	it('never crosses sides', () => {
		const left = ['左肩', '左腕', '左ひじ', '左手首', '左足', '左ひざ', '左足首'];
		for (const name of left) expect(canonicalizeBoneName(name)?.startsWith('Left'), name).toBe(true);
		for (const name of left.map((n) => n.replace(/^左/, '右'))) expect(canonicalizeBoneName(name)?.startsWith('Right'), name).toBe(true);
	});
});
```

### Now do one that is actually open

MMD is done, so do not re-submit it. Pick a convention that still returns `null` and give it the same four-part treatment (alias map, tests, Rig Doctor fingerprint, docs row). Two are verified open and waiting, each with the file, the bones, and the verification command spelled out:

- [#110](https://github.com/nirholas/three.ws/issues/110): Apple / ARKit rigs, which suffix every joint with `_joint` (`hips_joint`, `left_arm_joint`). 0 of 10 joints map today.
- [#111](https://github.com/nirholas/three.ws/issues/111): Kinect rigs, which put the side word last (`ShoulderLeft`, `ElbowLeft`, `SpineBase`). 0 of 10 map today.

Comment on the one you are taking, then:

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
git checkout -b feat/arkit-bone-names
npx prettier --write src/glb-canonicalize.js src/rig-report.js tests/glb-canonicalize.test.js tests/rig-report.test.js docs/rig-doctor.md
git add src/glb-canonicalize.js src/rig-report.js tests/glb-canonicalize.test.js tests/rig-report.test.js docs/rig-doctor.md
git commit -m "feat(rig): map Apple ARKit _joint-suffixed bone names to the canonical skeleton"
git push origin feat/arkit-bone-names
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
