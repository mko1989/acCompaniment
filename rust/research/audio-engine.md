# Research: audio engine (RtAudio + ffmpeg -> cpal + symphonia)

Scope: ADR-007 (`rust/DECISIONS.md`). What the Node engine does today, what cpal / symphonia /
rubato give us, and where the Rust engine could sound or report differently. Written 2026-11-21.

Sources: Node files are cited `file:line` against the working tree of 2026-11-21 (`cueManager.js`
was mid-way through the Spotify removal, ADR-003, so its numbers will drift). Crate claims cite
the published crate source (`cpal-0.18.2/...`, `symphonia-*-0.6.1/...`, `rubato-5.1.0/...`,
downloaded from crates.io; browse the same files at `https://docs.rs/crate/<name>/<ver>/source/`).
ffmpeg claims cite `https://github.com/FFmpeg/FFmpeg/blob/master/libswresample/...`.
Versions are the latest stable on crates.io that day: cpal 0.18.2, symphonia 0.6.1, rubato 5.1.0,
rtrb 0.4.1.

---

## 1. How the Node engine works today

### 1.1 Layers and threads

| Layer | File | Role |
|---|---|---|
| CueManager | `src/backend/cueManager.js` | cue semantics: retrigger, crossfade, ducking, playlists, broadcasts |
| AudioPlaybackManager | `src/backend/audioPlaybackManager.js` | device resolution, decode/cache, per-cue bookkeeping |
| WorkerMixer | `src/backend/workerMixer.js` | main-thread proxy; posts commands to the worker, answers queries from its own state + worker reports |
| audioEngineWorker | `src/backend/audioEngineWorker.js` | worker thread owning the RtAudio stream and the mixer |
| SoundboardMixer | `src/backend/soundboardMixer.js` | the render loop: voices, gains, patching, peaks |
| audioDecoder / pcmCache | `src/backend/audioDecoder.js`, `src/backend/pcmCache.js` | ffmpeg -> interleaved stereo f32; disk cache |

The worker exists because RtAudio calls the render callback on the JS thread that opened the stream
and the OS audio thread blocks until it returns (`audioEngineWorker.js:1-14`). In Rust the cpal
callback runs on the OS audio thread itself, so this layer becomes "callback + lock-free command
queue"; the *message semantics* below still have to hold.

### 1.2 Device enumeration and selection

- List: `RtAudio.getDevices()` filtered to `outputChannels > 0`, returned as
  `{id, name, outputChannels, isDefaultOutput, preferredSampleRate, sampleRates}`
  (`audioPlaybackManager.js:47-58`), served by `GET /api/audio/output-devices`
  (`src/backend/routes/audio.js:144-154`). The UI uses `name`, `outputChannels`, `isDefaultOutput`
  (`src/frontend/ui/appConfigUI.js:403-410`).
- Config `audioOutputDeviceId` is resolved by `resolveDeviceId` (`audioPlaybackManager.js:24-37`):
  `'default'`/`null`/`''` -> system default; a numeric string -> RtAudio id; otherwise exact
  **name** match; no match -> default device, silently.
- Since WO-001 the UI stores the device **by name** (`appConfigUI.js:403-405`;
  `work/WO-001-config-save-resets-output-device.md`). Old configs may still hold numeric ids.
- RtAudio ids are not device ids: `currentDeviceId_ = 129` and `info.ID = currentDeviceId_++` per
  probe (`node_modules/@hamitzor/rtaudio.js/vendor/rtaudio/RtAudio.cpp:674,1167`). On this Mac:
  129 "NewTek: NDI Audio" ... 130 "Existential Audio Inc.: BlackHole 2ch" (run of
  `test/audio/lib/listDevices.js`, 2026-11-21).
- RtAudio names per platform, as built here (`rtaudio.js/CMakeLists.txt:16-28`; API order
  `RtAudio.cpp:468-497`, first API with devices wins `RtAudio.cpp:616-623`):
  - macOS CoreAudio: `"<kAudioObjectPropertyManufacturer>: <kAudioObjectPropertyName>"`
    (`RtAudio.cpp:1225-1267`), e.g. `"Existential Audio Inc.: BlackHole 2ch"`.
  - Windows: WASAPI (compiled before DS), name = `PKEY_Device_FriendlyName` (`RtAudio.cpp:5149-5155`).
  - Linux: **PulseAudio only** (ALSA off, `CMakeLists.txt:19-23`), name = sink proplist
    `device.description` (`RtAudio.cpp:9214-9220`); sample rates are a fixed list
    (`RtAudio.cpp:9164-9165`).
