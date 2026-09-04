// The public door page: /knock/<handle>.
//
// One job, done for two very different visitors. A person reads who they are
// about to interrupt and what it costs, writes a message, and pays with the
// wallet they already have in this browser. An agent lands here to learn the
// endpoint, the price and the schema, then never opens the page again.
//
// Both get the same truth from GET /api/knock/door, so the page can never
// advertise a price the API would not charge.
//
// Payment is the browser x402 checkout (window.X402.pay, /x402.js), the same
// modal the club cover and the billboard use. It settles the USDC directly to
// the door owner and returns the endpoint's own JSON, which is the accepted
// knock plus its receipt URL.

import { knockApi } from './api.js';

const els = {};
let door = null;
let lastReceiptUrl = null;
// The escrow this visitor just paid, while the page is still open: what the
// countdown counts down to, and what the refund button acts on.
let escrow = null;
let clockTimer = null;

document.addEventListener('DOMContentLoaded', () => {
	for (const id of [
		'loading', 'not-found', 'door-card', 'avatar', 'display-name', 'handle', 'verified',
		'headline', 'greeting', 'price-badge', 'price-note', 'form', 'from', 'subject',
		'message', 'url', 'counter', 'submit', 'form-error', 'sent', 'sent-line', 'receipt-url',
		'copy-receipt', 'check-reply', 'reply-box', 'knock-again', 'agent-panel', 'agent-endpoint',
		'curl-snippet', 'sdk-snippet', 'mcp-snippet', 'copy-endpoint',
		'lanes', 'lane-pay-note', 'lane-escrow-note', 'guarantee',
		'escrow-status', 'escrow-amount', 'escrow-clock', 'escrow-clock-label', 'escrow-bar',
		'escrow-bar-fill', 'escrow-note', 'escrow-explorer', 'reclaim',
		'confirm-escrow', 'confirm-terms', 'confirm-note', 'confirm-ok',
		'escrow-block', 'escrow-snippet',
	]) {
		els[id] = document.getElementById(id);
	}

	bind();
	load();
});

function handleFromPath() {
	const fromPath = decodeURIComponent(window.location.pathname.replace(/^\/knock\/?/, '')).trim();
	if (fromPath) return fromPath;
	return new URLSearchParams(window.location.search).get('to') || '';
}

async function load() {
	const handle = handleFromPath();
	if (!handle) return showNotFound('No handle in this link. Try /knock and pick a door.');

	try {
		const data = await knockApi.door(handle);
		door = data.door;
		render();
	} catch (err) {
		showNotFound(
			err.status === 404
				? `Nobody is answering at @${handle}. They may not have opened a door yet.`
				: err.message,
		);
	}
}

function showNotFound(message) {
	els.loading.hidden = true;
	els['not-found'].hidden = false;
	els['not-found'].querySelector('[data-msg]').textContent = message;
}

function render() {
	els.loading.hidden = true;
	els['door-card'].hidden = false;

	document.title = `Knock on ${door.display_name} · three.ws`;
	els['display-name'].textContent = door.display_name;
	els.handle.textContent = `@${door.handle}`;
	els.handle.href = `/u/${door.handle}`;
	els.verified.hidden = !door.verified;

	if (door.avatar_url) {
		els.avatar.src = door.avatar_url;
		els.avatar.alt = `${door.display_name}'s avatar`;
		els.avatar.hidden = false;
	} else {
		// No avatar is still a designed state: the initial keeps the layout
		// stable instead of leaving a hole where a face should be.
		els.avatar.hidden = true;
		els.avatar.parentElement.dataset.initial = (door.display_name || '?').slice(0, 1).toUpperCase();
	}

	els.headline.textContent = door.headline || '';
	els.headline.hidden = !door.headline;
	els.greeting.textContent = door.greeting || '';
	els.greeting.hidden = !door.greeting;

	els['price-badge'].textContent = door.free ? 'Free' : door.price;
	els['price-badge'].classList.toggle('is-free', door.free);
	els['price-note'].textContent = door.free
		? 'This door is open to anyone. One message, no payment.'
		: `${door.price} USDC on ${door.networks.join(' or ')}, settled straight to ${door.display_name}. One message.`;

	els.message.maxLength = door.max_chars;
	updateCounter();

	renderLanes();
	updateSubmitLabel();
	renderAgentPanel();
}

