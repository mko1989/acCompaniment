# acCompaniment Soundboard

**acCompaniment** is a professional soundboard application designed for live performance, broadcasting, and advanced audio cue management. It runs as a Node.js audio server with a browser-based UI (wrapped in a minimal Electron tray launcher for system integration), and offers robust control over audio playback, extensive customization options, and integration capabilities with Bitfocus Companion.

## Features

*   **Cue Management:**
    *   Create, organize, and trigger audio cues.
    *   Support for single audio files and complex playlists within a single cue.
    *   Individual cue properties: volume, fade in/out times, looping, trim points, retrigger behavior.
    *   Retrigger behaviors (what pressing a playing or paused cue does): restart, toggle pause/play,
        stop, fade out and stop, do nothing, play new instance (layered copies), replay current item,
        play next item.
    *   Playlist-specific properties: shuffle, repeat one item, loop the list, play modes
        (continue to next item, stop after item and cue the next).
    *   Ducking: a cue marked as a ducking trigger lowers every other playing cue that has ducking
        enabled, by the trigger's ducking level, and restores them when it stops.
    *   Crossfade mode (XFADE): starting a cue fades the playing ones out and the new one in.
    *   Drag-and-drop interface for adding audio files.
    *   Spotify cues: play a Spotify track, playlist or album through Spotify Connect (see
        [Spotify cues](#spotify-cues)).
    *   Automatic discovery of audio file durations.
*   **Audio Playback Engine:**
    *   Server-side playback via RtAudio and a custom PCM mixer, with
        per-cue multichannel output routing.
    *   Visual waveform display for trimming audio start/end points.
    *   Precise control over playback: play, pause, stop, stop all, fade out and stop.
*   **Projects:**
    *   Everything saves automatically. The project name is at the top of the settings
        sidebar; New Project, Load Project, Download Bundle and Import Bundle are at the bottom.
    *   A bundle is one `.zip` with the project and all its audio - to move a show to another
        machine. Importing reuses audio that's already there.
    *   The last opened project reopens on restart.
*   **Media library:**
    *   Each audio file is stored once, under its own name, and shared by every cue and project
        that uses it; adding the same file again reuses it (a different file with a taken name
        is kept as "Name (2)").
    *   "Replace File" in a cue's properties swaps in a new version for every cue using it.
    *   Libraries from older versions (timestamped duplicate copies) are converted
        automatically on first start, with a backup in `cues/backups/library-migration-*`.
*   **Configuration:**
    *   Global application settings for default cue behaviors, audio output device selection.
*   **Integration & Control:**
    *   **Bitfocus Companion:** Seamless integration via a dedicated Companion module (https://github.com/mko1989/companion-module-highpass-accompaniment) for remote triggering of cues and receiving feedback (cue status, playback times).
    *   **HTTP Remote Control:** Built-in web interface for remote control via any web browser.
*   **User Interface:**
    *   Clear and intuitive grid-based layout for cue buttons.
    *   Real-time display of cue status (idle, playing, paused, fading, cued next, ducked, number of
        instances playing) and the playlist item playing now and next.
    *   Display of current playback time, total duration, and remaining time on cue buttons.
    *   Dedicated sidebars for cue properties and application configuration.
    *   Dark theme optimized for live performance environments.

## System Requirements

*   **Operating System:** Windows 10/11, macOS 10.15+
*   **Memory:** 4GB RAM minimum, 8GB recommended
*   **Storage:** 200MB for application, additional space for audio files
*   **Audio:** Compatible audio output device

## Getting Started

### Prerequisites

*   Node.js 20.17+ (or 22.9+) and npm (for development builds)
*   ffmpeg (`brew install ffmpeg` on macOS) - used to decode audio files;
    found on the `PATH`, or set `FFMPEG_PATH` to point at it
*   CMake (`brew install cmake` on macOS) - the audio engine's native
    module (`@hamitzor/rtaudio.js`) ships a prebuilt binary, but it isn't
    always usable as-is; `npm install` falls back to compiling it locally
    with CMake, and that fallback is common enough in practice to treat
    CMake as required, not optional. CMake 4 works thanks to the project's
    `.npmrc` (npm prints an "Unknown project config" warning about that
    line - it's expected; the setting is read by cmake-js, not npm)

### Installation & Running

#### For End Users
Download the latest release from the [Releases](../../releases) page for your operating system.

#### For Developers
1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd acCompaniment
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Run the application:**
    ```bash
    npm start
    ```

## Usage

1. **Adding Cues:** Drag and drop audio files onto the main grid area to create cues
2. **Show/Edit Mode:** Use the show mode button in top right corrner to change show state (lights or pencile icon)
3. **Playing Cues:** Click on any cue button to start playback
4. **Edit Mode:** Hold Shift while clicking to edit cue properties
5. **Stop All:** Use the red "Don't Panic" button to stop all playing cues (immediately, or with a
   fade - see "Stop All Behavior" in the app config)
6. **Crossfade:** Turn on XFADE in the top bar (or on the remote page) to crossfade between cues
7. **Remote Control:** Enable HTTP remote control in settings to access the web interface

#### Main workspace (red in show mode, gray in edit mode)
<img width="1195" height="782" alt="Screenshot 2025-07-11 at 22 15 53" src="https://github.com/user-attachments/assets/a20d35d7-4578-4073-9304-8b46c461ecdb" />

<img width="666" height="541" alt="Screenshot 2025-07-11 at 18 09 11" src="https://github.com/user-attachments/assets/696e765b-4912-4258-9b9c-0f9083d57e2a" />

#### Buttons
<img width="166" height="90" alt="Screenshot 2025-07-11 at 18 07 15" src="https://github.com/user-attachments/assets/90b4ddeb-8559-4334-9f01-a82c2b7a4afe" />

#### App config
<img width="272" height="660" alt="Screenshot 2025-07-11 at 18 06 52" src="https://github.com/user-attachments/assets/c46f8468-0edc-4c4d-8f6d-d346748ced49" />

<img width="266" height="307" alt="Screenshot 2025-07-11 at 18 07 03" src="https://github.com/user-attachments/assets/d08808c9-9363-49c5-aa3f-15863b074b0d" />

#### Single cue properties
<img width="305" height="714" alt="Screenshot 2025-07-11 at 18 08 27" src="https://github.com/user-attachments/assets/ac266220-f489-4787-9ccb-0787a669bae0" />

<img width="312" height="373" alt="Screenshot 2025-07-11 at 18 08 37" src="https://github.com/user-attachments/assets/bba057c7-b959-4334-8fd9-515c1a2966f2" />

#### Playlist cue properties
<img width="312" height="659" alt="Screenshot 2025-07-11 at 18 08 50" src="https://github.com/user-attachments/assets/ed5a5c7c-f4d5-4a42-8091-9a753c2d5653" />

<img width="305" height="540" alt="Screenshot 2025-07-11 at 18 09 01" src="https://github.com/user-attachments/assets/ee4fea3d-74a4-4aa3-8941-0bad315bbf1e" />

#### Add multiple files modal
<img width="350" height="318" alt="Screenshot 2025-07-11 at 18 08 03" src="https://github.com/user-attachments/assets/cd796ad5-f84f-4efc-92b9-4eb94bc968b2" />


#### Spotify cues
A cue can play a Spotify track, playlist, album, artist or podcast instead of an audio file.
Spotify doesn't let other apps take its audio, so Spotify cues play in a **Spotify player**
(the Spotify app on this computer, or a Connect speaker) - not through acCompaniment's audio
output - and they need **Spotify Premium**. Fades and ducking change that player's volume;
one Spotify cue plays at a time.

Setting it up (once):
1. Create an app at <https://developer.spotify.com/dashboard> (choose *Web API*). As its
   redirect URI, add the one shown under **Settings > Spotify** - e.g.
   `http://127.0.0.1:3333/api/spotify/callback` (it includes the server port).
2. Paste the app's **Client ID** into Settings > Spotify and press **Connect Spotify**, on the
   computer running acCompaniment. Approve access in the tab that opens.
3. Optionally pick which Spotify player cues play on (otherwise: whichever one is active).

Making cues: drag a track or playlist from the Spotify app onto the grid, or copy its link
(Share > Copy link) and paste it into the app. An existing cue can be switched to the *Spotify*
type in its properties and given a link there. Loop repeats the track (or the whole playlist);
the grid's arrows and "Play Next Item" step through a playlist.

#### HTTP Web Remote
<img width="582" height="480" alt="Screenshot 2025-08-19 at 12 49 01" src="https://github.com/user-attachments/assets/ce9e33ed-3bd9-4f59-be9b-f22c2d754d68" />



## Development

acCompaniment runs as a Node.js server with a browser-based UI, wrapped in a
minimal Electron tray launcher for system integration. Key technologies:

*   **Node.js + Express:** HTTP/REST API and static file serving.
*   **WebSockets (`ws`):** Real-time cue/playback state to the browser UI and
    to Bitfocus Companion.
*   **RtAudio (`@hamitzor/rtaudio.js`) + a custom PCM mixer:** Server-side
    audio output, mixing, fades, and multichannel routing — see
    `AUDIO_ENGINE_PLAN.md` for the design.
*   **HTML, CSS, JavaScript (browser, no framework):** The main UI, served
    to any browser on the LAN.
*   **Electron:** A thin system-tray launcher only — it starts/stops the
    Node.js server and shows connection info; it is not where the app's
    logic lives.

### Project Structure

- `server.js` — Node.js server entry point (HTTP + WebSocket)
- `src/backend/` — Server-side logic: cue/workspace management, audio
  engine, REST routes
- `src/frontend/` — Browser UI (served by the server), including
  `remote_control/` (the HTTP remote control page)
- `electron-launcher/` — Minimal Electron app: system tray, starts/stops the
  server, configuration window
- `start-nodejs.js` — Headless server launch script (no Electron/tray)
- `assets/` — Application icons and resources
- `archive/legacy-electron-app/` — The original, pre-migration monolithic
  Electron app, kept for reference only (not built or maintained)

### Available Scripts

*   `npm start` - Start the full app (Electron tray launcher + server)
*   `npm run start:server` / `npm run start:node` - Start just the Node.js
    server, headless (no Electron)
*   `npm test` - Run the full test suite (unit + API/WebSocket smoke tests +
    browser end-to-end tests)
*   `npm run test:unit` - Just the unit tests (`test/unit/` - mixer, playlist and retrigger
    logic, helpers; no server or audio device needed)
*   `npm run test:smoke` - Just the API/WebSocket smoke tests (`test/*.test.js`) -
    spawns real server instances against isolated temp data directories, no
    browser needed
*   `npm run test:e2e` - Just the Playwright tests: the browser UI
    (`test/e2e/`, requires a one-time `npx playwright install chromium`; each
    worker runs its own server and every test starts from a clean slate) and
    the Electron tray launcher (`test/electron/`, run as a real app against an
    isolated data directory and port)
*   `npm run test:audio` - The loopback audio suite (`test/audio/`): the server
    plays to a loopback audio device and the tests record what comes back,
    checking every playback option by ear - volume, fades, trims, loops,
    output routing, every retrigger behavior, pause, Stop All, crossfade,
    ducking, playlist modes, file formats and sample rates, engine settings
    and every control surface (REST, remote page, WebSocket, Companion).
    The test files are generated tones whose frequency encodes the playback
    position, so a recording shows exactly where each cue was and how loud.
*   `npm run test:audio:ui` - The same idea through the browser UI
    (`test/audio-ui/`, Playwright): real clicks on cues, sidebars, Stop All,
    XFADE and the remote page, checked against the recording.

    Both need a loopback device: macOS `brew install blackhole-2ch`, Windows
    VB-Cable, Linux `snd-aloop` - or any virtual device whose input echoes its
    output (found by name; set `ACCOMPANIMENT_LOOPBACK_DEVICE`, and
    `ACCOMPANIMENT_LOOPBACK_INPUT` if input and output are separate devices).
    Without one the tests are skipped. Every recording is saved to
    `test-recordings/audio/` / `test-recordings/audio-ui/` as a WAV with an
    Audacity label track (`.labels.txt`) marking each action. Tests marked
    TODO document known issues they currently catch.
*   `npm run probe:rtaudio` - Diagnose audio device / native module issues
*   `npm run pack` - Package the application (without creating installers)
*   `npm run dist` - Build the installer for this machine's platform
*   `npm run dist:mac` / `dist:win` / `dist:linux` - The same, for that
    platform - run each on that platform (see below)

### Building for Distribution

**Releases:** push a version tag and the release workflow
(`.github/workflows/release.yml`) builds the macOS, Windows and Linux
(x64 + arm64) installers, each on its own platform, and attaches them to the
GitHub release for that tag (a tag with a `-`, like `v2.0.5-beta`, is
published as a pre-release). Every push to the `node` branch builds them
too, without releasing, so a broken build shows up before tagging.

**Locally**, build the installer for the platform you're on:

```bash
npm install
npm run dist        # this machine's platform
```

Built packages will be available in the `dist/` directory.

Each platform has to be built on that platform: the audio engine is a
native addon that can't be cross-compiled. A build that would package
another platform's audio engine fails with an explanation
(`scripts/check-native-binaries.js`, run by electron-builder after
packaging). `node scripts/check-native-binaries.js dist/<unpacked dir> --load`
also checks that the packaged app can load its audio engine on its own.

## Companion Module Integration

To control acCompaniment from Bitfocus Companion:

1.  Ensure acCompaniment is running. The module connects over WebSocket to the same port as the web interface (3333 by default) - there is no separate Companion port.
2.  Install the `companion-module-highpass-accompaniment` module (2.0 or later; needs Companion 4.3+) into your Bitfocus Companion setup. Module 1.x only works with the old Electron app.
3.  Add an instance of the "acCompaniment" module in Companion.
4.  Set the IP address of the acCompaniment machine and the server port (defaults work if both run on the same machine with the default port). Connections made with module 1.x are moved from the old port 8877 automatically.
5.  Actions, variables, feedbacks and presets become available to trigger cues, step through playlists, switch crossfade, set the master volume and show cue state and times. See the module's HELP for the full list.

## Troubleshooting

### Common Issues

**Audio not playing:**
- Check that the correct audio output device is selected in Settings
- Verify audio files are in supported formats (MP3, WAV, M4A, etc.)

**Cues not appearing:**
- Ensure audio files are being dropped in the main grid area
- Check that files are not corrupted

**Spotify cue doesn't play:**
- The banner at the top says why. Usually: Spotify isn't open on this computer (or the chosen
  player is offline), the account isn't Premium, or the login expired (reconnect in Settings).
- "INVALID_CLIENT: Invalid redirect URI" on connecting: the redirect URI registered for your
  Spotify app must match the one in Settings > Spotify exactly, port included.

**Remote control not working:**
- Verify HTTP remote control is enabled in Settings
- Check firewall settings if accessing from another device

**Performance issues:**
- Close unnecessary applications
- Reduce the number of simultaneous playing cues
- Use lower quality audio files if needed

### Getting Help

If you encounter issues not covered here, please check the [Issues](../../issues) page or create a new issue with:
- Your operating system and version
- Steps to reproduce the problem
- Any error messages

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

If you like it consider buying me a coffee 
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S21HW40I)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 
