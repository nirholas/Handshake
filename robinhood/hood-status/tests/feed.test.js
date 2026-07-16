import { describe, it, expect } from 'vitest';
import { FeedWatcher } from '../worker/src/feed.js';

class NoopWs {
  constructor() {}
  on() {}
  close() {}
}

const NOW = 1_784_154_000_000;

function watcher() {
  return new FeedWatcher('wss://example.invalid', { WebSocketImpl: NoopWs });
}

describe('FeedWatcher.ingest / snapshot', () => {
  it('tracks sequence numbers from broadcast frames', () => {
    const w = watcher();
    w.connected = true;
    w.ingest(
      JSON.stringify({
        version: 1,
        messages: [{ sequenceNumber: 10745282 }, { sequenceNumber: 10745283 }],
      }),
      NOW
    );
    expect(w.lastSequenceNumber).toBe(10745283);
    const s = w.snapshot(10745284, true, NOW + 500);
    expect(s.lagBlocks).toBe(1);
    expect(s.connected).toBe(true);
    expect(s.silenceSec).toBeCloseTo(0.5);
    expect(s.messagesPerMin).toBe(1);
  });

  it('rolls the per-minute message window', () => {
    const w = watcher();
    for (let i = 0; i < 120; i++) {
      w.ingest('{"version":1,"messages":[]}', NOW - 90_000 + i * 1000);
    }
    const s = w.snapshot(null, true, NOW);
    // only the last 60s of messages counted (ingest prunes on arrival time)
    expect(s.messagesPerMin).toBeLessThanOrEqual(61);
    expect(s.messagesPerMin).toBeGreaterThan(20);
  });

  it('non-JSON frames still count as liveness, never throw', () => {
    const w = watcher();
    w.ingest('ping', NOW);
    expect(w.lastMessageAt).toBe(NOW);
    expect(w.lastSequenceNumber).toBeNull();
  });

  it('lag clamps at zero when the feed is ahead of the RPC read', () => {
    const w = watcher();
    w.ingest(JSON.stringify({ version: 1, messages: [{ sequenceNumber: 200 }] }), NOW);
    expect(w.snapshot(150, true, NOW).lagBlocks).toBe(0);
  });

  it('snapshot with no data yet is honest nulls', () => {
    const s = watcher().snapshot(null, false, NOW);
    expect(s.connected).toBe(false);
    expect(s.silenceSec).toBeNull();
    expect(s.lagBlocks).toBeNull();
  });
});
