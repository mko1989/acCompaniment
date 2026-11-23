# WO-026: The "play_new_instance" loopback test counts a segment boundary as a third copy (intermittent failure)

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Loopback suite: retrigger behaviors (`test/audio/retrigger.test.js`) |
| Opened | 2026-11-22, by Claude (failed 2 of 8 runs against the Rust core during B4; Node passes narrowly on the same margin) |
| Reproduction test | None deterministic: `test/audio/retrigger.test.js` - "play_new_instance: a second copy layers over the first, which plays on" fails when the second copy starts >= ~40 ms after the press |
| Related | WO-027 |

## Feature
With `retriggerBehavior: play_new_instance`, pressing a playing cue starts a second copy over the
first. The test plays a tone whose 100 ms segments each have their own frequency ("slots"), presses
again 1 s later and expects to hear exactly two positions, 10 segments apart.

## Problem
The test counts raw slots at `again + 0.55` (`test/audio/retrigger.test.js:123`, `slotsAt`). When
the analysis window straddles a segment change of the second copy, both segments are loud enough
to count (the analyzer's `voicesAt` exists precisely to merge such neighbours,
`test/audio/lib/analyzer.js:226`). The second copy's 4->5 boundary falls inside that window when
it starts about 40 ms or more after the press: heard "4,5,15", expected 2. Press-to-sound on the
second press is 33-41 ms on the Rust core and 34-42 ms on Node (8 runs each), so both sit at the
edge; Node landed at 41.7 ms three times and passed narrowly. The app is right; the test is
fragile.

## Proposed solution
Count positions the way `voicesAt` does (merge neighbouring slots, keep the loudest), then check
there are two and they are ~10 segments apart. No choice to make.

Acceptance: the test passes repeatedly (5 runs) against Node and the Rust core; it still fails if
the second press restarts the cue instead of layering (checked by reasoning: one position only).

## What has been done
- 2026-11-22: traced from the B4 runs (the failing takes' slot readings and onset times are in
  `rust/app/B4-NOTES.md`).
- 2026-11-23: fixed. `test/audio/retrigger.test.js`: the positions heard are merged with their
  neighbours, keeping the loudest, before counting. The retrigger file passed 15/15 in 5 runs
  against the Rust core and 5 against Node; test:audio 89/89 against both.

## Decision
- 2026-11-22, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Fix the test as proposed.
