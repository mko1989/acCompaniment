# WO-030: A playlist item can stay highlighted in the properties sidebar after the playlist stops

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Browser UI: properties sidebar, playlist item list (`src/frontend/ui/propertiesSidebarPlaylist.js`) |
| Opened | 2026-11-23, by Claude (one failure of `test/e2e/properties-sidebar.spec.js` - "playlist: the item playing is highlighted in the list, and follows the playlist", in `npm test` on Node) |
| Reproduction test | `test/e2e/properties-sidebar.spec.js` - "playlist: stopping just after the playing item changes leaves nothing highlighted (WO-030)" |
| Related | - |

## Feature
With a playlist cue open in the properties sidebar, the item playing is highlighted in its item
list; the highlight follows the playlist from item to item and goes when it stops.

## Problem
Highlighting is deferred three ways (`src/frontend/ui/propertiesSidebarPlaylist.js`):
`highlightPlayingPlaylistItemInSidebar` debounces calls by 50 ms (line ~367); `_performHighlighting`
removes every highlight at once but adds the new one on the next animation frame, and 50 ms later
adds it again if it's missing (lines ~415-440, a "Mac M1" workaround); and
`renderPlaylistInProperties` restores the previous highlight on an animation frame after a
re-render (lines ~134-145). None of the deferred callbacks checks whether the highlight is still
wanted. When Stop's clear runs between an item's highlight being applied and its 50 ms re-check,
the re-check sees no highlight and puts it back: the item stays highlighted, with the cue showing
Stopped, until the next play. In practice: pressing Stop 50-150 ms after the playlist moved to
another item (by hand or at an item's end).

Not part of the Rust port (the UI stays JS); it happens on Node.

## Proposed solution
Keep the wanted highlight in one module-level value, set by `_performHighlighting` (the item id,
or null to clear); every deferred callback applies a highlight only if it's still the wanted one;
the re-render restores the wanted highlight rather than the one found in the old DOM. No choice
to make.

Acceptance: the reproduction test passes (it sweeps Stop across the window, 30-150 ms after the
item changes, in 5 ms steps; before the fix it caught the bug in 5 of 5 runs); the existing
highlight tests and the e2e suite pass.

## What has been done
- 2026-11-23: traced; reproduction test written (`test.fail` naming this WO), fails 5/5 on Node.
- 2026-11-23: fixed in `src/frontend/ui/propertiesSidebarPlaylist.js`: `wantedHighlightItemId`,
  set by `_performHighlighting`; the late callbacks (animation frame, the 10 ms and 50 ms
  re-checks, the re-render's restore) apply a highlight only while it is still the wanted one.
  `test.fail` removed. `properties-sidebar.spec.js` 26/26 in 3 runs; `npm test` (Node): unit
  139/139, smoke 286/286, e2e 176/176; e2e against the Rust core 176/176.

## Decision
- 2026-11-23, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Fix as proposed.
