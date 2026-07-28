// Classification contract for the production triage monitor. Every signature
// added to KNOWN_SIGNATURES should get a case here: the monitor learning a
// benign pattern must never silently swallow a genuine fault that shares text.
import { describe, expect, it } from 'vitest';
import { classify } from '../scripts/gcp-triage.mjs';

describe('gcp-triage classify', () => {
	it('classifies the Colyseus stale-seat refusal as self-healing', () => {
		const sig = classify(
			'Error: seat reservation expired.\n    at WebSocketServer.onConnection (file:///app/node_modules/@colyseus/ws-transport/build/WebSocketTransport.mjs:79:15)',
			['three-ws-multiplayer'],
		);
		expect(sig?.id).toBe('colyseus-seat-expired');
		expect(sig?.class).toBe('self-healing');
	});

	it('classifies the SRH abort only on three-ws-redis-proxy', () => {
		const line = 'Uncaught signal: 10, pid=54, tid=54, fault_addr=0.';
		const onProxy = classify(line, ['three-ws-redis-proxy']);
		expect(onProxy?.id).toBe('redis-proxy-srh-crash');
		expect(onProxy?.class).toBe('self-healing');
	});

	it('leaves the same signal line from any other service unclassified', () => {
		const line = 'Uncaught signal: 10, pid=54, tid=54, fault_addr=0.';
		expect(classify(line, ['three-ws-api'])).toBeNull();
		expect(classify(line, [])).toBeNull();
		expect(classify(line)).toBeNull();
	});

	it('still matches service-unscoped signatures without a services argument', () => {
		const sig = classify('db at storage cap (3072MB >= 3072MB)');
		expect(sig?.id).toBe('db-storage-cap');
	});

	it('returns null for an unknown message', () => {
		expect(classify('some brand new failure nobody has seen', ['three-ws-api'])).toBeNull();
	});
});
