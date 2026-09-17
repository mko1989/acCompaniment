# Audio Playback (superseded)

This document previously described a planned `playbackMode: "client" | "server"`
toggle (browser Web Audio API vs. server-side playback) that was **never
built**. The actual implementation is server-primary only: RtAudio + a
custom PCM mixer running on the Node.js server, with the browser UI as a
thin client. There is no client-side playback mode.

See `AUDIO_ENGINE_PLAN.md` for the real architecture and the reasoning
behind choosing server-side playback.
