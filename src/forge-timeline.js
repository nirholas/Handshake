// Forge generation timeline: the named, evidence-driven stage list shown while
// a model is being made (#state-generating on /forge).
//
// The rule this module exists to enforce: EVERY stage transition is caused by a
// real signal from /api/forge, never by a timer. The pipeline reports exactly
// these things and nothing more:
//
//   POST /api/forge          → { status, backend, tier, path, mode, prompt,
//                                directed_prompt?, preview_image_url?,
//                                reference_image_urls?, text_to_image_model?,
//                                cold_start?, eta_seconds?, coalesced? }
//   GET  /api/forge?job=…    → { status: queued|running|done|failed, backend,
//                                tier, path, preview_image_url?, failover_from? }
//
// So the honest mapping is:
//   • "Art-directing your prompt": the server runs the Granite director before
//     the POST resolves; proof of completion is `directed_prompt` on the response
//     (or its absence, which means the model got the prompt verbatim).
//   • "Painting the reference view": proof is `preview_image_url`. It can arrive
//     on the POST, or later on a poll (coalesced job, resumed job, failover
//     successor), and is revealed the moment it exists.
//   • "Sculpting the mesh": `status: queued` vs `running`. The GPU
//     workers report no sub-steps, so this stays ONE stage: no invented
//     "texturing" phase, just the queue/running distinction plus the honest
//     elapsed meter that forge.js drives.
//   • "Finalizing": the done payload landed and the viewer is
//     loading the GLB. Completed when the model is on screen.
//
// A lane that skips a stage never shows it: the free NVIDIA NIM lane emits the
// mesh straight from the prompt (no director, no reference view), so its
// timeline has three rows, not five.
//
// Cold starts get their own designed state instead of a silent stall: `cold_start`
// on the submit response means the chosen self-host worker was reached but
// answered slowly (scale-to-zero container booting). The warm-up budget shown is
// the real difference between the response's cold ETA and the catalog's warm ETA
// and it ends on a real signal (the first `running` poll), never on the clock.

const STAGE_ORDER = ['direct', 'reference', 'input', 'mesh', 'finish'];

// A tiny inline "open in a new tab" affordance is overkill for a 30px thumb; the
// anchor itself is the affordance and carries its own aria-label.
function thumbHTML(url, alt) {
	return `<img src="${url}" alt="${alt}" loading="lazy" decoding="async" />`;
}

function plural(n, one, many) {
	return n === 1 ? one : many;
}

