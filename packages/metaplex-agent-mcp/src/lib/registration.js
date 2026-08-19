// EIP-8004 registration documents and Core asset metadata, Genesis-333 style.
//
// The three.ws Genesis 333 established a concrete on-chain shape for a 3D AI
// agent on Solana, and this module reproduces it byte-for-byte:
//
//   Asset metadata URI     data:application/json;base64 of
//                          { name, image, animation_url }
//   Agent Identity URI     data:application/json;base64 of
//                          { type: <eip-8004 registration-v1>, name, description,
//                            image, model: { uri }, active, x402Support,
//                            registrations, supportedTrust }
//
// data: URIs are fully self-contained: nothing to pin, nothing that can rot,
// and the whole identity lives in the transaction. Key ORDER matters for
// byte-exactness, so both builders assemble their objects field by field in
// the Genesis order and only ever append optional fields in that same order.

export const EIP_8004_REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

/** Wrap a JSON document in a data:application/json;base64 URI. */
export function jsonDataUri(doc) {
	return `data:application/json;base64,${b64(doc)}`;
}

/**
 * The Core asset's token-metadata document, Genesis order:
 * name, image, animation_url, then optional description / external_url /
 * attributes for callers that want more than the Genesis minimum.
 */
export function buildAssetMetadata({ name, image, animationUrl, description, externalUrl, attributes } = {}) {
	if (!name) throw Object.assign(new Error('asset metadata requires a name'), { code: 'validation_error' });
	const doc = { name };
	if (image) doc.image = image;
	if (animationUrl) doc.animation_url = animationUrl;
	if (description) doc.description = description;
	if (externalUrl) doc.external_url = externalUrl;
	if (Array.isArray(attributes) && attributes.length) {
		doc.attributes = attributes.map((a) => ({ trait_type: String(a.key ?? a.trait_type), value: String(a.value) }));
	}
	return doc;
}

/**
 * The EIP-8004 registration-v1 document, Genesis order:
 * type, name, description, image, model, services, active, x402Support,
 * registrations, supportedTrust.
 *
 * `registrations` entries are `{ agentId, agentRegistry }`. The Genesis mints
 * point back at their home registry (`https://three.ws`); a standalone agent
 * conventionally points at the chain registry (`solana:101:metaplex`).
 */
export function buildRegistrationDoc({
	name,
	description,
	image,
	modelUrl,
	services,
	active = true,
	x402Support = false,
	registrations = [],
	supportedTrust = ['reputation'],
} = {}) {
	if (!name) throw Object.assign(new Error('registration requires a name'), { code: 'validation_error' });
	const doc = { type: EIP_8004_REGISTRATION_TYPE, name, description: description || '' };
	if (image) doc.image = image;
	if (modelUrl) doc.model = { uri: modelUrl };
	if (Array.isArray(services) && services.length) {
		doc.services = services.map((s) => ({ name: String(s.name), endpoint: String(s.endpoint) }));
	}
	doc.active = active !== false;
	doc.x402Support = Boolean(x402Support);
	if (Array.isArray(registrations) && registrations.length) {
		doc.registrations = registrations.map((r) => ({
			agentId: String(r.agentId ?? r.agent_id),
			agentRegistry: String(r.agentRegistry ?? r.agent_registry),
		}));
	}
	doc.supportedTrust = Array.isArray(supportedTrust) && supportedTrust.length ? supportedTrust.map(String) : ['reputation'];
	return doc;
}

/**
 * Default `registrations` for an agent that has no home registry: the chain
 * registry itself, keyed by the asset address (Metaplex docs convention).
 */
export function chainRegistration(assetPubkey, network) {
	return { agentId: String(assetPubkey), agentRegistry: `solana:${network === 'devnet' ? 103 : 101}:metaplex` };
}

/** The Genesis-exact registration entry for a three.ws-hosted agent. */
export function threeWsRegistration(agentId) {
	return { agentId: String(agentId), agentRegistry: 'https://three.ws' };
}

/**
 * Resolve a registration or metadata URI to its JSON document.
 * data: URIs decode locally; http(s) URIs are fetched with a timeout.
 */
export async function decodeJsonUri(uri, { timeoutMs = 30000 } = {}) {
	if (typeof uri !== 'string' || !uri) return null;
	if (uri.startsWith('data:')) {
		const comma = uri.indexOf(',');
		if (comma < 0) return null;
		const meta = uri.slice(5, comma);
		const payload = uri.slice(comma + 1);
		try {
			const raw = meta.includes('base64')
				? Buffer.from(payload, 'base64').toString('utf8')
				: decodeURIComponent(payload);
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (uri.startsWith('https://') || uri.startsWith('http://')) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(uri, { signal: ctrl.signal, headers: { accept: 'application/json' } });
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}
