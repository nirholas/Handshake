// How bad is this change?
//
// The ladder is defined by what a downstream consumer notices, not by how large
// the byte delta is. A 40 MB texture swap is `minor` because everything still
// loads and plays; deleting one joint is `breaking` because every clip that
// addressed that joint by name silently stops moving, which is the single most
// expensive failure in this pipeline and the reason the tool exists.

export const SEVERITIES = ['none', 'cosmetic', 'minor', 'major', 'breaking'];

const RANK = new Map(SEVERITIES.map((s, i) => [s, i]));

export function severityRank(severity) {
	return RANK.get(severity) ?? 0;
}

/** The worst severity in a list. Returns 'none' for an empty list. */
export function maxSeverity(values) {
	let worst = 'none';
	for (const value of values) {
		if (!value) continue;
		if (severityRank(value) > severityRank(worst)) worst = value;
	}
	return worst;
}

/** True when `severity` is at least as bad as `threshold`. Drives the CLI exit code. */
export function atLeast(severity, threshold) {
	return severityRank(severity) >= severityRank(threshold);
}

export const SEVERITY_MEANING = {
	none: 'The two models are structurally identical.',
	cosmetic: 'Only metadata changed. Nothing a renderer or a clip can observe.',
	minor: 'Appearance changed. The model still loads, animates, and keeps its shape.',
	major: 'Geometry or hierarchy changed. Anything positioned against this model should be re-checked.',
	breaking: 'Something a consumer references by name is gone. Clips, attachments, or materials bound to it will fail.',
};
