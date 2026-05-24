// Knowledge ingest + list + delete for the talking-agent widget. Accepts:
//   { source_type: 'url',  source_url: 'https://…', title?: '…' }
//   { source_type: 'text', content:    '…',         title:  '…' }
//   { source_type: 'pdf',  content:    '<extracted>', title: '…', source_url?: '…', byte_size?: n }
//
// PDFs are extracted client-side (pdfjs in the studio bundle) and posted as
// text — the server never decodes binary PDFs, which keeps this route in the
// edge-friendly fetch-only path.

import { z } from 'zod';

import { sql } from '../../_lib/db.js';
import { embed, embeddingsConfigured, cosine } from '../../_lib/embeddings.js';
import { chunk, estimateTokens } from '../../_lib/chunker.js';
import { fetchAndExtract } from '../../_lib/text-extract.js';
import { shortId } from '../../_lib/ids.js';

const MAX_DOCS_PER_WIDGET = 25;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS_PER_DOC = 400;
const MAX_PREVIEW_QS = 3;

// Embed text in batches of N. text-embedding-3-small accepts up to 2048
// inputs per call, but 64 keeps memory predictable and lets failures retry
// at a small unit.
const EMBED_BATCH = 64;

const baseSchema = z.object({
	title: z.string().trim().min(1).max(160).optional(),
	source_type: z.enum(['url', 'text', 'pdf', 'markdown']),
});

const urlSchema = baseSchema.extend({
	source_type: z.literal('url'),
	source_url: z.string().url(),
});

const textSchema = baseSchema.extend({
	source_type: z.enum(['text', 'markdown', 'pdf']),
	content: z.string().min(1).max(MAX_TEXT_BYTES),
	source_url: z.string().url().optional(),
	byte_size: z.number().int().nonnegative().optional(),
});

const docInput = z.discriminatedUnion('source_type', [
	urlSchema,
	textSchema.extend({ source_type: z.literal('text') }),
	textSchema.extend({ source_type: z.literal('markdown') }),
	textSchema.extend({ source_type: z.literal('pdf') }),
]);

export async function listKnowledge(widgetId) {
	const docs = await sql`
		select id, title, source_type, source_url, byte_size, chunk_count,
		       token_count, status, error, created_at, updated_at
		from widget_knowledge_docs
		where widget_id = ${widgetId}
		order by created_at desc
	`;
	return {
		docs: docs.map((d) => ({
			id: d.id,
			title: d.title,
			source_type: d.source_type,
			source_url: d.source_url,
			byte_size: Number(d.byte_size || 0),
			chunk_count: Number(d.chunk_count || 0),
			token_count: Number(d.token_count || 0),
			status: d.status,
			error: d.error,
			created_at: d.created_at,
			updated_at: d.updated_at,
		})),
	};
}

