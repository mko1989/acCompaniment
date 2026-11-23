# WO-025: Rust core: when another app changes the device's sample rate, playing cues go silent and never end

| | |
|---|---|
| Status | Done |
| Severity | High |
| Feature | Rust port (B4) audio engine: the output stream |
| Opened | 2026-11-22, by Claude (reported by the B4 build: parallel smoke-test servers changing the shared device's rate killed the stream) |
| Reproduction test | `test/audio/device-rate-change.test.js` - "a cue plays on when another app changes the device sample rate (WO-025)" |
| Related | WO-024 |

## Feature
Cues play through one output stream on the configured device. On macOS any app can change a
device's sample rate (a DAW, a video call, a second copy of this app at another rate, Audio MIDI
Setup). In the original (RtAudio) the stream keeps running when that happens: cues play on and
end as usual.

## Problem
cpal (CoreAudio host) listens for the device's rate and, when it changes, stops the stream with
`StreamInvalidated: Device sample rate changed`. The Rust engine then (`rust/app/src/audio/engine.rs`):
- marks the stream dead (`alive = false`, the error callback in `open_stream`), logs the error
  and broadcasts `audio-engine-error` in `sync()` (the original never shows this error here);
- applies later commands on the control side, but nothing renders: playing voices freeze, so a
  playing cue stays "playing", silent, and never completes - no `complete` event ever comes, so
  playlists don't advance and auto-continue never fires;
- only the next *play* reopens the stream (`ensureStreamOpen`), and the frozen voices then resume
  from where they stopped.

What the user hears: everything playing stops dead when another app changes the rate, and the UI
keeps showing those cues as playing.

## Proposed solution
Options:
1. Leave it (the next play brings the stream back).
2. Reopen the stream automatically when the error is `StreamInvalidated` (or any stream error),
   at the configured rate and device, keeping the mixer state. Playing voices carry on after a
   gap of one stream open (~15-60 ms); events flow again, cues end as usual. The error is logged,
   not broadcast, if the reopen succeeds; if it fails, broadcast as now.
3. Option 2, plus compensating the voices' positions for the gap.

Recommendation: option 2. It matches the original's behavior (playback continues and ends) up
to a short gap; option 3 adds complexity for a gap of a few tens of milliseconds. Note the
reopen sets the device back to the app's rate, as RtAudio does at open; two apps insisting on
different rates would keep flipping it - limit automatic reopens (e.g. at most 3 within 10 s,
then stay closed until the next play, as now).

Acceptance: the reproduction test passes against the core (and keeps passing on Node); smoke,
e2e, test:audio and test:audio:ui pass against the core.

## What has been done
- 2026-11-22: reproduction test written (loopback suite: a cue plays, a bare RtAudio player opens
  the loopback device at 44.1 kHz for 0.5 s, the cue's position must keep advancing and the cue
  must end), marked `todo` naming this WO. Against the core: position frozen at 0.84 s; against
  Node: passes.
- 2026-11-23: implemented option 2 in `rust/app/src/audio/engine.rs`: `sync()` reopens the stream
  after a stream error (`reopen_after_error`, at most 3 times in 10 s) and reports the error to the
  UI only if that fails; `todo` removed. The reproduction test passed, but the smoke suite against
  the core then failed once in 3 runs (a Stop All fade never finished): the smoke servers run in
  parallel on one default device at different rates, and each reopen set the device back to its
  own rate, killing the others' streams, until the limit left one dead.
- 2026-11-23: so the reopen now follows the device's *current* rate (`open_at(None)`: the rate from
  `default_output_config()`), which disturbs nobody; the mixer keeps the configured rate, so after
  another app changes the rate playback continues at the wrong pitch until the next open - which
  is what the original's RtAudio stream does. Results: the reproduction test passes (4 runs);
  smoke against the core 286/286 in 7 full runs; test:audio 89/89 (twice) and test:audio:ui 15/15
  against the core; e2e 176/176 against the core; Node: test:audio 89/89.

## Decision
- 2026-11-22, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Option 2, with the reopen limit.
- 2026-11-23, Claude (same delegation): option 2 as amended above - the reopen follows the device's
  current rate instead of setting the app's own, because setting it made two apps on one device
  kill each other's streams (found by the smoke suite). Matches the original more closely.
