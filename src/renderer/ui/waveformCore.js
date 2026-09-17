// Companion_soundboard/src/renderer/ui/waveformCore.js

/**
 * Waveform Core Module
 * Handles core waveform initialization, event handling, and playback management
 */

// Module-level variables for WaveSurfer instance and related state
let wavesurferInstance = null;
let waveformIsStoppedAtTrimStart = false;
let currentAudioFilePath = null; // Store the current audio file path
let playStartPosition = 0; // Track where play was started for stop behavior

// Zoom state variables
let zoomLevel = 0; // Start at minimum zoom (0-100 scale, higher = more zoomed in)
let maxZoom = 1000; // Maximum zoom level (increased for better zoom range) 
let minZoom = 0; // Minimum zoom level

// DOM Elements
let waveformDisplayDiv;
let wfPlayPauseBtn, wfStopBtn, wfSoloBtn;
let wfCurrentTime, wfTotalDuration, wfRemainingTime;

// Dependencies
let ipcRendererBindingsModule;
let onTrimChangeCallback = null;

// Waveform initialization with debouncing
let waveformInitTimeout = null;
const WAVEFORM_INIT_DEBOUNCE_MS = 100;

/**
 * Initialize the core waveform module
 * @param {object} dependencies - Object containing required modules and DOM elements
 */
function initWaveformCore(dependencies) {
    wavesurferInstance = dependencies.wavesurferInstance;
    waveformDisplayDiv = dependencies.waveformDisplayDiv;
    wfPlayPauseBtn = dependencies.wfPlayPauseBtn;
    wfStopBtn = dependencies.wfStopBtn;
    wfSoloBtn = dependencies.wfSoloBtn;
    wfCurrentTime = dependencies.wfCurrentTime;
    wfTotalDuration = dependencies.wfTotalDuration;
    wfRemainingTime = dependencies.wfRemainingTime;
    ipcRendererBindingsModule = dependencies.ipcRendererBindings;
    onTrimChangeCallback = dependencies.onTrimChange;
    
    console.log('WaveformCore: Initialized with dependencies:', {
        wavesurferInstance: !!wavesurferInstance,
        displayDiv: !!waveformDisplayDiv,
        playPauseBtn: !!wfPlayPauseBtn,
        stopBtn: !!wfStopBtn,
        soloBtn: !!wfSoloBtn,
        currentTime: !!wfCurrentTime,
        totalDuration: !!wfTotalDuration,
        remainingTime: !!wfRemainingTime,
        ipcRenderer: !!ipcRendererBindingsModule,
        onTrimChange: !!onTrimChangeCallback
    });
}

/**
 * Update dependencies when they change
 * @param {object} dependencies - Updated dependencies
 */
function updateDependencies(dependencies) {
    if (dependencies.wavesurferInstance !== undefined) {
        wavesurferInstance = dependencies.wavesurferInstance;
    }
    if (dependencies.currentAudioFilePath !== undefined) {
        currentAudioFilePath = dependencies.currentAudioFilePath;
    }
    if (dependencies.onTrimChange !== undefined) {
        onTrimChangeCallback = dependencies.onTrimChange;
    }
}

/**
 * Bind event listeners for core waveform controls
 * @param {function} getTrimTimesCallback - Callback to get current trim times
 */
