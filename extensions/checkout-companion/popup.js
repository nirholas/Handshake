// The popup: three switches and an honest line about whether it can work.
//
// The connection line is a live check rather than "you saved a token", because
// a saved token that no longer resolves looks identical to a working one until
// the moment someone is standing on a checkout page needing an answer.

const DEFAULTS = { enabled: true, speak: true, rememberPrices: true };
const FIELDS = Object.keys(DEFAULTS);

const stored = await chrome.storage.local.get(DEFAULTS);
for (const field of FIELDS) {
	const input = document.getElementById(field);
	input.checked = stored[field] ?? DEFAULTS[field];
	input.addEventListener('change', () => {
		chrome.storage.local.set({ [field]: input.checked });
	});
}

const connection = document.getElementById('connection');
try {
	const state = await chrome.runtime.sendMessage({ type: 'checkout:ping' });
	if (state?.connected) {
		connection.textContent = state.via === 'token' ? 'Connected with a bridge token.' : 'Connected as your signed-in account.';
		connection.className = 'muted ok';
	} else {
		connection.textContent = 'Not connected. Open account settings to fix this.';
		connection.className = 'muted warn';
	}
} catch {
	connection.textContent = 'Could not reach three.ws.';
	connection.className = 'muted warn';
}
