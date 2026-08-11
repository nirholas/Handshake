// forge-run.js: drive ONE text to 3D generation on a FREE lane and report each
// real pipeline stage as it happens.
//
// This is the same zero-cost path the `forge_free` MCP tool and the /forge web
// page use: POST /api/forge with backend:'nvidia', path:'image' (no payment, no
// key), then poll /api/forge?job=<id> to a terminal state. The request names the
// free NVIDIA NIM (Microsoft TRELLIS) lane, but the API's free-first router may
// serve a different FREE engine (our self-host TRELLIS or Hunyuan3D worker, the
// HuggingFace lane) when NIM is down or a cheaper-for-us lane is warm. The lane
// that actually ran comes back as `backend` on every response, so the narration
// and the final frame name the real engine instead of the requested one. No
// fabricated progress: every onStage() call is fed by a real job/poll response.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The API reports a scale-to-zero GPU worker's spin-up budget as
// `cold_start_seconds`; the shared narration reads it as `cold_seconds` (see
// src/shared/forge-frames.js). Translate here, exactly as the in-browser twin
// does in src/agent-screen.js, so both surfaces say "Waking up the … GPU worker"
// on the same signal instead of one of them going silent through the boot.
function stageState(data, extra = {}) {
	return {
		...data,
		cold_seconds: data?.cold_start_seconds,
		...extra,
	};
}

function shape(data, base) {
	const glbUrl = data.glb_url;
	return {
		glbUrl,
		viewerUrl: `${base}/viewer?src=${encodeURIComponent(glbUrl)}`,
		tier: data.tier || null,
		backend: data.backend || null,
		durable: Boolean(data.durable),
	};
}

// Run a single forge. Calls onStage(state) on each distinct real state, where
// `state` is the /api/forge response ({ status, backend, eta_seconds, … }) with
// `cold_seconds` translated in. Resolves to
// { glbUrl, viewerUrl, tier, backend, durable } or throws a holder-readable
// Error. `budgetMs` bounds the total poll time; `pollMs` is the interval.
//
// The caller owns the 'submitting' narration (it fires before this function is
// reached, so the screen is never blank while the POST is in flight); this
// function starts narrating at the first state the API actually reports.
export async function runForge({
	base,
	prompt,
	tier = 'draft',
	onStage,
	budgetMs = 180_000,
	pollMs = 3_000,
	fetchImpl = fetch,
}) {
	let submitRes;
	try {
		submitRes = await fetchImpl(`${base}/api/forge`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			// Ask for the free NVIDIA NIM (TRELLIS) lane. The API's free-first
			// router may serve another FREE engine instead; the response names it.
			body: JSON.stringify({ prompt, tier, backend: 'nvidia', path: 'image' }),
		});
	} catch (err) {
		throw new Error(`free 3D lane unreachable: ${err?.message || err}`);
	}
	const submit = await submitRes.json().catch(() => ({}));
	if (submitRes.status === 503) throw new Error(submit.message || 'the free 3D lane is not configured on this deployment');
	if (submitRes.status === 429) throw new Error(submit.message || 'free 3D lane busy, try again shortly');
	// The High tier is $THREE hold-or-pay gated (api/forge.js, feature
	// 'forge.high'), and this worker submits unauthenticated, so a 402 here is a
	// tier choice, not an outage. Name the recovery instead of leaking a raw
	// paywall message into the live screen.
	if (submitRes.status === 402) {
		throw new Error(
			`${submit.message || 'this tier is gated'} Run this worker at FORGE_TIER=draft or standard, which are ungated.`,
		);
	}

	// A warm lane can finish inside the submit window: accept a synchronous done.
	if (submit.status === 'done' && submit.glb_url) {
		onStage?.(stageState(submit));
		return shape(submit, base);
	}
	if (!submitRes.ok || !submit.job_id) {
		throw new Error(submit.message || `forge returned ${submitRes.status}`);
	}

	// Narrate the accepted job with everything the submit response knows: which
	// free engine took it, and whether a scale-to-zero GPU worker has to boot
	// first. Without these the line degrades to a lane-agnostic "Queued" and the
	// cold-start wait reads as a stall.
	onStage?.(stageState(submit));

	const deadline = Date.now() + budgetMs;
	let lastStatus = 'queued';
	while (Date.now() < deadline) {
		await sleep(pollMs);
		let res;
		try {
			res = await fetchImpl(`${base}/api/forge?job=${encodeURIComponent(submit.job_id)}`, {
				headers: { accept: 'application/json' },
			});
		} catch {
			continue; // transient network blip, keep polling within the budget
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			if (res.status >= 500) continue;
			throw new Error(data.message || `forge poll returned ${res.status}`);
		}
		if (data.status && data.status !== lastStatus) {
			lastStatus = data.status;
			// The poll response repeats `backend` from the job record, so a lane
			// that only reveals itself after a failover still gets named.
			onStage?.(stageState(data, { backend: data.backend ?? submit.backend }));
		}
		if (data.status === 'done' && data.glb_url) return shape(data, base);
		if (data.status === 'failed') throw new Error(data.error || 'generation failed, try a more concrete prompt');
	}
	throw new Error(`generation did not finish within ${Math.round(budgetMs / 1000)}s`);
}