- Channel count: `min(config.audioOutputChannelCount || 2, device.outputChannels)`, at least 1
  (`audioPlaybackManager.js:39-45`).
- Tests pick the loopback by RtAudio name, in a separate Node process, and put that **name** in
  the server config (`test/audio/lib/capture.js:45-67`, `test/audio/lib/loopback.js:46-52`); the
  device-switch test uses names too (`test/audio/formats.test.js:120-147`). The recorder side stays
  RtAudio/Node even after the port.

### 1.3 Stream parameters

- Defaults: 48000 Hz, buffer 512 frames, 2 channels (`audioPlaybackManager.js:77-79`,
  `cueManager.js:86-95`, `appConfigManager.js:16-17`). Sample rate and buffer size are config/REST
  only, not in the UI.
- Opened as `RTAUDIO_FLOAT32`, interleaved, output only, channels starting at 0
  (`audioEngineWorker.js:135-142`).
- On CoreAudio RtAudio **clamps** the buffer size into the device range and **sets the device's
  nominal sample rate** to the engine rate, waiting up to 2 s (`RtAudio.cpp:1590-1611,1652-1688`).
  So at 44.1 kHz (`test/audio/engine-44k.test.js`) the BlackHole device itself is switched.
- The stream opens **lazily**, on the first play (`audioPlaybackManager.js:106-125,155-172`), and is
  re-checked before every play (`isStreamRunning`), so a stream killed by an error reopens on the
  next play. A config change to any of the four keys (`cueManager.js:14`) stops all cues (UI is told,
  `cueManager.js:193-205`) and reopens immediately (`audioPlaybackManager.js:220-255`).
- Close: callback returns 1 ("drain and stop") instead of calling `stopStream()` (deadlock), 2 s
  timeout (`audioEngineWorker.js:86-112`). Teardown needs forced GC (`audioEngineWorker.js:174-205`).
  None of this is needed with cpal (drop the `Stream`).

### 1.4 Decoding (ffmpeg) and the PCM cache

- Command (`audioDecoder.js:61-83`):
  `ffmpeg -hide_banner -loglevel error -i <file> -vn -f f32le -acodec pcm_f32le <toStereo> -ar <engineRate> pipe:1`
  where `toStereo` is `-af pan=stereo|c0=c0|c1=c0` for a mono source (WO-004) and `-ac 2` otherwise.
  Mono is detected from **tags** via music-metadata; unknown -> `-ac 2` (`audioDecoder.js:15-23,72-74`).
- Output: always interleaved **stereo f32 at the engine rate**; `durationSec = frames / rate`
  (`audioDecoder.js:110-117`). Whole file in memory.
- ffmpeg defaults that therefore shape today's sound:
  - resampler: swr, Kaiser-windowed sinc, `filter_size` 32, `phase_shift` 10, `linear_interp` on,
    `cutoff` 0 -> 0.97, `kaiser_beta` 9 (`libswresample/options.c:84-88,118-123`; `resample.c:188`);
  - `-ac 2` downmix: centre and surround at -3 dB (`clev`/`slev` = `C_30DB`), **LFE dropped**
    (`lfe_mix_level` 0) (`options.c:57-61`);
  - no dither (`dither_method` 0, `options.c:72`), irrelevant for f32 output;
  - honours encoder delay/padding (MP3 LAME tag, MP4 edit lists).
- Binary lookup: `FFMPEG_PATH`, packaged `Resources/ffmpeg`, `vendor/ffmpeg/<plat>`, then PATH
  (`audioDecoder.js:27-46`). Error texts: `ffmpeg decode failed for <name>: ...`,
  `ffmpeg produced no audio data for <name>` (`audioDecoder.js:93-108`) reach REST as `error`.
- Accepted extensions: `.mp3 .wav .m4a .aac .ogg .flac` (`src/backend/audioFileManager.js:19`,
  `routes/audio.js:9`, `mediaLibrary.js:19`, `appConfigManager.js:52`).
- **PCM cache** (`pcmCache.js`): key = sha256(path + `mtimeMs` + size + `decoder-<DECODER_VERSION>`)
  (`pcmCache.js:11-20`; version 2, `audioDecoder.js:13`). Files `<key>.f32` (raw LE interleaved) and
  `<key>.json` `{sourcePath, sampleRate, channels, durationSec, frameCount, cachedAt}`
  (`pcmCache.js:50-68`); ignored if `sampleRate` differs (`pcmCache.js:31-34`). Warmed on import /
  replace (`audioFileManager.js:305,377,387-390`). ADR-006 lets the format change.
