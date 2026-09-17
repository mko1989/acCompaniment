# Audio Playback Options for acCompaniment

This document outlines the different audio playback options available in acCompaniment and how to configure them.

## Playback Modes

### 1. Client-Side Playback (Browser)
- **Description**: Audio is played directly in the browser using Web Audio API
- **Advantages**: 
  - Low latency
  - No server audio processing overhead
  - Works with any audio device connected to the client
- **Disadvantages**:
  - Limited to browser audio capabilities
  - May have audio quality limitations
  - Requires user interaction to start audio context

### 2. Server-Side Playback (Node.js)
- **Description**: Audio is played on the server and streamed to clients
- **Advantages**:
  - Consistent audio quality across all clients
  - Better audio processing capabilities
  - Can use professional audio interfaces
- **Disadvantages**:
  - Higher latency
  - Requires server audio setup
  - More complex configuration

## Configuration Options

### Audio Device Selection
The application supports selecting different audio output devices:

1. **Default Audio Device**: Uses the system default
2. **Specific Audio Device**: Choose from available audio interfaces
3. **Custom Audio Device**: Specify custom audio device parameters

### Playback Configuration

#### Client-Side Configuration
```javascript
{
  "playbackMode": "client",
  "audioDevice": "default",
  "sampleRate": 44100,
  "bufferSize": 4096,
  "enableAudioContext": true
}
```

#### Server-Side Configuration
```javascript
{
  "playbackMode": "server",
  "audioDevice": "professional_interface",
  "sampleRate": 48000,
  "bufferSize": 1024,
  "enableAudioProcessing": true,
  "audioLatency": 50
}
```

## Implementation Details

### Client-Side Audio Manager
- Uses Web Audio API for playback
- Handles audio context management
- Supports fade in/out effects
- Manages multiple simultaneous audio streams

### Server-Side Audio Manager
- Uses Node.js audio libraries (e.g., node-speaker, alsa)
- Handles audio device management
- Supports professional audio interfaces
- Streams audio to clients via WebSocket

## Setup Instructions

### For Client-Side Playback
1. Ensure browser supports Web Audio API
2. Configure audio device in browser settings
3. Enable audio context on user interaction
4. Test audio playback functionality

### For Server-Side Playback
1. Install required audio libraries on server
2. Configure audio device permissions
3. Set up audio streaming infrastructure
4. Configure client connections

## Troubleshooting

### Common Issues
1. **No Audio Output**: Check audio device selection and permissions
2. **High Latency**: Adjust buffer sizes and audio processing settings
3. **Audio Quality Issues**: Verify sample rate and bit depth settings
4. **Device Not Found**: Ensure audio device is properly connected and recognized

### Debugging Steps
1. Check browser console for audio context errors
2. Verify audio device availability
3. Test with different audio formats
4. Check network connectivity for server-side playback

## Future Enhancements

1. **Hybrid Playback**: Combine client and server-side capabilities
2. **Audio Processing**: Add real-time audio effects
3. **Multi-Channel Support**: Support for surround sound and multi-channel audio
4. **Audio Synchronization**: Precise timing across multiple clients
5. **Audio Recording**: Capture and save audio output
