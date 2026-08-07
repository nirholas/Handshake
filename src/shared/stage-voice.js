// Living Stages — the host's voice, shared by every surface that renders a show.
//
// A StageRoom beat arrives as a timed `utterance` broadcast: { id, text, voice,
// cue, durationMs }. Turning that into a performance is the same job everywhere
// it happens — fetch /api/tts/speak for the words, route the audio through the
// host avatar's PositionalAudio (so it gets louder as you walk toward the stage),
// tap an AnalyserNode off it to drive lip-sync on whatever the rig supports, and
// stop cleanly when the next beat pre-empts this one.
//
// The /stage page (src/stage.js) and the in-world plaza stage
// (src/game/plaza-stage-show.js) both use this, so the two surfaces speak with
// one implementation: a fix to the audio path lands on both at once, and neither
// can drift into rendering a different show from the same broadcast.
//
// Audio is best-effort by design. Captions carry the words, so a TTS failure, a
// blocked autoplay, or a rig with no mouth degrades the performance, never
// breaks it.

import { AudioAnalyser } from 'three';
import { LipsyncDriver } from '../voice/lipsync-driver.js';
import { apiFetch } from '../api.js';

const TTS_URL = '/api/tts/speak';

export class StageVoice {
	/**
	 * @param {object} opts
	 * @param {() => (import('three').PositionalAudio|null)} [opts.getPositionalAudio]
	 *        The host's spatial audio node, once its avatar has mounted. Called per
	 *        utterance so a late-loading avatar still gets spatial voice.
	 * @param {() => (object|null)} [opts.getMouthTarget]  the rig's MouthTarget.
	 * @param {() => void} [opts.onAutoplayBlocked]  browser gated playback on a gesture.
	 * @param {(speaking:boolean) => void} [opts.onSpeaking]  playback started/ended.
	 * @param {number} [opts.gain]  lip-sync open-shape multiplier.
	 */
	constructor({ getPositionalAudio, getMouthTarget, onAutoplayBlocked, onSpeaking, gain = 1.5 } = {}) {
		this.getPositionalAudio = getPositionalAudio || (() => null);
		this.getMouthTarget = getMouthTarget || (() => null);
		this.onAutoplayBlocked = onAutoplayBlocked || (() => {});
		this.onSpeaking = onSpeaking || (() => {});
		this.gain = gain;
		this.muted = false;
		this.audio = null;
		this.lipsync = null;
		this._url = null;
		this._destroyed = false;
	}

	setMuted(muted) {
		this.muted = !!muted;
		if (this.muted) this.stop();
	}

