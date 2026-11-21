# WO-014: Smoke tests read the mixer's voices before the worker has reported them

| | |
|---|---|
| Status | Awaiting decision |
| Severity | Low |
| Feature | Smoke test suite (`test/*.test.js`): checks of what the audio engine plays |
| Opened | 2026-11-21, by Claude (one failure in a full `npm run test:smoke` run during the Spotify removal, ADR-003 in `rust/DECISIONS.md`) |
| Reproduction test | None deterministic yet: `test/cue-properties.test.js` - "a cue plays at its own volume" fails intermittently (`v` is `null`) |
| Related | - |

## Feature
Many smoke tests start a cue, wait until it reads as playing, then read the engine's voices
(`t.voices(cueId)`, from the playback status's `voices`) to check volume, gain, routing and so on.

## Problem
"a cue plays at its own volume" failed once with `TypeError` reading `null.volume`: the playing
cue had no voice yet. It then passed 3 times alone and in two full runs.

Cause: `t.playing()` (`test/helpers/api.js:93`) waits for the cue's status to read `playing`,
which `cueManager` sets as soon as it starts playback. The voices come from
`this.audioPlaybackManager.mixer.getStatus().playing` (`src/backend/cueManager.js:1396`), a
snapshot the audio worker reports every 40 ms. Between the two, the cue is `playing` but has no
voice. 15 reads in `test/cue-properties.test.js` and tests in 9 other files call `t.voices()`;
any of them can hit the gap on a busy machine.

The app behaves as intended (the status and the engine report are separate, and the UI does
not depend on them being simultaneous); the bug is in the tests.

## Proposed solution
Options:
1. **Make the helper wait** (recommended): `t.playing()` also waits until every given cue has a
   voice in the playback status (or a separate `t.sounding()`), so every test that reads voices
   after `playing()` is covered in one place.
2. Make each `voice()` read poll until the voice is present: more call sites to change.

Acceptance: a stress run (the affected files 20 times in a row, and once under CPU load) has no
missing-voice failures; the full smoke suite passes.

## What has been done
- 2026-11-21: traced the cause (above). No code changed.
- 2026-11-21: two full smoke runs (one through the Rust port's front door, one on Node) failed 2
  tests each, all intermittent, three of them this race: "a cue plays at its own volume"
  (`test/cue-properties.test.js`), "play_cue starts a cue" (`test/companion-protocol.test.js`)
  and "a bundle opened on another (empty) installation plays there" (`test/projects.test.js:404`,
  reads `voices` right after the trigger answers `playing`). Rerunning the three files 3 times on
  each server: 5 of 6 runs clean, one bundle-test failure on plain Node. The fourth failure, a
  file-level harness error in the Node run (server not ready?), left no detail and did not recur;
  not attributed to this work order.

## Decision
Pending. The owner said on 2026-11-21 that open decisions are taken later.
