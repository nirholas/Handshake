# backlog/ progress log

Cross-chat handoff. Append one block per work order attempt: what you measured,
what you changed, what is left, and who owns it. Newest at the bottom.

Format:

```
## <date>: <NN work-order name>
Measured: <the numbers you read, with the command>
Did: <what changed, with commit SHAs or env var names>
Left: <exactly what remains, and who owns it>
```

---

## 2026-08-01: pack created

Measured (see the snapshot table in [00-INDEX.md](00-INDEX.md)): prod at `6cc0370dc`
with no deploy gap, `x402_settle` down at 25.9% with `fee_runway_exhausted` at
85,331 rejects against 562 `broadcast_failed`, RPC lanes at 1/3 paid serving,
forge at 100%, fact-check benchmark unrun, Draco transcode fixed on the running
image, media CORS at the site edge already permissive.

Did: wrote ten work orders covering every open item carried by ISSUES.md and the
retired campaign logs. Dropped the Draco item from ISSUES.md against live
evidence rather than leaving a fixed item on the tracker.

Left: all ten work orders are unstarted.
