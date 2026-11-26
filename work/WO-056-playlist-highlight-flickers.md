# WO-056: The playing playlist item's highlight in the properties sidebar flickers off on every time update

| | |
|---|---|
| Status | Done |
| Severity | Medium (the sidebar can show no item playing; on a slow machine it can stay off) |
| Feature | Properties sidebar: the playlist item playing now is highlighted (`src/frontend/ui/propertiesSidebarPlaylist.js`) |
| Opened | 2026-11-26, by Claude (a new WO-054 test failed on Linux CI) |
| Reproduction test | `test/e2e/properties-sidebar.spec.js` - "playlist: the playing item stays highlighted - no flicker on every time update (WO-056)" |
| Related | WO-030 (highlight after stop), WO-054 (found by its tests) |

## Feature
With a playlist open in the properties sidebar, the item playing now is highlighted, and the
highlight follows the playlist as it moves on.

## Problem
The highlight is re-applied on every playback-time update (~10 times a second). Each time,
`_performHighlighting` (`propertiesSidebarPlaylist.js`, was lines 398-455) first removed the class
from every item, then added it back to the playing one inside a `requestAnimationFrame`. So the
playing item lost its highlight ~10 times a second (measured: 20 times in 2 s), and wherever
animation frames run late or not at all - a loaded machine, a background tab - it could stay off.
On Linux CI (run 45798716771) the new test "the properties sidebar highlight follows the playlist
as it moves on by itself" never saw item 3 highlighted in 4 s, while the console said it was.
`renderPlaylistInProperties` restored the highlight after a re-render on a later frame too.

## Proposed solution
Toggle the class synchronously, and only on the items whose state changes; restore it
synchronously after a re-render, still only if it is wanted (WO-030). Acceptance: the
reproduction test sees no highlight loss over 2 s of playback; the WO-030 tests and the
`playlist-playback.spec.js` tests pass.

## What has been done
2026-11-26 - Reproduced: a MutationObserver on the playing item counted 20 losses in 2 s. Added
the reproduction test (`test.fail`, failed as expected). Rewrote `_performHighlighting` and the
restore in `renderPlaylistInProperties` as proposed (the "Mac M1" reflow/repaint workarounds went
with it: they only existed to fight the remove-then-re-add). Removed the marker:
`properties-sidebar.spec.js` + `playlist-playback.spec.js` 42/42 pass.

## Decision
- 2026-11-26, Claude on the owner's delegation (ADR-016): fix as proposed - no behavior anyone
  relies on changes.
