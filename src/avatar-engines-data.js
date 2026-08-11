// Avatar Engines Atlas: the curated, factual registry of the open-source and
// commercial engines that produce high-quality / photoreal human avatars.
//
// This is a *reference* surface, not an endorsement: it tells a builder, for
// each engine, what it makes, what it eats, what it runs on, what its license
// permits, and exactly how (or whether) three.ws can use it today. The
// `integration` field is the honest answer to "can I click a button here and
// get an avatar?" See INTEGRATIONS below.
//
// Licensing is load-bearing. Many of the highest-fidelity research engines
// (ECON, ICON, the Max-Planck body/face models, the Gaussian-Splatting stack)
// ship under *non-commercial research* licenses. three.ws is a commercial
// platform, so those are surfaced for self-hosted/academic use and flagged
// `commercial: false`. They are deliberately NOT wired into the paid
// generation backend. Only `commercial: true` mesh engines deep-link into the
// live /forge pipeline.
//
// Each entry's facts (repo, venue, license, representation) are sourced from the
// project's own repository/paper. Keep this file the single source of truth;
// the /avatar-engines page renders straight from it.
//
// Two optional fields carry the parts of that truth that change after an entry
// lands:
//   status: 'retired'  the project or service is no longer operating. The card
//                      shows a Retired badge and the entry can never claim a
//                      live/forge integration. Engines do not get deleted when
//                      they die: builders still hold their exported assets and
//                      need to know what happened.
//   links.docs         official documentation that is not a paper. Without it a
//                      docs site rendered as a "Paper" button, which misstated
//                      what the reader was about to open.

// How three.ws relates to each engine, in plain terms.
export const INTEGRATIONS = Object.freeze({
	live: Object.freeze({
		id: 'live',
		label: 'Live on three.ws',
		blurb: 'Already wired into a three.ws product surface you can use right now.',
		tone: 'live',
	}),
	forge: Object.freeze({
		id: 'forge',
		label: 'Generate in Forge',
		blurb: 'Commercially licensed and reachable through the live /forge text/image → GLB pipeline.',
		tone: 'forge',
	}),
	splat: Object.freeze({
		id: 'splat',
		label: 'View in Splat Viewer',
		blurb: 'Produces Gaussian-splat / radiance-field output you can drop straight into the three.ws splat viewer.',
		tone: 'splat',
	}),
	interop: Object.freeze({
		id: 'interop',
		label: 'Interop',
		blurb: 'Emits a standard rigged format (glTF/VRM/FBX) the three.ws viewer and animation pipeline already understand.',
		tone: 'interop',
	}),
	reference: Object.freeze({
		id: 'reference',
		label: 'Reference / self-host',
		blurb: 'Run it yourself: license or compute profile keeps it out of the commercial pipeline. Linked here for builders.',
		tone: 'reference',
	}),
});

// Representation the engine outputs, which drives the "can the three.ws animation
// pipeline drive it?" intuition. Mesh/glTF → yes; gaussian/nerf → needs the
// splat/volume renderer, not the skinned-mesh animator.
export const REPRESENTATIONS = Object.freeze({
	mesh: { id: 'mesh', label: 'Mesh', note: 'Skinned/standard polygon mesh. Riggable, GLB-exportable.' },
	gltf: { id: 'gltf', label: 'glTF / VRM', note: 'Standard rigged avatar format. Loads directly in the viewer.' },
	parametric: { id: 'parametric', label: 'Parametric model', note: 'A statistical body/face model (SMPL-family) others build on.' },
	gaussian: { id: 'gaussian', label: '3D Gaussians', note: 'Gaussian-splat radiance field. Photoreal, needs a splat renderer.' },
	nerf: { id: 'nerf', label: 'Neural field', note: 'NeRF/volumetric. Photoreal, rendered by ray-marching, not rigged.' },
});

