// JSON-RPC dispatch for the 3D Studio MCP server — thin binding of the shared
// payment-free dispatcher (api/_lib/mcp-dispatch.js) to this server's catalog.
import { makeDispatcher, PROTOCOL_VERSION } from '../_lib/mcp-dispatch.js';
import { TOOL_CATALOG, TOOLS } from './catalog.js';

export { PROTOCOL_VERSION };

const INSTRUCTIONS = [
	'three.ws 3D Studio turns text or images into interactive 3D models.',
	'text_to_3d(prompt) and image_to_3d(image_url) start a generation job and return a job_id;',
	'poll generation_status(job_id) until it returns a GLB and an inline <model-viewer> artifact.',
	'preview_3d(glb_url) renders any GLB as an artifact; inspect_model / optimize_model analyze one.',
	'Always display returned text/html resources as inline 3D artifacts.',
].join(' ');

export const dispatch = makeDispatcher({
	serverInfo: { name: 'three-ws-3d-studio', version: '1.0.0' },
	instructions: INSTRUCTIONS,
	catalog: TOOL_CATALOG,
	tools: TOOLS,
	logName: 'mcp3d',
});
