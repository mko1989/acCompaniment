/**
 * Browser-based Audio Manager for acCompaniment
 * 
 * This module handles audio playback in the browser environment using Web Audio API
 * and provides compatibility with the existing cue system.
 */

class BrowserLruCache {
    constructor({ maxEntries = 30, maxBytes = 256 * 1024 * 1024 } = {}) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.cache = new Map();
        this.totalBytes = 0;
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const entry = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key, value, byteSize = 0) {
        if (this.cache.has(key)) {
            this.totalBytes -= this.cache.get(key).byteSize;
            this.cache.delete(key);
        }
        this.cache.set(key, { value, byteSize });
        this.totalBytes += byteSize;
        while (
            (this.maxEntries > 0 && this.cache.size > this.maxEntries)
            || (this.maxBytes > 0 && this.totalBytes > this.maxBytes)
        ) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey === undefined) break;
            this.totalBytes -= this.cache.get(oldestKey).byteSize;
            this.cache.delete(oldestKey);
        }
    }

    clear() {
        this.cache.clear();
        this.totalBytes = 0;
    }

    get size() {
        return this.cache.size;
    }

    has(key) {
        return this.cache.has(key);
    }
}

function estimateBrowserBufferBytes(audioBuffer) {
    if (!audioBuffer) return 0;
    return audioBuffer.length * audioBuffer.numberOfChannels * 4;
}

class AudioManager {
    constructor() {
        this.audioContext = null;
        this.audioBuffers = new BrowserLruCache();
        this.playingSounds = new Map(); // Currently playing sounds
        this.masterGain = null;
        this.isInitialized = false;
        this.onPlaybackEnd = null; // Callback for playback end events
        
        // Simple event emitter
        this.events = new Map();
        
        // Audio settings
        this.settings = {
            masterVolume: 1.0,
            crossfadeTime: 2000,
            fadeInTime: 0,
            fadeOutTime: 0
        };
        
        this.init();
    }
    
    // Simple event emitter methods
    on(event, callback) {
        if (!this.events.has(event)) {
            this.events.set(event, []);
        }
        this.events.get(event).push(callback);
    }
    
    emit(event, data) {
        if (this.events.has(event)) {
            this.events.get(event).forEach(callback => callback(data));
        }
    }
    
    async init() {
        try {
            // Create audio context
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContext();
            
            // Create master gain node
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            this.masterGain.gain.value = this.settings.masterVolume;
            
            this.isInitialized = true;
            console.log('AudioManager: Initialized successfully');
            
            // Handle audio context suspension (browser autoplay policy)
            if (this.audioContext.state === 'suspended') {
                console.log('AudioManager: Audio context suspended, waiting for user interaction');
            }
            
        } catch (error) {
            console.error('AudioManager: Failed to initialize:', error);
            throw error;
        }
    }
    
