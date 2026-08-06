import { describe, it, expect } from 'vitest';
import { classifyProbe, logErrorMsgFor } from '../api/_lib/x402/pipelines/service-uptime-monitor.js';

// The uptime monitor probes third-party x402 services for free (no X-PAYMENT,
// amount 0). Some of those routes are templated (readx.sh /api/:name/followers)
// or verb-picky (earth.x402.press /earth/ask), so a HEAD probe legitimately
// answers 400 or 405 while the service is UP. Recording that status as the log
// row's error_msg made the monitor the single largest source of http_400 and
// http_405 in x402_autonomous_log, which reads as "the loop is sending malformed
// paid requests" when no payment was involved at all.
//
// The verdict itself must not change: alive/classification/last_status still
// carry the observation into x402_service_uptime and value_extracted.

describe('service uptime probe verdicts', () => {
	it('still classifies every probe status exactly as before', () => {
		expect(classifyProbe(402, null)).toMatchObject({ alive: true, classification: 'live_paywall' });
		expect(classifyProbe(200, null)).toMatchObject({ alive: true, classification: 'live_free' });
		expect(classifyProbe(301, null)).toMatchObject({ alive: true, classification: 'live_free' });
		expect(classifyProbe(400, null)).toMatchObject({ alive: true, classification: 'reachable_unexpected', error_msg: 'http_400' });
		expect(classifyProbe(405, null)).toMatchObject({ alive: true, classification: 'reachable_unexpected', error_msg: 'http_405' });
		expect(classifyProbe(503, null)).toMatchObject({ alive: false, classification: 'server_error', error_msg: 'http_503' });
		expect(classifyProbe(null, 'timeout')).toMatchObject({ alive: false, classification: 'unreachable', error_msg: 'timeout' });
	});

	it('logs an error only for verdicts that mean the service is down', () => {
		// Up: no payment-shaped error code on a success row.
		expect(logErrorMsgFor(classifyProbe(400, null))).toBeNull();
		expect(logErrorMsgFor(classifyProbe(405, null))).toBeNull();
		expect(logErrorMsgFor(classifyProbe(402, null))).toBeNull();
		expect(logErrorMsgFor(classifyProbe(200, null))).toBeNull();
		// Down: the outage still reaches the loop's failure stats.
		expect(logErrorMsgFor(classifyProbe(503, null))).toBe('http_503');
		expect(logErrorMsgFor(classifyProbe(500, null))).toBe('http_500');
		expect(logErrorMsgFor(classifyProbe(null, 'network_error'))).toBe('network_error');
	});
});
