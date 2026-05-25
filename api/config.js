// Public client-config. Returns non-secret config values the browser needs.

import { cors, json, method, wrap } from './_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const regen = (process.env.AVATAR_REGEN_PROVIDER || '').trim().toLowerCase();
	const reconstructEnabled = regen !== '' && regen !== 'none';

	const videoAvatarEnabled = !!(process.env.LONGCAT_WORKER_URL || '').trim();

	return json(res, 200, {
		walletConnectProjectId: process.env.VITE_WALLETCONNECT_PROJECT_ID || '',
		features: {
			// /create/selfie uses /api/avatars/reconstruct, which 501s unless an
			// ML backend is wired. The selfie page reads this to either show the
			// capture flow or fall through to a "coming soon — try /create" panel.
			avatarReconstruct: reconstructEnabled,
			// /create/video uses the LongCat GPU worker on Cloud Run; only
			// available once LONGCAT_WORKER_URL is set in Vercel env.
			videoAvatar: videoAvatarEnabled,
		},
	});
});
