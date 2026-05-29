(function initApiPlayground() {
	var PG_ORIGIN = location.origin;
	var PG_DEMO = 'bacff13e-b64b-4ac0-860d-44f0168ad23b';

	var PG_ENDPOINTS = {
		'list-agents': {
			method: 'GET', path: '/api/agents', params: [],
			desc: 'List all agents in your account',
			auth: true,
			sampleBody: null,
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/agents', {\n  headers: { 'Authorization': 'Bearer YOUR_API_KEY' }\n});\nconst agents = await res.json();",
		},
		'create-agent': {
			method: 'POST', path: '/api/agents', params: [],
			desc: 'Create a new agent from avatar + prompt',
			auth: true,
			sampleBody: JSON.stringify({ name: 'my-agent', avatar_id: PG_DEMO, system_prompt: 'You are a helpful assistant.' }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/agents', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({\n    name: 'my-agent',\n    avatar_id: '" + PG_DEMO + "',\n    system_prompt: 'You are a helpful assistant.'\n  })\n});\nconst agent = await res.json();",
		},
		'chat': {
			method: 'POST', path: '/api/chat', params: [],
			desc: 'Send a message and stream a response',
			auth: false,
			sampleBody: JSON.stringify({ agent_id: PG_DEMO, message: 'Hello, who are you?', stream: false }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/chat', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({\n    agent_id: '" + PG_DEMO + "',\n    message: 'Hello, who are you?',\n    stream: false\n  })\n});\nconst reply = await res.json();",
		},
		'get-avatar': {
			method: 'GET', path: '/api/avatars/:id',
			params: [{ key: 'id', label: 'Avatar ID', placeholder: PG_DEMO, default: PG_DEMO }],
			desc: 'Fetch avatar metadata and GLB URL',
			auth: false,
			sampleBody: null,
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/avatars/" + PG_DEMO + "');\nconst avatar = await res.json();",
		},
		'mcp': {
			method: 'POST', path: '/api/mcp',
			params: [],
			desc: 'JSON-RPC 2.0 call to the MCP server',
			auth: false, paid: true,
			sampleBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/mcp', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({\n    jsonrpc: '2.0',\n    id: 1,\n    method: 'tools/list',\n    params: {}\n  })\n});\nconst result = await res.json();",
		},
		'a2a': {
			method: 'POST', path: '/api/agents/a2a-paid',
			params: [],
			desc: 'Agent-to-agent protocol endpoint (JSON-RPC 2.0)',
			auth: false,
			sampleBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ type: 'text', text: 'Inspect https://three.ws/avatars/default.glb' }] } } }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/agents/a2a-paid', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    jsonrpc: '2.0', id: 1,\n    method: 'message/send',\n    params: { message: { role: 'user', parts: [{ type: 'text', text: 'Inspect https://three.ws/avatars/default.glb' }] } }\n  })\n});\nconst result = await res.json();",
		},
	};

	var pgEl = function(id) { return document.getElementById(id); };
	var pgS = {
		tabs:      pgEl('pg-tabs'),
		empty:     pgEl('pg-empty-state'),
		builder:   pgEl('pg-builder'),
		key:       pgEl('pg-key'),
		method:    pgEl('pg-method'),
		path:      pgEl('pg-path'),
		params:    pgEl('pg-params'),
		bodyWrap:  pgEl('pg-body-wrap'),
		body:      pgEl('pg-body'),
		send:      pgEl('pg-send'),
		status:    pgEl('pg-status'),
		response:  pgEl('pg-response'),
		respBody:  pgEl('pg-response-body'),
		copyResp:  pgEl('pg-copy-resp'),
		sdkCode:   pgEl('pg-sdk-code'),
		curlCode:  pgEl('pg-curl-code'),
		endpoints: pgEl('pg-endpoints'),
	};

	if (!pgS.tabs || !pgS.endpoints) return;

	var pgActive = null;
	var PG_KEY_STORE = 'threews_pg_api_key';

	function pgGetKey() {
		return pgS.key ? pgS.key.value.trim() : '';
	}

	// Restore a previously-entered key and persist edits so the playground is
	// usable across reloads without re-pasting credentials.
	if (pgS.key) {
		try { pgS.key.value = localStorage.getItem(PG_KEY_STORE) || ''; } catch (_) {}
		pgS.key.addEventListener('input', function() {
			try { localStorage.setItem(PG_KEY_STORE, pgGetKey()); } catch (_) {}
			pgUpdateCurl();
			pgUpdateSdk();
		});
	}

	function pgHighlightJson(json) {
		return json
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"([^"]+)"(?=\s*:)/g, '<span class="json-key">"$1"</span>')
			.replace(/:\s*"([^"]*)"/g, ': <span class="json-str">"$1"</span>')
			.replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
			.replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
			.replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
	}

	function pgResolvePath(ep) {
		var p = ep.path;
		(ep.params || []).forEach(function(param) {
			var input = pgEl('pg-param-' + param.key);
			var val = input ? input.value.trim() : param.default;
			p = p.replace(':' + param.key, val || param.default);
		});
		return p;
	}

	function pgBuildCurl(ep) {
		var url = PG_ORIGIN + pgResolvePath(ep);
		var cmd = 'curl -X ' + ep.method + " '" + url + "'";
		var key = pgGetKey();
		if (ep.auth || key) {
			cmd += " \\\n  -H 'Authorization: Bearer " + (key || 'YOUR_API_KEY') + "'";
		}
		if (ep.sampleBody) {
			var body = pgS.body.value.trim() || ep.sampleBody;
			cmd += " \\\n  -H 'Content-Type: application/json'";
			cmd += " \\\n  -d '" + body.replace(/'/g, "'\\''") + "'";
		}
		return cmd;
	}

	function pgBuildSdk(ep) {
		var code = ep.sdk;
		(ep.params || []).forEach(function(param) {
			var input = pgEl('pg-param-' + param.key);
			var val = input ? input.value.trim() : param.default;
			if (val && val !== param.default) {
				code = code.split(param.default).join(val);
			}
		});
		var key = pgGetKey();
		if (key) code = code.split('YOUR_API_KEY').join(key);
		return code;
	}

	function pgUpdateCurl() {
		if (!pgActive) return;
		pgS.curlCode.textContent = pgBuildCurl(PG_ENDPOINTS[pgActive]);
	}

	function pgUpdateSdk() {
		if (!pgActive) return;
		var code = pgBuildSdk(PG_ENDPOINTS[pgActive]);
		pgS.sdkCode.innerHTML = code
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/\b(const|let|var|await|async|import|from|new)\b/g, '<span class="kw">$1</span>')
			.replace(/'([^']*)'/g, "'<span class=\"str\">$1</span>'");
	}

	function pgSelectEndpoint(key) {
		var ep = PG_ENDPOINTS[key];
		if (!ep) return;
		pgActive = key;

		pgS.endpoints.querySelectorAll('.dev-api-row').forEach(function(r) { r.classList.remove('active'); });
		var row = pgS.endpoints.querySelector('[data-endpoint="' + key + '"]');
		if (row) row.classList.add('active');

		pgS.empty.style.display = 'none';
		pgS.builder.style.display = 'block';

		pgS.method.textContent = ep.method;
		pgS.method.className = 'pg-url-method' + (ep.method === 'POST' ? ' post' : '');
		pgS.path.value = ep.path;

		pgS.params.innerHTML = '';
		(ep.params || []).forEach(function(param) {
			var div = document.createElement('div');
			div.className = 'pg-field';
			div.innerHTML = '<label class="pg-field-label">' + param.label + '</label><input class="pg-input" id="pg-param-' + param.key + '" placeholder="' + param.placeholder + '" value="' + param.default + '" />';
			pgS.params.appendChild(div);
			div.querySelector('input').addEventListener('input', function() {
				pgS.path.value = pgResolvePath(ep);
				pgUpdateCurl();
				pgUpdateSdk();
			});
		});
		pgS.path.value = pgResolvePath(ep);

		if (ep.sampleBody) {
			pgS.bodyWrap.style.display = 'block';
			pgS.body.value = ep.sampleBody;
		} else {
			pgS.bodyWrap.style.display = 'none';
			pgS.body.value = '';
		}

		pgS.response.style.display = 'none';
		pgS.status.textContent = '';
		pgS.status.className = 'pg-status';

		pgUpdateCurl();
		pgUpdateSdk();
	}

	// Tab switching
	pgS.tabs.addEventListener('click', function(e) {
		var tab = e.target.closest('.dev-tab');
		if (!tab) return;
		pgS.tabs.querySelectorAll('.dev-tab').forEach(function(t) { t.classList.remove('active'); });
		tab.classList.add('active');
		var target = tab.dataset.tab;
		document.querySelectorAll('#pg-left .dev-tab-content').forEach(function(c) { c.classList.remove('active'); });
		var panel = pgEl('pg-tab-' + target);
		if (panel) panel.classList.add('active');
	});

	// Endpoint selection
	pgS.endpoints.addEventListener('click', function(e) {
		var row = e.target.closest('.dev-api-row');
		if (!row || !row.dataset.endpoint) return;
		pgSelectEndpoint(row.dataset.endpoint);
		var tryitTab = pgS.tabs.querySelector('[data-tab="tryit"]');
		if (tryitTab && !tryitTab.classList.contains('active')) {
			tryitTab.click();
		}
	});

	function pgShowBody(text) {
		var display;
		try {
			display = pgHighlightJson(JSON.stringify(JSON.parse(text), null, 2));
		} catch (_) {
			display = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}
		pgS.respBody.innerHTML = display;
		pgS.response.style.display = 'block';
	}

	function pgSetStatus(status, statusText, elapsed) {
		var label = status + (statusText ? ' ' + statusText : '') + ' · ' + elapsed + 'ms';
		if (status === 402) {
			// The 402 with payment requirements IS the correct x402 response, not a
			// failure — present the challenge as informational, not a red error.
			pgS.status.textContent = label + ' · x402 — paid endpoint, response is the payment challenge';
			pgS.status.className = 'pg-status warn';
		} else if (status === 401) {
			var hint = pgGetKey() ? ' · check your API key' : ' · add an API key above or sign in';
			pgS.status.textContent = label + hint;
			pgS.status.className = 'pg-status err';
		} else {
			pgS.status.textContent = label;
			pgS.status.className = 'pg-status ' + (status >= 200 && status < 300 ? 'ok' : 'err');
		}
	}

	// Server-Sent Events (e.g. /api/chat) stream `data: {type:'chunk',text}` lines.
	// Accumulate the assistant text and render it live instead of dumping raw SSE.
	async function pgRenderStream(res, t0) {
		var reader = res.body.getReader();
		var decoder = new TextDecoder();
		var buf = '', acc = '', raw = '';
		pgS.response.style.display = 'block';
		pgS.respBody.textContent = '';
		pgS.status.textContent = res.status + ' · streaming…';
		pgS.status.className = 'pg-status ok';
		while (true) {
			var step = await reader.read();
			if (step.done) break;
			buf += decoder.decode(step.value, { stream: true });
			var lines = buf.split('\n');
			buf = lines.pop();
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i].trim();
				if (line.indexOf('data:') !== 0) continue;
				var payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				raw += payload + '\n';
				try {
					var evt = JSON.parse(payload);
					var t = evt.text != null ? evt.text : evt.delta;
					if (typeof t === 'string') acc += t;
				} catch (_) {}
				pgS.respBody.textContent = acc || raw;
			}
		}
		var elapsed = Math.round(performance.now() - t0);
		pgS.status.textContent = res.status + ' OK · ' + elapsed + 'ms · streamed';
		pgS.status.className = 'pg-status ok';
		pgS.respBody.textContent = acc || raw || '(empty stream)';
	}

	// Send request
	pgS.send.addEventListener('click', async function() {
		if (!pgActive) return;
		var ep = PG_ENDPOINTS[pgActive];
		var url = PG_ORIGIN + pgResolvePath(ep);
		var key = pgGetKey();

		pgS.send.disabled = true;
		pgS.send.textContent = 'Sending…';
		pgS.status.textContent = '';
		pgS.status.className = 'pg-status';
		pgS.response.style.display = 'none';

		var t0 = performance.now();
		try {
			var headers = {};
			if (key) headers['Authorization'] = 'Bearer ' + key;
			// credentials: 'include' lets a signed-in browser session authenticate
			// without a key; a pasted key takes precedence via the header above.
			var opts = { method: ep.method, headers: headers, credentials: 'include' };
			if (ep.sampleBody) {
				headers['Content-Type'] = 'application/json';
				opts.body = pgS.body.value.trim() || ep.sampleBody;
			}
			var res = await fetch(url, opts);
			var contentType = res.headers.get('content-type') || '';

			if (contentType.indexOf('text/event-stream') !== -1 && res.body) {
				await pgRenderStream(res, t0);
			} else {
				var elapsed = Math.round(performance.now() - t0);
				var text = await res.text();
				pgSetStatus(res.status, res.statusText, elapsed);
				pgShowBody(text);
			}
		} catch (err) {
			pgS.status.textContent = 'Network error';
			pgS.status.className = 'pg-status err';
			pgS.respBody.textContent = err.message;
			pgS.response.style.display = 'block';
		} finally {
			pgS.send.disabled = false;
			pgS.send.textContent = 'Send';
		}
	});

	// Copy response
	pgS.copyResp.addEventListener('click', function() {
		var text = pgS.respBody.textContent;
		navigator.clipboard.writeText(text).then(function() {
			pgS.copyResp.textContent = 'Copied';
			setTimeout(function() { pgS.copyResp.textContent = 'Copy'; }, 1500);
		}).catch(function() {});
	});

	// Update curl when body changes
	pgS.body.addEventListener('input', pgUpdateCurl);
})();
