# WO-003: Playlist items all play with the cue's trim instead of their own

| | |
|---|---|
| Status | Done |
| Severity | High |
| Feature | Playlist cues - trim |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction test | `test/audio/playlists.test.js` - "a trimmed single cue turned into a playlist: its file keeps its trim, other items play whole (WO-003)"; `test/cue-type-change.test.js` - "the trim moves with the file: onto the item, and back onto the cue (WO-003)" |
| Related | - |

## Feature
A single-file cue can be trimmed (`trimStartTime` / `trimEndTime`, set on the
waveform). Turning it into a playlist makes its file the first item - which
keeps that trim (`src/backend/cueDataManager.js:36-37` copies it onto the
item) - and other files can be added as items.

## Problem
Playback ignores the items' trim and applies the **cue's** trim to every
item: `startCuePlayback` builds the play options from
`trimStartTime: cue.trimStartTime` / `trimEndTime: cue.trimEndTime`
(`src/backend/cueManager.js:1105-1106`) whatever item is playing.

So after converting a cue trimmed to start at 0.5 s, every other item also
starts 0.5 s in - and a cue-level `trimEndTime` cuts every item off at that
time, or (if it's longer than an item) is clamped to that item's end. The
operator hears the start of every song missing and can't see why: the
playlist UI has no trim controls.

Reproduced: cue trimmed at 0.5 s → playlist of [own file, another file] →
the second file is heard from its 0.5 s point (segment 5), not its start.

## Proposed solution
- In `startCuePlayback`, for a playlist take the trim from the current
  item: `currentItem.trimStartTime || 0`, `currentItem.trimEndTime || null`
  (an item's `0` end means "no trim", as `cueDataManager.js:37` writes it).
- On conversion to a playlist, clear the cue-level `trimStartTime` /
  `trimEndTime` (the trim now lives on item 0), so nothing else reads a
  stale value. Converting back to a single cue restores item 0's trim to the
  cue.
- Check the other readers of cue-level trim for playlists (time display,
  `totalTime`) and make them item-aware.

Acceptance: the reproduction test passes; the first item still plays with
its own (carried-over) trim - add an assertion for that; single-cue trim
tests unchanged.

## What has been done
- 2026-10-24: Found by the loopback playlist tests. Root cause traced.
  Reproduction test added (`todo`). No product code changed.
- 2026-10-24: Implemented as proposed.
  - `src/backend/cueManager.js` (`startCuePlayback`): the trim comes from
    `trimSource` - the current item for a playlist, the cue otherwise.
  - `src/backend/cueDataManager.js`: new `moveTrimOnTypeChange()`, applied
    in `updateCue()`: becoming a playlist clears the cue-level trim (it is
    on item 0 already, copied there by `keepOwnFileWhenBecomingPlaylist` or
    by the sidebar's own staging); becoming a single-file cue takes back the
    trim of the item with its file, unless the update sets a trim itself.
  - The other readers of cue-level trim (frontend static time display,
    waveform) are single-cue views; with the playlist cue's own trim
    cleared they no longer see a stale value. No change needed.
  - Tests: the loopback reproduction test now converts the realistic way
    (`type: 'playlist'`, then adds an item) and asserts both items - the own
    file from its 0.5 s trim for 1.5 s, the other file whole from its start -
    and is no longer `todo`; new server test for the trim moving both ways
    and the playing voice's trim.
  - Results: `test/audio/playlists.test.js` 13 pass + 2 todo (WO-006,
    WO-007); `test/cue-type-change.test.js` 5/5; `playlist`, `shuffle`,
    `cue-properties` server tests 43/43.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  proposed fix.
