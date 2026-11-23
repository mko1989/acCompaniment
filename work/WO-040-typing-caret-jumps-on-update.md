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
`ed nameHalf-typ`: the caret was at the start when typing resumed. The first guess - the field
re-rendered by the update - is ruled out by the trace (below). The frontend is the Node app's,
unchanged. Whether a user can hit this is not known yet.

## Proposed solution
To investigate: reproduce by slowing the update path (Playwright CPU throttling, or many
updates), find where the focused input's `value` is assigned. Likely fix: never assign a
focused field, or assign only when the value differs and restore the selection.

## What has been done
- 2026-11-23: seen once in CI (trace in that run's artifacts was not uploaded); opened.
- 2026-11-23: failed again in CI run 45276394832 (macOS; 2 of the last 3 macOS runs). Its
  Playwright trace (artifact `playwright-traces-macos-latest`) shows: `fill("Half-typ")` (one
  input event), the three PUTs to the other cue, `press("End")`, then the typed keys landing
  at position 0 (`eHalf-typ`, `edHalf-typ`, ...). No sidebar refresh was logged
  (`shouldRefreshPropertiesFor` kept it from re-populating: no "re-opening" line), no value
  was assigned, no other input event. So the caret was at 0 when typing began, without the
  app's sidebar code running. Not settled: whether the app moves the caret some other way
  (focus leaving and returning), or the test's keys behave differently on the CI Mac's
  Chromium (on macOS, End is "scroll to end of document", not "caret to end of line"; then
  the caret position comes from `fill`). Next: reproduce with the CI Chromium version locally;
  log focus/blur and `selectionStart` on #propCueName in the test.

## Decision
Pending.
