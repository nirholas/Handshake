// Map a user prompt to one of the agent-3d emotion triggers.
// Emotion vocabulary: 'celebration' | 'concern' | 'curiosity' | 'empathy' | 'patience'
//
// Returns { emotion, weight } or null if nothing reads strongly enough.
// Keyword lists are deliberately small and high-precision: false positives
// look worse than no reaction.

const PATTERNS = {
	empathy: [
		/\bi(?:'m| am)?\s+(?:so\s+)?(?:sad|tired|exhausted|burned\s*out|overwhelmed|struggling|lonely|hurt|down)\b/i,
		/\b(?:i feel|feeling)\s+(?:bad|terrible|awful|low|blue|hopeless)\b/i,
		/\b(?:lost\s+my|passed\s+away|breakup|broke\s+up|grief|miss\s+(?:him|her|them))\b/i,
	],
	concern: [
		/\b(?:error|exception|traceback|stack\s*trace|crash(?:ed|ing)?|fail(?:ed|ing|ure)?|broken|bug|stuck|blocked|can'?t|cannot|won'?t\s+work|doesn'?t\s+work|not\s+working)\b/i,
		/\b(?:urgent|asap|emergency|critical|on\s*fire|production\s+down|prod\s+down|outage|p0|p1)\b/i,
		/\b(?:hate|frustrated|angry|annoyed|fed\s+up|worried|scared|afraid)\b/i,
	],
	celebration: [
		/\b(?:thanks?|thank\s+you|thx|ty)\b/i,
		/\b(?:awesome|amazing|incredible|fantastic|brilliant|wonderful|excellent|perfect|love\s+(?:it|this)|great\s+job|nice\s+work|woohoo|hooray|lfg|let'?s\s+go)\b/i,
		/\b(?:congrats|congratulations|shipped|launched|done|finished|works?!|it\s+works?)\b/i,
		/(?:!{2,}|🎉|🥳|🚀|❤️|🙌)/,
	],
	patience: [
		/\b(?:please|kindly|when\s+you\s+(?:can|get\s+a\s+chance)|no\s+rush|take\s+your\s+time|whenever)\b/i,
	],
	curiosity: [
		/\?/,
		/\b(?:how|why|what|when|where|who|which|explain|show\s+me|teach\s+me|tell\s+me|tell\s+about|curious|wonder(?:ing)?)\b/i,
	],
};

const PRIORITY = ['empathy', 'concern', 'celebration', 'patience', 'curiosity'];

export function detectEmotion(text) {
	if (!text || typeof text !== 'string') return null;
	const trimmed = text.trim();
	if (!trimmed) return null;

	const scores = {};
	for (const [emotion, patterns] of Object.entries(PATTERNS)) {
		let hits = 0;
		for (const re of patterns) if (re.test(trimmed)) hits++;
		if (hits > 0) scores[emotion] = hits;
	}

	if (Object.keys(scores).length === 0) return null;

	let pick = null;
	let pickScore = 0;
	for (const emotion of PRIORITY) {
		const s = scores[emotion] || 0;
		if (s > pickScore) {
			pick = emotion;
			pickScore = s;
		}
	}
	if (!pick) return null;

	const weight = Math.min(0.95, 0.55 + pickScore * 0.15);
	return { emotion: pick, weight };
}
