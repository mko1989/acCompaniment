# WO-035: The tray's supervisor tests look for the server without `.exe` on Windows

| | |
|---|---|
| Status | In progress |
| Severity | Low |
| Feature | Tray app tests (`rust/tray/src/supervisor.rs`, the tests against the real server) |
| Opened | 2026-11-23, by Claude (CI on Windows: https://github.com/mko1989/acCompaniment/actions/runs/45265130852) |
| Reproduction test | `rust/tray/src/supervisor.rs` - "starts_its_server_on_the_configured_port_from_the_data_dir_and_stops_it_on_quit", "restarts_a_crashed_server", "adopts_a_server_already_running_on_its_port_and_leaves_it_running" (fail on Windows) |
| Related | WO-033 |

## Feature
The tray's supervisor tests start the real server binary through the supervisor.

## Problem
The tests' `server_bin()` built the path `rust/app/target/release/accompaniment` with no
suffix; on Windows the binary is `accompaniment.exe`, so the three tests failed their "is the
server built?" check before testing anything. The tray app itself was not affected: its
`server_binary()` (`rust/tray/src/main.rs`) adds `.exe`.

## Proposed solution
Add `std::env::consts::EXE_SUFFIX` in the tests' `server_bin()`. Acceptance: the tests run on
the Windows CI runner.

## What has been done
- 2026-11-23: fixed as proposed. Not built locally (not enough disk on this Mac for the tray's
  build); CI to confirm.
- 2026-11-23: CI run 45274205089: 6 of 7 pass on Windows. The seventh,
  "restarts_a_crashed_server", restarted the server correctly but expected the Unix log line
  "exited (code null)"; a server killed by `taskkill /F` exits with code 1 (as under Node).
  The test now expects the platform's line. CI to confirm.

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016): fix as proposed (tests only).
