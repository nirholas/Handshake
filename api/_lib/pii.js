// Lightweight PII redaction for chat transcripts. Runs at write time so
// stored content is already scrubbed — the creator can review what visitors
// asked without ever holding raw email/phone/card data.
//
// This is the regex pass Presidio runs in its Analyzer; we skip the NER half
// because the transcripts dashboard doesn't need names/locations redacted
// (those frequently aren't sensitive) and NER would push a 200MB ML model
// onto the request path.

const PATTERNS = [
	{ token: '[email]', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
	{ token: '[card]', re: /\b(?:\d[ -]?){13,19}\b/g },
	{ token: '[ssn]', re: /\b\d{3}-\d{2}-\d{4}\b/g },
	{ token: '[phone]', re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g },
	{ token: '[key]', re: /\b(?:sk|pk|rk|api)[_-][A-Za-z0-9_-]{12,}\b/g },
];

export function redactPii(text) {
	let out = String(text ?? '');
	let redacted = false;
	for (const { token, re } of PATTERNS) {
		if (re.test(out)) {
			redacted = true;
			out = out.replace(re, token);
		}
	}
	return { content: out, redacted };
}
