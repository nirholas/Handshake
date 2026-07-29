<script>
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import {
		ACESFilmicToneMapping,
		AnimationMixer,
		Box3,
		Clock,
		Color,
		DirectionalLight,
		HemisphereLight,
		PerspectiveCamera,
		PMREMGenerator,
		Scene,
		SkeletonHelper,
		SRGBColorSpace,
		Vector3,
		WebGLRenderer,
	} from 'three';
	import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

	const dispatch = createEventDispatcher();

	// Envelope produced by the forge tools (application/model-3d) or a bare
	// { glb } for GLB links found in message text.
	export let content = {};
	export let height = 340;

	let container;
	let canvas;
	// none → generating → loading → ready, or error / lost at any point.
	let state = 'none';
	let errorMessage = '';
	let loadPct = 0;
	let genPct = 0;
	let genLabel = 'Generating model';
	let hasSkeleton = false;
	let skeletonVisible = false;
	let glbUrl = content?.glb || null;

	let renderer = null;
	let scene = null;
	let camera = null;
	let controls = null;
	let mixer = null;
	let skeletonHelper = null;
	let clock = null;
	let rafId = 0;
	let visible = false;
	let started = false;
	let destroyed = false;
	let pollTimer = 0;
	let genTicker = 0;
	let intersectionObserver;
	let resizeObserver;

	const prompt = content?.prompt || '';
	const etaSeconds = typeof content?.eta === 'number' && content.eta > 0 ? content.eta : 60;
	const forgeUrl = 'https://three.ws/forge' + (prompt ? '?prompt=' + encodeURIComponent(prompt) : '');
	$: viewerUrl = glbUrl ? 'https://three.ws/viewer?src=' + encodeURIComponent(glbUrl) : null;
	$: arUrl = glbUrl ? 'https://three.ws/ar?src=' + encodeURIComponent(glbUrl) : null;

	onMount(() => {
		if (content?.error) {
			state = 'error';
			errorMessage = String(content.error);
			return;
		}
		// Defer all network + WebGL work until the card is near the viewport, so a
		// long thread full of models doesn't fetch and render everything at once.
		intersectionObserver = new IntersectionObserver(
			(entries) => {
				visible = entries[0].isIntersecting;
				if (visible && !started) {
					started = true;
					begin();
				}
			},
			{ rootMargin: '250px' },
		);
		intersectionObserver.observe(container);
	});

	onDestroy(() => {
		destroyed = true;
		intersectionObserver?.disconnect();
		resizeObserver?.disconnect();
		clearTimeout(pollTimer);
		clearInterval(genTicker);
		teardownScene();
	});

	function begin() {
		if (glbUrl) {
			loadModel(glbUrl);
		} else if (content?.job) {
			pollJob(content.job);
		} else {
			state = 'error';
			errorMessage = 'No model URL or generation job was provided.';
		}
	}

	function pollJob(job) {
		state = 'generating';
		const startedAt = Date.now();
		genTicker = setInterval(() => {
			const elapsed = (Date.now() - startedAt) / 1000;
			genPct = Math.min(95, Math.round((elapsed / etaSeconds) * 100));
		}, 500);
		const maxTries = 110; // ~4.5 minutes at 2.5s
		let tries = 0;
		const tick = async () => {
			if (destroyed) return;
			tries++;
			try {
				const res = await fetch('/api/forge?job=' + encodeURIComponent(job), { credentials: 'include' });
				if (res.ok) {
					const j = await res.json();
					if (j.status === 'done' && j.glb_url) {
						clearInterval(genTicker);
						glbUrl = j.glb_url;
						dispatch('resolved', { glb_url: j.glb_url });
						loadModel(j.glb_url);
						return;
					}
					if (j.status === 'failed') {
						clearInterval(genTicker);
						state = 'error';
						errorMessage = j.error ? String(j.error) : 'Generation failed.';
						return;
					}
					if (j.backend) genLabel = 'Generating model · ' + j.backend;
				}
			} catch {
				// Transient network error: keep polling until the try budget runs out.
			}
			if (tries >= maxTries) {
				clearInterval(genTicker);
				state = 'error';
				errorMessage = 'Generation timed out. Open the Forge to check on it.';
				return;
			}
			pollTimer = setTimeout(tick, 2500);
		};
		tick();
	}

	async function loadModel(url) {
		state = 'loading';
		loadPct = 0;
		try {
			const gltf = await new Promise((resolve, reject) => {
				new GLTFLoader().load(
					url,
					resolve,
					(ev) => {
						if (ev.total > 0) loadPct = Math.round((ev.loaded / ev.total) * 100);
					},
					reject,
				);
			});
			if (destroyed) return;
			// State first: animate() only runs while state === 'ready'.
			state = 'ready';
			setupScene(gltf);
		} catch {
			if (destroyed) return;
			state = 'error';
			errorMessage = 'Could not load the 3D model file.';
		}
	}

	function setupScene(gltf) {
		renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.toneMapping = ACESFilmicToneMapping;

		scene = new Scene();
		scene.background = new Color('#f1f3f6');
		const pmrem = new PMREMGenerator(renderer);
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();

		const model = gltf.scene;
		const box = new Box3().setFromObject(model);
		const center = box.getCenter(new Vector3());
		const size = box.getSize(new Vector3());
		const maxDim = Math.max(size.x, size.y, size.z) || 1;
		model.position.sub(center);
		scene.add(model);

		camera = new PerspectiveCamera(40, 1, maxDim / 100, maxDim * 100);
		const dist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
		camera.position.set(dist * 0.6, size.y * 0.15, dist * 1.5);

		controls = new OrbitControls(camera, canvas);
		controls.enableDamping = true;
		controls.autoRotate = true;
		controls.autoRotateSpeed = 1.4;
		controls.minDistance = maxDim * 0.4;
		controls.maxDistance = maxDim * 6;
		canvas.addEventListener('pointerdown', () => (controls.autoRotate = false), { once: true });
		canvas.addEventListener(
			'webglcontextlost',
			(ev) => {
				ev.preventDefault();
				cancelAnimationFrame(rafId);
				state = 'lost';
			},
			{ once: true },
		);

		scene.add(new HemisphereLight(0xffffff, 0x8892a0, 1.6));
		const key = new DirectionalLight(0xffffff, 1.8);
		key.position.set(3, 6, 4);
		scene.add(key);

		if (gltf.animations?.length) {
			mixer = new AnimationMixer(model);
			mixer.clipAction(gltf.animations[0]).play();
		}
		model.traverse((o) => {
			if (!hasSkeleton && o.isSkinnedMesh && o.skeleton) {
				hasSkeleton = true;
				skeletonHelper = new SkeletonHelper(model);
				skeletonHelper.visible = false;
				scene.add(skeletonHelper);
			}
		});

		clock = new Clock();
		resizeObserver = new ResizeObserver(fitCanvas);
		resizeObserver.observe(container);
		fitCanvas();
		animate();
	}

	function fitCanvas() {
		if (!renderer || !camera || !container) return;
		const w = container.clientWidth;
		renderer.setSize(w, height, false);
		camera.aspect = w / height;
		camera.updateProjectionMatrix();
	}

	function animate() {
		if (destroyed || state !== 'ready') return;
		rafId = requestAnimationFrame(animate);
		// Skip rendering while scrolled far offscreen; the context stays warm.
		if (!visible) return;
		if (mixer && clock) mixer.update(clock.getDelta());
		controls.update();
		renderer.render(scene, camera);
	}

	function teardownScene() {
		cancelAnimationFrame(rafId);
		controls?.dispose();
		if (scene) {
			scene.traverse((obj) => {
				obj.geometry?.dispose();
				const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
				for (const m of mats) {
					for (const v of Object.values(m)) v?.isTexture && v.dispose();
					m.dispose();
				}
			});
			scene.environment?.dispose();
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		mixer = null;
		controls = null;
	}

	function reload() {
		teardownScene();
		hasSkeleton = false;
		skeletonVisible = false;
		if (glbUrl) loadModel(glbUrl);
	}

	function toggleSkeleton() {
		if (!skeletonHelper) return;
		skeletonVisible = !skeletonVisible;
		skeletonHelper.visible = skeletonVisible;
	}

	function recenter() {
		if (!controls) return;
		controls.reset();
		controls.autoRotate = true;
	}

	function onKeydown(ev) {
		if (ev.key === 's' || ev.key === 'S') {
			toggleSkeleton();
			ev.preventDefault();
		}
	}
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<div
	bind:this={container}
	class="relative w-full overflow-hidden rounded-lg border border-slate-200 bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
	style="min-height: {height}px"
	tabindex="0"
	role="img"
	aria-label={prompt ? '3D model: ' + prompt : '3D model viewer'}
	on:keydown={onKeydown}
>
	{#if state === 'error'}
		<div class="flex flex-col items-center justify-center gap-3 px-6 text-center" style="height: {height}px">
			<span class="text-sm font-medium text-slate-700">3D generation didn't finish</span>
			<span class="max-w-md text-xs text-slate-500">{errorMessage}</span>
			<a
				href={forgeUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="rounded-full border border-slate-200 px-3.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
			>
				Retry in the Forge ↗
			</a>
		</div>
	{:else if state === 'generating' || state === 'none'}
		<div class="flex flex-col items-center justify-center gap-4 px-6" style="height: {height}px">
			{#if content?.preview}
				<img
					src={content.preview}
					alt="Concept preview for {prompt}"
					class="h-32 w-32 animate-pulse rounded-lg object-cover"
				/>
			{:else}
				<div class="h-32 w-32 animate-pulse rounded-lg bg-slate-100" />
			{/if}
			<div class="flex w-full max-w-xs flex-col gap-1.5">
				<div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
					<div
						class="h-full rounded-full bg-slate-500 transition-[width] duration-500"
						style="width: {genPct}%"
					/>
				</div>
				<span class="text-center text-xs text-slate-500">{genLabel} · usually ~{etaSeconds}s</span>
			</div>
		</div>
	{:else if state === 'loading'}
		<div class="flex flex-col items-center justify-center gap-4 px-6" style="height: {height}px">
			<div class="h-32 w-32 animate-pulse rounded-lg bg-slate-100" />
			<div class="flex w-full max-w-xs flex-col gap-1.5">
				<div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
					<div
						class="h-full rounded-full bg-slate-500 transition-[width] duration-300"
						style="width: {loadPct}%"
					/>
				</div>
				<span class="text-center text-xs text-slate-500">Loading model…</span>
			</div>
		</div>
	{:else if state === 'lost'}
		<div class="flex flex-col items-center justify-center gap-3 px-6" style="height: {height}px">
			<span class="text-xs text-slate-500">The 3D view was paused to free graphics memory.</span>
			<button
				on:click={reload}
				class="rounded-full border border-slate-200 px-3.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
			>
				Reload 3D view
			</button>
		</div>
	{/if}

	<canvas
		bind:this={canvas}
		class="{state === 'ready' ? 'block' : 'hidden'} w-full touch-none"
		style="height: {height}px"
	/>

	{#if state === 'ready'}
		{#if prompt || content?.status_note}
			<div class="pointer-events-none absolute left-3 top-2.5 max-w-[70%] rounded-lg bg-white/80 px-2.5 py-1.5 backdrop-blur-sm">
				{#if prompt}
					<div class="truncate text-xs font-medium text-slate-700">{prompt}</div>
				{/if}
				{#if content?.status_note}
					<div class="mt-0.5 text-[10px] text-slate-500">{content.status_note}</div>
				{/if}
			</div>
		{/if}
		<div class="absolute bottom-2.5 left-3 right-3 flex flex-wrap items-center gap-1.5">
			<a
				href={glbUrl}
				download="model.glb"
				class="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-[11px] text-slate-600 backdrop-blur-sm transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
			>
				Download GLB
			</a>
			<a
				href={viewerUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-[11px] text-slate-600 backdrop-blur-sm transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
			>
				Viewer ↗
			</a>
			<a
				href={arUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-[11px] text-slate-600 backdrop-blur-sm transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
			>
				View in AR ↗
			</a>
			{#if content?.saved_url}
				<a
					href={content.saved_url}
					target="_blank"
					rel="noopener noreferrer"
					class="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-[11px] text-slate-600 backdrop-blur-sm transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
				>
					In your library ↗
				</a>
			{/if}
			<button
				on:click={recenter}
				class="ml-auto rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-[11px] text-slate-600 backdrop-blur-sm transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
				aria-label="Recenter the camera"
			>
				Recenter
			</button>
			{#if hasSkeleton}
				<button
					on:click={toggleSkeleton}
					class="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-[11px] backdrop-blur-sm transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400 {skeletonVisible
						? 'bg-slate-700 text-white hover:bg-slate-600'
						: 'text-slate-600'}"
					aria-pressed={skeletonVisible}
					aria-label="Toggle skeleton overlay (S)"
				>
					Skeleton
				</button>
			{/if}
		</div>
	{/if}
</div>
