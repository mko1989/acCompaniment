# acCompaniment Investigation Findings

## Project Architecture
- **Hybrid Node.js + Electron**: Backend runs Node.js server, frontend is browser-based, optional Electron launcher
- **Audio Engine**: Howler.js for playback, Web Audio API for advanced features
- **Communication**: WebSocket for real-time updates, IPC for Electron integration
- **UI**: Modular JavaScript classes with DOM manipulation

## Issue Analysis

### 1. Cue Fade Out Issue
**Problem**: Cues stop after retrigger but don't fade properly
**Root Cause**: 
- `audioPlaybackToggle.js:126` calls `stop(cueIdToToggle, true, fromCompanion, true, null, context)` for `fade_out_and_stop` behavior
- `audioPlaybackCore.js:490` sets `playingState.acIsStoppingWithFade = useFade && fadeOutTime > 0`
- **Issue**: `fadeOutTime` calculation may be 0 if cue has no `fadeOutTime` and config `defaultFadeOutTime` is 0
- **Fix**: Ensure default fade out time is > 0 or handle 0 fade time gracefully

### 2. Visual Feedback Problems  
**Problem**: Cues turn green but stay green instead of changing to red when fading
**Root Cause**:
- `cueGrid.js:253-290` handles crossfade text display but may not update visual states properly
- `updateButtonPlayingState()` function has complex logic for fade states
- **Issue**: Visual state updates may not be triggered during fade transitions
- **Fix**: Ensure `updateButtonPlayingState()` is called with proper fade state parameters

### 3. Timer Display Issues
**Problem**: Cue timers don't populate on page reload and don't run during playback
**Root Cause**:
- `playbackTimeManager.js:13-144` creates time update intervals
- `createTimeUpdateInterval()` is called from `playbackEventHandlersCore.js` on play events
- **Issue**: Intervals may not be created on page reload if cues are already playing
- **Fix**: Initialize timers for existing playing cues on page load

### 4. Waveform Display Problem
**Problem**: Shows "Waveform will be loaded here" instead of actual waveform
**Root Cause**:
- `waveformCore.js:639-656` handles waveform initialization
- `showWaveformForCue()` checks for `cue.filePath` and calls `initializeWaveform()`
- **Issue**: Waveform initialization may fail silently or DOM elements not found
- **Fix**: Check DOM element existence and add error handling for waveform loading

### 5. App Properties Sidebar Issue
**Problem**: Cannot open app properties sidebar
**Root Cause**:
- `configSidebar.js:14-32` handles sidebar toggle
- Delegates to `sidebarsModule.toggleConfigSidebar()` or falls back to direct DOM manipulation
- **Issue**: `window.uiModules?.sidebars` may not be available or `toggleConfigSidebar()` not implemented
- **Fix**: Ensure sidebars module is properly initialized and exported

### 6. WebSocket Message Error
**Problem**: Unknown WebSocket message: 'cue_stopped'
**Root Cause**:
- `audioController.js:93-149` handles WebSocket messages
- `cue_stopped` message type not handled in switch statement
- **Issue**: Backend sends `cue_stopped` but frontend doesn't recognize it
- **Fix**: Add `cue_stopped` case to WebSocket message handler

## Implementation Priority
1. **High**: Fix fade out functionality (core audio behavior)
2. **High**: Fix WebSocket message handling (communication)
3. **Medium**: Fix visual feedback (user experience)
4. **Medium**: Fix timer initialization (user experience)
5. **Low**: Fix waveform display (editing feature)
6. **Low**: Fix app properties sidebar (configuration)

## Key Files to Modify
- `src/renderer/audioPlaybackCore.js` - Fix fade out time calculation
- `src/frontend/audio/audioController.js` - Add cue_stopped message handling
- `src/renderer/ui/cueGrid.js` - Fix visual state updates
- `src/renderer/playbackTimeManager.js` - Fix timer initialization
- `src/frontend/ui/waveformCore.js` - Fix waveform loading
- `src/frontend/ui/sidebars.js` - Fix config sidebar toggle

## Testing Strategy
1. Test fade out with different retrigger behaviors
2. Verify WebSocket message handling
3. Check visual states during playback transitions
4. Test timer updates on page reload
5. Verify waveform loading in properties sidebar
6. Test config sidebar toggle functionality
