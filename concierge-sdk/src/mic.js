/**
 * Voice input — @three-ws/concierge
 * =================================
 *
 * Thin wrapper over the Web Speech API's SpeechRecognition (webkit-prefixed on
 * Chromium). Push-to-talk: start() listens for one utterance, streams interim
 * transcripts for live feedback, and resolves the final transcript. Degrades
 * to `supported: false` where the API is absent (Firefox, most webviews) so
 * the widget can hide the mic button instead of showing a dead control.
 */

function RecognitionCtor() {
	if (typeof window === 'undefined') return null;
	return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function micSupported() {
	return !!RecognitionCtor();
}

/**
 * @param {{ lang?: string,
 *          onInterim?: (transcript:string)=>void,
 *          onState?: (s:'listening'|'idle')=>void,
 *          onError?: (e:Error)=>void }} [opts]
 */
export function createMic(opts = {}) {
	const Ctor = RecognitionCtor();
	let rec = null;
	let finalText = '';
	let resolveDone = null;

	function stopInternal() {
		if (!rec) return;
		try {
			rec.stop();
		} catch {
			/* already stopped */
		}
	}

	return {
		supported: !!Ctor,
		get listening() {
			return !!rec;
		},

		/** Listen for one utterance; resolves the final transcript ('' on abort). */
		start() {
			if (!Ctor || rec) return Promise.resolve('');
			finalText = '';
			rec = new Ctor();
			rec.lang = opts.lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
			rec.interimResults = true;
			rec.continuous = false;
			rec.maxAlternatives = 1;

			opts.onState?.('listening');
			return new Promise((resolve) => {
				resolveDone = resolve;
				rec.onresult = (e) => {
					let interim = '';
					for (let i = e.resultIndex; i < e.results.length; i++) {
						const r = e.results[i];
						if (r.isFinal) finalText += r[0].transcript;
						else interim += r[0].transcript;
					}
					opts.onInterim?.(finalText + interim);
				};
				rec.onerror = (e) => {
					// 'no-speech'/'aborted' are normal outcomes of a quiet mic, not faults.
					if (e?.error && !/no-speech|aborted/i.test(e.error)) {
						opts.onError?.(new Error('speech-recognition: ' + e.error));
					}
				};
				rec.onend = () => {
					rec = null;
					opts.onState?.('idle');
					const out = finalText.trim();
					resolveDone?.(out);
					resolveDone = null;
				};
				try {
					rec.start();
				} catch (err) {
					rec = null;
					opts.onState?.('idle');
					opts.onError?.(err instanceof Error ? err : new Error(String(err)));
					resolve('');
					resolveDone = null;
				}
			});
		},

		/** Stop listening; the in-flight start() promise resolves with what was heard. */
		stop() {
			stopInternal();
		},

		dispose() {
			stopInternal();
			rec = null;
		},
	};
}
