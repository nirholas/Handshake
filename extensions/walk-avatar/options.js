// options.js — settings page controller

const THREEWS = 'https://three.ws';

async function loadVoices() {
	try {
		const res = await fetch(`${THREEWS}/api/tts/voices`);
		if (!res.ok) return;
		const { voices } = await res.json();
		const select = document.getElementById('opt-voice');
		select.innerHTML = '';
		voices.forEach((v) => {
			const opt = document.createElement('option');
			opt.value = v.id;
			opt.textContent = v.name;
			select.appendChild(opt);
		});
	} catch {}
}

async function boot() {
	// Load voices from real API
	await loadVoices();

	// Load stored settings
	const settings = await chrome.storage.sync.get(null);

	document.getElementById('opt-position').value = settings.position || 'bottom-right';
	document.getElementById('opt-width').value = String(settings.width || 180);
	document.getElementById('opt-height').value = String(settings.height || 260);

	const speed = settings.walkSpeed || 1;
	document.getElementById('opt-speed').value = String(speed);
	document.getElementById('opt-speed-val').textContent = parseFloat(speed).toFixed(1) + '×';

	document.getElementById('opt-narration').checked = !!settings.narrationEnabled;
	if (settings.voice) document.getElementById('opt-voice').value = settings.voice;

	document.getElementById('opt-allowlist').value = (settings.siteAllowlist || []).join('\n');
	document.getElementById('opt-blocklist').value = (settings.siteBlocklist || []).join('\n');

	// Speed slider live update
	document.getElementById('opt-speed').addEventListener('input', () => {
		const v = parseFloat(document.getElementById('opt-speed').value);
		document.getElementById('opt-speed-val').textContent = v.toFixed(1) + '×';
	});

	// Diagnostics
	const { threews_session: session } = await chrome.storage.local.get('threews_session');
	document.getElementById('diag-session').textContent = session ? 'signed in' : 'not signed in';
	document.getElementById('diag-version').textContent = chrome.runtime.getManifest().version;

	// Sign out
	document.getElementById('sign-out-btn').addEventListener('click', async () => {
		await chrome.storage.local.remove('threews_session');
		document.getElementById('diag-session').textContent = 'not signed in';
	});

	// Save
	document.getElementById('save-btn').addEventListener('click', async () => {
		const newSettings = {
			position: document.getElementById('opt-position').value,
			width: parseInt(document.getElementById('opt-width').value, 10) || 180,
			height: parseInt(document.getElementById('opt-height').value, 10) || 260,
			walkSpeed: parseFloat(document.getElementById('opt-speed').value),
			narrationEnabled: document.getElementById('opt-narration').checked,
			voice: document.getElementById('opt-voice').value,
			siteAllowlist: document.getElementById('opt-allowlist').value
				.split('\n').map(s => s.trim()).filter(Boolean),
			siteBlocklist: document.getElementById('opt-blocklist').value
				.split('\n').map(s => s.trim()).filter(Boolean),
		};

		await chrome.storage.sync.set(newSettings);

		// Broadcast to all active content scripts
		const tabs = await chrome.tabs.query({ status: 'complete' });
		tabs.forEach((tab) => {
			chrome.tabs.sendMessage(tab.id, {
				type: 'walk:config',
				speed: newSettings.walkSpeed,
			}).catch(() => {});
		});

		const btn = document.getElementById('save-btn');
		btn.textContent = 'Saved!';
		btn.classList.add('saved');
		setTimeout(() => {
			btn.textContent = 'Save settings';
			btn.classList.remove('saved');
		}, 1800);
	});
}

boot();
