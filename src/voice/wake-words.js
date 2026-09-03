/**
 * The wake-word catalog: names, files and the honest note on each.
 *
 * Deliberately its own module, and deliberately tiny. The panel needs this list
 * to render its picker on a page where nothing about listening has been turned
 * on, and importing it from wake-word.js would drag the detector (and its path
 * to onnxruntime) into the cold-load graph. Keeping the catalog separate is what
 * makes "nothing about wake-word detection loads before you opt in" true rather
 * than nearly true.
 */

/**
 * Every entry is a pre-trained model from openWakeWord v0.5.1 (Apache-2.0,
 * https://github.com/dscripka/openWakeWord), committed under
 * /public/models/voice/wake-word. We offer a choice among phrases that already
 * exist rather than training one of our own: a custom phrase trained on
 * synthetic speech would be measurably worse than these, and the user would pay
 * for it in false wakes on an always-on microphone.
 */
export const WAKE_WORDS = [
	{
		id: 'hey_jarvis',
		file: 'hey_jarvis_v0.1.onnx',
		phrase: 'Hey Jarvis',
		hint: 'Two syllables and an uncommon name, so it survives a noisy kitchen best.',
	},
	{
		id: 'hey_mycroft',
		file: 'hey_mycroft_v0.1.onnx',
		phrase: 'Hey Mycroft',
		hint: 'The Mycroft project phrase. Rare enough in conversation to seldom misfire.',
	},
	{
		id: 'alexa',
		file: 'alexa_v0.1.onnx',
		phrase: 'Alexa',
		hint: 'Pick this only if no Echo is in earshot: it will wake both.',
	},
	{
		id: 'hey_rhasspy',
		file: 'hey_rhasspy_v0.1.onnx',
		phrase: 'Hey Rhasspy',
		hint: 'The Rhasspy phrase, and the smallest model of the four.',
	},
];

export const DEFAULT_WAKE_WORD = 'hey_jarvis';

/** Resolve an id, falling back to the default rather than returning nothing. */
export function wakeWordById(id) {
	return WAKE_WORDS.find((w) => w.id === id) || WAKE_WORDS.find((w) => w.id === DEFAULT_WAKE_WORD);
}
