// SignInput — webcam ASL fingerspelling capture → text.
//
// The input half of the platform's sign-language loop (the output half is
// src/sign-speech.js). Opens the user's camera, runs MediaPipe's Holistic
// landmarker in the browser, assembles per-frame feature rows in the exact
// column order the recognition worker publishes (GET /api/asl-recognition),
// and on stop POSTs the frame matrix for transcription. Raw video never
// leaves the device — only landmark coordinates.
//
// Usage:
//   const input = new SignInput({ onState });
//   await input.start();          // camera on, capturing
//   const { text } = await input.stop();  // camera off, transcribed
//
// The recognizer reads continuous fingerspelling (Kaggle-2023 ASLFR
// 1st-place model — see workers/model-asl-recognition/README.md for the
// full provenance chain).

import { FilesetResolver, HolisticLandmarker } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task';

const COLUMN_RE = /^([xyz])_(face|left_hand|right_hand|pose)_(\d+)$/;

// Result-field lookup per schema group. Holistic returns arrays-of-arrays
// (one entry per detected person; we take the first).
const GROUP_FIELDS = {
	face: 'faceLandmarks',
	left_hand: 'leftHandLandmarks',
	right_hand: 'rightHandLandmarks',
	pose: 'poseLandmarks',
};

/** Parse the worker's column names once into fast extractors. */
export function buildColumnExtractors(columns) {
	return columns.map((name) => {
		const m = COLUMN_RE.exec(name);
		if (!m) throw new Error(`unrecognized landmark column: ${name}`);
		const [, coord, group, idxStr] = m;
		return { field: GROUP_FIELDS[group], coord, idx: parseInt(idxStr, 10) };
	});
}

/** One Holistic result → a schema row ([number|null] per column). */
export function extractRow(result, extractors) {
	return extractors.map(({ field, coord, idx }) => {
		const lm = result?.[field]?.[0]?.[idx];
		if (!lm) return null;
		const v = lm[coord];
		return Number.isFinite(v) ? v : null;
	});
}

export class SignInput {
	/**
	 * @param {{
	 *   apiBase?: string,
	 *   onState?: (state: 'loading'|'capturing'|'transcribing'|'idle', detail?: object) => void,
	 *   maxSeconds?: number,
	 *   targetFps?: number,
	 * }} [opts]
	 */
	constructor(opts = {}) {
		this.apiBase = opts.apiBase ?? '/api/asl-recognition';
		this.onState = opts.onState ?? (() => {});
		this.maxSeconds = opts.maxSeconds ?? 20;
		this.targetFps = opts.targetFps ?? 24;

		this._landmarker = null;
		this._extractors = null;
		this._minFrames = 8;
		this._video = null;
		this._stream = null;
		this._frames = [];
		this._raf = 0;
		this._lastSampleT = 0;
		this._lastVideoTime = -1;
		this.capturing = false;
	}

	/** Camera preview element (attach it to the page while capturing). */
	get videoElement() {
		return this._video;
	}

	async _ensureReady() {
		if (this._landmarker && this._extractors) return;
		this.onState('loading');
		const [schemaRes, fileset] = await Promise.all([
			fetch(this.apiBase, { headers: { accept: 'application/json' } }),
			FilesetResolver.forVisionTasks(WASM_URL),
		]);
		if (!schemaRes.ok) {
			const body = await schemaRes.json().catch(() => ({}));
			throw new Error(body.message || `sign recognition unavailable (${schemaRes.status})`);
		}
		const schema = await schemaRes.json();
		this._extractors = buildColumnExtractors(schema.columns);
		this._minFrames = schema.min_frames ?? 8;
		this._landmarker = await HolisticLandmarker.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
			runningMode: 'VIDEO',
		});
	}

	/** Open the camera and start collecting frames. */
	async start() {
		if (this.capturing) return;
		await this._ensureReady();
		this._stream = await navigator.mediaDevices.getUserMedia({
			video: { width: 640, height: 480, facingMode: 'user' },
			audio: false,
		});
		const video = document.createElement('video');
		video.playsInline = true;
		video.muted = true;
		video.srcObject = this._stream;
		await video.play();
		this._video = video;
		this._frames = [];
		this._lastSampleT = 0;
		this._lastVideoTime = -1;
		this.capturing = true;
		this.onState('capturing', { frames: 0 });
		const step = (t) => {
			if (!this.capturing) return;
			this._raf = requestAnimationFrame(step);
			if (t - this._lastSampleT < 1000 / this.targetFps) return;
			if (video.currentTime === this._lastVideoTime) return;
			this._lastVideoTime = video.currentTime;
			this._lastSampleT = t;
			const result = this._landmarker.detectForVideo(video, performance.now());
			this._frames.push(extractRow(result, this._extractors));
			if (this._frames.length % 12 === 0) {
				this.onState('capturing', { frames: this._frames.length });
			}
			if (this._frames.length >= this.maxSeconds * this.targetFps) {
				// Hard cap — auto-stop into transcription rather than dropping data.
				this.stop().catch(() => {});
			}
		};
		this._raf = requestAnimationFrame(step);
	}

	/** Stop the camera and transcribe what was captured. */
	async stop() {
		if (!this.capturing) return { text: '', frames: 0 };
		this.capturing = false;
		cancelAnimationFrame(this._raf);
		this._stream?.getTracks().forEach((tr) => tr.stop());
		this._stream = null;
		const frames = this._frames;
		this._frames = [];
		this._video = null;
		if (frames.length < this._minFrames) {
			this.onState('idle');
			throw new Error('Not enough signing captured — hold the sign a moment longer.');
		}
		this.onState('transcribing', { frames: frames.length });
		try {
			const res = await fetch(this.apiBase, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ frames }),
			});
			const out = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(out.message || `transcription failed (${res.status})`);
			return {
				text: out.text ?? '',
				raw: out.raw ?? out.text ?? '',
				confidence: out.confidence ?? null,
				cleaned: !!out.cleaned,
				frames: frames.length,
				ms: out.ms,
			};
		} finally {
			this.onState('idle');
		}
	}

	/** Abandon capture without transcribing. */
	cancel() {
		this.capturing = false;
		cancelAnimationFrame(this._raf);
		this._stream?.getTracks().forEach((tr) => tr.stop());
		this._stream = null;
		this._frames = [];
		this._video = null;
		this.onState('idle');
	}
}
