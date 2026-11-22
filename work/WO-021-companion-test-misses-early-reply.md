# WO-021: The Companion "play_cue" test can miss its reply (intermittent failure)

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Smoke test suite: Companion WebSocket protocol (`test/companion-protocol.test.js`) |
| Opened | 2026-11-21, by Claude (one failure in a full smoke run through the Rust port's front door; first filed under WO-014 by mistake) |
| Reproduction test | None deterministic: `test/companion-protocol.test.js` - "play_cue starts a cue" fails when the `cue_played` reply arrives before the `playing` status |
| Related | WO-014 |

## Feature
The Companion protocol test sends `play_cue` over the WebSocket and checks both the cue status
broadcast and the `cue_played` reply.

## Problem
The test waited for the `playing` status first and only then started listening for `cue_played`
(`reply()` registers a listener at call time, `test/helpers/harness.js:252`). The server may send
the reply before the status broadcast; the test then waits for a second `cue_played` that never
comes and times out. The app is right either way (the order of the two messages is not part of the
protocol); the test is wrong. Seen once in a full smoke run through the Rust front door, where
timing differs slightly; it can happen on plain Node too.

## Proposed solution
Start listening for the reply before sending (as the other tests in the file already do, by
calling `reply()` synchronously right after `wsSend`). No choice to make.

Acceptance: the test passes repeatedly on Node and through the front door; no other test in the
file waits between sending and listening (checked: only this one did).

## What has been done
- 2026-11-21: traced; the test now registers both waits before sending.
- 2026-11-22: fixed. `test/companion-protocol.test.js`: the play_cue test listens for its reply before sending.
  Verified: npm test: unit 139/139, smoke 285/285 (no todo left), e2e 175/175; test:audio 88/88 on an idle machine (a first run with Rust builds running beside it had 6 dropout failures, as CLAUDE.md warns); test:audio:ui 12 passed, 3 flaky (passed on retry).

## Decision
- 2026-11-21, decided by Claude on the owner's delegation. Owner, 2026-11-21: "do the best you can
  with those dillemas" - the open decisions were delegated to Claude. Fix the test as proposed.