- In-memory LRU in front: 50 entries / 512 MiB (`audioPlaybackManager.js:65-68`), keyed by path;
  buffers are SharedArrayBuffers so the worker doesn't copy (`workerMixer.js:31-37`).

### 1.5 The mixer (render loop)

All in `soundboardMixer.js`; JS numbers are **f64**, sample buffers f32.

- Voice = one playing instance; a cue has 1..n voices (`soundboardMixer.js:5-21`).
- Trim: frames = `floor(sec * rate)`; start clamped to `[0, total-1]`, end to `[start+1, total]`
  (`:27-29,118-132`).
- Gain stages per voice: `currentGain` (fade/volume) x `duckGain`, times `masterGain` (0..2)
  (`:394`). Ramps are **linear in amplitude**, per frame: `step = (target-current)/(sec*rate)`
  (`:31-40`), snapping to target when within one step (`:43-49`).
  - fade-in: start at 0, ramp to `volume` over `fadeInTime` (`:162-164`);
  - fade-out stop: ramp `currentGain -> 0` over the fade; voice removed when gain hits 0, reason
    `'stopped'` (`:214-233,429-432`); a stop drops any queued `next` (`:220-223`);
  - live volume: 50 ms ramp default, ignored for a voice already fading out (`:243-255`);
  - duck: separate ramp, target clamped 0..1 (`:258-269`).
- Mono/patch: reads L = `buf[i] || 0` (NaN -> 0), R = `buf[i+1] ?? L` (`:390-392`). Patch
  `[L,R]` clamped to the device channels (`:157-160`); `patchL === patchR` folds down
  `(L+R)*0.5` (WO-005, `:398-408`). A 1-channel device always folds.
- Loop: wrap to trim start (`:369-370`). Queued `next` (WO-006): switch buffer, rate and trim in
  the same frame, emit `advanced(token)` (`:371-383`). Otherwise `'completed'` (`:384-386`).
- Peak meter: max |sample| after gain/patch per voice, drained by the broadcaster (`:410-413,335-343`).
- Pause: voice skipped entirely, position frozen (`:358-360`). Stopping a paused cue is always
  immediate (`audioPlaybackManager.js:428-432`).
- No clipping or limiting anywhere: `masterGain` up to 2 and overlapping voices can exceed 1.0; the
  float goes to the OS as is.
- Status per voice: `positionSec`, `trimStartSec/EndSec`, `isFadingIn/Out`, `fadeRemainingSec`,
  `isDucked`, `duckGain`, `volume`, `currentGain`, `outputPatch` (`:289-326`).

### 1.6 Cue-level behaviour that drives the mixer (cueManager)

- Retrigger table `src/backend/retriggerLogic.js` (pure; port as is); actions applied in
  `cueManager.js:492-...`: restart = immediate stop + start without crossfade; `fade_stop` uses the
  cue's own `fadeOutTime`; `new_instance` layers a voice (`cueManager.js:600-...`); replace without
  `newInstance` removes old voices **silently** (no completion) (`soundboardMixer.js:139-143`).
- Crossfade mode: every other playing cue fades out and the new one fades in, both over
  `crossfadeTime` (default 2000 ms), linear (`cueManager.js:523-545`).
- Stop All with fade uses `defaultStopAllFadeOutTime` (default 1500 ms), not per-cue fades
  (`cueManager.js:674-700`).
- Ducking: multiplier = `1 - strongest_trigger_level/100` over audibly playing triggers, default
  level 80; ramp over `duckingFadeTime` (default 1000 ms, `cueManager.js:10`); a cue starts
  already ducked (`cueManager.js:918-960,1030`).
- Playlists: next item decided when an item starts and queued for a sample-accurate join
  (`cueManager.js:1124-1158`); gapless joins do **not** re-apply fade-in (WO-006); fallbacks on
  item end (`cueManager.js:1193-...`); each item uses its own trim (WO-003).

### 1.7 Messaging and seq numbers (`workerMixer.js`, `audioEngineWorker.js`)

- Commands (fire-and-forget): `play{cueId,seq,buffer,options}`, `stop{cueId,fadeSeconds}`,
  `queueNext`, `clearNext`, `setGain`, `setDuck`, `pause`, `resume`, `setMasterGain`, `setFormat`;
  requests with reply: `open`, `close`, `isOpen`, `dispose` (`audioEngineWorker.js:207-253`).
