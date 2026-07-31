/**
 * Snapshot store.
 *
 * The current snapshot lives in memory and is mirrored to disk so a restart
 * comes back with data instead of an empty dashboard. A compact history of
 * previous scans is kept alongside it, because a score is far more useful as a
 * trend than as a number.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const SNAPSHOT = 'snapshot.json';
const HISTORY = 'history.json';

let current = null;
let history = [];

const path = (name) => join(config.dataDir, name);

const writeAtomic = async (name, value) => {
	await mkdir(config.dataDir, { recursive: true });
	const target = path(name);
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(value), 'utf8');
	await rename(temp, target);
};

const readJson = async (name) => {
	try {
		return JSON.parse(await readFile(path(name), 'utf8'));
	} catch {
		return null;
	}
};

/** Load whatever the previous process left behind. Safe to call once at boot. */
export async function load() {
	current = await readJson(SNAPSHOT);
	const stored = await readJson(HISTORY);
	history = Array.isArray(stored) ? stored : [];
	return current;
}

export const getSnapshot = () => current;
export const getHistory = () => history;

/** History reduced to one repository, oldest first. */
export const historyFor = (name) =>
	history
		.map((entry) => ({ at: entry.at, score: entry.scores?.[name] }))
		.filter((entry) => typeof entry.score === 'number');

/** Persist a completed scan and append its compact form to the history. */
export async function save(snapshot) {
	current = snapshot;

	const scores = {};
	for (const repo of snapshot.repos) {
		if (typeof repo.score === 'number') scores[repo.name] = repo.score;
	}
	history.push({
		at: snapshot.generatedAt,
		medianScore: snapshot.summary.medianScore,
		averageScore: snapshot.summary.averageScore,
		healthyDeployments: snapshot.summary.deployments.healthy,
		totalDeployments: snapshot.summary.deployments.total,
		deadLinks: snapshot.summary.links.dead,
		missingPackages: snapshot.summary.missingPackages.length,
		scores
	});
	if (history.length > config.historyLimit) history = history.slice(-config.historyLimit);

	await writeAtomic(SNAPSHOT, snapshot);
	await writeAtomic(HISTORY, history);
	return snapshot;
}

export const findRepo = (name) => current?.repos?.find((repo) => repo.name.toLowerCase() === String(name || '').toLowerCase()) || null;