/**
 * The lane picker, shown only when this door takes escrow.
 *
 * A door with one lane does not get a chooser: a single option presented as a
 * choice is noise. When there are two, the difference between them is the only
 * thing worth saying, so each option says what happens to the money rather
 * than naming a protocol.
 */
function renderLanes() {
	if (!door.escrow || door.free) {
		els.lanes.hidden = true;
		els.guarantee.hidden = true;
		return;
	}
	els.lanes.hidden = false;
	els['lane-pay-note'].textContent = `${door.price} goes straight to ${door.display_name} when you send.`;
	els['lane-escrow-note'].textContent = `${door.price} is held on-chain and only pays out if they answer.`;
	els.guarantee.hidden = false;
	const strong = document.createElement('strong');
	strong.textContent = `They have ${windowLabel(door.escrow.window_hours)} to answer. `;
	els.guarantee.replaceChildren(strong, document.createTextNode(door.escrow.guarantee));
}

function windowLabel(hours) {
	const n = Number(hours) || 24;
	if (n < 24) return `${n} hour${n === 1 ? '' : 's'}`;
	const days = Math.round(n / 24);
	return `${days} day${days === 1 ? '' : 's'}`;
}

function selectedLane() {
	if (door?.free || !door?.escrow) return door?.free ? 'free' : 'pay';
	const picked = document.querySelector('input[name="lane"]:checked');
	return picked?.value === 'escrow' ? 'escrow' : 'pay';
}

function updateSubmitLabel() {
	if (door.free) {
		els.submit.textContent = 'Knock';
		return;
	}
	els.submit.textContent =
		selectedLane() === 'escrow' ? `Escrow ${door.price} and knock` : `Pay ${door.price} and knock`;
}

function renderAgentPanel() {
	const endpoint = door.endpoint;
	els['agent-endpoint'].textContent = endpoint;
	els['copy-endpoint'].dataset.copy = endpoint;

	const example = {
		from: 'Your agent',
		subject: 'One line they will hear out loud',
		message: 'What you actually want to say.',
	};

	els['curl-snippet'].textContent = door.free
		? `curl -X POST ${endpoint} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ to: door.handle, ...example })}'`
		: `# 402 first, then pay and retry. Any x402 client does both steps.\ncurl -i -X POST '${endpoint}' \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(example)}'`;

	els['sdk-snippet'].textContent = [
		"import { knock } from '@three-ws/knock';",
		'',
		'const receipt = await knock({',
		`  to: '${door.handle}',`,
		"  from: 'Your agent',",
		"  message: 'What you actually want to say.',",
		'  wallet,            // a Solana signer you already have',
		'  confirm: true,     // shows the price and asks before it pays',
		'});',
		'',
		'console.log(receipt.receipt_url); // poll this for a reply',
	].join('\n');

	// The escrowed lane, for a caller who can sign Solana. Written out rather
	// than hidden behind an SDK call, because the one step that cannot be
	// delegated is the one the agent has to get exactly right: the message hash
	// on-chain must be the SHA-256 of the trimmed body sent here, or this
	// endpoint refuses to deliver a message the escrow did not pay for.
	els['escrow-block'].hidden = !door.escrow;
	if (door.escrow) {
		els['escrow-snippet'].textContent = [
			`# 1. Sign \`knock\` on ${door.escrow.program}`,
			`#    door:         ${door.escrow.door}`,
			'#    args:         nonce (u64), message_hash (sha256 of the trimmed message)',
			`#    the program takes this door's on-chain price and holds it in a vault`,
			`#    that pays out only if @${door.handle} answers within ${windowLabel(door.escrow.window_hours)}.`,
			'',
			'# 2. Deliver the message against that escrow.',
			`curl -X POST ${door.escrow.endpoint} \\`,
			"  -H 'content-type: application/json' \\",
			`  -d '${JSON.stringify({ to: door.handle, ...example, sender_wallet: '<your pubkey>', nonce: '<the nonce you signed>' })}'`,
		].join('\n');
	}

	els['mcp-snippet'].textContent = [
		'{',
		'  "mcpServers": {',
		'    "knock": {',
		'      "command": "npx",',
		'      "args": ["-y", "@three-ws/knock-mcp"]',
		'    }',
		'  }',
		'}',
	].join('\n');
}

