# Profiling plan

1. Record a reproducible signposted editing session.
2. Capture Time Profiler and Allocations traces.
3. Compare live-object growth before and after closing the editor.
4. Inspect retain cycles with Memory Graph.
5. Re-run the same scenario after the narrow fix.