- Events: `status` every 40 ms while anything plays plus once after idle
  (`audioEngineWorker.js:20-22,63-76`), `complete{cueId,reason,seq}`, `advanced{cueId,token,seq}`,
  `engine-error{type,message}`, `dropouts` every 5 s if any (`:23-26,78-84`).
- Every play gets a seq; completions/advances/reports about an older seq are dropped
  (`workerMixer.js:16-19,121-133,315-332`). Queries (`voiceCount`, `isPaused`, `getStatus`) answer
  from what was *asked*, so a caller sees its own command immediately (`workerMixer.js:9-14`).
  An immediate stop never produces a completion; a fade does (`workerMixer.js:267-274`).
- Worker death -> `engine-error{type:'worker-exit'}` and a `'stopped'` completion for every cue
  (`workerMixer.js:71-87`).

### 1.8 Everything user-visible from the engine

| What | Where | Detail |
|---|---|---|
| `playback-time-update` every 100 ms per cue (newest voice) | `cueManager.js:104-157` | `currentTimeSec = positionSec - trimStartSec`, total = trim span, MM:SS floored, `peakLevel`, `isFadingIn/Out`, `fadeTimeRemainingMs = round(sec*1000)`, `isDucked`, `duckGain`, `voiceCount`, playlist index |
| `cue_status` playing / stopped / completed / paused / cued_next | `websocketManager.js:710-715`, cueManager | `'stopped'` vs `'completed'` comes from the mixer's reason |
| `audio-engine-error` `{type, message}` | `cueManager.js:74-79` | banner in `renderer.js:161-166` and `remote.html:259`; types today: RtAudio error-type number as string, `render-exception`, `worker-exit` |
| `GET /api/audio/output-devices` | `routes/audio.js:144-154` | RtAudio ids and names |
| playback status (`deviceId`, `sampleRate`, `channelCount`, `cachedBuffers`, mixer status) | `audioPlaybackManager.js:558-571` | REST status endpoints |
| REST/WS errors from play | `audioPlaybackManager.js:292-362` | `'Audio engine not initialized'`, ffmpeg messages |
| log lines (dropouts, "stream open ... buffer 512") | `workerMixer.js:137-146`, `audioPlaybackManager.js:214-217` | log only |

---

## 2. cpal 0.18.2

### 2.1 Hosts
- Default hosts: macOS CoreAudio, Windows WASAPI, Linux ALSA; PulseAudio, PipeWire, JACK are opt-in
  features (`cpal-0.18.2/README.md:20-29,61-73`). With `pulseaudio`/`pipewire` enabled,
  `default_host()` on Linux prefers PipeWire, then PulseAudio, then ALSA
  (`cpal-0.18.2/src/platform/mod.rs:833-845`). ALSA dev headers are needed in every case
  (`README.md:31-35`). PulseAudio host needs Rust 1.88 (`README.md:51`).
- README lists **macOS 14.2** as the CoreAudio minimum (`README.md:44`). Not verified whether that
  is a hard floor (link-time) or only for loopback recording. Matters for ADR-009 (Intel Macs).

### 2.2 Device identity and names (0.18 changes)
- Every device has a stable `DeviceId` (`host`, `id` string) and `Host::device_by_id()`
  (`CHANGELOG.md` 0.18.0 "Added"/"Changed"; `src/traits.rs:67`). Names moved to
  `Device::description()` -> `DeviceDescription::name()/manufacturer()/driver()/...`
  (`src/device_description.rs:157-212`).
- CoreAudio: id = `kAudioDevicePropertyDeviceUID` (stable across reboots)
  (`src/host/coreaudio/macos/device.rs:431-467`); name = `kAudioDevicePropertyDeviceNameCFString`
  via coreaudio-rs (`coreaudio-rs-0.14.2/src/audio_unit/macos_helpers.rs:316-318`), **no
  manufacturer prefix**, and description sets no manufacturer (`device.rs:406-428`). So cpal says
  `"BlackHole 2ch"` where RtAudio says `"Existential Audio Inc.: BlackHole 2ch"`.
- WASAPI: id = `IMMDevice::GetId()` endpoint string (`src/host/wasapi/device.rs:500-516`); name =
  `DEVPKEY_Device_FriendlyName`, fallback DeviceDesc (`device.rs:412-460`) - **same key as RtAudio**.
- ALSA: id = PCM id (`hw:0,0`, `default`, ...) (`src/host/alsa/mod.rs:458-460`); name = first line
  of the hint description or the PCM id (`alsa/mod.rs:440-455`). Does **not** match RtAudio's
  Pulse names.
