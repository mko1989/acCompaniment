# WO-022: A playlist whose current item was removed can't be triggered

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Playlist cues: current item (`currentPlaylistIndex`) |
| Opened | 2026-11-21, by Claude (from a behavior the Rust port of `playlistLogic.js` flagged, `rust/playlist-logic`) |
| Reproduction test | `test/shuffle.test.js` - "a playlist whose current item was removed still plays and steps from a sensible place" |
| Related | - |

## Feature
A playlist cue remembers which item plays next (`currentPlaylistIndex`). Items can be added,
removed and reordered in the properties sidebar at any time.

## Problem
Removing items past the current one leaves the index pointing at an item that no longer exists:
nothing keeps it in range when `playlistItems` changes (`cueDataManager.updateCue`,
`src/backend/cueDataManager.js:162-178`, merges without checking; `validateCue` only checks the
type). Then:

- triggering the cue fails with `Audio file not found` - `startCuePlayback` looks up
  `playlistItems[currentPlaylistIndex]` (`src/backend/cueManager.js:995`) and finds nothing. The
  operator presses the button and nothing plays;
- next/previous and item-end treat the index as position 0 of the play order
  (`src/backend/playlistLogic.js:70`, `:96`) and go to the second item, skipping the first.

Reproduced: a 4-item playlist jumped to item 4, trimmed to 2 items, triggered: `success: false,
"Audio file not found"`.

## Proposed solution
Keep the index in range wherever cue data is stored: when it falls outside the items (or is
negative), reset it to 0, the start of the playlist. Applied in `updateCue` and on load
(`validateCue`), so projects saved with an out-of-range index are repaired too. With the index
always in range, `playlistLogic`'s position-0 fallback is never reached and needs no change.

Options considered: reset to 0 (chosen: editing a playlist and pressing play starts it from the
top), or clamp to the last item (keeps "near where it was", but then the next press plays the
last item and ends).

Acceptance: the reproduction test passes; `npm test` passes; the Rust port does the same.

## What has been done
- 2026-11-21: reproduced (test above, `todo`); fixed with `keepPlaylistIndexInRange` in
  `src/backend/cueDataManager.js`, used by `updateCue` and `validateCue`; the test passes.
- 2026-11-22: fixed. Fixed as described above; the test passes.
  Verified: npm test: unit 139/139, smoke 285/285 (no todo left), e2e 175/175; test:audio 88/88 on an idle machine (a first run with Rust builds running beside it had 6 dropout failures, as CLAUDE.md warns); test:audio:ui 12 passed, 3 flaky (passed on retry).

## Decision
- 2026-11-21, decided by Claude on the owner's delegation. Owner, 2026-11-21: "do the best you can
  with those dillemas" - the open decisions were delegated to Claude. Reset to 0, as proposed.
