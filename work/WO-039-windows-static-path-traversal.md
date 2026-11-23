# WO-039: On Windows a request with `..\` could read files outside the browser UI folder

| | |
|---|---|
| Status | In progress |
| Severity | High (security, Windows only) |
| Feature | Static file serving of the browser UI (`rust/app/src/server/http.rs`, `serve_static`) |
| Opened | 2026-11-23, by Claude (found reviewing the code for Windows path assumptions after WO-038; not seen in use) |
| Reproduction test | `rust/app/src/server/http.rs` - "static_paths_cannot_leave_the_root_on_windows" |
| Related | WO-038 |

## Feature
Any GET the API doesn't handle is served from the browser UI folder, as `express.static` did:
`..` segments and dotfiles are refused.

## Problem
`serve_static` split the decoded path only on `/` and refused a `..` segment. On Windows `\` is
a separator too: `GET /..%5c..%5cWindows%5cwin.ini` decodes to `/..\..\Windows\win.ini`, one
segment that is not `..`, and `PathBuf::push` then walks out of the UI folder. A segment like
`C:\Windows\win.ini` would replace the root altogether. Anyone on the network who can reach the
server (it listens on every interface) could read files the server's user can read. `send`
(behind `express.static`) splits on both separators on Windows, so Node was not affected.
macOS and Linux are not affected (`\` is an ordinary file-name character there).

## Proposed solution
On Windows split on `/` and `\`, refuse `..` as before, and refuse any segment containing `:`
(drive letters; also alternate data streams `file:stream`). Refused requests fall through to
the 404, as before. Acceptance: the unit test; the smoke and e2e suites unchanged.

## What has been done
- 2026-11-23: `static_segments()` in `http.rs` with the rule above, tested for both platforms'
  rules on every platform. Test and fix written together. CI on Windows pending.

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016): fix as proposed.
