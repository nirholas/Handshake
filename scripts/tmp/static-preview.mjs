// Minimal static host for verifying tutorial pages without vite.
// Other agents restart the shared dev server constantly, which makes a
// browser check against it flaky for reasons unrelated to what is being tested.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.PORT || 4599);
const TYPES = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.webp': 'image/webp',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.glb': 'model/gltf-binary',
	'.md': 'text/markdown',
	'.woff2': 'font/woff2',
};

createServer(async (req, res) => {
	let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (/^\/tutorials\/[a-z0-9-]+\/?$/.test(path)) path = '/__page/tutorial.html';

	const candidates = path.startsWith('/__page/')
		? [resolve(ROOT, 'pages', path.slice('/__page/'.length))]
		: [resolve(ROOT, 'public', path.slice(1)), resolve(ROOT, path.slice(1))];

	for (const file of candidates) {
		if (!file.startsWith(ROOT) || !existsSync(file)) continue;
		try {
			const body = await readFile(file);
			res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
			res.end(body);
			return;
		} catch {
			/* fall through to the next candidate */
		}
	}
	res.writeHead(404, { 'content-type': 'text/plain' });
	res.end('not found');
}).listen(PORT, () => console.log(`static preview on http://localhost:${PORT}`));
