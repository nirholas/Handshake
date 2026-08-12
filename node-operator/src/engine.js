// Built-in proof workload: real text generation with a small open model.
//
// The model is distilgpt2 (82M params, the distilled GPT-2, MIT-licensed
// weights from OpenAI's GPT-2 family), served from the ONNX export published
// by Xenova on Hugging Face. The quantized graph is ~80 MB, small enough that
// the image builds anywhere and fast enough on CPU to prove the job loop end
// to end; on a GPU host the same graph runs on the CUDA execution provider
// (see Dockerfile.gpu).
//
// Files are downloaded from huggingface.co into MODEL_CACHE_DIR on first run
// and checksummed by the hub's own ETag path (resolve/main pins the revision
// served today; set MODEL_REVISION to pin an exact commit).
//
// The tokenizer is a byte-level BPE (GPT-2 family). Rather than vendoring a
// tokenizer library, this module implements the exact algorithm from the
// Hugging Face tokenizers spec over the repo's real vocab.json/merges.txt:
// bytes-to-unicode mapping, the GPT-2 pre-tokenizer split regex, then BPE
// merge ranking. Generation is greedy argmax over the ONNX logits.

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import ort from 'onnxruntime-node';

export const DEFAULT_MODEL_ID = 'Xenova/distilgpt2';
export const DEFAULT_MODEL_REVISION = 'main';

// decoder_model_merged_quantized.onnx is the KV-cache-fused, int8-quantized
// export: no past_key_values inputs to manage, ~80 MB download. The greedy
// loop feeds only input_ids + attention_mask. MODEL_ID/MODEL_REVISION must
// resolve these exact paths.
const MODEL_FILES = [
	'onnx/decoder_model_merged_quantized.onnx',
	'config.json',
	'tokenizer.json',
	'vocab.json',
	'merges.txt',
];

// ── Download ────────────────────────────────────────────────────────────────

async function fileExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function download(url, dest) {
	await mkdir(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.part-${process.pid}`;
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) {
		throw new Error(`model download failed: ${res.status} ${res.statusText} for ${url}`);
	}
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	await rename(tmp, dest);
}

// Ensure every model file is present under cacheDir; returns the directory.
export async function ensureModel({ cacheDir, modelId = DEFAULT_MODEL_ID, revision = DEFAULT_MODEL_REVISION, log = () => {} }) {
	await mkdir(cacheDir, { recursive: true });
	for (const rel of MODEL_FILES) {
		const dest = path.join(cacheDir, rel);
		if (await fileExists(dest)) continue;
		const url = `https://huggingface.co/${modelId}/resolve/${revision}/${rel}`;
		log(`downloading ${rel}`);
		await download(url, dest);
	}
	return cacheDir;
}

// ── Byte-level BPE tokenizer (GPT-2 family) ─────────────────────────────────

// The GPT-2 bytes-to-unicode table: printable bytes map to themselves, the
// rest map to codepoints 256+. Identical to transformers' bytes_to_unicode().
function buildBytesToUnicode() {
	const bs = [];
	for (let i = 33; i <= 126; i++) bs.push(i);
	for (let i = 161; i <= 172; i++) bs.push(i);
	for (let i = 174; i <= 255; i++) bs.push(i);
	const cs = [...bs];
	let n = 0;
	const b2u = new Map();
	for (let b = 0; b < 256; b++) {
		if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + n);
			n++;
		}
	}
	for (let i = 0; i < bs.length; i++) b2u.set(bs[i], String.fromCodePoint(cs[i]));
	const u2b = new Map([...b2u].map(([b, u]) => [u, b]));
	return { b2u, u2b };
}

// GPT-2 pre-tokenizer split pattern (the JS-safe equivalent of the original
// Python regex): contractions, words, numbers, symbol runs, whitespace runs.
const PRE_TOKENIZER_RE = /'s|'t|'re|'ve|'m|'ll|'d| ?[A-Za-z]+| ?[0-9]+| ?[^\sA-Za-z0-9]+|\s+(?!\S)|\s+/gu;

