# WO-001: Saving any setting in the config sidebar can move the show output to the system default device

| | |
|---|---|
| Status | Done |
| Severity | Critical |
| Feature | App config sidebar - audio output device |
| Opened | 2026-10-24, by Claude (loopback UI suite - output went to the laptop speakers mid-run) |
| Reproduction test | `test/audio-ui/ui-playback.spec.js` - "saving an unrelated setting in the config sidebar leaves the output device alone (WO-001)"; `test/e2e/config-sidebar.spec.js` - "a configured device that isn't connected stays configured through other saves (WO-001)", "choosing an output device saves it by name" |
| Related | WO-002 |

## Feature
The config sidebar (`#configAudioOutputDevice`) picks the output device the
show plays to. Every field in the sidebar autosaves: changing any of them
sends the whole sidebar's config to the server (WebSocket `save-app-config`),
which re-opens the audio engine if an audio setting changed.

## Problem
If the configured output device isn't one of the dropdown's options, the
dropdown silently shows nothing selected - and the next save of *any*
setting (crossfade time, a default fade...) sends `audioOutputDeviceId: ''`.
The server resolves `''` to the system default output and re-opens the
engine there. Mid-show, the output jumps to the laptop speakers (or whatever
the Mac's default is) because someone changed the crossfade time.

When the configured device isn't an option:
- it is stored **by name** - the server accepts names
  (`resolveDeviceId`, `src/backend/audioPlaybackManager.js:24`), and API
  clients, older configs and the test suites use them; the dropdown's
  options are valued by numeric id;
- the device **isn't connected** right now (interface unplugged, turned off);
- the device's numeric id **changed** - RtAudio's CoreAudio ids are
  run-time object ids, not guaranteed stable across reboots or re-plugging,
  so an id saved yesterday can point at nothing (or another device) today.

Root cause:
- `src/frontend/ui/appConfigUI.js:399` - options are `String(device.id)`.
- `src/frontend/ui/appConfigUI.js:245` and `:409` - `select.value =
  String(currentAppConfig.audioOutputDeviceId)`; with no matching option
  the select's value becomes `''`.
- `src/frontend/ui/appConfigUI.js:502` - `gatherConfigFromUI` sends
  `select.value` whatever it is.
- `src/backend/audioPlaybackManager.js:25` - `''` means "default device".
- `src/backend/websocketManager.js:266-286` - the changed device id counts
  as an audio change, so the engine is re-opened on the new device.

Reproduced on 2026-10-24 on both NoMachine Audio Adapter and BlackHole 2ch:
a cue played after changing `#crossfadeTime` came out of the MacBook
speakers, not the configured device.

## Proposed solution
1. **Store devices by name, not id** (names are stable; ids aren't). Option
   values become `device.name`; the server already resolves names. Existing
   configs with a numeric id keep working (resolved as today) and are
   rewritten to the name the next time the device is chosen.
2. **Never lose the configured device in the dropdown.** If it isn't in the
   list, add a selected, disabled-looking option "<name> (not connected)"
   carrying the configured value, so saving other settings round-trips it
   unchanged.
3. **Only send what changed** (or at least: never send an audio key the user
   didn't touch). `handleAppConfigChange` sends the field that changed rather
   than the whole form, so an unrelated save can't re-open the engine.
4. **Server guard:** treat an empty `audioOutputDeviceId` in an update as
   "unchanged", not "default"; "default" must be chosen explicitly
   (`'default'`).

Acceptance: the reproduction test passes; choosing a device in the
dropdown still moves the output (existing test "config sidebar: choosing
another output device moves the sound there, and back"); a configured device
that's unplugged shows as "(not connected)" and survives other saves.

Options for the owner:
- A. All four (recommended): fixes the cause and hardens both ends.
- B. 2 + 4 only: smallest change that stops the jump; ids stay fragile.

## What has been done
- 2026-10-24: Found by the loopback UI suite (crossfade and Stop All fade
  tests went silent - the sound had moved to the speakers). Root cause traced
  as above. Reproduction test added (`test.fail`). The UI suite now seeds
  the device by id so its other tests aren't affected. No product code
  changed.
- 2026-10-24: Implemented option A.
  - `src/frontend/ui/appConfigUI.js`: device options are valued by name;
    new `selectConfiguredDevice()` selects the configured device whether
    it's stored by name or (older configs) by id, and when it isn't in the
    list adds a selected "<name> (not connected)" option carrying the stored
    value; `savedUiConfig` snapshots what the sidebar shows after it's
    populated / devices load / a save, and `saveAppConfiguration()` sends
    only the fields that differ from it. An old id-style config therefore
    shows as the device's name and is only rewritten if the user picks a
    device.
  - `src/backend/appConfigManager.js`: `updateConfig()` drops an empty or
    null `audioOutputDeviceId` instead of saving it (which meant "default").
  - Tests: the UI reproduction test no longer expects failure and passes
    (cue still heard on the loopback after changing crossfade time); two new
    e2e tests (unplugged device survives saves; choosing a device saves its
    name); the loopback UI fixtures seed the device by name again; the
    device-switch test selects by name.
  - Results: `test/e2e/config-sidebar.spec.js` 18/18;
    `npm run test:audio:ui` 15/15 (one test - playlist arrows - passed on
    retry; not reproducible in 4 further runs, unrelated to this change).

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  recommended option, A (all four parts).
