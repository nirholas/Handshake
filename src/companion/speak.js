// Speaking a delivery out loud on the companion page.
//
// The platform TTS lanes (POST /api/tts/speak) are the voice: real synthesis in
// the voice the user picked for that contact, same catalog as Voice Lab. When
// no lane can serve (every provider over quota, or a browser that will not play
// the returned container), the browser's own speech synthesis finishes the job
// rather than leaving a silent button. Audio only ever starts from a click, so
// nothing here can autoplay at somebody.

const FALLBACK_VOICE = 'alloy';

let current = null;

export function stopSpeaking() {
	if (current?.audio) {
		current.audio.pause();
		current.audio.src = '';
	}
	if (current?.controller) current.controller.abort();
	if (current?.url) URL.revokeObjectURL(current.url);
	current = null;
	try {
		window.speechSynthesis?.cancel();
	} catch {
		/* no speech synthesis in this browser */
	}
}

function speakWithBrowser(text) {
	try {
		if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.rate = 1.02;
		window.speechSynthesis.cancel();
		window.speechSynthesis.speak(utterance);
		return true;
	} catch {
		return false;
	}
}

/**
 * Say one line. Returns 'tts' | 'browser' | 'silent' so the caller can tell the
 * user what actually happened instead of pretending it spoke.
 */
export async function speak(text, { voice = FALLBACK_VOICE } = {}) {
	const line = String(text || '').trim();
	if (!line) return 'silent';
	stopSpeaking();

	const controller = new AbortController();
	current = { controller, audio: null, url: null };

	try {
		const res = await fetch('/api/tts/speak', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ text: line, voice, format: 'mp3' }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`tts ${res.status}`);
		const blob = await res.blob();
		if (!blob || blob.size === 0) throw new Error('empty clip');

		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		current = { controller: null, audio, url };
		audio.onended = () => stopSpeaking();
		audio.onerror = () => stopSpeaking();
		await audio.play();
		return 'tts';
	} catch (err) {
		stopSpeaking();
		if (err?.name === 'AbortError') return 'silent';
		return speakWithBrowser(line) ? 'browser' : 'silent';
	}
}
