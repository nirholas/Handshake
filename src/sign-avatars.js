// Which avatar does the signing, shared by every sign-language surface.
//
// /sign-language, /asl-alphabet and the mirror drill all put a rig on a
// PoseStage and drive it with the same clips, and they all read one stored
// preference block: a left-handed signer who set that once should never set it
// again, and an avatar chosen on one page is already on stage on the next.
//
// Two rigs ship with the platform, and any avatar on three.ws (yours or a
// public one) can take their place. The clips are rig-independent: they
// retarget onto whatever skeleton is attached, so a custom avatar signs with
// the same vocabulary, speed and dominant hand as the built-ins.

const PREFS_KEY = 'threews:sign-prefs';

// The classic rig is light enough to animate smoothly everywhere, including on
// software renderers, but carries no face blendshapes. The expressive rig ships
// the full ARKit shape set, so the non-manual markers a signed question needs
// (raised brows, furrowed brows, a headshake's set jaw) are actually visible.
// See docs/sign-language.md.
export const BUILT_IN_RIGS = [
	{ id: 'classic', label: 'Classic', url: '/avatars/cz.glb' },
	{ id: 'expressive', label: 'Expressive face', url: '/avatars/default.glb' },
];

const CUSTOM_PREFIX = 'custom:';

export function loadSignPrefs() {
	try {
		const parsed = JSON.parse(localStorage.getItem(PREFS_KEY));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/** Merge `patch` into the stored preferences. Private mode just doesn't persist. */
export function saveSignPrefs(patch) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadSignPrefs(), ...patch }));
	} catch {
		/* storage denied: settings live for this page view only */
	}
}

/** A stored custom rig is only usable if it still carries a loadable GLB URL. */
function validCustomRig(rig) {
	if (!rig || typeof rig !== 'object') return null;
	const { id, label, url } = rig;
	if (typeof id !== 'string' || !id.startsWith(CUSTOM_PREFIX)) return null;
	if (typeof url !== 'string' || !/^(https?:\/\/|\/)/.test(url)) return null;
	return { id, label: typeof label === 'string' && label.trim() ? label.trim() : 'Your avatar', url, custom: true };
}

/** The custom avatar the visitor last picked, or null. */
export function customRig(prefs = loadSignPrefs()) {
	return validCustomRig(prefs.customRig);
}

/** The rig to put on stage: the stored pick, falling back to the classic rig. */
export function resolveRig(prefs = loadSignPrefs()) {
	const custom = customRig(prefs);
	if (custom && prefs.avatar === custom.id) return custom;
	return BUILT_IN_RIGS.find((r) => r.id === prefs.avatar) || BUILT_IN_RIGS[0];
}

/** Turn a picked avatar record from the gallery into a rig the stages can mount. */
export function rigFromAvatar(avatar) {
	const url = avatar?.model_url || avatar?.modelUrl || '';
	if (!url) return null;
	const id = `${CUSTOM_PREFIX}${avatar.id || url}`;
	return validCustomRig({ id, label: avatar.name || 'Your avatar', url });
}

/**
 * Render the Avatar pill group: the built-in rigs, then one pill for a custom
 * avatar. The custom pill opens the avatar gallery when it is already active
 * (or when nothing has been picked yet), and simply switches back to the stored
 * pick otherwise, so swapping between a built-in and your own avatar never
 * costs a trip through the gallery.
 *
 * @param {Object} opts
 * @param {Element|string} opts.host        Container for the pills.
 * @param {string} opts.optionClass         Page's pill class (`sl-opt` / `aa-opt`).
 * @param {Object} opts.active              Rig currently on stage.
 * @param {(rig: Object) => Promise<boolean>} opts.apply  Mounts the rig; resolves
 *   false when the rig could not be used, which restores the previous pill.
 * @param {(msg: string) => void} [opts.onStatus]
 */
export function buildRigPicker({ host, optionClass, active, apply, onStatus }) {
	const root = typeof host === 'string' ? document.querySelector(host) : host;
	if (!root) return;

	let current = active;
	let busy = false;
	const buttons = new Map();

	const press = (rig) => {
		for (const [id, btn] of buttons) btn.setAttribute('aria-pressed', String(id === rig?.id));
	};
	const setBusy = (value) => {
		busy = value;
		for (const btn of buttons.values()) btn.disabled = value;
	};

	const choose = async (rig) => {
		if (busy || !rig || rig.id === current.id) return;
		const previous = current;
		setBusy(true);
		press(rig);
		const ok = await apply(rig);
		if (ok) current = rig;
		else press(previous);
		setBusy(false);
	};

	const addPill = (label, onClick) => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = optionClass;
		btn.textContent = label;
		btn.setAttribute('aria-pressed', 'false');
		btn.addEventListener('click', onClick);
		root.appendChild(btn);
		return btn;
	};

	for (const rig of BUILT_IN_RIGS) {
		buttons.set(rig.id, addPill(rig.label, () => choose(rig)));
	}

	// The custom pill carries the picked avatar's name once there is one, and
	// keeps its own key in the map so pressed state tracks the avatar behind it.
	let stored = customRig();
	const customBtn = addPill(stored ? stored.label : 'Your avatar…', async () => {
		if (busy) return;
		if (stored && stored.id !== current.id) {
			await choose(stored);
			return;
		}
		setBusy(true);
		let picked = null;
		try {
			const { openAvatarPicker } = await import('./avatar-gallery-picker.js');
			picked = await openAvatarPicker({
				source: 'both',
				title: 'Choose an avatar to sign with',
				selectedId: stored ? stored.id.slice(CUSTOM_PREFIX.length) : '',
				showModes: false,
				ctaLabel: 'Sign with this avatar',
			});
		} catch {
			onStatus?.('The avatar gallery could not open. The built-in rigs still sign everything.');
		}
		setBusy(false);
		const rig = picked ? rigFromAvatar(picked) : null;
		if (!rig) {
			if (picked) onStatus?.('That avatar has no 3D model to load. Pick another.');
			return;
		}
		const previousKey = stored?.id;
		stored = rig;
		saveSignPrefs({ customRig: rig });
		customBtn.textContent = rig.label;
		if (previousKey) buttons.delete(previousKey);
		buttons.set(rig.id, customBtn);
		await choose(rig);
	});
	if (stored) buttons.set(stored.id, customBtn);

	press(current);
}