export function createForgeTimeline({ list, preview, warming, engineLabel = (id) => id }) {
	// Facts accumulated from real responses. Nothing here is ever guessed.
	let f = blankFacts();
	// Rendered rows keyed by stage id, so a re-render updates text in place
	// instead of rebuilding the list (no flicker, no re-announcing every row to
	// a screen reader, and CSS transitions survive).
	const rows = new Map();
	let previewUrlShown = null;

	function blankFacts() {
		return {
			mode: 'text', // text | image | sketch
			viewCount: 0,
			localPreviewUrl: null, // user's own photo/sketch, known before submit
			plannedBackend: null,
			backend: null,
			plannedReference: true, // does this lane paint a reference view?
			hasReference: false,
			referenceUrl: null,
			directedPrompt: null,
			// Did the response carry a `directed_prompt` KEY at all? Absent (an older
			// deployment) is not the same claim as present-and-null (the director
			// genuinely left the prompt alone), and the label must not conflate them.
			directedReported: false,
			directorRan: false, // the submit response came back, so the pass is over
			submitted: false,
			resumed: false,
			status: 'submitting', // submitting | queued | running | finalizing | done | failed
			coldStart: false,
			coldSeconds: null,
			etaSeconds: null,
			queuedSeconds: 0,
			failoverFrom: null,
			elapsedS: 0,
		};
	}

	// ── Stage model ──────────────────────────────────────────────────────────
	function stages() {
		const out = [];
		const meshStarted = f.submitted || f.resumed;
		const terminal = f.status === 'done' || f.status === 'finalizing';
		// A failed job stops spinning: the row keeps its label and detail but drops
		// back to the idle marker, so nothing on screen still implies live work.
		const meshState = terminal ? 'done' : f.status === 'failed' ? 'pending' : meshStarted ? 'active' : 'pending';

		if (f.mode === 'sketch') {
			out.push({
				id: 'input',
				label: 'Your drawing',
				detail: 'Uploaded and used as the reference, no image is synthesized',
				state: 'done',
				thumb: f.localPreviewUrl,
				thumbAlt: 'Your uploaded drawing',
			});
		} else if (f.mode === 'image') {
			const n = Math.max(1, f.viewCount);
			out.push({
				id: 'input',
				label: `Conditioning on ${n} reference ${plural(n, 'view', 'views')}`,
				detail: n > 1 ? 'The engine fuses every view into one mesh' : 'Reconstructing straight from your photo',
				state: 'done',
				thumb: f.localPreviewUrl || f.referenceUrl,
				thumbAlt: 'Your uploaded reference view',
			});
		} else if (f.plannedReference || f.hasReference) {
			// Text → 3D through a reference view: the director rewrites the prompt,
			// then a text-to-image model paints the view the mesh is built from.
			out.push({
				id: 'direct',
				label: directLabel(),
				detail: directDetail(),
				state: f.directorRan ? 'done' : 'active',
			});
			out.push({
				id: 'reference',
				label: f.hasReference ? 'Reference view painted' : 'Painting the reference view',
				detail: f.hasReference
					? 'This is the image the mesh is reconstructed from'
					: 'A photoreal single view the reconstructor can read cleanly',
				state: f.hasReference ? 'done' : f.directorRan ? 'active' : 'pending',
				thumb: f.hasReference ? f.referenceUrl : null,
				thumbAlt: 'The reference view painted from your prompt',
			});
		} else {
			out.push({
				id: 'input',
				label: f.submitted ? 'Prompt accepted' : 'Sending your prompt',
				detail: `${engineLabel(f.backend || f.plannedBackend)} builds the mesh straight from text, with no reference image in this lane`,
				state: f.submitted ? 'done' : 'active',
			});
		}

		out.push({
			id: 'mesh',
			label: meshLabel(),
			detail: meshDetail(),
			state: meshState,
		});

		out.push({
			id: 'finish',
			label: f.status === 'done' ? 'Model ready' : 'Finalizing the GLB',
			detail:
				f.status === 'done'
					? 'Saved to your creations and loaded in the viewer'
					: f.status === 'finalizing'
						? 'Compressing, scoring quality and loading it into the viewer'
						: 'Durable copy, quality score, then straight into the viewer',
			state: f.status === 'done' ? 'done' : f.status === 'finalizing' ? 'active' : 'pending',
		});

		return out.sort((a, b) => STAGE_ORDER.indexOf(a.id) - STAGE_ORDER.indexOf(b.id));
	}

	function directLabel() {
		if (!f.directorRan) return 'Art-directing your prompt';
		if (f.directedPrompt) return 'Prompt art-directed';
		// The lane reported no rewrite. Only claim the prompt went through
		// untouched when the response actually said so.
		return f.directedReported ? 'Prompt used as you wrote it' : 'Prompt handed to the painter';
	}

	function directDetail() {
		if (!f.directorRan) return 'Rewriting it into a single-subject brief with material and lighting cues';
		if (f.directedPrompt) return 'Expanded with materials, lighting and composition cues. See it with your model';
		return f.directedReported
			? 'The director left it unchanged, so the model saw your exact words'
			: 'This lane does not report the director’s rewrite back';
	}

	function meshLabel() {
		const engine = engineLabel(f.backend || f.plannedBackend);
		if (f.mode === 'sketch') return `Sculpting geometry from your drawing on ${engine}`;
		return `Sculpting the textured mesh on ${engine}`;
	}

	function meshDetail() {
		if (f.status === 'failed') return 'The lane reported a failure';
		if (f.failoverFrom) {
			return `${engineLabel(f.failoverFrom)} hit a snag, so ${engineLabel(f.backend)} picked the job up`;
		}
		if (f.status === 'queued') {
			if (f.coldStart) return 'Waiting on a GPU worker that is still booting';
			return f.queuedSeconds >= 8
				? 'In line for a GPU. Earlier jobs finish first, nothing is downgraded'
				: 'Accepted, waiting for a GPU slot';
		}
		if (f.status === 'running') {
			// The workers expose queued/running only (no per-step progress), so this
			// says what the stage covers rather than pretending to track it.
			return 'Geometry and textures in one pass. The engine reports no sub-steps, so the elapsed meter below is the real signal.';
		}
		if (f.status === 'done' || f.status === 'finalizing') return 'Mesh delivered';
		return 'Starts as soon as the job is accepted';
	}

	// ── Rendering ────────────────────────────────────────────────────────────
	function render() {
		if (!list) return;
		const wanted = stages();
		const seen = new Set();
		for (const st of wanted) {
			seen.add(st.id);
			let row = rows.get(st.id);
			if (!row) {
				row = buildRow(st.id);
				rows.set(st.id, row);
				list.appendChild(row.el);
			}
			if (row.el.dataset.state !== st.state) row.el.dataset.state = st.state;
			if (row.label.textContent !== st.label) row.label.textContent = st.label;
			const detail = st.detail || '';
			if (row.detail.textContent !== detail) row.detail.textContent = detail;
			row.detail.hidden = !detail;
			renderThumb(row, st);
		}
		for (const [id, row] of rows) {
			if (seen.has(id)) continue;
			row.el.remove();
			rows.delete(id);
		}
		// Keep DOM order in sync with the stage order after an insert.
		for (const st of wanted) {
			const row = rows.get(st.id);
			if (row) list.appendChild(row.el);
		}
	}

	function buildRow(id) {
		const el = document.createElement('li');
		el.className = 'step';
		el.dataset.stage = id;
		el.dataset.state = 'pending';
		el.innerHTML =
			'<span class="dot" aria-hidden="true"></span>' +
			'<span class="step-body"><span class="step-label"></span><span class="step-detail"></span></span>';
		return {
			el,
			label: el.querySelector('.step-label'),
			detail: el.querySelector('.step-detail'),
			thumb: null,
		};
	}

	function renderThumb(row, st) {
		if (!st.thumb) {
			if (row.thumb) {
				row.thumb.remove();
				row.thumb = null;
			}
			return;
		}
		if (!row.thumb) {
			const a = document.createElement('a');
			a.className = 'step-thumb';
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			row.thumb = a;
			row.el.appendChild(a);
		}
		if (row.thumb.dataset.src !== st.thumb) {
			row.thumb.dataset.src = st.thumb;
			row.thumb.href = st.thumb;
			row.thumb.setAttribute('aria-label', `${st.thumbAlt || 'Reference view'}. Opens the full image in a new tab`);
			row.thumb.title = 'Open the full reference view';
			row.thumb.innerHTML = thumbHTML(st.thumb, st.thumbAlt || 'Reference view');
		}
	}

	// The big square preview above the stage list. Shows the shimmer skeleton
	// until a real image exists, then paints it in (CSS handles the motion-safe
	// reveal) and runs the reconstruction scanline while the mesh stage is live.
	function renderPreview() {
		if (!preview) return;
		const url = f.referenceUrl || f.localPreviewUrl || null;
		const meshLive = (f.status === 'queued' || f.status === 'running') && (f.submitted || f.resumed);
		preview.classList.toggle('is-reconstructing', Boolean(meshLive));
		if (!url) {
			if (previewUrlShown !== null) {
				previewUrlShown = null;
				preview.innerHTML = '<div class="shimmer" aria-hidden="true"></div>';
			} else if (!preview.firstChild) {
				preview.innerHTML = '<div class="shimmer" aria-hidden="true"></div>';
			}
			return;
		}
		if (previewUrlShown === url) return;
		previewUrlShown = url;
		const img = new Image();
		img.alt = f.mode === 'sketch' ? 'Your drawing' : f.hasReference ? 'Reference view painted from your prompt' : 'Your reference photo';
		img.src = url;
		img.onload = () => {
			if (previewUrlShown !== url) return;
			preview.replaceChildren(img);
		};
		img.onerror = () => {
			// A broken reference URL must not leave a half-state: fall back to the
			// skeleton and let the stage row keep the honest label.
			if (previewUrlShown !== url) return;
			previewUrlShown = null;
			preview.innerHTML = '<div class="shimmer" aria-hidden="true"></div>';
		};
	}

	// ── Cold-start warming state ─────────────────────────────────────────────
	function renderWarming() {
		if (!warming) return;
		const active = f.coldStart && (f.status === 'queued' || f.status === 'submitting');
		warming.classList.toggle('is-hidden', !active);
		if (!active) {
			warming.dataset.phase = 'off';
			return;
		}
		const title = warming.querySelector('.gen-warming-title');
		const body = warming.querySelector('.gen-warming-body');
		const count = warming.querySelector('.gen-warming-count');
		const budget = f.coldSeconds;
		const left = budget ? Math.round(budget - f.elapsedS) : null;
		const over = left != null && left <= 0;
		warming.dataset.phase = over ? 'over' : 'warming';
		const engine = engineLabel(f.backend || f.plannedBackend);
		const nextTitle = over ? 'Still waking the GPU' : 'Waking up a GPU';
		if (title.textContent !== nextTitle) title.textContent = nextTitle;
		const nextBody = over
			? `${engine} is taking longer than its usual boot. Your job is accepted and queued: it starts the moment the worker answers, and nothing is lost in the meantime.`
			: `${engine} scales to zero when nobody is using it, so this request is booting a container. Your job is already accepted and starts the second the worker is up.`;
		if (body.textContent !== nextBody) body.textContent = nextBody;
		const nextCount = over
			? 'Past the usual boot time. Still waiting on the worker'
			: left != null
				? `~${left}s of warm-up left, then sculpting starts`
				: 'First request after an idle spell, so the worker is booting';
		if (count.textContent !== nextCount) count.textContent = nextCount;
	}

	function paint() {
		render();
		renderPreview();
		renderWarming();
	}

	// ── Public API ───────────────────────────────────────────────────────────
	return {
		/**
		 * Start a fresh timeline for a submission. Everything passed here is known
		 * client-side before the request goes out; the server's answer refines it.
		 */
		begin({ mode, backend, viewCount = 0, localPreviewUrl = null, usesReference = true }) {
			f = blankFacts();
			f.mode = mode;
			f.plannedBackend = backend;
			f.backend = backend;
			f.viewCount = viewCount;
			f.localPreviewUrl = localPreviewUrl;
			f.plannedReference = mode === 'text' ? usesReference : false;
			previewUrlShown = null;
			rows.forEach((row) => row.el.remove());
			rows.clear();
			if (preview) preview.innerHTML = '<div class="shimmer" aria-hidden="true"></div>';
			paint();
		},

		/** Restore the timeline for a job that survived a reload (resumeInflight). */
		resume({ backend, referenceUrl = null, mode = 'text', elapsedS = 0 }) {
			f = blankFacts();
			f.mode = mode;
			f.plannedBackend = backend;
			f.backend = backend;
			f.resumed = true;
			f.submitted = true;
			f.directorRan = true;
			f.status = 'running';
			f.elapsedS = elapsedS;
			f.plannedReference = Boolean(referenceUrl);
			if (referenceUrl) {
				f.hasReference = true;
				f.referenceUrl = referenceUrl;
			}
			previewUrlShown = null;
			rows.forEach((row) => row.el.remove());
			rows.clear();
			paint();
			return f.etaSeconds;
		},

		/**
		 * Apply the POST /api/forge response. `warmEtaSeconds` is the catalog's
		 * warm estimate for the lane that actually ran, so the cold-start budget is
		 * a real difference of two real numbers rather than a made-up countdown.
		 */
		applySubmit(job, { warmEtaSeconds = null } = {}) {
			f.submitted = true;
			f.directorRan = true;
			if (job?.backend) f.backend = job.backend;
			f.directedReported = Boolean(job) && Object.prototype.hasOwnProperty.call(job, 'directed_prompt');
			if (typeof job?.directed_prompt === 'string' && job.directed_prompt.trim()) {
				f.directedPrompt = job.directed_prompt.trim();
			}
			const ref =
				(typeof job?.preview_image_url === 'string' && job.preview_image_url) ||
				(Array.isArray(job?.reference_image_urls) && job.reference_image_urls[0]) ||
				null;
			if (ref && f.mode === 'text') {
				f.hasReference = true;
				f.referenceUrl = ref;
				f.plannedReference = true;
			} else if (f.mode === 'text' && job?.status && !ref && !job?.coalesced) {
				// The lane answered without a reference view: it generates the mesh
				// straight from the prompt. Drop the reference stages rather than
				// leaving a row that will never complete.
				f.plannedReference = false;
			}
			if (Number(job?.eta_seconds) > 0) f.etaSeconds = Math.round(Number(job.eta_seconds));
			f.coldStart = Boolean(job?.cold_start);
			if (f.coldStart) {
				const warm = Number(warmEtaSeconds) > 0 ? Number(warmEtaSeconds) : null;
				const gap = warm && f.etaSeconds ? f.etaSeconds - warm : null;
				f.coldSeconds = gap && gap > 0 ? Math.round(gap) : null;
			}
			f.status = job?.status === 'done' ? 'finalizing' : job?.status === 'running' ? 'running' : 'queued';
			paint();
			return { etaSeconds: f.etaSeconds, directedPrompt: f.directedPrompt, referenceUrl: f.referenceUrl };
		},

		/** Apply one GET /api/forge?job=… poll payload. */
		applyPoll(data) {
			if (!data) return;
			if (data.backend) f.backend = data.backend;
			if (data.failover_from && data.backend && data.failover_from !== data.backend) {
				f.failoverFrom = data.failover_from;
			}
			// The reference view can first become visible here: a coalesced job, a
			// resumed session, or a failover successor never saw the submit payload.
			if (typeof data.preview_image_url === 'string' && data.preview_image_url && !f.hasReference) {
				f.hasReference = true;
				f.referenceUrl = data.preview_image_url;
				if (f.mode === 'text') f.plannedReference = true;
			}
			if (data.status === 'queued') {
				f.status = 'queued';
				f.queuedSeconds += 1;
			} else if (data.status === 'running') {
				f.status = 'running';
				f.queuedSeconds = 0;
				// A worker that answers "running" is up: the cold start is over, and
				// that is a real signal, not a timer expiring.
				f.coldStart = false;
			} else if (data.status === 'done') {
				f.status = 'finalizing';
			} else if (data.status === 'failed') {
				f.status = 'failed';
			}
			paint();
		},

		/** The GLB landed; the client is loading it into the viewer. */
		finalizing() {
			f.status = 'finalizing';
			paint();
		},

		/** The model is on screen. */
		complete() {
			f.status = 'done';
			f.coldStart = false;
			paint();
		},

		/** Terminal failure: freeze the rows where they are, drop the warming card. */
		fail() {
			f.status = 'failed';
			f.coldStart = false;
			paint();
		},

		/** Called once a second by the elapsed timer in forge.js. No state changes. */
		tick(elapsedS) {
			f.elapsedS = elapsedS;
			renderWarming();
		},

		/** The honest ETA the server reported for this job, or null. */
		etaSeconds() {
			return f.etaSeconds;
		},

		/** The art-directed prompt for the current job, or null. */
		directedPrompt() {
			return f.directedPrompt;
		},

		/** Is the current job on a cold (booting) worker? */
		isCold() {
			return f.coldStart;
		},
	};
}
