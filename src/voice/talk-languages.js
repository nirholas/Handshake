/**
 * Languages the avatar voice loop can hold a conversation in.
 *
 * One turn crosses three systems, and a language only counts as supported when
 * all three handle it:
 *
 *   1. speech in:    server-side Riva ASR (/api/asr, multilingual model) or the
 *                    browser's own SpeechRecognition
 *   2. the reply:    /api/chat, told which language to answer in
 *   3. speech out:   ElevenLabs (a cloned voice speaks every language below via
 *                    the multilingual model) with Microsoft Edge Neural TTS as
 *                    the fallback when no voice is cloned
 *
 * `asr: true` marks the tags the free server lane transcribes accurately, each
 * verified against real synthesized speech (`node scripts/verify-nvidia-asr.mjs
 * --languages`). The rest still work when the browser's recognizer speaks them,
 * so they stay offerable in Chrome/Edge/Safari rather than being hidden.
 *
 * `edge` is the Microsoft Neural voice used when the avatar has no cloned voice:
 * without it a Mandarin reply comes out of an American English voice reading
 * pinyin-shaped noise. Female/male pairs mirror the avatar's own body type.
 */

export const TALK_LANGUAGES = [
	{ tag: 'en-US', native: 'English (US)', english: 'English (US)', asr: true, edge: { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' } },
	{ tag: 'en-GB', native: 'English (UK)', english: 'English (UK)', asr: true, edge: { female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' } },
	{ tag: 'zh-CN', native: '简体中文', english: 'Chinese (Mandarin)', asr: true, edge: { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' } },
	{ tag: 'zh-TW', native: '繁體中文', english: 'Chinese (Taiwan)', asr: true, edge: { female: 'zh-TW-HsiaoChenNeural', male: 'zh-TW-YunJheNeural' } },
	{ tag: 'ja-JP', native: '日本語', english: 'Japanese', asr: true, edge: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' } },
	{ tag: 'ko-KR', native: '한국어', english: 'Korean', asr: true, edge: { female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' } },
	{ tag: 'es-ES', native: 'Español', english: 'Spanish', asr: true, edge: { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' } },
	{ tag: 'fr-FR', native: 'Français', english: 'French', asr: true, edge: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' } },
	{ tag: 'de-DE', native: 'Deutsch', english: 'German', asr: true, edge: { female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' } },
	{ tag: 'it-IT', native: 'Italiano', english: 'Italian', asr: true, edge: { female: 'it-IT-ElsaNeural', male: 'it-IT-DiegoNeural' } },
	{ tag: 'pt-BR', native: 'Português (BR)', english: 'Portuguese (Brazil)', asr: true, edge: { female: 'pt-BR-FranciscaNeural', male: 'pt-BR-AntonioNeural' } },
	{ tag: 'ru-RU', native: 'Русский', english: 'Russian', asr: true, edge: { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' } },
	{ tag: 'hi-IN', native: 'हिन्दी', english: 'Hindi', asr: true, edge: { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' } },
	{ tag: 'nl-NL', native: 'Nederlands', english: 'Dutch', asr: true, edge: { female: 'nl-NL-ColetteNeural', male: 'nl-NL-MaartenNeural' } },
	{ tag: 'pl-PL', native: 'Polski', english: 'Polish', asr: true, edge: { female: 'pl-PL-ZofiaNeural', male: 'pl-PL-MarekNeural' } },
	{ tag: 'cs-CZ', native: 'Čeština', english: 'Czech', asr: true, edge: { female: 'cs-CZ-VlastaNeural', male: 'cs-CZ-AntoninNeural' } },
	{ tag: 'ar-SA', native: 'العربية', english: 'Arabic', asr: false, edge: { female: 'ar-SA-ZariyahNeural', male: 'ar-SA-HamedNeural' } },
	{ tag: 'tr-TR', native: 'Türkçe', english: 'Turkish', asr: false, edge: { female: 'tr-TR-EmelNeural', male: 'tr-TR-AhmetNeural' } },
	{ tag: 'id-ID', native: 'Bahasa Indonesia', english: 'Indonesian', asr: false, edge: { female: 'id-ID-GadisNeural', male: 'id-ID-ArdiNeural' } },
	{ tag: 'sv-SE', native: 'Svenska', english: 'Swedish', asr: false, edge: { female: 'sv-SE-SofieNeural', male: 'sv-SE-MattiasNeural' } },
	{ tag: 'uk-UA', native: 'Українська', english: 'Ukrainian', asr: false, edge: { female: 'uk-UA-PolinaNeural', male: 'uk-UA-OstapNeural' } },
	{ tag: 'ro-RO', native: 'Română', english: 'Romanian', asr: false, edge: { female: 'ro-RO-AlinaNeural', male: 'ro-RO-EmilNeural' } },
];

export const DEFAULT_TALK_LANGUAGE = 'en-US';

const BY_TAG = new Map(TALK_LANGUAGES.map((l) => [l.tag.toLowerCase(), l]));

/** The language entry for a tag, or null when we do not carry that language. */
export function talkLanguage(tag) {
	const key = String(tag || '').trim().toLowerCase();
	if (!key) return null;
	if (BY_TAG.has(key)) return BY_TAG.get(key);
	// "zh", "zh-Hans-CN", "pt" → the first entry sharing the primary subtag, so a
	// browser locale we do not list exactly still lands on the right language.
	const primary = key.split('-')[0];
	return TALK_LANGUAGES.find((l) => l.tag.toLowerCase().split('-')[0] === primary) || null;
}

/**
 * Normalize any locale-ish input to a tag we support.
 * @returns {string} a supported BCP-47 tag; DEFAULT_TALK_LANGUAGE when unknown.
 */
export function resolveTalkLanguage(tag) {
	return talkLanguage(tag)?.tag || DEFAULT_TALK_LANGUAGE;
}

/**
 * Pick the conversation language for a first visit, in preference order:
 * an explicit stored choice, then the language the site UI is already in, then
 * the browser's own languages. Pure, so the ordering is unit-testable.
 *
 * @param {{ stored?: string, uiLocale?: string, navLangs?: string[] }} input
 */
export function detectTalkLanguage({ stored, uiLocale, navLangs } = {}) {
	const candidates = [stored, uiLocale, ...(navLangs || [])];
	for (const c of candidates) {
		const hit = talkLanguage(c);
		if (hit) return hit.tag;
	}
	return DEFAULT_TALK_LANGUAGE;
}

/**
 * Microsoft Edge Neural voice for a language, matched to the avatar's body type.
 * Falls back to the language's female voice, then to US English.
 */
export function edgeVoiceFor(tag, gender = 'neutral') {
	const entry = talkLanguage(tag) || talkLanguage(DEFAULT_TALK_LANGUAGE);
	const key = gender === 'male' ? 'male' : 'female';
	return entry.edge[key] || entry.edge.female;
}

/**
 * The instruction appended to the agent's system prompt so the reply comes back
 * in the conversation language. English needs no instruction: it is what every
 * agent persona already writes in, and a redundant line only dilutes the prompt.
 */
export function languageInstruction(tag) {
	const entry = talkLanguage(tag);
	if (!entry || entry.tag.startsWith('en')) return '';
	return `Reply only in ${entry.english} (${entry.native}). The user is speaking ${entry.english}; answer naturally in that language, never in English, and never translate your own reply. Keep replies short enough to be spoken aloud.`;
}
