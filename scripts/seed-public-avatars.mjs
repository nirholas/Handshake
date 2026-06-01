/**
 * seed-public-avatars.mjs
 * ───────────────────────
 * Populate the avatars table with public, embeddable GLBs so /discover has
 * something to show besides the (currently sparse) onchain index.
 *
 * Sources:
 *   • local: GLBs already in the repo (cz, soldier, robotexpressive, etc.)
 *   • khronos: Khronos glTF Sample Assets (CC0/CC-BY)
 *   • threejs: three.js example models
 *
 * Owner: a seed user (default seed@3dagent.dev). Override with --email=<addr>.
 * Visibility: public. Idempotent on (owner_id, slug).
 *
 * Usage:
 *   node scripts/seed-public-avatars.mjs                    # all sources
 *   node scripts/seed-public-avatars.mjs --source=local     # one source
 *   node scripts/seed-public-avatars.mjs --dry-run          # plan only
 *   node scripts/seed-public-avatars.mjs --email=me@x.com   # custom owner
 *
 * Required env: DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY_ID,
 *               S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_DOMAIN.
 */

import { neon } from '@neondatabase/serverless';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v] = a.replace(/^--/, '').split('=');
		return [k, v ?? true];
	}),
);
const SOURCE = args.source || 'all';
const DRY_RUN = !!args['dry-run'];
const OWNER_EMAIL = args.email || 'seed@3dagent.dev';
const SEED_DISPLAY_NAME = 'Three.ws Showcase';

if (!process.env.DATABASE_URL) {
	console.error('Missing DATABASE_URL'); process.exit(1);
}
if (!DRY_RUN) {
	for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN']) {
		if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }
	}
}

const sql = neon(process.env.DATABASE_URL);
const s3 = DRY_RUN
	? null
	: new S3Client({
		region: 'auto',
		endpoint: process.env.S3_ENDPOINT.replace(/\/$/, ''),
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY_ID,
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
		},
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
	});

// ── catalog ─────────────────────────────────────────────────────────────────
// Each entry: { source, name, slug, description, tags, file? (local path) | url?, license }
const KHRONOS = (path, file) =>
	`https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${path}/glTF-Binary/${file}`;
const THREE_GLTF = (file) =>
	`https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/${file}`;