- PulseAudio host: id = sink `name`, description = sink `description` (`src/host/pulseaudio/mod.rs:502-520`)
  - the same string RtAudio-Pulse showed (proplist `device.description`; normally identical to
  `pa_sink_info.description`, to be confirmed on a real box).

### 2.3 Sample rate, buffer size, format
- `build_output_stream(config, data_cb, err_cb, timeout)` takes `StreamConfig {channels,
  sample_rate, buffer_size}` by value; streams **do not auto-start**, call `play()`
  (`CHANGELOG.md` 0.18.0 "Changed"; `src/traits.rs:288-317`).
- CoreAudio: best-effort sets the physical format, else sets the device nominal rate (fails with
  `UnsupportedConfig` if not in the available ranges, times out after 1 s by default)
  (`macos/device.rs:88-215,835-849`) - equivalent to RtAudio. `BufferSize::Fixed(n)` outside the
  device range is an **error** (`UnsupportedConfig`), not clamped (`macos/device.rs:1009-1036`);
  RtAudio clamped silently.
- WASAPI: shared mode with `AUTOCONVERTPCM | SRC_DEFAULT_QUALITY`, i.e. Windows' own resampler/format
  converter does the conversion if the engine rate differs from the mix format
  (`wasapi/device.rs:656-660,975-976`); `Fixed(n)` becomes a buffer duration
  (`wasapi/device.rs:1432-1445`). Callback sizes may vary per call; the mixer already handles any
  `nFrames`.
- Data callback receives a slice pre-filled with silence (`src/traits.rs:293-296`).
- `SupportedStreamConfigRange` default heuristics now rank F32 first but may return I32/I24 on
  pro hardware (`CHANGELOG.md` 0.18.0) - request F32 explicitly.

### 2.4 Errors and disconnect
- Unified `ErrorKind` incl. `DeviceNotAvailable`, `DeviceChanged`, `StreamInvalidated`, `Xrun`,
  `RealtimeDenied`, `DeviceBusy`, `UnsupportedConfig` (`src/error.rs`; `CHANGELOG.md` 0.18.0/0.18.2).
- CoreAudio: a listener thread reports `DeviceNotAvailable` on `kAudioDevicePropertyDeviceIsAlive`
  (stream paused), `StreamInvalidated` if someone changes the device's nominal rate, `Xrun` on
  `kAudioDeviceProcessorOverload` (`src/host/coreaudio/macos/mod.rs:100-200`).
- **Default device follows the system default**: a stream built from `default_output_device()`
  uses `AudioUnitMode::DefaultOutput` and reroutes (`DeviceChanged`) when the user changes the
  system output (`macos/device.rs:851-855`; `macos/mod.rs:255-345`; `src/error.rs` doc of
  `DeviceChanged`). RtAudio resolved "default" to a fixed id at open time.
- Xrun reporting replaces RtAudio's `RTAUDIO_OUTPUT_UNDERFLOW` status bit
  (`audioEngineWorker.js:25,155`): CoreAudio/PipeWire/AAudio since 0.18.2, WASAPI capture only
  (`CHANGELOG.md` 0.18.2). Our own "late callback" counter (`audioEngineWorker.js:146-154`) can be
  kept with `Instant` in the callback.
- Real-time: CoreAudio callback already runs on the HAL IO thread; `realtime` feature only affects
  Android/Windows, `realtime-dbus` Linux (`README.md:71-72,183-189`). The callback must not
  allocate, lock a contended mutex, log, or free large buffers (dropping the last `Arc` of a decoded
  file in the callback would free hundreds of MB on the audio thread) - send retired buffers back
  over a queue.

### 2.5 BlackHole
- cpal 0.18.2 runs input+output on BlackHole 2ch at 48 kHz with `BufferSize::Fixed` on GitHub
  macOS runners (issue https://github.com/RustAudio/cpal/issues/1398, 2026-10-12, measurement
  setup). The same issue reports CoreAudio stream timestamps off by one buffer each way - do not
  use cpal timestamps for anything the tests measure.

## 3. symphonia 0.6.1

- Default features: `adpcm flac mkv ogg pcm vorbis wav all-meta opt-simd`; **mp3, aac, isomp4,
  alac, aiff, caf are off by default** (`symphonia-0.6.1/Cargo.toml` `[features]`).
- Support (`symphonia-0.6.1/README.md:75-122`): WAV Excellent, MP3 Excellent (gapless), FLAC
  Excellent, Vorbis Excellent, PCM Excellent, OGG Great, AIFF Great, ISO/MP4 Great but **no
  gapless**, AAC-LC Great **no gapless**, ALAC Great. **No Opus decoder** (the Ogg demuxer has an
  Opus mapping, `symphonia-format-ogg-0.6.1/src/mappings/opus.rs`, but `symphonia-codec-opus`
  does not exist on crates.io).
