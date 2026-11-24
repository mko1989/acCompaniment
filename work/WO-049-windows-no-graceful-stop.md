# WO-049: On Windows the server can't be stopped gracefully, so its last save is lost

| | |
|---|---|
| Status | Done |
| Severity | High (Windows: edits made just before quitting are lost) |
| Feature | Stopping the server (`rust/app/src/server/mod.rs` `wait_signal`; the tray's `supervisor.rs` `stop`; `test/helpers/harness.js`) |
| Opened | 2026-11-24, by Claude (CI on Windows: 10 harness failures and "cues still play after the data dir has moved") |
| Reproduction test | `test/moved-data-dir.test.js` - "cues still play after the data dir has moved" (Windows); the harness's "Server should exit 0 on graceful SIGTERM shutdown" check |
| Related | WO-050 |

## Feature
On SIGTERM/SIGINT the server stops playback, writes the pending (debounced 300 ms) save and
exits 0. The tray stops it that way on quit; the tests do too.

## Problem
Windows has no SIGTERM: Node's `kill('SIGTERM')` and the tray's `taskkill /F` end the process
at once. The pending save is lost, and the exit code is null/1. In CI, 10 test files failed
their after-hook ("Server should exit 0 on graceful SIGTERM shutdown, got null"), and
"cues still play after the data dir has moved" got "Cue not found": the cue created just before
the stop was never written. A user quitting the tray right after an edit loses it the same way
(the Electron launcher did too).

## Proposed solution
- The server takes its stdin closing as a stop request, like SIGTERM, when started with
  `ACCOMPANIMENT_STOP_ON_STDIN_EOF=1` (once only, so it doesn't count as the second, forcing
  signal; without the variable nothing changes, e.g. under systemd).
- The tray starts the server with that variable and a stdin pipe, and on Windows stops it by
  closing the pipe (still force-killing after 5 s).
- The test harness does the same: on Windows `kill('SIGTERM'|'SIGINT')` closes stdin.

Acceptance: on Windows CI the harness's exit-0 check and the moved-data-dir test pass; macOS and
Linux unchanged.

## What has been done
- 2026-11-24: the fix above. On macOS: the server exits 0 when its stdin closes (checked by
  hand); smoke 286/286; tray tests pass. Windows not yet run.
- 2026-11-24: Windows CI (run 45383129540): the harness's exit-0 checks and the moved-data-dir
  test pass; smoke 285/286 (the other is WO-051), e2e 171 passed. Done.

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
