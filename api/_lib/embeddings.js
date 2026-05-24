// OpenAI text-embedding-3-small @ 256 dimensions (Matryoshka truncation).
// 12× cheaper storage than the full 3072-dim model with ~98% of recall, which
// is the right tradeoff for grounding a small set of widget knowledge docs
// where chunk counts stay in the low thousands.
//
// We keep this here (rather than reaching for an SDK) so the talking-agent
// chat path remains a single zero-dep fetch call — matching the existing
// pattern in api/widgets/[id]/[action].js.

const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 256;

export function embeddingsConfigured() {
	return !!process.env.OPENAI_API_KEY;
}

/**
 * Embed an array of strings. Returns Float64Array[].
 * Throws if OPENAI_API_KEY isn't configured or the API errors.
 */
export async function embed(texts) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey)
		throw Object.assign(new Error('OPENAI_API_KEY not configured'), { code: 'no_embedder' });
	if (!texts.length) return [];

	const upstream = await fetch(EMBED_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: EMBED_MODEL,
			input: texts,
			dimensions: EMBED_DIMS,
		}),
	});
	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		throw Object.assign(new Error(`embedding api ${upstream.status}: ${body.slice(0, 200)}`), {
			code: 'embedder_error',
			status: upstream.status,
		});
	}
	const data = await upstream.json();
	return (data.data || [])
		.sort((a, b) => a.index - b.index)
		.map((row) => Float64Array.from(row.embedding));
}

/**
 * Cosine similarity between two equal-length numeric arrays. Inputs come from
 * embed() (Float64Array) or from the DB (plain Array via JSONB) — both work.
 */
export function cosine(a, b) {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i];
		const y = b[i];
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (!na || !nb) return 0;
	return dot / Math.sqrt(na * nb);
}