function updateCounter() {
	const max = door?.max_chars ?? 600;
	const used = els.message.value.length;
	els.counter.textContent = `${used} / ${max}`;
	els.counter.classList.toggle('is-full', used >= max);
}

function bind() {
	els.message?.addEventListener('input', updateCounter);
	els.form?.addEventListener('submit', onSubmit);
	els['knock-again']?.addEventListener('click', () => {
		stopClock();
		els['escrow-status'].hidden = true;
		els.sent.hidden = true;
		els.form.hidden = false;
		els.message.value = '';
		els.subject.value = '';
		updateCounter();
		els.from.focus();
	});
	els['check-reply']?.addEventListener('click', checkReply);
	els.reclaim?.addEventListener('click', onReclaim);
	for (const radio of document.querySelectorAll('input[name="lane"]')) {
		radio.addEventListener('change', updateSubmitLabel);
	}
	for (const btn of document.querySelectorAll('[data-copy-target], [data-copy]')) {
		btn.addEventListener('click', () => copy(btn));
	}
	// Cmd/Ctrl+Enter sends, because everyone tries it in a message box.
	els.message?.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') els.form.requestSubmit();
	});
}

async function copy(btn) {
	const text = btn.dataset.copy || document.getElementById(btn.dataset.copyTarget)?.textContent || '';
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		const original = btn.textContent;
		btn.textContent = 'Copied';
		btn.classList.add('is-ok');
		setTimeout(() => {
			btn.textContent = original;
			btn.classList.remove('is-ok');
		}, 1400);
	} catch {
		// Clipboard blocked (insecure context, denied permission). Select the
		// text instead so the visitor can copy it by hand rather than get
		// nothing at all.
		const target = document.getElementById(btn.dataset.copyTarget);
		if (target) window.getSelection()?.selectAllChildren(target);
	}
}

function payload() {
	const body = {
		from: els.from.value.trim(),
		message: els.message.value.trim(),
		sender_kind: 'human',
	};
	if (els.subject.value.trim()) body.subject = els.subject.value.trim();
	if (els.url.value.trim()) body.url = els.url.value.trim();
	return body;
}

async function onSubmit(e) {
	e.preventDefault();
	setError('');
	const body = payload();
	if (body.message.length < 8) return setError('Say at least 8 characters.');
	if (!body.from) return setError('Tell them who you are.');

	const lane = selectedLane();
	els.submit.disabled = true;
	const label = els.submit.textContent;
	els.submit.textContent = door.free ? 'Knocking…' : 'Opening wallet…';

	try {
		const result =
			lane === 'free'
				? await knockApi.send({ to: door.handle, ...body })
				: lane === 'escrow'
					? await escrowAndKnock(body, (status) => { els.submit.textContent = `${status}…`; })
					: await payAndKnock(body);
		showSent(result);
	} catch (err) {
		setError(friendlyError(err));
	} finally {
		els.submit.disabled = false;
		els.submit.textContent = label;
	}
}

async function payAndKnock(body) {
	if (!window.X402?.pay) {
		throw new Error('The payment widget is still loading. Give it a second and try again.');
	}
	const out = await window.X402.pay({
		endpoint: door.endpoint,
		method: 'POST',
		body,
		merchant: `three.ws Knock`,
		action: `Knock on ${door.display_name} (${door.price})`,
		autoConnect: true,
		autoClose: true,
	});
	const result = out?.result;
	if (!result?.ok) throw new Error(result?.error_description || result?.error || 'the payment did not settle');
	return result;
}

/**
 * The escrowed lane, end to end.
 *
 * Two steps, in this order and never the other way round. The visitor's own
 * wallet parks the payment on-chain first, and only then does the API get
 * asked to deliver the message, because the API's entire job on this lane is to
 * refuse anything the chain does not already back. If the delivery call fails
 * after the escrow is paid, the money is not lost and this says so: it is sitting
 * in a vault that pays nobody but the sender once the window closes.
 */