	/** Speak one beat. Resolves once playback has started (or been given up on). */
	async speak(text, voice) {
		if (this._destroyed || this.muted || !text) return;
		this.stop();

		let buf;
		try {
			const res = await apiFetch(TTS_URL, {
				method: 'POST',
				allowAnonymous: true,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, voice: voice || 'nova', format: 'mp3' }),
			});
			if (!res.ok) throw new Error(`tts ${res.status}`);
			buf = await res.arrayBuffer();
		} catch {
			return; // captions already carry the words; audio is best-effort
		}
		if (this._destroyed || this.muted) return;

		const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
		const audio = new Audio();
		audio.src = url;
		audio.crossOrigin = 'anonymous';
		this.audio = audio;
		this._url = url;
		audio.addEventListener('ended', () => {
			this._release(url);
			this.stopLipsync();
			this.onSpeaking(false);
		}, { once: true });

		// Spatial + lip-sync when the host avatar is mounted; plain playback while
		// it is still streaming in (or on a device with no 3D at all).
		const analyser = this._attachSpatial(audio);
		if (analyser) this.startLipsync(analyser);

		try {
			await audio.play();
			this.onSpeaking(true);
		} catch {
			this.onAutoplayBlocked();
		}
	}

	/** Retry playback of the current line after the user's first gesture. */
	resume() {
		if (!this.audio || this.muted) return;
		this.audio.play().then(() => this.onSpeaking(true)).catch(() => {});
	}

	_attachSpatial(audioEl) {
		const positional = this.getPositionalAudio();
		if (!positional) return null;
		try {
			const ctx = positional.context;
			if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
			// A MediaElementSource can be created once per element; this element is
			// fresh per utterance, so this is safe.
			positional.setMediaElementSource(audioEl);
			return new AudioAnalyser(positional, 256).analyser;
		} catch {
			return null; // fall through to plain playback
		}
	}

	startLipsync(analyser) {
		this.stopLipsync();
		const target = this.getMouthTarget();
		if (!target) return;
		try {
			this.lipsync = new LipsyncDriver({ analyser, target, gain: this.gain });
			this.lipsync.start();
		} catch { /* lip-sync is enhancement, never required */ }
	}

	stopLipsync() {
		if (!this.lipsync) return;
		try { this.lipsync.stop(); } catch {}
		this.lipsync = null;
		try { this.getMouthTarget()?.setMouthShape({ open: 0, wide: 0, round: 0 }); } catch {}
	}

	stop() {
		if (this.audio) {
			try { this.audio.pause(); } catch {}
			this.audio = null;
			this.onSpeaking(false);
		}
		this._release(this._url);
		this.stopLipsync();
	}

	_release(url) {
		if (!url) return;
		try { URL.revokeObjectURL(url); } catch {}
		if (this._url === url) this._url = null;
	}

	dispose() {
		this._destroyed = true;
		this.stop();
	}
}

/**
 * Maps lip-sync {open,wide,round} onto whatever the GLB rig supports: morph
 * targets (visemes / mouthOpen / jawOpen) when present, else a jaw bone, else a
 * subtle head scale — so lip-sync is real where the rig allows and degrades
 * gracefully where it doesn't (no T-pose, never a hard failure).
 */
export class MouthTarget {
	constructor(model) {
		this.influences = [];
		this.jaw = null;
		this.head = findHead(model);
		const openNames = /(mouthopen|jawopen|viseme_aa|viseme_o|vrc\.v_aa|mouth_open|aa)/i;
		model.traverse((o) => {
			if (o.isMesh && o.morphTargetDictionary) {
				for (const [name, idx] of Object.entries(o.morphTargetDictionary)) {
					if (openNames.test(name)) this.influences.push({ mesh: o, idx });
				}
			}
			if (o.isBone && /jaw/i.test(o.name) && !this.jaw) this.jaw = o;
		});
	}

	setMouthShape({ open }) {
		const v = Math.max(0, Math.min(1, open));
		if (this.influences.length) {
			for (const { mesh, idx } of this.influences) mesh.morphTargetInfluences[idx] = v;
		} else if (this.jaw) {
			this.jaw.rotation.x = v * 0.35;
		} else if (this.head) {
			this.head.scale.y = 1 + v * 0.03;
		}
	}

	dispose() {
		for (const { mesh, idx } of this.influences) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[idx] = 0;
		if (this.jaw) this.jaw.rotation.x = 0;
		if (this.head) this.head.scale.y = 1;
	}
}

/** The rig's head bone, when it has one (the spatial audio + mouth anchor). */
export function findHead(model) {
	let head = null;
	model.traverse((o) => { if (!head && o.isBone && /head/i.test(o.name)) head = o; });
	return head;
}

/** Geometry height of a loaded model, for normalizing an avatar to human scale. */
export function modelHeight(model) {
	let minY = Infinity;
	let maxY = -Infinity;
	model.traverse((o) => {
		if (o.isMesh && o.geometry) {
			o.geometry.computeBoundingBox?.();
			const b = o.geometry.boundingBox;
			if (b) { minY = Math.min(minY, b.min.y); maxY = Math.max(maxY, b.max.y); }
		}
	});
	const h = maxY - minY;
	return Number.isFinite(h) && h > 0 ? h : 0;
}
