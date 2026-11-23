# WO-036: The smoke test "the created cue was persisted to disk" can read a save's temp file after it is renamed

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Smoke suite - workspace saving (`test/smoke.test.js`) |
| Opened | 2026-11-23, by Claude (CI on Linux, https://github.com/mko1989/acCompaniment/actions/runs/45265130852: `ENOENT ... cues/workspaces/<id>.json.tmp.18441....`) |
| Reproduction test | `test/smoke.test.js` - "the created cue was persisted to disk" (intermittent: needs a save to land between the test's `readdir` and `readFile`) |
| Related | - |

## Feature
The server saves a workspace (debounced, 300 ms) by writing `<id>.json.tmp.<pid>.<time>.<n>`
and renaming it to `<id>.json`, so a crash never leaves a half-written file. The test polls the
folder until the created cue shows up in a saved file.

## Problem
The test read every file `readdir` listed (`test/smoke.test.js:134-136`), temp files included.
When a save happened between the two calls, the temp file was already renamed and `readFile`
threw ENOENT, which failed the test instead of polling again. The app behaved correctly - the
temp-then-rename is the point.

## Proposed solution
Read only `*.json`, and treat a file that vanishes as not-yet-saved (poll again).
Acceptance: the test can't fail on a save's temp file.

## What has been done
- 2026-11-23: fixed as proposed; `node --test test/smoke.test.js` passes locally.

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016): fix the test as proposed (tests only).
