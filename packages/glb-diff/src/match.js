// Pairing entries across two models.
//
// A diff is only as good as its matching. Compare by name alone and every
// exporter that renumbers "Mesh.001" reports the whole file as rewritten;
// compare by content alone and a rename looks like a deletion plus an unrelated
// addition. So this runs the same three-tier strategy git uses for file renames,
// applied to glTF objects:
//
//   1. by key          the names agree, so the objects correspond
//   2. by fingerprint  the names disagree but the content is byte-identical, so
//                      it is a rename
//   3. by similarity   neither agrees, but one candidate is close enough that
//                      calling it "the same object, edited and renamed" is more
//                      honest than reporting an add and a remove
//
// Anything still unpaired after all three really is an addition or a removal.

/** Two counts as a 0..1 closeness ratio. Equal counts score 1, a zero against a nonzero scores 0. */
export function ratio(a, b) {
	const x = Math.abs(Number(a) || 0);
	const y = Math.abs(Number(b) || 0);
	if (x === 0 && y === 0) return 1;
	const hi = Math.max(x, y);
	if (hi === 0) return 1;
	return Math.min(x, y) / hi;
}

/** Overlap of two lists as a 0..1 Jaccard index. Empty against empty scores 1. */
export function jaccard(a, b) {
	const setA = new Set(a || []);
	const setB = new Set(b || []);
	if (setA.size === 0 && setB.size === 0) return 1;
	let shared = 0;
	for (const v of setA) if (setB.has(v)) shared++;
	return shared / (setA.size + setB.size - shared);
}

// Above this many candidate pairs the similarity pass is skipped: it is O(n*m)
// and a 40k-comparison ceiling already covers a 200-object model against another
// 200-object model, which is far past any real avatar. When it trips, the result
// says so rather than quietly downgrading renames into add/remove noise.
const MAX_SIMILARITY_PAIRS = 40_000;

/**
 * @template T
 * @param {T[]} listA
 * @param {T[]} listB
 * @param {{ similarity?: (a: T, b: T) => number, threshold?: number }} [opts]
 * @returns {{ pairs: {a: T, b: T, via: 'key'|'fingerprint'|'similarity', score: number}[], added: T[], removed: T[], similarityLimited: boolean }}
 */
export function matchEntries(listA, listB, opts = {}) {
	const threshold = opts.threshold ?? 0.6;
	const pairs = [];
	const usedA = new Set();
	const usedB = new Set();

	const pairBy = (field, via) => {
		const bucketB = new Map();
		listB.forEach((entry, i) => {
			if (usedB.has(i)) return;
			const value = entry[field];
			if (value === null || value === undefined) return;
			if (!bucketB.has(value)) bucketB.set(value, []);
			bucketB.get(value).push(i);
		});
		listA.forEach((entry, i) => {
			if (usedA.has(i)) return;
			const value = entry[field];
			if (value === null || value === undefined) return;
			const candidates = bucketB.get(value);
			if (!candidates || candidates.length === 0) return;
			// Duplicates on either side are paired in document order, which is the
			// only stable choice when the file itself offers no way to tell two
			// identically named siblings apart.
			const j = candidates.shift();
			usedA.add(i);
			usedB.add(j);
			pairs.push({ a: entry, b: listB[j], via, score: 1 });
		});
	};

	pairBy('key', 'key');
	pairBy('fingerprint', 'fingerprint');

	const restA = listA.map((e, i) => ({ e, i })).filter(({ i }) => !usedA.has(i));
	const restB = listB.map((e, i) => ({ e, i })).filter(({ i }) => !usedB.has(i));

	let similarityLimited = false;
	if (opts.similarity && restA.length && restB.length) {
		if (restA.length * restB.length > MAX_SIMILARITY_PAIRS) {
			similarityLimited = true;
		} else {
			const scored = [];
			for (const a of restA) {
				for (const b of restB) {
					const score = opts.similarity(a.e, b.e);
					if (score >= threshold) scored.push({ a, b, score });
				}
			}
			// Best match first, and each entry may only be claimed once, so a strong
			// pairing is never displaced by a weaker one that happened to come first.
			scored.sort((x, y) => y.score - x.score);
			for (const { a, b, score } of scored) {
				if (usedA.has(a.i) || usedB.has(b.i)) continue;
				usedA.add(a.i);
				usedB.add(b.i);
				pairs.push({ a: a.e, b: b.e, via: 'similarity', score });
			}
		}
	}

	return {
		pairs,
		removed: listA.filter((_, i) => !usedA.has(i)),
		added: listB.filter((_, i) => !usedB.has(i)),
		similarityLimited,
	};
}