    // Ensure audio context is running (required for autoplay policy)
    async ensureAudioContextRunning() {
        if (!this.audioContext) {
            await this.init();
        }
        
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
            console.log('AudioManager: Audio context resumed');
        }
    }
    
    // Load audio file from URL
    async loadAudioFile(audioFileId, url) {
        try {
            if (this.audioBuffers.has(audioFileId)) {
                return this.audioBuffers.get(audioFileId);
            }
            
            console.log(`AudioManager: Loading audio file: ${audioFileId}`);
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to load audio file: ${response.statusText}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            
            this.audioBuffers.set(
                audioFileId,
                audioBuffer,
                estimateBrowserBufferBytes(audioBuffer)
            );
            console.log(`AudioManager: Audio file loaded: ${audioFileId}`);
            
            return audioBuffer;
            
        } catch (error) {
            console.error(`AudioManager: Error loading audio file ${audioFileId}:`, error);
            throw error;
        }
    }
    
    // Play audio cue
    async playCue(cueId, audioFileId, options = {}) {
        try {
            await this.ensureAudioContextRunning();
            
            // Stop existing playback if retrigger behavior requires it
            if (this.playingSounds.has(cueId)) {
                console.log(`AudioManager: Stopping existing playback for cue ${cueId} before starting new playback`);
                await this.stopCue(cueId, false);
                // Wait a bit to ensure cleanup is complete
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            // Load audio buffer if not cached
            const audioBuffer = await this.loadAudioFile(audioFileId, `/api/audio/serve/${audioFileId}`);
            
            // Create audio source
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            
            // Create gain node for volume control
            const gainNode = this.audioContext.createGain();
            
            // Connect audio graph
            source.connect(gainNode);
            gainNode.connect(this.masterGain);
            
            // Set initial volume
            gainNode.gain.value = options.volume || 1.0;
            
            // Handle trim start/end
            const startTime = options.trimStartTime || 0;
            const endTime = options.trimEndTime || audioBuffer.duration;
            const duration = endTime - startTime;
            
            // Store playback info first
            const playbackInfo = {
                cueId: cueId,
                source: source,
                gainNode: gainNode,
                startTime: this.audioContext.currentTime,
                duration: duration,
                volume: options.volume || 1.0,
                fadeInTime: options.fadeInTime || 0,
                fadeOutTime: options.fadeOutTime || 0,
                loop: options.loop || false,
                isFadingIn: false,
                isFadingOut: false,
                fadeInStartTime: null,
                fadeInDuration: 0,
                fadeStartTime: null,
                fadeDuration: 0
            };
            
            // Handle fade in
            if (options.fadeInTime > 0) {
                gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(
                    options.volume || 1.0,
                    this.audioContext.currentTime + options.fadeInTime
                );
                
                // Mark as fading in
                playbackInfo.isFadingIn = true;
                playbackInfo.fadeInStartTime = Date.now();
                playbackInfo.fadeInDuration = options.fadeInTime;
                
                // Clear fade in state after fade completes
                setTimeout(() => {
                    playbackInfo.isFadingIn = false;
                }, options.fadeInTime);
            }
            
            // Start playback
            source.start(0, startTime, duration);
            
            this.playingSounds.set(cueId, playbackInfo);
            
            // Handle loop
            if (options.loop) {
                source.loop = true;
                source.loopStart = startTime;
                source.loopEnd = endTime;
            }
            
            // Handle playback end
            source.onended = () => {
                this.handlePlaybackEnd(cueId);
            };
            
            console.log(`AudioManager: Started playback for cue ${cueId}`);
            
            return {
                success: true,
                playbackInfo: playbackInfo
            };
            
        } catch (error) {
            console.error(`AudioManager: Error playing cue ${cueId}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Stop audio cue
    async stopCue(cueId, fadeOut = false, fadeOutTimeMs = 0) {
        try {
            const playbackInfo = this.playingSounds.get(cueId);
            if (!playbackInfo) {
                console.log(`AudioManager: Cue ${cueId} not found in playing sounds, already stopped`);
                return { success: true }; // Already stopped
            }
            
            const { source, gainNode } = playbackInfo;
            
            // Use provided fadeOutTimeMs or fall back to playback info fadeOutTime
            const actualFadeOutTime = fadeOutTimeMs > 0 ? fadeOutTimeMs : (playbackInfo.fadeOutTime || 0);
            
            console.log(`AudioManager: Stopping cue ${cueId}, fadeOut: ${fadeOut}, fadeOutTime: ${actualFadeOutTime}ms`);
            
            // Remove from playing sounds immediately to prevent multiple stop calls
            this.playingSounds.delete(cueId);
            
            if (fadeOut && actualFadeOutTime > 0) {
                console.log(`AudioManager: Starting fade out for cue ${cueId}, duration: ${actualFadeOutTime}ms`);
                
                // Mark as fading out
                playbackInfo.isFadingOut = true;
                playbackInfo.fadeStartTime = Date.now();
                playbackInfo.fadeDuration = actualFadeOutTime;
                
                // Fade out
                const currentTime = this.audioContext.currentTime;
                gainNode.gain.cancelScheduledValues(currentTime);
                gainNode.gain.setValueAtTime(gainNode.gain.value, currentTime);
                gainNode.gain.linearRampToValueAtTime(0, currentTime + (actualFadeOutTime / 1000));
                
                // Stop source after fade out
                setTimeout(() => {
                    try {
                        if (source && typeof source.stop === 'function') {
                            source.stop();
                            console.log(`AudioManager: Fade out completed for cue ${cueId}`);
                        }
                        // Clear fade state
                        playbackInfo.isFadingOut = false;
                    } catch (e) {
                        console.warn(`AudioManager: Error stopping source after fade for cue ${cueId}:`, e);
                        // Source might already be stopped
                    }
                }, actualFadeOutTime);
            } else {
                console.log(`AudioManager: Immediate stop for cue ${cueId}`);
                // Immediate stop
                try {
                    if (source && typeof source.stop === 'function') {
                        source.stop();
                    }
                } catch (e) {
                    console.warn(`AudioManager: Error stopping source immediately for cue ${cueId}:`, e);
                    // Source might already be stopped
                }
            }
            
            console.log(`AudioManager: Stopped cue ${cueId}`);
            
            return { success: true };
            
        } catch (error) {
            console.error(`AudioManager: Error stopping cue ${cueId}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Stop all playing cues
    async stopAllCues(fadeOut = false) {
        try {
            const cueIds = Array.from(this.playingSounds.keys());
            const results = [];
            
            console.log(`AudioManager: Stopping ${cueIds.length} cues`);
            
            // Stop all cues in parallel for better performance
            const stopPromises = cueIds.map(async (cueId) => {
                const result = await this.stopCue(cueId, fadeOut);
                results.push({ cueId, ...result });
                return result;
            });
            
            await Promise.all(stopPromises);
            
            console.log(`AudioManager: Stopped ${cueIds.length} cues`);
            return {
                success: true,
                results: results
            };
            
        } catch (error) {
            console.error(`AudioManager: Error stopping all cues:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Pause/Resume cue
    async togglePauseCue(cueId) {
        try {
            const playbackInfo = this.playingSounds.get(cueId);
            if (!playbackInfo) {
                return { success: false, error: 'Cue not playing' };
            }
            
            // Note: Web Audio API doesn't support pause/resume directly
            // We need to implement this by stopping and restarting with offset
            // For now, we'll just return success and let the backend handle it
            
            console.log(`AudioManager: Toggle pause for cue ${cueId} (not implemented)`);
            return { success: true, message: 'Pause/resume not implemented in browser' };
            
        } catch (error) {
            console.error(`AudioManager: Error toggling pause for cue ${cueId}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Set master volume
    setMasterVolume(volume) {
        if (this.masterGain) {
            this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
            this.settings.masterVolume = volume;
            console.log(`AudioManager: Master volume set to ${volume}`);
        }
    }
    
    // Get current playback status
    getPlaybackStatus() {
        const status = {
            isInitialized: this.isInitialized,
            audioContextState: this.audioContext?.state || 'not-initialized',
            masterVolume: this.settings.masterVolume,
            playingCues: Array.from(this.playingSounds.keys()),
            totalPlaying: this.playingSounds.size,
            cachedBuffers: this.audioBuffers.size
        };
        
        return status;
    }
    
    // Get duration of an audio file without playing it
    async getAudioFileDuration(audioFileId) {
        try {
            // Check if we already have this buffer cached
            if (this.audioBuffers.has(audioFileId)) {
                const buffer = this.audioBuffers.get(audioFileId);
                return buffer.duration;
            }
            
            // Load the audio file
            const audioUrl = `/api/audio/serve/${audioFileId}`;
            const response = await fetch(audioUrl);
            
            if (!response.ok) {
                throw new Error(`Failed to fetch audio file: ${response.status}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            
            // Cache the buffer
            this.audioBuffers.set(audioFileId, audioBuffer);
            
            return audioBuffer.duration;
            
        } catch (error) {
            console.error(`AudioManager: Error getting duration for audio file ${audioFileId}:`, error);
            return 0;
        }
    }
    
    // Get fade state for a specific cue
    getCueFadeState(cueId) {
        const playbackInfo = this.playingSounds.get(cueId);
        if (!playbackInfo) {
            return { isFadingIn: false, isFadingOut: false, fadeTimeRemainingMs: 0 };
        }
        
        const now = Date.now();
        let fadeTimeRemainingMs = 0;
        
        if (playbackInfo.isFadingOut && playbackInfo.fadeStartTime && playbackInfo.fadeDuration) {
            const elapsed = now - playbackInfo.fadeStartTime;
            fadeTimeRemainingMs = Math.max(0, playbackInfo.fadeDuration - elapsed);
        } else if (playbackInfo.isFadingIn && playbackInfo.fadeInStartTime && playbackInfo.fadeInDuration) {
            const elapsed = now - playbackInfo.fadeInStartTime;
            fadeTimeRemainingMs = Math.max(0, playbackInfo.fadeInDuration - elapsed);
        }
        
        return {
            isFadingIn: playbackInfo.isFadingIn || false,
            isFadingOut: playbackInfo.isFadingOut || false,
            fadeTimeRemainingMs: fadeTimeRemainingMs
        };
    }
    
    // Handle playback end
    handlePlaybackEnd(cueId) {
        this.playingSounds.delete(cueId);
        console.log(`AudioManager: Playback ended for cue ${cueId}`);
        
        // Emit event for UI updates
        this.emit('playbackEnded', { cueId });
    }
    
    cleanup() {
        try {
            this.playingSounds.forEach((playbackInfo) => {
                if (playbackInfo.source) {
                    try {
                        playbackInfo.source.stop();
                    } catch (e) {
                        // Source might already be stopped
                    }
                }
            });

            this.playingSounds.clear();
            this.audioBuffers.clear();
            
            if (this.audioContext && this.audioContext.state !== 'closed') {
                this.audioContext.close();
            }
            
            console.log('AudioManager: Cleanup completed');
            
        } catch (error) {
            console.error('AudioManager: Error during cleanup:', error);
        }
    }
}

// Export for use in modules
export default AudioManager;
