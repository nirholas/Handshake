/**
 * GET /api/gemini-key
 *
 * Returns the Gemini API key for browser-side use.
 * Restricted to requests originating from the same domain (or localhost in dev).
 * The key should be restricted in Google AI Studio to this domain only.
 */
export default function handler(req, res) {
	const origin  = req.headers.origin  || '';
	const referer = req.headers.referer || '';
	const source  = origin || referer;

	const allowed =
		source.includes('three.ws') ||
		source.includes('localhost') ||
		source.includes('127.0.0.1') ||
		source.includes('vercel.app');

	if (!allowed) {
		return res.status(403).json({ error: 'forbidden' });
	}

	const key = process.env.GEMINI_API_KEY;
	if (!key) {
		return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
	}

	res.setHeader('Cache-Control', 'no-store');
	res.json({ key });
}
