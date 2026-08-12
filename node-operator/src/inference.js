/**
 * Real local inference for the node operator client.
 *
 * The built-in proof workload is MNIST-8 from the ONNX model zoo (MIT),
 * vendored at models/mnist-8.onnx: a 26 KB convolutional digit classifier.
 * It is deliberately small so a zero-context operator can prove their node
 * end to end on any hardware in milliseconds, while still being a real model
 * executing real tensor math through ONNX Runtime - not a stub.
 *
 * Runtime selection: the CUDA build of ONNX Runtime (package
 * onnxruntime-node-gpu, installed in the GPU Docker image) is tried first;
 * the plain CPU build (onnxruntime-node) is the fallback. Both export the
 * same API. Force a provider with ORT_EXECUTION_PROVIDER=cpu|cuda.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MODEL_PATH = join(here, '..', 'models', 'mnist-8.onnx');
export const MODEL_NAME = 'mnist-8';

/**
 * Deterministic benchmark-vector generator. The platform pins the vector set
 * (api/_lib/inference-benchmark.js), so both sides must derive the exact same
 * 784 floats from a seed: a SplitMix32 LCG over [0,1). Seeds are small
 * integers embedded in the job payload.
 */
export function benchmarkVector(seed) {
	let state = (seed >>> 0) || 1;
	const out = new Float32Array(784);
	for (let i = 0; i < out.length; i++) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[i] = state / 0x100000000;
	}
	return out;
}

/** The seeds the platform draws proof jobs from. Keep in step with the API. */
export const BENCHMARK_SEEDS = [11, 42, 137, 1009, 65537];

let ortPromise = null;

async function loadOrt() {
	if (!ortPromise) {
		ortPromise = (async () => {
			// The GPU image installs onnxruntime-node-gpu; the CPU image (and a
			// plain npm ci) installs onnxruntime-node. Try GPU first.
			const gpu = await import('onnxruntime-node-gpu').catch(() => null);
			if (gpu) return gpu.default ?? gpu;
			const cpu = await import('onnxruntime-node');
			return cpu.default ?? cpu;
		})();
	}
	return ortPromise;
}

let sessionPromise = null;

async function loadSession() {
	if (!sessionPromise) {
		sessionPromise = (async () => {
			const ort = await loadOrt();
			const available = ort.getAvailableExecutionProviders?.() ?? ['cpu'];
			const wanted = (process.env.ORT_EXECUTION_PROVIDER || '').trim();
			const providers = wanted
				? [wanted]
				: available.includes('cuda')
					? ['cuda', 'cpu']
					: ['cpu'];
			const modelBytes = readFileSync(MODEL_PATH);
			const session = await ort.InferenceSession.create(modelBytes, {
				executionProviders: providers,
			});
			return { ort, session, provider: providers[0] };
		})();
	}
	return sessionPromise;
}

/** Which execution provider the session will use ('cuda' when the GPU build
 * and hardware are present, else 'cpu'). Resolved lazily with the session. */
export async function activeProvider() {
	const { provider } = await loadSession();
	return provider;
}

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

/**
 * Run the proof model on a 784-float input. Returns the argmax class, a
 * sha256 of the raw logit bytes (recorded for audit), and wall time.
 */
export async function runMnist(input) {
	if (!(input instanceof Float32Array) || input.length !== 784) {
		throw new Error(`mnist-8 input must be a Float32Array of 784 values, got ${input?.length}`);
	}
	const { ort, session } = await loadSession();
	const tensor = new ort.Tensor('float32', input, [1, 1, 28, 28]);
	const started = process.hrtime.bigint();
	const outputs = await session.run({ [session.inputNames[0]]: tensor });
	const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
	const logits = outputs[session.outputNames[0]].data;
	let top1 = 0;
	for (let i = 1; i < logits.length; i++) {
		if (logits[i] > logits[top1]) top1 = i;
	}
	return {
		top1,
		logitsSha256: sha256Hex(Buffer.from(logits.buffer, logits.byteOffset, logits.byteLength)),
		durationMs: Math.round(durationMs * 1000) / 1000,
	};
}

/** Decode the platform's base64 float32 job input. */
export function decodeJobInput(inputB64) {
	const bytes = Buffer.from(inputB64, 'base64');
	if (bytes.byteLength !== 784 * 4) {
		throw new Error(`job input must decode to ${784 * 4} bytes, got ${bytes.byteLength}`);
	}
	return new Float32Array(bytes.buffer, bytes.byteOffset, 784);
}

/** Self-description for registration: what this build can actually run. */
export async function capabilities() {
	const provider = await activeProvider();
	return [`${MODEL_NAME}@${provider}`];
}
