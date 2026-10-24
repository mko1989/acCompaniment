# WO-005: Patching both sides of a cue to one output drops the file's right channel

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Cue output routing (`outputPatch`) |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction tests | `test/audio/cue-options.test.js` - "output patch [0,0]: ...", "output patch [1,1]: ...", "a file with the same content in both channels keeps its level when routed to one output"; `test/unit/soundboard-mixer.test.js` - "both sides patched to one output fold down: L and R mixed at half each (WO-005)" |
| Related | WO-004 |

## Feature
`outputPatch: [L, R]` routes a cue's left and right channels to output
channels (properties sidebar `#propOutputPatchLeft` / `#propOutputPatchRight`,
shown on devices with more than 2 outputs). `[0, 0]` sends the whole cue to
output 1 - e.g. a mono feed to one speaker or a separate monitor send.

## Problem
When both sides go to the same output, only the file's **left** channel
reaches it; the right channel is discarded. `SoundboardMixer.render()`
writes the left sample to `patchL` and skips the right one entirely when
`patchR === patchL` (`src/backend/soundboardMixer.js:336`).

So a stereo file routed to one output loses everything that's only (or
mostly) in its right channel - hard-panned instruments, one side of a
stereo SFX, a right-channel-only click track. Reproduced with a file whose
left and right channels carry different tones: `[0, 0]` puts only the left
tone on output 1.

## Proposed solution
When `patchL === patchR`, fold down: write `(left + right) * g` to the one
output. The choice is `g`:
- A. `g = 0.5` (recommended): a mono file (left = right) keeps exactly its
  level, so routing to one output doesn't change loudness; uncorrelated
  stereo content drops ~3 dB.
- B. `g = 0.707`: constant power for uncorrelated content, but mono files
  get +3 dB louder when folded.
- C. `g = 1`: up to +6 dB, risk of clipping - not recommended.

Keep it in the hot loop without allocation (one extra add and multiply).
Peak metering should use the folded sample.

Acceptance: the two reproduction tests pass (both tones present on the one
output, the other output silent); a mono file routed `[0, 0]` measures the
same level as routed `[0, 1]`; `test/unit/soundboard-mixer.test.js` gets a
fold-down case.

## What has been done
- 2026-10-24: Found by the loopback output-routing tests. Root cause traced.
  Reproduction tests added (`todo`). No product code changed.
- 2026-10-24: Implemented option A (g = 0.5).
  - `src/backend/soundboardMixer.js` (`render`): when `patchL === patchR`
    the output gets `(L + R) * 0.5`; peak metering uses the folded sample.
    This also covers a 1-channel output device, whose patch is always
    clamped to `[0, 0]` - stereo files on a mono output no longer lose their
    right channel either. No allocation added to the render loop.
  - Tests: the two routing tests assert both channels reach the one output
    at half level each, and are no longer `todo`; new loopback test: a file
    with the same content in both channels keeps its level routed `[0, 0]`;
    new mixer unit test with exact sample values and the peak meter.
  - Results: routing loopback tests 5/5; channel count 1 loopback test
    passes; mixer unit tests 25/25 and `scripts/test-soundboard-mixer.js`
    PASS; `cue-properties` server tests 15/15.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  recommended option, A (fold-down gain 0.5).
