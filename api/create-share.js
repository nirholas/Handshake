// POST /create/share is the Web Share Target declared in the web manifest. In
// normal operation the service worker (public/share-target-sw.js) intercepts
// the POST before it reaches the network, parks the shared files in the Cache
// API, and redirects into the right creation flow. This handler only answers
// when the worker is not there yet: the very first share after install, or a
// browser with the worker evicted. A multipart body cannot be handed back to
// the page from here without storing it, so the honest answer is a redirect
// with a reason the /create page explains ("share it again"), never a 404 page
// or an upload that silently vanishes.

import { wrap } from './_lib/http.js';

export default wrap(async (req, res) => {
	// Read and discard the body so the connection closes cleanly; the files
	// are never stored.
	await new Promise((resolve) => {
		req.on('data', () => {});
		req.on('end', resolve);
		req.on('error', resolve);
		if (req.readableEnded || req.complete) resolve();
	});
	const target = req.method === 'POST' ? '/create?shared=nosw' : '/create';
	res.statusCode = 303;
	res.setHeader('Location', target);
	res.setHeader('Cache-Control', 'no-store');
	res.end();
});