function bindCoreWaveformEvents(getTrimTimesCallback) {
    console.log('WaveformCore: Starting to bind core event listeners...');
    
    if (wfPlayPauseBtn) {
        wfPlayPauseBtn.addEventListener('click', () => {
            console.log('WaveformCore: wfPlayPauseBtn clicked.');
            if (wavesurferInstance) {
                const trimTimes = getTrimTimesCallback ? getTrimTimesCallback() : null;
                const currentTime = wavesurferInstance.getCurrentTime();
                const duration = wavesurferInstance.getDuration();
                console.log('WaveformCore (Play): ws valid.', 'trimTimes:', trimTimes, 'currentTime:', currentTime, 'duration:', duration, 'isPlaying:', wavesurferInstance.isPlaying());

                if (trimTimes) {
                    if (wavesurferInstance.isPlaying()) {
                        wavesurferInstance.pause();
                    } else {
                        if (currentTime < trimTimes.trimStartTime || currentTime >= trimTimes.trimEndTime) {
                            console.log('WaveformCore: Playhead outside trim region or at/after end. Seeking to region start.');
                            if (duration > 0) wavesurferInstance.seekTo(trimTimes.trimStartTime / duration);
                            playStartPosition = trimTimes.trimStartTime;
                            wavesurferInstance.play();
                        } else {
                            playStartPosition = currentTime;
                            wavesurferInstance.play(); 
                        }
                    }
                } else {
                    if (wavesurferInstance.isPlaying()) {
                        wavesurferInstance.pause();
                    } else {
                        playStartPosition = currentTime;
                        wavesurferInstance.play();
                    }
                }
            }
        });
        console.log('WaveformCore: Play/Pause button listener bound');
    } else {
        console.warn('WaveformCore: wfPlayPauseBtn not found, cannot bind event');
    }
    
    if (wfStopBtn) {
        wfStopBtn.addEventListener('click', () => {
            console.log('WaveformCore: wfStopBtn clicked.');
            if (wavesurferInstance) {
                const wasPlaying = wavesurferInstance.isPlaying();
                wavesurferInstance.pause();
                
                const duration = wavesurferInstance.getDuration();
                let seekToTime = 0;
                
                if (wasPlaying) {
                    seekToTime = playStartPosition;
                } else {
                    const trimTimes = getTrimTimesCallback ? getTrimTimesCallback() : null;
                    if (trimTimes) {
                        seekToTime = trimTimes.trimStartTime;
                    }
                }
                
                if (duration > 0) {
                    wavesurferInstance.seekTo(seekToTime / duration);
                }
                
                console.log('WaveformCore: Stopped and seeked to:', seekToTime);
            }
        });
        console.log('WaveformCore: Stop button listener bound');
    } else {
        console.warn('WaveformCore: wfStopBtn not found, cannot bind event');
    }
    
    if (wfSoloBtn) {
        wfSoloBtn.addEventListener('click', () => {
            console.log('WaveformCore: wfSoloBtn clicked.');
            // Solo functionality would be implemented here
        });
        console.log('WaveformCore: Solo button listener bound');
    } else {
        console.log('WaveformCore: wfSoloBtn not found - solo functionality not implemented');
    }
    
    // Add zoom functionality with mouse wheel
    if (waveformDisplayDiv) {
        waveformDisplayDiv.addEventListener('wheel', (e) => {
            if (wavesurferInstance) {
                e.preventDefault(); // Prevent page scrolling
                
                // Calculate new zoom level based on wheel direction
                const direction = e.deltaY < 0 ? 1 : -1; // 1 = zoom in, -1 = zoom out
                
                // Variable zoom step based on current zoom level
                let zoomStep;
                if (zoomLevel < 10) {
                    // Very fine steps at the beginning (1 unit per step)
                    zoomStep = 1 * direction;
                } else {
                    // Larger steps at higher zoom levels (5 units per step)
                    zoomStep = 5 * direction;
                }
                
                // Update the zoom level
                zoomLevel += zoomStep;
                
                // Constrain zoom level between min and max values
                zoomLevel = Math.min(Math.max(zoomLevel, minZoom), maxZoom);
                
                // Apply the zoom directly - wavesurfer zoom value = our zoom level
                console.log(`WaveformCore: Setting zoom to level ${zoomLevel}`);
                wavesurferInstance.zoom(zoomLevel);
                
                console.log(`WaveformCore: Zoom changed to ${zoomLevel.toFixed(2)}`);
                
                // If zoomed all the way to minimum, reset to default zoom
                if (zoomLevel <= minZoom) {
                    resetZoom();
                }
            }
        });
        
        // Double-click to reset zoom
        waveformDisplayDiv.addEventListener('dblclick', (e) => {
            if (wavesurferInstance) {
                resetZoom();
            }
        });
        
        console.log('WaveformCore: Zoom event listeners bound');
    } else {
        console.warn('WaveformCore: waveformDisplayDiv not found, cannot bind zoom events');
    }
    
    // Add precise editing keyboard controls
    document.addEventListener('keydown', (e) => {
        if (!wavesurferInstance || !waveformDisplayDiv) return;
        
        // Check if waveform is visible and focused
        const waveformVisible = waveformDisplayDiv.style.display !== 'none';
        const waveformFocused = document.activeElement === waveformDisplayDiv || 
            waveformDisplayDiv.contains(document.activeElement) ||
            // Also handle when no specific element is focused but waveform is visible
            (!document.activeElement || document.activeElement === document.body);
        
        if (!waveformVisible || !waveformFocused) return;
        
        const duration = wavesurferInstance.getDuration();
        if (!duration || duration <= 0) return;
        
        let seekOffset = 0;
        let handled = true;
        
        // Determine seek offset based on key combination
        if (e.shiftKey) {
            // Fine adjustment (0.01 seconds = 10ms)
            seekOffset = 0.01;
        } else if (e.ctrlKey || e.metaKey) {
            // Medium adjustment (0.1 seconds = 100ms)
            seekOffset = 0.1;
        } else {
            // Coarse adjustment (1 second)
            seekOffset = 1.0;
        }
        
        // Apply direction based on arrow keys
        switch (e.key) {
            case 'ArrowLeft':
                seekOffset = -seekOffset;
                break;
            case 'ArrowRight':
                // seekOffset is already positive
                break;
            case 'Home':
                // Seek to beginning
                wavesurferInstance.seekTo(0);
                syncPlaybackTimeWithUI(0);
                handled = true;
                break;
            case 'End':
                // Seek to end
                wavesurferInstance.seekTo(1);
                syncPlaybackTimeWithUI(duration);
                handled = true;
                break;
            default:
                handled = false;
        }
        
        if (handled && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            
            const currentTime = wavesurferInstance.getCurrentTime();
            const newTime = Math.max(0, Math.min(duration, currentTime + seekOffset));
            
            // Seek to new position
            const seekProgress = newTime / duration;
            wavesurferInstance.seekTo(seekProgress);
            syncPlaybackTimeWithUI(newTime);
            
            console.log(`WaveformCore: Precise seek by ${seekOffset.toFixed(3)}s to ${newTime.toFixed(3)}s`);
        }
    });
}

