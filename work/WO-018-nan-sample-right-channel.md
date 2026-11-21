# WO-018: A NaN sample on a file's right channel reaches the output and spoils other cues

| | |
|---|---|
| Status | Awaiting decision |
| Severity | Low |
| Feature | Audio engine: mixer (`src/backend/soundboardMixer.js`) |
| Opened | 2026-11-21, by Claude (found by the Rust port's recording of the mixer, `rust/soundboard-mixer`) |
| Reproduction test | `test/unit/soundboard-mixer.test.js` - "a NaN sample in a file is silenced on both sides and does not spoil other cues" |
| Related | - |

## Feature
The mixer adds every playing cue's samples into the output buffer, frame by frame. Bad samples
in a file (NaN) are meant to be silenced so they can't reach the audio device.

## Problem
The left sample is read as `buf[idx] || 0` (NaN becomes 0), but the right one as
`buf[idx + 1] ?? left` (`src/backend/soundboardMixer.js:391-392`): `??` only replaces `null`
and `undefined`, so a NaN right sample passes through. It is added into the output buffer, where
`x + NaN` is NaN, so every other cue playing on that output channel is lost for that sample too,
and the right peak meter reads NaN. The device then gets NaN, which (depending on the driver)
plays as silence, a click or a burst of noise.

Files reach the mixer as 32-bit floats straight from ffmpeg (`-f f32le`,
`src/backend/audioDecoder.js:79`), which passes NaN in a float file through unchanged. So a
damaged or unusual 32-bit float WAV/AIFF can trigger it. Reproduced by the test above: output
sample 7 (frame 3, right) is NaN.

## Proposed solution
Read the right sample the way the left one is read, keeping the mono fallback:
`const r = buf[idx + 1]; const right = r === undefined ? left : (r || 0);`
(or `Number.isFinite` checks on both, which also silences infinities - a small behavior change).

Options:
1. **Silence NaN on the right like on the left** (recommended): minimal, matches the intent.
2. Also silence ±Infinity on both sides: safer for the device, changes behavior for infinities.

Acceptance: the reproduction test passes; `npm run test:unit` passes; the Rust mixer
(`rust/soundboard-mixer`, which reproduces the bug today because it was recorded) is changed
the same way, with a `known-diffs.jsonl` entry for the recorded NaN case until it is re-recorded.

## What has been done
- 2026-11-21: found by the mixer port; reproduced with the test above (marked `todo`); traced.

## Decision
Pending. The owner said on 2026-11-21 that open decisions are taken later.
