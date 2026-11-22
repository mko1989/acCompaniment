# App replay

Build: `env ACCOMPANIMENT_CORE=rust rust/app/target/release/accompaniment`

Passed: 146/167

Fallback rate: 0.0% (0/167 cases answered by the original)

## Failing cases

### 1003-remote-status

Arguments: `GET '/api/remote/status?case=1003'`

body:

```diff
  ⋮
      "cueStates": {},
      "engine": {
        "channelCount": 2,
-       "deviceId": 130,
+       "deviceId": null,
        "sampleRate": 48000
      },
      "masterVolume": 1,
  ⋮
```

### 1021-playback-status

Arguments: `GET '/api/cues/status/playback?case=1021'`

body:

```diff
  ⋮
      "cueStates": {},
      "engine": {
        "channelCount": 2,
-       "deviceId": 130,
+       "deviceId": null,
        "sampleRate": 48000
      },
      "masterVolume": 1,
  ⋮
```

### 3001-trigger-plain

Arguments: `POST '/api/cues/d86f0e6c-af67-4918-964d-60f975548940/trigger?case=3001'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3002-status-while-playing

Arguments: `GET '/api/cues/status/playback?case=3002'`

body:

```diff
- {"success":true,"status":{"playingCues":["[..]"],"totalPlaying":1,"cueStates":{"[..]":{"status":"playing",[..],"currentTime":0,"totalTime":0}},"masterVolume":0.5,"crossfadeMode":false,"engine":{"deviceId":130,"sampleRate":48000,"channelCount":2},"voices":[{"cueId":"[..]","voiceId":"[..]#1","isPaused":false,"isFadingIn":false,"isFadingOut":false,"isDucked":false,"duckGain":1,"gain":0.04,"volume":0.04,[..],"trimStartSec":0,"trimEndSec":10,"outputPatch":[1,1]}]}}
+ {
+   "status": {
+     "crossfadeMode": false,
+     "cueStates": {},
+     "engine": {
+       "channelCount": 2,
+       "deviceId": null,
+       "sampleRate": 48000
+     },
+     "masterVolume": 0.5,
+     "playingCues": [],
+     "totalPlaying": 0,
+     "voices": []
+   },
+   "success": true
+ }
(trailing newline: expected false, got true)
```

### 3003-remote-status-while-playing

Arguments: `GET '/api/remote/status?case=3003'`

body:

```diff
- {"success":true,"status":{"playingCues":["[..]"],"totalPlaying":1,"cueStates":{"[..]":{"status":"playing",[..],"currentTime":0,"totalTime":0}},"masterVolume":0.5,"crossfadeMode":false,"engine":{"deviceId":130,"sampleRate":48000,"channelCount":2},"voices":[{"cueId":"[..]","voiceId":"[..]#1","isPaused":false,"isFadingIn":false,"isFadingOut":false,"isDucked":false,"duckGain":1,"gain":0.04,"volume":0.04,[..],"trimStartSec":0,"trimEndSec":10,"outputPatch":[1,1]}]}}
+ {
+   "status": {
+     "crossfadeMode": false,
+     "cueStates": {},
+     "engine": {
+       "channelCount": 2,
+       "deviceId": null,
+       "sampleRate": 48000
+     },
+     "masterVolume": 0.5,
+     "playingCues": [],
+     "totalPlaying": 0,
+     "voices": []
+   },
+   "success": true
+ }
(trailing newline: expected false, got true)
```

### 3006-trigger-fades

Arguments: `POST '/api/cues/7e015e7a-6654-4ad0-90d5-158a060fb22a/trigger?case=3006'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3008-trigger-toggle

Arguments: `POST '/api/cues/6d90d28a-ff21-453c-a5ef-940971c0a35c/trigger?case=3008'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3009-retrigger-toggle

Arguments: `POST '/api/cues/6d90d28a-ff21-453c-a5ef-940971c0a35c/trigger?case=3009'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "paused",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3010-toggle-cue-after-retrigger

Arguments: `GET '/api/cues/6d90d28a-ff21-453c-a5ef-940971c0a35c?case=3010'`

body:

```diff
  ⋮
      ],
      "relativePath": "tone.flac",
      "retriggerBehavior": "pause",
-     "status": "paused",
+     "status": "stopped",
      "totalTime": 0,
      "trimEndTime": null,
      "trimStartTime": 0,
  ⋮
```

### 3011-toggle-pause

Arguments: `POST '/api/cues/6d90d28a-ff21-453c-a5ef-940971c0a35c/toggle-pause?case=3011'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue playing",
-   "status": "playing",
-   "success": true
+   "error": "Cue not playing",
+   "success": false
  }
```

