// End-to-end coverage against the real Blender on this machine, driven through
// a real MCP stdio session (client SDK -> spawned server -> Blender).
//
// Nothing here is stubbed: a fixture GLB is produced by Blender itself, then
// inspected, converted, rendered, and edited with a bpy script. The whole file
// skips when no Blender is installed, so it stays green on a machine that only
// runs the offline suite.
//
// Run: node --test packages/blender-mcp/test/blender-session.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { resolveBlender, runJob } from '../src/lib/blender.js';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Resolved at module load, not in before(): node:test reads the `skip` option
// when the test is DEFINED, so a promise or a callback there silently skips.
const SKIP = (await resolveBlender().then(
	() => false,
	() => true,
))
	? 'no Blender executable on this machine'
	: false;

let workdir;
let client;
let fixture;

/** Parse the single text block an MCP tool result carries. */
function payloadOf(result) {
	return JSON.parse(result.content[0].text);
}

async function callTool(name, args) {
	const result = await client.callTool({ name, arguments: args });
	return { isError: result.isError === true, payload: payloadOf(result) };
}

before(async () => {
	if (SKIP) return;

	workdir = await mkdtemp(path.join(os.tmpdir(), 'blender-mcp-test-'));
	fixture = path.join(workdir, 'fixture.glb');

	// Build the fixture with Blender itself: a subdivided monkey with a
	// material, so triangle counts, materials, and modifiers are all non-trivial.
	await runJob({
		op: 'exec',
		code: [
			'import bpy',
			'bpy.ops.mesh.primitive_monkey_add(size=2)',
			"obj = bpy.context.object",
			"obj.name = 'Fixture'",
			"material = bpy.data.materials.new('FixtureSkin')",
			'material.use_nodes = True',
			'obj.data.materials.append(material)',
			"obj.modifiers.new('Subd', 'SUBSURF').levels = 1",
		].join('\n'),
		output: fixture,
	});

	client = new Client({ name: 'blender-mcp-tests', version: '1.0.0' }, { capabilities: {} });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [path.join(PACKAGE_ROOT, 'src', 'index.js')],
			cwd: PACKAGE_ROOT,
			env: { ...process.env, BLENDER_MCP_WORKDIR: workdir },
		}),
	);
});

