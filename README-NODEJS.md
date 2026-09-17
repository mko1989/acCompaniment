# acCompaniment Node.js Backend

This is the Node.js backend implementation of acCompaniment, designed to work with a browser-based frontend and optional Electron launcher.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   node start-nodejs.js
   ```

3. **Access the web interface:**
   Open your browser and go to `http://localhost:3000`

## 📁 Project Structure

```
accompaniment-nodejs/
├── server.js                 # Main server entry point
├── start-nodejs.js          # Startup script
├── package-nodejs.json      # Node.js dependencies
├── src/
│   ├── backend/             # Backend modules
│   │   ├── pathManager.js   # File path management
│   │   ├── appConfigManager.js # Configuration management
│   │   ├── audioFileManager.js # Audio file handling
│   │   ├── cueDataManager.js   # Cue data management
│   │   ├── websocketManager.js # WebSocket communication
│   │   ├── cueManager.js       # Main cue management
│   │   └── routes/             # API routes
│   │       ├── config.js       # Configuration API
│   │       ├── audio.js        # Audio file API
│   │       ├── cues.js         # Cue management API
│   │       ├── workspaces.js   # Workspace API
│   │       └── remote.js       # Remote control API
│   └── frontend/            # Browser-based UI
│       └── index.html       # Main web interface
└── assets/                  # Static assets
```

## 🔧 Configuration

The server creates a data directory at `~/.accompaniment/` with the following structure:

```
~/.accompaniment/
├── audio/                   # Audio files
│   ├── imported/           # Imported audio files
│   ├── user/               # User audio files
│   └── metadata/           # Audio file metadata
├── cues/                   # Cue data
│   ├── workspaces/         # Workspace files
│   ├── backups/            # Automatic backups
│   └── templates/          # Cue templates
├── config/                 # Configuration
│   └── appConfig.json      # Main configuration
└── temp/                   # Temporary files
    └── waveforms/          # Generated waveform data
```

## 🌐 API Endpoints

### Configuration
- `GET /api/config` - Get current configuration
- `PUT /api/config` - Update configuration
- `POST /api/config/reset` - Reset to defaults

### Audio Files
- `GET /api/audio` - Get all audio files
- `POST /api/audio/upload` - Upload audio file
- `POST /api/audio/import` - Import audio file from path
- `GET /api/audio/:id` - Get audio file by ID
- `PUT /api/audio/:id` - Update audio file metadata
- `DELETE /api/audio/:id` - Delete audio file

### Cues
- `GET /api/cues` - Get all cues
- `POST /api/cues` - Create new cue
- `GET /api/cues/:id` - Get cue by ID
- `PUT /api/cues/:id` - Update cue
- `DELETE /api/cues/:id` - Delete cue
- `POST /api/cues/:id/trigger` - Trigger cue
- `POST /api/cues/:id/stop` - Stop cue
- `POST /api/cues/stop-all` - Stop all cues

### Workspaces
- `GET /api/workspaces` - Get all workspaces
- `POST /api/workspaces` - Create new workspace
- `GET /api/workspaces/current` - Get current workspace
- `POST /api/workspaces/:id/load` - Load workspace
- `POST /api/workspaces/save` - Save current workspace

### Remote Control
- `GET /api/remote/cues` - Get cues for remote control
- `POST /api/remote/cues/:id/trigger` - Trigger cue via remote
- `POST /api/remote/cues/stop-all` - Stop all cues via remote
- `GET /api/remote/status` - Get playback status
- `GET /api/remote/info` - Get server info

## 🔌 WebSocket Events

The server provides real-time updates via WebSocket:

### Client → Server
- `trigger_cue` - Trigger a cue
- `stop_cue` - Stop a cue
- `stop_all_cues` - Stop all cues
- `playlist_navigate` - Navigate playlist
- `update_cue` - Update cue properties
- `delete_cue` - Delete a cue
- `create_cue` - Create a new cue

### Server → Client
- `cues_update` - Cue list updated
- `cue_status` - Cue status changed
- `cue_update` - Cue properties updated
- `playback_time` - Playback time update
- `config_update` - Configuration updated
- `workspace_update` - Workspace updated

## 🎵 Features

### ✅ Implemented
- **File System Management**: Organized audio file storage
- **Cue Management**: Create, update, delete cues
- **Workspace Management**: Save/load cue layouts
- **WebSocket Communication**: Real-time updates
- **HTTP API**: RESTful API for all operations
- **Remote Control**: HTTP endpoints for remote access
- **Configuration Management**: Persistent settings
- **Audio File Import**: Drag & drop and file upload
- **Web Interface**: Browser-based UI for testing

### 🚧 In Progress
- **Audio Playback**: Browser-based audio playback
- **Waveform Generation**: Visual waveform display
- **Electron Launcher**: System tray integration

### 📋 Planned
- **Companion Integration**: Bitfocus Companion support
- **Advanced Audio Features**: Crossfading, ducking
- **File Organization**: Advanced file management
- **Backup & Sync**: Workspace backup and sync

## 🛠️ Development

### Running in Development Mode
```bash
node start-nodejs.js --dev
```

### Using nodemon for auto-restart
```bash
npm run dev
```

### Command Line Options
```bash
node start-nodejs.js --port=8080 --host=0.0.0.0 --dev
```

## 🔧 Configuration Options

Key configuration options in `appConfig.json`:

```json
{
  "httpRemotePort": 3000,
  "websocketPort": 8877,
  "audioDirectory": "~/.accompaniment/audio",
  "cuesDirectory": "~/.accompaniment/cues",
  "defaultFadeInTime": 0,
  "defaultFadeOutTime": 0,
  "crossfadeTime": 2000,
  "supportedAudioFormats": [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]
}
```

## 🌐 Network Access

The server binds to `0.0.0.0` by default, making it accessible from other devices on the network:

- **Local**: `http://localhost:3000`
- **Network**: `http://[your-ip]:3000`

Use the `/api/config/network` endpoint to get all available network interfaces.

## 🔒 Security Notes

- The server is designed for local network use
- No authentication is implemented (planned for future)
- File uploads are limited to 100MB by default
- Only supported audio formats are accepted

## 🐛 Troubleshooting

### Port Already in Use
```bash
node start-nodejs.js --port=3001
```

### Permission Issues
Ensure the data directory is writable:
```bash
chmod 755 ~/.accompaniment
```

### Audio File Issues
Check supported formats and file size limits in configuration.

## 📝 Logs

The server logs to console with different levels:
- `🚀` - Server startup
- `📁` - File operations
- `🎵` - Audio/cue operations
- `🔌` - WebSocket operations
- `❌` - Errors
- `✅` - Success operations

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.
