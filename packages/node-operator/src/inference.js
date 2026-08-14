/**
 * The built-in proof workload: real, local text-embedding inference with the
 * open Xenova/all-MiniLM-L6-v2 model (Apache-2.0, ~23MB quantized ONNX). No
 * API keys, no network calls at inference time: the model downloads from the
 * HuggingFace hub once and is cached in ./models thereafter.
 *
 * Why embeddings and not a generative model as the proof workload: it is the
 * smallest model that still exercises the full GPU/CPU tensor path a real
 * phase 4 inference job would (tokenize -> transformer forward -> mean pool
 * -> normalize), runs in seconds on a laptop CPU, and produces a
 * deterministic, verifiable numeric output. Nodes advertise this capability
 * on registration as proof they can execute the runtime; richer models plug
 * into the same runJob() interface.
 *
 * Device selection is real, not decorative. @huggingface/transformers v4
 * bundles onnxruntime-node 1.24, which ships libonnxruntime_providers_cuda.so
 * for linux/x64, so `DEVICE=cuda` genuinely runs the forward pass on the GPU.
 * The predecessor library (@xenova/transformers v2) hardcoded
 * `executionProviders = ['cpu', 'wasm']` and shipped no CUDA provider at all,
 * which made the old "it picks up CUDA when the drivers are present" claim
 * false on every host.
 */

import { existsSync } from 'node:fs';

/** Devices the operator may request. 'auto' probes GPU first, then CPU. */
export const DEVICES = ['auto', 'cpu', 'cuda', 'webgpu', 'dml', 'coreml'];

let _pipeline = null;
let _pipelineKey = null;
let _resolved = null;

/**
 * Is an NVIDIA driver actually attached to this host?
 *
 * The NVIDIA Container Toolkit (`docker run --gpus all`) mounts the driver
 * device nodes into the container, and a bare-metal host with the driver
 * loaded exposes /proc/driver/nvidia/version. Checking that before reaching
 * for CUDA is what keeps `DEVICE=auto` cheap: the fp32 graph is a 90MB
 * download and the q8 CPU graph is 23MB, so blindly trying CUDA first would
 * cost every CPU-only operator 90MB of weights they can never execute.
 */
export function hasNvidiaDriver({ platform = process.platform, arch = process.arch, exists = existsSync } = {}) {
	if (platform !== 'linux' || arch !== 'x64') return false;
	return exists('/dev/nvidiactl') || exists('/dev/nvidia0') || exists('/proc/driver/nvidia/version');
}

/**
 * Candidate execution devices, most capable first, for a requested setting.
 *
 * An explicit device is honored exactly: asking for 'cuda' on a host with no
 * GPU must fail loudly rather than quietly bill the operator's electricity
 * for a CPU run they did not ask for. 'auto' is the one setting that falls
 * back, and it says so in the log line.
 */
export function deviceCandidates(requested = 'auto', { platform = process.platform, arch = process.arch, gpu } = {}) {
	if (requested && requested !== 'auto') return [requested];
	const nvidia = gpu === undefined ? hasNvidiaDriver({ platform, arch }) : gpu;
	if (platform === 'linux' && arch === 'x64') return nvidia ? ['cuda', 'cpu'] : ['cpu'];
	if (platform === 'darwin') return ['coreml', 'cpu'];
	if (platform === 'win32') return ['dml', 'cpu'];
	return ['cpu'];
}

/**
 * Weight precision for a device. CUDA loads the full fp32 graph (the GPU has
 * the memory and int8 kernels buy nothing there); CPU loads the q8 quantized
 * graph, which is what the 23MB cached download is.
 */
export function defaultDtype(device) {
	return device === 'cpu' ? 'q8' : 'fp32';
}

/**
 * Load (and cache) the feature-extraction pipeline for a model id. The first
 * call downloads the model weights; later calls return the warm pipeline.
 * `cacheDir` pins where weights land so Docker volumes can persist them.
 *
 * @returns {Promise<{extractor: Function, device: string, dtype: string}>}
 */
export async function loadModel(model, { cacheDir, device = 'auto', dtype, log = console } = {}) {
	const key = `${model}|${device}|${dtype || ''}`;
	if (_pipeline && _pipelineKey === key) return { extractor: _pipeline, ..._resolved };
	const { pipeline, env } = await import('@huggingface/transformers');
	if (cacheDir) env.cacheDir = cacheDir;
	// The model hub is the only remote allowed, and only on first download.
	env.allowLocalModels = true;

	const candidates = deviceCandidates(device);
	const failures = [];
	for (const candidate of candidates) {
		const precision = dtype || defaultDtype(candidate);
		try {
			_pipeline = await pipeline('feature-extraction', model, { device: candidate, dtype: precision });
			_pipelineKey = key;
			_resolved = { device: candidate, dtype: precision };
			if (failures.length) {
				log.warn?.(`[node] ${failures.length} device(s) unavailable, running on ${candidate}: ${failures.join(' | ')}`);
			}
			return { extractor: _pipeline, ..._resolved };
		} catch (err) {
			failures.push(`${candidate}: ${err.message}`);
		}
	}
	throw new Error(`could not load ${model} on any of [${candidates.join(', ')}] -> ${failures.join(' | ')}`);
}

/**
 * Execute one inference job.
 *
 * The returned output deliberately carries no device or dtype field: two
 * honest nodes running the same job must produce the same output shape, and
 * the result receipt hashes this object. Runtime details belong in the
 * operator's own logs, not in a signed result other nodes have to match.
 *
 * @param {object} job the claimed job: { id, model, input }
 * @param {object} [opts] { cacheDir, device, dtype, now } - now is injectable for tests
 * @returns {Promise<{output: object, startedAt: number, finishedAt: number, device: string}>}
 */
export async function runJob(job, { cacheDir, device = 'auto', dtype, log = console, now = () => Date.now() } = {}) {
	const prompt = typeof job.input === 'string' ? job.input : job.input?.text;
	if (typeof prompt !== 'string' || prompt.length === 0) {
		throw new Error(`job ${job.id}: input.text must be a non-empty string`);
	}
	const model = job.model || 'Xenova/all-MiniLM-L6-v2';
	const startedAt = now();
	const { extractor, device: resolvedDevice, dtype: resolvedDtype } = await loadModel(model, { cacheDir, device, dtype, log });
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
		device: resolvedDevice,
		dtype: resolvedDtype,
	};
}

/**
 * A self-check the operator can run before registering: executes the proof
 * workload on a fixed input and returns the output summary, including the
 * device that actually ran it. `node src/index.js --self-test` calls this so
 * a fresh operator can prove their host runs the runtime (and see whether
 * their GPU was really picked up) before they ever poll for jobs.
 */
export async function selfTest({ cacheDir, device = 'auto', dtype, log = console } = {}) {
	const probe = { id: 'self-test', model: undefined, input: { text: 'three.ws node operator self-test' } };
	const { output, startedAt, finishedAt, device: resolvedDevice, dtype: resolvedDtype } = await runJob(probe, { cacheDir, device, dtype, log });
	return {
		ok: Array.isArray(output.embedding) && output.embedding.length === output.dimensions,
		model: output.model,
		dimensions: output.dimensions,
		device: resolvedDevice,
		dtype: resolvedDtype,
		elapsedMs: finishedAt - startedAt,
	};
}