async function escrowAndKnock(body, onStatus) {
	const { escrowKnock, EscrowError } = await import('./escrow-checkout.js');
	const paid = await escrowKnock({
		doorAddress: door.escrow.door,
		message: body.message,
		onStatus,
		confirm: confirmEscrow,
	});

	onStatus('Delivering');
	try {
		const result = await knockApi.escrowed({
			to: door.handle,
			...body,
			sender_wallet: paid.sender,
			nonce: String(paid.nonce),
		});
		return { ...result, paid };
	} catch (err) {
		// The escrow exists whatever happened here, so the visitor is told what
		// they are holding and how to get it back rather than just that
		// something failed.
		const reason = err instanceof EscrowError ? err.message : friendlyError(err);
		throw Object.assign(
			new Error(
				`Your ${paid.amount} is escrowed and safe, but the message did not go through: ${reason} Nobody can spend it, and you can take it back after the window closes.`,
			),
			{ code: 'delivery_failed', escrow: paid },
		);
	}
}

/**
 * The spend confirmation. Nothing is signed until this resolves true.
 *
 * It states the amount, who it goes to and the deadline in the same words the
 * page used to sell the lane, because a confirmation that says something
 * different from the pitch is how people end up agreeing to what they did not
 * read.
 */
function confirmEscrow(terms) {
	const dialog = els['confirm-escrow'];
	if (typeof dialog?.showModal !== 'function') {
		// No dialog support: fall back to the browser's own confirm rather than
		// silently signing. Spending money always asks.
		return Promise.resolve(
			window.confirm(
				`Escrow ${terms.amount} to knock on ${door.display_name}? It pays out only if they answer within ${windowLabel(door.escrow.window_hours)}, and comes back to you otherwise.`,
			),
		);
	}

	const rows = [
		['You escrow', terms.amount, false],
		['Goes to', `${door.display_name} (@${door.handle})`, false],
		['Only if they answer by', new Date(terms.expiresAt * 1000).toLocaleString(), false],
		['Held at', terms.knock, true],
	];
	els['confirm-terms'].replaceChildren(
		...rows.flatMap(([label, value, mono]) => {
			const dt = document.createElement('dt');
			dt.textContent = label;
			const dd = document.createElement('dd');
			dd.textContent = value;
			if (mono) dd.className = 'mono';
			return [dt, dd];
		}),
	);
	els['confirm-note'].textContent =
		'Your wallet signs this, not three.ws. Once it is escrowed nobody can spend it except by answering you, and if the deadline passes anyone can send it back to you.';
	els['confirm-ok'].textContent = `Escrow ${terms.amount}`;

	return new Promise((resolve) => {
		dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
		dialog.showModal();
	});
}

/** The live state of the escrow this visitor is holding open on the page. */
function showEscrow(paid, escrowState) {
	// The API returns the deadline the CHAIN recorded, in unix seconds. Prefer
	// it over the one derived locally before signing: the program stamps
	// expires_at from the cluster's clock, not this browser's.
	escrow = {
		knock: escrowState?.knock || paid.knock,
		amount: paid.amount,
		createdAt: Math.floor(Date.now() / 1000),
		expiresAt: Number(escrowState?.expires_at) || paid.expiresAt,
	};
	els['escrow-status'].hidden = false;
	els['escrow-amount'].textContent = `${escrow.amount} USDC`;
	els['escrow-explorer'].href = `https://solscan.io/account/${escrow.knock}`;
	els['escrow-note'].textContent =
		`Nobody can spend this but ${door.display_name}, and only by answering you.`;
	tickClock();
	stopClock();
	clockTimer = window.setInterval(tickClock, 1000);
}

function stopClock() {
	if (clockTimer) window.clearInterval(clockTimer);
	clockTimer = null;
}

function tickClock() {
	if (!escrow) return;
	const now = Math.floor(Date.now() / 1000);
	const left = escrow.expiresAt - now;
	const total = Math.max(1, escrow.expiresAt - escrow.createdAt);

	if (left > 0) {
		els['escrow-clock-label'].textContent = 'Answer due in';
		els['escrow-clock'].textContent = countdown(left);
		els['escrow-bar-fill'].style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
		els['escrow-bar'].classList.toggle('is-late', left < total * 0.25);
		els.reclaim.hidden = true;
		return;
	}

	els['escrow-clock-label'].textContent = 'Window closed';
	els['escrow-clock'].textContent = 'Refundable now';
	els['escrow-bar-fill'].style.width = '0%';
	els['escrow-bar'].classList.add('is-late');
	els['escrow-note'].textContent =
		`${door.display_name} did not answer in time, so this is yours again. Anyone can send it back to you; the button below does it from this wallet.`;
	els.reclaim.hidden = false;
	stopClock();
}

