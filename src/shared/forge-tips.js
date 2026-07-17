// Forge: "while it forges" craft tips (pure, shared, testable).
//
// A text→3D generation takes 10-60s. forge.js already shows honest progress; it
// does not fill the wait with anything to learn. These curated cards do: each is
// a concrete prompt-craft tip tuned to the free draft lane (single subject +
// material), so the wait quietly makes a creator's NEXT prompt better. Nothing
// here fakes progress: it is genuine content shown alongside the real timers.
//
// Deliberately dependency-free so both the client and its tests can import it.

export const FORGE_TIPS = [
	{ tip: 'Name one subject. A single object reconstructs far cleaner than a whole scene.', example: 'a sitting red fox' },
	{ tip: 'Add a material. Words like brushed brass or glazed ceramic sharpen the mesh and its texture.', example: 'a brushed brass compass' },
	{ tip: 'Describe the finish. Matte, glossy, polished, or weathered tell the model how light should behave.', example: 'a weathered bronze helmet' },
	{ tip: 'Give it a pose. A stance reads clearer than a bare noun.', example: 'an owl with wings spread' },
	{ tip: 'Add a colour. A named colour resolves cleaner than leaving it open.', example: 'a teal ceramic vase' },
	{ tip: 'Two details is the sweet spot. A material plus a colour or pose usually nails it.', example: 'a glossy red toy car' },
	{ tip: 'Style words carry weight. Low-poly, chibi, steampunk, or art deco set a whole look in one word.', example: 'a low-poly mountain fox' },
	{ tip: 'Skip the background. Extra objects and scenery pull a single-subject model off target.', example: 'a lone stone lighthouse' },
	{ tip: 'Love the result? Tap “More like this” to re-forge it in new materials in one click.', example: null },
];

// A rotation order over the tips. When a seeded rng is supplied the order is
// deterministic (for tests); otherwise it is shuffled so repeat visitors do not
// always see the same first card. Fisher-Yates.
export function tipOrder(rng = Math.random) {
	const idx = FORGE_TIPS.map((_, i) => i);
	for (let i = idx.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[idx[i], idx[j]] = [idx[j], idx[i]];
	}
	return idx;
}
