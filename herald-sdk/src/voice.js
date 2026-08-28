// Voice: the line, spoken out loud.
//
// Two lanes, in this order:
//   1. A real TTS endpoint (three.ws serves one at /api/tts/speak; point it
//      anywhere that returns audio bytes for `{ text, voice, format }`). This
//      is the good one: a real voice, the same one across every browser.
//   2. The browser's own speechSynthesis, when no endpoint is configured or
//      the endpoint is unreachable. It is robotic and inconsistent across
//      platforms, which is exactly why it is the fallback and not the default.
//
// Autoplay policy is not negotiable and not worth fighting: audio is attempted
// only after a real user gesture has been seen on the page. Before that, and
// whenever playback is refused, the caller still has the text on screen. No
// silent failure, no fake audio, no "click here to enable sound" nag.

/**
 * @param {object} [opts]
 * @param {string|null} [opts.endpoint='/api/tts/speak'] POST target returning audio
 * @param {string} [opts.voice='nova'] voice id passed to the endpoint
 * @param {'endpoint'|'browser'|'auto'} [opts.lane='auto']
 * @param {boolean} [opts.requireGesture=true]
 */
export function createVoice({
	endpoint = '/api/tts/speak',
	voice = 'nova',
	lane = 'auto',
	requireGesture = true,
} = {}) {
	let gestureSeen = !requireGesture;
	let audio = null;
	let controller = null;
	let objectUrl = null;

	if (requireGesture && typeof globalThis.document !== 'undefined') {
		const mark = () => {
			gestureSeen = true;
		};
		globalThis.document.addEventListener('pointerdown', mark, { capture: true, once: true });
		globalThis.document.addEventListener('keydown', mark, { capture: true, once: true });
	}

	function cancel() {
		controller?.abort();
		controller = null;
		if (audio) {
			audio.pause();
			audio.onended = null;
			audio.onerror = null;
			audio.src = '';
			audio = null;
		}
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
		try {
			globalThis.speechSynthesis?.cancel();
		} catch {
			/* no synthesis in this environment */
		}
	}

	async function speakViaEndpoint(text) {
		if (!endpoint || typeof fetch !== 'function') return false;
		controller = new AbortController();
		let blob;
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ text, voice, format: 'mp3' }),
				signal: controller.signal,
			});
			if (!res.ok) return false;
			blob = await res.blob();
		} catch {
			return false;
		}
		if (!blob?.size) return false;
		objectUrl = URL.createObjectURL(blob);
		audio = new Audio(objectUrl);
		try {
			await audio.play();
			return true;
		} catch {
			cancel();
			return false;
		}
	}

	function speakViaBrowser(text) {
		const synth = globalThis.speechSynthesis;
		if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return false;
		try {
			const utterance = new globalThis.SpeechSynthesisUtterance(text);
			utterance.rate = 1.02;
			synth.speak(utterance);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Say it. Resolves true when audio actually started.
	 * @param {string} text
	 */
	async function speak(text) {
		if (!text || !gestureSeen) return false;
		cancel();
		if (lane !== 'browser' && (await speakViaEndpoint(text))) return true;
		if (lane === 'endpoint') return false;
		return speakViaBrowser(text);
	}

	return {
		speak,
		cancel,
		/** True once the page has seen a gesture, so audio is allowed at all. */
		get unlocked() {
			return gestureSeen;
		},
	};
}
