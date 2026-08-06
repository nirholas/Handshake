// Agora — the bounty / hire compose form (Task 08). A real, validated form that
// produces the payload POST /api/agora/act consumes. Used for both "post a
// bounty" (open to anyone of a profession) and "hire <citizen>" (the same form,
// pre-targeted). No fake fields: every input maps to a real createTask arg.
//
// Classes are namespaced agora-h-* (see humans.css.js) so they never collide
// with the actively-edited scaffold (agora.css) or the other Agora layers; the
// shared .agora-btn is the one exception we reuse from the page chrome.

import { h, clear } from './panel.js';

// Profession keys mirror docs/agora.md + api/_lib/agora-human.js PROFESSION_BITS.
const PROFESSIONS = [
	['fetcher', 'Fetcher: call an HTTP/x402 service'],
	['scribe', 'Scribe: research / write'],
	['verifier', 'Verifier: re-derive a proof, attest'],
	['sculptor', 'Sculptor: text/image → rigged GLB'],
	['cartographer', 'Cartographer: build a 3D scene'],
	['crier', 'Crier: TTS / voice'],
	['appraiser', 'Appraiser: token / market intel'],
	['namekeeper', 'Namekeeper: .sol / ENS'],
];

/**
 * Build the compose form. Returns a DOM node. `onSubmit(payload)` is called with
 * the validated payload and returns a promise; the form drives its busy + result
 * states from that promise.
 */
export function buildPostForm({ onSubmit, cluster = 'devnet', hireTarget = null, mainnetEnabled = false }) {
	let net = cluster === 'mainnet' && mainnetEnabled ? 'mainnet' : 'devnet';

	const titleInput = h('input', { class: 'agora-h-input', type: 'text', maxlength: '140', required: true, placeholder: hireTarget ? `What should ${hireTarget.name} do?` : 'What needs doing? (≤140 chars)' });
	const descInput = h('textarea', { class: 'agora-h-input agora-h-textarea', maxlength: '4000', rows: '4', placeholder: 'Describe the deliverable and how it will be judged. This is hashed into the on-chain task.' });

	const profSelect = h('select', { class: 'agora-h-input', 'aria-label': 'Profession' },
		PROFESSIONS.map(([k, label]) => h('option', { value: k }, [label])));
	if (hireTarget?.profession) profSelect.value = hireTarget.profession;

	const rewardInput = h('input', { class: 'agora-h-input', type: 'number', min: '0', step: net === 'mainnet' ? '1' : '0.001', required: true, placeholder: net === 'mainnet' ? 'Reward in $THREE' : 'Reward in SOL (devnet)' });
	const rewardUnit = h('span', { class: 'agora-h-unit' }, [net === 'mainnet' ? '$THREE' : 'SOL']);

	const deadlineInput = h('input', { class: 'agora-h-input', type: 'number', min: '1', max: '720', value: '24', 'aria-label': 'Deadline in hours' });
	const minRepInput = h('input', { class: 'agora-h-input', type: 'number', min: '0', value: '0', 'aria-label': 'Minimum reputation' });

	const status = h('div', { class: 'agora-h-status', role: 'status', 'aria-live': 'polite' });
	const submitBtn = h('button', { class: 'agora-btn agora-btn-primary', type: 'submit' }, [hireTarget ? `Hire ${hireTarget.name}` : 'Post bounty & escrow']);

	const netToggle = mainnetEnabled
		? h('label', { class: 'agora-h-net' }, [
			h('input', { type: 'checkbox', onchange: (e) => {
				net = e.target.checked ? 'mainnet' : 'devnet';
				rewardUnit.textContent = net === 'mainnet' ? '$THREE' : 'SOL';
				rewardInput.placeholder = net === 'mainnet' ? 'Reward in $THREE' : 'Reward in SOL (devnet)';
				rewardInput.step = net === 'mainnet' ? '1' : '0.001';
			} }),
			h('span', {}, ['Use mainnet $THREE (real money)']),
		])
		: h('div', { class: 'agora-h-hint' }, ['Bounties escrow on devnet (test SOL). Mainnet $THREE is gated by the server.']);

	function setBusy(busy) {
		submitBtn.disabled = busy;
		submitBtn.textContent = busy ? 'Escrowing…' : (hireTarget ? `Hire ${hireTarget.name}` : 'Post bounty & escrow');
		[titleInput, descInput, profSelect, rewardInput, deadlineInput, minRepInput].forEach((el) => { el.disabled = busy; });
	}

	const form = h('form', { class: 'agora-h-form', novalidate: true }, [
		field('Title', titleInput),
		field('Brief', descInput),
		field('Profession', profSelect),
		h('div', { class: 'agora-h-row' }, [
			field('Reward', h('div', { class: 'agora-h-reward' }, [rewardInput, rewardUnit])),
			field('Deadline (h)', deadlineInput),
			field('Min rep', minRepInput),
		]),
		hireTarget ? h('div', { class: 'agora-h-hint' }, [`Routed to ${hireTarget.name}, who clears the reputation gate.`]) : null,
		netToggle,
		status,
		h('div', { class: 'agora-h-actions' }, [submitBtn]),
	]);

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		clear(status); status.className = 'agora-h-status';
		const title = titleInput.value.trim();
		const reward = Number(rewardInput.value);
		if (!title) { fail(status, 'A title is required.'); titleInput.focus(); return; }
		if (!Number.isFinite(reward) || reward <= 0) { fail(status, 'Enter a reward greater than zero.'); rewardInput.focus(); return; }

		const payload = {
			cluster: net,
			title,
			description: descInput.value.trim(),
			profession: profSelect.value,
			deadlineHours: Math.max(1, Math.min(720, Number(deadlineInput.value) || 24)),
			minReputation: Math.max(0, Number(minRepInput.value) || 0),
		};
		if (net === 'mainnet') payload.rewardThree = reward; else payload.rewardSol = reward;
		if (hireTarget) payload.citizenId = hireTarget.id;

		setBusy(true);
		try {
			const res = await onSubmit(payload);
			ok(status, res);
			form.reset();
			if (hireTarget?.profession) profSelect.value = hireTarget.profession;
		} catch (err) {
			fail(status, err?.message || 'The bounty was not posted.', err);
		} finally {
			setBusy(false);
		}
	});

	return form;
}

