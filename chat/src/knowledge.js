import { get } from 'svelte/store';
import { openaiAPIKey, notify } from './stores.js';

export function chunkText(text, chunkSize = 500, overlap = 50) {
	const words = text.split(/\s+/).filter(Boolean);
	const chunks = [];
	for (let i = 0; i < words.length; i += chunkSize - overlap) {
		chunks.push(words.slice(i, i + chunkSize).join(' '));
		if (i + chunkSize >= words.length) break;
	}
	return chunks;
}

export async function embedTexts(texts) {
	const apiKey = get(openaiAPIKey);
	if (!apiKey) throw new Error('No OpenAI API key set. Add it in Settings.');
	const res = await fetch('https://api.openai.com/v1/embeddings', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error?.message || `Embeddings API error: ${res.status}`);
	}
	const json = await res.json();
	return json.data.map((d) => new Float32Array(d.embedding));
}

export function cosineSimilarity(a, b) {
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export function getChunksForAgent(db, agentId) {
	return new Promise((resolve, reject) => {
		const tx = db.transaction('knowledge', 'readonly');
		const index = tx.objectStore('knowledge').index('agentId');
		const req = index.getAll(agentId);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export function saveChunks(db, chunks) {
	return new Promise((resolve, reject) => {
		const tx = db.transaction('knowledge', 'readwrite');
		const store = tx.objectStore('knowledge');
		for (const chunk of chunks) store.put(chunk);
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
	});
}

export function deleteChunksForFile(db, agentId, filename) {
	return new Promise((resolve, reject) => {
		const tx = db.transaction('knowledge', 'readwrite');
		const index = tx.objectStore('knowledge').index('agentId');
		const req = index.getAll(agentId);
		req.onsuccess = () => {
			const toDelete = req.result.filter((c) => c.filename === filename);
			const store = tx.objectStore('knowledge');
			for (const c of toDelete) store.delete(c.id);
		};
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
	});
}

export async function retrieveTopK(db, agentId, query, k = 3) {
	const [queryEmbedding] = await embedTexts([query]);
	const chunks = await getChunksForAgent(db, agentId);
	if (chunks.length === 0) return [];
	const scored = chunks.map((c) => ({
		...c,
		score: cosineSimilarity(queryEmbedding, new Float32Array(c.embedding)),
	}));
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k);
}

export async function ingestFile(db, agentId, file, onProgress) {
	const text = await file.text();
	const chunks = chunkText(text);
	const total = chunks.length;
	onProgress('chunking', total, total);

	const BATCH = 20;
	const records = [];
	for (let i = 0; i < chunks.length; i += BATCH) {
		const batch = chunks.slice(i, i + BATCH);
		const embeddings = await embedTexts(batch);
		for (let j = 0; j < batch.length; j++) {
			records.push({
				id: `${agentId}:${file.name}:${i + j}`,
				agentId,
				filename: file.name,
				chunkIndex: i + j,
				text: batch[j],
				embedding: Array.from(embeddings[j]),
			});
		}
		onProgress('embedding', i + BATCH, total);
	}
	await saveChunks(db, records);
	onProgress('done', total, total);
}
