// ── Interactive Bento Features ─────────────────────────────────────
(function initBentoInteractives() {

	// ── 1. Avatar Studio: capture a real photo, hand it to the real flow ──
	// This is a teaser. It does NOT fabricate a build — it captures the
	// visitor's photo, stashes it for the real selfie pipeline, and sends
	// them to /create-selfie where the actual reconstruction runs. The photo
	// is downscaled before storage so it fits comfortably in sessionStorage.
	(function() {
		var HANDOFF_KEY = 'threews:selfie-handoff';
		var MAX_DIM = 1024;

		var drop = document.getElementById('studio-drop');
		var fileInput = document.getElementById('studio-file');
		var webcamBtn = document.getElementById('studio-webcam-btn');
		var zone = document.getElementById('studio-zone');
		var ready = document.getElementById('studio-ready');
		var previewImg = document.getElementById('studio-preview-img');
		var resetBtn = document.getElementById('studio-reset');
		var errorEl = document.getElementById('studio-error');
		if (!drop) return;

		function showError(msg) {
			if (!errorEl) return;
			errorEl.textContent = msg;
			errorEl.classList.add('show');
			errorEl.hidden = false;
		}
		function clearError() {
			if (!errorEl) return;
			errorEl.classList.remove('show');
			errorEl.hidden = true;
		}

		// Load → downscale → JPEG data URL. Keeps storage small and strips EXIF.
		function toDataUrl(file) {
			return new Promise(function(resolve, reject) {
				if (!file || !/^image\//.test(file.type)) { reject(new Error('not an image')); return; }
				var url = URL.createObjectURL(file);
				var img = new Image();
				img.onload = function() {
					var scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
					var w = Math.max(1, Math.round(img.naturalWidth * scale));
					var h = Math.max(1, Math.round(img.naturalHeight * scale));
					var canvas = document.createElement('canvas');
					canvas.width = w; canvas.height = h;
					canvas.getContext('2d').drawImage(img, 0, 0, w, h);
					URL.revokeObjectURL(url);
					try { resolve(canvas.toDataURL('image/jpeg', 0.9)); }
					catch (e) { reject(e); }
				};
				img.onerror = function() { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
				img.src = url;
			});
		}

		function present(dataUrl, name) {
			try {
				sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ dataUrl: dataUrl, name: name || 'selfie.jpg' }));
			} catch (e) {
				// Storage blocked or quota exceeded — the visitor can still start
				// fresh in Avatar Studio, so degrade gracefully instead of lying.
			}
			previewImg.src = dataUrl;
			zone.style.display = 'none';
			ready.classList.add('show');
		}

		function accept(file) {
			clearError();
			toDataUrl(file).then(function(dataUrl) {
				present(dataUrl, file.name);
			}).catch(function() {
				showError('Could not read that image. Try a JPG or PNG.');
			});
		}

		drop.addEventListener('click', function() { fileInput.click(); });
		fileInput.addEventListener('change', function() {
			if (fileInput.files && fileInput.files[0]) accept(fileInput.files[0]);
		});
		drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.classList.add('drag-over'); });
		drop.addEventListener('dragleave', function() { drop.classList.remove('drag-over'); });
		drop.addEventListener('drop', function(e) {
			e.preventDefault(); drop.classList.remove('drag-over');
			if (e.dataTransfer.files && e.dataTransfer.files[0]) accept(e.dataTransfer.files[0]);
		});

		resetBtn && resetBtn.addEventListener('click', function() {
			try { sessionStorage.removeItem(HANDOFF_KEY); } catch (e) {}
			ready.classList.remove('show');
			zone.style.display = '';
			fileInput.value = '';
			clearError();
		});

		webcamBtn.addEventListener('click', function() {
			if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
				showError('Webcam not available in this browser. Upload a photo instead.');
				return;
			}
			clearError();
			webcamBtn.disabled = true;
			navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 640 } })
				.then(function(stream) {
					var video = document.createElement('video');
					video.srcObject = stream;
					video.muted = true;
					video.playsInline = true;
					video.play();
					var done = false;
					function snap() {
						if (done) return;
						done = true;
						var size = Math.min(video.videoWidth || 640, video.videoHeight || 640) || 640;
						var canvas = document.createElement('canvas');
						canvas.width = size; canvas.height = size;
						var sx = ((video.videoWidth || size) - size) / 2;
						var sy = ((video.videoHeight || size) - size) / 2;
						canvas.getContext('2d').drawImage(video, sx, sy, size, size, 0, 0, size, size);
						stream.getTracks().forEach(function(t) { t.stop(); });
						webcamBtn.disabled = false;
						present(canvas.toDataURL('image/jpeg', 0.9), 'webcam.jpg');
					}
					// Snap once the first frame is actually available.
					video.addEventListener('loadeddata', function() { setTimeout(snap, 250); }, { once: true });
				}).catch(function() {
					webcamBtn.disabled = false;
					showError('Camera access was blocked. Upload a photo instead.');
				});
		});
	})();

	// ── 2. Voice + Mocap: microphone waveform ───────────────────────
	(function() {
		var btn = document.getElementById('mocap-mic-btn');
		var canvas = document.getElementById('mocap-waveform');
		var status = document.getElementById('mocap-status');
		if (!btn || !canvas) return;
		var ctx = canvas.getContext('2d');
		var audioCtx = null, analyser = null, stream = null, animId = null;
		var active = false;

		function draw() {
			if (!active) return;
			animId = requestAnimationFrame(draw);
			var w = canvas.width, h = canvas.height;
			var data = new Uint8Array(analyser.frequencyBinCount);
			analyser.getByteTimeDomainData(data);
			ctx.clearRect(0, 0, w, h);
			ctx.strokeStyle = 'rgba(168,168,168,0.6)';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			var sliceW = w / data.length;
			for (var i = 0; i < data.length; i++) {
				var v = data[i] / 128.0;
				var y = v * h / 2;
				if (i === 0) ctx.moveTo(0, y);
				else ctx.lineTo(i * sliceW, y);
			}
			ctx.stroke();
		}

		function resizeCanvas() {
			canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
			canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
		}

		btn.addEventListener('click', function() {
			if (active) {
				active = false;
				cancelAnimationFrame(animId);
				if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
				if (audioCtx) audioCtx.close();
				stream = null; audioCtx = null; analyser = null;
				btn.textContent = 'Microphone';
				status.textContent = 'click to capture';
				status.classList.remove('live');
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				return;
			}
			navigator.mediaDevices.getUserMedia({ audio: true }).then(function(s) {
				stream = s;
				audioCtx = new (window.AudioContext || window.webkitAudioContext)();
				analyser = audioCtx.createAnalyser();
				analyser.fftSize = 256;
				audioCtx.createMediaStreamSource(stream).connect(analyser);
				active = true;
				resizeCanvas();
				btn.textContent = 'Stop';
				status.textContent = 'live — speak now';
				status.classList.add('live');
				draw();
			}).catch(function() {
				status.textContent = 'mic access denied';
			});
		});

		new ResizeObserver(function() { if (active) resizeCanvas(); }).observe(canvas);
	})();

	// ── 3. Walk & Multiplayer: mini map ─────────────────────────────
	(function() {
		var canvas = document.getElementById('walk-minimap');
		if (!canvas) return;
		var ctx = canvas.getContext('2d');
		var dpr = window.devicePixelRatio || 1;
		var W, H;

		function resize() {
			W = canvas.clientWidth; H = canvas.clientHeight;
			canvas.width = W * dpr; canvas.height = H * dpr;
			ctx.scale(dpr, dpr);
		}
		resize();
		new ResizeObserver(resize).observe(canvas);

		var player = { x: 0.5, y: 0.5, color: '#fff' };
		var bots = [
			{ x: 0.2, y: 0.3, vx: 0.0008, vy: 0.0006, color: '#4ade80' },
			{ x: 0.8, y: 0.6, vx: -0.0006, vy: 0.0009, color: '#60a5fa' },
			{ x: 0.5, y: 0.8, vx: 0.0007, vy: -0.0005, color: '#fbbf24' },
		];

		var keys = {};
		canvas.addEventListener('keydown', function(e) { keys[e.key.toLowerCase()] = true; e.preventDefault(); });
		canvas.addEventListener('keyup', function(e) { keys[e.key.toLowerCase()] = false; });
		canvas.addEventListener('click', function(e) {
			var r = canvas.getBoundingClientRect();
			player.x = (e.clientX - r.left) / r.width;
			player.y = (e.clientY - r.top) / r.height;
			canvas.focus();
		});

		// The arena redraws its grid and every visitor dot each frame. It used
		// to run from page load until the tab closed, offscreen included, which
		// cost ~1.5s of main-thread time per page view on a section most
		// visitors never scroll to. It now runs only while the canvas is on
		// screen and the tab is visible.
		var running = false;
		var rafId = 0;
		var onScreen = !('IntersectionObserver' in window);
		function setRunning(on) {
			if (on === running) return;
			running = on;
			if (on && !rafId) rafId = requestAnimationFrame(tick);
		}
		function syncRunning() {
			setRunning(onScreen && !document.hidden);
		}
		function tick() {
			if (!running) { rafId = 0; return; }
			rafId = requestAnimationFrame(tick);
			var speed = 0.006;
			if (keys['w'] || keys['arrowup']) player.y -= speed;
			if (keys['s'] || keys['arrowdown']) player.y += speed;
			if (keys['a'] || keys['arrowleft']) player.x -= speed;
			if (keys['d'] || keys['arrowright']) player.x += speed;
			player.x = Math.max(0.02, Math.min(0.98, player.x));
			player.y = Math.max(0.02, Math.min(0.98, player.y));

			bots.forEach(function(b) {
				b.x += b.vx; b.y += b.vy;
				if (b.x < 0.05 || b.x > 0.95) b.vx *= -1;
				if (b.y < 0.05 || b.y > 0.95) b.vy *= -1;
				b.vx += (Math.random() - 0.5) * 0.0002;
				b.vy += (Math.random() - 0.5) * 0.0002;
			});

			ctx.clearRect(0, 0, W, H);
			ctx.fillStyle = '#0d0d0d';
			ctx.fillRect(0, 0, W, H);
			// Grid
			ctx.strokeStyle = 'rgba(255,255,255,0.04)';
			ctx.lineWidth = 0.5;
			for (var gx = 0; gx < W; gx += 30) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
			for (var gy = 0; gy < H; gy += 30) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

			// Bots
			bots.forEach(function(b) {
				ctx.beginPath();
				ctx.arc(b.x * W, b.y * H, 4, 0, Math.PI * 2);
				ctx.fillStyle = b.color;
				ctx.fill();
				ctx.fillStyle = 'rgba(255,255,255,0.2)';
				ctx.font = '7px monospace';
				ctx.fillText('visitor', b.x * W + 7, b.y * H + 3);
			});

			// Player
			ctx.beginPath();
			ctx.arc(player.x * W, player.y * H, 5, 0, Math.PI * 2);
			ctx.fillStyle = player.color;
			ctx.fill();
			ctx.shadowColor = '#fff'; ctx.shadowBlur = 8;
			ctx.fill();
			ctx.shadowBlur = 0;
			ctx.fillStyle = 'rgba(255,255,255,0.5)';
			ctx.font = '8px monospace';
			ctx.fillText('you', player.x * W + 8, player.y * H + 3);
		}
		if ('IntersectionObserver' in window) {
			new IntersectionObserver(function(entries) {
				onScreen = entries.some(function(e) { return e.isIntersecting; });
				syncRunning();
			}, { rootMargin: '100px 0px' }).observe(canvas);
		}
		document.addEventListener('visibilitychange', syncRunning);
		syncRunning();
	})();

	// ── 4. x402 Payments: interactive flow ──────────────────────────
	(function() {
		var payBtn = document.getElementById('x402-pay-btn');
		var code = document.getElementById('x402-code');
		var spinner = document.getElementById('x402-spinner');
		var amount = document.getElementById('x402-amount');
		if (!payBtn) return;

		payBtn.addEventListener('click', function() {
			payBtn.style.display = 'none';
			spinner.style.display = 'block';
			code.textContent = 'Processing USDC payment...';
			code.className = 'x402-code';

			setTimeout(function() {
				spinner.style.display = 'none';
				code.textContent = 'HTTP 200 — OK';
				code.className = 'x402-code ok';
				amount.classList.add('show');

				setTimeout(function() {
					code.textContent = 'HTTP 402 — Payment Required';
					code.className = 'x402-code err';
					amount.classList.remove('show');
					payBtn.style.display = '';
				}, 3000);
			}, 1200);
		});
	})();

	// ── 5. On-chain Identity: real Solana deploy lives in the module
	//        script near the end of <body> (needs ES-module imports). ─────

	// ── 6. Skills: live tool-call demo ──────────────────────────────
	// Every pill fires a REAL call: Jupiter's public quote API, our Solana
	// RPC proxy, the live pump.fun launch feed (SSE), and an A2A agent ask
	// streamed through /api/chat. No canned responses.
	(function() {
		var tools = document.getElementById('skill-tools');
		var result = document.getElementById('skill-result');
		if (!tools || !result) return;

		var USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
		var WSOL = 'So11111111111111111111111111111111111111112';
		var seq = 0;            // monotonic token — only the latest click renders
		var pending = null;     // open EventSource to tear down on tool switch

		function colorJson(obj, indent) {
			indent = indent || 0;
			var pad = '  '.repeat(indent);
			if (obj === null || obj === undefined) return '<span class="json-dim">null</span>';
			if (typeof obj === 'string') return '<span class="json-str">"' + obj + '"</span>';
			if (typeof obj === 'number') return '<span class="json-num">' + obj + '</span>';
			if (typeof obj === 'boolean') return '<span class="json-num">' + obj + '</span>';
			if (Array.isArray(obj)) {
				if (obj.length === 0) return '[]';
				var items = obj.map(function(v) { return pad + '  ' + colorJson(v, indent + 1); });
				return '[\n' + items.join(',\n') + '\n' + pad + ']';
			}
			var keys = Object.keys(obj).filter(function(k) { return obj[k] !== null && obj[k] !== undefined; });
			if (keys.length === 0) return '{}';
			var lines = keys.map(function(k) {
				return pad + '  <span class="json-key">"' + k + '"</span>: ' + colorJson(obj[k], indent + 1);
			});
			return '{\n' + lines.join(',\n') + '\n' + pad + '}';
		}

		function setLoading(label) {
			result.classList.remove('err', 'fresh');
			result.classList.add('loading');
			result.innerHTML = '<span class="skill-loading">▸ calling <span class="json-key">' + label + '</span><span class="skill-dots"></span></span>';
		}
		function setError(label, msg) {
			result.classList.remove('loading', 'fresh');
			result.classList.add('err');
			result.innerHTML = '<span class="skill-err">✕ ' + label + ' — ' + msg + '</span>';
		}
		function render(obj, streamingHtml) {
			result.classList.remove('loading', 'err');
			result.innerHTML = streamingHtml || colorJson(obj, 0);
			if (!streamingHtml) {
				result.classList.add('fresh');
				setTimeout(function() { result.classList.remove('fresh'); }, 600);
			}
		}
		function teardown() {
			if (pending) { try { pending.close(); } catch (_) {} pending = null; }
		}

		var runners = {
			jupiter: function(my) {
				setLoading('jupiter_swap');
				// Bounded: without a timeout the tile spins forever on a stalled
				// connection, which reads as a broken page rather than a slow quote.
				return fetch('https://lite-api.jup.ag/swap/v1/quote?inputMint=' + USDC + '&outputMint=' + WSOL + '&amount=10000000&slippageBps=50', { signal: AbortSignal.timeout(8000) })
					.then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
					.then(function(q) {
						if (my !== seq) return;
						var sol = Number(q.outAmount) / 1e9;
						var route = (q.routePlan || []).map(function(p) { return p.swapInfo && p.swapInfo.label; }).filter(Boolean);
						render({
							tool: 'jupiter_swap',
							input: { from: 'USDC', to: 'SOL', amount: '10.00' },
							output: {
								received: sol.toFixed(4) + ' SOL',
								rate: (sol > 0 ? (10 / sol) : 0).toFixed(2) + ' USDC/SOL',
								price_impact: (Number(q.priceImpactPct || 0) * 100).toFixed(3) + '%',
								slippage: ((q.slippageBps || 50) / 100).toFixed(2) + '%',
								route: route.length ? route.join(' → ') : 'direct'
							}
						});
					})
					.catch(function(e) { if (my === seq) setError('jupiter_swap', e.message); });
			},

			rpc: function(my) {
				setLoading('solana_rpc');
				return fetch('/api/solana-rpc', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEpochInfo' })
				})
					.then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
					.then(function(j) {
						if (my !== seq) return;
						var v = j.result || {};
						render({
							tool: 'solana_rpc',
							method: 'getEpochInfo',
							network: 'mainnet-beta',
							result: {
								epoch: v.epoch,
								absolute_slot: v.absoluteSlot,
								block_height: v.blockHeight,
								slot_index: v.slotIndex + ' / ' + v.slotsInEpoch,
								tx_count: v.transactionCount
							}
						});
					})
					.catch(function(e) { if (my === seq) setError('solana_rpc', e.message); });
			},

			pump: function(my) {
				setLoading('pump_live_feed');
				return new Promise(function(resolve) {
					var es, settled = false, to;
					function finish(fn) {
						if (settled) return;
						settled = true;
						clearTimeout(to);
						if (es) { try { es.close(); } catch (_) {} }
						if (pending === es) pending = null;
						fn();
						resolve();
					}
					try { es = new EventSource('/api/pump/live-stream?kind=mint'); }
					catch (e) { if (my === seq) setError('pump_live_feed', 'feed unavailable'); return resolve(); }
					pending = es;
					to = setTimeout(function() {
						finish(function() { if (my === seq) setError('pump_live_feed', 'no launches in the last 20s — try again'); });
					}, 20000);
					es.addEventListener('mint', function(ev) {
						var d;
						try { d = JSON.parse(ev.data); } catch (_) { return; }
						finish(function() {
							if (my !== seq) return;
							render({
								tool: 'pump_live_feed',
								event: 'new_mint',
								source: 'pump.fun · mainnet',
								data: {
									name: d.name || '(unnamed)',
									symbol: d.symbol ? ('$' + String(d.symbol).replace(/^\$/, '')) : null,
									mint: d.mint ? (d.mint.slice(0, 4) + '…' + d.mint.slice(-4)) : null,
									market_cap_usd: (d.market_cap_usd != null) ? '$' + Math.round(d.market_cap_usd).toLocaleString() : null,
									initial_buy_sol: (d.initial_buy_sol != null) ? Number(d.initial_buy_sol).toFixed(3) + ' SOL' : null
								}
							});
						});
					});
					es.onerror = function() {
						finish(function() { if (my === seq) setError('pump_live_feed', 'feed disconnected'); });
					};
				});
			},

			a2a: function(my) {
				setLoading('a2a · agent.ask');
				var question = 'In one sentence, what can I build on three.ws?';
				var base = { protocol: 'a2a', target: 'claude.agent', action: 'ask', input: question };
				function paint(text, streaming) {
					if (my !== seq) return;
					result.classList.remove('loading', 'err');
					var json = colorJson(Object.assign({}, base, { response: text || '' }), 0);
					result.innerHTML = streaming ? json.replace(/<\/span>(\n\})$/, '<span class="skill-cursor">▍</span></span>$1') : json;
				}
				return fetch('/api/chat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						message: question,
						system_prompt: 'You are the three.ws platform agent. Answer in ONE concise, confident sentence, no preamble.',
						history: [],
						context: {}
					})
				})
					.then(function(r) { if (!r.ok || !r.body) throw new Error('HTTP ' + r.status); return r.body.getReader(); })
					.then(function(reader) {
						var dec = new TextDecoder(), buf = '', text = '';
						function step(res) {
							if (my !== seq) { try { reader.cancel(); } catch (_) {} return; }
							if (res.done) {
								if (my === seq) { paint(text || '(no response)', false); result.classList.add('fresh'); setTimeout(function() { result.classList.remove('fresh'); }, 600); }
								return;
							}
							buf += dec.decode(res.value, { stream: true });
							var lines = buf.split('\n');
							buf = lines.pop();
							lines.forEach(function(line) {
								if (line.indexOf('data: ') !== 0) return;
								var data = line.slice(6).trim();
								if (!data || data === '[DONE]') return;
								try {
									var parsed = JSON.parse(data);
									if (parsed.type === 'chunk' && parsed.text) text += parsed.text;
								} catch (_) {}
							});
							paint(text, true);
							return reader.read().then(step);
						}
						return reader.read().then(step);
					})
					.catch(function(e) { if (my === seq) setError('a2a · agent.ask', e.message); });
			}
		};

		function run(name) {
			teardown();
			var my = ++seq;
			(runners[name] || runners.jupiter)(my);
		}

		tools.addEventListener('click', function(e) {
			var btn = e.target.closest('.bento-pill-btn');
			if (!btn) return;
			tools.querySelectorAll('.bento-pill-btn').forEach(function(b) { b.classList.remove('active'); });
			btn.classList.add('active');
			run(btn.dataset.tool);
		});

		// Fire the first real call only when the card scrolls into view.
		var fired = false;
		if ('IntersectionObserver' in window) {
			var io = new IntersectionObserver(function(entries) {
				entries.forEach(function(en) {
					if (en.isIntersecting && !fired) { fired = true; run('jupiter'); io.disconnect(); }
				});
			}, { threshold: 0.3 });
			io.observe(result);
		} else {
			run('jupiter');
		}
	})();

	// ── 7. Memory: store/recall demo ────────────────────────────────
	(function() {
		var input = document.getElementById('memory-input');
		var storeBtn = document.getElementById('memory-store-btn');
		var recallBtn = document.getElementById('memory-recall-btn');
		var log = document.getElementById('memory-log');
		if (!input || !storeBtn) return;

		var memories = [];

		function addEntry(op, val) {
			var el = document.createElement('div');
			el.className = 'memory-entry';
			el.innerHTML = '<span class="mem-op">' + op + '</span><span class="mem-val">' + val + '</span>';
			log.appendChild(el);
			log.scrollTop = log.scrollHeight;
		}

		storeBtn.addEventListener('click', function() {
			var val = input.value.trim();
			if (!val) return;
			memories.push(val);
			addEntry('STORE →', val);
			input.value = '';
		});

		recallBtn.addEventListener('click', function() {
			if (memories.length === 0) {
				addEntry('RECALL →', '(empty — store something first)');
				return;
			}
			memories.forEach(function(m, i) {
				setTimeout(function() {
					addEntry('MEM[' + i + ']', m);
				}, i * 150);
			});
		});

		input.addEventListener('keydown', function(e) {
			if (e.key === 'Enter') storeBtn.click();
		});
	})();

	// ── 8. AR / WebXR: launcher demo ────────────────────────────────
	(function() {
		var btn = document.getElementById('ar-launch-btn');
		var phone = document.getElementById('ar-phone');
		var status = document.getElementById('ar-status');
		if (!btn) return;
		var active = false;

		btn.addEventListener('click', function() {
			if (active) {
				active = false;
				phone.classList.remove('active');
				status.textContent = 'tap to place agent';
				status.classList.remove('ready');
				btn.textContent = 'Launch AR';
				return;
			}
			active = true;
			phone.classList.add('active');
			status.textContent = 'scanning surface...';
			btn.textContent = 'Stop';

			setTimeout(function() {
				if (!active) return;
				status.textContent = 'agent placed in AR';
				status.classList.add('ready');
			}, 1500);
		});
	})();

	// ── 9. Marketplace: live agent browser ──────────────────────────
	(function() {
		var strip = document.getElementById('mktplace-strip');
		if (!strip) return;

		fetch('/api/marketplace', { headers: { accept: 'application/json' } })
			.then(function(r) {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				return r.json();
			})
			.then(function(body) {
				// /api/marketplace answers { data: { items: [...] } }. Each item is an
				// agent listing: `id` is the agent id (what /agents/:id resolves), and
				// `thumbnail_url` is a ready-to-use absolute URL — null when the listing's
				// avatar has no stored thumbnail. Only ~1 in 6 listings carries one, so
				// the initial-letter placeholder is the common path, not an error path.
				var items = ((body && body.data && body.data.items) || []).filter(function(it) {
					return it && it.id;
				}).slice(0, 10);
				if (!items.length) return renderBrowseFallback();

				items.forEach(function(item) {
					var name = item.name || item.id.slice(0, 6);
					var a = document.createElement('a');
					a.className = 'mktplace-item';
					a.href = '/agents/' + item.id;
					a.title = name;

					var initial = document.createElement('span');
					initial.className = 'mktplace-item-initial';
					initial.textContent = (name || '?').charAt(0);
					a.appendChild(initial);

					if (item.thumbnail_url) {
						var img = document.createElement('img');
						img.src = item.thumbnail_url;
						img.alt = name;
						img.loading = 'lazy';
						// A stored thumbnail can still 404 (object pruned) — fall back to the
						// initial rather than leaving a broken-image tile.
						img.onerror = function() {
							this.remove();
							initial.style.display = 'flex';
						};
						a.appendChild(img);
					} else {
						initial.style.display = 'flex';
					}

					var lbl = document.createElement('span');
					lbl.className = 'mktplace-item-name';
					lbl.textContent = name;
					a.appendChild(lbl);
					strip.appendChild(a);
				});

				var more = document.createElement('a');
				more.className = 'mktplace-more';
				more.href = '/discover';
				more.textContent = '→';
				more.title = 'Browse all agents';
				strip.appendChild(more);
			}).catch(renderBrowseFallback);

		function renderBrowseFallback() {
			strip.innerHTML = '';
			var a = document.createElement('a');
			a.className = 'mktplace-more';
			a.href = '/discover';
			a.style.width = 'auto';
			a.style.padding = '0 16px';
			a.textContent = 'Browse marketplace →';
			strip.appendChild(a);
		}
	})();

	// ── 10. Analytics: sparkline + animated counters ─────────────────
	(function() {
		var demo = document.getElementById('analytics-demo');
		if (!demo) return;
		var convosEl = document.getElementById('an-convos');
		var revenueEl = document.getElementById('an-revenue');
		var retentionEl = document.getElementById('an-retention');
		var sparkSvg = document.getElementById('analytics-spark');

		var dataPoints = [5, 12, 8, 22, 18, 30, 25, 40, 35, 48, 42, 55, 50, 62, 58, 70, 65, 78, 72, 85];
		var maxVal = Math.max.apply(null, dataPoints);
		var svgW = 200, svgH = 40, pad = 2;

		function buildPath() {
			var pts = dataPoints.map(function(v, i) {
				return {
					x: pad + (i / (dataPoints.length - 1)) * (svgW - pad * 2),
					y: svgH - pad - (v / maxVal) * (svgH - pad * 2)
				};
			});
			var d = pts.map(function(p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
			var fillD = d + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + svgH + ' L' + pts[0].x.toFixed(1) + ' ' + svgH + ' Z';
			var last = pts[pts.length - 1];

			sparkSvg.innerHTML = sparkSvg.querySelector('defs').outerHTML
				+ '<path class="spark-fill" d="' + fillD + '"/>'
				+ '<path d="' + d + '"/>'
				+ '<circle class="spark-dot" cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="2.5"/>';
		}

		// Counters reveal a fixed set of example figures (the widget is labeled
		// "example" in the markup). These are illustrative of the analytics
		// dashboard — not live platform data — so no random "live" simulation.
		var animated = false;
		var targets = { convos: 1247, revenue: 847.5, retention: 68 };
		function setCounters(convos, revenue, retention) {
			convosEl.textContent = Math.round(convos).toLocaleString();
			revenueEl.textContent = '$' + revenue.toFixed(0);
			retentionEl.textContent = Math.round(retention) + '%';
		}
		function animateCounters() {
			if (animated) return;
			animated = true;
			if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
				setCounters(targets.convos, targets.revenue, targets.retention);
				return;
			}
			var start = performance.now();
			var dur = 1200;
			(function tick(now) {
				var p = Math.min((now - start) / dur, 1);
				var e = 1 - Math.pow(1 - p, 3);
				setCounters(targets.convos * e, targets.revenue * e, targets.retention * e);
				if (p < 1) requestAnimationFrame(tick);
			})(start);
		}

		buildPath();

		var io = new IntersectionObserver(function(entries) {
			if (entries[0].isIntersecting) { animateCounters(); io.disconnect(); }
		}, { threshold: 0.3 });
		io.observe(demo);
	})();

})();
