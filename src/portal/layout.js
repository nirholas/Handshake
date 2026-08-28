// The world layout lives in the published package, not here.
//
// `@three-ws/portal` is the canonical home of the outline-to-world function, so
// the page you are looking at, the GLB exporter, the MCP tool and anyone who
// installs the package all run the SAME code. A copy in src/ would be a second
// implementation waiting to drift, and the drift would be invisible: both would
// still build a world, just not the same one, and a shared link would open a
// different city than the one its author walked.
export * from '../../packages/portal/src/layout.js';
