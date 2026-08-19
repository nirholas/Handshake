/**
 * Skill slug to display label.
 *
 * Skills travel as machine slugs (`nft-lookup`, `deep_diligence_card`) because
 * that is what the agent record, the pricing map and the x402 call path all key
 * on. Every surface that shows one to a person needs the same readable form, so
 * it lives here once instead of being re-derived per page with slightly
 * different rules (the studio's capability list, the dashboard's transaction
 * table and its revenue breakdown were three separate answers).
 *
 * Acronyms are the reason a naive title-case is not enough: "nft-lookup" reads
 * as "Nft Lookup", which looks like a typo. Words in `ACRONYMS` are uppercased
 * whole; a token that is already mixed case (a brand like "watsonx") is left
 * exactly as its author wrote it.
 */

// Uppercased whole when a slug token matches one, case-insensitively.
const ACRONYMS = new Set([
	'2d', '3d', 'ai', 'api', 'ar', 'cli', 'css', 'dao', 'dex', 'dm', 'eth', 'evm',
	'faq', 'glb', 'gltf', 'html', 'http', 'id', 'ip', 'json', 'kyc', 'llm', 'mcp',
	'nft', 'ocr', 'pdf', 'pnl', 'rag', 'rpc', 'sdk', 'seo', 'sol', 'sql', 'ssr',
	'svg', 'tts', 'ui', 'url', 'usd', 'usdc', 'ux', 'vr', 'x402', 'xr', 'yaml',
]);

/**
 * @param {unknown} slug  a skill slug, e.g. "nft-lookup"
 * @param {string} [fallback]  returned for an empty/absent slug
 * @returns {string} e.g. "NFT Lookup"
 */
export function skillLabel(slug, fallback = 'Skill') {
	const raw = String(slug ?? '').trim();
	if (!raw) return fallback;
	return raw
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => {
			if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
			// An author who wrote "watsonx" or "iOS" meant it; only plain
			// lowercase and plain uppercase tokens get re-cased.
			if (word !== word.toLowerCase() && word !== word.toUpperCase()) return word;
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		})
		.join(' ');
}