- AAC limits: rejects anything not AAC-LC, with **SBR (HE-AAC)**, **more than 2 channels**, or
  960-sample frames: `"aac: aac too complex"` (`symphonia-codec-aac-0.6.1/src/aac/mod.rs:90-97`);
  implicit SBR found mid-stream only sets a flag (`aac/mod.rs:186-197`). Raw `.aac` (ADTS) is read
  by `AdtsReader`, one frame per packet only (`src/adts.rs:39,192,274`).
- Encoder delay/padding: MP3 reads the LAME tag (`symphonia-bundle-mp3-0.6.1/src/demuxer.rs:433-435`).
  The MP4 reader has no edit-list / iTunSMPB handling (no match for `elst`/`edts`/`iTunSMPB` in
  `symphonia-format-isomp4-0.6.1/src`) - m4a keeps the AAC priming samples ffmpeg removes.
- Output is planar, native sample type; convert with `copy_to_vec_interleaved::<f32>`
  (`symphonia-core-0.6.1/src/audio/generic.rs:237,504`). Int->float is `s / 32768` for i16 and
  `/ 8388608` for i24 (`src/audio/conv.rs:491,511`), the same scaling ffmpeg uses, so WAV stays
  bit-exact; no dither on int->float (`conv.rs:373,385`).
- No resampling and no channel remix in symphonia; both are ours.

### Formats the app promises vs what is tested

| Ext | Typical content | ffmpeg today | symphonia 0.6.1 | Loopback test today |
|---|---|---|---|---|
| .wav | PCM 16/24/f32 | yes | yes (`wav`) | yes, `formats.test.js:38-40` |
| .mp3 | MP3 | yes | yes (`mp3`) | yes, `:42-68` |
| .flac | FLAC | yes | yes (`flac`) | **no** |
| .ogg | Vorbis | yes | yes (`ogg`,`vorbis`) | **no** |
| .ogg | **Opus** | yes | **no** | **no** |
| .ogg | FLAC-in-Ogg | yes | yes (mapping `flac.rs`) | no |
| .m4a | AAC-LC | yes | yes (`isomp4`,`aac`), priming not trimmed | **no** |
| .m4a | **HE-AAC / 5.1 AAC** | yes | **no** | no |
| .m4a | ALAC | yes | yes (`alac`) | no |
| .aac | ADTS AAC-LC | yes | yes (`aac`) | no |
| (.aif/.aiff) | not accepted today | - | `aiff` | - |

`test/audio/formats.test.js` only covers WAV, MP3, 44.1/96 kHz and mono, so ADR-007's "check the
formats only ffmpeg decoded" needs new loopback cases (flac, ogg vorbis, ogg opus, m4a AAC-LC,
m4a HE-AAC, .aac ADTS, m4a ALAC, 5.1 file) run against the Node app first, so the recorded
behaviour exists to compare against.

## 4. Resampling: rubato 5.1.0

- For whole-file, fixed-ratio conversion the crate recommends `Fft` with `process_all()`, which
  trims the resampler's startup delay so output lines up with input
  (`rubato-5.1.0/README.md:80-82,206-231`); `Async::new_sinc` is the variable-ratio equivalent.
  I/O through `audioadapter` 5.0 / `audioadapter-buffers` 5.1 (`rubato-5.1.0/Cargo.toml`).
  Feature `fft_resampler` is default.
- It is not swresample: different filter, transition band and phase; output will not be
  sample-identical to today's 44.1->48 kHz files. Pitch/level/position tests have tolerances
  (`formats.test.js:53-60`, pitch +/-3 Hz, level +/-0.01) that should absorb it; null tests against
  old recordings would not.
- Resample at decode time (as today), never in the callback.

---

## 5. Semantic traps (where Rust could sound or report differently)

1. **Saved device names won't match.** Configs and the loopback suites store RtAudio names; on
   macOS cpal names lack the `"Manufacturer: "` prefix (sec. 2.2), so `resolveDeviceId` would miss
   and fall back to the **default device** - the WO-001 failure (show on the laptop speakers).
   Needs a compatibility rule: build RtAudio-style names on macOS (read
   `kAudioObjectPropertyManufacturer` ourselves) or match both forms. Linux needs the `pulseaudio`
   (or `pipewire`) host to get the same names; ALSA names differ. Windows should match.
