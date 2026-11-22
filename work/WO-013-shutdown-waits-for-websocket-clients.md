# WO-013: Shutdown stalls and ends in SIGKILL while a WebSocket client is connected

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Server shutdown (quit from the tray, SIGTERM/SIGINT) |
| Opened | 2026-11-21, by Claude (found by the HTTP/WebSocket research for the Rust port, `rust/research/http-websocket.md`) |
| Reproduction test | `test/shutdown.test.js` - "SIGTERM with a WebSocket client connected exits promptly with code 0" |
| Related | - |

## Feature
On SIGTERM or SIGINT the server cleans up (saves state, stops playback, releases the audio
device), closes the HTTP server and exits with code 0. The Electron launcher sends SIGTERM when
the app quits and waits up to 5 s before force-killing the server.

## Problem
With any WebSocket client connected (the browser UI, the remote page, Companion), the server
never finishes closing. `stop()` calls `this.server.close(...)` (`server.js:250`ff), which waits
for every open connection to end, and nothing closes the WebSocket connections: the `ws` server
is never closed and its clients are never terminated. The exit only comes from a force-kill:

- run on its own: the 10 s timer in `stop()` fires and the server SIGKILLs itself
  (`forceExit()`, `server.js:293`); the reproduction test sees `{ code: null, signal: 'SIGKILL' }`
  after about 11 s;
- under the launcher: quitting the app stalls for 5 s, then the launcher SIGKILLs the server
  (`electron-launcher/main.js:590`).

State is not lost: `cueManager.cleanup()` runs before `server.close()`. What the user sees is a
5 s stall on quit whenever the UI is open, which is nearly always.

## Proposed solution
In `stop()`, after `cueManager.cleanup()`, close the WebSocket side before `server.close()`:
terminate every client in `this.wss.clients` (or close them with code 1001 "going away" and
terminate after a short grace period), call `this.wss.close()`, and call
`this.server.closeAllConnections()` for idle keep-alive HTTP connections.

Options:
1. **Terminate clients immediately** (recommended): simplest; the UI already reconnects on its
   own when the server comes back.
2. Send close 1001 and wait up to ~500 ms for clients to close, then terminate: friendlier to
   clients, slightly slower quit.

Acceptance: the reproduction test passes (exit code 0 within 5 s with a client connected); the
existing shutdown tests still pass.

The Rust port must do the same on shutdown (axum's graceful shutdown does not track upgraded
WebSocket connections; see `rust/research/http-websocket.md`).

## What has been done
- 2026-11-21: reproduced with the test above (marked `todo`): SIGKILL after ~11 s instead of exit
  code 0. Checked the launcher's side (5 s, then SIGKILL).
- 2026-11-22: fixed. `server.js` `stop()`: terminates every WebSocket client, closes the WebSocket server and idle keep-alive connections before `server.close()`. Reproduction test un-todo'd; it passes (exit code 0, promptly).
  Verified: npm test: unit 139/139, smoke 285/285 (no todo left), e2e 175/175; test:audio 88/88 on an idle machine (a first run with Rust builds running beside it had 6 dropout failures, as CLAUDE.md warns); test:audio:ui 12 passed, 3 flaky (passed on retry).

## Decision
- 2026-11-21, decided by Claude on the owner's delegation. Owner, 2026-11-21: "do the best you can with those dillemas" - the open decisions were delegated to Claude.
  Option 1: terminate every WebSocket client and close the WebSocket server in `stop()` before `server.close()`, and close idle keep-alive HTTP connections. The UI reconnects on its own.
