// Zero-latency local commands for /drive.
//
// A handful of things a driver says are control, not conversation: "repeat
// that", "stop talking", "louder", "night mode". Sending those to a model costs
// a round trip and can come back wrong, so the page answers them itself, before
// the network is touched. Everything else falls through to the agent untouched.
//
// The matcher deliberately compares the WHOLE utterance against a phrase set
// rather than searching inside it. "Stop" is a command; "stop at the next
// charger" is a question for the agent, and swallowing it would be worse than
// having no command layer at all.

const PHRASES = [
	['repeat', ['repeat', 'repeat that', 'say that again', 'again', 'what did you say', 'come again', 'one more time']],
	['hush', ['stop', 'stop talking', 'be quiet', 'quiet', 'hush', 'never mind', 'nevermind', 'cancel', 'shut up']],
	['louder', ['louder', 'speak up', 'turn it up', 'volume up', 'i can not hear you', "i can't hear you"]],
	['quieter', ['quieter', 'softer', 'turn it down', 'volume down', 'too loud']],
	['night', ['night mode', 'dark mode', 'go dark', 'dim the screen']],
	['day', ['day mode', 'light mode', 'brighten the screen']],
	['parked', ['i am parked', "i'm parked", 'parked', 'we are parked', 'park mode']],
	['driving', ['i am driving', "i'm driving", 'driving', 'drive mode', 'we are moving']],
];

const LOOKUP = new Map();
for (const [id, phrases] of PHRASES) {
	for (const phrase of phrases) LOOKUP.set(phrase, id);
}

/** Lowercase, strip punctuation and filler, collapse whitespace. */
export function normalize(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9' ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^(hey |ok |okay |please |can you |could you |would you )+/g, '')
		.replace(/( please| now| for me)+$/g, '')
		.trim();
}

/**
 * @param {string} transcript
 * @returns {'repeat'|'hush'|'louder'|'quieter'|'night'|'day'|'parked'|'driving'|null}
 */
export function matchDriveCommand(transcript) {
	const phrase = normalize(transcript);
	if (!phrase || phrase.length > 40) return null;
	return LOOKUP.get(phrase) || null;
}

/**
 * Build the interceptor TalkController calls with every final transcript.
 * Returning true means the utterance was control and the chat round trip is
 * skipped; returning false lets it through to the agent.
 *
 * @param {object} handlers  One function per command id. A handler may be async
 *   and may return a short line to speak back; returning nothing stays silent,
 *   which is right for "stop".
 */
export function createDriveInterceptor(handlers) {
	return async function interceptDriveCommand(transcript) {
		const id = matchDriveCommand(transcript);
		if (!id) return false;
		const fn = handlers[id];
		if (typeof fn !== 'function') return false;
		await fn();
		return true;
	};
}

/** The command vocabulary, for the system prompt and the docs. */
export function commandVocabulary() {
	return PHRASES.map(([id, phrases]) => ({ id, phrases: phrases.slice() }));
}
