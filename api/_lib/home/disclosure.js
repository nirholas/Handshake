// The sentences a person actually reads before they hand us their house.
//
// A link to a privacy policy is not a disclosure. Nobody opens it, and the one
// moment somebody is genuinely deciding whether to trust us with a key to their
// building is the moment they are looking at the connect button. So the text
// lives here, in front of them, at that moment.
//
// It lives in ONE module because it appears in more than one place: the connect
// screen, the voice opt-in, the privacy screen, and docs/home-privacy.md. Copies
// of a promise drift, and a drifted privacy promise is a false one. Every
// surface imports these strings; none of them retypes them.
//
// Rules these strings are written to:
//   * Say what the token can do, in the worst case, in the user's words. "Full
//     control of your Home Assistant" is not the sentence. "Anyone holding it
//     can unlock your doors" is, because that is the fact that would change
//     someone's mind.
//   * Say what we store and what we do not, concretely. "We take privacy
//     seriously" says nothing. "We never store which lights were on, or when"
//     is checkable, and tests/home-privacy.test.js checks it.
//   * No hedging, no future tense, no "may". Every sentence here is true of the
//     code as it stands or it does not ship.

/**
 * Shown on the connect screen (the "add a home" flow), next to the token field,
 * before the button that sends it.
 */
export const CONNECT_DISCLOSURE = Object.freeze({
	id: 'home.connect',
	heading: 'What this token can do, and what we keep',
	lines: Object.freeze([
		'A Home Assistant long-lived access token is a key to your building. Anyone holding it can turn on your lights and can also unlock your doors, open your garage and disarm your alarm.',
		'We encrypt it before it touches disk and we never show it again, not even to you. Deleting the home erases it.',
		'We store the address of your home, the name you give it, and a count of how many entities and areas it has. We do not store the names of your rooms or devices, and we never store their states: no record of which lights were on, or when.',
		'We keep a log of every action the agent takes in your home, so you can check it. It is yours: you choose how long it lives, ninety days by default, and you can delete it at any time.',
		'The agent asks you first, every time, before anything unlocks, opens or disarms. Locking up and closing never asks.',
	]),
	learnMoreHref: '/docs/home-privacy',
	learnMoreLabel: 'What we store, in full',
});

/**
 * Shown at the voice opt-in, before the microphone is ever enabled.
 *
 * The distinction this has to make is local versus remote, because that is the
 * one thing a person cannot see and the one thing they care about. It states
 * which half happens on their device and which half leaves it, and it does not
 * pretend the remote half does not exist.
 */
export const VOICE_DISCLOSURE = Object.freeze({
	id: 'home.voice',
	heading: 'What happens to your voice',
	lines: Object.freeze([
		'The wake word is detected on this device. Nothing leaves it until you say the wake word or press the button.',
		'After that, the audio of your request is sent to be turned into text, and the text is sent to the agent so it can act. Both happen over an encrypted connection.',
		'We never store the audio. It is discarded as soon as it has been turned into words.',
		'The text of what you said lives in this conversation and goes when the conversation does. It is not added to your home\'s records.',
		'What the agent then does in your home is written to your action log, the same as any other action.',
	]),
	learnMoreHref: '/docs/home-privacy',
	learnMoreLabel: 'What we store, in full',
});

/** Every disclosure, so a surface can render them all and a test can check them all. */
export const DISCLOSURES = Object.freeze([CONNECT_DISCLOSURE, VOICE_DISCLOSURE]);

/**
 * @param {string} id
 * @returns {typeof CONNECT_DISCLOSURE | undefined}
 */
export function disclosureById(id) {
	return DISCLOSURES.find((d) => d.id === id);
}
