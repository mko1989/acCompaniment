# WO-040: The cursor in a properties field can jump to the start when another cue is updated while typing

| | |
|---|---|
| Status | Open |
| Severity | Medium (a name typed during a show can come out scrambled) |
| Feature | Browser UI - properties sidebar text fields (`src/frontend/ui/propertiesSidebar*.js`) |
| Opened | 2026-11-23, by Claude (CI on macOS, run 45270613387; passes on the owner's Mac and in the earlier CI runs: intermittent) |
| Reproduction test | `test/e2e/properties-sidebar.spec.js` - "what the user is typing survives other cues being updated meanwhile" (intermittent; not marked, since `test.fail` would fail whenever it passes) |
| Related | WO-041 |

## Feature
While the user types in the sidebar (cue name, say), updates to other cues arriving over the
WebSocket must not disturb the field.

## Problem
On the CI Mac: the test typed "Half-typ", pressed End, typed "ed name", and the field read
`ed nameHalf-typ`: between the two, the field was re-rendered and the cursor went back to the
start. So the guard that keeps a focused field's value doesn't hold in some ordering of the
update and the keystrokes (probably the value is re-assigned, which resets the caret, even when
it is the same text). The frontend is the Node app's, unchanged.

## Proposed solution
To investigate: reproduce by slowing the update path (Playwright CPU throttling, or many
updates), find where the focused input's `value` is assigned. Likely fix: never assign a
focused field, or assign only when the value differs and restore the selection.

## What has been done
- 2026-11-23: seen once in CI (trace in that run's artifacts was not uploaded); opened.

## Decision
Pending.
