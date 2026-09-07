// Centralized env for the Blender MCP.
//
// This server drives a LOCAL Blender install in background mode. It holds no
// secret and signs nothing: the only knobs are which Blender to run, how long
// to let a job run, where scratch files go, and which three.ws deployment the
// forge bridge talks to.

import os from 'node:os';
import path from 'node:path';

export function env(key, fallback) {
	const value = process.env[key];
	return value !== undefined && String(value).trim() !== '' ? String(value).trim() : fallback;
}

function positiveNumber(key, fallback) {
	const raw = env(key);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`${key} must be a positive number (got "${raw}")`), { code: 'bad_config' });
	}
	return n;
}

function boolean(key, fallback) {
	const raw = env(key);
	if (raw === undefined) return fallback;
	return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

// Absolute path to the Blender executable. Left unset, the binary is discovered
// on PATH and at the standard install locations for the host platform.
export const BLENDER_PATH = env('BLENDER_PATH');

// Ceiling for one Blender job. Renders and heavy conversions are the slow ones;
// everything else finishes in seconds.
export const JOB_TIMEOUT_MS = positiveNumber('BLENDER_MCP_TIMEOUT_MS', 300000);

// Where generated files land when a tool is called without an explicit output
// path, and where per-job scratch directories are created.
export const WORKDIR = path.resolve(env('BLENDER_MCP_WORKDIR', path.join(os.tmpdir(), 'three-ws-blender-mcp')));

// blender_run_python executes caller-supplied Python inside Blender with full
// filesystem access. It is registered by default because scripted scene edits
// are the point of driving Blender from an agent; set this to 0 in shared or
// unattended deployments and the tool is not advertised at all.
export const ALLOW_PYTHON = boolean('BLENDER_MCP_ALLOW_PYTHON', true);

// three.ws deployment backing blender_forge_import.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// Ceiling for one text-to-3D generation, which runs on a shared GPU lane.
export const FORGE_TIMEOUT_MS = positiveNumber('THREE_WS_FORGE_TIMEOUT_MS', 600000);

// Optional Meshy/Tripo key for the BYOK geometry lane. The default image lane
// (FLUX to TRELLIS) is free and needs no key.
export const FORGE_PROVIDER_KEY = env('THREE_WS_FORGE_PROVIDER_KEY');

export const USER_AGENT = '@three-ws/blender-mcp';
