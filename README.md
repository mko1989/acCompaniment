# acCompaniment

**acCompaniment** is a professional soundboard application built with Electron, designed for live performance, broadcasting, and advanced audio cue management. It offers robust control over audio playback, extensive customization options, and integration capabilities with Bitfocus Companion.

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
    *   **Bitfocus Companion:** Seamless integration via a dedicated Companion module (https://github.com/mko1989/companion-module-highpass-accompaniment) for remote triggering of cues and receiving feedback (cue status, playback times).
    *   **HTTP Remote Control:** Built-in web interface for remote control via any web browser.
*   **User Interface:**
    *   Clear and intuitive grid-based layout for cue buttons.
    *   Real-time display of cue status (idle, playing, paused, cued next).
    *   Display of current playback time, total duration, and remaining time on cue buttons.
    *   Dedicated sidebars for cue properties and application configuration.
    *   Dark theme optimized for live performance environments.
*   **Easter Egg:**
    *   A fun, hidden 16-bit style game, "Happy Pig!" accessible through Ctrl+Alt+P.

## System Requirements

*   **Operating System:** Windows 10/11, macOS 10.15+
*   **Memory:** 4GB RAM minimum, 8GB recommended
*   **Storage:** 200MB for application, additional space for audio files
*   **Audio:** Compatible audio output device

## Getting Started

### Prerequisites

*   Node.js 18+ and npm (for development builds)

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
5. **Stop All:** Use the red "Don't Panic" button to stop all playing cues
6. **Ducking:** One cue is a ducking trigger, meaning when this cue is played, all the cues with ducking enable will be ducked with the set level.
7. **Crossfade:** When enabled only one cue is able to play and clicking a new one will trigger a crossfade between them.
8. **Waveform editing:** In single cue's properties users can set in and out points on the wave form to cut out unnecessary parts.
9. **Remote Control:** Enable HTTP remote control in settings to access the web interface

#### Main workspace (red in show mode, gray in edit mode)
<img width="1165" height="655" alt="Screenshot 2025-12-09 at 09 55 36" src="https://github.com/user-attachments/assets/444794ed-9243-4d88-96d7-785881b29f99" />

<img width="1161" height="656" alt="Screenshot 2025-12-09 at 09 56 09" src="https://github.com/user-attachments/assets/e6dd92a0-9101-4b2c-a8c8-57f62f30cb07" />

#### Buttons
<img width="215" height="77" alt="Screenshot 2025-12-09 at 09 56 23" src="https://github.com/user-attachments/assets/7af6c51b-566c-4a22-b72b-300593816ab3" />
<img width="218" height="72" alt="Screenshot 2025-12-09 at 09 56 56" src="https://github.com/user-attachments/assets/15f97635-9200-4627-9d04-118d4656b460" />

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

#### Cue's settings on buttons
##### Top left: cue's state. Next: looping if enabled. Middle: retrigger behaviour. Top right: ducking
<img width="160" height="131" alt="Screenshot 2025-12-09 at 10 09 24" src="https://github.com/user-attachments/assets/92efaf3f-7926-4159-bebc-cdb8cf5a68b5" />

##### Retrigger behaviour: Fade and Stop
<img width="164" height="140" alt="Screenshot 2025-12-09 at 09 57 25" src="https://github.com/user-attachments/assets/831d1d26-52b1-4d61-849a-39e0c20f07a1" />

##### Retrigger behaviour: Restart
<img width="166" height="141" alt="Screenshot 2025-12-09 at 09 57 37" src="https://github.com/user-attachments/assets/9ec3996c-e07a-4497-b926-b32d7fce6ffb" />

##### Retrigger behaviour: Play new instance
<img width="160" height="136" alt="Screenshot 2025-12-09 at 09 57 45" src="https://github.com/user-attachments/assets/7f817baf-f64c-409d-bd7e-5861600a1869" />

##### Retrigger behaviour: Do nothing
<img width="165" height="133" alt="Screenshot 2025-12-09 at 09 57 52" src="https://github.com/user-attachments/assets/94b2bdfd-5214-459b-a0fd-ca283b1b11ac" />

##### Retrigger behaviour: Stop
<img width="161" height="135" alt="Screenshot 2025-12-09 at 09 58 01" src="https://github.com/user-attachments/assets/1ceff267-4953-4944-bbea-1e7e687d560d" />

##### Retrigger behaviour: Toggle Play/Pause
<img width="158" height="136" alt="Screenshot 2025-12-09 at 09 58 10" src="https://github.com/user-attachments/assets/18f1c0a7-4cfc-4a96-950c-aea7a8f03c21" />

##### Retrigger behaviour: Play next playlist item
<img width="170" height="135" alt="Screenshot 2025-12-09 at 09 58 44" src="https://github.com/user-attachments/assets/6b374174-aff2-4523-abb1-c74ce553fbef" />

##### Retrigger behaviour: Replay current item
<img width="161" height="140" alt="Screenshot 2025-12-09 at 09 59 57" src="https://github.com/user-attachments/assets/46f36b92-0fd9-411f-963d-54a74efe7851" />


#### HTTP Web Remote
<img width="582" height="480" alt="Screenshot 2025-08-19 at 12 49 01" src="https://github.com/user-attachments/assets/ce9e33ed-3bd9-4f59-be9b-f22c2d754d68" />



## Development


The application is built using Electron. Key technologies include:

*   **Electron:** For building the cross-platform desktop application.
*   **HTML, CSS, JavaScript:** For the user interface and core logic.
*   **Howler.js:** For audio playback.
*   **Node.js:** For main process logic and system interactions.
*   **WebSockets:** For communication with the Bitfocus Companion module.

### Project Structure

The project follows a standard Electron structure:
- `main.js` - Main Electron process
- `src/main/` - Main process modules
- `src/renderer/` - Renderer process (UI) modules
- `assets/` - Application icons and resources

### Available Scripts

*   `npm start` - Start the Electron application in development mode
*   `npm run pack` - Package the application (without creating installers)
*   `npm run dist` - Build distributables for all platforms
*   `npm run dist:mac` - Build macOS distributable
*   `npm run dist:win` - Build Windows distributable

### Building for Distribution

To create distributable packages:

```bash
# Install dependencies
npm install

# Build for all platforms
npm run dist

# Or build for specific platform
npm run dist:mac    # macOS
npm run dist:win    # Windows
```

Built packages will be available in the `dist/` directory.

## Companion Module Integration

To control acCompaniment from Bitfocus Companion:

1.  Ensure acCompaniment is running. The internal WebSocket server will start automatically.
2.  Install the `companion-module-highpass-accompaniment` module into your Bitfocus Companion setup.
3.  Add an instance of the "acCompaniment" module in Companion.
4.  Configure the IP address and port if necessary (defaults usually work if Companion and acCompaniment are on the same machine).
5.  Actions, variables, and feedbacks will become available in Companion to control and monitor cues.


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
