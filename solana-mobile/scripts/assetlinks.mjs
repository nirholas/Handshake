// Build the Digital Asset Links statement list for the three.ws TWA.
//
// Why this is not a one-liner inside build-apk.sh: the same app is distributed
// through more than one channel, and each channel can sign it with a DIFFERENT
// certificate.
//
//   Solana dApp Store + direct download -> signed with our own release key
//                                          (solana-mobile/android.keystore).
//   Google Play                         -> Play App Signing is mandatory for
//                                          new apps, so Google re-signs the
//                                          upload with ITS key. The installed
//                                          app then presents Google's
//                                          certificate, not ours.
//
// Digital Asset Links verifies the certificate of the app that is actually
// installed. A statement file carrying only our key means every Play install
// fails verification and opens three.ws with the Chrome address bar visible
// instead of full screen, while the dApp Store build stays correct. That is a
// channel-specific failure nobody sees in local QA.
//
// So the file has to list every certificate the app can legitimately be signed
// with. The extra ones are declared in twa/extra-fingerprints.json, checked
// into git and reviewed there, rather than merged out of whatever the last run
// happened to leave on disk. Merging from disk is how the orphaned key from
// the lost 2026-08-10 keystore survived a rotation it was supposed to die in.

const HEX_PAIR = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

/** Normalize a keytool/Play Console fingerprint to upper-case colon-separated hex. */
export function normalizeFingerprint(raw) {
	const cleaned = String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase();
	if (!cleaned) return null;
	const hex = cleaned.replace(/:/g, '');
	if (!/^[0-9A-F]{64}$/.test(hex)) return null;
	return hex.match(/.{2}/g).join(':');
}

/**
 * @param {{ packageId: string, fingerprints: string[] }} input
 * @returns {Array<object>} the assetlinks.json statement list
 */
export function buildAssetLinks({ packageId, fingerprints }) {
	if (!packageId) throw new Error('packageId is required');

	const seen = new Set();
	const normalized = [];
	for (const raw of fingerprints ?? []) {
		const fp = normalizeFingerprint(raw);
		if (!fp) throw new Error(`not a SHA-256 certificate fingerprint: ${JSON.stringify(raw)}`);
		if (seen.has(fp)) continue;
		seen.add(fp);
		normalized.push(fp);
	}
	if (!normalized.length) throw new Error('at least one certificate fingerprint is required');
	if (!normalized.every((fp) => HEX_PAIR.test(fp))) throw new Error('fingerprint normalization failed');

	return [
		{
			relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.use_as_origin'],
			target: {
				namespace: 'android_app',
				package_name: packageId,
				sha256_cert_fingerprints: normalized,
			},
		},
	];
}

/** Read the checked-in extra certificates (Play App Signing and any future channel). */
export function extraFingerprintsFrom(config) {
	if (!config) return [];
	const list = Array.isArray(config) ? config : config.fingerprints;
	if (!Array.isArray(list)) return [];
	return list
		.map((e) => (typeof e === 'string' ? e : e?.sha256))
		.filter((v) => typeof v === 'string' && v.trim().length > 0);
}

// --- CLI ---------------------------------------------------------------------
// node scripts/assetlinks.mjs --package ws.three.app --fingerprint <SHA256> \
//   [--extra <file>] [--out <path>]
// Prints the statement list to stdout, or writes it to --out.

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
	const { dirname, resolve } = await import('node:path');

	const argv = process.argv.slice(2);
	const flag = (name) => {
		const i = argv.indexOf(`--${name}`);
		return i === -1 ? undefined : argv[i + 1];
	};

	const here = dirname(new URL(import.meta.url).pathname);
	const extraFile = resolve(flag('extra') ?? `${here}/../twa/extra-fingerprints.json`);
	const packageId = flag('package') ?? JSON.parse(readFileSync(resolve(`${here}/../twa/twa-manifest.json`), 'utf8')).packageId;

	let extraConfig = null;
	try {
		extraConfig = JSON.parse(readFileSync(extraFile, 'utf8'));
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
	}
	const extras = extraFingerprintsFrom(extraConfig);

	const links = buildAssetLinks({ packageId, fingerprints: [flag('fingerprint'), ...extras].filter(Boolean) });
	const body = JSON.stringify(links, null, 2) + '\n';

	const out = flag('out');
	if (out) {
		mkdirSync(dirname(resolve(out)), { recursive: true });
		writeFileSync(resolve(out), body);
		const count = links[0].target.sha256_cert_fingerprints.length;
		process.stderr.write(`[assetlinks] wrote ${out} with ${count} certificate fingerprint(s)\n`);
	} else {
		process.stdout.write(body);
	}
}