export class BpeTokenizer {
	constructor({ vocab, merges, b2u, u2b, eosTokenId }) {
		this.vocab = vocab; // token string -> id
		this.idToToken = new Map(Object.entries(vocab).map(([t, id]) => [id, t]));
		this.b2u = b2u;
		this.u2b = u2b;
		this.eosTokenId = eosTokenId;
		// Merge rank lookup: "left right" -> rank.
		this.ranks = new Map(merges.map((pair, i) => [`${pair[0]} ${pair[1]}`, i]));
		this.cache = new Map();
	}

	static async load(dir) {
		const vocab = JSON.parse(await readFile(path.join(dir, 'vocab.json'), 'utf8'));
		const mergesRaw = await readFile(path.join(dir, 'merges.txt'), 'utf8');
		const merges = mergesRaw
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'))
			.map((l) => l.split(' '));
		const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
		const { b2u, u2b } = buildBytesToUnicode();
		return new BpeTokenizer({ vocab, merges, b2u, u2b, eosTokenId: config.eos_token_id ?? 50256 });
	}

	encode(text) {
		const preTokens = String(text).match(PRE_TOKENIZER_RE) || [];
		const ids = [];
		for (const pre of preTokens) {
			// Map raw UTF-8 bytes through the bytes-to-unicode alphabet.
			const bytes = new TextEncoder().encode(pre);
			const word = [...bytes].map((b) => this.b2u.get(b));
			for (const token of this.bpe(word)) {
				const id = this.vocab[token];
				if (id !== undefined) ids.push(id);
			}
		}
		return ids;
	}

	decode(ids) {
		const tokens = ids.map((id) => this.idToToken.get(id) || '');
		const text = tokens.join('');
		const bytes = [];
		for (const ch of text) {
			const b = this.u2b.get(ch);
			if (b !== undefined) bytes.push(b);
		}
		return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
	}

	bpe(word) {
		const key = word.join('');
		if (this.cache.has(key)) return this.cache.get(key);
		if (word.length <= 1) {
			this.cache.set(key, word);
			return word;
		}
		let current = word;
		for (;;) {
			// Find the lowest-rank adjacent pair.
			let bestRank = Infinity;
			let bestIdx = -1;
			for (let i = 0; i < current.length - 1; i++) {
				const rank = this.ranks.get(`${current[i]} ${current[i + 1]}`);
				if (rank !== undefined && rank < bestRank) {
					bestRank = rank;
					bestIdx = i;
				}
			}
			if (bestIdx === -1) break;
			const merged = current[bestIdx] + current[bestIdx + 1];
			current = [...current.slice(0, bestIdx), merged, ...current.slice(bestIdx + 2)];
		}
		this.cache.set(key, current);
		return current;
	}
}

// ── Inference session ───────────────────────────────────────────────────────

// The npm `onnxruntime-node` build ships a CUDA provider stub that hard-fails
// session creation when it is listed but the CUDA shared libraries are absent
// (any CPU-only host). So CUDA is requested only when the runtime reports a
// GPU build: the GPU image (Dockerfile.gpu) installs the CUDA-enabled
// onnxruntime build and sets ONNXRUNTIME_CUDA=1; everywhere else the session
// runs on the CPU provider.
function executionProviders() {
	const list = [];
	if (process.env.ONNXRUNTIME_CUDA === '1') list.push('cuda');
	list.push('cpu');
	return list;
}

export class InferenceEngine {
	constructor({ session, tokenizer, maxLength, config }) {
		this.session = session;
		this.tokenizer = tokenizer;
		this.maxLength = maxLength;
		this.config = config || {};
	}

