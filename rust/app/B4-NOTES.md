# B4 notes (audio engine), for a resume

- Deps added to rust/app/Cargo.toml: cpal 0.18, rtrb 0.4, symphonia 0.6 (wav pcm flac vorbis ogg mp3
  aiff adpcm), rubato 5.1 + audioadapter-buffers 5.1, core-foundation 0.10 (macOS).
- Decoder plan (ADR-018): symphonia for WAV/AIFF/FLAC/Ogg Vorbis/MP3; ffmpeg (same command as
  audioDecoder.js) for AAC/M4A (edit-list/priming = ffmpeg's), files with more than 2 channels
  (-ac 2 downmix = ffmpeg's), and anything symphonia fails on. Resample with rubato when the file
  rate differs from the engine rate.
- Devices (macOS): enumerate through CoreAudio like RtAudio's probeDevices (ids 129.. in
  kAudioHardwarePropertyDevices order, every probed device counts; name "Manufacturer: Name";
  outputChannels from stream configuration; rates per RtAudio's SAMPLE_RATES rule), then open the
  cpal device by UID.
- Step 1 done: rust/app/src/audio/decode.rs; proof `node rust/scripts/compare-decode.js` (after
  `cargo build --release` in rust/app) = 50/50. Routing to ffmpeg also for MP3 without
  Xing/Info/VBRI (symphonia cut a VBR file short) and RIFF/FORM with an odd-sized chunk (symphonia
  misread). Resampled output: rubato Fft vs swresample place samples half a source sample apart
  (constant, ~11-21 us); levels identical; frame count = integer ceil(frames*to/from) like swr.
- Step 2 code: src/audio/{devices,engine,pcm_cache}.rs; server uses CpalEngine; route
  output-devices asks the engine; device list identical to RtAudio's on this Mac (list-devices bin).
- macOS floor: cpal 0.18 links AudioHardware{Create,Destroy}ProcessTap/DestroyAggregateDevice
  (14.2+) strongly -> binary wouldn't start < 14.2. build.rs adds -weak_framework CoreAudio; nm -m
  now shows "weak external". Not run on an old macOS (none here).
- Proof 1 (2026-11-22): core replay 167/167, fallback 0%.
- test/helpers/serverCommand.js: the ACCOMPANIMENT_SERVER_BIN/_ENV switch, now shared by
  test/helpers/harness.js, test/e2e/fixtures.js and test/audio-ui/fixtures.js.
- Proof 2 (smoke suite vs core). First run 280/286. Two causes:
  1. Voices lagged commands. The worker sends a status straight after each command, but the
     audio thread here applies commands at its next callback, so a request right after
     play/stop read the old voices (6 tests: retrigger new-instance x3, fade-out x2, crossfade).
     Fix: `posted`/`applied` command counters; `voices()` waits (at most 3 periods + 20 ms,
     capped at 200 ms) until the report covers every posted command.
  2. A stream dying left queued commands unapplied. The first play on a server sometimes showed
     no voices for 5 s (1 test per run, varying). Server logs: cpal
     `StreamInvalidated: Device sample rate changed`, because parallel test servers open the same
     device at other rates. Fix: with no live stream, the control side applies queued commands
     (sync/voices/post), as the worker does with a dead stream. Stream errors are now logged
     like the worker's console.error.
  After the fixes: 286/286 (full runs; one more run's only failure was test 242, caused by my
  stderr-capturing wrapper, and it passes without the wrapper). Gap, not decided: cpal kills
  the stream when another process changes the device rate, while RtAudio keeps playing. The
  next play reopens it (ensure_stream_open).
- cargo is in ~/.cargo/bin and isn't on PATH in a fresh shell. Export it, or builds silently
  don't happen.
- Proof 3 (vs core): Playwright e2e 175/175 (the electron launcher specs start Node's server
  themselves). test:audio 87/88. The failure is retrigger "play_new_instance: a second copy
  layers": positions heard 4,5,15 where 2 were expected. It counts raw slotsAt at again+0.55, so
  when the second copy's half-level onset is at least ~40 ms after the press, its 4->5 boundary
  lands in that window (slot 4 leftover 0.182 vs the 0.175 threshold). Second-press onset, 8 runs
  each: core 33-41 ms, Node 34-42 ms, the same. Core failed 2/8, Node 0/8. Node also sits at
  41.7 ms (3 times), so this is the test's margin; passes on reruns. First-press onset is ~15 ms
  later on the core (40-61 vs 33-44 ms): the first play also opens the cpal stream.
  test:audio:ui 15/15.
- Proof 4 (no switch): front door replay 167/167; diff-data 548/548; cargo fmt --check, clippy
  --all-targets -D warnings (6 lints fixed: as_chunks, float patterns, and the !(fade > 0) NaN
  rule kept via partial_cmp) and cargo test clean.
- server/engine.rs (NoOutputEngine) is no longer used by the server. Kept: it is pub, so no dead
  code warning, and it is a ready no-output fallback. Delete it if not wanted.
