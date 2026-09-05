// src/irl/pin-ar.js: "View in AR" for ANY agent discovered on /irl (pure routing).
//
// Until now the only AR entry on /irl was the placement button, which only ever
// opened the viewer's OWN agent (the one they were about to pin). A visitor who
// walked up to somebody else's agent could see it in the camera passthrough, but
// had no way to stand it on their real floor with the device's native AR stack.
// This module decides, per device, how a tapped pin gets there:
//
//   'quicklook'  iOS / iPadOS: ARKit Quick Look, fed a USDZ baked on-device from
//                the pin's GLB (idle clip included, same bake the placement path
//                uses). The Quick Look banner names the agent and its tap hands
//                the visitor back to the pin sheet with the conversation open.
//   'webxr'      Android Chrome (ARCore): an immersive hit-test session that stands
//                THIS pin's already-loaded model on a detected surface, view-only.
//                Nothing is persisted: the durable placement is the owner's pin.
//   'link'       Everything else: the device-aware /api/ar launch page for the
//                pin's GLB (Scene Viewer on an ARCore phone without WebXR, a
//                phone-handoff QR on desktop). Opens in a new tab so the visitor
//                never loses their place in the camera view.
//
// The functions are pure (no DOM, no Three.js) so the routing and the URL
// construction are unit-tested in isolation; irl.js owns the side effects.

/** @typedef {'quicklook'|'webxr'|'link'} PinArLane */

// Upper bound on the agent name inside the Quick Look banner and the /api/ar
// title. Quick Look truncates long strings itself; /api/ar echoes the title into
// the page <title>, so a prompt-as-name must never run away.
const NAME_MAX = 60;

/**
 * Map the device's placement capability (src/ar/placement-capability.js) to the
 * lane a discovered pin is viewed through. Unknown/empty input is the safe
 * universal lane, never a thrown error on a button tap.
 * @param {string} capability 'webxr' | 'quicklook' | 'pin' | anything else
 * @returns {PinArLane}
 */
export function arLaneFor(capability) {
	if (capability === 'quicklook') return 'quicklook';
	if (capability === 'webxr') return 'webxr';
	return 'link';
}

/**
 * Button copy per lane: one visible label everywhere (one mental model), with the
 * accessible description saying what actually happens on this device.
 * @param {PinArLane} lane
 * @returns {{ label: string, aria: string }}
 */
export function arButtonCopy(lane) {
	if (lane === 'quicklook') {
		return { label: 'View in AR', aria: 'View this agent on your floor in AR (iOS Quick Look)' };
	}
	if (lane === 'webxr') {
		return { label: 'View in AR', aria: 'Stand this agent on your floor with AR' };
	}
	return { label: 'View in AR', aria: 'Open this agent in the AR viewer' };
}

/** The pin's display name, clamped for banners and titles. */
export function pinDisplayName(pin) {
	const raw = typeof pin?.avatar_name === 'string' ? pin.avatar_name.trim() : '';
	return (raw || 'Agent').slice(0, NAME_MAX);
}

/**
 * Resolve the pin's GLB to an absolute URL. Pins store either an absolute CDN
 * URL or a site-relative path (`/avatars/default.glb`); native AR viewers and
 * /api/ar only accept absolute https. Returns null when nothing usable exists.
 * @param {string} avatarUrl
 * @param {string} origin e.g. location.origin
 * @returns {string|null}
 */
export function absoluteGlbUrl(avatarUrl, origin) {
	if (typeof avatarUrl !== 'string' || !avatarUrl.trim()) return null;
	try {
		return new URL(avatarUrl.trim(), origin).toString();
	} catch {
		return null;
	}
}

/**
 * The device-aware AR launch link for a pin (GET /api/ar, api/ar.js). `kind=avatar`
 * marks it as a living agent so Android without WebXR lands on /ar/view with the
 * IRL handoff visible instead of a blind Scene Viewer redirect. Returns null when
 * the GLB cannot be expressed as an https URL, which /api/ar would reject anyway.
 * @param {{ avatar_url?: string, avatar_name?: string }} pin
 * @param {string} origin
 * @returns {string|null}
 */
export function arLaunchUrl(pin, origin) {
	const glb = absoluteGlbUrl(pin?.avatar_url, origin);
	if (!glb || !glb.startsWith('https://')) return null;
	const params = new URLSearchParams({ src: glb, title: pinDisplayName(pin), kind: 'avatar' });
	return `${origin}/api/ar?${params.toString()}`;
}

/**
 * Quick Look banner fields for a discovered pin. The banner is the one piece of
 * page UI Apple allows inside the sealed viewer; its tap is the only in-AR signal
 * we get back, so the call to action is the conversation, not a placement.
 * @param {{ avatar_name?: string, caption?: string }} pin
 */
export function quickLookBannerFor(pin) {
	const name = pinDisplayName(pin);
	const caption = typeof pin?.caption === 'string' ? pin.caption.trim() : '';
	return {
		title: name,
		subtitle: caption || 'Living agent on three.ws',
		callToAction: `Talk to ${name}`,
	};
}
