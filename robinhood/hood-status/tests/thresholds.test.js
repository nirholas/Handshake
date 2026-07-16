import { describe, it, expect } from 'vitest';
import '../docs/assets/status-core.js';

const { evaluators, worstStatus, clampSeverity, isUsMarketOpen } = globalThis.StatusCore;

describe('rpc evaluator', () => {
  it('operational on fast responses', () => {
    const r = evaluators.rpc({ ok: true, latencyMs: 120, recentLatencies: [100, 110, 120] });
    expect(r.status).toBe('operational');
  });
  it('degraded when median latency exceeds threshold', () => {
    const r = evaluators.rpc({ ok: true, latencyMs: 2000, recentLatencies: [1800, 2000, 2400] });
    expect(r.status).toBe('degraded');
    expect(r.reason).toMatch(/median latency 2000ms/);
  });
  it('one slow sample does not degrade a healthy median', () => {
    const r = evaluators.rpc({
      ok: true,
      latencyMs: 4000,
      recentLatencies: [100, 120, 110, 130, 4000],
    });
    expect(r.status).toBe('operational');
  });
  it('down on request failure', () => {
    expect(evaluators.rpc({ ok: false, error: 'timeout after 8000ms' }).status).toBe('down');
  });
  it('unknown without data', () => {
    expect(evaluators.rpc(null).status).toBe('unknown');
  });
});

describe('blocks evaluator', () => {
  it('operational with a fresh head', () => {
    expect(evaluators.blocks({ ok: true, headAgeSec: 1, blocksPerMin: 500 }).status).toBe(
      'operational'
    );
  });
  it('degraded when the head is 2+ minutes old', () => {
    expect(evaluators.blocks({ ok: true, headAgeSec: 150, blocksPerMin: 0 }).status).toBe(
      'degraded'
    );
  });
  it('down when the head is 5+ minutes old', () => {
    expect(evaluators.blocks({ ok: true, headAgeSec: 400, blocksPerMin: 0 }).status).toBe('down');
  });
  it('degraded on near-zero production with a stale-ish head', () => {
    expect(evaluators.blocks({ ok: true, headAgeSec: 90, blocksPerMin: 0.5 }).status).toBe(
      'degraded'
    );
  });
  it('unknown when the head is unobservable', () => {
    expect(evaluators.blocks({ ok: false, headAgeSec: null, blocksPerMin: null }).status).toBe(
      'unknown'
    );
  });
});

describe('feed evaluator', () => {
  it('operational when connected and current', () => {
    expect(
      evaluators.feed({ connected: true, silenceSec: 0.5, lagBlocks: 0, headAdvancing: true })
        .status
    ).toBe('operational');
  });
  it('down when disconnected', () => {
    expect(evaluators.feed({ connected: false, error: 'ECONNREFUSED' }).status).toBe('down');
  });
  it('degraded when silent while the chain advances', () => {
    const r = evaluators.feed({
      connected: true,
      silenceSec: 90,
      lagBlocks: 0,
      headAdvancing: true,
    });
    expect(r.status).toBe('degraded');
  });
  it('NOT degraded when silent because the chain itself is quiet', () => {
    const r = evaluators.feed({
      connected: true,
      silenceSec: 90,
      lagBlocks: 0,
      headAdvancing: false,
    });
    expect(r.status).toBe('operational');
  });
  it('degraded when lagging the RPC head', () => {
    expect(
      evaluators.feed({ connected: true, silenceSec: 1, lagBlocks: 80, headAdvancing: true })
        .status
    ).toBe('degraded');
  });
});

describe('settlement evaluator', () => {
  it('operational at normal lag', () => {
    expect(evaluators.settlement({ ok: true, lagL1Blocks: 2 }).status).toBe('operational');
  });
  it('degraded at 50+ L1 blocks behind', () => {
    expect(evaluators.settlement({ ok: true, lagL1Blocks: 60 }).status).toBe('degraded');
  });
  it('down at 300+ L1 blocks behind', () => {
    expect(evaluators.settlement({ ok: true, lagL1Blocks: 350 }).status).toBe('down');
  });
  it('unknown when the L1 head is unobservable (no fake green)', () => {
    expect(evaluators.settlement({ ok: false, lagL1Blocks: null }).status).toBe('unknown');
  });
});

