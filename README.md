# acCompaniment Soundboard

**acCompaniment** is a professional soundboard application designed for live performance, broadcasting, and advanced audio cue management. It runs as one native audio server, written in Rust, with a browser-based UI, and offers robust control over audio playback, extensive customization options, and integration capabilities with Bitfocus Companion.

> This branch is the Rust version: the server and audio engine were ported from the Node.js app
> (see `rust/MAP.md` and `rust/DECISIONS.md`). The tray app (`rust/tray/`) builds a macOS app
> and DMG; Windows and Linux installers and a release workflow are still to do (Wave C).

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
    *   Automatic discovery of audio file durations.
*   **Audio Playback Engine:**
    *   Server-side playback (cpal) and a sample-accurate mixer, with
        per-cue multichannel output routing; files decoded with symphonia (ffmpeg for AAC/M4A
        and a few others).
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

*   **Operating System:** macOS (tested on macOS 15, Apple silicon; built to start on macOS 12 and
    later, not yet tried below 14); Windows 10/11 and Linux are targets, not tested yet
*   **Audio:** Compatible audio output device

## Getting Started

### Prerequisites

*   Rust (stable, via [rustup](https://rustup.rs)); `cargo` lives in `~/.cargo/bin`
*   ffmpeg, for AAC/M4A and a few other formats: `npm run fetch:ffmpeg` puts a static build in
    `vendor/ffmpeg/`, or install one on the `PATH`, or set `FFMPEG_PATH`
*   For the tests only: Node.js 20+ and npm (`npm install`, then
    `npx playwright install chromium` for the browser tests)

### Running

```bash
cargo build --release --manifest-path rust/app/Cargo.toml
rust/app/target/release/accompaniment
```

Then open http://localhost:3333. Settings: `PORT` (default 3333, or the port in the app config),
`HOST` (default every interface), `ACCOMPANIMENT_DATA_DIR` (default `~/.accompaniment`),
`ACCOMPANIMENT_FRONTEND_DIR` (default the repo's `src/frontend`), `FFMPEG_PATH`.
`npm start` builds and runs it in one step.

The tray app (`rust/tray/`, Tauri) runs the server for you and lives in the menu bar / system
tray: status, port, Open Browser UI, Restart Server, Show Logs, Open Data Directory, Quit. It
has no window of its own: settings, the port included, are in the browser UI (Restart Server
applies a changed port). It restarts the server after a crash, adopts a server already running on its
port, and writes the server's output to `<data dir>/logs/accompaniment-server.log`.

```bash
npm run build:tray                       # the server + the tray app (development build)
rust/tray/target/release/acCompaniment   # finds the server it just built
npm run bundle:tray                      # the installable app: rust/tray/target/release/bundle/
```

`bundle:tray` needs `cargo install tauri-cli --version ^2 --locked` once. On macOS the DMG step
styles its window through Finder; without automation access (an SSH or CI session) run it as
`CI=true npm run bundle:tray`.

`npm run bundle:tray:mac-universal` builds one macOS app for Intel and Apple Silicon (needs
`rustup target add x86_64-apple-darwin aarch64-apple-darwin`).

### Headless Linux

For a Linux machine without a desktop (a rack PC, a Raspberry Pi 4/5 with a 64-bit OS): the
server alone, with its browser UI and ffmpeg, installed as a systemd service.
`npm run package:headless` (on Linux; `ci/linux-check.sh package:headless` builds it in Docker
from a Mac) makes `dist/accompaniment-<version>-linux-<arch>.tar.gz`; on the target machine:

```bash
tar xzf accompaniment-*-linux-*.tar.gz && cd accompaniment-*-linux-*/
sudo ./install.sh        # /opt/accompaniment, data in /var/lib/accompaniment, starts at boot
```

Then open `http://<machine>:3333` from any browser on the network. The package's `README.txt`
(from `packaging/linux-headless/`) covers settings, logs, audio and removal.

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


#### HTTP Web Remote
<img width="582" height="480" alt="Screenshot 2025-08-19 at 12 49 01" src="https://github.com/user-attachments/assets/ce9e33ed-3bd9-4f59-be9b-f22c2d754d68" />



## Development

*   **Rust server** (`rust/app/`): HTTP/REST API and static file serving (axum), WebSockets for
    the browser UI and Bitfocus Companion, the cue engine, the data layer and the audio engine
    (cpal output, symphonia decoding, the mixer).
*   **Browser UI** (`src/frontend/`, HTML/CSS/JavaScript, no framework): served by the server
    to any browser on the LAN, including `remote_control/` (the HTTP remote page).

### Project Structure

- `rust/app/` — the server: `src/server/` (HTTP, WebSocket), `src/core/` (cues, projects, media
  library, cue engine, playlist and retrigger logic, the mixer), `src/audio/` (devices,
  decoding, output)
- `rust/tray/` — the tray app (Tauri): `src/supervisor.rs` runs the server
- `rust/` — the port's records: `MAP.md` (plan and state), `DECISIONS.md` (ADRs),
  `HANDOFF.md`, `app-cases/` (recorded HTTP behavior), `research/`
- `src/frontend/` — browser UI
- `test/` — the test suites (JavaScript, run against the Rust binary)
- `work/` — work orders: every bug's record (see CLAUDE.md)
- `assets/` — icons and resources
- `archive/`, `companion-module-highpass-accompaniment/` — not part of the app and not in the repo (ignored by git; the module lives in its own repo)

### Available Scripts

*   `npm run build` - Build the server (`cargo build --release`)
*   `npm run build:tray` / `npm run bundle:tray` - Build the tray app / its installable bundle
*   `npm run package:headless` - The headless Linux package (on Linux)
*   `ci/linux-check.sh [npm scripts...]` - Build and test on Linux in Docker (default:
    `test:unit test:smoke`)
*   `npm start` - Build and run it
*   `npm test` - Build, then the unit tests (Rust and the test tooling's), the API/WebSocket
    smoke tests and the browser end-to-end tests
*   `npm run test:rust` - `cargo test`: the server's Rust tests, including the recorded cases of
    the pure logic (`rust/app/tests/unit_cases.rs`), and the tray app's (its supervisor, against
    the real server binary)
*   `npm run test:smoke` - The API/WebSocket tests (`test/*.test.js`): each file starts its own
    server against an isolated temp data directory
*   `npm run test:e2e` - The browser UI in Playwright (`test/e2e/`; each worker runs its own
    server and every test starts from a clean slate)
*   `npm run test:audio` - The loopback audio suite (`test/audio/`): the server plays to a
    loopback audio device and the tests record what comes back, checking every playback option
    by ear - volume, fades, trims, loops, output routing, every retrigger behavior, pause, Stop
    All, crossfade, ducking, playlist modes, file formats and sample rates, engine settings and
    every control surface (REST, remote page, WebSocket, Companion). The test files are
    generated tones whose frequency encodes the playback position, so a recording shows exactly
    where each cue was and how loud.
*   `npm run test:audio:ui` - The same idea through the browser UI (`test/audio-ui/`,
    Playwright): real clicks on cues, sidebars, Stop All, XFADE and the remote page, checked
    against the recording.

    Both need a loopback device: macOS `brew install blackhole-2ch`, Windows VB-Cable, Linux
    `snd-aloop` - or any virtual device whose input echoes its output (found by name; set
    `ACCOMPANIMENT_LOOPBACK_DEVICE`, and `ACCOMPANIMENT_LOOPBACK_INPUT` if input and output are
    separate devices). Without one the tests are skipped. Every recording is saved to
    `test-recordings/audio/` / `test-recordings/audio-ui/` as a WAV with an Audacity label
    track (`.labels.txt`) marking each action.
*   `ACCOMPANIMENT_SERVER_BIN=<path>` runs any suite against another server binary.
*   `rust-anything app replay . --build rust/app/target/release/accompaniment` - replays the
    recorded HTTP cases (`rust/app-cases/`) against the server.

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
