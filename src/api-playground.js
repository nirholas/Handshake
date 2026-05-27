(function initApiPlayground() {
	var PG_ORIGIN = location.origin;
	var PG_DEMO = 'bacff13e-b64b-4ac0-860d-44f0168ad23b';

	var PG_ENDPOINTS = {
		'list-agents': {
			method: 'GET', path: '/api/agents', params: [],
			desc: 'List all agents in your account',
			sampleBody: null,
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/agents', {\n  headers: { 'Authorization': 'Bearer YOUR_API_KEY' }\n});\nconst agents = await res.json();",
		},
		'create-agent': {
			method: 'POST', path: '/api/agents', params: [],
			desc: 'Create a new agent from avatar + prompt',
			sampleBody: JSON.stringify({ name: 'my-agent', avatar_id: PG_DEMO, system_prompt: 'You are a helpful assistant.' }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/agents', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({\n    name: 'my-agent',\n    avatar_id: '" + PG_DEMO + "',\n    system_prompt: 'You are a helpful assistant.'\n  })\n});\nconst agent = await res.json();",
		},
		'chat': {
			method: 'POST', path: '/api/chat', params: [],
			desc: 'Send a message and stream a response',
			sampleBody: JSON.stringify({ agent_id: PG_DEMO, message: 'Hello, who are you?', stream: false }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/chat', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({\n    agent_id: '" + PG_DEMO + "',\n    message: 'Hello, who are you?',\n    stream: false\n  })\n});\nconst reply = await res.json();",
		},
		'get-avatar': {
			method: 'GET', path: '/api/avatars/:id',
			params: [{ key: 'id', label: 'Avatar ID', placeholder: PG_DEMO, default: PG_DEMO }],
			desc: 'Fetch avatar metadata and GLB URL',
			sampleBody: null,
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/avatars/" + PG_DEMO + "');\nconst avatar = await res.json();",
		},
		'mcp': {
			method: 'POST', path: '/api/mcp',
			params: [],
			desc: 'JSON-RPC 2.0 call to the MCP server',
			sampleBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/mcp', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer YOUR_API_KEY',\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({\n    jsonrpc: '2.0',\n    id: 1,\n    method: 'tools/list',\n    params: {}\n  })\n});\nconst result = await res.json();",
		},
		'a2a': {
			method: 'POST', path: '/api/agents/:agentId/a2a',
			params: [{ key: 'agentId', label: 'Agent ID', placeholder: PG_DEMO, default: PG_DEMO }],
			desc: 'Agent-to-agent protocol endpoint',
			sampleBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] } } }, null, 2),
			sdk: "const res = await fetch('" + PG_ORIGIN + "/api/agents/" + PG_DEMO + "/a2a', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    jsonrpc: '2.0', id: 1,\n    method: 'message/send',\n    params: { message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] } }\n  })\n});\nconst result = await res.json();",
		},
	};

	var pgEl = function(id) { return document.getElementById(id); };
	var pgS = {
		tabs:      pgEl('pg-tabs'),
		empty:     pgEl('pg-empty-state'),
		builder:   pgEl('pg-builder'),
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
		cmd += " \\\n  -H 'Authorization: Bearer YOUR_API_KEY'";
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

	// Send request
	pgS.send.addEventListener('click', async function() {
		if (!pgActive) return;
		var ep = PG_ENDPOINTS[pgActive];
		var url = PG_ORIGIN + pgResolvePath(ep);

		pgS.send.disabled = true;
		pgS.send.textContent = 'Sending…';
		pgS.status.textContent = '';
		pgS.status.className = 'pg-status';
		pgS.response.style.display = 'none';

		var t0 = performance.now();
		try {
			var opts = { method: ep.method, headers: {} };
			if (ep.sampleBody) {
				opts.headers['Content-Type'] = 'application/json';
				opts.body = pgS.body.value.trim() || ep.sampleBody;
			}
			var res = await fetch(url, opts);
			var elapsed = Math.round(performance.now() - t0);
			var text = await res.text();

			pgS.status.textContent = res.status + ' ' + res.statusText + ' · ' + elapsed + 'ms';
			pgS.status.className = 'pg-status ' + (res.ok ? 'ok' : 'err');

			var display;
			try {
				var parsed = JSON.parse(text);
				display = pgHighlightJson(JSON.stringify(parsed, null, 2));
			} catch (_) {
				display = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			}
			pgS.respBody.innerHTML = display;
			pgS.response.style.display = 'block';
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
