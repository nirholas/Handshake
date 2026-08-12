/**
 * The built-in proof workload: real, local text-embedding inference with the
 * open Xenova/all-MiniLM-L6-v2 model (Apache-2.0, ~90MB ONNX, quantized for
 * CPU). No API keys, no network calls at inference time: the model downloads
 * from HuggingFace once and is cached in ./models thereafter.
 *
 * Why embeddings and not a generative model as the proof workload: it is the
 * smallest model that still exercises the full GPU/CPU tensor path a real
 * phase 4 inference job would (tokenize -> transformer forward -> mean pool
 * -> normalize), runs in seconds on a laptop CPU, and produces a
 * deterministic, verifiable numeric output. Nodes advertise this capability
 * on registration as proof they can execute the runtime; richer models plug
 * into the same runJob() interface.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let _pipeline = null;
let _pipelineModel = null;

/**
 * Load (and cache) the feature-extraction pipeline for a model id. The first
 * call downloads the model weights; later calls return the warm pipeline.
 * `cacheDir` pins where weights land so Docker volumes can persist them.
 */
export async function loadModel(model, { cacheDir } = {}) {
	if (_pipeline && _pipelineModel === model) return _pipeline;
	const { pipeline, env } = await import('@xenova/transformers');
	if (cacheDir) env.cacheDir = cacheDir;
	// The model hub is the only remote allowed, and only on first download.
	env.allowLocalModels = true;
	_pipeline = await pipeline('feature-extraction', model, { quantized: true });
	_pipelineModel = model;
	return _pipeline;
}

/**
 * Execute one inference job.
 *
 * @param {object} job the claimed job: { id, model, input }
 * @param {object} [opts] { cacheDir, now } - now is injectable for tests
 * @returns {Promise<{output: object, startedAt: number, finishedAt: number}>}
 */
export async function runJob(job, { cacheDir, now = () => Date.now() } = {}) {
	const prompt = typeof job.input === 'string' ? job.input : job.input?.text;
	if (typeof prompt !== 'string' || prompt.length === 0) {
		throw new Error(`job ${job.id}: input.text must be a non-empty string`);
	}
	const model = job.model || 'Xenova/all-MiniLM-L6-v2';
	const startedAt = now();
	const extractor = await loadModel(model, { cacheDir });
	const tensor = await extractor(prompt, { pooling: 'mean', normalize: true });
	const finishedAt = now();
	return {
		output: {
			kind: 'text-embedding',
			model,
			dimensions: tensor.dims[tensor.dims.length - 1],
			embedding: Array.from(tensor.data, (v) => Number(v.toFixed(8))),
		},
		startedAt,
		finishedAt,
	};
}

/**
 * A self-check the operator can run before registering: executes the proof
 * workload on a fixed input and returns the output summary. `node
 * src/index.js --self-test` calls this so a fresh operator can prove their
 * host runs the runtime before they ever poll for jobs.
 */
export async function selfTest({ cacheDir } = {}) {
	const probe = { id: 'self-test', model: undefined, input: { text: 'three.ws node operator self-test' } };
	const { output, startedAt, finishedAt } = await runJob(probe, { cacheDir });
	return {
		ok: Array.isArray(output.embedding) && output.embedding.length === output.dimensions,
		model: output.model,
		dimensions: output.dimensions,
		elapsedMs: finishedAt - startedAt,
	};
}