// Engine families, ordered the way the page presents them.
export const FAMILIES = Object.freeze([
	{
		id: 'photoreal-head',
		label: 'Photoreal head avatars',
		blurb: 'Gaussian-splat and neural-field heads reconstructed from video: the current state of the art for realistic faces.',
	},
	{
		id: 'image-to-human',
		label: 'Image → 3D human',
		blurb: 'Turn one photo (or a few) into a posed, clothed, textured 3D human you can rig.',
	},
	{
		id: 'text-to-avatar',
		label: 'Text / image → 3D avatar',
		blurb: 'Generative pipelines that author a whole avatar from a prompt: the same lane three.ws Forge lives in.',
	},
	{
		id: 'parametric',
		label: 'Parametric body & face models',
		blurb: 'The statistical human models almost every method above is built on. The foundation layer.',
	},
	{
		id: 'production',
		label: 'Production & interop',
		blurb: 'Battle-tested avatar formats and platforms: the rigs three.ws already loads and animates.',
	},
]);

// The registry. `commercial` = license permits commercial use as-is.
export const ENGINES = Object.freeze([
	// ── Photoreal head avatars ───────────────────────────────────────────────
	{
		id: 'gaussian-avatars',
		name: 'GaussianAvatars',
		org: 'Qian et al. · TU Munich / Toyota',
		year: 2024,
		venue: 'CVPR 2024 Highlight',
		family: 'photoreal-head',
		representation: 'gaussian',
		input: 'Multi-view face video',
		output: 'Rigged 3D Gaussians on a FLAME mesh',
		license: 'Non-commercial research (Gaussian-Splatting + FLAME)',
		commercial: false,
		compute: 'GPU training, per-subject',
		integration: 'splat',
		integrationNote: 'Export the trained splat and inspect it in the three.ws Splat Viewer. Animation is driven by FLAME, not the skinned-mesh pipeline.',
		blurb: 'Photorealistic, fully controllable head avatars: 3D Gaussians rigged to a parametric face model for expression and pose transfer.',
		links: {
			repo: 'https://github.com/ShenhanQian/GaussianAvatars',
			paper: 'https://arxiv.org/abs/2312.02069',
			demo: 'https://shenhanqian.github.io/gaussian-avatars',
		},
	},
	{
		id: 'gaussian-head-avatar',
		name: 'Gaussian Head Avatar',
		org: 'Xu et al. · NeRSemble',
		year: 2024,
		venue: 'CVPR 2024',
		family: 'photoreal-head',
		representation: 'gaussian',
		input: 'Multi-view face video',
		output: 'Controllable 3D Gaussian head',
		license: 'Non-commercial research',
		commercial: false,
		compute: 'GPU training, per-subject',
		integration: 'splat',
		integrationNote: 'Ultra-high-fidelity splat output: view exported scenes in the three.ws Splat Viewer.',
		blurb: 'Ultra high-fidelity head avatars via controllable dynamic 3D Gaussians, targeting 2K-resolution rendering.',
		links: {
			repo: 'https://github.com/YuelangX/Gaussian-Head-Avatar',
			paper: 'https://arxiv.org/abs/2312.03029',
			demo: 'https://yuelangx.github.io/gaussianheadavatar/',
		},
	},
	{
		id: 'insta',
		name: 'INSTA',
		org: 'Zielinski et al. · MPI',
		year: 2023,
		venue: 'CVPR 2023',
		family: 'photoreal-head',
		representation: 'nerf',
		input: 'Monocular face video (~10 min train)',
		output: 'Instant volumetric head avatar (NeRF)',
		license: 'Non-commercial research',
		commercial: false,
		compute: 'GPU training (minutes)',
		integration: 'reference',
		integrationNote: 'Neural-field output, rendered by ray-marching, not the three.ws splat/mesh pipelines. Linked for builders self-hosting.',
		blurb: 'Instant Volumetric Head Avatars: trains a deformable NeRF head from a short monocular video in about ten minutes.',
		links: {
			repo: 'https://github.com/Zielon/INSTA',
			paper: 'https://arxiv.org/abs/2211.12499',
			demo: 'https://zielon.github.io/insta/',
		},
	},
	{
		id: 'imavatar',
		name: 'IMavatar',
		org: 'Zheng et al. · ETH / MPI',
		year: 2022,
		venue: 'CVPR 2022',
		family: 'photoreal-head',
		representation: 'nerf',
		input: 'Monocular face video',
		output: 'Implicit morphable head avatar',
		license: 'Non-commercial research',
		commercial: false,
		compute: 'GPU training, per-subject',
		integration: 'reference',
		integrationNote: 'Implicit field representation: self-host for research. Not wired into the commercial pipeline.',
		blurb: 'Implicit Morphable head Avatars: learns an animatable implicit head with expression and pose control from video.',
		links: {
			repo: 'https://github.com/zhengyuf/IMavatar',
			paper: 'https://arxiv.org/abs/2112.07471',
			demo: 'https://ait.ethz.ch/imavatar',
		},
	},
	{
		id: 'geneface',
		name: 'GeneFace++',
		org: 'Ye et al. · Zhejiang Univ.',
		year: 2023,
		venue: 'arXiv / ICLR lineage',
		family: 'photoreal-head',
		representation: 'nerf',
		input: 'Audio + target portrait video',
		output: 'Audio-driven talking-head (NeRF)',
		license: 'MIT (code) · research models',
		commercial: false,
		compute: 'GPU training + inference',
		integration: 'reference',
		integrationNote: 'Produces lip-synced talking-head video from speech. Pair conceptually with the three.ws audio2face/voice lane; self-host the renderer.',
		blurb: 'Generalized and stable audio-driven talking-face generation: real-time lip-sync from arbitrary speech.',
		links: {
			repo: 'https://github.com/yerfor/GeneFacePlusPlus',
			paper: 'https://arxiv.org/abs/2305.00787',
			demo: 'https://genefaceplusplus.github.io/',
		},
	},

	// ── Image → 3D human ─────────────────────────────────────────────────────
	{
		id: 'pifuhd',
		name: 'PIFuHD',
		org: 'Saito et al. · Meta AI',
		year: 2020,
		venue: 'CVPR 2020 Oral',
		family: 'image-to-human',
		representation: 'mesh',
		input: 'Single full-body photo',
		output: 'High-resolution clothed mesh (.obj)',
		license: 'CC BY-NC 4.0 (non-commercial)',
		commercial: false,
		compute: 'GPU inference (Colab available)',
		integration: 'reference',
		integrationNote: 'The classic single-image human. Non-commercial license keeps it out of the paid pipeline: self-host or use the official Colab.',
		blurb: 'Pixel-aligned implicit function at high resolution: the reference single-image clothed-human reconstruction baseline.',
		links: {
			repo: 'https://github.com/facebookresearch/pifuhd',
			paper: 'https://arxiv.org/abs/2004.00452',
			demo: 'https://shunsukesaito.github.io/PIFuHD/',
		},
	},
	{
		id: 'econ',
		name: 'ECON',
		org: 'Xiu et al. · Max Planck',
		year: 2023,
		venue: 'CVPR 2023 Highlight',
		family: 'image-to-human',
		representation: 'mesh',
		input: 'Single photo (loose clothing / hard poses)',
		output: 'Detailed clothed mesh',
		license: 'Non-commercial research (Max Planck)',
		commercial: false,
		compute: 'GPU inference',
		integration: 'reference',
		integrationNote: 'State-of-the-art single-image humans, even in loose clothing. Try the authors’ Hugging Face Space; license blocks commercial wiring.',
		blurb: 'Explicit Clothed humans Optimized via Normal integration: combines implicit detail with explicit SMPL-X structure for robust in-the-wild reconstruction.',
		links: {
			repo: 'https://github.com/YuliangXiu/ECON',
			paper: 'https://arxiv.org/abs/2212.07422',
			demo: 'https://huggingface.co/spaces/Yuliang/ECON',
		},
	},
	{
		id: 'icon',
		name: 'ICON',
		org: 'Xiu et al. · Max Planck',
		year: 2022,
		venue: 'CVPR 2022',
		family: 'image-to-human',
		representation: 'mesh',
		input: 'Single photo',
		output: 'Clothed mesh (normal-guided)',
		license: 'Non-commercial research (Max Planck)',
		commercial: false,
		compute: 'GPU inference',
		integration: 'reference',
		integrationNote: 'Predecessor to ECON; SMPL-conditioned implicit reconstruction. Hugging Face Space available; non-commercial only.',
		blurb: 'Implicit Clothed humans Obtained from Normals: local-feature implicit reconstruction conditioned on an SMPL body prior.',
		links: {
			repo: 'https://github.com/YuliangXiu/ICON',
			paper: 'https://arxiv.org/abs/2112.09127',
			demo: 'https://huggingface.co/spaces/Yuliang/ICON',
		},
	},
	{
		id: 'sith',
		name: 'SiTH',
		org: 'Ho et al. · ETH Zürich',
		year: 2024,
		venue: 'CVPR 2024',
		family: 'image-to-human',
		representation: 'mesh',
		input: 'Single photo',
		output: 'Full textured 3D human mesh',
		license: 'Non-commercial research',
		commercial: false,
		compute: 'GPU inference (diffusion)',
		integration: 'reference',
		integrationNote: 'Diffusion-based back-view hallucination + mesh reconstruction. Self-host for research.',
		blurb: 'Single-view Textured Human reconstruction: image-conditioned diffusion hallucinates the unseen back, then lifts both views to a textured mesh.',
		links: {
			repo: 'https://github.com/SiTH-Diffusion/SiTH',
			paper: 'https://arxiv.org/abs/2311.15855',
			demo: 'https://ait.ethz.ch/sith',
		},
	},
	{
		id: 'pifu',
		name: 'PIFu',
		org: 'Saito et al. · USC / Meta',
		year: 2019,
		venue: 'ICCV 2019',
		family: 'image-to-human',
		representation: 'mesh',
		input: 'Single or multi-view photo',
		output: 'Textured clothed mesh',
		license: 'Custom research (non-commercial)',
		commercial: false,
		compute: 'GPU inference',
		integration: 'reference',
		integrationNote: 'The original pixel-aligned implicit function, and the foundation of this whole family. Self-host for research and study.',
		blurb: 'The original Pixel-aligned Implicit Function for clothed-human digitization: the method PIFuHD and most of this column descend from.',
		links: {
			repo: 'https://github.com/shunsukesaito/PIFu',
			paper: 'https://arxiv.org/abs/1905.05172',
			demo: 'https://shunsukesaito.github.io/PIFu/',
		},
	},

	// ── Text / image → 3D avatar ─────────────────────────────────────────────
	{
		id: 'trellis',
		name: 'TRELLIS',
		org: 'Microsoft Research',
		year: 2024,
		venue: 'arXiv 2024',
		family: 'text-to-avatar',
		representation: 'mesh',
		input: 'Text prompt or image',
		output: 'Textured 3D asset (mesh + radiance)',
		license: 'MIT',
		commercial: true,
		compute: 'Cloud API (NVIDIA NIM / self-host)',
		integration: 'live',
		integrationNote: 'Powers the free three.ws Forge lane (forge_free) end-to-end: text/image → rig-ready GLB. Click straight through to /forge.',
		blurb: 'Structured 3D latents for versatile, high-quality generation: the MIT-licensed engine behind the free three.ws text/image → 3D lane.',
		links: {
			repo: 'https://github.com/microsoft/TRELLIS',
			paper: 'https://arxiv.org/abs/2412.01506',
			demo: '/forge',
		},
		cta: { label: 'Generate in Forge', href: '/forge' },
	},
	{
		id: 'tada',
		name: 'TADA!',
		org: 'Liao et al. · MPI / ETH',
		year: 2024,
		venue: '3DV 2024',
		family: 'text-to-avatar',
		representation: 'mesh',
		input: 'Text prompt',
		output: 'Animatable SMPL-X avatar (mesh + texture)',
		license: 'Non-commercial research (SMPL-X)',
		commercial: false,
		compute: 'GPU optimization (per-prompt)',
		integration: 'reference',
		integrationNote: 'Outputs a CG-ready, riggable SMPL-X avatar, conceptually closest to Forge’s text→avatar lane, but SMPL-X licensing keeps it self-host.',
		blurb: 'Text to Animatable Digital Avatars: optimizes a displacement-enhanced SMPL-X body plus a texture map into a holistic, animation-ready avatar.',
		links: {
			repo: 'https://github.com/TingtingLiao/TADA',
			paper: 'https://arxiv.org/abs/2308.10899',
			demo: 'https://tada.is.tue.mpg.de/',
		},
	},
	{
		id: 'humangaussian',
		name: 'HumanGaussian',
		org: 'Liu et al. · NTU / Shanghai AI Lab',
		year: 2024,
		venue: 'CVPR 2024 Highlight',
		family: 'text-to-avatar',
		representation: 'gaussian',
		input: 'Text prompt',
		output: '3D human as SMPL-X-anchored Gaussians',
		license: 'Non-commercial research',
		commercial: false,
		compute: 'GPU optimization (per-prompt)',
		integration: 'splat',
		integrationNote: 'Generates a full-body Gaussian human from text: export the splat and view it in the three.ws Splat Viewer.',
		blurb: 'Text-driven 3D human generation that anchors Gaussian splats to an SMPL-X body, with a structure-aware SDS for fast, detailed results.',
		links: {
			repo: 'https://github.com/alvinliu0/HumanGaussian',
			paper: 'https://arxiv.org/abs/2311.17061',
			demo: 'https://alvinliu0.github.io/projects/HumanGaussian',
		},
	},
	{
		id: 'avatarclip',
		name: 'AvatarCLIP',
		org: 'Hong et al. · NTU',
		year: 2022,
		venue: 'SIGGRAPH 2022',
		family: 'text-to-avatar',
		representation: 'nerf',
		input: 'Text prompt (shape + appearance + motion)',
		output: 'SMPL-based neural avatar + animation',
		license: 'Non-commercial research',
		commercial: false,
		compute: 'GPU optimization',
		integration: 'reference',
		integrationNote: 'Zero-shot text-driven generation and animation. Neural representation: self-host for research.',
		blurb: 'Zero-shot text-driven generation and animation of 3D avatars: CLIP-guided shape, texture, and motion from a single description.',
		links: {
			repo: 'https://github.com/hongfz16/AvatarCLIP',
			paper: 'https://arxiv.org/abs/2205.08535',
			demo: 'https://hongfz16.github.io/projects/AvatarCLIP.html',
		},
	},
	{
		id: 'dreamhuman',
		name: 'DreamHuman',
		org: 'Kolotouros et al. · Google',
		year: 2023,
		venue: 'NeurIPS 2023',
		family: 'text-to-avatar',
		representation: 'nerf',
		input: 'Text prompt',
		output: 'Animatable pose-conditioned NeRF human',
		license: 'Research (paper + page; no official weights)',
		commercial: false,
		compute: 'GPU optimization',
		integration: 'reference',
		integrationNote: 'Text → animatable deformable NeRF human. Reference method; linked for completeness.',
		blurb: 'Generates animatable 3D human avatars from text using a deformable, pose-conditioned NeRF guided by 2D diffusion priors.',
		links: {
			repo: 'https://dream-human.github.io/',
			paper: 'https://arxiv.org/abs/2306.09329',
			demo: 'https://dream-human.github.io/',
		},
	},

	// ── Parametric body & face models ────────────────────────────────────────
	{
		id: 'smplx',
		name: 'SMPL-X',
		org: 'Pavlakos et al. · Max Planck',
		year: 2019,
		venue: 'CVPR 2019',
		family: 'parametric',
		representation: 'parametric',
		input: 'Pose + shape + expression params',
		output: 'Expressive body+hands+face mesh',
		license: 'Non-commercial research (Max Planck)',
		commercial: false,
		compute: 'CPU/GPU (real-time)',
		integration: 'reference',
		integrationNote: 'The expressive body model underpinning TADA, ECON, HumanGaussian and most methods here. Foundation layer, non-commercial.',
		blurb: 'SMPL eXpressive: one differentiable model unifying body, hands, and face. The substrate nearly every method on this page builds on.',
		links: {
			repo: 'https://github.com/vchoutas/smplx',
			paper: 'https://arxiv.org/abs/1904.05866',
			demo: 'https://smpl-x.is.tue.mpg.de/',
		},
	},
	{
		id: 'smpl',
		name: 'SMPL',
		org: 'Loper et al. · Max Planck',
		year: 2015,
		venue: 'SIGGRAPH Asia 2015',
		family: 'parametric',
		representation: 'parametric',
		input: 'Pose + shape params',
		output: 'Skinned body mesh',
		license: 'Non-commercial research (Max Planck)',
		commercial: false,
		compute: 'CPU/GPU (real-time)',
		integration: 'reference',
		integrationNote: 'The original learned body model: the common language of 3D human research. Non-commercial.',
		blurb: 'A Skinned Multi-Person Linear body model: the field-defining parametric human that started the modern 3D-body era.',
		links: {
			repo: 'https://github.com/vchoutas/smplx',
			paper: 'https://files.is.tue.mpg.de/black/papers/SMPL2015.pdf',
			demo: 'https://smpl.is.tue.mpg.de/',
		},
	},
	{
		id: 'flame',
		name: 'FLAME',
		org: 'Li et al. · Max Planck',
		year: 2017,
		venue: 'SIGGRAPH Asia 2017',
		family: 'parametric',
		representation: 'parametric',
		input: 'Shape + pose + expression params',
		output: 'Articulated head & face mesh',
		license: 'Non-commercial research (Max Planck)',
		commercial: false,
		compute: 'CPU/GPU (real-time)',
		integration: 'reference',
		integrationNote: 'The head model that rigs GaussianAvatars and most photoreal-head methods. Foundation layer, non-commercial.',
		blurb: 'Faces Learned with an Articulated Model and Expressions: the standard parametric head that drives the photoreal-head column.',
		links: {
			repo: 'https://github.com/Rubikplayer/flame-fitting',
			paper: 'https://ps.is.mpg.de/publications/flame-siggraph-asia-2017',
			demo: 'https://flame.is.tue.mpg.de/',
		},
	},
	{
		id: 'star',
		name: 'STAR',
		org: 'Osman et al. · Max Planck',
		year: 2020,
		venue: 'ECCV 2020',
		family: 'parametric',
		representation: 'parametric',
		input: 'Pose + shape params',
		output: 'Sparse-corrective body mesh',
		license: 'Non-commercial research (Max Planck)',
		commercial: false,
		compute: 'CPU/GPU (real-time)',
		integration: 'reference',
		integrationNote: 'A more accurate, sparser successor to SMPL. Foundation layer, non-commercial.',
		blurb: 'Sparse Trained Articulated human body Regressor: a successor to SMPL with realistic, localized pose-dependent deformations.',
		links: {
			repo: 'https://github.com/ahmedosman/STAR',
			paper: 'https://arxiv.org/abs/2008.08535',
			demo: 'https://star.is.tue.mpg.de/',
		},
	},

	// ── Production & interop ──────────────────────────────────────────────────
	{
		id: 'mixamo',
		name: 'Mixamo',
		org: 'Adobe',
		year: 2008,
		venue: 'Commercial service',
		family: 'production',
		representation: 'gltf',
		input: 'Uploaded humanoid mesh',
		output: 'Auto-rigged character + animation library',
		license: 'Free for use (Adobe terms)',
		commercial: true,
		compute: 'Cloud service',
		integration: 'live',
		integrationNote: 'The three.ws animation pipeline canonicalizes against the Mixamo skeleton, so every Mixamo rig drives the pre-baked clip library.',
		blurb: 'Adobe’s auto-rigger and animation library: the de-facto humanoid skeleton the three.ws retargeting pipeline is built around.',
		links: {
			repo: 'https://www.mixamo.com/',
			demo: '/animations',
		},
		cta: { label: 'Animation Gallery', href: '/animations' },
	},
	{
		id: 'ready-player-me',
		name: 'Ready Player Me',
		org: 'Ready Player Me (Netflix)',
		year: 2020,
		venue: 'Commercial platform, retired 31 Jan 2026',
		family: 'production',
		representation: 'gltf',
		input: 'Selfie or config',
		output: 'Rigged glTF avatar (half/full body)',
		license: 'Commercial SDK (service discontinued)',
		commercial: false,
		compute: 'Cloud API (offline)',
		status: 'retired',
		integration: 'reference',
		integrationNote: 'The avatar creator and developer API shut down on 31 January 2026 after Netflix acquired the company, so no new avatars can be minted. GLB files exported before the shutdown are plain rigged glTF and still load and animate in the three.ws viewer.',
		blurb: 'The cross-app glTF avatar platform that set the interop bar before Netflix took it in-house and closed the public service. Listed as history, and because millions of exported RPM GLBs are still in circulation.',
		links: {
			repo: 'https://github.com/readyplayerme',
		},
	},
	{
		id: 'univrm',
		name: 'VRM / UniVRM',
		org: 'VRM Consortium · pixiv',
		year: 2018,
		venue: 'Open standard',
		family: 'production',
		representation: 'gltf',
		input: 'glTF-based avatar',
		output: 'VRM rigged avatar (interoperable)',
		license: 'MIT',
		commercial: true,
		compute: 'Client',
		integration: 'interop',
		integrationNote: 'three.ws already maps VRM/VRoid bone names in glb-canonicalize.js, so VRM avatars animate out of the box.',
		blurb: 'The open, glTF-based standard for interoperable humanoid avatars: the dominant rig format for VTuber and metaverse pipelines.',
		links: {
			repo: 'https://github.com/vrm-c/UniVRM',
			docs: 'https://vrm.dev/en/',
		},
	},
	{
		id: 'three-vrm',
		name: 'three-vrm',
		org: 'pixiv',
		year: 2020,
		venue: 'Open-source library',
		family: 'production',
		representation: 'gltf',
		input: 'VRM file',
		output: 'Three.js-rendered VRM avatar',
		license: 'MIT',
		commercial: true,
		compute: 'Client (Three.js)',
		integration: 'interop',
		integrationNote: 'The Three.js VRM loader, same renderer family as the three.ws viewer, so VRM heads/bodies render with no extra runtime.',
		blurb: 'The official Three.js loader for VRM avatars: spring-bone physics, expressions, and look-at, in the browser.',
		links: {
			repo: 'https://github.com/pixiv/three-vrm',
			docs: 'https://pixiv.github.io/three-vrm/packages/three-vrm/docs/',
			demo: 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/',
		},
	},
	{
		id: 'avaturn',
		name: 'Avaturn',
		org: 'Avaturn',
		year: 2022,
		venue: 'Commercial platform',
		family: 'production',
		representation: 'gltf',
		input: 'Single selfie',
		output: 'Realistic rigged glTF avatar',
		license: 'Commercial SDK',
		commercial: true,
		compute: 'Cloud API',
		integration: 'interop',
		integrationNote: 'The Avaturn skeleton is the canonical target three.ws retargets onto, so its avatars are first-class in the animation pipeline.',
		blurb: 'Photo-to-avatar that outputs realistic, rigged glTF bodies: the skeleton convention the three.ws animation system canonicalizes to.',
		links: {
			repo: 'https://avaturn.me/',
			docs: 'https://docs.avaturn.me/',
		},
	},
]);

// ── Derived helpers (pure) ───────────────────────────────────────────────────

export function enginesByFamily(familyId) {
	return ENGINES.filter((e) => e.family === familyId);
}

export function isRetired(engine) {
	return engine.status === 'retired';
}

export function engineStats() {
	const total = ENGINES.length;
	const commercial = ENGINES.filter((e) => e.commercial).length;
	const live = ENGINES.filter((e) => e.integration === 'live' || e.integration === 'forge').length;
	const splat = ENGINES.filter((e) => e.integration === 'splat').length;
	const retired = ENGINES.filter(isRetired).length;
	return { total, commercial, live, splat, retired, families: FAMILIES.length };
}
