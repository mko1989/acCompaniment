# WO-050: On Windows CI the smoke suite hangs after the project-restart tests

| | |
|---|---|
| Status | Open |
| Severity | Medium (CI: the Windows job runs into its 45-minute limit) |
| Feature | The smoke suite on Windows |
| Opened | 2026-11-24, by Claude (CI runs 45371346663, 45373290845) |
| Reproduction test | - (`npm run test:smoke` on Windows CI) |
| Related | WO-049 |

## Problem
The last result printed is `projects-restart.test.js`'s; `node --test` reports files in order,
so the next file (`test/projects.test.js`) probably never finishes. No test timeout was set, so
the job just ran until it was cancelled.

## Proposed solution
`test:smoke` now runs with `--test-timeout=180000`, so a hung test fails with its name. Then
find the cause; WO-049 (no graceful stop on Windows) may be it.

## What has been done
- 2026-11-24: opened; test timeout added.

## Decision
Pending.