2. **Numeric device ids.** `GET /api/audio/output-devices` returns RtAudio's 129.. ids, and old
   configs may store them. ADR-005 wants the same JSON values; cpal ids are strings (UIDs). Either
   synthesize 129-based ids in enumeration order (as unstable as today's) or accept a contract
   change for `id`.
3. **"default" semantics.** cpal's default-device stream follows the OS default live; RtAudio's
   did not. Resolve "default" to a concrete device at open time to keep today's behaviour, or
   decide the new one is better.
4. **Buffer size out of range** errors in cpal; RtAudio clamped (sec. 2.3). Clamp ourselves using
   `SupportedBufferSize::Range`.
5. **Device sample rate is changed** on macOS by both; any other app on that device is affected the
   same way. cpal reports `StreamInvalidated` if another app changes the rate later - today nothing
   is reported. Decide whether to reopen automatically.
6. **Channel count below the device's.** RtAudio writes the first N channels of the device and
   leaves the rest silent (test "channel count 1: everything comes out of the first output only",
   `formats.test.js:100-115`). A 1-channel cpal stream on a 2-channel device goes through AUHAL /
   WASAPI channel conversion, which may copy mono to both outputs (unverified). Safer: always open
   the device with its full channel count (or `max(config, 2)` capped to device) and zero the
   unused channels; keep `channelCount` as the mixer's patch range.
7. **Output sample format.** cpal does not convert sample formats for us: `build_output_stream<T:
   SizedSample>` hands the callback a slice of the stream's own type (`cpal-0.18.2/src/traits.rs:318-326`).
   Request F32 (CoreAudio AUHAL and WASAPI with AUTOCONVERTPCM accept it; ALSA `hw:` devices may
   not). If a device only takes I16/I24 the clamp/rounding/dither is then *our* code; today the OS
   converts from f32.
8. **Clipping.** Today there is none in the app; overs pass to the OS. Do not add a limiter or
   clamp in the mixer (would change level tests and peaks); `peakLevel` may exceed 1.0 and the UI
   must keep receiving it unclamped.
9. **f32 vs f64 math.** Gains, ramp steps and positions are f64 in JS. A 10 s fade at 48 kHz is
   480 000 increments; in f32 the accumulated error can shift the fade end and `fadeRemainingSec`.
   Keep gains, steps, ramp state and `secondsToFrame` in f64; samples f32. Keep the exact
   `stepRamp` snap rule and the "remove when stopping && gain == 0" check.
10. **Fold-down and mono levels.** Keep `(L+R)*0.5` (WO-005) and mono duplicated at 0 dB (WO-004).
    symphonia reports channels exactly, so mono files with no channel tag (today `-ac 2`, -3 dB)
    become 0 dB - a small improvement; note it.
11. **Multichannel sources.** ffmpeg `-ac 2` downmixes 5.1 with C and surrounds at -3 dB and drops
    LFE (sec. 1.4). We must write that matrix ourselves; a naive "take channels 0 and 1" loses the
    centre (dialogue).
12. **AAC priming.** m4a/AAC files decoded by symphonia keep ~1024-2112 priming frames at the start
    and padding at the end (no edit-list support, no AAC gapless). Cue length, `totalDurationSec`,
    trim points and playlist joins shift by ~20-45 ms. Either parse `elst`/`iTunSMPB` ourselves or
    accept and document.
13. **Formats that stop working.** Ogg Opus, HE-AAC, >2-channel AAC: today they play; with
    symphonia they fail to decode. Error surface: play returns `{success:false, error}` (shape
    unchanged, text differs - fine under ADR-005), but the operator loses the cue.
14. **Duration reported vs decoded.** File `duration` in the media library comes from
    music-metadata (`audioFileManager.js:193-205`) and is stored/returned by REST; the time display
    uses the decoded length (`soundboardMixer.js:119-121`). If the port computes `duration` with
    symphonia instead, stored JSON values change (ADR-005/006). Keep the two sources separate.
15. **Resampler output** differs from swresample (sec. 4): fine for tolerance tests, not
    bit-identical. Also keep the "short file plays whole" case (`formats.test.js:71`): FFT
    resamplers on a 50 ms clip must not drop the tail (`process_all` handles it per README).
16. **Timing of status.** Today: mixer status every 40 ms, broadcast every 100 ms, so
    `currentTimeSec` lags up to ~140 ms behind the audio callback. A Rust engine reading atomics
    directly will be fresher; tests that assert "heard on time" are against audio, not WS, so this
    is safe, but `fadeTimeRemainingMs` and position rounding should keep the same formulas.
17. **Completion races.** Keep the seq rule (stale `complete`/`advanced` ignored), "immediate stop
    = no completion", "replace = silent", "fade stop = completion `'stopped'`", "last voice ends the
    cue". The command queue must be FIFO with play/stop/queueNext in order.
18. **Lazy open and self-healing.** Keep opening on first play and re-checking before each play;
    after `DeviceNotAvailable` the next play should try again (today: `isStreamRunning` false ->
    reopen). Map cpal errors to `audio-engine-error {type, message}`; `type` strings will change
    (today RtAudio numbers as strings) - check nothing in the UI/Companion keys off them (renderer
    only shows `message`).
19. **Xrun/dropout accounting** comes from a different source (cpal `Xrun` vs RtAudio underflow
    bit), so WO-009's baseline comparison (`test/audio/calibration.test.js`) compares a Rust app to
    an RtAudio bare player. Acceptable, but say so when reading results.
20. **NaN guard.** `buf[i] || 0` turns NaN into silence; a Rust `f32` read won't. Sanitize at
    decode time (cheaper) rather than in the callback.
21. **PCM cache.** New decoder = new key namespace (bump the version string or use a new dir), else
    a Rust build could read ffmpeg-decoded `.f32` files with a different resampler/downmix and the
    level/length tests would test ffmpeg, not symphonia. `mtimeMs` is a JS float; Rust must hash
    something of its own anyway.
22. **Windows with no devices (WO-012).** RtAudio aborted the process; cpal should return an empty
    list / `None`, but this is untested - add the CI case WO-012 proposes against the Rust server.
23. **Memory/free on the audio thread** (sec. 2.4) - JS GC hid this.

## 6. Recommended crate set

```toml
cpal = "0.18.2"                     # Linux: features = ["pulseaudio"] (see Q1)
symphonia = { version = "0.6.1", features = ["mp3", "aac", "isomp4", "alac", "aiff"] }
                                    # defaults keep flac, ogg, vorbis, pcm, wav, adpcm, mkv, all-meta, opt-simd
rubato = "5.1.0"                    # default "fft_resampler"; Fft + process_all at decode time
audioadapter-buffers = "5.1"        # rubato 5.1 I/O adapters
rtrb = "0.4.1"                      # wait-free SPSC: commands in, retired buffers/events out
```

MSRV: 1.85 (cpal, symphonia), 1.87 (rubato), 1.88 if the cpal
`pulseaudio` feature is used (`README.md:51`; each crate's `Cargo.toml` `rust-version`).
Not recommended: `realtime-dbus` (pulls libdbus), `jack`, `asio` (not used today). A dedicated
`Opus` decoder (e.g. a libopus binding) only if Q3 says Ogg Opus must keep working - that
reintroduces a C dependency.

## 7. Open questions for the owner

1. **Linux host**: build cpal with `pulseaudio` (same device names as today's RtAudio-Pulse build,
   needs libpulse-dev and Rust 1.88) or `pipewire`, or plain ALSA (names change, configs fall back
   to default)? Recommendation: `pulseaudio`.
2. **Device names on macOS**: keep RtAudio's `"Manufacturer: Name"` form (compatible with saved
   configs and the test harness) or switch to cpal's plain name and match both on read?
   Recommendation: report the RtAudio form, accept both, optionally also store the CoreAudio UID.
3. **Formats symphonia can't decode** (Ogg Opus, HE-AAC, multichannel AAC): drop them (and say so
   on upload), add a C decoder for them, or keep a fallback? Recommendation: first record the Node
   app on these files; then decide. Today none of them is tested.
4. **AAC priming in m4a**: implement edit-list/iTunSMPB trimming to match ffmpeg, or accept
   ~20-45 ms extra at start/end of m4a cues?
5. **Device ids in `/api/audio/output-devices`**: keep synthetic 129-based numbers for ADR-005, or
   accept string ids as a documented contract change?
6. **"System Default"**: fixed at open time (today) or follow the OS default live (cpal default)?
7. **Resampler**: is "in tune, right level within tolerance" enough, or must 44.1 kHz files be
   close to swresample output (would push us to a sinc `Async` with tuned parameters and a null
   test)?
8. **macOS minimum version**: cpal's README says CoreAudio needs macOS 14.2. Is that acceptable for
   the Intel target in ADR-009, or should we verify / pin an older cpal?
9. **Channel count < device channels**: OK to always open the device at its full width and zero the
   extra channels (keeps today's "first output only" behaviour)?
