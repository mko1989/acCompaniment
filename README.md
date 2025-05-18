# acCompaniment Soundboard

**acCompaniment** is a professional soundboard application built with Electron, designed for live performance, broadcasting, and advanced audio cue management. It offers robust control over audio playback, extensive customization options, and integration capabilities with external hardware and software, including Behringer WING mixers and Bitfocus Companion.

## Features

*   **Cue Management:**
    *   Create, organize, and trigger audio cues.
    *   Support for single audio files and complex playlists within a single cue.
    *   Individual cue properties: volume, fade in/out times, looping, retrigger behavior.
    *   Playlist-specific properties: shuffle, repeat one item, play modes (play through, stop after item).
    *   Drag-and-drop interface for adding audio files.
    *   Automatic discovery of audio file durations.
*   **Audio Playback Engine:**
    *   Powered by Howler.js for reliable and performant audio handling.
    *   Visual waveform display for trimming audio start/end points.
    *   Precise control over playback: play, pause, stop, stop all, fade out and stop.
*   **Configuration:**
    *   Global application settings for default cue behaviors, audio output device selection.
    *   Workspace management: Save and load entire cue layouts.
    *   Option to automatically load the last opened workspace.
*   **Integration & Control:**
    *   **Bitfocus Companion:** Seamless integration via a dedicated Companion module (`companion-module-highpass-accompaniment`) for remote triggering of cues and receiving feedback (cue status, playback times).
    *   **Behringer WING Mixer:** Direct OSC integration for configuring user-assignable buttons on the WING mixer to trigger cues and receive feedback from the mixer.
    *   **General OSC & MIDI Input:** (Planned) Configure cues to be triggered by generic OSC messages or MIDI notes/CCs.
*   **User Interface:**
    *   Clear and intuitive grid-based layout for cue buttons.
    *   Real-time display of cue status (idle, playing, paused, cued next).
    *   Display of current playback time, total duration, and remaining time on cue buttons.
    *   Dedicated sidebars for cue properties and application configuration.
    *   Theme support (light/dark/system).
*   **Easter Egg:**
    *   A fun, hidden 16-bit style game, "Elmer Fudd's Pig Roundup," accessible through a developer button or via an inactivity trigger in a blank workspace.

## Getting Started

### Prerequisites

*   Node.js and npm (or yarn) installed.

### Installation & Running

1.  **Clone the repository (if applicable) or navigate to the `acCompaniment` directory.**
2.  **Install dependencies:**
    ```bash
    cd path/to/your/workspace/acCompaniment
    npm install
    ```
3.  **Run the application:**
    ```bash
    npm start
    ```

## Development

The application is built using Electron. Key technologies include:

*   **Electron:** For building the cross-platform desktop application.
*   **HTML, CSS, JavaScript:** For the user interface and core logic.
*   **Howler.js:** For audio playback.
*   **Node.js:** For main process logic and system interactions.
*   **WebSockets:** For communication with the Bitfocus Companion module.
*   **OSC (Open Sound Control):** For mixer integration.

### Project Structure

Refer to `PROJECT_STRUCTURE.md` in the workspace root for a detailed breakdown of the application's file and directory layout.

### Key Scripts (from `package.json`)

*   `npm start`: Starts the Electron application.
*   (Add other relevant scripts here, e.g., for building, linting, testing, if they exist)

## Companion Module Integration

To control acCompaniment from Bitfocus Companion:

1.  Ensure acCompaniment is running. The internal WebSocket server will start automatically.
2.  Install the `companion-module-highpass-accompaniment` module into your Bitfocus Companion setup.
3.  Add an instance of the "acCompaniment" module in Companion.
4.  Configure the IP address and port if necessary (defaults usually work if Companion and acCompaniment are on the same machine).
5.  Actions, variables, and feedbacks will become available in Companion to control and monitor cues.

## Contributing

(Details on how to contribute, if applicable - e.g., pull requests, issue reporting guidelines)

## License

(Specify your project's license, e.g., MIT, GPL, etc. If not yet decided, you can put "To be determined" or leave blank for now.) 