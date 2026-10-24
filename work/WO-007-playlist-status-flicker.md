# WO-007: A playing playlist briefly reads as "stopped" between items

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Playlist cues - playback status over REST |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction test | `test/audio/playlists.test.js` - "a playlist reads as playing throughout the hand-over from one item to the next (WO-007)" |
| Related | WO-006 |

## Feature
`GET /api/cues/:id` (and `/api/cues`, `/api/remote/cues`) report each cue's
live status - used by the remote page, integrations and the tests.

## Problem
While a playlist hands over from one item to the next, its status reads
`stopped` for a moment, though the audio carries straight on. In
`_handlePlaylistItemEnd` (`src/backend/cueManager.js:1187`) the cue's live
state is deleted (`:1223`) and only re-created once `_startCue` for the next
item resolves (`:1224`); in between, `_mergeLiveState` finds no live state
and falls back to the stored record's `stopped`.

Anything polling REST can see a playing playlist flash to stopped - the
loopback suite's "wait until the cue is idle" did exactly that and cut a
recording short. During the same window the playlist doesn't count as a
playing ducking trigger, though nothing re-evaluates ducking in it today.

## Proposed solution
Don't delete the state before starting the next item: leave it `playing`
(it is) and let `_startCue` overwrite it; only delete it if starting the
next item fails (that branch already broadcasts `stopped`). Small,
contained change.

Acceptance: the reproduction test passes; existing playlist, shuffle and
ducking tests pass.

## What has been done
- 2026-10-24: Found when the loopback suite's idle wait returned mid-
  playlist. Root cause traced. Reproduction test added (`todo`); the suite's
  `waitForIdle` now requires idle to hold for 250 ms. No product code
  changed.
- 2026-10-24: Implemented as proposed.
  - `src/backend/cueManager.js` (`_handlePlaylistItemEnd`): the cue state is
    no longer deleted before `_startCue`; it stays `playing` until
    `_startCue` replaces it, and is deleted only if the next item fails to
    start (that branch already broadcasts `stopped`).
  - Checked the start path for readers of the state: shuffle's
    `_preparePlaylistForStart` only distinguishes `cued_next` (same result
    for "playing" and "no state"); ducking now correctly counts a playlist
    trigger as playing through the hand-over; hand-overs are serialized with
    the cue's other operations, so a press can't see the in-between state.
  - Tests: reproduction test no longer `todo`, passes (REST polled as fast
    as possible across the hand-over never reads anything but `playing`).
  - Results: loopback playlist tests 7/7 (the hand-over related ones);
    `playlist`, `shuffle`, `ducking` server tests 43/43.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  proposed fix.
