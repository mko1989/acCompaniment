# WO-004: Mono files play 3 dB quieter than the file

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Audio decoding - mono files |
| Opened | 2026-10-24, by Claude (loopback suite calibration) |
| Reproduction test | `test/audio/formats.test.js` - "a mono file plays on both outputs at the file's level (WO-004)", "a mono MP3 plays on both outputs at the file's level (WO-004)"; `test/unit/audio-decoder.test.js` |
| Related | WO-005 |

## Feature
Every file is decoded to stereo float PCM at the engine's sample rate by
ffmpeg (`src/backend/audioDecoder.js`), then mixed. A cue at volume 1
should play at the file's own level.

## Problem
Mono files come out at 0.707 of their level on each output (-3 dB): a
0.5-peak mono tone measures 0.354 per side; the same tone as a stereo file
measures 0.5. The decoder asks ffmpeg for two channels with `-ac 2`
(`src/backend/audioDecoder.js:58`), and ffmpeg's default mono-to-stereo
matrix puts the centre channel into each side at -3 dB (its constant-power
pan law).

Effect: mono sound effects and voice-overs are noticeably quieter than
stereo music at the same cue volume, so operators compensate per cue - and
a mono and a stereo version of the same file don't match.

## Proposed solution
For mono sources, duplicate the channel at full level instead of the -3 dB
matrix:
- Probe the input's channel count (ffmpeg already reports it; or decode
  with the source's own channel count) and, for mono, decode with
  `-af pan=stereo|c0=c0|c1=c0` instead of `-ac 2`.
- **Invalidate the PCM cache:** cache keys
  (`src/backend/pcmCache.js:11`) hash path + mtime + size only, so existing
  cached decodes of mono files would keep the old level. Add a decoder
  version to the key.

Options for the owner (this is a level change existing shows will hear):
- A. 0 dB duplicate (recommended): file level on both sides, matches what
  most playback software does with mono files on a stereo output.
- B. Keep -3 dB: document it as the pan law and change the test to assert
  it.

## What has been done
- 2026-10-24: Found by the first loopback calibration test (unity gain
  failed for a mono file; the loopback device itself measured unity).
  Confirmed the decoder, not the mixer or device, causes it. The suite
  generates stereo files by default so other level tests aren't affected.
  Reproduction test added (`todo`). No product code changed.
- 2026-10-24: Implemented option A.
  - `src/backend/audioDecoder.js`: reads the source's channel count with
    music-metadata (already a dependency; no extra process); a mono source
    is decoded with `-af pan=stereo|c0=c0|c1=c0` (both sides at full
    level), everything else with `-ac 2` as before (a file whose tags don't
    give a channel count also takes `-ac 2`). New `DECODER_VERSION` (2).
  - `src/backend/pcmCache.js`: the decoder version is part of the cache key,
    so mono files cached at -3 dB are decoded again rather than reused.
  - Tests: the loopback mono WAV test is no longer `todo` and passes; new
    mono MP3 loopback test; the decoder unit test asserted the -3 dB level
    and now asserts full level; new unit test that the cache key carries the
    decoder version.
  - Measured after the fix (decoded, no app): mono WAV 0.500 per side
    (was 0.354), mono MP3 0.485 (LAME's own loss), stereo WAV unchanged.
  - Results: decoder unit tests 6/6; format loopback tests 6/6.
  - Existing shows: mono cues get 3 dB louder. Operators who had turned
    mono cues up to compensate will want to turn them back down.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  recommended option, A (0 dB).