function countdown(seconds) {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
	return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function onReclaim() {
	if (!escrow) return;
	els.reclaim.disabled = true;
	const label = els.reclaim.textContent;
	els.reclaim.textContent = 'Opening wallet…';
	try {
		const { reclaimKnock } = await import('./escrow-checkout.js');
		await reclaimKnock({
			knockAddress: escrow.knock,
			onStatus: (status) => { els.reclaim.textContent = `${status}…`; },
		});
		els['escrow-clock-label'].textContent = 'Refunded';
		els['escrow-clock'].textContent = escrow.amount;
		els['escrow-note'].textContent = 'Every unit went back to your wallet, and the escrow is closed.';
		els.reclaim.hidden = true;
	} catch (err) {
		els['escrow-note'].textContent = err?.message || 'That refund did not go through. Try again shortly.';
		els.reclaim.disabled = false;
		els.reclaim.textContent = label;
	}
}

function friendlyError(err) {
	const map = {
		door_closed: 'This door just closed.',
		door_full: 'This door has taken all the knocks it accepts today. Try tomorrow.',
		message_too_long: `Trim it to ${door?.max_chars ?? 600} characters.`,
		message_too_short: 'Say at least 8 characters.',
		bad_url: 'That link needs to be a plain http(s) URL.',
		payment_required: 'This door charges now. Reload the page to see the price.',
		// Escrowed lane. Each of these is the chain disagreeing with the
		// request, so each says what the sender still holds and what to do.
		knock_not_found: 'The escrow has not landed yet. Give it a few seconds and knock again.',
		escrow_not_enabled: 'This door stopped taking escrowed knocks. Reload the page to pay the normal way.',
		message_mismatch: 'That escrow was paid against a different message. Escrow again for this one.',
		already_settled: 'That escrow was already settled and cannot buy a second message.',
		window_closed: 'That escrow expired. Take it back below and knock again.',
		underpaid: 'This door raised its price after the escrow was paid. Take it back below and knock again.',
		no_payout_wallet: 'This door has no Solana address, so it has no on-chain door to knock at.',
	};
	if (err.status === 429) return 'Too many knocks from here for now. Try again a bit later.';
	return map[err.code] || err.message || 'That did not go through.';
}

function setError(message) {
	els['form-error'].textContent = message;
	els['form-error'].hidden = !message;
}

function showSent(result) {
	els.form.hidden = true;
	els.sent.hidden = false;
	lastReceiptUrl = result.receipt_url || result.receipt || null;
	if (result.paid) showEscrow(result.paid, result.escrow);
	els['sent-line'].textContent = result.duplicate
		? `Already delivered. ${door.display_name} has this one.`
		: `Delivered. ${door.display_name}'s companion will walk on and say who you are.`;
	els['receipt-url'].textContent = lastReceiptUrl || '';
	els['receipt-url'].hidden = !lastReceiptUrl;
	els['copy-receipt'].dataset.copy = lastReceiptUrl || '';
	els['copy-receipt'].hidden = !lastReceiptUrl;
	els['check-reply'].hidden = !lastReceiptUrl;
	els['reply-box'].hidden = true;
	els.sent.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function checkReply() {
	if (!lastReceiptUrl) return;
	els['check-reply'].disabled = true;
	const label = els['check-reply'].textContent;
	els['check-reply'].textContent = 'Checking…';
	try {
		const { knock } = await knockApi.receipt(lastReceiptUrl);
		els['reply-box'].hidden = false;
		els['reply-box'].textContent =
			knock.status === 'replied'
				? knock.reply
				: knock.status === 'dismissed'
					? 'They read it and moved on. No reply.'
					: knock.seen
						? 'Read. No reply written yet.'
						: 'Not opened yet.';
	} catch {
		els['reply-box'].hidden = false;
		els['reply-box'].textContent = 'Could not reach the receipt just now. Try again shortly.';
	} finally {
		els['check-reply'].disabled = false;
		els['check-reply'].textContent = label;
	}
}