function field(label, control) {
	return h('label', { class: 'agora-h-field' }, [h('span', { class: 'agora-h-field-label' }, [label]), control]);
}

// An error is a designed state, not a red string. A dry wallet in particular is
// recoverable, so it renders the exact address to fund next to the message.
function fail(status, msg, err) {
	status.className = 'agora-h-status is-error';
	clear(status);
	status.appendChild(h('span', {}, [msg]));
	const addr = err?.code === 'insufficient_funds' ? err?.detail?.walletAddress : null;
	if (addr) {
		status.appendChild(h('div', { class: 'agora-h-fund' }, [
			h('span', { class: 'agora-h-muted' }, ['Fund this address: ']),
			h('code', { class: 'agora-h-addr', title: addr }, [addr]),
			h('button', {
				class: 'agora-btn agora-h-btn-sm', type: 'button',
				onclick: (e) => {
					navigator.clipboard?.writeText(addr)
						.then(() => { e.target.textContent = 'Copied'; })
						.catch(() => { e.target.textContent = 'Copy failed'; });
				},
			}, ['Copy']),
		]));
	}
}

function ok(status, res) {
	status.className = 'agora-h-status is-ok';
	clear(status);
	status.appendChild(h('span', {}, ['Escrowed. ']));
	if (res?.explorerUrl) {
		status.appendChild(h('a', { href: res.explorerUrl, target: '_blank', rel: 'noopener', class: 'agora-h-link' }, ['View tx ↗']));
	}
	if (res?.reward?.label) status.appendChild(h('span', { class: 'agora-h-muted' }, [` · ${res.reward.label}`]));
}
