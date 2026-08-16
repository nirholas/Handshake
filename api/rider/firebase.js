// GET /api/rider/firebase
//
// Serves the rider client's Firebase web-app config so the browser bundle ships
// no project literals. These are Firebase's public client identifiers (access is
// enforced by security rules, not by hiding them), which is why the endpoint is
// unauthenticated; no service-account material is ever returned here.
//
// Fails closed with 503 rather than handing back an all-null object: a config
// whose apiKey is null crashes initializeApp() inside the client with an opaque
// Firebase error, so the caller can't tell a misconfigured deployment from a bug
// in its own code.

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { env } from '../_lib/env.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const config = {
		apiKey: env.RIDER_FIREBASE_API_KEY ?? null,
		authDomain: env.RIDER_FIREBASE_AUTH_DOMAIN ?? null,
		databaseURL: env.RIDER_FIREBASE_DATABASE_URL ?? null,
		projectId: env.RIDER_FIREBASE_PROJECT_ID ?? null,
		storageBucket: env.RIDER_FIREBASE_STORAGE_BUCKET ?? null,
		messagingSenderId: env.RIDER_FIREBASE_MESSAGING_SENDER_ID ?? null,
	};

	// apiKey + projectId are the two Firebase refuses to initialize without.
	if (!config.apiKey || !config.projectId) {
		return error(
			res,
			503,
			'not_configured',
			'rider Firebase is not configured: set RIDER_FIREBASE_API_KEY and RIDER_FIREBASE_PROJECT_ID',
		);
	}

	return json(res, 200, config);
});
