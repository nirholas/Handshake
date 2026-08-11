/**
 * IPFS pinning helper — single entry point for putting bytes on IPFS.
 *
 * Pump.fun's own frontend pins coin images and metadata JSON to IPFS (via
 * Pinata) and points the on-chain `uri` at `https://ipfs.io/ipfs/{cid}`.
 * Matching that flow keeps three.ws launches indistinguishable from native
 * ones to wallets, explorers, and aggregators that fetch the metadata.
 *
 * Provider order mirrors api/pinning/[action].js: Pinata (preferred),
 * web3.storage (fallback). When neither is configured, returns null so callers
 * fall back to R2 HTTPS hosting — a valid metadata URI, just not a CID.
 */

const PINATA_FILE_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const WEB3_STORAGE_ENDPOINT = 'https://api.web3.storage/upload';

/** @returns {string} the public IPFS gateway URL pump.fun uses for a CID. */
export function ipfsGatewayUrl(cid) {
	return `https://ipfs.io/ipfs/${cid}`;
}

// Bounded so a hung provider cannot hold an interactive request (persona save
// pins inline) open until the platform's own request timeout fires.
const PIN_TIMEOUT_MS = 25000;

async function pinViaPinata(buf, filename) {
	const form = new FormData();
	form.append('file', new Blob([buf]), filename);
	const resp = await fetch(PINATA_FILE_ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
		body: form,
		signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`Pinata error ${resp.status}`), { status: 502, detail });
	}
	const data = await resp.json();
	return { cid: data.IpfsHash, provider: 'pinata' };
}

async function pinViaWeb3Storage(buf, filename) {
	const resp = await fetch(WEB3_STORAGE_ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.WEB3_STORAGE_TOKEN}`, 'X-NAME': filename },
		body: buf,
		signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`Web3.Storage error ${resp.status}`), { status: 502, detail });
	}
	const data = await resp.json();
	return { cid: data.cid, provider: 'web3.storage' };
}

/** True when at least one IPFS pinning provider is configured. */
export function ipfsPinningConfigured() {
	return Boolean(process.env.PINATA_JWT || process.env.WEB3_STORAGE_TOKEN);
}

/**
 * Pin a buffer to IPFS via the configured provider.
 *
 * @param {Buffer} buf
 * @param {string} filename
 * @returns {Promise<{cid: string, uri: string, provider: string} | null>}
 *   the pinned CID + gateway URI, or null when no provider is configured.
 */
export async function pinToIPFS(buf, filename) {
	if (process.env.PINATA_JWT) {
		const { cid, provider } = await pinViaPinata(buf, filename);
		return { cid, uri: ipfsGatewayUrl(cid), provider };
	}
	if (process.env.WEB3_STORAGE_TOKEN) {
		const { cid, provider } = await pinViaWeb3Storage(buf, filename);
		return { cid, uri: ipfsGatewayUrl(cid), provider };
	}
	return null;
}
