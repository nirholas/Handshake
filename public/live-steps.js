/*
 * Live steps - runnable API calls embedded directly in three.ws documentation.
 * ============================================================================
 *
 * WHAT IT IS
 * A tutorial author writes a fenced ```live block naming a step id. The viewer
 * replaces that block with an interactive card that performs the REAL request
 * against the live three.ws API, in the reader's browser, and renders the real
 * response. No mocked payloads, no recorded fixtures: the reader sees what the
 * platform is actually returning right now, and can copy it.
 *
 * THE SECURITY MODEL (the reason this design, and not "let markdown name a URL")
 * Markdown is content. Content must never be able to choose what request the
 * page makes. So:
 *
 *   1. Markdown SELECTS, code DECIDES. A ```live block may only reference a
 *      step id from the STEPS registry below. An unknown id renders a visible
 *      "unknown step" card and issues no request at all.
 *   2. GET only. validateRegistry() throws at load if any entry declares
 *      another method, so no live step can ever mutate platform state.
 *   3. Paths are literal constants. Reader input and chained values only ever
 *      land in query-string values, URL-encoded. Nothing interpolates into the
 *      path or the origin, so no live step can be pointed at another host.
 *   4. Responses render through the DOM (textContent + built spans), never
 *      innerHTML, so a hostile payload cannot inject markup.
 *   5. Session-shaped fields (sid, csrf, tokens) are redacted from the DISPLAY
 *      before painting. Chained exports read the raw body, so a redacted field
 *      still works as an input to the next step without ever being on screen.
 *
 * WIRING
 * Loaded as a classic script (like /tutorials-manifest.js) and used as:
 *
 *   LiveSteps.mount(articleElement);
 *
 * called after the markdown has been parsed into the article. Styles live in
 * /live-steps.css. Authoring guide: /docs/live-steps.md.
 */
