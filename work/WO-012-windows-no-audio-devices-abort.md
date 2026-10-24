# WO-012: On Windows with no audio devices, probing devices aborts the process

| | |
|---|---|
| Status | Open |
| Severity | High (if confirmed: the server dies) |
| Feature | Audio engine - device listing / engine start (Windows) |
| Opened | 2026-10-24, by Claude (seen in the release workflow, WO-011) |
| Reproduction test | - (needs a Windows machine with no audio output devices; not yet reproduced against the app itself) |
| Related | WO-011 |

## Feature
The server lists output devices (`AudioPlaybackManager.listOutputDevices` /
`getOutputDevices`, `GET /api/audio/output-devices`, the config sidebar) and
opens the configured device when playback starts. With no device it should
say so - "no audio output" in the UI - and keep running.

## Problem
On a GitHub Windows runner, which has no audio devices, loading the
packaged RtAudio addon worked, but `new RtAudio().getDevices()` ended the
process: RtAudio printed `RtApiWasapi::probeDevices: No devices found.` and
the process exited with code 4294930435 (a native abort - a JavaScript
`try` around the call didn't help). On macOS and Linux runners, also with
no devices, the same call returned an empty list.

If the app does the same - and it calls `getDevices()` from the main thread
(`listOutputDevices`, `resolveDeviceId`, `resolveChannelCount`) and the
engine worker - then a Windows machine with all output devices disabled or
unplugged, or a remote-desktop session without audio, would crash the
server instead of showing "no audio output". Not confirmed against the app
yet.

## Proposed solution
1. Reproduce on Windows with output devices disabled: start the server,
   open the UI, list devices, trigger a cue.
2. If it crashes: count devices first where RtAudio allows it without
   probing (`getDeviceCount()` / `getDeviceIds()` in RtAudio 6), or move
   device listing into a short-lived child process the server can survive,
   and report "no audio output" through the existing engine-error banner.
3. Add a test: the server stays up, and lists zero devices, with no audio
   devices (can run on a GitHub Windows runner, which has none).

## What has been done
- 2026-10-24: Seen in the release workflow; the workflow's check no longer
  probes devices (it only loads the addon). Work order opened; nothing
  changed in the app.

## Decision
- Pending - owner to decide whether to pursue (needs a Windows machine, or
  a test run on a Windows CI runner).
