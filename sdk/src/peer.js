/**
 * Optional peer dependency loading.
 *
 * `ethers`, `@solana/web3.js` and `viem` are declared as OPTIONAL peer
 * dependencies, so a consumer who only wants the chat panel, the avatar
 * embed or the `.well-known` manifests must be able to import the package
 * with none of them installed. A top-level `import ... from 'ethers'`
 * anywhere in the root entry's module graph breaks that promise: the import
 * is resolved eagerly and the whole package fails to load.
 *
 * Every chain-specific module therefore resolves its peer through the
 * helpers here, at call time, and reports a missing peer as an actionable
 * install instruction rather than a bare module-resolution stack trace.
 */

/**
 * Wrap a peer's module-not-found failure in an actionable error.
 * @param {string} pkg      npm package name
 * @param {string} feature  What the caller was trying to do
 * @param {unknown} err     The original import failure
 * @returns {Error}
 */
function missingPeer(pkg, feature, err) {
	const error = new Error(
		`@three-ws/sdk: ${feature} needs the optional peer dependency "${pkg}". ` +
			`Install it with: npm install ${pkg}`,
	);
	error.cause = err;
	error.code = 'MISSING_PEER_DEPENDENCY';
	error.peer = pkg;
	return error;
}

let _ethers = null;

/**
 * Load `ethers` v6 on demand.
 * @param {string} [feature] What the caller needs ethers for, used in the error.
 * @returns {Promise<typeof import('ethers')>}
 */
export async function loadEthers(feature = 'EVM support') {
	if (_ethers) return _ethers;
	try {
		_ethers = await import('ethers');
	} catch (err) {
		throw missingPeer('ethers', feature, err);
	}
	return _ethers;
}

let _web3 = null;

/**
 * Load `@solana/web3.js` v1 on demand.
 * @param {string} [feature] What the caller needs the library for.
 * @returns {Promise<typeof import('@solana/web3.js')>}
 */
export async function loadSolanaWeb3(feature = 'Solana support') {
	if (_web3) return _web3;
	try {
		_web3 = await import('@solana/web3.js');
	} catch (err) {
		throw missingPeer('@solana/web3.js', feature, err);
	}
	return _web3;
}
