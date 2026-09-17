# Audio Engine — Server-Primary + Multichannel Plan

Status: **implemented** · Owner: unassigned · Last updated: 2026-09-17

This design is live: `src/backend/soundboardMixer.js`, `audioDecoder.js`, and
`pcmCache.js` implement the `SoundboardMixer` + RtAudio approach described
below (Option C was chosen). The rest of this document is kept as the
design rationale for that choice, not a pending proposal.

---

## 1. Framing: what a server audio engine actually needs

Web Audio API is a browser concept. Porting it to Node.js via `node-web-audio-api`
is convenient but conflates three distinct layers into one opaque black box:

| Layer | Job |
|---|---|
| **PCM I/O** | Open a hardware device, feed interleaved float samples at the right rate, handle device enumeration + channel count |
| **Mixing / scheduling** | Sum multiple cues into the output buffer; apply gain, trim, fade, loop |
| **Decoding** | Convert audio files (mp3/wav/flac/m4a) to raw PCM Float32 |

For a pure Node.js server, you need to choose the right primitive at each layer.
The choice you make for the I/O layer determines multichannel reliability.

---

## 2. Concrete problems found with the current `node-web-audio-api` approach

| Issue | Detail |
|---|---|
| Channel count cap | `new AudioContext({ channels: 8 })` is **silently ignored**; `destination.maxChannelCount` returns what the driver reports and cannot be overridden. On the dev machine (MacBook Pro stereo speakers) = 2; unknown on a real multichannel interface. |
| Linux dependency | Pre-built binaries require **JACK or pipewire-jack** (a daemon); plain ALSA is not supported. A theatre machine running Linux without JACK configured cannot use this library out of the box. |
| Maturity | Backed by `orottier/web-audio-api-rs` (Rust reimplementation, not the browser's V8/Blink engine). Useful for creative coding; production 24/7 theatre playback is untested. |
| Opacity | Multichannel routing internals are opaque; no guarantee that `ChannelMergerNode` output maps correctly to physical device outputs on all platforms. |

---

## 3. Option comparison

### Option A — Keep `node-web-audio-api` (current)

**I/O layer:** Rust/CPAL → CoreAudio (Mac) / WASAPI (Win) / JACK (Linux only)  
**Mixing layer:** Web Audio node graph  
**Decode layer:** `decodeAudioData` (built-in)

| Pro | Con |
|---|---|
| Zero new deps | Channel count silently ignored — multichannel unverified without real hardware |
| Familiar Web Audio scheduling API | Linux requires JACK (daemon dependency) |
| `setSinkId` and `enumerateDevices` already work | Rust reimplementation, not browser-tested |
| Good for creative prototyping | Opaque channel routing internals |

**Verdict:** Acceptable for stereo. Multichannel reliability **unverified**. Linux
theatre machines are a problem. Not the right long-term foundation.

---

### Option B — `naudiodon` (PortAudio Node.js streams)

**I/O layer:** PortAudio → CoreAudio / WASAPI / ALSA / DirectSound  
**Mixing layer:** you build it  
**Decode layer:** you build it (ffmpeg subprocess or separate lib)

naudiodon has known issues with CoreAudio channel mapping (GitHub issue #71:
a user trying the exact same multichannel AV use case got audio glitches and
underflows). The last real maintenance activity is years old. No ASIO out of the box.

**Verdict:** Do not use. Outdated, known channel mapping bugs on macOS, requires
building everything from scratch.

---

### Option C — `@hamitzor/rtaudio.js` + ffmpeg decode (recommended)

**I/O layer:** RtAudio C++ → CoreAudio (Mac) / WASAPI+ASIO (Win) / ALSA+JACK (Linux)  
**Mixing layer:** custom `SoundboardMixer` (Float32Array, ~400 lines)  
**Decode layer:** `fluent-ffmpeg` → raw Float32 PCM

**RtAudio** is the audio I/O library used by SuperCollider, Pure Data, Csound,
and Sonic Pi. It is 20+ years old and specifically designed for professional
multichannel real-time audio in server/daemon applications. Node.js bindings:
**`@hamitzor/rtaudio.js`** (there is no bare `rtaudio.js` on npm).

```
npm install @hamitzor/rtaudio.js fluent-ffmpeg
```

**macOS multichannel:** Yes. RtAudio uses **CoreAudio** (`MACOSX_CORE`) on macOS.
Each device exposes `outputChannels` via `getDevices()` — the count comes from the
hardware/driver, not a library cap. Built-in MacBook speakers report 2 (stereo
only); external USB/Thunderbolt interfaces (MOTU, RME, Focusrite, Dante USB, NDI,
etc.) report their full channel count (e.g. 6, 8, 16). You open a stream with
`nChannels` up to that max and write interleaved Float32 in the callback;
`firstChannel` can offset the starting output index on complex CoreAudio layouts.

**API sketch:**
```js
const RtAudio = require('@hamitzor/rtaudio.js');
const rt = new RtAudio();

// Enumerate devices with real channel counts
const devices = rt.getDevices();
// → [{ id, name, outputChannels, sampleRates, preferredSampleRate, ... }, ...]

// Open stream on chosen device with N channels
rt.openStream(
    { deviceId: selectedDeviceId, nChannels: 8 },  // output
    null,                                            // no input
    RtAudioFormat.RTAUDIO_FLOAT32,
    48000,
    512,   // buffer size (frames)
    (outputBuffer, inputBuffer, nFrames) => {
        // outputBuffer = Float32Array of length nFrames * 8
        // Write interleaved samples: [ch0_s0, ch1_s0, ..., ch7_s0, ch0_s1, ...]
        mixer.render(outputBuffer, nFrames, 8);
        return 0;
    }
);
rt.start();
```

**Channel routing:** interleaved Float32 gives explicit per-sample channel control.
Routing cue N to outputs 3-4 means writing to `outputBuffer[frame * nCh + 2]` and
`outputBuffer[frame * nCh + 3]`. No ambiguity, no opaque node graph.

| Pro | Con |
|---|---|
| RtAudio is the standard for professional server audio | Requires building a mixing layer (400-600 lines) |
| True multichannel: report actual hw channel count | Requires ffmpeg for audio decoding |
| ASIO support on Windows | More moving parts than node-web-audio-api |
| Direct ALSA on Linux (no JACK daemon required) | `@hamitzor/rtaudio.js` builds native addon (CMake + C++); verify on target CI/hardware |
| CoreAudio multichannel on macOS | Built-in output stays stereo; need external interface for >2 channels |
| Full control over channel routing | |
| No silent failures or opaque caps | |

**Verdict: Best foundation for a professional multichannel theatre server.**

---

### Option D — `node-cpal` (same Rust lib as node-web-audio-api, but raw)

**I/O layer:** CPAL Rust → CoreAudio / WASAPI / ALSA  
**Mixing layer:** you build it  
**Decode layer:** you build it

CPAL is what `node-web-audio-api` uses internally. `node-cpal` exposes it directly
as raw PCM streams. Same Linux situation (ALSA, not JACK). Very new; API unstable.

**Verdict:** Interesting but immature. Linux ALSA support here (unlike `node-web-audio-api`
which wraps it into JACK). Not enough ecosystem history for theatre use.

---

## 4. Recommended architecture

```
┌─────────────────────────────────────────────────────────────┐
│  NODE.JS SERVER                                             │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Cue 1        │  │ Cue 2        │  │ Cue N            │  │
│  │ ffmpeg→Float │  │ ffmpeg→Float │  │ ffmpeg→Float     │  │
│  │ buffer+state │  │ buffer+state │  │ buffer+state     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
│         │                 │                 │               │
│  ┌──────▼─────────────────▼─────────────────▼────────────┐  │
│  │  SoundboardMixer                                       │  │
│  │  - trim/loop/fade (linear gain curves in PCM)          │  │
│  │  - per-cue outputPatch: channel assignment             │  │
│  │  - render(outputBuffer, nFrames, nChannels)            │  │
│  └──────────────────────────────┬─────────────────────────┘  │
│                                 │ Float32 interleaved PCM    │
│  ┌──────────────────────────────▼─────────────────────────┐  │
│  │  RtAudio  (@hamitzor/rtaudio.js)                        │  │
│  │  deviceId + nChannels configured from appConfig         │  │
│  │  CoreAudio / WASAPI / ALSA                              │  │
│  └─────────────────────────────────────────────────────── ┘  │
│                  ↕  WebSocket                               │
└─────────────────────────────────────────────────────────────┘
            │
   ┌────────▼──────────────────┐
   │ BROWSER                   │
   │ Cue grid / state display  │
   │ Howler.js: solo preview   │
   └───────────────────────────┘
```

---

## 5. The `SoundboardMixer` — what needs to be built

The mixer is the only genuinely new code. It is not complex. It is a PCM sample loop.

```js
class SoundboardMixer {
    constructor() {
        this.activeCues = new Map(); // cueId → CuePlayback
    }

    // Called by RtAudio callback at ~10ms intervals
    render(outputBuffer, nFrames, nChannels) {
        outputBuffer.fill(0); // silence

        for (const [, cue] of this.activeCues) {
            const vol  = cue.currentGain;   // updated by fade logic (see below)
            const patch = cue.outputPatch;  // e.g. [2, 3]

            for (let f = 0; f < nFrames; f++) {
                if (cue.position >= cue.trimEnd) {
                    if (cue.loop) cue.position = cue.trimStart;
                    else { this.activeCues.delete(cue.id); break; }
                }

                const L = cue.buffer[cue.position * cue.channels    ];
                const R = cue.buffer[cue.position * cue.channels + 1] ?? L;
                cue.position++;

                outputBuffer[f * nChannels + patch[0]] += L * vol;
                outputBuffer[f * nChannels + patch[1]] += R * vol;

                // Inline linear gain ramp (fade)
                if (cue.gainTarget !== vol) {
                    cue.currentGain += cue.gainStep; // pre-computed per-sample step
                    if (Math.abs(cue.gainTarget - cue.currentGain) < Math.abs(cue.gainStep))
                        cue.currentGain = cue.gainTarget;
                }
            }
        }
    }

    playCue(cue, floatBuffer, options) { /* trim, fade, loop, patch setup */ }
    stopCue(cueId, fadeMs)             { /* set gainTarget = 0, gainStep */ }
}
```

This is the entire mixing engine. It runs inside the RtAudio callback with no async.

---

## 6. Audio decoding with ffmpeg

```js
const ffmpeg = require('fluent-ffmpeg');

function decodeToFloat32(filePath, sampleRate, trimStart, trimEnd) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(filePath)
            .inputOptions(trimStart > 0 ? [`-ss ${trimStart}`] : [])
            .inputOptions(trimEnd    ? [`-to ${trimEnd}`]    : [])
            .outputFormat('f32le')          // raw float32 little-endian
            .audioChannels(2)               // always decode to stereo; mixer handles routing
            .audioFrequency(sampleRate)
            .pipe()
            .on('data', chunk => chunks.push(chunk))
            .on('end',  () => {
                const buf = Buffer.concat(chunks);
                resolve(new Float32Array(buf.buffer));
            })
            .on('error', reject);
    });
}
```

ffmpeg handles every format (wav, mp3, flac, m4a, ogg, aiff) without separate
per-format libraries. The result is a `Float32Array` the mixer reads directly.

Pre-decode cues on load (not on first play) and cache them. This removes all
decode latency from playback start.

---

## 7. Device enumeration API

```js
const devices = rt.getDevices().filter(d => d.outputChannels > 0);
// Each device: { id, name, outputChannels, sampleRates }
```

Expose via:
- `GET /api/audio/output-devices` → `[{ id, name, outputChannels }, ...]`
- WebSocket invoke `get-output-devices`

No temporary AudioContext required (unlike the `node-web-audio-api` approach where
you'd open a context per device to read `maxChannelCount`).

---

## 8. Cue model additions

```js
// New fields (default values ensure no migration needed for existing workspaces):
{
  outputPatch: [0, 1]   // 0-based output channel indices on the hardware device
                        // [0,1] = default stereo; [2,3] = outputs 3-4, etc.
}
```

---

## 9. Config model additions

```js
{
  audioOutputDeviceId:     'default',  // rtaudio device id or 'default'
  audioOutputChannelCount: 2,          // how many channels to open (up to device max)
  audioSampleRate:         48000,
  audioBufferSize:         512,        // frames; lower = less latency, more CPU
}
```

---

## 10. Implementation tasks

### ENG1 — Install + test RtAudio device enumeration `[x]`
```
npm install @hamitzor/rtaudio.js fluent-ffmpeg
```
Requires CMake and a C++ toolchain to compile the native addon on first install.

**CMake 4.x note:** If install fails with `Compatibility with CMake < 3.5 has been removed`,
run: `CMAKE_POLICY_VERSION_MINIMUM=3.5 npm install`

Verify with: `npm run probe:rtaudio`
`outputChannels` count. On a Mac without an external interface, built-in speakers
will correctly show 2 — plug in the show interface to validate the real channel count.

**Acceptance:** Device list shows multichannel interface name + channel count.

---

### ENG2 — Build `SoundboardMixer` class `[x]`
**File:** `src/backend/soundboardMixer.js` (new)

Implement: `render(outBuf, nFrames, nCh)`, `playCue(opts)`, `stopCue(id, fadeMs)`,
`setGain(id, vol)`, `getStatus()`. Use Float32Array throughout.
Fade = per-sample linear ramp computed as `gainStep = (target - current) / (fadeMs * sampleRate / 1000)`.

**Acceptance:** Unit test: two simultaneous cues with crossfade, output on different
channel pairs, loop at trim boundary — verify via `OfflineAudioContext` or file write.

---

### ENG3 — Replace `AudioPlaybackManager` with RtAudio + SoundboardMixer `[x]`
**File:** `src/backend/audioPlaybackManager.js`

- Replace `AudioContext` + node graph with `RtAudio` instance + `SoundboardMixer`.
- In `init()`: call `rt.openStream(deviceConfig)`, set up RtAudio callback → `mixer.render()`.
- `playCue(cueId, filePath, options)`: decode via ffmpeg (ENG4), hand buffer to mixer.
- `stopCue(cueId, fadeOut)`: call `mixer.stopCue()` with fade time.
- `getPlaybackStatus()`: read from `mixer.getStatus()`.
- Keep the same public API so `cueManager.js` doesn't change.

**Acceptance:** All existing cue trigger/stop flows work; playback audible on server.

---

### ENG4 — Pre-decode audio files to Float32 on import `[x]`
**Files:** `src/backend/audioFileManager.js`, `src/backend/audioPlaybackManager.js`

When a cue is loaded for the first time (or on app start for existing cues), decode
to `Float32Array` via ffmpeg and cache in `audioBuffers` Map. Apply LRU as per
FIX_PLAN D1 (max ~512 MB total decoded).

Also: ffmpeg decode replaces `decodeAudioData`, so `node-web-audio-api` can be
**removed from `package.json`** after this step.

**Acceptance:** First play of a cue is instantaneous (buffer pre-cached);
`node-web-audio-api` no longer in deps.

---

### ENG5 — Device selection + runtime switch `[x]`
**File:** `src/backend/audioPlaybackManager.js`, `src/backend/websocketManager.js`

- `switchDevice(deviceId, channelCount)`: fade all playing cues, `rt.closeStream()`,
  `rt.openStream(newConfig)`, recreate mixer with new channel count.
- Wire to `save-app-config` WS handler when `audioOutputDeviceId` or
  `audioOutputChannelCount` changes.

**Acceptance:** Device change in config sidebar routes audio to new device; playing
cues survive with a short fade.

---

### ENG6 — Server-side playback time reporting `[x]`
**Files:** `src/backend/audioPlaybackManager.js`, `src/backend/cueManager.js`

Track `wallStartTime` + `trimStartTime` per active cue. In `cueManager`, run a
10 Hz setInterval that reads `mixer.getStatus()` per playing cue and broadcasts
`playback-time-update` via WebSocket.

**Acceptance:** Browser UI time counter matches real playback position within ~200ms.

---

### ENG7 — Per-cue channel assignment in properties sidebar `[x]`
**Files:** `src/frontend/ui/propertiesSidebar*.js`, `src/frontend/ui/appConfigUI.js`

Add "Output" row: two dropdowns ("Left / Mono", "Right") populated from
`GET /api/audio/output-devices` channel count. Saves to `cue.outputPatch`.
Only show when `outputChannelCount > 2`.

**Acceptance:** Changing output channel for a cue persists and routes correctly.

---

### ENG8 — Browser preview path `[x]`
**Files:** `src/frontend/audio/audioController.js`, `src/frontend/ui/propertiesSidebar.js`

- Remove Howler.js from normal cue trigger flow.
- Gate existing Howler code behind `previewOnly: true` flag.
- Add "Preview" button in properties sidebar → `audioController.previewCue(cue)` →
  local Howler play, no server trigger.
- Cue button states driven by server `cue-status` WS messages only.

**Acceptance:** Normal cue button sends trigger to server only; Preview button plays
locally; grid shows playing state from server message.

---

## 11. What to remove

| Item | Action |
|---|---|
| `node-web-audio-api` dep | Remove after ENG4 |
| `src/backend/audioPlaybackManager.js` | Replace (ENG3) |
| `src/frontend/audio/audioManager.js` | Remove (has duplicate `cleanup()` bug anyway) |
| Howler.js from main playback flow | Gate behind preview flag (ENG8) |

---

## 12. What NOT to change

- `cueManager.js` public API (`playCue`, `stopCue`, `triggerCue`, etc.)
- WebSocket message contract
- Cue data model (only adding `outputPatch`)
- All persistence / workspace logic
- Frontend cue grid, cue store, properties sidebar (except ENG7/8 additions)

---

## 13. Suggested implementation order

```
ENG1   Hardware verification (must do first — confirms @hamitzor/rtaudio.js on target)
ENG2   SoundboardMixer build + unit test
ENG4   ffmpeg decode layer
ENG3   Replace AudioPlaybackManager
ENG5   Device enumeration API + runtime switch
ENG6   Server-side time reporting
ENG8   Browser preview path
ENG7   Per-cue channel selector in UI (last)
```

---

## 14. Testing checklist

- [ ] `rt.getDevices()` shows multichannel interface with correct channel count
- [ ] Default stereo cue plays on outputs 1-2 (unchanged behaviour)
- [ ] Cue with `outputPatch: [2, 3]` silent on 1-2, audible on 3-4
- [ ] Fade-in / fade-out work (no click at start/end)
- [ ] Trim start/end enforced (silence before trim, silence after trim end)
- [ ] Loop restarts cleanly at trim start with no gap
- [ ] Two cues simultaneously on different channel pairs
- [ ] Retrigger mid-fade: new playback starts cleanly, old stops
- [ ] Device switch reroutes cleanly
- [ ] Preview button plays locally only, no server state change
- [ ] Browser time display tracks server position within 200ms
- [ ] Decoded buffer cache stays bounded after loading 100+ cues
- [ ] Linux: audio works with plain ALSA (no JACK required)
