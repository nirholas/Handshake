// Spatial MCP — server-side entry point for the open 3D-native tool-result shape.
//
// The implementation moved to public/spatial-mcp/spatial-validator.js so ONE copy
// serves every consumer: this module, the reference renderer page that imports it
// as a sibling, and any third party importing it off the published URL
// (https://three.ws/spatial-mcp/spatial-validator.js). A spec's validator is only
// useful where the mistakes happen, which is a browser, and a second copy of a
// conformance gate is a conformance gate that drifts.
//
// This file stays the server-side import path because every three.ws 3D tool
// already uses it (api/_mcp3d/tools/{spatial,studio,ar}.js, api/_mcp-studio/tools.js).
// Nothing else changes: same named exports, same behavior. Spec: specs/SPATIAL_MCP.md.

export {
	SPATIAL_MCP_VERSION,
	buildSpatialArtifact,
	validateSpatialArtifact,
	isConformantSpatialArtifact,
} from '../../public/spatial-mcp/spatial-validator.js';