/**
 * Initialize waveform for a cue
 * @param {object} cue - The cue object
 * @param {function} setupEventsCallback - Callback to setup waveform events
 * @param {function} setRegionsCallback - Callback to set regions instance
 */
function initializeWaveform(cue, setupEventsCallback, setRegionsCallback) {
    console.log('WaveformCore: initializeWaveform called for cue:', cue.id);
    
    // Clear any pending initialization
    if (waveformInitTimeout) {
        clearTimeout(waveformInitTimeout);
    }
    
    // Debounce the initialization
    waveformInitTimeout = setTimeout(() => {
        _initializeWaveformDebounced(cue, setupEventsCallback, setRegionsCallback);
    }, WAVEFORM_INIT_DEBOUNCE_MS);
}

function _initializeWaveformDebounced(cue, setupEventsCallback, setRegionsCallback) {
    console.log('WaveformCore: _initializeWaveformDebounced called for cue:', cue.id);
    
    if (!cue || !cue.filePath) {
        console.error('WaveformCore: Cannot initialize waveform - no cue or filePath');
        return;
    }
    
    // Clean up existing waveform
    destroyWaveform();
    
    // Store current audio file path
    currentAudioFilePath = cue.filePath;
    
    console.log('WaveformCore: Creating new waveform for:', cue.filePath);
    
    try {
        // Make the waveform display focusable for keyboard controls
        waveformDisplayDiv.setAttribute('tabindex', '0');
        waveformDisplayDiv.style.outline = 'none';
        
        // Create new WaveSurfer instance with settings matching expanded waveform
        wavesurferInstance = WaveSurfer.create({
            container: waveformDisplayDiv,
            waveColor: '#4F46E5',
            progressColor: '#7C3AED',
            cursorColor: '#EF4444',
            barWidth: 2,
            barRadius: 3,
            responsive: true,
            height: 128, // Match the CSS height for #waveformDisplay
            normalize: true,
            backend: 'WebAudio',
            mediaControls: false,
            interact: true, // Ensure interaction is enabled
            plugins: [
                WaveSurfer.Regions.create()
            ]
        });
        
        // Get the regions plugin instance
        const regionsPlugin = wavesurferInstance.plugins[0];
        if (setRegionsCallback) {
            setRegionsCallback(regionsPlugin);
        }
        
        // Set up waveform events
        if (setupEventsCallback) {
            setupEventsCallback(cue, regionsPlugin);
        }
        
        // Load the audio file
        wavesurferInstance.load(cue.filePath);
        
        console.log('WaveformCore: Waveform initialization completed');
        
    } catch (error) {
        console.error('WaveformCore: Error initializing waveform:', error);
    }
}

/**
 * Set up core waveform events
 * @param {object} cue - The cue object
 * @param {object} regionsPlugin - The regions plugin instance
 * @param {function} setupRegionEventsCallback - Callback to setup region events
 * @param {function} loadRegionsCallback - Callback to load regions from cue
 * @param {function} handlePlaybackEndCallback - Callback to handle playback end
 */
