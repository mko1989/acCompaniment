# WO-053: On Windows the tray app opens an empty console window

| | |
|---|---|
| Status | In progress |
| Severity | High (Windows: a stray window; closing it stops the server) |
| Feature | The tray starting the server; the server running ffmpeg (`rust/tray/src/supervisor.rs`, `rust/app/src/audio/decode.rs`) |
| Opened | 2026-11-24, by the owner (installed v2.0.0-beta on the Windows laptop) |
| Reproduction test | - (install the Windows build and start it) |
| Related | - |

## Feature
The tray app runs in the background with a tray icon; the server it supervises has no window.

## Problem
"It starts a cmd window that just stays empty." The server is a console program; started from
the tray, which has no console, Windows gives it a new console window (empty: its output goes
to the tray's pipes). Closing that window ends the server. The same would happen for each
ffmpeg the server runs to decode audio, and for the tray's `taskkill`.

## Proposed solution
Start the server, `taskkill` and ffmpeg with `CREATE_NO_WINDOW` on Windows. Acceptance: on
Windows the installed tray app shows no console window, also while cues decode and on quit.

## What has been done
- 2026-11-24: the fix above; builds and lints on macOS (the Windows-only lines are checked by
  Windows CI). Needs a new Windows build to try.

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