// Inkeep-style retrieval debugger: takes a probe query and returns the top-K
// chunks with cosine scores + the source doc. Lets the creator verify their
// docs are actually retrievable without having to chat. No LLM call — pure
// vector lookup, mirrors what handleChat would inject as grounding.
export async function testRetrieval({ widgetId, query, topK = 5 }) {
	if (!embeddingsConfigured()) {
		throw httpError(
			503,
			'embedder_unavailable',
			'Knowledge test needs an OpenAI key on the server (OPENAI_API_KEY).',
		);
	}
	const q = String(query || '').trim();
	if (q.length < 2) throw httpError(400, 'invalid_request', 'query must be at least 2 chars');

	const rows = await sql`
		select c.id, c.doc_id, c.chunk_index, c.content, c.embedding, c.token_count,
		       d.title, d.source_url, d.source_type
		from widget_knowledge_chunks c
		join widget_knowledge_docs   d on d.id = c.doc_id
		where c.widget_id = ${widgetId}
	`;
	if (!rows.length) return { query: q, results: [], chunks_searched: 0 };

	const [queryEmbedding] = await embed([q]);
	const scored = rows
		.map((r) => {
			const e = Array.isArray(r.embedding) ? r.embedding : r.embedding?.values || [];
			return {
				id: Number(r.id),
				doc_id: r.doc_id,
				chunk_index: Number(r.chunk_index),
				score: cosine(queryEmbedding, e),
				token_count: Number(r.token_count || 0),
				excerpt: truncate(String(r.content), 280),
				title: r.title,
				source_url: r.source_url,
				source_type: r.source_type,
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, Math.min(20, topK)));

	return {
		query: q,
		results: scored,
		chunks_searched: rows.length,
	};
}

function truncate(s, n) {
	if (s.length <= n) return s;
	return s.slice(0, n).trim() + '…';
}

export async function deleteKnowledge({ widgetId, userId, docId }) {
	const rows = await sql`
		delete from widget_knowledge_docs
		where id = ${docId} and widget_id = ${widgetId} and user_id = ${userId}
		returning id
	`;
	return !!rows[0];
}

export async function ingestKnowledge({ widgetId, userId, input }) {
	if (!embeddingsConfigured()) {
		throw httpError(
			503,
			'embedder_unavailable',
			'Knowledge upload needs an OpenAI key on the server (OPENAI_API_KEY).',
		);
	}

	const parsed = docInput.safeParse(input);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
			.join('; ');
		throw httpError(400, 'validation_error', msg);
	}
	const body = parsed.data;

	const [{ n }] = await sql`
		select count(*)::int as n from widget_knowledge_docs where widget_id = ${widgetId}
	`;
	if (n >= MAX_DOCS_PER_WIDGET) {
		throw httpError(
			400,
			'too_many_docs',
			`Each widget can hold up to ${MAX_DOCS_PER_WIDGET} knowledge docs. Delete one to add another.`,
		);
	}

	let title,
		text,
		sourceUrl = null,
		byteSize = 0;
	if (body.source_type === 'url') {
		const ext = await fetchAndExtract(body.source_url);
		title = body.title || ext.title;
		text = ext.text;
		sourceUrl = body.source_url;
		byteSize = ext.byteSize;
	} else {
		text = String(body.content || '').trim();
		title = body.title || autoTitle(text);
		sourceUrl = body.source_url || null;
		byteSize = body.byte_size || Buffer.byteLength(text, 'utf8');
	}

	if (!text || text.length < 12) {
		throw httpError(400, 'empty_source', 'No readable text was extracted from this source.');
	}

	const chunks = chunk(text).slice(0, MAX_CHUNKS_PER_DOC);
	if (!chunks.length) {
		throw httpError(400, 'empty_source', 'No chunks produced from this source.');
	}

	const docId = shortId('wkd');
	const tokenSum = chunks.reduce((s, c) => s + (c.token_count || 0), 0);

	await sql`
		insert into widget_knowledge_docs
			(id, widget_id, user_id, title, source_type, source_url, byte_size, chunk_count, token_count, status)
		values
			(${docId}, ${widgetId}, ${userId}, ${title.slice(0, 160)}, ${body.source_type},
			 ${sourceUrl}, ${byteSize}, ${chunks.length}, ${tokenSum}, 'processing')
	`;

	try {
		for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
			const slice = chunks.slice(i, i + EMBED_BATCH);
			const embedded = await embed(slice.map((c) => c.content));
			const inserts = slice.map((c, j) => {
				const vec = Array.from(embedded[j]);
				return sql`
					insert into widget_knowledge_chunks
						(doc_id, widget_id, chunk_index, content, embedding, token_count)
					values
						(${docId}, ${widgetId}, ${i + j}, ${c.content},
						 ${JSON.stringify(vec)}::jsonb, ${c.token_count})
				`;
			});
			await sql.transaction(inserts);
		}
		await sql`update widget_knowledge_docs set status = 'ready' where id = ${docId}`;
	} catch (err) {
		await sql`
			update widget_knowledge_docs
			set status = 'failed', error = ${String(err?.message || 'embed failed').slice(0, 500)}
			where id = ${docId}
		`.catch(() => {});
		throw httpError(err.status || 502, 'embed_failed', err.message || 'embedding failed');
	}

	const previewQuestions = synthesizePreviewQs(chunks);

	return {
		id: docId,
		title: title.slice(0, 160),
		source_type: body.source_type,
		source_url: sourceUrl,
		byte_size: byteSize,
		chunk_count: chunks.length,
		token_count: tokenSum,
		status: 'ready',
		preview_questions: previewQuestions,
	};
}

// "Your bot now knows X" preview — pulls salient sentences from the first few
// chunks and reshapes them into starter questions so the creator can sanity-
// check that the doc landed in retrieval. Heuristic, not LLM-generated.
function synthesizePreviewQs(chunks) {
	const sentences = [];
	for (const c of chunks.slice(0, 3)) {
		for (const s of String(c.content).split(/(?<=[.!?])\s+/)) {
			const trimmed = s.trim();
			if (trimmed.length >= 32 && trimmed.length <= 180) sentences.push(trimmed);
		}
	}
	if (!sentences.length) return [];

	// Pick the longest distinct-prefix sentences first.
	const seen = new Set();
	const picked = [];
	for (const s of sentences.sort((a, b) => b.length - a.length)) {
		const key = s.slice(0, 40).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		picked.push(s);
		if (picked.length >= MAX_PREVIEW_QS) break;
	}

	return picked.map(toQuestion);
}

function toQuestion(sentence) {
	const s = sentence.replace(/[.!?]+$/, '').trim();
	if (/^(what|when|where|why|how|who|which|can|do|does|is|are)\b/i.test(s)) return s + '?';
	const noun = s.split(/[.,;:—-]/)[0].trim();
	return noun
		? `What does the doc say about ${lower(noun.slice(0, 80))}?`
		: `Can you tell me more about this?`;
}

function lower(s) {
	return s.charAt(0).toLowerCase() + s.slice(1);
}

function autoTitle(text) {
	const firstLine =
		String(text)
			.split('\n')
			.find((l) => l.trim().length > 0) || '';
	return firstLine.trim().slice(0, 120) || `Pasted text (${estimateTokens(text)} tokens)`;
}

function httpError(status, code, message) {
	return Object.assign(new Error(message), { status, code });
}