after(async () => {
	if (client) await client.close();
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

test('the session advertises every tool with a schema', { skip: SKIP }, async () => {
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name).sort();
	assert.deepEqual(names, [
		'blender_convert',
		'blender_forge_import',
		'blender_info',
		'blender_render',
		'blender_run_python',
		'blender_scene_info',
	]);
	for (const tool of tools) {
		assert.equal(tool.inputSchema.type, 'object', `${tool.name} must publish an object schema`);
	}
});

test('blender_info reports the local build', { skip: SKIP }, async () => {
	const { isError, payload } = await callTool('blender_info', {});
	assert.equal(isError, false);
	assert.match(payload.blender.version, /^\d+\.\d+/);
	assert.ok(payload.render_engines.length > 0, 'at least one render engine must be usable');
	assert.ok(payload.import_formats.includes('.glb'), 'glTF import is required by the other tools');
});

test('blender_scene_info reports evaluated geometry, materials and bounds', { skip: SKIP }, async () => {
	const { isError, payload } = await callTool('blender_scene_info', { input: fixture });
	assert.equal(isError, false);
	assert.equal(payload.counts.meshes, 1);
	assert.ok(payload.counts.triangles > 100, 'the subdivided fixture should carry real geometry');
	assert.deepEqual(payload.materials, ['FixtureSkin']);
	assert.equal(payload.objects[0].name, 'Fixture');
	assert.ok(payload.bounds.radius > 0);
});

test('blender_convert round-trips GLB to FBX and back with the geometry intact', { skip: SKIP }, async () => {
	const source = await callTool('blender_scene_info', { input: fixture });
	const fbx = path.join(workdir, 'round-trip.fbx');
	const toFbx = await callTool('blender_convert', { input: fixture, output: fbx });
	assert.equal(toFbx.isError, false);
	assert.equal(toFbx.payload.output, fbx);
	assert.ok((await stat(fbx)).size > 0);

	const back = path.join(workdir, 'round-trip.glb');
	const toGlb = await callTool('blender_convert', { input: fbx, output: back });
	assert.equal(toGlb.isError, false);
	assert.equal(toGlb.payload.counts.triangles, source.payload.counts.triangles);
});

test('blender_convert bakes a uniform scale into the export', { skip: SKIP }, async () => {
	const output = path.join(workdir, 'scaled.glb');
	const { payload } = await callTool('blender_convert', { input: fixture, output, scale: 2 });
	const source = await callTool('blender_scene_info', { input: fixture });
	assert.ok(
		Math.abs(payload.bounds.size[0] - source.payload.bounds.size[0] * 2) < 1e-3,
		'a scale of 2 must double the exported bounds',
	);
});

test('blender_render writes a real PNG, framing and lighting a bare asset', { skip: SKIP }, async () => {
	const output = path.join(workdir, 'preview.png');
	const { isError, payload } = await callTool('blender_render', {
		input: fixture,
		output,
		samples: 4,
		resolution: [160, 160],
	});
	assert.equal(isError, false);
	assert.equal(payload.camera_created, true, 'the fixture has no camera, so one must be added');
	assert.ok(payload.lights_created.includes('sun'), 'the fixture has no light, so one must be added');
	const header = await readFile(output);
	assert.deepEqual([...header.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the output must be a PNG');
	assert.ok(header.length > 1000, 'the PNG must have real image data');
});

test('blender_run_python edits the scene and exports the result', { skip: SKIP }, async () => {
	const output = path.join(workdir, 'decimated.glb');
	const before = await callTool('blender_scene_info', { input: fixture });
	const { isError, payload } = await callTool('blender_run_python', {
		input: fixture,
		output,
		code: [
			'import bpy',
			"obj = bpy.data.objects['Fixture']",
			"modifier = obj.modifiers.new('Decimate', 'DECIMATE')",
			'modifier.ratio = 0.25',
			"print('ratio', modifier.ratio)",
			"result = {'object': obj.name}",
		].join('\n'),
	});
	assert.equal(isError, false);
	assert.match(payload.stdout, /ratio 0\.25/);
	assert.deepEqual(payload.result, { object: 'Fixture' });
	assert.ok(
		payload.counts.triangles < before.payload.counts.triangles / 2,
		'decimating to a quarter must cut the evaluated triangle count',
	);
});

test('a missing input fails as a structured tool error, not a crash', { skip: SKIP }, async () => {
	const { isError, payload } = await callTool('blender_scene_info', { input: path.join(workdir, 'nope.glb') });
	assert.equal(isError, true);
	assert.equal(payload.ok, false);
	assert.equal(payload.error, 'input_not_found');
	assert.match(payload.message, /not found/i);
});

test('an unsupported output format fails with an actionable message', { skip: SKIP }, async () => {
	const { isError, payload } = await callTool('blender_convert', {
		input: fixture,
		output: path.join(workdir, 'nope.3mf'),
	});
	assert.equal(isError, true);
	assert.equal(payload.error, 'format_unsupported');
	assert.match(payload.message, /Supported:/);
});

test('blender_render hands the image back inline so the caller can see it', { skip: SKIP }, async () => {
	const output = path.join(workdir, 'inline.png');
	const result = await client.callTool({
		name: 'blender_render',
		arguments: { input: fixture, output, samples: 4, resolution: [1024, 1024] },
	});
	const image = result.content.find((block) => block.type === 'image');
	assert.ok(image, 'the render must come back as an MCP image block, not just a path');
	assert.equal(image.mimeType, 'image/png');
	assert.ok(image.data.length > 100, 'the image block must carry real base64 data');

	const payload = payloadOf(result);
	// The full-resolution render stays on disk; only a scaled copy is inlined.
	assert.equal(payload.resolution[0], 1024);
	assert.ok(payload.preview_bytes < payload.output_bytes, 'the inlined copy must be smaller than the render');
	await assert.rejects(stat(payload.preview), 'the scaled copy is temporary and must not be left behind');
});

test('inline_image: false suppresses the image block', { skip: SKIP }, async () => {
	const result = await client.callTool({
		name: 'blender_render',
		arguments: { input: fixture, output: path.join(workdir, 'no-inline.png'), samples: 4, resolution: [160, 160], inline_image: false },
	});
	assert.ok(!result.content.some((block) => block.type === 'image'));
	assert.equal(payloadOf(result).ok, true);
});

test('blender_scene_info reports the texture budget, not just an image count', { skip: SKIP }, async () => {
	const textured = path.join(workdir, 'textured.glb');
	await callTool('blender_run_python', {
		output: textured,
		code: [
			'import bpy',
			'bpy.ops.mesh.primitive_cube_add()',
			"image = bpy.data.images.new('Albedo', width=512, height=512)",
			"image.generated_type = 'COLOR_GRID'",
			"material = bpy.data.materials.new('Textured')",
			'material.use_nodes = True',
			"node = material.node_tree.nodes.new('ShaderNodeTexImage')",
			'node.image = image',
			"material.node_tree.links.new(node.outputs['Color'], material.node_tree.nodes['Principled BSDF'].inputs['Base Color'])",
			'bpy.context.object.data.materials.append(material)',
		].join('\n'),
	});

	const { payload } = await callTool('blender_scene_info', { input: textured });
	assert.equal(payload.textures.length, 1);
	assert.deepEqual(payload.textures[0].resolution, [512, 512]);
	assert.ok(payload.textures[0].bytes > 0, 'a packed texture must report its byte size');
	assert.equal(payload.counts.texture_bytes, payload.textures[0].bytes);
});

test('parallel calls queue instead of exhausting the machine', { skip: SKIP }, async () => {
	const results = await Promise.all(
		Array.from({ length: 5 }, () => callTool('blender_scene_info', { input: fixture, include_objects: false })),
	);
	assert.ok(
		results.every((r) => r.isError === false && r.payload.counts.meshes === 1),
		'every queued call must succeed',
	);
});
