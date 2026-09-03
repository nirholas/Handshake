// The channel between /drive in a web view and the native car shell around it.
//
// On CarPlay the car screen is NOT ours to draw on: a voice-conversational app
// gets Apple's Voice Control template (a listening indicator and up to four
// action buttons) and nothing else. The conversation itself, the agent, its
// voice and its face all live in this page, which runs on the phone. So the
// page publishes its state outward and accepts button presses inward, and the
// native side is a thin renderer of whatever it is told. Android Auto's
// template host works the same way.
//
// In a plain browser there is no channel and every send is a no-op, so the
// page has exactly one code path.

const PROTOCOL = 1;

/** The action set mirrored onto the car screen. Four is Apple's ceiling. */
export const MAX_NATIVE_ACTIONS = 4;

function nativeSink() {
	if (typeof window === 'undefined') return null;
	const ios = window.webkit?.messageHandlers?.threeWsDrive;
	if (ios?.postMessage) return (payload) => ios.postMessage(payload);
	const android = window.ThreeWsDriveNative;
	if (android?.post) return (payload) => android.post(JSON.stringify(payload));
	return null;
}

/**
 * Open the bridge.
 * @param {(command: { type: string, value?: unknown }) => void} onCommand
 *   Invoked for every press that arrives from the car screen.
 */
export function createBridge(onCommand) {
	const sink = nativeSink();
	const handler = typeof onCommand === 'function' ? onCommand : () => {};

	// The native shell calls into this global. It exists even without a shell so
	// the same surface is drivable from the console during development.
	if (typeof window !== 'undefined') {
		window.threeWsDrive = {
			protocol: PROTOCOL,
			command(input) {
				const cmd = typeof input === 'string' ? { type: input } : input;
				if (!cmd?.type) return false;
				handler(cmd);
				return true;
			},
		};
	}

	const send = (type, body) => {
		if (!sink) return false;
		try {
			sink({ v: PROTOCOL, type, ...body });
			return true;
		} catch {
			// A dead channel must never take the conversation down with it.
			return false;
		}
	};

	return {
		attached: !!sink,
		ready: (agent) => send('ready', { agent }),
		state: (state) => send('state', { state }),
		heard: (text) => send('heard', { text: String(text || '').slice(0, 240) }),
		said: (text) => send('said', { text: String(text || '').slice(0, 500) }),
		error: (code, message) => send('error', { code, message: String(message || '').slice(0, 240) }),
		actions: (actions) =>
			send('actions', {
				actions: actions.slice(0, MAX_NATIVE_ACTIONS).map((a) => ({
					id: a.id,
					label: a.label,
					enabled: a.enabled !== false,
				})),
			}),
		dispose() {
			if (typeof window !== 'undefined' && window.threeWsDrive?.protocol === PROTOCOL) {
				delete window.threeWsDrive;
			}
		},
	};
}
