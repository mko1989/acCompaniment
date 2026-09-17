const { v4: uuidv4 } = require('uuid');
const AudioPlaybackManager = require('./audioPlaybackManager');

class CueManager {
    constructor(audioFileManager, cueDataManager, websocketManager) {
        this.audioFileManager = audioFileManager;
        this.cueDataManager = cueDataManager;
        this.websocketManager = websocketManager;
        
        this.playingCues = new Map(); // cueId -> playback info
        this.cueStates = new Map(); // cueId -> state info
        this.audioPlaybackManager = new AudioPlaybackManager();
        
        this.config = null;
        this._saveDebounceTimer = null;
        this._saveDebounceMs = 300;
    }
    
    async initialize() {
        console.log('CueManager: Initializing...');
        
        await this.cueDataManager.cleanupOrphanWorkspaceFiles();
        
        const workspaces = await this.cueDataManager.getAllWorkspaces();
        if (workspaces.length > 0) {
            await this.cueDataManager.loadWorkspace(workspaces[0].id);
            console.log(`CueManager: Loaded workspace: ${workspaces[0].name}`);
        } else {
            await this.cueDataManager.createWorkspace('Default Workspace');
            console.log('CueManager: Created default workspace');
        }

        await this.audioPlaybackManager.init(this._audioEngineConfig());
        
        // Set up playback end callback
        this.audioPlaybackManager.setPlaybackEndCallback((cueId) => {
            this.handlePlaybackEnd(cueId);
        });

        // Surface native audio-engine errors (e.g. output device removed
        // mid-show) to connected clients instead of playback silently
        // stopping with nothing visible in the UI.
        this.audioPlaybackManager.setEngineErrorCallback((error) => {
            this.websocketManager?.broadcast({
                type: 'audio-engine-error',
                payload: error,
            });
        });

        this._startPlaybackTimeBroadcast();
        
        console.log('CueManager: Initialized successfully');
    }

    _audioEngineConfig() {
        const config = this.config || {};
        return {
            audioOutputDeviceId: config.audioOutputDeviceId ?? 'default',
            audioOutputChannelCount: config.audioOutputChannelCount ?? 2,
            audioSampleRate: config.audioSampleRate ?? 48000,
            audioBufferSize: config.audioBufferSize ?? 512,
            pcmCacheDir: this.cueDataManager?.pathManager?.pcmCacheDir ?? null,
        };
    }

