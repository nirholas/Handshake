// The kinematics layer on its own, for callers building something other than a
// score compiler: an interactive posing tool, a constraint solver, a different
// authoring format. Nothing here knows what a Motion Score is.

export * from './math.js';
export * from './skeleton.js';
export * from './pose.js';
export * from './ik.js';
export * from './anchors.js';