const CATALOG = [
	// ── local repo GLBs ─────────────────────────────────────────────────────
	{
		source: 'local', name: 'CZ', slug: 'cz',
		description: 'Stylized humanoid avatar (CZ).',
		tags: ['humanoid', 'character'],
		file: 'public/avatars/cz.glb', license: 'internal',
	},
	{
		source: 'local', name: 'Soldier', slug: 'soldier',
		description: 'Mixamo-rigged soldier with walk/run/idle animations.',
		tags: ['humanoid', 'rigged', 'mixamo'],
		file: 'public/animations/soldier.glb', license: 'CC-BY (Mixamo)',
	},
	{
		source: 'local', name: 'Robot Expressive', slug: 'robot-expressive',
		description: 'Three.js demo robot with expressive animations.',
		tags: ['robot', 'rigged', 'demo'],
		file: 'public/animations/robotexpressive.glb', license: 'MIT (three.js)',
	},
	{
		source: 'local', name: 'Floating Character', slug: 'floating-character',
		description: 'Sims-style floating character.',
		tags: ['character', 'lowpoly'],
		file: 'sims-demo/public/Floating Character.glb', license: 'internal',
	},

	// ── Khronos glTF Sample Assets (mostly CC0 / CC-BY) ─────────────────────
	{
		source: 'khronos', name: 'Fox', slug: 'fox',
		description: 'Stylized fox with idle, walk, and run animations. CC0.',
		tags: ['animal', 'rigged', 'cc0'],
		url: KHRONOS('Fox', 'Fox.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'CesiumMan', slug: 'cesium-man',
		description: 'Walking humanoid reference rig. CC-BY 4.0.',
		tags: ['humanoid', 'rigged', 'reference'],
		url: KHRONOS('CesiumMan', 'CesiumMan.glb'), license: 'CC-BY 4.0',
	},
	{
		source: 'khronos', name: 'BrainStem', slug: 'brain-stem',
		description: 'Animated rigged figure (Khronos sample). CC-BY 4.0.',
		tags: ['humanoid', 'rigged', 'reference'],
		url: KHRONOS('BrainStem', 'BrainStem.glb'), license: 'CC-BY 4.0',
	},
	{
		source: 'khronos', name: 'Damaged Helmet', slug: 'damaged-helmet',
		description: 'Battle-damaged sci-fi helmet — the canonical PBR test asset.',
		tags: ['prop', 'pbr'],
		url: KHRONOS('DamagedHelmet', 'DamagedHelmet.glb'), license: 'CC-BY 4.0',
	},
	{
		source: 'khronos', name: 'Avocado', slug: 'avocado',
		description: 'Photorealistic avocado. The internet\'s favorite glTF sample.',
		tags: ['prop', 'food'],
		url: KHRONOS('Avocado', 'Avocado.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Boom Box', slug: 'boom-box',
		description: 'Vintage portable cassette player. CC0.',
		tags: ['prop', 'object'],
		url: KHRONOS('BoomBox', 'BoomBox.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Lantern', slug: 'lantern',
		description: 'Hanging lantern with metal and glass. CC0.',
		tags: ['prop', 'object'],
		url: KHRONOS('Lantern', 'Lantern.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Water Bottle', slug: 'water-bottle',
		description: 'Translucent plastic water bottle. CC0.',
		tags: ['prop', 'object'],
		url: KHRONOS('WaterBottle', 'WaterBottle.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Antique Camera', slug: 'antique-camera',
		description: 'Vintage bellows camera. CC0.',
		tags: ['prop', 'vintage'],
		url: KHRONOS('AntiqueCamera', 'AntiqueCamera.glb'), license: 'CC0',
	},

	// ── Khronos glTF Sample Assets — extended ───────────────────────────────
	{
		source: 'khronos', name: 'Duck', slug: 'duck',
		description: 'Classic rubber duck — one of the original glTF reference models.',
		tags: ['prop', 'animal', 'cc0'],
		url: KHRONOS('Duck', 'Duck.glb'), license: 'CC-BY 2.0',
	},
{
		source: 'khronos', name: 'Toy Car', slug: 'toy-car',
		description: 'Colourful toy car with clearcoat and iridescent paint.',
		tags: ['prop', 'vehicle', 'pbr'],
		url: KHRONOS('ToyCar', 'ToyCar.glb'), license: 'CC0',
	},
{
		source: 'khronos', name: 'Barramundi Fish', slug: 'barramundi-fish',
		description: 'Photorealistic barramundi fish with subsurface scattering.',
		tags: ['animal', 'pbr', 'cc0'],
		url: KHRONOS('BarramundiFish', 'BarramundiFish.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Corset', slug: 'corset',
		description: 'Ornate Victorian corset — detailed fabric and lace textures.',
		tags: ['prop', 'fashion', 'pbr'],
		url: KHRONOS('Corset', 'Corset.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Iridescent Dish', slug: 'iridescent-dish',
		description: 'Dish of olives with iridescent glaze showcasing material extensions.',
		tags: ['prop', 'food', 'pbr'],
		url: KHRONOS('IridescentDishWithOlives', 'IridescentDishWithOlives.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Materials Variants Shoe', slug: 'variants-shoe',
		description: 'Sneaker demonstrating KHR_materials_variants for colour switching.',
		tags: ['prop', 'fashion', 'pbr'],
		url: KHRONOS('MaterialsVariantsShoe', 'MaterialsVariantsShoe.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Glam Velvet Sofa', slug: 'glam-velvet-sofa',
		description: 'Tufted velvet sofa showcasing sheen and specular materials.',
		tags: ['prop', 'furniture', 'pbr'],
		url: KHRONOS('GlamVelvetSofa', 'GlamVelvetSofa.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Metal Rough Spheres', slug: 'metal-rough-spheres',
		description: 'PBR reference grid of metallic/roughness sphere samples.',
		tags: ['reference', 'pbr'],
		url: KHRONOS('MetalRoughSpheres', 'MetalRoughSpheres.glb'), license: 'CC0',
	},
	{
		source: 'khronos', name: 'Rigged Figure', slug: 'rigged-figure',
		description: 'Animated humanoid reference rig. CC0.',
		tags: ['humanoid', 'rigged', 'reference', 'cc0'],
		url: KHRONOS('RiggedFigure', 'RiggedFigure.glb'), license: 'CC0',
	},
{
		source: 'khronos', name: 'Cesium Milk Truck', slug: 'cesium-milk-truck',
		description: 'Animated milk delivery truck. CC-BY 4.0.',
		tags: ['vehicle', 'rigged', 'prop'],
		url: KHRONOS('CesiumMilkTruck', 'CesiumMilkTruck.glb'), license: 'CC-BY 4.0',
	},
{
		source: 'khronos', name: 'Animated Morph Cube', slug: 'animated-morph-cube',
		description: 'Cube with morph target animations. Reference asset.',
		tags: ['reference', 'animated'],
		url: KHRONOS('AnimatedMorphCube', 'AnimatedMorphCube.glb'), license: 'CC0',
	},

	// ── three.js example models ─────────────────────────────────────────────
	{
		source: 'threejs', name: 'Michelle', slug: 'michelle',
		description: 'Mixamo-rigged dancer (three.js example).',
		tags: ['humanoid', 'rigged', 'mixamo'],
		url: THREE_GLTF('Michelle.glb'), license: 'CC-BY (Mixamo)',
	},
	{
		source: 'threejs', name: 'Xbot', slug: 'xbot',
		description: 'Generic humanoid X-Bot rig (three.js example).',
		tags: ['humanoid', 'rigged'],
		url: THREE_GLTF('Xbot.glb'), license: 'MIT',
	},
	{
		source: 'threejs', name: 'Flamingo', slug: 'flamingo',
		description: 'Animated flamingo with looping wing flap.',
		tags: ['animal', 'rigged'],
		url: THREE_GLTF('Flamingo.glb'), license: 'MIT',
	},
	{
		source: 'threejs', name: 'Horse', slug: 'horse',
		description: 'Animated low-poly horse with morph-based gallop.',
		tags: ['animal', 'rigged'],
		url: THREE_GLTF('Horse.glb'), license: 'MIT',
	},
	{
		source: 'threejs', name: 'Parrot', slug: 'parrot',
		description: 'Animated low-poly parrot.',
		tags: ['animal', 'rigged'],
		url: THREE_GLTF('Parrot.glb'), license: 'MIT',
	},
	{
		source: 'threejs', name: 'Stork', slug: 'stork',
		description: 'Animated low-poly stork.',
		tags: ['animal', 'rigged'],
		url: THREE_GLTF('Stork.glb'), license: 'MIT',
	},
	{
		source: 'threejs', name: 'Soldier (three.js)', slug: 'soldier-threejs',
		description: 'Three.js example soldier with run/walk/idle.',
		tags: ['humanoid', 'rigged'],
		url: THREE_GLTF('Soldier.glb'), license: 'CC-BY (Mixamo)',
	},
	{
		source: 'threejs', name: 'LittlestTokyo', slug: 'littlest-tokyo',
		description: 'Iconic animated diorama by Glen Fox.',
		tags: ['scene', 'diorama'],
		url: THREE_GLTF('LittlestTokyo.glb'), license: 'CC-BY 4.0',
	},
	{
		source: 'threejs', name: 'Lee Perry Smith', slug: 'lee-perry-smith',
		description: 'High-resolution photogrammetry scan of a human face.',
		tags: ['humanoid', 'photogrammetry', 'pbr'],
		url: THREE_GLTF('LeePerrySmith/LeePerrySmith.glb'), license: 'CC-BY 3.0',
	},
	{
		source: 'threejs', name: 'Nefertiti', slug: 'nefertiti',
		description: 'Detailed scan of the Nefertiti bust — public domain.',
		tags: ['character', 'scan', 'historical'],
		url: THREE_GLTF('Nefertiti/Nefertiti.glb'), license: 'CC0',
	},
	{
		source: 'threejs', name: 'Primary Ion Drive', slug: 'primary-ion-drive',
		description: 'Animated sci-fi ion thruster engine.',
		tags: ['prop', 'sci-fi', 'animated'],
		url: THREE_GLTF('PrimaryIonDrive.glb'), license: 'CC-BY 4.0',
	},
];

// ── runner ──────────────────────────────────────────────────────────────────
const filtered = CATALOG.filter((e) => SOURCE === 'all' || e.source === SOURCE);

console.log(`\nseed-public-avatars — owner=${OWNER_EMAIL} source=${SOURCE} dry-run=${DRY_RUN}`);
console.log(`${filtered.length} candidates\n`);

const owner = await ensureOwner(OWNER_EMAIL, SEED_DISPLAY_NAME);
console.log(`owner user_id: ${owner.id}\n`);

const results = { created: 0, skipped: 0, failed: 0 };

for (const entry of filtered) {
	try {
		const existing = await sql`
			select id, visibility from avatars
			where owner_id = ${owner.id} and slug = ${entry.slug} and deleted_at is null limit 1
		`;
		if (existing.length) {
			if (existing[0].visibility !== 'public' && !DRY_RUN) {
				await sql`update avatars set visibility = 'public' where id = ${existing[0].id}`;
				console.log(`  ↑  ${entry.slug} (promoted to public)`);
			} else {
				console.log(`  =  ${entry.slug} (already exists)`);
			}
			results.skipped++;
			continue;
		}

		const bytes = await fetchBytes(entry);
		const checksum = createHash('sha256').update(bytes).digest('base64');
		const storageKey = `u/${owner.id}/${entry.slug}/${Date.now().toString(36)}.glb`;

		if (DRY_RUN) {
			console.log(`  +  ${entry.slug} (${formatBytes(bytes.byteLength)}) [dry-run]`);
			results.created++;
			continue;
		}

		await s3.send(new PutObjectCommand({
			Bucket: process.env.S3_BUCKET,
			Key: storageKey,
			Body: bytes,
			ContentType: 'model/gltf-binary',
			ChecksumSHA256: checksum,
		}));

		await sql`
			insert into avatars (
				owner_id, slug, name, description, storage_key, size_bytes, content_type,
				source, source_meta, visibility, tags, checksum_sha256
			) values (
				${owner.id}, ${entry.slug}, ${entry.name}, ${entry.description},
				${storageKey}, ${bytes.byteLength}, 'model/gltf-binary',
				'import', ${JSON.stringify({ seed: entry.source, license: entry.license, origin: entry.url || entry.file })}::jsonb,
				'public', ${entry.tags}, ${checksum}
			)
		`;
		console.log(`  +  ${entry.slug} (${formatBytes(bytes.byteLength)})`);
		results.created++;
	} catch (e) {
		console.error(`  ✗  ${entry.slug}: ${e.message}`);
		results.failed++;
	}
}

console.log(`\ndone — created=${results.created} skipped=${results.skipped} failed=${results.failed}`);

// ── helpers ─────────────────────────────────────────────────────────────────
async function ensureOwner(email, displayName) {
	const existing = await sql`select id from users where email = ${email} limit 1`;
	if (existing.length) return existing[0];
	const [row] = await sql`
		insert into users (email, display_name, email_verified, plan)
		values (${email}, ${displayName}, true, 'pro')
		returning id
	`;
	return row;
}

async function fetchBytes(entry) {
	if (entry.file) {
		const path = resolve(REPO_ROOT, entry.file);
		const s = await stat(path);
		if (!s.isFile()) throw new Error(`not a file: ${path}`);
		return await readFile(path);
	}
	if (entry.url) {
		const r = await fetch(entry.url);
		if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${entry.url}`);
		return Buffer.from(await r.arrayBuffer());
	}
	throw new Error('entry missing both file and url');
}

function formatBytes(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
