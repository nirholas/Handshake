import { describe, it, expect } from 'vitest';
import '../docs/assets/status-core.js';

const { IncidentMachine, THRESHOLDS } = globalThis.StatusCore;

const t = 1_784_000_000_000;

describe('IncidentMachine', () => {
  it('stays operational on healthy input', () => {
    const m = new IncidentMachine();
    for (let i = 0; i < 10; i++) {
      const r = m.step('operational', null, t + i);
      expect(r.published).toBe('operational');
      expect(r.event).toBeNull();
    }
  });

  it('suppresses flaps shorter than openAfter', () => {
    const m = new IncidentMachine();
    // two bad cycles, then recovery: no incident
    expect(m.step('down', 'x', t).event).toBeNull();
    expect(m.step('down', 'x', t + 1).event).toBeNull();
    expect(m.step('operational', null, t + 2).event).toBeNull();
    expect(m.step('operational', null, t + 3).published).toBe('operational');
  });

  it('opens an incident after openAfter consecutive bad evaluations', () => {
    const m = new IncidentMachine();
    const n = THRESHOLDS.incident.openAfter;
    let r;
    for (let i = 0; i < n; i++) r = m.step('down', 'rpc dead', t + i);
    expect(r.published).toBe('down');
    expect(r.event).toEqual({ type: 'open', severity: 'down', reason: 'rpc dead', t: t + n - 1 });
  });

  it('requires closeAfter consecutive good evaluations to close', () => {
    const m = new IncidentMachine();
    for (let i = 0; i < 3; i++) m.step('degraded', 'slow', t + i);
    expect(m.published).toBe('degraded');
    // three good cycles: still open (closeAfter = 4)
    for (let i = 0; i < 3; i++) {
      const r = m.step('operational', null, t + 10 + i);
      expect(r.published).toBe('degraded');
      expect(r.event).toBeNull();
    }
    const r = m.step('operational', null, t + 13);
    expect(r.published).toBe('operational');
    expect(r.event).toEqual({ type: 'close', t: t + 13 });
  });

  it('a bad blip during recovery resets the close counter', () => {
    const m = new IncidentMachine();
    for (let i = 0; i < 3; i++) m.step('down', 'x', t + i);
    m.step('operational', null, t + 10);
    m.step('operational', null, t + 11);
    m.step('down', 'x again', t + 12); // resets recovery
    m.step('operational', null, t + 13);
    m.step('operational', null, t + 14);
    const r = m.step('operational', null, t + 15);
    expect(r.published).toBe('down'); // only 3 consecutive good
    const r2 = m.step('operational', null, t + 16);
    expect(r2.published).toBe('operational');
    expect(r2.event.type).toBe('close');
  });

  it('escalates severity inside an open incident', () => {
    const m = new IncidentMachine();
    for (let i = 0; i < 3; i++) m.step('degraded', 'slow', t + i);
    let r;
    for (let i = 0; i < 3; i++) r = m.step('down', 'dead', t + 10 + i);
    expect(r.published).toBe('down');
    expect(r.event).toEqual({ type: 'severity', severity: 'down', reason: 'dead', t: t + 12 });
  });

  it('de-escalates down to degraded without closing', () => {
    const m = new IncidentMachine();
    for (let i = 0; i < 3; i++) m.step('down', 'dead', t + i);
    let r;
    for (let i = 0; i < 3; i++) r = m.step('degraded', 'recovering', t + 10 + i);
    expect(r.published).toBe('degraded');
    expect(r.event.type).toBe('severity');
    expect(r.event.severity).toBe('degraded');
  });

  it('unknown publishes after unknownAfter but never opens incidents', () => {
    const m = new IncidentMachine();
    m.step('operational', null, t);
    const r1 = m.step('unknown', 'no data', t + 1);
    expect(r1.published).toBe('operational');
    const r2 = m.step('unknown', 'no data', t + 2);
    expect(r2.published).toBe('unknown');
    expect(r2.event).toBeNull();
  });

  it('keeps an incident open through an unknown gap', () => {
    const m = new IncidentMachine();
    for (let i = 0; i < 3; i++) m.step('down', 'dead', t + i);
    m.step('unknown', 'probe broken', t + 10);
    const r = m.step('unknown', 'probe broken', t + 11);
    expect(r.published).toBe('unknown');
    expect(r.event).toBeNull(); // no close event: incident row stays open
    // recovery from unknown back to operational closes nothing (close only
    // fires from an incident state) but a fresh bad run reopens cleanly
    const r2 = m.step('operational', null, t + 20);
    expect(r2.published).toBe('operational');
    expect(r2.event).toBeNull();
  });

  it('resumes from a persisted published state', () => {
    const m = new IncidentMachine({ published: 'down' });
    expect(m.step('down', 'still dead', t).published).toBe('down');
    expect(m.step('down', 'still dead', t).event).toBeNull();
  });
});