(function () {
	'use strict';

	/* ══════════════════════════════════════════════════════════════════════
	 * Derivations - pure client-side transforms, referenced by name from the
	 * registry. A derive step performs no network call; it turns values that
	 * earlier steps exported into the exact artifact the reader needs to see.
	 * ══════════════════════════════════════════════════════════════════════ */

	const SIWS_STATEMENT =
		'Sign in to three.ws. This request will not trigger any blockchain transaction or cost ' +
		'any fees. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and ' +
		'Privacy Policy (https://three.ws/legal/privacy).';

	const DERIVATIONS = {
		/*
		 * Assemble the CAIP-122 message a Solana wallet signs. This is the step
		 * integrations get wrong most often: the blank lines are structural, the
		 * chain id is a network name rather than an EIP-155 number, and domain
		 * and uri must come from the nonce response rather than from location.
		 */
		siwsMessage(vars) {
			const address = vars.address || '<your-solana-address>';
			const issuedAt = new Date();
			const expiration = new Date(issuedAt.getTime() + 5 * 60 * 1000);
			return [
				`${vars.domain} wants you to sign in with your Solana account:`,
				address,
				'',
				SIWS_STATEMENT,
				'',
				`URI: ${vars.uri}`,
				'Version: 1',
				'Chain ID: mainnet',
				`Nonce: ${vars.nonce}`,
				`Issued At: ${issuedAt.toISOString()}`,
				`Expiration Time: ${expiration.toISOString()}`,
			].join('\n');
		},
	};

	/* ══════════════════════════════════════════════════════════════════════
	 * The registry - the complete set of calls documentation is allowed to
	 * make. Adding a row here is a code change, reviewed like any other.
	 *
	 *   id          referenced from markdown
	 *   kind        'request' (network) or 'derive' (pure, local)
	 *   title       card heading
	 *   summary     one line explaining what the reader is about to observe
	 *   docs        deep link to the reference entry for this endpoint
	 *   inputs      reader-editable query parameters
	 *   uses        variable names this step consumes from earlier steps
	 *   exports     variable name -> key in the response body
	 * ══════════════════════════════════════════════════════════════════════ */

	const STEPS = [
		{
			id: 'version',
			kind: 'request',
			method: 'GET',
			path: '/api/version',
			title: 'Ask the platform what it is running',
			summary:
				'Returns the exact commit and Cloud Run revision serving this page. Useful as a first call when a fix you expect is not showing up.',
			docs: '/docs/#api-reference',
			credentials: 'omit',
			inputs: [],
			exports: { commit: 'commitShort' },
		},
		{
			id: 'platform-stats',
			kind: 'request',
			method: 'GET',
			path: '/api/platform/stats',
			title: 'Read the live platform counters',
			summary:
				'Agents, avatars, widgets and chains, counted at request time. These are the numbers behind the homepage.',
			docs: '/docs/#api-reference',
			credentials: 'omit',
			inputs: [],
			exports: {},
		},
		{
			id: 'agents-public',
			kind: 'request',
			method: 'GET',
			path: '/api/agents/public',
			title: 'List public agents',
			summary:
				'The public agent directory, cursor-paginated. No key and no session: this is the same data the discover page renders.',
			docs: '/docs/#api-reference',
			credentials: 'omit',
			inputs: [
				{
					name: 'limit',
					label: 'limit',
					value: '3',
					placeholder: '3',
					hint: 'How many agents to return (1-50).',
				},
			],
			exports: {},
		},
		{
			id: 'skills-catalog',
			kind: 'request',
			method: 'GET',
			path: '/api/skills',
			title: 'Browse the skill catalog',
			summary:
				'Every published skill with its category, install count, rating and per-call price. This is what an agent shops from.',
			docs: '/docs/#api-reference',
			credentials: 'omit',
			inputs: [
				{
					name: 'limit',
					label: 'limit',
					value: '3',
					placeholder: '3',
					hint: 'How many skills to return.',
				},
			],
			exports: {},
		},
		{
			id: 'three-leaderboard',
			kind: 'request',
			method: 'GET',
			path: '/api/leaderboard',
			title: 'Read the $THREE holder leaderboard',
			summary:
				'Live holder ranks, tiers and supply share for $THREE, read straight from chain state. Holder tier is what gates the premium surfaces.',
			docs: '/docs/#api-reference',
			credentials: 'omit',
			inputs: [
				{
					name: 'limit',
					label: 'limit',
					value: '3',
					placeholder: '3',
					hint: 'How many ranked holders to return.',
				},
			],
			exports: {},
		},
		{
			id: 'auth-me',
			kind: 'request',
			method: 'GET',
			path: '/api/auth/me',
			title: 'Ask who you are signed in as',
			summary:
				'Sent with your cookies. If you are signed in on this browser you will see your own account; if not, you will see the signed-out shape that trips most integrations.',
			docs: '/docs/#authentication',
			credentials: 'include',
			inputs: [],
			exports: {},
		},
		{
			id: 'siws-nonce',
			kind: 'request',
			method: 'GET',
			path: '/api/auth/siws/nonce',
			title: 'Mint a Solana sign-in nonce',
			summary:
				'A single-use nonce with a five minute life, plus the canonical domain and uri your signed message must carry. Reading it here costs nothing and signs you into nothing.',
			docs: '/docs/#authentication',
			credentials: 'include',
			inputs: [],
			exports: {
				nonce: 'nonce',
				domain: 'domain',
				uri: 'uri',
				expiresAt: 'expiresAt',
			},
		},
		{
			id: 'siws-message',
			kind: 'derive',
			derive: 'siwsMessage',
			title: 'Build the exact bytes to sign',
			summary:
				'Composed locally from the nonce response. This is the string your wallet signs, byte for byte, and the one place integrations most often go wrong.',
			docs: '/tutorials/wallet-sign-in',
			uses: ['nonce', 'domain', 'uri'],
			inputs: [
				{
					name: 'address',
					label: 'address',
					value: '',
					placeholder: 'Your Solana address (optional)',
					hint: 'Left blank, the message shows a placeholder in the address line.',
				},
			],
		},
	];

	/* ══════════════════════════════════════════════════════════════════════
	 * Registry validation. These are the invariants the security model rests
	 * on, so they are checked at load and throw rather than degrade.
	 * ══════════════════════════════════════════════════════════════════════ */

	const SAFE_PATH = /^\/api\/[A-Za-z0-9][A-Za-z0-9/_-]*$/;
	const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

	function validateRegistry(steps) {
		const seen = new Set();
		const produced = new Set();
		for (const step of steps) {
			if (!step.id || seen.has(step.id)) {
				throw new Error(`live-steps: duplicate or missing step id "${step.id}"`);
			}
			seen.add(step.id);
			if (step.kind !== 'request' && step.kind !== 'derive') {
				throw new Error(`live-steps: ${step.id} has unknown kind "${step.kind}"`);
			}
			for (const input of step.inputs || []) {
				if (!SAFE_NAME.test(input.name)) {
					throw new Error(`live-steps: ${step.id} has unsafe input name "${input.name}"`);
				}
			}
			for (const name of step.uses || []) {
				if (!produced.has(name)) {
					throw new Error(
						`live-steps: ${step.id} uses "${name}", which no earlier step exports`,
					);
				}
			}
			if (step.kind === 'request') {
				if (step.method !== 'GET') {
					throw new Error(
						`live-steps: ${step.id} declares ${step.method}; live steps are read-only`,
					);
				}
				if (!SAFE_PATH.test(step.path) || step.path.includes('..')) {
					throw new Error(`live-steps: ${step.id} has an unsafe path "${step.path}"`);
				}
				for (const name of Object.keys(step.exports || {})) {
					if (!SAFE_NAME.test(name)) {
						throw new Error(`live-steps: ${step.id} exports unsafe name "${name}"`);
					}
					produced.add(name);
				}
			} else {
				if (typeof DERIVATIONS[step.derive] !== 'function') {
					throw new Error(`live-steps: ${step.id} names unknown derivation "${step.derive}"`);
				}
				if (!(step.uses || []).length) {
					throw new Error(`live-steps: ${step.id} is a derive step with no inputs to derive from`);
				}
			}
		}
		return true;
	}

	validateRegistry(STEPS);

	const BY_ID = new Map(STEPS.map((s) => [s.id, s]));
	/* variable name -> id of the step that produces it, for prerequisite chasing. */
	const PRODUCER = new Map();
	for (const step of STEPS) {
		for (const name of Object.keys(step.exports || {})) {
			if (!PRODUCER.has(name)) PRODUCER.set(name, step.id);
		}
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * Redaction. Session-shaped fields are stripped from the rendered copy so
	 * that a reader screenshotting the docs, or a page recorded by a session
	 * replay tool, never carries a usable credential. Exports read the raw
	 * body, so redaction costs the reader nothing.
	 * ══════════════════════════════════════════════════════════════════════ */

	const SECRET_KEY =
		/^(sid|csrf|csrf_token|token|access_token|refresh_token|id_token|secret|authorization|cookie|session|password|private_key|privatekey|api_key|apikey)$/i;
	const REDACTED = '[redacted in this view]';

	function redact(value) {
		let count = 0;
		const walk = (node) => {
			if (Array.isArray(node)) return node.map(walk);
			if (node && typeof node === 'object') {
				const out = {};
				for (const [key, val] of Object.entries(node)) {
					if (SECRET_KEY.test(key) && val !== null && val !== '') {
						out[key] = REDACTED;
						count += 1;
					} else {
						out[key] = walk(val);
					}
				}
				return out;
			}
			return node;
		};
		return { value: walk(value), count };
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * URL building. Query values are the only place reader input reaches the
	 * request, and they go through URLSearchParams, so they are encoded.
	 * ══════════════════════════════════════════════════════════════════════ */

	function buildUrl(step, values) {
		const params = new URLSearchParams();
		for (const input of step.inputs || []) {
			const raw = values[input.name];
			if (raw === undefined || raw === null || String(raw).trim() === '') continue;
			params.set(input.name, String(raw).trim());
		}
		const qs = params.toString();
		return qs ? `${step.path}?${qs}` : step.path;
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * Rendering helpers.
	 * ══════════════════════════════════════════════════════════════════════ */

	const SVG = 'http://www.w3.org/2000/svg';

	function icon(paths, extra) {
		const svg = document.createElementNS(SVG, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', extra || '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.setAttribute('aria-hidden', 'true');
		for (const d of paths) {
			const p = document.createElementNS(SVG, 'path');
			p.setAttribute('d', d);
			svg.appendChild(p);
		}
		return svg;
	}

	const ICONS = {
		play: () => icon(['M7 4.5v15l12-7.5z'], '1.6'),
		check: () => icon(['M20 6 9 17l-5-5'], '2.4'),
		copy: () => icon(['M9 9h9a2 2 0 0 1 2 2v9H9z', 'M5 15V5a2 2 0 0 1 2-2h10']),
		alert: () => icon(['M12 8v5', 'M12 17h.01', 'M12 3 2 20h20z']),
		link: () => icon(['M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.71-1.71']),
		chain: () => icon(['M4 12h6', 'M14 12h6', 'M11 8l3 8'], '1.8'),
	};

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	/*
	 * Paint JSON without innerHTML: tokens become spans, everything else stays
	 * a text node, so no response body can inject markup into the page.
	 */
	const JSON_TOKEN =
		/("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)/g;

	function paintJson(text) {
		const frag = document.createDocumentFragment();
		let last = 0;
		let match;
		JSON_TOKEN.lastIndex = 0;
		while ((match = JSON_TOKEN.exec(text)) !== null) {
			if (match.index > last) {
				frag.appendChild(document.createTextNode(text.slice(last, match.index)));
			}
			const cls = match[1] ? 'ls-key' : match[2] ? 'ls-str' : match[3] ? 'ls-num' : 'ls-lit';
			frag.appendChild(el('span', cls, match[0]));
			last = match.index + match[0].length;
		}
		if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
		return frag;
	}

	function copyButton(getText) {
		const btn = el('button', 'ls-copy');
		btn.type = 'button';
		const label = el('span', null, 'Copy');
		btn.append(ICONS.copy(), label);
		btn.setAttribute('aria-label', 'Copy this response to the clipboard');
		let timer = null;
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(getText());
				btn.replaceChildren(ICONS.check(), el('span', null, 'Copied'));
				btn.classList.add('is-copied');
			} catch {
				btn.replaceChildren(ICONS.copy(), el('span', null, 'Press Ctrl+C'));
			}
			clearTimeout(timer);
			timer = setTimeout(() => {
				btn.classList.remove('is-copied');
				btn.replaceChildren(ICONS.copy(), el('span', null, 'Copy'));
			}, 1800);
		});
		return btn;
	}

	function formatBytes(n) {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	/*
	 * Turn a failed request into something the reader can act on. A live step
	 * that says "something went wrong" teaches nothing, so every branch here
	 * names the cause and the next move.
	 */
	function explainFailure(status, body) {
		if (status === 0) {
			return 'The request never reached the API. You are probably offline, or an extension is blocking requests from this page.';
		}
		if (status === 401 || status === 403) {
			return 'The API answered, and told us this call needs a signed-in session. That is the correct answer for a signed-out browser.';
		}
		if (status === 404) {
			return 'The API answered, but no route matched. If you are reading a cached copy of this page, reload it.';
		}
		if (status === 429) {
			return 'Rate limited. The live steps share your IP allowance with the rest of the site, so wait a few seconds and run it again.';
		}
		if (status >= 500) {
			return 'The API failed on its side. This is a real production response, not a mock, so it is worth reporting if it persists.';
		}
		const described = body && (body.error_description || body.error);
		return described
			? `The API rejected the request: ${described}`
			: 'The API answered with an unexpected status.';
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * The card.
	 * ══════════════════════════════════════════════════════════════════════ */

	function createCard(step, block, ctx) {
		const card = el('section', 'ls-card');
		card.dataset.step = step.id;
		card.dataset.state = 'idle';
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', `Live step: ${step.title}`);

		/* Header: what this call is, and where the reference for it lives. */
		const head = el('header', 'ls-head');
		const badge = el('span', 'ls-badge');
		badge.append(
			el('span', 'ls-badge-dot'),
			el('span', null, step.kind === 'derive' ? 'LOCAL' : 'LIVE'),
		);
		head.appendChild(badge);

		const titles = el('div', 'ls-titles');
		titles.appendChild(el('h4', 'ls-title', block.title || step.title));
		const target = el('p', 'ls-target');
		if (step.kind === 'request') {
			target.append(el('span', 'ls-method', step.method), el('code', 'ls-path', step.path));
		} else {
			target.append(el('span', 'ls-method ls-method-local', 'DERIVE'), el('code', 'ls-path', 'runs in this page, no request'));
		}
		titles.appendChild(target);
		head.appendChild(titles);

		if (step.docs) {
			const ref = el('a', 'ls-ref');
			ref.href = step.docs;
			ref.append(ICONS.link(), el('span', null, 'Reference'));
			head.appendChild(ref);
		}
		card.appendChild(head);

		card.appendChild(el('p', 'ls-summary', block.note || step.summary));

		/* Chained variables: name what this step needs and where it comes from. */
		if ((step.uses || []).length) {
			const chain = el('p', 'ls-chain');
			chain.appendChild(ICONS.chain());
			chain.appendChild(
				el(
					'span',
					null,
					`Uses ${step.uses.join(', ')} from the ${BY_ID.get(PRODUCER.get(step.uses[0])).title.toLowerCase()} step above.`,
				),
			);
			card.appendChild(chain);
		}

		/* Reader-editable query parameters. */
		const values = {};
		if ((step.inputs || []).length) {
			const form = el('div', 'ls-inputs');
			for (const input of step.inputs) {
				values[input.name] = input.value;
				const field = el('label', 'ls-field');
				field.appendChild(el('span', 'ls-field-label', input.label));
				const box = el('input', 'ls-input');
				box.type = 'text';
				box.value = input.value;
				box.placeholder = input.placeholder || '';
				box.spellcheck = false;
				box.autocomplete = 'off';
				if (input.hint) box.title = input.hint;
				box.addEventListener('input', () => {
					values[input.name] = box.value;
					if (step.kind === 'request') urlPreview.textContent = buildUrl(step, values);
				});
				field.appendChild(box);
				if (input.hint) field.appendChild(el('span', 'ls-field-hint', input.hint));
				form.appendChild(field);
			}
			card.appendChild(form);
		}

		/* Action row: the button, the resolved URL, and the result meta. */
		const actions = el('div', 'ls-actions');
		const run = el('button', 'ls-run');
		run.type = 'button';
		run.append(ICONS.play(), el('span', 'ls-run-label', step.kind === 'derive' ? 'Build it' : 'Run it'));
		actions.appendChild(run);

		const urlPreview = el('code', 'ls-url');
		urlPreview.textContent = step.kind === 'request' ? buildUrl(step, values) : '';
		if (step.kind === 'request') actions.appendChild(urlPreview);

		const meta = el('span', 'ls-meta');
		actions.appendChild(meta);
		card.appendChild(actions);

		/* Result region. Announced politely so a screen reader hears the outcome. */
		const result = el('div', 'ls-result');
		result.setAttribute('aria-live', 'polite');
		card.appendChild(result);

		function setState(state) {
			card.dataset.state = state;
		}

		function showBody(text, isJson) {
			result.replaceChildren();
			const shell = el('div', 'ls-body');
			const pre = el('pre', 'ls-pre');
			const code = el('code');
			if (isJson) code.appendChild(paintJson(text));
			else code.textContent = text;
			pre.appendChild(code);
			shell.append(pre, copyButton(() => text));
			result.appendChild(shell);
			return shell;
		}

		function showNote(className, text) {
			const note = el('p', `ls-note ${className}`);
			if (className === 'is-error') note.appendChild(ICONS.alert());
			note.appendChild(el('span', null, text));
			result.appendChild(note);
		}

		async function execute() {
			if (card.dataset.state === 'running') return;

			/* A derive step needs its inputs; offer to produce them rather than fail. */
			if (step.kind === 'derive') {
				const missing = (step.uses || []).filter((name) => !(name in ctx.vars));
				if (missing.length) {
					const producerId = PRODUCER.get(missing[0]);
					setState('idle');
					result.replaceChildren();
					showNote(
						'is-hint',
						`This step needs ${missing.join(', ')}. Running the ${BY_ID.get(producerId).title.toLowerCase()} step first.`,
					);
					const ok = await ctx.runStep(producerId);
					if (!ok) return;
				}
				const vars = Object.assign({}, ctx.vars, values);
				const text = DERIVATIONS[step.derive](vars);
				setState('ok');
				meta.replaceChildren(el('span', 'ls-pill ls-pill-ok', 'built'), el('span', 'ls-dim', `${text.length} chars`));
				showBody(text, false);
				showNote('is-hint', 'Every line matters: the two blank lines are structural, and Chain ID is a network name rather than a number.');
				return true;
			}

			setState('running');
			run.disabled = true;
			meta.replaceChildren(el('span', 'ls-spinner'), el('span', 'ls-dim', 'calling the live API'));
			result.replaceChildren();

			const url = buildUrl(step, values);
			urlPreview.textContent = url;
			const started = performance.now();
			let status = 0;
			let text = '';
			let parsed = null;
			try {
				const res = await fetch(url, {
					method: step.method,
					credentials: step.credentials === 'include' ? 'include' : 'omit',
					headers: { accept: 'application/json' },
				});
				status = res.status;
				text = await res.text();
			} catch {
				status = 0;
			}
			const ms = Math.round(performance.now() - started);
			run.disabled = false;

			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = null;
			}

			const ok = status >= 200 && status < 300;
			setState(ok ? 'ok' : 'error');
			meta.replaceChildren(
				el('span', `ls-pill ${ok ? 'ls-pill-ok' : 'ls-pill-bad'}`, status ? String(status) : 'no response'),
				el('span', 'ls-dim', `${ms} ms`),
				el('span', 'ls-dim', formatBytes(new Blob([text]).size)),
			);

			if (parsed !== null) {
				const { value, count } = redact(parsed);
				showBody(JSON.stringify(value, null, 2), true);
				if (count) {
					showNote(
						'is-hint',
						`${count} session-shaped ${count === 1 ? 'field is' : 'fields are'} hidden in this view so the page never carries a usable credential. Your own call receives the real values.`,
					);
				}
			} else if (text) {
				showBody(text, false);
			}

			if (!ok) {
				showNote('is-error', explainFailure(status, parsed));
				return false;
			}

			/* Publish exports for later steps, from the RAW body. */
			const exported = [];
			for (const [name, key] of Object.entries(step.exports || {})) {
				if (parsed && parsed[key] !== undefined && parsed[key] !== null) {
					ctx.vars[name] = parsed[key];
					exported.push(name);
				}
			}
			if (exported.length) {
				showNote('is-ok', `Later steps on this page can now use ${exported.join(', ')}.`);
				ctx.onExport();
			}
			return true;
		}

		run.addEventListener('click', () => {
			execute();
		});

		return { card, execute, step };
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * Unknown-step placeholder. A typo in markdown must be visible to the
	 * author and inert for the reader, never a silent no-op.
	 * ══════════════════════════════════════════════════════════════════════ */

	function unknownCard(id) {
		const card = el('section', 'ls-card');
		card.dataset.state = 'error';
		const head = el('header', 'ls-head');
		head.appendChild(el('span', 'ls-badge ls-badge-bad', 'UNKNOWN'));
		const titles = el('div', 'ls-titles');
		titles.appendChild(el('h4', 'ls-title', 'This live step is not registered'));
		titles.appendChild(el('p', 'ls-target', `No step with id "${id}" exists.`));
		head.appendChild(titles);
		card.appendChild(head);
		card.appendChild(
			el(
				'p',
				'ls-summary',
				'Documentation may only run calls that are registered in public/live-steps.js, so nothing was requested. Add the step to the registry, or fix the id in the markdown.',
			),
		);
		return card;
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * Toolbar. Appears once a page carries more than one live step, so a
	 * reader can watch the whole flow run in order without hunting buttons.
	 * ══════════════════════════════════════════════════════════════════════ */

	function createToolbar(cards, ctx) {
		const bar = el('div', 'ls-toolbar');
		const label = el('div', 'ls-toolbar-text');
		label.appendChild(el('strong', null, 'This page runs.'));
		label.appendChild(
			el(
				'span',
				null,
				` ${cards.length} steps below call the live three.ws API from your browser and show the real response.`,
			),
		);
		bar.appendChild(label);

		const runAll = el('button', 'ls-run ls-run-all');
		runAll.type = 'button';
		runAll.append(ICONS.play(), el('span', null, 'Run every step'));
		runAll.addEventListener('click', async () => {
			runAll.disabled = true;
			runAll.replaceChildren(el('span', 'ls-spinner'), el('span', null, 'Running'));
			for (const entry of cards) {
				entry.card.scrollIntoView({ block: 'center', behavior: ctx.reduceMotion ? 'auto' : 'smooth' });
				await entry.execute();
			}
			runAll.disabled = false;
			runAll.replaceChildren(ICONS.check(), el('span', null, 'Ran every step'));
		});
		bar.appendChild(runAll);
		return bar;
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * mount(root) - swap every ```live block in `root` for a card.
	 * ══════════════════════════════════════════════════════════════════════ */

	function mount(root) {
		if (!root) return [];
		const blocks = root.querySelectorAll('pre > code.language-live');
		if (!blocks.length) return [];

		const ctx = {
			vars: Object.create(null),
			reduceMotion:
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(prefers-reduced-motion: reduce)').matches,
			onExport() {},
			async runStep(id) {
				const entry = mounted.find((m) => m.step.id === id);
				return entry ? entry.execute() : false;
			},
		};

		const mounted = [];
		for (const code of blocks) {
			const pre = code.parentElement;
			let spec;
			try {
				spec = JSON.parse(code.textContent);
			} catch {
				spec = null;
			}
			const step = spec && BY_ID.get(spec.step);
			if (!step) {
				pre.replaceWith(unknownCard(spec ? spec.step : 'malformed block'));
				continue;
			}
			const entry = createCard(step, spec, ctx);
			pre.replaceWith(entry.card);
			mounted.push(entry);
		}

		if (mounted.length > 1) {
			mounted[0].card.parentNode.insertBefore(createToolbar(mounted, ctx), mounted[0].card);
		}
		return mounted;
	}

	window.LiveSteps = {
		STEPS,
		DERIVATIONS,
		validateRegistry,
		redact,
		buildUrl,
		explainFailure,
		mount,
	};
})();
