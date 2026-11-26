# WO-054: On Windows a playlist set to "Continue to next item" stops after each item

| | |
|---|---|
| Status | Awaiting decision |
| Severity | High (playlists are unusable for background music on Windows) |
| Feature | Playlist auto-advance (`playlistPlayMode: "continue"`): `rust/app/src/core/cue_engine.rs` (`handle_playlist_item_end`, `queue_next_item`), `rust/app/src/core/playlist_logic.rs` (`decide_item_end_with`) |
| Opened | 2026-11-26, by the owner (v2.0.0-beta installer on the Windows laptop) |
| Reproduction test | not reproduced yet; tests that would catch it on Windows CI: `test/e2e/file-handling.spec.js` - "a playlist from several dropped files plays through on its own, in the order dropped (WO-054)", `test/playlist-advance.test.js` - "continue: a playlist of mp3/flac/m4a/ogg items plays every item, then stops (WO-054)", `test/audio-ui/ui-playback.spec.js` - "show mode: a continue playlist clicked once plays every item, back to back (WO-054)" |
| Related | WO-006 (gapless hand-over), WO-007, WO-046 (Windows paths) |

## Feature
A playlist cue plays its items one after another. With "Playlist Advance Behavior" set to
"Continue to next item" it goes on to the next item by itself when one ends (gaplessly, WO-006),
and after the last one it stops (or goes round, with loop on). "Stop after item, cue next" is
the other mode: it stops after each item and waits for the next press.

## Problem
Owner, 2026-11-26: "even when a playlist is set to auto advance it stops after each item."
On the Windows laptop, with the 2.0.0-beta installer; the playlist was made by dropping several
files onto the grid at once. What the button shows when the item ends was not noticed.

Root cause: not found yet.

## Proposed solution
Pending the root cause.

## What has been done
2026-11-26 - Tried to reproduce on the Mac (release build of the current `rust-port`), and it
advances every time ("playing@0 playing@1 playing@2 stopped@0"):
- REST trigger and WebSocket `toggle_cue`; wav, mp3, flac and m4a items; 1 s, 3 s and 20 s items;
- fade in 100 ms / fade out 1000 ms, fade out only, fade in only; the fields the drop handler sends;
- in the browser (Playwright, show mode click): plain, with fades, with the properties sidebar open
  while it plays, after toggling the advance behavior in the sidebar, after converting a single cue
  to a playlist.
The smoke suite's "continue" tests (`test/playlist.test.js`) pass on Windows CI too, so the
engine's logic works there; what is left is specific to the laptop: its output device (WASAPI),
real files decoded through the bundled ffmpeg, or the installed tray app. Asked the owner for the
server log (tray menu -> Show Logs) and the cue (`%USERPROFILE%\.accompaniment`).

2026-11-26 - The owner asked for tests for "all cases like this one". An audit of the suites found
that nothing a playlist does on its own was checked in the browser, and playlist items were only
ever generated WAVs. Added (all pass on the Mac; the smoke and e2e ones also run on Windows CI):
- `test/e2e/playlist-playback.spec.js` (new, 15 tests): continue (button playing throughout,
  Now: follows), end of list, loop, time display per item, stop after item, repeat one, shuffle
  Now/Next, Toggle Pause then advance, Stop All mid-list, sidebar highlight following
  auto-advance, changing the advance behavior while playing, DUCK released when the trigger ends
  by itself, ducking held across a hand-over, a looping single cue, the remote page.
- `test/e2e/file-handling.spec.js`: the owner's path - drop several files, "Add as Single
  Playlist Cue", click in show mode, every item plays in the order dropped.
- `test/playlist-advance.test.js` (new, 28 tests): mp3/flac/m4a/ogg items and mixed formats
  (through the bundled ffmpeg), the cue_status sequence at a hand-over (no stopped/completed
  between items), time updates per item, stop_and_cue_next with and without loop, repeat one with
  every mode, shuffle + loop, a one-item list, pause/resume, starting mid-list, item trim, volume,
  edits while playing (rename, add an item, switch the mode either way), ducking across a
  hand-over (as trigger and as bed), and the restart/stop/fade/do-nothing retriggers on a playlist.
- `test/audio-ui/ui-playback.spec.js`: the same click in show mode, heard - three items back to back.

2026-11-26 - CI run 45798716771 (d900b67): on windows-latest every new test passed (smoke 314/314,
e2e green), including the mp3/flac/m4a/ogg playlists and the dropped-files playlist clicked in
show mode. So neither the server nor the browser UI stops a playlist after each item on Windows as
such; the cause is in what only the owner's laptop has. Still waiting for its server log and
cues.json. (The new tests found two other things on Linux CI: WO-055, WO-056.)

2026-11-26 - The owner tried it on another Windows laptop: "checked now on another windows laptop
the playlist bug and i cant replicate it." So it is not Windows as such: it happened on one
machine (its audio device, its files or its install) and has not been seen anywhere else.

## Decision
Pending: keep it open until it happens again (with that laptop's log), or close it as not
reproducible - the owner's call.
