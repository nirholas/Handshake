/**
 * /irl/sign?pin=<id>: the printable sign for a placed IRL agent.
 *
 * Tape it where the agent stands. It carries the agent's name, thumbnail and bio
 * from the public agent card, plus a QR of the visit link (/irl?pin=<id>). The
 * page is deliberately coordinate-free: the pin id resolves only to who lives
 * here, and the agent itself still appears only through the presence-gated
 * nearby read once the visitor is physically within range.
 */

import { renderQRToSVG } from './erc8004/qr.js';
import { normalizePinId, buildVisitUrl } from './irl/visit-link.js';

const $ = (id) => document.getElementById(id);

const bar     = $('sg-bar');
const loading = $('sg-loading');
const stateEl = $('sg-state');
const sheet   = $('sg-sheet');
const LAYOUT_KEY = 'irl-sign-layout';

function showState({ title, body, action }) {
	loading.hidden = true;
	sheet.hidden = true;
	stateEl.hidden = false;
	stateEl.innerHTML = `<h1></h1><p></p>`;
	stateEl.querySelector('h1').textContent = title;
	stateEl.querySelector('p').textContent = body;
	if (action) {
		const a = document.createElement('a');
		a.className = 'sg-btn primary';
		a.href = action.href;
		a.textContent = action.label;
		stateEl.appendChild(a);
	}
}

function applyLayout(layout) {
	const poster = layout === 'poster';
	sheet.classList.toggle('is-poster', poster);
	for (const b of bar.querySelectorAll('[data-layout]')) {
		b.setAttribute('aria-pressed', b.dataset.layout === layout ? 'true' : 'false');
	}
	try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* private mode: layout just doesn't persist */ }
}

async function main() {
	const pinId = normalizePinId(new URLSearchParams(location.search).get('pin'));
	if (!pinId) {
		showState({
			title: 'Which agent is this sign for?',
			body: 'Open a placement from your dashboard and choose "Visit link" to print its sign.',
			action: { href: '/dashboard/irl-placements', label: 'Open my placements' },
		});
		return;
	}

	const visitUrl = buildVisitUrl(pinId, location.origin);

	let card;
	try {
		const r = await fetch(`/api/irl/agent-card?pin=${encodeURIComponent(pinId)}`);
		if (r.status === 404) {
			showState({
				title: 'This placement is no longer active',
				body: 'The pin expired or was removed, so a sign for it would point at an empty spot. Place the agent again and print a fresh sign.',
				action: { href: '/irl', label: 'Open IRL' },
			});
			return;
		}
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		({ card } = await r.json());
		if (!card?.agent) throw new Error('empty card');
	} catch {
		showState({
			title: "Couldn't load this agent",
			body: 'Check your connection and reload. The visit link itself still works.',
			action: { href: visitUrl, label: 'Open the visit link' },
		});
		return;
	}

	const agent = card.agent;
	$('sg-name').textContent = agent.name || 'Agent';
	const bio = (agent.bio || '').trim();
	if (bio) { $('sg-bio').textContent = bio; $('sg-bio').hidden = false; }
	if (agent.thumbnail_url) {
		const img = document.createElement('img');
		img.alt = '';
		img.src = agent.thumbnail_url;
		img.addEventListener('error', () => { img.remove(); $('sg-thumb').textContent = '✦'; });
		$('sg-thumb').textContent = '';
		$('sg-thumb').appendChild(img);
	}
	$('sg-qr').innerHTML = renderQRToSVG(visitUrl, { scale: 6, margin: 1 });
	$('sg-url').textContent = visitUrl.replace(/^https?:\/\//, '');
	$('sg-open').href = visitUrl;
	document.title = `${agent.name || 'Agent'} | IRL sign | three.ws`;

	$('sg-copy').addEventListener('click', async () => {
		const btn = $('sg-copy');
		try {
			await navigator.clipboard.writeText(visitUrl);
			btn.textContent = 'Copied';
		} catch {
			btn.textContent = 'Copy failed';
		}
		setTimeout(() => { btn.textContent = 'Copy visit link'; }, 1800);
	});
	$('sg-print').addEventListener('click', () => window.print());
	bar.addEventListener('click', (e) => {
		const b = e.target.closest('[data-layout]');
		if (b) applyLayout(b.dataset.layout);
	});
	let saved = 'landscape';
	try { saved = localStorage.getItem(LAYOUT_KEY) === 'poster' ? 'poster' : 'landscape'; } catch { /* default */ }
	applyLayout(saved);

	loading.hidden = true;
	stateEl.hidden = true;
	bar.hidden = false;
	sheet.hidden = false;
}

main();
