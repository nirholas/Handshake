// Public client-config. Returns non-secret config values the browser needs.

import { cors, json, method, wrap } from './_lib/http.js';
import { resolveProviderName, BYOK_REGEN_PROVIDERS } from './_lib/regen-provider.js';
import { vapidPublicKey, pushConfigured } from './_lib/web-push.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const provider = resolveProviderName();
	const hasPlatformProvider = provider !== 'none';

	// Whether the delivered model is auto-rigged (animation-ready). The GCP
	// pipeline rigs inline via UniRig; Replicate rigs only when a rerig model is
	// configured. HF Spaces return static meshes. The /scan page uses this to set
	// honest expectations instead of promising a rig we can't produce.
	const riggingEnabled =
		provider === 'gcp' ||
		(provider === 'replicate' && !!(process.env.REPLICATE_RERIG_MODEL || '').trim());

	const videoAvatarEnabled = !!(process.env.LONGCAT_WORKER_URL || '').trim();

	// Live webcam body motion capture (Pose Landmarker → humanoid bones). Ships
	// dark: the capture module and solver are bundled but no surface wires them in
	// until this flag is flipped on via env, so it can be validated in production
	// before being bridged into /mocap-studio.
	const liveBodyMocapEnabled = /^(1|true|on)$/i.test((process.env.LIVE_BODY_MOCAP || '').trim());

	// Enterprise SAML SSO — true when an IdP is wired (explicit cert + SSO URL,
	// or a metadata URL to fetch them from). Drives the SSO button on /login.
	// Cheap env-only check so this hot endpoint doesn't pull in the SAML lib.
	const samlEnabled = Boolean(
		(process.env.SAML_IDP_CERT && process.env.SAML_IDP_SSO_URL) ||
			process.env.SAML_IDP_METADATA_URL,
	);

	return json(res, 200, {
		walletConnectProjectId: process.env.VITE_WALLETCONNECT_PROJECT_ID || '',
		privyAppId: process.env.VITE_PRIVY_APP_ID || process.env.PRIVY_APP_ID || '',
		samlEnabled,
		// Web Push: the client needs the VAPID public key to subscribe. Empty
		// string when push isn't configured, which the client reads as "hide the
		// enable-push affordance".
		pushEnabled: pushConfigured(),
		vapidPublicKey: vapidPublicKey(),
		samlLabel: process.env.SAML_BUTTON_LABEL || 'Single sign-on (SSO)',
		features: {
			// avatarReconstruct is always true: BYOK providers (Meshy, Tripo) are
			// always available — the selfie page handles key entry inline when the
			// platform backend isn't configured. The reconstruct endpoint returns
			// { code: 'regen_needs_byok' } rather than 501 in that case.
			avatarReconstruct: true,
			// 'platform' = server has configured creds (no key needed by user).
			// 'byok'     = reconstruction works but user must supply an API key.
			avatarReconstructMode: hasPlatformProvider ? 'platform' : 'byok',
			// Which BYOK providers the user can use when platform is unconfigured.
			avatarByokProviders: hasPlatformProvider ? [] : [...BYOK_REGEN_PROVIDERS],
			// True when the pipeline returns a rigged (animation-ready) model.
			avatarRigging: riggingEnabled,
			// /create/video uses the LongCat GPU worker, which needs an 80 GB
			// GPU and so runs on Compute Engine, not Cloud Run (see
			// workers/longcat/README.md). False until LONGCAT_WORKER_URL is set
			// on the three-ws-api Cloud Run service.
			videoAvatar: videoAvatarEnabled,
			// Live webcam body capture. Off until LIVE_BODY_MOCAP is set; the
			// frontend gates the "go live (body)" affordance on this.
			liveBodyMocap: liveBodyMocapEnabled,
		},
	});
});
