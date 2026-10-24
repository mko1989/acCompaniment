# WO-008: Companion's "Play Cue" can pause, stop or restart a playing cue

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Companion module actions - Play Cue (`play_cue`) |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction test | `test/audio/control-surfaces.test.js` - "Companion: Play Cue starts a cue, keeps a playing one playing, and resumes a paused one (WO-008)" |
| Related | - |

## Feature
The Companion module offers two cue actions
(`companion-module-highpass-accompaniment/actions.js:52-54`):
- **Trigger Cue** (`toggle_cue`) - a press, following the cue's retrigger
  behavior (restart, pause/resume, stop, ...);
- **Play Cue** (`play_cue`) - by its name, "make this cue play".

## Problem
The server handles both the same way: `handlePlayCue`
(`src/backend/websocketManager.js:506`) calls `cueManager.triggerCue`, which
applies the retrigger behavior. So "Play Cue" on a playing cue set to
toggle pause/play **pauses** it, set to stop **stops** it, set to restart
restarts it from the top. An operator with a "Play" button on a Stream Deck
(e.g. "make sure the walk-in music is playing") can kill it by pressing
Play. Reproduced: second Play on a playing `toggle_pause_play` cue → silence.

## Proposed solution
Give `play_cue` its own meaning, independent of retrigger behavior:
- stopped / completed / cued → start it (as today);
- paused → resume it;
- playing → do nothing.

Implement as a `cueManager.playCue(cueId)` used by `handlePlayCue`; keep
`toggle_cue` (Trigger Cue) unchanged. Update the Companion action's
description to say so.

Options for the owner:
- A. As above (recommended): Play is idempotent; Trigger remains the
  behavior-following press.
- B. Play on a playing cue restarts it ("play from the top").
- C. Keep today's behavior; rename the action so it isn't called "Play".

## What has been done
- 2026-10-24: Found by the loopback control-surface tests. Root cause traced.
  Reproduction test added (`todo`, written for option A). No product code
  changed.
- 2026-10-24: Implemented option A.
  - `src/backend/cueManager.js`: new `playCue(cueId, options)`, serialized
    with the cue's other operations: playing -> nothing; paused -> resume;
    otherwise -> start (the normal trigger path, so a cued playlist item and
    crossfade mode work as for any start).
  - `src/backend/websocketManager.js`: `play_cue` calls `playCue`
    (`toggle_cue` / Trigger Cue is unchanged).
  - `companion-module-highpass-accompaniment/actions.js`: Trigger Cue and
    Play Cue have descriptions saying how they differ.
  - Tests: the reproduction test now covers all three cases by ear (Play on
    a stopped cue starts it; a second Play changes nothing - no gap, position
    keeps climbing; Play on a paused cue resumes it where it paused), on a
    toggle_pause_play cue, and is no longer `todo`.
  - Results: control-surface loopback tests 8/8; `companion-protocol` and
    `websocket-protocol` server tests 33/33; Companion module tests 75/75.
  - The Companion module's version isn't bumped here; do that with its next
    release.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  recommended option, A.
