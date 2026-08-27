// Resilient loader for third-party browser modules and scripts.
//
// Every lazy CDN import on the platform used to be a single `import(url)` on
// one host. When that host was slow, blocked by a corporate proxy, or having an
// outage, the caller hung forever or died with the opaque "Failed to fetch
// dynamically imported module" and the surface went blank. This module gives
// every such site the same three things: an ordered mirror list (the same
// package version on esm.sh, jsdelivr and unpkg), a deadline per attempt, and a
// typed error that names every host it tried so the UI can say something true.
//
// Served raw at /load-module.js so plain public/ scripts (the launch studio,
// the paywall core, the merchant console) can import it by URL; bundled code
// reaches the same file through src/shared/load-module.js.

const DEFAULT_TIMEOUT_MS = 15_000;
const MODULE_UNAVAILABLE = 'module_unavailable';

// Parses an esm.sh / jsdelivr / unpkg module URL into { pkg, version, subpath }.
// Returns null for anything else (a self-hosted path, an unknown CDN), in
// which case the URL is loaded as-is with no mirrors.
export function parseCdnModuleUrl(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	let path = u.pathname;
	let host;
	if (u.hostname === 'esm.sh') host = 'esm';
	else if (u.hostname === 'cdn.jsdelivr.net' && path.startsWith('/npm/')) {
		host = 'jsdelivr';
		path = path.slice('/npm'.length);
	} else if (u.hostname === 'unpkg.com') host = 'unpkg';
	else return null;
	if (host === 'jsdelivr') path = path.replace(/\/\+esm$/, '');
	// /@scope/name@1.2.3/sub/path  or  /name@1.2.3
	const m = path.match(/^\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)(\/.*)?$/);
	if (!m) return null;
	return { host, pkg: m[1], version: m[2], subpath: m[3] || '', search: u.search };
}

// The same package version on each of the three CDNs, original host first.
export function moduleMirrors(url) {
	const parsed = parseCdnModuleUrl(url);
	if (!parsed) return [url];
	const { pkg, version, subpath, host, search } = parsed;
	const spec = `${pkg}@${version}${subpath}`;
	const byHost = {
		esm: `https://esm.sh/${spec}${host === 'esm' ? search : ''}`,
		jsdelivr: `https://cdn.jsdelivr.net/npm/${spec}/+esm`,
		unpkg: `https://unpkg.com/${spec}?module`,
	};
	const order = [host, ...['esm', 'jsdelivr', 'unpkg'].filter((h) => h !== host)];
	return order.map((h) => byHost[h]);
}

function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return String(url);
	}
}

function withDeadline(promise, ms, label) {
	if (!(ms > 0)) return promise;
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms loading ${label}`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function unavailableError(hosts, lastErr, what) {
	const err = new Error(
		`${what} could not be loaded from ${hosts.join(', ')}. Check your connection, ad blocker or content security policy, then try again.`,
	);
	err.code = MODULE_UNAVAILABLE;
	err.hosts = hosts;
	err.cause = lastErr;
	return err;
}

const _modules = new Map();

/**
 * Dynamically import the first reachable URL from an ordered list.
 *
 * @param {string|string[]} specifiers  One CDN URL (expanded to its mirrors) or an explicit ordered list.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]   Per-attempt deadline (default 15s).
 * @param {(url: string) => Promise<any>} [opts.importer]  Injectable import() for tests.
 * @returns {Promise<any>}  The module namespace. Rejects with `{ code: 'module_unavailable', hosts }`.
 */
export function loadModule(specifiers, opts = {}) {
	const urls = Array.isArray(specifiers) ? specifiers.slice() : moduleMirrors(specifiers);
	if (!urls.length) return Promise.reject(new Error('loadModule: no URLs given'));
	const key = urls.join('\n');
	if (_modules.has(key)) return _modules.get(key);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const importer = opts.importer || ((url) => import(/* @vite-ignore */ url));
	const attempt = (async () => {
		let lastErr;
		for (const url of urls) {
			try {
				return await withDeadline(importer(url), timeoutMs, url);
			} catch (err) {
				lastErr = err;
			}
		}
		throw unavailableError(urls.map(hostOf), lastErr, urls[0]);
	})();
	_modules.set(key, attempt);
	// A failure is not memoised: the next call (a retry button) tries the chain again.
	attempt.catch(() => _modules.delete(key));
	return attempt;
}

const _scripts = new Map();

function appendScript(url, { type, timeoutMs, globalName }) {
	return new Promise((resolve, reject) => {
		const existing = Array.from(document.scripts).some((el) => el.getAttribute('src') === url);
		if (existing && (!globalName || globalThis[globalName] !== undefined)) {
			resolve();
			return;
		}
		const s = document.createElement('script');
		if (type) s.type = type;
		s.src = url;
		s.crossOrigin = 'anonymous';
		const timer = setTimeout(() => {
			s.remove();
			reject(new Error(`timed out after ${timeoutMs}ms loading ${url}`));
		}, timeoutMs);
		s.onload = () => {
			clearTimeout(timer);
			if (globalName && globalThis[globalName] === undefined) {
				s.remove();
				reject(new Error(`${url} loaded but did not define window.${globalName}`));
				return;
			}
			resolve();
		};
		s.onerror = () => {
			clearTimeout(timer);
			s.remove();
			reject(new Error(`failed to load ${url}`));
		};
		document.head.appendChild(s);
	});
}

/**
 * Append a classic or module <script> from the first reachable mirror.
 *
 * @param {string[]} urls  Ordered mirrors of the same script.
 * @param {object} [opts]
 * @param {string} [opts.globalName]  Resolve only once `window[globalName]` exists.
 * @param {string} [opts.type]        e.g. 'module'.
 * @param {number} [opts.timeoutMs]   Per-mirror deadline (default 15s).
 * @returns {Promise<any>}  `window[globalName]` when given, else undefined.
 */
export function loadScript(urls, opts = {}) {
	const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
	if (!list.length) return Promise.reject(new Error('loadScript: no URLs given'));
	const { globalName, type, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
	if (globalName && globalThis[globalName] !== undefined) return Promise.resolve(globalThis[globalName]);
	const key = list.join('\n');
	if (_scripts.has(key)) return _scripts.get(key);
	const attempt = (async () => {
		let lastErr;
		for (const url of list) {
			try {
				await appendScript(url, { type, timeoutMs, globalName });
				return globalName ? globalThis[globalName] : undefined;
			} catch (err) {
				lastErr = err;
			}
		}
		throw unavailableError(list.map(hostOf), lastErr, list[0]);
	})();
	_scripts.set(key, attempt);
	attempt.catch(() => _scripts.delete(key));
	return attempt;
}

/** True when `err` came from a mirror chain that was exhausted. */
export function isModuleUnavailable(err) {
	return err?.code === MODULE_UNAVAILABLE;
}

export { MODULE_UNAVAILABLE };