describe('blockscout evaluator', () => {
  it('never reports down, only degraded', () => {
    const r = evaluators.blockscout({ ok: false, error: 'HTTP 502' });
    expect(r.status).toBe('degraded');
  });
});

describe('chainlink evaluator', () => {
  it('stale outside market hours is operational (expected)', () => {
    expect(
      evaluators.chainlink({ ok: true, maxAgeSec: 90_000, marketOpen: false }).status
    ).toBe('operational');
  });
  it('stale during market hours is degraded', () => {
    const r = evaluators.chainlink({
      ok: true,
      maxAgeSec: 3600,
      marketOpen: true,
      staleFeeds: ['TSLA'],
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toMatch(/TSLA/);
  });
  it('fresh during market hours is operational', () => {
    expect(evaluators.chainlink({ ok: true, maxAgeSec: 60, marketOpen: true }).status).toBe(
      'operational'
    );
  });
  it('failed reads are unknown, not operational', () => {
    expect(evaluators.chainlink({ ok: false, maxAgeSec: null, marketOpen: true }).status).toBe(
      'unknown'
    );
  });
});

describe('worstStatus / clampSeverity', () => {
  it('worst known status wins', () => {
    expect(worstStatus(['operational', 'degraded', 'operational'])).toBe('degraded');
    expect(worstStatus(['operational', 'down'])).toBe('down');
    expect(worstStatus(['operational', 'unknown'])).toBe('operational');
    expect(worstStatus(['unknown', 'unknown'])).toBe('unknown');
    expect(worstStatus([])).toBe('unknown');
  });
  it('clamps down to degraded for capped components', () => {
    expect(clampSeverity('down', 'degraded')).toBe('degraded');
    expect(clampSeverity('degraded', 'degraded')).toBe('degraded');
    expect(clampSeverity('down', null)).toBe('down');
  });
});

describe('isUsMarketOpen', () => {
  it('open on a summer weekday afternoon UTC (EDT session)', () => {
    // Tuesday 2026-07-14 15:00 UTC = 11:00 ET
    expect(isUsMarketOpen(new Date('2026-07-14T15:00:00Z'))).toBe(true);
  });
  it('closed before the bell', () => {
    // Tuesday 2026-07-14 13:00 UTC = 09:00 ET
    expect(isUsMarketOpen(new Date('2026-07-14T13:00:00Z'))).toBe(false);
  });
  it('closed after 16:00 ET', () => {
    // Tuesday 2026-07-14 20:30 UTC = 16:30 EDT
    expect(isUsMarketOpen(new Date('2026-07-14T20:30:00Z'))).toBe(false);
  });
  it('closed on weekends', () => {
    expect(isUsMarketOpen(new Date('2026-07-11T15:00:00Z'))).toBe(false); // Saturday
    expect(isUsMarketOpen(new Date('2026-07-12T15:00:00Z'))).toBe(false); // Sunday
  });
  it('handles winter time (EST): 14:00 UTC is 09:00 ET, closed', () => {
    expect(isUsMarketOpen(new Date('2026-01-13T14:00:00Z'))).toBe(false);
    expect(isUsMarketOpen(new Date('2026-01-13T15:00:00Z'))).toBe(true); // 10:00 EST
  });
  it('boundary: 09:30 ET opens, 16:00 ET closes', () => {
    expect(isUsMarketOpen(new Date('2026-07-14T13:30:00Z'))).toBe(true); // 09:30 EDT
    expect(isUsMarketOpen(new Date('2026-07-14T20:00:00Z'))).toBe(false); // 16:00 EDT
  });
});