    _formatTimeMMSS(seconds) {
        const sec = Math.max(0, Math.floor(seconds || 0));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    _startPlaybackTimeBroadcast() {
        if (this._playbackTimeInterval) {
            clearInterval(this._playbackTimeInterval);
        }

        this._playbackTimeInterval = setInterval(() => {
            if (!this.audioPlaybackManager?.isInitialized) {
                return;
            }

            const status = this.audioPlaybackManager.getPlaybackStatus();
            const playing = status.mixer?.playing || [];

            for (const entry of playing) {
                const cue = this.getCue(entry.cueId);
                const totalTime = entry.trimEndSec - entry.trimStartSec;
                const currentTime = Math.max(0, entry.positionSec - entry.trimStartSec);
                const remaining = Math.max(0, totalTime - currentTime);
                const playbackStatus = entry.isPaused ? 'paused' : 'playing';

                this.websocketManager.broadcast({
                    type: 'playback-time-update',
                    payload: {
                        cueId: entry.cueId,
                        cueName: cue?.name || '',
                        currentTimeSec: currentTime,
                        totalDurationSec: totalTime,
                        remainingTimeSec: remaining,
                        currentTimeFormatted: this._formatTimeMMSS(currentTime),
                        totalDurationFormatted: this._formatTimeMMSS(totalTime),
                        remainingTimeFormatted: this._formatTimeMMSS(remaining),
                        status: playbackStatus,
                    },
                });
            }
        }, 100);
    }
    
    // Get current configuration
    getConfig() {
        return this.config;
    }
    
    // Set configuration
    setConfig(config) {
        this.config = config;
    }

    async applyAudioEngineConfig() {
        if (!this.audioPlaybackManager) {
            return { success: false, error: 'Audio engine not available' };
        }

        const result = await this.audioPlaybackManager.applyAudioConfig(this._audioEngineConfig());
        if (this.config?.audioSampleRate) {
            this.audioFileManager?.setPcmSampleRate(this.config.audioSampleRate);
        }
        return result;
    }

    _schedulePersistWorkspace() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
        }
        this._saveDebounceTimer = setTimeout(async () => {
            this._saveDebounceTimer = null;
            const result = await this.saveWorkspace();
            if (!result.success) {
                console.warn(`CueManager: Debounced workspace save failed: ${result.error}`);
            }
        }, this._saveDebounceMs);
    }

    async flushPersistWorkspace() {
        return this._flushPersistWorkspace();
    }

    async _flushPersistWorkspace() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
            this._saveDebounceTimer = null;
        }
        return await this.saveWorkspace();
    }
    
    // Get all cues
    getCues() {
        return this.cueDataManager.getCues().map((cue) => this._mergeLiveState(cue));
    }

    // Get cue by ID
    getCue(cueId) {
        const cue = this.cueDataManager.getCue(cueId);
        return cue ? this._mergeLiveState(cue) : cue;
    }

    // Playback status (playing/paused/stopped, currentTime, totalTime) is
    // tracked in the in-memory this.cueStates map, not persisted to disk
    // (it's ephemeral runtime state, not cue configuration, and shouldn't
    // survive a restart or cost a disk write on every play/pause/stop).
    // cueDataManager's stored record only ever has the status it was
    // created/last-saved with. Without this merge, every REST read
    // (GET /api/cues, /api/cues/:id, /api/remote/cues) would return a
    // permanently stale status - WebSocket broadcasts are the only thing
    // that would ever reflect live state.
    _mergeLiveState(cue) {
        const liveState = this.cueStates.get(cue.id);
        if (!liveState) {
            return cue;
        }
        return {
            ...cue,
            status: liveState.status,
            currentTime: liveState.currentTime ?? cue.currentTime,
            totalTime: liveState.totalTime ?? cue.totalTime,
        };
    }

    // Create new cue
    async createCue(cueData) {
        try {
            // If it's a single file cue with audioFileId, fetch the duration
            if (cueData.type === 'single_file' && cueData.audioFileId) {
                try {
                    const audioFile = await this.audioFileManager.loadAudioFileMetadata(cueData.audioFileId);
                    if (audioFile && audioFile.duration) {
                        cueData.knownDuration = audioFile.duration;
                        console.log(`CueManager: Set duration for cue ${cueData.name}: ${audioFile.duration}s`);
                    }
                } catch (error) {
                    console.warn(`⚠️ CueManager: Could not fetch duration for audio file ${cueData.audioFileId}: ${error.message}`);
                }
            }
            
            // If it's a playlist cue, fetch durations for all items
            if (cueData.type === 'playlist' && cueData.playlistItems) {
                for (const item of cueData.playlistItems) {
                    if (item.audioFileId) {
                        try {
                            const audioFile = await this.audioFileManager.loadAudioFileMetadata(item.audioFileId);
                            if (audioFile && audioFile.duration) {
                                item.knownDuration = audioFile.duration;
                                console.log(`CueManager: Set duration for playlist item ${item.name}: ${audioFile.duration}s`);
                            }
                        } catch (error) {
                            console.warn(`⚠️ CueManager: Could not fetch duration for playlist item ${item.audioFileId}: ${error.message}`);
                        }
                    }
                }
            }
            
            const cue = this.cueDataManager.createCue(cueData);
            this.cueDataManager.addCue(cue);
            
            // Broadcast update
            await this.websocketManager.broadcastCuesUpdate(this.getCues());
            
            console.log(`CueManager: Created cue: ${cue.name} (${cue.id})`);
            this._schedulePersistWorkspace();
            return { success: true, cue: cue };
            
        } catch (error) {
            console.error(`CueManager: Error creating cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Update cue
    async updateCue(cueId, updates) {
        try {
            const result = this.cueDataManager.updateCue(cueId, updates);
            
            if (result.success) {
                // Broadcast update
                this.websocketManager.broadcastCueUpdate(cueId, updates);
                await this.websocketManager.broadcastCuesUpdate(this.getCues());
                
                console.log(`📝 CueManager: Updated cue: ${cueId}`);
                this._schedulePersistWorkspace();
            }
            
            return result;
            
        } catch (error) {
            console.error(`CueManager: Error updating cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Delete cue
    async deleteCue(cueId) {
        try {
            // Stop cue if playing
            await this.stopCue(cueId);
            
            const result = this.cueDataManager.deleteCue(cueId);
            
            if (result.success) {
                // Clean up state
                this.playingCues.delete(cueId);
                this.cueStates.delete(cueId);
                
                // Broadcast update
                await this.websocketManager.broadcastCuesUpdate(this.getCues());
                
                console.log(`CueManager: Deleted cue: ${cueId}`);
                this._schedulePersistWorkspace();
            }
            
            return result;
            
        } catch (error) {
            console.error(`CueManager: Error deleting cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Trigger cue (play/restart)
    async triggerCue(cueId, options = {}) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }
            
            // Handle retrigger behavior
            const currentState = this.cueStates.get(cueId);
            if (currentState && currentState.status === 'playing') {
                return await this.handleRetriggerBehavior(cue, options);
            }
            
            // Start playing the cue
            const playbackInfo = await this.startCuePlayback(cue, options);
            
            if (playbackInfo.success) {
                this.playingCues.set(cueId, playbackInfo);
                this.cueStates.set(cueId, {
                    status: 'playing',
                    startTime: Date.now(),
                    currentTime: 0,
                    totalTime: cue.totalTime || 0
                });
                
                // Broadcast status update
                this.websocketManager.broadcastCueStatus(cueId, 'playing', {
                    currentTime: 0,
                    totalTime: cue.totalTime || 0
                });
                
                console.log(`CueManager: Started cue: ${cue.name} (${cueId})`);
            }
            
            return playbackInfo;
            
        } catch (error) {
            console.error(`CueManager: Error triggering cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Stop cue
    async stopCue(cueId, fadeOut = false) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }
            
            const playbackInfo = this.playingCues.get(cueId);
            if (!playbackInfo) {
                return { success: true }; // Already stopped
            }
            
            // Stop playback
            await this.stopCuePlayback(cueId, fadeOut ? cue.fadeOutTime : 0);
            
            // Update state
            this.playingCues.delete(cueId);
            this.cueStates.set(cueId, {
                status: 'stopped',
                currentTime: 0,
                totalTime: 0
            });
            
            // Broadcast status update
            this.websocketManager.broadcastCueStatus(cueId, 'stopped');
            
            console.log(`CueManager: Stopped cue: ${cue.name} (${cueId})`);
            return { success: true };
            
        } catch (error) {
            console.error(`CueManager: Error stopping cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Stop all cues
    async stopAllCues(behavior = 'stop') {
        try {
            const fadeOut = behavior === 'fade_out_and_stop';
            
            // Use the audio playback manager to stop all cues
            const result = await this.audioPlaybackManager.stopAllCues(fadeOut);
            
            if (result.success) {
                // Clear local state
                this.playingCues.clear();
                this.cueStates.clear();
                
                // Broadcast status updates for all stopped cues
                for (const { cueId } of result.results) {
                    this.websocketManager.broadcastCueStatus(cueId, 'stopped');
                }
                
                console.log(`CueManager: Stopped ${result.results.length} cues`);
            }
            
            return result;
            
        } catch (error) {
            console.error(`CueManager: Error stopping all cues: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Navigate playlist
    async navigatePlaylist(cueId, direction) {
        try {
            const cue = this.getCue(cueId);
            if (!cue || cue.type !== 'playlist') {
                return { success: false, error: 'Cue not found or not a playlist' };
            }
            
            const currentIndex = cue.currentPlaylistIndex || 0;
            let newIndex = currentIndex;
            
            if (direction === 'next') {
                newIndex = Math.min(currentIndex + 1, cue.playlistItems.length - 1);
            } else if (direction === 'previous') {
                newIndex = Math.max(currentIndex - 1, 0);
            }
            
            if (newIndex !== currentIndex) {
                await this.updateCue(cueId, { currentPlaylistIndex: newIndex });
                
                // If cue is playing, restart with new item
                if (this.cueStates.get(cueId)?.status === 'playing') {
                    await this.stopCue(cueId);
                    await this.triggerCue(cueId);
                }
                
                console.log(`CueManager: Navigated playlist ${direction}: ${cue.name} (${cueId})`);
            }
            
            return { success: true, newIndex: newIndex };
            
        } catch (error) {
            console.error(`CueManager: Error navigating playlist: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Toggle cue (main toggle method)
    async toggleCue(cueId, options = {}) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }
            
            // Check if cue is currently playing
            const currentState = this.cueStates.get(cueId);
            const isCurrentlyPlaying = currentState && currentState.status === 'playing';
            
            if (isCurrentlyPlaying) {
                // Cue is playing, handle retrigger behavior
                const retriggerBehavior = options.retriggerBehavior || cue.retriggerBehavior || 'restart';
                return await this.handleRetriggerBehavior(cue, { retriggerBehavior, ...options });
            } else {
                // Cue is not playing, start it
                return await this.triggerCue(cueId, options);
            }
            
        } catch (error) {
            console.error(`CueManager: Error toggling cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Handle retrigger behavior
    async handleRetriggerBehavior(cue, options) {
        const retriggerBehavior = options.retriggerBehavior || cue.retriggerBehavior || 'restart';
        
        switch (retriggerBehavior) {
            case 'restart':
                await this.stopCue(cue.id);
                return await this.triggerCue(cue.id, options);
                
            case 'pause_resume':
                return await this.togglePauseCue(cue.id);
                
            case 'stop':
                return await this.stopCue(cue.id);
                
            case 'fade_out_and_stop':
                return await this.stopCue(cue.id, true);
                
            case 'do_nothing':
                return { success: true, message: 'Cue already playing' };
                
            case 'play_new_instance':
                // Full polyphonic multi-instance playback isn't implemented
                // (the mixer keys active playback by cue ID, one slot per
                // cue). Rather than surface an error to the operator
                // mid-show for choosing this retrigger option, degrade
                // gracefully to a normal restart.
                console.warn('CueManager: play_new_instance not implemented - falling back to restart');
                await this.stopCue(cue.id);
                return await this.triggerCue(cue.id, options);
                
            default:
                return await this.triggerCue(cue.id, options);
        }
    }
    
    // Toggle pause/resume cue
    async togglePauseCue(cueId) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }
            
            const state = this.cueStates.get(cueId);
            if (!state) {
                return { success: false, error: 'Cue not playing' };
            }

            const audioResult = await this.audioPlaybackManager.togglePauseCue(cueId);
            if (!audioResult.success) {
                return audioResult;
            }
            
            state.status = audioResult.status;
            if (audioResult.status === 'paused') {
                state.pausedAt = Date.now();
                this.websocketManager.broadcastCueStatus(cueId, 'paused');
                console.log(`CueManager: Paused cue: ${cue.name} (${cueId})`);
            } else if (audioResult.status === 'playing') {
                state.resumedAt = Date.now();
                this.websocketManager.broadcastCueStatus(cueId, 'playing');
                console.log(`CueManager: Resumed cue: ${cue.name} (${cueId})`);
            }
            
            return { success: true, status: state.status };
            
        } catch (error) {
            console.error(`CueManager: Error toggling pause: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Start cue playback
    async startCuePlayback(cue, options) {
        try {
            let filePath = null;
            let audioFile = null;
            
            // For single file cues, we need to get the audio file info
            if (cue.type === 'single_file' && cue.relativePath) {
                // Find the audio file in the audio manager
                audioFile = await this.audioFileManager.getAudioFileByPath(cue.relativePath);
                if (audioFile) {
                    filePath = audioFile.path;
                }
            }
            
            // For playlist cues, handle the current item
            if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                const currentItem = cue.playlistItems[cue.currentPlaylistIndex || 0];
                if (currentItem) {
                    audioFile = await this.audioFileManager.getAudioFileByPath(currentItem.relativePath);
                    if (audioFile) {
                        filePath = audioFile.path;
                    }
                }
            }
            
            if (!filePath) {
                return { success: false, error: 'Audio file not found' };
            }
            
            // Prepare playback options
            const playbackOptions = {
                volume: cue.volume || 1.0,
                fadeInTime: (cue.fadeInTime || 0) / 1000, // Convert to seconds
                fadeOutTime: (cue.fadeOutTime || 0) / 1000, // Convert to seconds
                trimStartTime: cue.trimStartTime || 0,
                trimEndTime: cue.trimEndTime || null,
                loop: cue.loop || false,
                outputPatch: cue.outputPatch,
            };
            
            // Use the audio playback manager to actually play the audio
            const result = await this.audioPlaybackManager.playCue(cue.id, filePath, playbackOptions);
            
            if (result.success) {
                const playbackInfo = {
                    cueId: cue.id,
                    startTime: Date.now(),
                    duration: audioFile?.duration || 0,
                    volume: cue.volume || 1.0,
                    fadeInTime: cue.fadeInTime || 0,
                    fadeOutTime: cue.fadeOutTime || 0,
                    source: options.source || 'unknown',
                    audioFileId: audioFile?.id,
                    filePath: filePath
                };
                
                return { success: true, playbackInfo: playbackInfo };
            } else {
                return result;
            }
            
        } catch (error) {
            console.error(`CueManager: Error starting playback: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Stop cue playback
    async stopCuePlayback(cueId, fadeOutTime = 0) {
        try {
            // Use the audio playback manager to actually stop the audio
            const result = await this.audioPlaybackManager.stopCue(cueId, fadeOutTime > 0);
            
            if (result.success) {
                // Remove from playing cues
                this.playingCues.delete(cueId);
                this.cueStates.delete(cueId);
                
                // Broadcast status update
                this.websocketManager.broadcastCueStatus(cueId, 'stopped');
                
                console.log(`CueManager: Stopped cue: ${cueId}`);
            }
            
            return result;
            
        } catch (error) {
            console.error(`CueManager: Error stopping playback: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Handle cue playback completion
    async handleCuePlaybackComplete(cueId) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) return;
            
            // Update state
            this.playingCues.delete(cueId);
            this.cueStates.set(cueId, {
                status: 'completed',
                currentTime: cue.totalTime || 0,
                totalTime: cue.totalTime || 0,
                completedAt: Date.now()
            });
            
            // Broadcast completion
            this.websocketManager.broadcastCueStatus(cueId, 'completed');
            
            // Handle playlist advance
            if (cue.type === 'playlist' && cue.playlistPlayMode === 'continue') {
                await this.navigatePlaylist(cueId, 'next');
            }
            
            console.log(`CueManager: Cue completed: ${cue.name} (${cueId})`);
            
        } catch (error) {
            console.error(`CueManager: Error handling completion: ${error.message}`);
        }
    }
    
    // Get current workspace
    getCurrentWorkspace() {
        return this.cueDataManager.getCurrentWorkspace();
    }
    
    // Save current workspace
    async saveWorkspace(name = null, description = null) {
        return await this.cueDataManager.saveWorkspace(name, description);
    }
    
    // Load workspace
    async loadWorkspace(workspaceId) {
        const result = await this.cueDataManager.loadWorkspace(workspaceId);
        
        if (result.success) {
            // Stop all currently playing cues
            await this.stopAllCues();
            
            // Broadcast workspace update
            this.websocketManager.broadcastWorkspaceUpdate(result.workspace);
            await this.websocketManager.broadcastCuesUpdate(this.getCues());
        }
        
        return result;
    }
    
    // Handle playback end (called by AudioPlaybackManager)
    handlePlaybackEnd(cueId) {
        this.handleCuePlaybackComplete(cueId).catch((error) => {
            console.error(`CueManager: Error handling playback end for cue ${cueId}:`, error);
        });
    }
    
    // Get playback status
    getPlaybackStatus() {
        const status = {
            playingCues: Array.from(this.playingCues.keys()),
            totalPlaying: this.playingCues.size,
            cueStates: Object.fromEntries(this.cueStates),
            masterVolume: this.audioPlaybackManager?.getMasterVolume() ?? 1.0
        };

        return status;
    }

    // Master volume (0-2, applied as a gain multiplier over every cue's own
    // volume in the mixer). Not persisted - like a physical fader, it's
    // live session state, not a saved preference.
    setMasterVolume(volume) {
        if (typeof volume !== 'number' || Number.isNaN(volume)) {
            return { success: false, error: 'volume must be a number' };
        }
        this.audioPlaybackManager.setMasterVolume(volume);
        const applied = this.audioPlaybackManager.getMasterVolume();
        this.websocketManager?.broadcast({
            type: 'master-volume-updated',
            payload: { volume: applied }
        });
        return { success: true, volume: applied };
    }

    getMasterVolume() {
        return this.audioPlaybackManager?.getMasterVolume() ?? 1.0;
    }
    
    // Cleanup
    async cleanup() {
        try {
            // Stop all playing cues
            await this.stopAllCues();

            if (this.audioPlaybackManager) {
                await this.audioPlaybackManager.cleanup();
            }

            if (this._playbackTimeInterval) {
                clearInterval(this._playbackTimeInterval);
                this._playbackTimeInterval = null;
            }
            
            // Save current workspace (flush any pending debounced save)
            await this._flushPersistWorkspace();
            
            console.log('CueManager: Cleanup completed');
            
        } catch (error) {
            console.error(`CueManager: Error during cleanup: ${error.message}`);
        }
    }
}

module.exports = CueManager;