function setupCoreWaveformEvents(cue, regionsPlugin, setupRegionEventsCallback, loadRegionsCallback, handlePlaybackEndCallback) {
    if (!wavesurferInstance) {
        console.error('WaveformCore: Cannot setup events - no wavesurferInstance');
        return;
    }
    
    console.log('WaveformCore: Setting up core waveform events');
    
    // Set up region event handlers
    if (setupRegionEventsCallback) {
        setupRegionEventsCallback();
    }
    
    // Update time displays during playback
    wavesurferInstance.on('audioprocess', (currentTime) => {
        console.log('WaveformCore: audioprocess event - currentTime:', currentTime);
        // Enforce trim end during editor playback
        try {
            const trimTimes = getCurrentTrimTimes();
            if (trimTimes && typeof trimTimes.trimEndTime === 'number') {
                const epsilon = 0.005;
                if (currentTime >= (trimTimes.trimEndTime - epsilon)) {
                    if (handlePlaybackEndCallback) {
                        handlePlaybackEndCallback();
                    }
                    return;
                }
            }
        } catch (e) {
            console.warn('WaveformCore: Error enforcing trim end during audioprocess:', e);
        }
        syncPlaybackTimeWithUI(currentTime);
    });
    
    // Update time displays on seek
    wavesurferInstance.on('seek', (seekProgress) => {
        if (!wavesurferInstance) return;
        const duration = wavesurferInstance.getDuration();
        const currentTime = seekProgress * duration;
        console.log('WaveformCore: seek event - seekProgress:', seekProgress, 'currentTime:', currentTime);
        syncPlaybackTimeWithUI(currentTime);
    });
    
    // Update time displays when playback position changes
    wavesurferInstance.on('timeupdate', (currentTime) => {
        if (!wavesurferInstance) return;
        console.log('WaveformCore: timeupdate event - currentTime:', currentTime);
        // Redundant enforcement in case audioprocess is throttled
        try {
            const trimTimes = getCurrentTrimTimes();
            if (trimTimes && typeof trimTimes.trimEndTime === 'number') {
                const epsilon = 0.005;
                if (currentTime >= (trimTimes.trimEndTime - epsilon)) {
                    if (handlePlaybackEndCallback) {
                        handlePlaybackEndCallback();
                    }
                    return;
                }
            }
        } catch (e) {
            console.warn('WaveformCore: Error enforcing trim end during timeupdate:', e);
        }
        syncPlaybackTimeWithUI(currentTime);
    });
    
    // Initialize time displays when ready
    wavesurferInstance.on('ready', () => {
        console.log('WaveformCore: ready event fired');
        updateInitialTimeDisplays();
        
        // Load regions from cue data after waveform is ready
        if (cue && loadRegionsCallback) {
            console.log('WaveformCore: Loading regions from cue:', cue);
            loadRegionsCallback(cue);
        }
    });
    
    // Handle clicks for seeking
    wavesurferInstance.on('click', (relativeX) => {
        if (!wavesurferInstance) return;
        
        const duration = wavesurferInstance.getDuration();
        const seekTime = relativeX * duration;
        
        if (seekTime >= 0 && seekTime <= duration) {
            console.log('WaveformCore: Seeking to', seekTime);
            syncPlaybackTimeWithUI(seekTime);
            
            // Focus the waveform for keyboard controls
            if (waveformDisplayDiv) {
                waveformDisplayDiv.focus();
            }
            
            if (typeof seekInAudioController === 'function') {
                seekInAudioController(cue.id, seekTime);
            }
        }
    });
    
    // Handle playback state changes
    wavesurferInstance.on('play', () => { 
        const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
        if (playPauseImg) playPauseImg.src = '../../assets/icons/pause.png';
    });
    
    wavesurferInstance.on('pause', () => { 
        const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
        if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';
    });
    
    wavesurferInstance.on('finish', () => { 
        if (handlePlaybackEndCallback) {
            handlePlaybackEndCallback();
        }
    });
    
    console.log('WaveformCore: Event listeners setup completed');
}

/**
 * Sync playback time with UI elements
 * @param {number} currentTime - Current playback time
 */
function syncPlaybackTimeWithUI(currentTime) {
    if (!wavesurferInstance) {
        console.warn('WaveformCore: syncPlaybackTimeWithUI called but wavesurferInstance is null');
        return;
    }
    
    const totalDuration = wavesurferInstance.getDuration();
    if (totalDuration === null || totalDuration === undefined || isNaN(totalDuration)) {
        console.warn('WaveformCore: syncPlaybackTimeWithUI - invalid duration, skipping');
        return;
    }
    
    // Update the current time display (always show original time)
    if (wfCurrentTime) {
        wfCurrentTime.textContent = formatWaveformTime(currentTime);
    }
    
    // Update the total duration display (always show original duration, not trimmed)
    if (wfTotalDuration) {
        wfTotalDuration.textContent = formatWaveformTime(totalDuration);
    }
    
    // Update the remaining time display (always show original remaining time)
    if (wfRemainingTime) {
        const remainingTime = totalDuration - currentTime;
        wfRemainingTime.textContent = formatWaveformTime(remainingTime);
    }
}

