# WO-006: Up to 10.7 ms of silence between playlist items

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Playlist cues - continue mode (item to item) |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction test | `test/audio/playlists.test.js` - "items hand over gaplessly: no silence at any join, positions continuous (WO-006)", "gapless joins also when looping round, and each item's own trim is kept"; `test/unit/soundboard-mixer.test.js` - "a queued next buffer follows on in the same render, with no gap (WO-006)", "without a queued next, or after a stop, the voice ends as before" |
| Related | WO-007 |

## Feature
A playlist in `continue` mode plays its items back to back.

## Problem
Each hand-over leaves a short stretch of digital silence - an audible tick
on continuous material (a live album, a DJ mix split into tracks, a looped
bed split in parts).

When an item reaches its end mid-buffer, the mixer removes the voice and
leaves the rest of that output buffer silent
(`src/backend/soundboardMixer.js:322`, then `break`). The completion goes to
the main thread, which decides the next item and posts a new `play` - which
starts on the *next* buffer at the earliest. The gap is whatever was left
of the buffer: anything from 0 to one buffer (512 frames = 10.7 ms at
48 kHz), depending on the item's length. Measured: 1 s items at 48 kHz
leave 48000 mod 512 = 128 frames, plus a buffer or more if the main thread
is slow to respond.

## Proposed solution
Make the hand-over sample-accurate inside the mixer:
- When a playlist item starts, also send the worker the next item's buffer
  (already decoded / in the PCM cache) as the voice's `next`.
- When the voice reaches its end and has a `next`, the mixer continues
  rendering from the start of `next` in the same buffer, then reports
  "item advanced" (not "completed") so the main thread updates the playlist
  index, status and UI and queues the following item.
- Only in `continue` mode without repeat-one; `stop_and_cue_next`,
  repeat-one and the last item (without loop) keep today's behavior. Shuffle
  works the same since the next index is decided when the item starts.
- Navigation (next/prev/jump) or a playlist edit while an item plays
  replaces the queued `next`.

Options for the owner:
- A. Gapless as above (recommended if playlists are used for continuous
  material). Medium effort; touches mixer, worker protocol and cueManager.
- B. Accept the gap: change the test to assert it stays under one buffer.

## What has been done
- 2026-10-24: Found by the loopback playlist tests (sample-level dropout
  detection at the join). Ruled out the test files and the decoder: a
  decoded test file has exactly one zero sample at each end. Cause traced
  to the mixer as above. Reproduction test added (`todo`). No product code
  changed.
- 2026-10-24: Implemented option A.
  - `src/backend/soundboardMixer.js`: a voice can hold a queued `next`
    buffer (`queueNext` / `clearNext`); reaching its trim end it switches to
    it within the same render - from the next item's own trim start - and
    `onCueAdvance(cueId, token)` fires instead of `onCueComplete`. Looping
    takes precedence; a stopped (or fading-out) voice drops its `next`.
  - `src/backend/audioEngineWorker.js` / `workerMixer.js`: `queueNext` and
    `clearNext` commands, and an `advanced` message carrying the play's
    sequence number - ignored, like completions, if it's about an older play.
  - `src/backend/audioPlaybackManager.js`: `queueNext(cueId, filePath,
    {trim, token}, stillWanted)` loads the file and queues it unless the cue
    moved on while it loaded; `handlePlaybackAdvance` updates what it
    records as playing; queued items are dropped on stop, end, replace and
    new instance.
  - `src/backend/cueManager.js`: `_queueNextItem` decides the next item when
    one starts, by the same rule as at its end (`_itemEndDecision`, shared
    with `_handlePlaylistItemEnd`), and queues it only when that rule says
    "play" - continue mode, not repeat-one, not past the end without loop.
    `_handlePlaylistAdvance` applies the decision (index, shuffle order),
    updates state and broadcasts `playing` with the new position, then
    queues the following item. Editing a playing playlist's items, shuffle,
    loop, mode or repeat-one re-queues. If the next item isn't loaded in
    time, the item's end is handled exactly as before.
  - Behavior change: items reached by a gapless hand-over no longer each
    fade in with the playlist's fade-in time (a fade at every join would
    defeat the point); the fade-in still applies when the playlist starts,
    and to items started any other way (navigation, a press).
  - Tests: the reproduction test is strict now - no more silence at any
    join than the test tones' own two zero samples (was 130 samples), each
    item played to its last segment and the next from its first - and is no
    longer `todo`; new loopback test for the loop wrap and an item's own
    trim; two new mixer unit tests (sample-exact switch, and no switch after
    clearNext or a stop).
  - Results: playlist loopback tests 16/16; mixer unit tests 27/27;
    worker-mixer unit tests 10/10; `playlist`, `shuffle`, `ducking`,
    `retrigger`, `cue-type-change` server tests 75/75.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  recommended option, A (gapless).
