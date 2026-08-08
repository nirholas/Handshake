// Shared catalog of the voices the platform can synthesize.
//
// One source of truth so the renderer (/api/tts/voices) and the validator
// (/api/tts/speak) never drift: a voice that shows up in a picker is always a
// voice speak() will actually render. The ids are the OpenAI-style set; the
// free NVIDIA Magpie lane maps each id to a persona in
// api/_lib/tts-nvidia.js (VOICE_TO_MAGPIE), so the same id renders on either
// provider.

export const DEFAULT_VOICE = 'nova';

export const TTS_VOICES = [
	{ id: 'nova', name: 'Nova', description: 'Bright and energetic, the default companion voice' },
	{ id: 'alloy', name: 'Alloy', description: 'Neutral and balanced' },
	{ id: 'ash', name: 'Ash', description: 'Warm and expressive' },
	{ id: 'ballad', name: 'Ballad', description: 'Soft and lyrical' },
	{ id: 'coral', name: 'Coral', description: 'Friendly and upbeat' },
	{ id: 'echo', name: 'Echo', description: 'Calm and measured' },
	{ id: 'fable', name: 'Fable', description: 'Expressive storyteller' },
	{ id: 'onyx', name: 'Onyx', description: 'Deep and authoritative' },
	{ id: 'sage', name: 'Sage', description: 'Gentle and thoughtful' },
	{ id: 'shimmer', name: 'Shimmer', description: 'Light and airy' },
	{ id: 'verse', name: 'Verse', description: 'Dynamic and conversational' },
];

export const TTS_VOICE_IDS = TTS_VOICES.map((v) => v.id);
