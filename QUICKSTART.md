# Quick Start Guide - acCompaniment Node.js

## 🚀 Running the Application

### Prerequisites
- Node.js 18+ installed
- Dependencies installed (`npm install`)

### Step 1: Install Dependencies (if not already done)
```bash
npm install
```

### Step 2: Start the Server

#### Recommended: the full app (system tray + auto-started server)
```bash
npm start
```
This launches the Electron tray launcher (`electron-launcher/`), which
starts the Node.js server for you, shows connection/port info in its tray
menu, and opens the browser UI. This is what end users run.

#### Headless server only (no tray icon, no Electron)
Useful for running on a machine without a GUI, or when developing against
the server directly.

##### Option 1: Using npm script
```bash
npm run start:node
```

##### Option 2: Using the startup script directly
```bash
node start-nodejs.js
```

##### Option 3: Using the server file directly
```bash
node server.js
```

##### Option 4: Development mode
```bash
npm run dev
```

### Step 3: Access the Application

Once the server starts, you'll see output like:
```
HTTP Server running at http://0.0.0.0:3333
WebSocket Server running at ws://0.0.0.0:3333
Browser UI: http://localhost:3333
```

**Open your browser and navigate to:**
```
http://localhost:3333
```

### Custom Port

To run on a different port:
```bash
node start-nodejs.js --port=8080
```

Or set the PORT environment variable:
```bash
PORT=8080 node start-nodejs.js
```

### What to Expect

1. **Server starts** - You'll see initialization messages in the console
2. **Data directory created** - The server creates `~/.accompaniment/` for storing:
   - Audio files
   - Cue data
   - Configuration
   - Workspaces
3. **WebSocket connection** - The browser automatically connects via WebSocket
4. **UI loads** - The frontend loads and initializes all modules

### Testing Features

Once the application is running, you can test:

1. **Create Cues** - Drag and drop audio files onto the grid
2. **Play Audio** - Click cue buttons to play audio
3. **Edit Cues** - Click a cue to open the properties sidebar
4. **Configure Settings** - Use the config sidebar to adjust defaults
5. **Create Playlists** - Add multiple files to create playlist cues

### Troubleshooting

#### Port Already in Use
If port 3333 is already in use, the server exits with a clear
"port already in use" message instead of a raw crash. Use a different port:
```bash
node start-nodejs.js --port=8080
```

#### WebSocket Connection Issues
- Check that the server is running
- Verify the browser console for connection errors
- Ensure no firewall is blocking WebSocket connections

#### Module Import Errors
- Make sure all dependencies are installed: `npm install`
- Check that you're using Node.js 18+
- Verify all files are in the correct locations

### Stopping the Server

Press `Ctrl+C` in the terminal to stop the server gracefully.

### Next Steps

- Check the browser console (F12) for any errors
- Test audio playback with different file formats
- Try creating and editing cues
- Test the waveform editing features
- Explore the configuration options

