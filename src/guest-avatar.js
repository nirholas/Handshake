/**
 * Guest avatar store — persists an in-progress avatar locally so users can
 * finish the create flow without signing in first. The flow is:
 *
 *   1. /create produces a GLB Blob from the default editor / Studio / file upload.
 *   2. We stage(blob, meta) into IndexedDB before navigating to /create-review.
 *   3. /create-review reads it back, renders it, and on "Save" either uploads
 *      immediately (signed-in user) or sends the user through /login?next=/create-review
 *      and the page picks up where it left off after auth.
 *
 * Blobs go in IndexedDB (multi-MB GLBs would blow the localStorage quota).
 * A short JSON metadata pointer lives in localStorage so we can detect a
 * pending guest avatar even before the IDB connection opens — useful for the
 * /login post-auth check.
 */

const DB_NAME = 'three-ws-guest';
const STORE = 'avatars';
const KEY = 'pending';
const META_KEY = '3dagent:guest-avatar-meta';

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('indexeddb open failed'));
	});
}

async function tx(mode, fn) {
	const db = await openDb();
	try {
		return await new Promise((resolve, reject) => {
			const t = db.transaction(STORE, mode);
			const store = t.objectStore(STORE);
			let result;
			Promise.resolve(fn(store))
				.then((r) => {
					result = r;
				})
				.catch(reject);
			t.oncomplete = () => resolve(result);
			t.onerror = () => reject(t.error || new Error('idb transaction failed'));
			t.onabort = () => reject(t.error || new Error('idb transaction aborted'));
		});
	} finally {
		db.close();
	}
}

/**
 * Stage a GLB Blob with provenance metadata. Replaces any previously staged
 * avatar — the user can only have one pending guest avatar at a time.
 *
 * @param {Blob} blob - The GLB binary.
 * @param {{
 *   source?: 'avaturn' | 'import' | 'upload' | 'three-ws-studio' | 'three-ws-selfie' | string,
 *   source_meta?: Record<string, unknown>,
 *   name?: string,
 *   provider?: string,
 *   sourceUrl?: string | null,
 * }} [meta]
 * @returns {Promise<{ id: string, size: number, createdAt: number }>}
 */
export async function stage(blob, meta = {}) {
	if (!(blob instanceof Blob)) throw new TypeError('stage() requires a Blob');
	const id = cryptoRandomId();
	const size = blob.size;
	const createdAt = Date.now();
	const name = meta.name || `Avatar #${id.slice(0, 6)}`;

	await tx('readwrite', (store) =>
		new Promise((resolve, reject) => {
			const req = store.put({ blob, meta, id, name, size, createdAt }, KEY);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error || new Error('idb put failed'));
		}),
	);

	const pointer = { id, name, size, createdAt, source: meta.source || meta.provider || 'unknown' };
	try {
		localStorage.setItem(META_KEY, JSON.stringify(pointer));
	} catch {
		// quota or storage disabled — IDB is the source of truth, pointer is best-effort
	}

	return { id, size, createdAt };
}

/**
 * Returns the staged avatar's metadata pointer, or null if nothing is staged.
 * Cheap synchronous-ish check (reads localStorage; doesn't open IDB).
 */
export function peek() {
	try {
		const raw = localStorage.getItem(META_KEY);
		if (!raw) return null;
		const pointer = JSON.parse(raw);
		if (!pointer || typeof pointer !== 'object') return null;
		return pointer;
	} catch {
		return null;
	}
}

/**
 * Returns the full staged record (blob + meta) or null if nothing is staged.
 * @returns {Promise<{ blob: Blob, meta: object, id: string, name: string, size: number, createdAt: number } | null>}
 */
export async function load() {
	try {
		return await tx('readonly', (store) =>
			new Promise((resolve, reject) => {
				const req = store.get(KEY);
				req.onsuccess = () => resolve(req.result || null);
				req.onerror = () => reject(req.error || new Error('idb get failed'));
			}),
		);
	} catch (err) {
		console.warn('[guest-avatar] load failed:', err);
		return null;
	}
}

/**
 * Drop the staged avatar after a successful save or an explicit "start over".
 */
export async function clear() {
	try {
		localStorage.removeItem(META_KEY);
	} catch {
		/* ignore */
	}
	try {
		await tx('readwrite', (store) =>
			new Promise((resolve, reject) => {
				const req = store.delete(KEY);
				req.onsuccess = () => resolve();
				req.onerror = () => reject(req.error || new Error('idb delete failed'));
			}),
		);
	} catch (err) {
		console.warn('[guest-avatar] clear failed:', err);
	}
}

function cryptoRandomId() {
	const bytes = new Uint8Array(8);
	(globalThis.crypto || window.crypto).getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
