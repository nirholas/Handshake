// Shared constants a neighbouring tool fixture imports. Real tool files hoist
// bounds and enum member lists exactly like this, which is why the reader
// follows one level of relative imports.

export const ROYALTY_CAP_BPS = 1000;

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const FORMATS = { mp3: 'audio/mpeg', wav: 'audio/wav' };