### 3013-trigger-ducked

Arguments: `POST '/api/cues/e7602c69-426c-4c48-8abf-a935bc0f2ace/trigger?case=3013'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3014-trigger-ducking

Arguments: `POST '/api/cues/5fc03146-304c-4e6e-bc4f-850f9a3c7829/trigger?case=3014'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3015-status-ducking

Arguments: `GET '/api/cues/status/playback?case=3015'`

body:

```diff
- {"success":true,"status":{"playingCues":["[..]","[..]","[..]"],"totalPlaying":3,"cueStates":{"[..]":{"status":"stopped","currentTime":0,"totalTime":0,"completedAt":[..]},"[..]":{"status":"playing",[..],"currentTime":0,"totalTime":0,"pausedAt":[..],"resumedAt":[..]},"[..]":{"status":"playing",[..],"currentTime":0,"totalTime":0},"[..]":{"status":"playing",[..],"currentTime":0,"totalTime":0}},"masterVolume":0.5,"crossfadeMode":false,"engine":{"deviceId":130,"sampleRate":48000,"channelCount":2},"voices":[{"cueId":"[..]","voiceId":"[..]#3","isPaused":false,"isFadingIn":false,"isFadingOut":false,"isDucked":false,"duckGain":1,"gain":0.05,"volume":0.05,[..],"trimStartSec":0,"trimEndSec":10,"outputPatch":[0,1]},{"cueId":"[..]","voiceId":"[..]#4","isPaused":false,"isFadingIn":false,"isFadingOut":false,"isDucked":true,"duckGain":0.[..],"gain":0.05,"volume":0.05,[..],"trimStartSec":0,"trimEndSec":10.0078125,"outputPatch":[0,1]},{"cueId":"[..]","voiceId":"[..]#5","isPaused":false,"isFadingIn":false,"isFadingOut":false,"isDucked":false,"duckGain":1,"gain":0.05,"volume":0.05,[..],"trimStartSec":0,"trimEndSec":10,"outputPatch":[0,1]}]}}
+ {
+   "status": {
+     "crossfadeMode": false,
+     "cueStates": {},
+     "engine": {
+       "channelCount": 2,
+       "deviceId": null,
+       "sampleRate": 48000
+     },
+     "masterVolume": 0.5,
+     "playingCues": [],
+     "totalPlaying": 0,
+     "voices": []
+   },
+   "success": true
+ }
(trailing newline: expected false, got true)
```

### 3016-trigger-playlist

Arguments: `POST '/api/cues/579933b0-9fee-4d06-b1b4-6ab043194548/trigger?case=3016'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3023-remote-trigger

Arguments: `POST '/api/remote/cues/891cc443-984f-44c0-a43d-81bfc518fb45/trigger?case=3023'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3027-trigger-unicode

Arguments: `POST '/api/cues/2b149964-7488-4b5a-b921-59e0b16d5aa5/trigger?case=3027'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3028-trigger-trimmed

Arguments: `POST '/api/cues/a7826383-017e-4f9a-afef-689004e31c97/trigger?case=3028'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```

### 3031-stop-all-fade

Arguments: `POST '/api/cues/stop-all?case=3031'`

body:

```diff
  {
-   "message": "Stopped 2 cues",
-   "stoppedCount": 2,
+   "message": "Stopped 0 cues",
+   "stoppedCount": 0,
    "success": true
  }
```

### 3032-stop-all

Arguments: `POST '/api/cues/stop-all?case=3032'`

body:

```diff
  {
-   "message": "Stopped 2 cues",
-   "stoppedCount": 2,
+   "message": "Stopped 0 cues",
+   "stoppedCount": 0,
    "success": true
  }
```

### 3035-status-after-stop-all

Arguments: `GET '/api/cues/status/playback?case=3035'`

body:

```diff
  ⋮
      "cueStates": {},
      "engine": {
        "channelCount": 2,
-       "deviceId": 130,
+       "deviceId": null,
        "sampleRate": 48000
      },
      "masterVolume": 0.5,
  ⋮
```

### 4012-trigger-after-restore

Arguments: `POST '/api/cues/d86f0e6c-af67-4918-964d-60f975548940/trigger?case=4012'`

status:

```diff
expected 200, got 400
```

body:

```diff
  {
-   "message": "Cue triggered successfully",
-   "status": "playing",
-   "success": true
+   "error": "No audio output: the Rust audio engine (B4) is not built yet",
+   "success": false
  }
```
