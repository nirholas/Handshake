// Filename helpers. Pure: no vscode, no fs, so they are unit tested directly.

const MAX_SLUG = 48;

/**
 * Turn a prompt into a short, safe, readable file stem.
 * "A friendly round robot mascot, glossy white" -> "a-friendly-round-robot-mascot-glossy-white"
 */
export function slugFromPrompt(prompt, fallback = 'model') {
	const slug = String(prompt || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG)
		.replace(/-+$/g, '');
	return slug || fallback;
}

/** The stem of a URL's last path segment, slugified. */
export function slugFromUrl(url, fallback = 'model') {
	try {
		const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
		return slugFromPrompt(last.replace(/\.(glb|gltf)$/i, ''), fallback);
	} catch {
		return fallback;
	}
}

/**
 * First name in `<stem>.glb`, `<stem>-2.glb`, `<stem>-3.glb`… that `taken` does
 * not already hold. Keeps generated models from silently overwriting each other.
 *
 * @param {string} stem
 * @param {string} ext including the dot, e.g. ".glb"
 * @param {(name: string) => boolean} taken
 */
export function uniqueName(stem, ext, taken) {
	const base = `${stem}${ext}`;
	if (!taken(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!taken(candidate)) return candidate;
	}
	return `${stem}-${Date.now()}${ext}`;
}

/** Human file size, matching how the viewer reports it. */
export function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
