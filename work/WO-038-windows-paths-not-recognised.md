# WO-038: On Windows the server can't start: absolute Windows paths are taken as relative

| | |
|---|---|
| Status | In progress |
| Severity | Critical (Windows: the server does not start) |
| Feature | The data layer's paths (`rust/app/src/core/nodefs.rs`: Node's `path`) on Windows |
| Opened | 2026-11-23, by Claude (CI on Windows, run 45270613387: `Failed to start server: ENAMETOOLONG: name too long, mkdir 'D:\a\acCompaniment\acCompaniment/D:\a\_temp/accompaniment-start/audio'`) |
| Reproduction test | `rust/app/tests/unit_cases.rs` - "path_win32_cases" (2,992 cases recorded from Node's `path.win32`); CI "The server starts and answers" step on Windows; `rust/tray` supervisor tests on Windows |
| Related | WO-035, WO-039; MAP.md "From B1": "core/nodefs.rs ports Node's POSIX path only; Windows path rules are still to do" |

## Feature
The server keeps its data in `ACCOMPANIMENT_DATA_DIR` or `~/.accompaniment` and builds every
file path from it with the port of Node's `path`. On Windows, Node's `path` is `path.win32`:
drive letters, `\` and `/` as separators, UNC shares, per-drive working directories.

## Problem
`nodefs.rs` ported only `path.posix` (a known gap, MAP.md). On Windows `is_absolute("D:\...")`
was false and `resolve` glued the absolute data dir onto the working directory
(`D:\...\acCompaniment/D:\a\_temp/...`), so creating the data folders failed and the server
exited at startup - with any data dir, the default `C:\Users\<name>\.accompaniment` included.
Found on the first Windows CI run; every Windows user would hit it.

## Proposed solution
Port Node's `path.win32` (`core/nodepath_win32.rs`, on UTF-16 units like Node) and use it in
`nodefs.rs` on Windows (`resolve`, `normalize`, `join`, `is_absolute`, `relative`, `dirname`,
`basename`, `extname`); POSIX stays as it is elsewhere. Prove it against Node: record
`path.win32` on a spread of paths (`rust/scripts/record-path-win32.js`), run the cases on every
platform. No real choice to make: the original used `path.win32` on Windows.

Acceptance: the recorded cases match; on the Windows runner the server starts and answers, and
the smoke suite runs.

## What has been done
- 2026-11-23: `core/nodepath_win32.rs` written from Node's lib/path.js; `nodefs.rs` dispatches
  with `cfg!(windows)` (the POSIX functions are `posix_*`, their unit test calls them
  directly). Recorded 2,992 cases from Node 22.18 (`tests/unit-cases/path-win32.jsonl`): all
  match. Node reads a drive's own working directory (`=D:`) only on Windows, so that branch has
  its own unit test (`nodepath_win32.rs`). Windows run in CI pending.
- The test and the fix were written together, not test first: the bug was a missing port, and
  the recorded cases are the reproduction.

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016): port `path.win32` as proposed (the
  original's behavior on Windows; no alternative worth weighing).