/**
 * Update initial time displays
 */
function updateInitialTimeDisplays() {
    if (!wavesurferInstance) return;
    
    const duration = wavesurferInstance.getDuration();
    if (duration && duration > 0) {
        if (wfTotalDuration) {
            wfTotalDuration.textContent = formatWaveformTime(duration);
        }
        if (wfRemainingTime) {
            wfRemainingTime.textContent = formatWaveformTime(duration);
        }
        if (wfCurrentTime) {
            wfCurrentTime.textContent = formatWaveformTime(0);
        }
    }
}

/**
 * Handle playback end reached
 * @param {function} getTrimTimesCallback - Callback to get current trim times
 */
function handlePlaybackEndReached(getTrimTimesCallback) {
    console.log('WaveformCore: Playback end reached');
    
    if (wavesurferInstance) {
        wavesurferInstance.pause();
        
        const trimTimes = getTrimTimesCallback ? getTrimTimesCallback() : null;
        if (trimTimes) {
            const duration = wavesurferInstance.getDuration();
            if (duration > 0) {
                wavesurferInstance.seekTo(trimTimes.trimStartTime / duration);
            }
        }
        
        // Update play/pause button icon
        const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
        if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';
    }
}

/**
 * Destroy the waveform
 */
function destroyWaveform() {
    console.log('WaveformCore: destroyWaveform called');
    
    if (wavesurferInstance) {
        try {
            wavesurferInstance.destroy();
        } catch (error) {
            console.warn('WaveformCore: Error destroying waveform:', error);
        }
        wavesurferInstance = null;
    }
    
    // Reset state
    currentAudioFilePath = null;
    playStartPosition = 0;
    waveformIsStoppedAtTrimStart = false;
    
    console.log('WaveformCore: Waveform destroyed and state reset');
}

/**
 * Get current trim times (placeholder - should be implemented by regions module)
 * @returns {object|null} Current trim times
 */
function getCurrentTrimTimes() {
    // This should be implemented by the regions module
    return null;
}

/**
 * Format time for display with millisecond precision
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
function formatWaveformTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00.000';
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);
    
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

/**
 * Get the current wavesurfer instance
 * @returns {object|null} The wavesurfer instance
 */
function getWavesurferInstance() {
    return wavesurferInstance;
}

/**
 * Get the current audio file path
 * @returns {string|null} The current audio file path
 */
function getCurrentAudioFilePath() {
    return currentAudioFilePath;
}

/**
 * Show waveform for a cue
 * @param {object} cue - The cue object
 * @param {function} setupEventsCallback - Callback to setup waveform events
 * @param {function} setRegionsCallback - Callback to set regions instance
 */
function showWaveformForCue(cue, setupEventsCallback, setRegionsCallback) {
    console.log('WaveformCore: showWaveformForCue called with cue:', cue ? cue.id : 'null');
    
    if (!waveformDisplayDiv) {
        console.error("WaveformCore: DOM not cached - waveformDisplayDiv not found."); 
        return; 
    }
    
    if (!cue || !cue.filePath || (cue.type && cue.type === 'playlist')) {
        console.log('WaveformCore: Hiding waveform - no cue, no filePath, or playlist type');
        destroyWaveform(); 
        if(waveformDisplayDiv) waveformDisplayDiv.style.display = 'none';
        return;
    }
    
    console.log('WaveformCore: Initializing waveform for cue:', cue.id, 'filePath:', cue.filePath);
    return initializeWaveform(cue, setupEventsCallback, setRegionsCallback);
}

/**
 * Reset zoom to show the entire track
 */
function resetZoom() {
    if (wavesurferInstance) {
        console.log('WaveformCore: Resetting zoom to default level');
        zoomLevel = 0;
        wavesurferInstance.zoom(0);
    }
}

/**
 * Hide and destroy waveform
 */
function hideAndDestroyWaveform() {
    destroyWaveform();
    if(waveformDisplayDiv) waveformDisplayDiv.style.display = 'none';
}

export {
    initWaveformCore,
    updateDependencies,
    bindCoreWaveformEvents,
    initializeWaveform,
    setupCoreWaveformEvents,
    syncPlaybackTimeWithUI,
    updateInitialTimeDisplays,
    handlePlaybackEndReached,
    destroyWaveform,
    getCurrentTrimTimes,
    formatWaveformTime,
    getWavesurferInstance,
    getCurrentAudioFilePath,
    resetZoom,
    showWaveformForCue,
    hideAndDestroyWaveform
};