	static async load({ cacheDir, log = () => {} }) {
		const modelPath = path.join(cacheDir, 'onnx', 'decoder_model_merged_quantized.onnx');
		const config = JSON.parse(await readFile(path.join(cacheDir, 'config.json'), 'utf8'));
		const tokenizer = await BpeTokenizer.load(cacheDir);
		const session = await ort.InferenceSession.create(modelPath, {
			executionProviders: executionProviders(),
			graphOptimizationLevel: 'all',
			logSeverityLevel: 3,
		});
		log(`model loaded from ${modelPath}`);
		return new InferenceEngine({
			session,
			tokenizer,
			config,
			maxLength: Math.min(Number(config.n_positions) || 1024, 1024),
		});
	}

	// Greedy generation over the merged KV-cache graph. First pass feeds the
	// whole prompt with an empty cache (zero-filled past_key_values of seq 0 and
	// use_cache_branch=false); every later pass feeds only the new token plus
	// the cache returned by the previous pass. Deterministic argmax decode is
	// what a verifiable proof workload wants: the same prompt on an honest
	// node produces the same output hash.
	async generate(prompt, maxNewTokens = 48) {
		const t0 = Date.now();
		const promptIds = this.tokenizer.encode(prompt);
		const startIds = promptIds.length ? promptIds : [this.tokenizer.eosTokenId];
		const budget = Math.min(Math.max(1, maxNewTokens), this.maxLength - startIds.length);
		const nLayers = Number(this.config.n_layer) || 6;
		const nHeads = Number(this.config.n_head) || 12;
		const headDim = Math.floor((Number(this.config.n_embd) || 768) / nHeads);
		const empty = () => new ort.Tensor('float32', new Float32Array(0), [1, nHeads, 0, headDim]);

		let past = new Map();
		for (let l = 0; l < nLayers; l++) {
			past.set(`past_key_values.${l}.key`, empty());
			past.set(`past_key_values.${l}.value`, empty());
		}

		const inputIds = [...startIds];
		let stepIds = inputIds; // first pass consumes the full prompt
		let attentionLen = inputIds.length;
		let generated = 0;
		const feedNames = new Set(this.session.inputNames);

		for (let step = 0; step < budget; step++) {
			const feeds = {
				input_ids: new ort.Tensor('int64', BigInt64Array.from(stepIds.map(BigInt)), [1, stepIds.length]),
			};
			if (feedNames.has('attention_mask')) {
				feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from({ length: attentionLen }, () => 1n), [1, attentionLen]);
			}
			if (feedNames.has('use_cache_branch')) {
				feeds.use_cache_branch = new ort.Tensor('bool', new Uint8Array([step === 0 ? 0 : 1]), [1]);
			}
			for (const [name, tensor] of past) if (feedNames.has(name)) feeds[name] = tensor;

			const outputs = await this.session.run(feeds);
			const logits = outputs.logits;
			const vocabSize = logits.dims[logits.dims.length - 1];
			const last = logits.data.subarray(logits.data.length - vocabSize);
			let best = 0;
			let bestVal = -Infinity;
			for (let i = 0; i < last.length; i++) {
				if (last[i] > bestVal) {
					bestVal = last[i];
					best = i;
				}
			}

			// Rotate the KV cache for the next step.
			const nextPast = new Map();
			for (let l = 0; l < nLayers; l++) {
				const k = outputs[`present.${l}.key`];
				const v = outputs[`present.${l}.value`];
				if (k) nextPast.set(`past_key_values.${l}.key`, k);
				if (v) nextPast.set(`past_key_values.${l}.value`, v);
			}
			if (nextPast.size === past.size) past = nextPast;

			inputIds.push(best);
			stepIds = [best];
			attentionLen += 1;
			generated++;
			if (best === this.tokenizer.eosTokenId) break;
		}

		const text = this.tokenizer.decode(inputIds.slice(inputIds.length - generated));
		return { text, tokens: generated, latencyMs: Date.now() - t0 };
	}
}

// Load model + engine in one call, downloading on first use.
export async function loadEngine({ cacheDir, modelId, revision, log } = {}) {
	const dir = await ensureModel({ cacheDir, modelId, revision, log });
	return InferenceEngine.load({ cacheDir: dir, log });
}
