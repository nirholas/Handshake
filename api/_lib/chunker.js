// Recursive 512-token chunks with ~100-token overlap. We approximate tokens
// as 4 chars (the conservative GPT-family ratio) so we don't pull in tiktoken
// just to drive a chunker — within ±15% of the real count, which is fine for
// a retrieval window. The 512/100 split was the best-performing config in the
// 2026 chunking benchmarks (Firecrawl, Substack) versus semantic chunking.

const CHARS_PER_TOKEN = 4;
const CHUNK_TOKENS = 512;
const OVERLAP_TOKENS = 100;

const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

/**
 * Split `text` into overlapping chunks. Walks sentence/paragraph boundaries
 * when possible so chunks don't slice through mid-word or mid-sentence.
 *
 * Returns: [{ content: string, token_count: number }]
 */
export function chunk(text) {
	const clean = normalize(text);
	if (!clean) return [];
	if (clean.length <= CHUNK_CHARS) {
		return [{ content: clean, token_count: estimateTokens(clean) }];
	}

	const out = [];
	let cursor = 0;
	while (cursor < clean.length) {
		const target = Math.min(cursor + CHUNK_CHARS, clean.length);
		const slice = clean.slice(cursor, target);
		const cut = target >= clean.length ? slice : sliceAtBoundary(slice);
		const trimmed = cut.trim();
		if (trimmed) out.push({ content: trimmed, token_count: estimateTokens(trimmed) });
		if (target >= clean.length) break;
		cursor += Math.max(1, cut.length - OVERLAP_CHARS);
	}
	return out;
}

export function estimateTokens(text) {
	return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
}

function normalize(text) {
	return String(text || '')
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Prefer to end on a paragraph break, then sentence end, then space. Falls
// through to the raw slice if none are reachable in the last 25% of the chunk.
function sliceAtBoundary(slice) {
	const tail = Math.floor(slice.length * 0.25);
	const window = slice.slice(slice.length - tail);

	const para = window.lastIndexOf('\n\n');
	if (para >= 0) return slice.slice(0, slice.length - tail + para + 2);

	const sentence = lastIndexOfAny(window, ['. ', '! ', '? ', '.\n', '!\n', '?\n']);
	if (sentence >= 0) return slice.slice(0, slice.length - tail + sentence + 2);

	const space = window.lastIndexOf(' ');
	if (space >= 0) return slice.slice(0, slice.length - tail + space + 1);

	return slice;
}

function lastIndexOfAny(str, needles) {
	let best = -1;
	for (const n of needles) {
		const i = str.lastIndexOf(n);
		if (i > best) best = i;
	}
	return best;
}
