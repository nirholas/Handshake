/**
 * gpu-capacity — unit tests for the two pure decision points.
 *
 * The gcloud calls are integration surface, but the YAML retarget and the
 * recommendation ranking are where a mistake is expensive: a bad retarget
 * either fails the replace or, worse, clones a service on top of its own
 * revision history, and a bad ranking sends an agent to file a quota request
 * when a region already has idle GPUs sitting unused.
 */

import { describe, it, expect } from 'vitest';
import { retargetExport, recommend } from '../scripts/gpu-capacity.mjs';

// A trimmed `gcloud run services describe --format=export` body, same shape as
// the real one for a GPU worker.
const EXPORTED = `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  annotations:
    run.googleapis.com/ingress: all
    run.googleapis.com/urls: '["https://model-triposr-93741856042.us-central1.run.app"]'
  labels:
    cloud.googleapis.com/location: us-central1
  name: model-triposr
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '2'
        run.googleapis.com/accelerator: nvidia-l4
      name: model-triposr-00011-rpl
    spec:
      containers:
      - image: us-central1-docker.pkg.dev/p/model-triposr/server:manual02
        name: server-1
        resources:
          limits:
            nvidia.com/gpu: '1'
`;

describe('retargetExport', () => {
	const out = retargetExport(EXPORTED, 'us-central1', 'us-east4');

	it('moves the location label to the destination region', () => {
		expect(out).toContain('cloud.googleapis.com/location: us-east4');
		expect(out).not.toContain('cloud.googleapis.com/location: us-central1');
	});

	it('drops the read-only per-region URLs annotation', () => {
		expect(out).not.toContain('run.googleapis.com/urls');
	});

	it('drops the pinned revision name so the new region mints its own', () => {
		expect(out).not.toContain('model-triposr-00011-rpl');
	});

	it('keeps the service name, image and GPU request intact', () => {
		expect(out).toContain('name: model-triposr');
		expect(out).toContain('image: us-central1-docker.pkg.dev/p/model-triposr/server:manual02');
		expect(out).toContain("nvidia.com/gpu: '1'");
		expect(out).toContain('run.googleapis.com/accelerator: nvidia-l4');
	});

	it('leaves the source-region image registry alone — images pull cross-region', () => {
		expect(out).toContain('us-central1-docker.pkg.dev');
	});

	it('is a no-op on a body that does not mention the source region', () => {
		const untouched = retargetExport('kind: Service\nspec: {}\n', 'us-central1', 'us-east4');
		expect(untouched).toBe('kind: Service\nspec: {}\n');
	});
});

const region = (over) => ({
	region: 'us-central1',
	quotas: [],
	services: [],
	pinned: 0,
	ceiling: 0,
	granted: null,
	headroom: null,
	starved: [],
	...over,
});

const l4Quota = (over) => ({
	quotaId: 'NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion',
	label: 'L4',
	granted: 3,
	preferred: 3,
	reconciling: false,
	name: 'l4-pref',
	updated: '2026-07-16T00:00:00Z',
	...over,
});

describe('recommend', () => {
	it('ranks using an already-granted idle GPU above asking for more quota', () => {
		const recs = recommend({
			project: 'p',
			regions: [
				region({ region: 'us-central1', quotas: [l4Quota()], granted: 3, pinned: 3, headroom: 0, ceiling: 8, services: [{ name: 'model-triposr', min: 0 }], starved: [{ name: 'model-triposr', min: 0 }] }),
				region({ region: 'us-east4', quotas: [l4Quota()], granted: 3, pinned: 0, headroom: 3, ceiling: 2, services: [{ name: 'model-text2motion', min: 0 }] }),
			],
		});
		expect(recs[0].kind).toBe('use-existing-grant');
		expect(recs[0].region).toBe('us-east4');
		// The starved service is told to move to the region with headroom, not to
		// wait behind a quota request.
		const starved = recs.find((r) => r.kind === 'starved-service');
		expect(starved.service).toBe('model-triposr');
		expect(starved.command).toContain('--to us-east4');
	});

	it('falls back to a quota request when no region has headroom', () => {
		const recs = recommend({
			project: 'p',
			regions: [
				region({ granted: 3, pinned: 3, headroom: 0, ceiling: 3, services: [{ name: 'model-triposr', min: 0 }], starved: [{ name: 'model-triposr', min: 0 }], quotas: [l4Quota()] }),
			],
		});
		const starved = recs.find((r) => r.kind === 'starved-service');
		expect(starved.command).toContain('--request');
	});

	it('flags a region with no preference filed as a free thing to try', () => {
		const recs = recommend({ project: 'p', regions: [region({ region: 'us-west1' })] });
		expect(recs.some((r) => r.kind === 'no-preference-filed' && r.region === 'us-west1')).toBe(true);
	});

	it('reports a pending grant with its age instead of treating it as capacity', () => {
		const recs = recommend({
			project: 'p',
			regions: [region({ granted: 3, pinned: 1, headroom: 2, ceiling: 3, quotas: [l4Quota({ preferred: 16, reconciling: true })] })],
		});
		const pending = recs.find((r) => r.kind === 'pending-grant');
		expect(pending.detail).toContain('3 → 16');
		expect(pending.detail).toMatch(/day\(s\)/);
	});

	it('warns when the burst ceiling exceeds the grant', () => {
		const recs = recommend({
			project: 'p',
			regions: [region({ granted: 3, pinned: 2, headroom: 1, ceiling: 9, quotas: [l4Quota()] })],
		});
		const burst = recs.find((r) => r.kind === 'burst-exceeds-grant');
		expect(burst.command).toContain('--request 9');
	});

	it('says nothing when a fully-used region has a settled grant and no starved service', () => {
		const recs = recommend({
			project: 'p',
			regions: [region({ granted: 3, pinned: 3, headroom: 0, ceiling: 3, quotas: [l4Quota()], services: [{ name: 'model-trellis', min: 3 }] })],
		});
		expect(recs).toEqual([]);
	});
});
