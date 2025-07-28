// Companion_soundboard/src/renderer/ui/waveformControls.js

// Module-level variables for WaveSurfer instance, regions, and related state
let wavesurferInstance = null;
let wsRegions = null; // Regions plugin instance
let currentLiveTrimRegion = null; // ADDED: To store the live trimRegion object
let isDestroyingWaveform = false; // ADDED: Flag to prevent callback loops during destruction
let waveformIsStoppedAtTrimStart = false;
let zoomLevel = 0; // Start at minimum zoom (0-100 scale, higher = more zoomed in)
let maxZoom = 100; // Maximum zoom level 
let minZoom = 0; // Minimum zoom level
let currentAudioFilePath = null; // Store the current audio file path
let playStartPosition = 0; // Track where play was started for stop behavior

// Bottom panel state
let isBottomPanelExpanded = false;
let bottomPanelSize = 'normal'; // 'normal' or 'large'
let expandedWaveformCanvas = null;
let expandedAnimationId = null;
let currentExpandedCue = null;
let expandedZoomLevel = 0; // Zoom level for expanded waveform

// DOM Elements
let waveformDisplayDiv;
let wfPlayPauseBtn, wfStopBtn, wfSetStartBtn, wfSetEndBtn, wfSoloBtn;
let wfCurrentTime, wfTotalDuration, wfRemainingTime;

// DOM elements for bottom panel
let bottomWaveformPanel;
let bottomPanelCueName;
let normalSizeBtn;
let largeSizeBtn;
let collapseBottomPanelBtn;
let expandWaveformBtn;
let expandedWaveformDisplay;
let expandedWaveformControls;
let expandedWfSetStartBtn;
let expandedWfSetEndBtn;
let expandedWfPlayPauseBtn;
let expandedWfStopBtn;
let expandedWfClearTrimBtn;
let expandedWfCurrentTime;
let expandedWfTotalDuration;
let expandedWfRemainingTime;

// Main waveform clear button
let wfClearTrimBtn;

// Dependencies from other modules (will be set in init)
let ipcRendererBindingsModule;
let onTrimChangeCallback = null; // ADDED: Callback for trim changes
// let cueStore; // If needed directly for cue data, otherwise cue object is passed

// --- Initialization ---

/**
 * Initializes the waveform controls module.
 * Caches DOM elements and sets up initial state.
 * @param {object} dependencies - Object containing necessary modules (ipcRenderer) and callbacks.
 */
function initWaveformControls(dependencies) {
    console.log('WaveformControls: Initializing...');
    console.log('WaveformControls: Dependencies received:', dependencies);
    
    ipcRendererBindingsModule = dependencies.ipcRendererBindings;
    console.log('WaveformControls: ipcRendererBindings set:', !!ipcRendererBindingsModule);

    console.log('WaveformControls (DEBUG init): typeof dependencies.onTrimChange:', typeof dependencies.onTrimChange); // New Log
    if (dependencies.onTrimChange) {
        console.log('WaveformControls (DEBUG init): dependencies.onTrimChange.toString():', dependencies.onTrimChange.toString()); // New Log (be careful if it's not a function)
    }

    if (typeof dependencies.onTrimChange === 'function') { 
        onTrimChangeCallback = dependencies.onTrimChange;
        console.log('WaveformControls (DEBUG init): onTrimChangeCallback ASSIGNED.'); // New Log
    } else {
        console.error('WaveformControls (DEBUG init): onTrimChange callback was not provided or not a function! dependencies.onTrimChange:', dependencies.onTrimChange);
        onTrimChangeCallback = null; // Explicitly set to null if not a function
    }

    cacheWaveformDOMElements();
    bindWaveformControlEventsListeners(); // Listeners for wfPlayPauseBtn, etc.
    console.log('WaveformControls: Initialized.');
}

function cacheWaveformDOMElements() {
    waveformDisplayDiv = document.getElementById('waveformDisplay');
    wfPlayPauseBtn = document.getElementById('wfPlayPauseBtn');
    wfStopBtn = document.getElementById('wfStopBtn');
    wfSetStartBtn = document.getElementById('wfSetStartBtn');
    wfSetEndBtn = document.getElementById('wfSetEndBtn');
    wfSoloBtn = document.getElementById('wfSoloBtn');
    wfClearTrimBtn = document.getElementById('wfClearTrimBtn');
    wfCurrentTime = document.getElementById('wfCurrentTime');
    wfTotalDuration = document.getElementById('wfTotalDuration');
    wfRemainingTime = document.getElementById('wfRemainingTime');
    
    // Cache bottom panel DOM elements
    bottomWaveformPanel = document.getElementById('bottomWaveformPanel');
    bottomPanelCueName = document.getElementById('bottomPanelCueName');
    normalSizeBtn = document.getElementById('normalSizeBtn');
    largeSizeBtn = document.getElementById('largeSizeBtn');
    collapseBottomPanelBtn = document.getElementById('collapseBottomPanelBtn');
    expandWaveformBtn = document.getElementById('expandWaveformBtn');
    expandedWaveformDisplay = document.getElementById('expandedWaveformDisplay');
    expandedWaveformControls = document.getElementById('expandedWaveformControls');
    expandedWfSetStartBtn = document.getElementById('expandedWfSetStartBtn');
    expandedWfSetEndBtn = document.getElementById('expandedWfSetEndBtn');
    expandedWfPlayPauseBtn = document.getElementById('expandedWfPlayPauseBtn');
    expandedWfStopBtn = document.getElementById('expandedWfStopBtn');
    expandedWfClearTrimBtn = document.getElementById('expandedWfClearTrimBtn');
    expandedWfCurrentTime = document.getElementById('expandedWfCurrentTime');
    expandedWfTotalDuration = document.getElementById('expandedWfTotalDuration');
    expandedWfRemainingTime = document.getElementById('expandedWfRemainingTime');
    
    console.log('WaveformControls: DOM elements cached:');
    console.log('  waveformDisplayDiv:', waveformDisplayDiv ? 'Found' : 'NOT FOUND');
    console.log('  wfSetStartBtn:', wfSetStartBtn ? 'Found' : 'NOT FOUND');
    console.log('  wfSetEndBtn:', wfSetEndBtn ? 'Found' : 'NOT FOUND');
    console.log('  wfCurrentTime:', wfCurrentTime ? 'Found' : 'NOT FOUND');
    console.log('  wfTotalDuration:', wfTotalDuration ? 'Found' : 'NOT FOUND');
    console.log('  wfRemainingTime:', wfRemainingTime ? 'Found' : 'NOT FOUND');
}

// Function to reset zoom to show the entire track
function resetZoom() {
    if (wavesurferInstance) {
        zoomLevel = 0; // Reset to minimum zoom level
        wavesurferInstance.zoom(1); // Minimum effective zoom for wavesurfer (0 would be invalid)
        console.log('WaveformControls: Zoom reset to default level (level 0)');
    }
}

// Function to reset expanded waveform zoom
function resetExpandedZoom() {
    if (expandedWaveformInstance) {
        expandedZoomLevel = 0; // Reset to minimum zoom level
        expandedWaveformInstance.zoom(1); // Minimum effective zoom for wavesurfer (0 would be invalid)
        console.log('WaveformControls: Expanded zoom reset to default level (level 0)');
    }
}

// Function to set up zoom functionality for expanded waveform
function setupExpandedWaveformZoom() {
    if (!expandedWaveformInstance || !expandedWaveformDisplay) {
        console.warn('WaveformControls: Cannot setup zoom - missing expandedWaveformInstance or expandedWaveformDisplay');
        return;
    }
    
    console.log('WaveformControls: Setting up expanded waveform zoom functionality');
    console.log('WaveformControls: expandedWaveformInstance exists:', !!expandedWaveformInstance);
    console.log('WaveformControls: expandedWaveformDisplay exists:', !!expandedWaveformDisplay);
    console.log('WaveformControls: expandedWaveformDisplay dimensions:', {
        width: expandedWaveformDisplay.offsetWidth,
        height: expandedWaveformDisplay.offsetHeight
    });
    
    // Check if event listeners are already attached to prevent duplicates
    if (expandedWaveformDisplay.hasAttribute('data-zoom-setup')) {
        console.log('WaveformControls: Zoom already set up for this element');
        return;
    }
    
    // Add zoom functionality with mouse wheel
    const wheelHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Calculate new zoom level based on wheel direction
        const direction = e.deltaY < 0 ? 1 : -1; // 1 = zoom in, -1 = zoom out
        
        // Variable zoom step based on current zoom level
        let zoomStep;
        if (expandedZoomLevel < 10) {
            // Smaller steps at lower zoom levels (1 unit per step)
            zoomStep = 1 * direction;
        } else {
            // Larger steps at higher zoom levels (5 units per step)
            zoomStep = 5 * direction;
        }
        
        // Update the zoom level
        expandedZoomLevel += zoomStep;
        
        // Constrain zoom level between min and max values
        expandedZoomLevel = Math.min(Math.max(expandedZoomLevel, minZoom), maxZoom);
        
        // Apply the zoom directly - wavesurfer zoom value = our zoom level
        console.log(`WaveformControls: Setting expanded zoom to level ${expandedZoomLevel}`);
        expandedWaveformInstance.zoom(expandedZoomLevel);
        
        console.log(`WaveformControls: Expanded zoom changed to ${expandedZoomLevel.toFixed(2)}`);
        
        // If zoomed all the way to minimum, reset to default zoom
        if (expandedZoomLevel <= minZoom) {
            resetExpandedZoom();
        }
    };
    
    const dblClickHandler = (e) => {
        resetExpandedZoom();
    };
    
    // Add the event listeners
    expandedWaveformDisplay.addEventListener('wheel', wheelHandler);
    expandedWaveformDisplay.addEventListener('dblclick', dblClickHandler);
    
    // Mark as set up to prevent duplicate listeners
    expandedWaveformDisplay.setAttribute('data-zoom-setup', 'true');
    
    console.log('WaveformControls: Expanded zoom event listeners added');
}

function bindWaveformControlEventsListeners() {
    console.log('WaveformControls: Starting to bind event listeners...');
    
    if (wfPlayPauseBtn) {
        wfPlayPauseBtn.addEventListener('click', () => {
        console.log('WaveformControls: wfPlayPauseBtn clicked.'); // New Log
        if (wavesurferInstance) {
            const trimRegion = wsRegions ? wsRegions.getRegions().find(r => r.id === 'trimRegion') : null;
            const currentTime = wavesurferInstance.getCurrentTime();
            const duration = wavesurferInstance.getDuration();
            console.log('WaveformControls (Play): ws valid.', 'trimRegion:', trimRegion ? trimRegion.id : null, 'currentTime:', currentTime, 'duration:', duration, 'isPlaying:', wavesurferInstance.isPlaying()); // New Log

            if (trimRegion) {
                if (wavesurferInstance.isPlaying()) {
                    wavesurferInstance.pause(); // If playing, just pause it regardless of position
                } else {
                    // If paused, decide where to play from and track play start position
                    if (currentTime < trimRegion.start || currentTime >= trimRegion.end) {
                        console.log('WaveformControls: Playhead outside trim region or at/after end. Seeking to region start.');
                        if (duration > 0) wavesurferInstance.seekTo(trimRegion.start / duration);
                        playStartPosition = trimRegion.start; // Track where we start playing from
                        wavesurferInstance.play();
                    } else {
                        // Playhead is within the trim region, play from current position
                        playStartPosition = currentTime; // Track where we start playing from
                        wavesurferInstance.play(); 
                    }
                }
            } else {
                // No trim region, just play/pause normally
                if (wavesurferInstance.isPlaying()) {
                    wavesurferInstance.pause();
                } else {
                    playStartPosition = currentTime; // Track where we start playing from
                    wavesurferInstance.play();
                }
            }
        }
    });
        console.log('WaveformControls: Play/Pause button listener bound');
    } else {
        console.warn('WaveformControls: wfPlayPauseBtn not found, cannot bind event');
    }
    
    if (wfStopBtn) {
        wfStopBtn.addEventListener('click', () => {
            console.log('WaveformControls: wfStopBtn clicked.');
            if (wavesurferInstance) {
                const wasPlaying = wavesurferInstance.isPlaying();
                wavesurferInstance.pause();
                
                const duration = wavesurferInstance.getDuration();
                let seekToTime = 0;
                
                if (wasPlaying) {
                    // If audio was playing, go back to where play was started
                    seekToTime = playStartPosition;
                    console.log('WaveformControls: Audio was playing, returning to play start position:', seekToTime);
                } else {
                    // If audio was not playing, go to position 0
                    seekToTime = 0;
                    playStartPosition = 0; // Reset play start position
                    console.log('WaveformControls: Audio was not playing, going to position 0');
                }
                
                if (duration > 0) {
                    wavesurferInstance.seekTo(seekToTime / duration);
                }
                
                const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
                if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';

                waveformIsStoppedAtTrimStart = false; // Reset this flag
            }
        });
        console.log('WaveformControls: Stop button listener bound');
    } else {
        console.warn('WaveformControls: wfStopBtn not found, cannot bind event');
    }
    
    if (wfSetStartBtn) {
        wfSetStartBtn.addEventListener('click', () => {
            console.log('WaveformControls: SET START BUTTON CLICKED!');
            handleSetTrimStart();
        }); // Call internal handler
        console.log('WaveformControls: Set Start button listener bound');
    } else {
        console.warn('WaveformControls: wfSetStartBtn not found, cannot bind event');
    }
    
    if (wfSetEndBtn) {
        wfSetEndBtn.addEventListener('click', () => {
            console.log('WaveformControls: SET END BUTTON CLICKED!');
            handleSetTrimEnd();
        });     // Call internal handler
        console.log('WaveformControls: Set End button listener bound');
    } else {
        console.warn('WaveformControls: wfSetEndBtn not found, cannot bind event');
    }
    
    if (wfClearTrimBtn) {
        wfClearTrimBtn.addEventListener('click', () => {
            console.log('WaveformControls: CLEAR TRIM BUTTON CLICKED!');
            handleClearTrim();
            // Sync the expanded waveform visually after trim clear
            setTimeout(() => {
                syncExpandedWaveformVisuals();
                syncTrimRegions();
            }, 100);
        });
        console.log('WaveformControls: Clear trim button listener bound');
    } else {
        console.warn('WaveformControls: wfClearTrimBtn not found, cannot bind event');
    }
    
    // Bind expand waveform button
    if (expandWaveformBtn) {
        expandWaveformBtn.addEventListener('click', expandBottomPanel);
        console.log('WaveformControls: Expand waveform button listener bound');
    } else {
        console.warn('WaveformControls: expandWaveformBtn not found, cannot bind event');
    }
    
    // Bind bottom panel controls
    if (collapseBottomPanelBtn) {
        collapseBottomPanelBtn.addEventListener('click', collapseBottomPanel);
        console.log('WaveformControls: Collapse bottom panel button listener bound');
    }
    
    if (normalSizeBtn) {
        normalSizeBtn.addEventListener('click', () => setBottomPanelSize('normal'));
        console.log('WaveformControls: Normal size button listener bound');
    }
    
    if (largeSizeBtn) {
        largeSizeBtn.addEventListener('click', () => setBottomPanelSize('large'));
        console.log('WaveformControls: Large size button listener bound');
    }
    
    // Bind expanded waveform controls (sync with main waveform)
    if (expandedWfPlayPauseBtn) {
        expandedWfPlayPauseBtn.addEventListener('click', () => {
            // Control the main waveform (which drives the audio), sync visual to expanded
            if (wavesurferInstance) {
                const trimRegion = wsRegions ? wsRegions.getRegions().find(r => r.id === 'trimRegion') : null;
                const currentTime = wavesurferInstance.getCurrentTime();
                const duration = wavesurferInstance.getDuration();

                if (trimRegion) {
                    if (wavesurferInstance.isPlaying()) {
                        wavesurferInstance.pause();
                    } else {
                        if (currentTime < trimRegion.start || currentTime >= trimRegion.end) {
                            if (duration > 0) wavesurferInstance.seekTo(trimRegion.start / duration);
                            playStartPosition = trimRegion.start; // Track where we start playing from
                            wavesurferInstance.play();
                        } else {
                            playStartPosition = currentTime; // Track where we start playing from
                            wavesurferInstance.play();
                        }
                    }
                } else {
                    if (wavesurferInstance.isPlaying()) {
                        wavesurferInstance.pause();
                    } else {
                        playStartPosition = currentTime; // Track where we start playing from
                        wavesurferInstance.play();
                    }
                }
                
                // Sync the expanded waveform visually
                syncExpandedWaveformVisuals();
            }
        });
        console.log('WaveformControls: Expanded play/pause button listener bound');
    }
    
    if (expandedWfStopBtn) {
        expandedWfStopBtn.addEventListener('click', () => {
            // Control the main waveform (which drives the audio), sync visual to expanded  
            if (wavesurferInstance) {
                const wasPlaying = wavesurferInstance.isPlaying();
                wavesurferInstance.pause();
                
                const duration = wavesurferInstance.getDuration();
                let seekToTime = 0;
                
                if (wasPlaying) {
                    // If audio was playing, go back to where play was started
                    seekToTime = playStartPosition;
                    console.log('WaveformControls: Expanded stop - Audio was playing, returning to play start position:', seekToTime);
                } else {
                    // If audio was not playing, go to position 0
                    seekToTime = 0;
                    playStartPosition = 0; // Reset play start position
                    console.log('WaveformControls: Expanded stop - Audio was not playing, going to position 0');
                }
                
                if (duration > 0) {
                    wavesurferInstance.seekTo(seekToTime / duration);
                }
                
                // Update play button icons
                const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
                if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';
                
                const expandedPlayPauseImg = expandedWfPlayPauseBtn ? expandedWfPlayPauseBtn.querySelector('img') : null;
                if (expandedPlayPauseImg) expandedPlayPauseImg.src = '../../assets/icons/play.png';
                
                // Sync the expanded waveform visually
                syncExpandedWaveformVisuals();
            }
        });
        console.log('WaveformControls: Expanded stop button listener bound');
    }
    
    if (expandedWfSetStartBtn) {
        expandedWfSetStartBtn.addEventListener('click', () => {
            console.log('WaveformControls: EXPANDED SET START BUTTON CLICKED!');
            handleSetTrimStart();
            // Sync the expanded waveform visually after trim change immediately and with retries
            syncExpandedWaveformVisuals();
            syncTrimRegions();
            setTimeout(() => {
                syncExpandedWaveformVisuals();
                syncTrimRegions();
            }, 100);
            // Additional sync after a longer delay to ensure it persists
            setTimeout(() => {
                syncTrimRegions();
            }, 500);
        });
        console.log('WaveformControls: Expanded set start button listener bound');
    }
    
    if (expandedWfSetEndBtn) {
        expandedWfSetEndBtn.addEventListener('click', () => {
            console.log('WaveformControls: EXPANDED SET END BUTTON CLICKED!');
            handleSetTrimEnd();
            // Sync the expanded waveform visually after trim change immediately and with retries
            syncExpandedWaveformVisuals();
            syncTrimRegions();
            setTimeout(() => {
                syncExpandedWaveformVisuals();
                syncTrimRegions();
            }, 100);
            // Additional sync after a longer delay to ensure it persists
            setTimeout(() => {
                syncTrimRegions();
            }, 500);
        });
        console.log('WaveformControls: Expanded set end button listener bound');
    }
    
    if (expandedWfClearTrimBtn) {
        expandedWfClearTrimBtn.addEventListener('click', () => {
            console.log('WaveformControls: EXPANDED CLEAR TRIM BUTTON CLICKED!');
            handleClearTrim();
            // Sync the expanded waveform visually after trim clear immediately and with retries
            syncExpandedWaveformVisuals();
            syncTrimRegions();
            setTimeout(() => {
                syncExpandedWaveformVisuals();
                syncTrimRegions();
            }, 100);
            // Additional sync after a longer delay to ensure it persists
            setTimeout(() => {
                syncTrimRegions();
            }, 500);
        });
        console.log('WaveformControls: Expanded clear trim button listener bound');
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
                console.log(`WaveformControls: Setting zoom to level ${zoomLevel}`);
                wavesurferInstance.zoom(zoomLevel);
                
                console.log(`WaveformControls: Zoom changed to ${zoomLevel.toFixed(2)}`);
                
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
    }
    
    console.log('WaveformControls: Event listeners for playback controls bound.');
}

// --- Utility Functions ---

// Utility to format time from seconds to M:SS.s
function formatWaveformTime(seconds) {
    const isNegative = seconds < 0;
    const absSeconds = isNegative ? -seconds : seconds;

    const m = Math.floor(absSeconds / 60);
    const s = Math.floor(absSeconds % 60);
    const ms = Math.floor((absSeconds - Math.floor(absSeconds)) * 10);
    return `${isNegative ? '-' : ''}${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
}

// Helper function to handle when playback reaches end of region or audio
function _handlePlaybackEndReached() {
    if (!wavesurferInstance) return;
    console.log("WaveformControls: Playback end reached (trim or finish).");
    wavesurferInstance.pause();
    const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
    if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';

    const trimRegion = wsRegions ? wsRegions.getRegions().find(r => r.id === 'trimRegion') : null;
    const duration = wavesurferInstance.getDuration();

    if (trimRegion && duration > 0) {
        console.log(`  Seeking to trimRegion.start: ${trimRegion.start}`);
        wavesurferInstance.seekTo(trimRegion.start / duration);
    } else if (duration > 0) {
        // If no trim region but audio finished, seek to absolute 0
        // This part might be optional if 'finish' always means end of full audio
        console.log("  No trim region on finish/end, seeking to 0.");
        wavesurferInstance.seekTo(0);
    }
    // The seekTo() call should trigger the 'seek' event, which updates time displays.
}

// --- Core Waveform Logic (to be moved/populated) ---

// Performance optimization: debounce waveform initialization
let waveformInitTimeout = null;
const WAVEFORM_INIT_DEBOUNCE_MS = 100;

async function initializeWaveformInternal(cue) {
    if (!waveformDisplayDiv || !cue || !cue.filePath) { // Simplified check, type check done by caller
        _destroyWaveformInternal(); // Use internal destroy
        return;
    }

    // Clear any pending initialization to avoid duplicate operations
    if (waveformInitTimeout) {
        clearTimeout(waveformInitTimeout);
        waveformInitTimeout = null;
    }

    // Debounce waveform initialization to prevent rapid successive calls
    waveformInitTimeout = setTimeout(async () => {
        await _performWaveformInitialization(cue);
    }, WAVEFORM_INIT_DEBOUNCE_MS);
}

async function _performWaveformInitialization(cue) {
    _destroyWaveformInternal(); 
    if (waveformDisplayDiv) {
        waveformDisplayDiv.style.display = 'block';
        waveformDisplayDiv.innerHTML = '<p style="color:gray; text-align:center; padding-top: 40px;">Preparing waveform display...</p>'; 
    }

    try {
        if (typeof WaveSurfer === 'undefined') { 
            console.error('WaveformControls: WaveSurfer is not loaded.'); 
            if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">Waveform library not loaded.</p>';
            return;
        }
        
        // Clear the container right before creating WaveSurfer instance
        if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = ''; 

        // Set up the audio URL
        let audioUrl = cue.filePath;
        if (!audioUrl.startsWith('file://')) {
            let normalizedPath = cue.filePath.replace(/\\/g, '/');
            audioUrl = normalizedPath.startsWith('/') ? 'file://' + normalizedPath : 'file:///' + normalizedPath;
        }
        
        // Store the current audio URL for use in expanded waveform
        currentAudioFilePath = audioUrl;
        console.log('WaveformControls: Stored current audio URL:', currentAudioFilePath);

        // Performance optimization: Use progressive loading for large files
        const isLargeFile = await _checkIfLargeAudioFile(audioUrl);
        
        // Create wavesurfer instance with optimized settings
        const waveformConfig = {
            container: waveformDisplayDiv,
            waveColor: 'rgb(85, 85, 85)',
            progressColor: 'rgb(120, 120, 120)',
            cursorColor: 'rgb(204, 204, 204)',
            height: 128,
            // Performance optimizations
            partialRender: true, 
            autoCenter: false,
            normalize: !isLargeFile, // Skip normalization for large files to improve performance
            pixelRatio: window.devicePixelRatio || 1,
            // Use lower quality for large files to improve performance
            barWidth: isLargeFile ? 2 : 1,
            barGap: isLargeFile ? 1 : 0,
            url: audioUrl,
            plugins: [ WaveSurfer.Regions.create({ 
                dragSelection: false, 
                regionClass: 'wavesurfer-region'
            }) ]
        };

        // Add progress callback for large files
        if (isLargeFile) {
            waveformConfig.progressColor = 'rgba(120, 120, 120, 0.8)';
        }

        console.log('WaveformControls: Creating WaveSurfer instance with optimized config:', waveformConfig);

        // Create instance in a non-blocking way
        await new Promise((resolve, reject) => {
            // Use setTimeout to allow UI to update
            setTimeout(() => {
                try {
                    console.log('WaveformControls: About to create WaveSurfer instance...');
                    wavesurferInstance = WaveSurfer.create(waveformConfig);
                    console.log('WaveformControls: WaveSurfer instance created:', wavesurferInstance);
                    
                    // Get regions plugin reference immediately after creation
                    console.log('WaveformControls: Looking for regions plugin...');
                    wsRegions = wavesurferInstance.getActivePlugins().find(plugin => 
                        plugin.constructor.name === 'RegionsPlugin' || 
                        plugin.constructor.name.includes('Region')
                    );
                    
                    if (!wsRegions) {
                        console.warn('WaveformControls: Regions plugin not found in active plugins');
                        console.log('WaveformControls: Active plugins:', wavesurferInstance.getActivePlugins().map(p => p.constructor.name));
                        
                        // Try alternative approaches to get regions
                        wsRegions = wavesurferInstance.plugins?.find(plugin => 
                            plugin.constructor.name === 'RegionsPlugin' ||
                            plugin.constructor.name.includes('Region')
                        );
                        console.log('WaveformControls: Alternative plugin search result:', wsRegions);
                        
                        // Try using the first plugin if only one exists
                        if (!wsRegions && wavesurferInstance.getActivePlugins().length === 1) {
                            wsRegions = wavesurferInstance.getActivePlugins()[0];
                            console.log('WaveformControls: Using first available plugin as regions:', wsRegions);
                        }
                        
                        // Try accessing via registry if available
                        if (!wsRegions && wavesurferInstance.plugins) {
                            console.log('WaveformControls: All plugins:', wavesurferInstance.plugins);
                            wsRegions = Object.values(wavesurferInstance.plugins).find(plugin => 
                                plugin && typeof plugin.addRegion === 'function'
                            );
                            console.log('WaveformControls: Plugin with addRegion method:', wsRegions);
                        }
                    }
                    
                    console.log('WaveformControls: Regions plugin found:', wsRegions ? 'Yes' : 'No');
                    if (wsRegions) {
                        console.log('WaveformControls: Regions plugin type:', wsRegions.constructor.name);
                        console.log('WaveformControls: Regions plugin methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(wsRegions)));
                    }
                    
                    // Set up event listeners for performance monitoring
                    wavesurferInstance.on('load', () => {
                        console.log('WaveformControls: Waveform loaded successfully');
                        resolve();
                    });
                    
                    wavesurferInstance.on('error', (error) => {
                        console.error('WaveformControls: WaveSurfer error:', error);
                        reject(error);
                    });
                    
                    // Performance optimization: Show loading progress for large files
                    if (isLargeFile) {
                        wavesurferInstance.on('loading', (percent) => {
                            if (waveformDisplayDiv) {
                                const progressBar = waveformDisplayDiv.querySelector('.waveform-progress');
                                if (progressBar) {
                                    progressBar.style.width = `${percent}%`;
        } else { 
                                    // Create progress bar if it doesn't exist
                                    const progressContainer = document.createElement('div');
                                    progressContainer.className = 'waveform-progress-container';
                                    progressContainer.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 80%; height: 4px; background: rgba(255,255,255,0.3); border-radius: 2px;';
                                    
                                    const progressBar = document.createElement('div');
                                    progressBar.className = 'waveform-progress';
                                    progressBar.style.cssText = `width: ${percent}%; height: 100%; background: rgb(120, 120, 120); border-radius: 2px; transition: width 0.3s ease;`;
                                    
                                    progressContainer.appendChild(progressBar);
                                    waveformDisplayDiv.appendChild(progressContainer);
                                }
                            }
                        });
                    }
                    
                } catch (error) {
                    reject(error);
                }
            }, 0);
        });

        // Additional optimizations after successful creation
        if (wavesurferInstance) {
            // Set up performance-optimized event handlers
            _setupOptimizedWaveformEvents(cue);
            
            // Clean up progress bar if it exists
            const progressContainer = waveformDisplayDiv.querySelector('.waveform-progress-container');
            if (progressContainer) {
                progressContainer.remove();
            }
            
            console.log('WaveformControls: Waveform initialization completed successfully');
        }

    } catch (error) {
        console.error('WaveformControls: Error initializing waveform:', error);
        if (waveformDisplayDiv) {
            waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">Critical error during waveform initialization.</p>';
        }
    }
}

// Helper function to check if audio file is large (for performance optimization)
async function _checkIfLargeAudioFile(audioUrl) {
    try {
        // Try to get file size if possible
        if (typeof electronAPIForPreload !== 'undefined' && electronAPIForPreload.getFileSize) {
            const fileSize = await electronAPIForPreload.getFileSize(audioUrl);
            return fileSize > 50 * 1024 * 1024; // 50MB threshold
        }
        
        // Fallback: assume it's large if we can't check
        return false;
    } catch (error) {
        console.warn('WaveformControls: Unable to check file size:', error);
        return false;
    }
}

// Optimized event handling for waveform
function _setupOptimizedWaveformEvents(cue) {
    console.log('WaveformControls: _setupOptimizedWaveformEvents called');
    console.log('WaveformControls: wavesurferInstance exists:', !!wavesurferInstance);
    console.log('WaveformControls: wsRegions exists:', !!wsRegions);
    
    if (!wavesurferInstance) return;
    
    // wsRegions should already be set during WaveSurfer creation
    if (!wsRegions) {
        console.warn('WaveformControls: wsRegions not available in _setupOptimizedWaveformEvents');
        return;
    }
    
    // Throttle seek events to prevent excessive calls
    let seekTimeout = null;
    
    // Initialize time displays once waveform is ready
    const updateInitialTimeDisplays = () => {
        console.log('WaveformControls: updateInitialTimeDisplays called');
        
        // CRITICAL: Check if instance still exists before calling methods
        if (!wavesurferInstance) {
            console.warn('WaveformControls: updateInitialTimeDisplays called but wavesurferInstance is null, skipping');
            return;
        }
        
        const duration = wavesurferInstance.getDuration();
        console.log('WaveformControls: Duration:', duration);
        if (wfTotalDuration && duration > 0) {
            wfTotalDuration.textContent = formatWaveformTime(duration);
            console.log('WaveformControls: Set total duration to:', formatWaveformTime(duration));
        }
        if (wfCurrentTime) {
            wfCurrentTime.textContent = formatWaveformTime(0);
            console.log('WaveformControls: Set current time to: 0:00.0');
        }
        if (wfRemainingTime) {
            wfRemainingTime.textContent = formatWaveformTime(-duration);
            console.log('WaveformControls: Set remaining time to:', formatWaveformTime(-duration));
        }
    };
    
    // Set up time display updates during playback
    wavesurferInstance.on('audioprocess', (currentTime) => {
        if (!wavesurferInstance) return; // Guard against race conditions
        console.log('WaveformControls: audioprocess event - currentTime:', currentTime);
                syncPlaybackTimeWithUI(currentTime);
            });
            
    // Update time displays on seek
    wavesurferInstance.on('seek', (seekProgress) => {
        if (!wavesurferInstance) return; // Guard against race conditions
        const duration = wavesurferInstance.getDuration();
        const currentTime = seekProgress * duration;
        console.log('WaveformControls: seek event - seekProgress:', seekProgress, 'currentTime:', currentTime);
        syncPlaybackTimeWithUI(currentTime);
    });
    
    // Update time displays when playback position changes
    wavesurferInstance.on('timeupdate', (currentTime) => {
        if (!wavesurferInstance) return; // Guard against race conditions
        console.log('WaveformControls: timeupdate event - currentTime:', currentTime);
                syncPlaybackTimeWithUI(currentTime);
            });
            
    // Initialize time displays when ready
    wavesurferInstance.on('ready', () => {
        console.log('WaveformControls: ready event fired');
        updateInitialTimeDisplays();
        
        // Load regions from cue data after waveform is ready
        if (cue) {
            console.log('WaveformControls: Loading regions from cue:', cue);
            loadRegionsFromCueInternal(cue);
        }
    });
    
    // Handle clicks for seeking
    wavesurferInstance.on('click', (relativeX) => {
        if (seekTimeout) {
            clearTimeout(seekTimeout);
        }
        
        seekTimeout = setTimeout(() => {
            if (!wavesurferInstance) return; // Guard against race conditions
            
            const duration = wavesurferInstance.getDuration();
            const seekTime = relativeX * duration;
            
            if (seekTime >= 0 && seekTime <= duration) {
                console.log('WaveformControls: Seeking to', seekTime);
                // Update time displays immediately for better responsiveness
                syncPlaybackTimeWithUI(seekTime);
                
                if (typeof seekInAudioController === 'function') {
                    seekInAudioController(cue.id, seekTime);
                }
            }
        }, 50); // 50ms debounce
    });
    
    // Region event handlers
    if (wsRegions) {
        console.log('WaveformControls: Setting up region event handlers...');
        
        // Handle when regions are created
        wsRegions.on('region-created', (region) => {
            if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
            console.log('WaveformControls: Region created event fired:', region.id);
            updateTrimInputsFromRegionInternal(region);
        });
        
        // Handle when regions are updated (dragged/resized)
        wsRegions.on('region-updated', (region) => {
            if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
            console.log('WaveformControls: Region updated event fired:', region.id);
            updateTrimInputsFromRegionInternal(region);
        });
        
        // Handle when region update ends (final position)
        wsRegions.on('region-update-end', (region) => {
            if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
            console.log('WaveformControls: Region update ended event fired:', region.id);
            updateTrimInputsFromRegionInternal(region);
        });
        
        // Handle when regions are removed
        wsRegions.on('region-removed', (region) => {
            if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
            console.log('WaveformControls: Region removed event fired:', region.id);
            updateTrimInputsFromRegionInternal(null);
        });
        
        // Handle region click events
        wsRegions.on('region-clicked', (region, event) => {
            if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
            console.log('WaveformControls: Region clicked event fired:', region.id);
            // Optionally seek to region start on click
            const duration = wavesurferInstance.getDuration();
            if (duration > 0) {
                wavesurferInstance.seekTo(region.start / duration);
            }
        });
        
        console.log('WaveformControls: Region event handlers setup completed');
    } else {
        console.warn('WaveformControls: wsRegions not available, cannot setup region events');
    }
    
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
                _handlePlaybackEndReached();
            });
            
    console.log('WaveformControls: Event listeners setup completed');
}

// Function to sync playback time with other UI elements
function syncPlaybackTimeWithUI(currentTime) {
    if (!wavesurferInstance) {
        console.warn('WaveformControls: syncPlaybackTimeWithUI called but wavesurferInstance is null');
        return;
    }
    
    const totalDuration = wavesurferInstance.getDuration();
    if (totalDuration === null || totalDuration === undefined || isNaN(totalDuration)) {
        console.warn('WaveformControls: syncPlaybackTimeWithUI - invalid duration, skipping');
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
    
    // Update the remaining time display (original duration - current time)
    if (wfRemainingTime) {
        const remainingTime = Math.max(0, totalDuration - currentTime);
        wfRemainingTime.textContent = '-' + formatWaveformTime(remainingTime);
    }
}

function _destroyWaveformInternal() {
    console.log('WaveformControls: _destroyWaveformInternal called');
    isDestroyingWaveform = true; // CRITICAL: Set flag to prevent callback loops
    
    if (wavesurferInstance) {
        try { 
            wavesurferInstance.destroy(); 
            console.log('WaveformControls: wavesurferInstance destroyed successfully');
        } catch (e) { 
            console.warn("WaveformControls: Error destroying wavesurfer:", e); 
        }
        wavesurferInstance = null; 
        wsRegions = null;
        currentLiveTrimRegion = null; // ADDED: Reset live region
        currentAudioFilePath = null; // Clear the stored audio file path
    }
    if (waveformDisplayDiv) { 
        waveformDisplayDiv.innerHTML = ''; 
        console.log('WaveformControls: waveformDisplayDiv cleared');
    }
    
    // Reset flag after a delay to allow any pending events to finish
    setTimeout(() => {
        isDestroyingWaveform = false;
        console.log('WaveformControls: destruction flag reset');
    }, 100);
}

function loadRegionsFromCueInternal(cue) {
    if (!wsRegions || !wavesurferInstance) {
        console.warn("WaveformControls: Cannot load regions, wsRegions or wavesurferInstance not ready.");
        return;
    }
    console.log("WaveformControls: Clearing all regions before loading from cue.");
    wsRegions.clearRegions(); 
    currentLiveTrimRegion = null; // ADDED: Reset live region

    const totalDuration = wavesurferInstance.getDuration();
    let trimStart = cue.trimStartTime !== undefined ? parseFloat(cue.trimStartTime) : 0;
    let trimEnd = cue.trimEndTime !== undefined ? parseFloat(cue.trimEndTime) : totalDuration;

    if (trimEnd <= 0 || trimEnd > totalDuration) trimEnd = totalDuration;
    if (trimStart < 0) trimStart = 0;
    if (trimStart >= trimEnd) { 
        console.warn(`WaveformControls: Invalid trim times from cue (start ${trimStart}, end ${trimEnd}). Resetting to full duration.`);
        trimStart = 0; 
        trimEnd = totalDuration; 
    }

    if (trimStart > 0 || trimEnd < totalDuration) {
        console.log(`WaveformControls: Adding trimRegion from cue: Start=${trimStart}, End=${trimEnd}`);
        // Store the returned region instance
        currentLiveTrimRegion = wsRegions.addRegion({ 
            id: 'trimRegion', 
            start: trimStart, 
            end: trimEnd, 
            color: 'rgba(0, 0, 0, 0)', // Transparent - no visual overlay
            drag: true, 
            resize: true 
        });
    } else {
        console.log("WaveformControls: Cue trim is full duration, no trimRegion added initially.");
        styleRegionsInternal(); 
    }
}

function handleSetTrimStart() {
    console.log('WaveformControls: handleSetTrimStart called');
    console.log('WaveformControls: wavesurferInstance exists:', !!wavesurferInstance);
    console.log('WaveformControls: wsRegions exists:', !!wsRegions);
    
    if (!wavesurferInstance || !wsRegions) {
        console.error('WaveformControls: Cannot set trim start - missing wavesurferInstance or wsRegions');
        return;
    }
    
    const currentTime = wavesurferInstance.getCurrentTime();
    console.log('WaveformControls: handleSetTrimStart - FORCING REMOVE/ADD. Current time:', currentTime);

    // Attempt to remove existing region with id 'trimRegion'
    const regions = wsRegions.getRegions(); 
    console.log('WaveformControls: Current regions:', regions);
    const oldRegionInstance = Array.isArray(regions) ? regions.find(r => r.id === 'trimRegion') : (regions ? regions['trimRegion'] : null);
    console.log('WaveformControls: Old region instance:', oldRegionInstance);
    
    if (oldRegionInstance && typeof oldRegionInstance.remove === 'function') {
        try { 
            oldRegionInstance.remove(); 
            console.log('Force-removed old trimRegion (start)'); 
        } 
        catch (e) { 
            console.warn('Error force-removing old trimRegion (start):', e); 
        }
    } else if (oldRegionInstance) {
        console.warn('Old trimRegion found but no remove method (start)');
        // Potentially try wsRegions.clearRegions() if desperate, but that clears all regions.
    } else {
        console.log('No old trimRegion found to remove (start).');
    }
    currentLiveTrimRegion = null; 

    // Define new region boundaries
    const totalDur = wavesurferInstance.getDuration();
    console.log('WaveformControls: Total duration:', totalDur);
    let newStart = currentTime;
    let newEnd = totalDur; // Default to full duration if an old end isn't available or makes sense
    
    // If we had an old region, try to use its end time, otherwise full duration or a small increment.
    if (oldRegionInstance && oldRegionInstance.end !== undefined) {
        newEnd = oldRegionInstance.end;
        console.log('WaveformControls: Using old region end:', newEnd);
    } else {
        newEnd = totalDur > 0 ? totalDur : currentTime + 0.1;
        console.log('WaveformControls: Using total duration as end:', newEnd);
    }

    if (newEnd <= newStart) {
        newEnd = Math.min(newStart + 0.1, totalDur > 0 ? totalDur : newStart + 0.1);
        if (newStart >= newEnd && totalDur > 0) {
             newStart = Math.max(0, newEnd - 0.1);
        } else if (newStart >= newEnd) {
             newStart = 0; 
             newEnd = Math.min(0.1, totalDur > 0 ? totalDur : 0.1);
        }
    }
    if (newStart < 0) newStart = 0;
    if (newEnd > totalDur && totalDur > 0) newEnd = totalDur;
    if (newStart >= newEnd) { // Final sanity check
        newStart = 0; newEnd = totalDur > 0 ? totalDur : 0.1;
    }

    console.log('Force Add: New region (start). Start:', newStart.toFixed(3), ', end:', newEnd.toFixed(3));
    
    try {
    currentLiveTrimRegion = wsRegions.addRegion({
        id: 'trimRegion',
        start: newStart,
        end: newEnd,
        color: 'rgba(0, 0, 0, 0)', // Transparent - no visual overlay
        drag: true,
        resize: true,
    });
        
        console.log('WaveformControls: Region creation result:', currentLiveTrimRegion);
        
    if (currentLiveTrimRegion) {
        console.log(`WFC_DEBUG SetStart: Region added. Start: ${currentLiveTrimRegion.start.toFixed(3)}, End: ${currentLiveTrimRegion.end.toFixed(3)}`);
        if (typeof onTrimChangeCallback === 'function') {
            console.log(`WFC_DEBUG SetStart: PRE onTrimChangeCallback with Start: ${currentLiveTrimRegion.start.toFixed(3)}, End: ${currentLiveTrimRegion.end.toFixed(3)}`);
            onTrimChangeCallback(currentLiveTrimRegion.start, currentLiveTrimRegion.end);
            console.log(`WFC_DEBUG SetStart: POST onTrimChangeCallback`);
        } else {
            console.warn('WFC_DEBUG SetStart: onTrimChangeCallback is not a function here.');
        }
    } else {
        console.warn('WFC_DEBUG SetStart: wsRegions.addRegion did not return a region.');
        }
    } catch (error) {
        console.error('WaveformControls: Error creating region:', error);
    }
    // 'region-created' event should fire here, which also calls updateTrimInputsFromRegionInternal
}

function handleSetTrimEnd() {
    if (!wavesurferInstance || !wsRegions) return;
    const currentTime = wavesurferInstance.getCurrentTime();
    console.log('WaveformControls: handleSetTrimEnd - FORCING REMOVE/ADD. Current time:', currentTime);

    // Attempt to remove existing region with id 'trimRegion'
    const regions = wsRegions.getRegions();
    const oldRegionInstance = Array.isArray(regions) ? regions.find(r => r.id === 'trimRegion') : (regions ? regions['trimRegion'] : null);
    if (oldRegionInstance && typeof oldRegionInstance.remove === 'function') {
        try { oldRegionInstance.remove(); console.log('Force-removed old trimRegion (end)'); }
        catch (e) { console.warn('Error force-removing old trimRegion (end):', e); }
    } else if (oldRegionInstance) {
        console.warn('Old trimRegion found but no remove method (end)');
    } else {
        console.log('No old trimRegion found to remove (end).');
    }
    currentLiveTrimRegion = null;

    // Define new region boundaries
    const totalDur = wavesurferInstance.getDuration();
    let newStart = 0; // Default to 0 if an old start isn't available
    let newEnd = currentTime;

    if (oldRegionInstance && oldRegionInstance.start !== undefined) {
        newStart = oldRegionInstance.start;
    } 

    if (newStart >= newEnd) {
        newStart = Math.max(0, newEnd - 0.1);
        if (newStart >= newEnd && newEnd > 0) { // if newEnd is 0, newStart can be 0
             newEnd = Math.min(totalDur > 0 ? totalDur : newStart + 0.1, newStart + 0.1);
        } else if (newStart >= newEnd) {
            newStart = 0;
            newEnd = Math.min(0.1, totalDur > 0 ? totalDur : 0.1);
        }
    }
    if (newStart < 0) newStart = 0;
    if (newEnd > totalDur && totalDur > 0) newEnd = totalDur;
    if (newStart >= newEnd && newEnd > 0) { // Final sanity, ensure end is after start if not 0
        newStart = Math.max(0, newEnd-0.1);
    } else if (newStart >= newEnd) { // if newEnd is 0 or less
        newEnd = newStart + 0.1; 
        if(newEnd > totalDur && totalDur > 0) newEnd = totalDur;
    }


    console.log('Force Add: New region (end). Start:', newStart.toFixed(3), ', end:', newEnd.toFixed(3));
    currentLiveTrimRegion = wsRegions.addRegion({
        id: 'trimRegion',
        start: newStart,
        end: newEnd,
        color: 'rgba(0, 0, 0, 0)', // Transparent - no visual overlay
        drag: true,
        resize: true,
    });
    if (currentLiveTrimRegion) {
        console.log(`WFC_DEBUG SetEnd: Region added. Start: ${currentLiveTrimRegion.start.toFixed(3)}, End: ${currentLiveTrimRegion.end.toFixed(3)}`);
        if (typeof onTrimChangeCallback === 'function') {
            console.log(`WFC_DEBUG SetEnd: PRE onTrimChangeCallback with Start: ${currentLiveTrimRegion.start.toFixed(3)}, End: ${currentLiveTrimRegion.end.toFixed(3)}`);
            onTrimChangeCallback(currentLiveTrimRegion.start, currentLiveTrimRegion.end);
            console.log(`WFC_DEBUG SetEnd: POST onTrimChangeCallback`);
        } else {
            console.warn('WFC_DEBUG SetEnd: onTrimChangeCallback is not a function here.');
        }
    } else {
        console.warn('WFC_DEBUG SetEnd: wsRegions.addRegion did not return a region.');
    }
    // 'region-created' event should fire here, which also calls updateTrimInputsFromRegionInternal
}

function handleClearTrim() {
    console.log('WaveformControls: handleClearTrim called');
    
    if (!wavesurferInstance || !wsRegions) {
        console.warn('WaveformControls: Cannot clear trim - missing wavesurferInstance or wsRegions');
        return;
    }
    
    // Remove all trim regions
    const regions = wsRegions.getRegions();
    const trimRegion = Array.isArray(regions) ? regions.find(r => r.id === 'trimRegion') : (regions ? regions['trimRegion'] : null);
    
    if (trimRegion && typeof trimRegion.remove === 'function') {
        try {
            trimRegion.remove();
            console.log('WaveformControls: Trim region removed');
            currentLiveTrimRegion = null;
            
            // Notify that the trim has been cleared (full duration)
            const totalDuration = wavesurferInstance.getDuration();
            if (typeof onTrimChangeCallback === 'function') {
                onTrimChangeCallback(0, totalDuration);
                console.log('WaveformControls: Notified callback of trim clear');
            }
        } catch (error) {
            console.error('WaveformControls: Error removing trim region:', error);
        }
    } else {
        console.log('WaveformControls: No trim region found to clear');
    }
}

// Added function to notify sidebars module
function notifyCuePropertiesPanelOfTrimChange(trimStart, trimEnd) {
    console.log(`WaveformControls (notifyCuePropertiesPanelOfTrimChange): CALLED. Start: ${trimStart}, End: ${trimEnd}`);
    
    // CRITICAL: Prevent callback loops during waveform destruction
    if (isDestroyingWaveform) {
        console.log('WaveformControls (notifyCuePropertiesPanelOfTrimChange): Skipping callback - waveform is being destroyed');
        return;
    }
    
    if (onTrimChangeCallback) { // ADDED: Use the callback
        console.log('WaveformControls (notifyCuePropertiesPanelOfTrimChange): Calling onTrimChangeCallback (sidebars.handleCuePropertyChangeFromWaveform)');
        onTrimChangeCallback(trimStart, trimEnd); // This updates sidebar inputs & triggers save
    } else {
        console.warn('WaveformControls (notifyCuePropertiesPanelOfTrimChange): onTrimChangeCallback is not defined. Cannot update sidebar inputs or trigger save.');
    }

    // NOTE: Do NOT update wfTotalDuration here - waveform bottom times should always show original time
    // The trimmed duration will be reflected in the cue button times via the callback above
    // wfCurrentTime and wfRemainingTime are updated by 'audioprocess' or 'seek' events and show original times
}

function updateTrimInputsFromRegionInternal(region) {
    // CRITICAL: Prevent callback loops during waveform destruction
    if (isDestroyingWaveform) {
        console.log('WaveformControls (updateTrimInputsFromRegionInternal): Skipping update - waveform is being destroyed');
        return;
    }
    
    if (region && region.id === 'trimRegion') {
        console.log(`WaveformControls (updateTrimInputsFromRegionInternal): CALLED for trimRegion. ID: ${region.id}, Start: ${region.start.toFixed(3)}, End: ${region.end.toFixed(3)}`);
        notifyCuePropertiesPanelOfTrimChange(region.start, region.end);
    } else if (!region && wsRegions) { // Simpler check: if region is null but wsRegions exists
        const allRegions = wsRegions.getRegions();
        if (!allRegions['trimRegion']) { // Check if 'trimRegion' specifically is gone
            console.log('WaveformControls (updateTrimInputsFromRegionInternal): trimRegion removed. Effective trim is full duration.');
            const totalDuration = wavesurferInstance ? wavesurferInstance.getDuration() : 0;
            notifyCuePropertiesPanelOfTrimChange(0, totalDuration); 
        }
    } else {
        console.log('WaveformControls (updateTrimInputsFromRegionInternal): called with non-trimRegion or no region change relevant to trim inputs.', region ? region.id : 'no region', wsRegions ? Object.keys(wsRegions.getRegions()) : 'no wsRegions');
    }
}

const MIN_REGION_DURATION = 0.01; // seconds, to avoid issues with zero-width regions

function styleRegionsInternal() {
    if (!wavesurferInstance || !wsRegions) {
        console.warn("WaveformControls: styleRegionsInternal - wsRegions or wavesurferInstance not ready.");
        return;
    }
    const allCurrentRegions = wsRegions.getRegions();
    console.log("WaveformControls: styleRegionsInternal invoked. Current regions before styling:", allCurrentRegions.map(r => r.id));

    // Remove any existing dimming regions
    allCurrentRegions.forEach(reg => {
        if (reg.id !== 'trimRegion') {
            console.log(`WaveformControls: Removing old dimming region: ${reg.id}`);
            try { reg.remove(); } catch (e) { console.warn(`WaveformControls: Minor error removing ${reg.id}`, e); }
        }
    });
    
    // Set the trimRegion to be more visible if it exists
    const trimRegion = wsRegions.getRegions().find(r => r.id === 'trimRegion');
    if (trimRegion && trimRegion.element) {
        trimRegion.element.style.zIndex = '3';
        
        // Update the trimRegion color to be transparent (no visual overlay)
        trimRegion.color = 'rgba(0, 0, 0, 0)';
        trimRegion.update();
    }
    
    console.log("WaveformControls: styleRegionsInternal completed. Current regions after styling:", wsRegions.getRegions().map(r => r.id));
}

// --- Public API ---
// These functions will be called by sidebarManager.js

/**
 * Public interface to initialize or re-initialize the waveform for a cue.
 * @param {object} cue - The cue object.
 */
async function showWaveformForCue(cue) {
    console.log('WaveformControls: showWaveformForCue called with cue:', cue);
    
    if (!waveformDisplayDiv) { 
        console.error("WaveformControls: DOM not cached - waveformDisplayDiv not found."); 
        return; 
    }
    
    if (!cue || !cue.filePath || (cue.type && cue.type === 'playlist')) {
        console.log('WaveformControls: Hiding waveform - no cue, no filePath, or playlist type');
        _destroyWaveformInternal(); 
        if(waveformDisplayDiv) waveformDisplayDiv.style.display = 'none';
        return;
    }
    
    console.log('WaveformControls: Initializing waveform for cue:', cue.id, 'filePath:', cue.filePath);
    return initializeWaveformInternal(cue);
}

/**
 * Public interface to destroy the waveform.
 */
function hideAndDestroyWaveform() {
    _destroyWaveformInternal();
    if(waveformDisplayDiv) waveformDisplayDiv.style.display = 'none';
}

/**
 * Gets the current trim start and end times from the waveform region.
 * Returns null if no wavesurfer instance or no trimRegion exists.
 * @returns {{trimStartTime: number, trimEndTime: number} | null}
 */
function getCurrentTrimTimes() {
    if (wavesurferInstance && wsRegions) {
        const trimRegion = wsRegions.getRegions().find(r => r.id === 'trimRegion');
        if (trimRegion) {
            return {
                trimStartTime: trimRegion.start,
                trimEndTime: trimRegion.end
            };
        }
    }
    return null; 
}

// --- Public API / Exports ---

// Test function for debugging - can be called from console: window.waveformTest()
window.waveformTest = function() {
    console.log('=== WAVEFORM TEST ===');
    console.log('wavesurferInstance exists:', !!wavesurferInstance);
    console.log('wsRegions exists:', !!wsRegions);
    console.log('onTrimChangeCallback exists:', !!onTrimChangeCallback);
    
    if (wavesurferInstance) {
        console.log('Waveform duration:', wavesurferInstance.getDuration());
        console.log('Waveform current time:', wavesurferInstance.getCurrentTime());
        
        if (wsRegions) {
            console.log('Current regions:', wsRegions.getRegions());
            
            // Try to create a test region
            try {
                const testRegion = wsRegions.addRegion({
                    id: 'test-region',
                    start: 1.0,
                    end: 3.0,
                    color: 'rgba(255, 0, 0, 0.3)',
                    drag: true,
                    resize: true
                });
                console.log('Test region created:', testRegion);
            } catch (error) {
                console.error('Error creating test region:', error);
            }
        }
    }
    
    // Test DOM elements
    console.log('DOM Elements:');
    console.log('  wfSetStartBtn:', !!wfSetStartBtn);
    console.log('  wfSetEndBtn:', !!wfSetEndBtn);
    console.log('  wfCurrentTime:', !!wfCurrentTime);
    console.log('  wfTotalDuration:', !!wfTotalDuration);
    console.log('  wfRemainingTime:', !!wfRemainingTime);
};

// --- Bottom Panel Functions ---

/**
 * Expands the bottom waveform panel for enhanced editing
 */
function expandBottomPanel() {
    if (!wavesurferInstance) {
        console.warn('WaveformControls: No waveform instance available, cannot expand bottom panel');
        return;
    }
    
    if (!currentAudioFilePath) {
        console.warn('WaveformControls: No audio file loaded, cannot expand bottom panel');
        return;
    }
    
    console.log('WaveformControls: Expanding bottom panel');
    console.log('WaveformControls: Current audio file path:', currentAudioFilePath);
    console.log('WaveformControls: Main waveform instance:', wavesurferInstance);
    
    // Debug: Check if main waveform has trim regions
    if (wsRegions) {
        const mainRegions = wsRegions.getRegions();
        const trimRegion = Array.isArray(mainRegions) ? 
            mainRegions.find(r => r.id === 'trimRegion') : 
            (mainRegions ? mainRegions['trimRegion'] : null);
        console.log('WaveformControls: Main waveform trim region:', trimRegion ? {
            start: trimRegion.start,
            end: trimRegion.end
        } : 'None');
    } else {
        console.log('WaveformControls: No wsRegions available in main waveform');
    }
    
    // Clean up any existing expanded waveform first
    if (expandedWaveformInstance) {
        try {
            expandedWaveformInstance.destroy();
        } catch (error) {
            console.warn('WaveformControls: Error destroying previous expanded waveform:', error);
        }
        expandedWaveformInstance = null;
    }
    
    // Clear the display
    if (expandedWaveformDisplay) {
        expandedWaveformDisplay.innerHTML = '';
    }
    
    // Update panel state
    isBottomPanelExpanded = true;
    
    // Update UI
    if (bottomWaveformPanel) {
        // Force show the panel with correct height
        const panelHeight = bottomPanelSize === 'large' ? 450 : 400;
        bottomWaveformPanel.style.height = panelHeight + 'px';
        bottomWaveformPanel.style.display = 'flex';
        bottomWaveformPanel.classList.add('expanded');
        
        // Update panel title with current cue info
        if (bottomPanelCueName) {
            bottomPanelCueName.textContent = 'Waveform Editor';
        }
        
        // Update size buttons
        updateSizeButtons();
        
        // Create expanded waveform
        createExpandedWaveform();
    } else {
        console.error('WaveformControls: bottomWaveformPanel not found');
    }
}

/**
 * Collapses the bottom waveform panel
 */
function collapseBottomPanel() {
    console.log('WaveformControls: Collapsing bottom panel');
    
    // Update panel state
    isBottomPanelExpanded = false;
    
    // Clean up expanded waveform if it exists
    if (expandedWaveformInstance) {
        try {
            expandedWaveformInstance.destroy();
        } catch (error) {
            console.warn('WaveformControls: Error destroying expanded waveform:', error);
        }
        expandedWaveformInstance = null;
    }
    
    // Clean up regions reference
    if (window.expandedWsRegions) {
        // Try to clear any remaining regions
        try {
            const regions = window.expandedWsRegions.getRegions();
            const cutStartRegion = regions.find(r => r.id === 'expandedCutStart');
            const cutEndRegion = regions.find(r => r.id === 'expandedCutEnd');
            
            if (cutStartRegion) cutStartRegion.remove();
            if (cutEndRegion) cutEndRegion.remove();
        } catch (error) {
            console.warn('WaveformControls: Error cleaning up regions:', error);
        }
        
        window.expandedWsRegions = null;
    }
    
    // Clear the expanded waveform display completely
    if (expandedWaveformDisplay) {
        expandedWaveformDisplay.innerHTML = '';
        expandedWaveformDisplay.style.height = '0px';
        // Remove zoom setup marker so it can be set up again
        expandedWaveformDisplay.removeAttribute('data-zoom-setup');
    }
    
    // Update UI - force hide the panel
    if (bottomWaveformPanel) {
        bottomWaveformPanel.classList.remove('expanded', 'large');
        bottomWaveformPanel.style.height = '0px'; // Force collapse
        bottomWaveformPanel.style.display = 'flex'; // Keep flex but collapsed
        bottomWaveformPanel.style.overflow = 'hidden'; // Ensure nothing shows through
    }
    
    console.log('WaveformControls: Cleaned up expanded waveform and sync listeners');
}

/**
 * Sets the size of the bottom waveform panel
 * @param {string} size - 'normal' or 'large'
 */
function setBottomPanelSize(size) {
    console.log('WaveformControls: Setting bottom panel size to:', size);
    
    bottomPanelSize = size;
    
    if (bottomWaveformPanel) {
        if (size === 'large') {
            bottomWaveformPanel.classList.add('large');
        } else {
            bottomWaveformPanel.classList.remove('large');
        }
        
        // Force the container height immediately
        const panelHeight = size === 'large' ? 450 : 400;
        bottomWaveformPanel.style.height = panelHeight + 'px';
        console.log('WaveformControls: Forced bottom panel height to:', panelHeight + 'px');
    }
    
    updateSizeButtons();
    
    // Update existing expanded waveform height if it exists
    if (isBottomPanelExpanded && expandedWaveformInstance) {
        const newHeight = size === 'large' ? 280 : 250;
        console.log('WaveformControls: Updating expanded waveform height to:', newHeight);
        
        // Force the waveform display height
        if (expandedWaveformDisplay) {
            expandedWaveformDisplay.style.height = newHeight + 'px';
        }
        
        // Update the WaveSurfer height
        if (expandedWaveformInstance.setHeight) {
            expandedWaveformInstance.setHeight(newHeight);
        } else {
            // Fallback: recreate if setHeight is not available
            createExpandedWaveform();
        }
    }
}

/**
 * Updates the size button states
 */
function updateSizeButtons() {
    if (normalSizeBtn) {
        normalSizeBtn.classList.toggle('active', bottomPanelSize === 'normal');
    }
    if (largeSizeBtn) {
        largeSizeBtn.classList.toggle('active', bottomPanelSize === 'large');
    }
}

/**
 * Creates the expanded waveform in the bottom panel
 */
let expandedWaveformInstance = null;

function createExpandedWaveform() {
    if (!expandedWaveformDisplay || !wavesurferInstance) return;
    
    console.log('WaveformControls: Creating expanded waveform');
    
    try {
        // Clean up existing expanded waveform
        if (expandedWaveformInstance) {
            expandedWaveformInstance.destroy();
            expandedWaveformInstance = null;
        }
        
        // Clear the expanded waveform display
        expandedWaveformDisplay.innerHTML = '';
        
        // Ensure container is properly sized and visible
        const waveformHeight = bottomPanelSize === 'large' ? 280 : 250;
        expandedWaveformDisplay.style.height = waveformHeight + 'px';
        expandedWaveformDisplay.style.width = '100%';
        expandedWaveformDisplay.style.display = 'block';
        
        console.log('WaveformControls: Setting expanded waveform height to:', waveformHeight + 'px', 'for size:', bottomPanelSize);
        
        // Wait for DOM to update
        setTimeout(() => {
            createExpandedWaveformDelayed(waveformHeight);
        }, 50);
        
    } catch (error) {
        console.error('WaveformControls: Error in createExpandedWaveform:', error);
        if (expandedWaveformDisplay) {
            expandedWaveformDisplay.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ff6b6b; font-size: 14px;">Failed to create expanded waveform</div>';
        }
    }
}

function createExpandedWaveformDelayed(waveformHeight) {
    // Check container dimensions after DOM update
    const containerRect = expandedWaveformDisplay.getBoundingClientRect();
    console.log('WaveformControls: Container dimensions after setup:', containerRect.width, 'x', containerRect.height);
    
    if (containerRect.width === 0 || containerRect.height === 0) {
        console.error('WaveformControls: Container has zero dimensions, cannot create waveform');
        expandedWaveformDisplay.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ff6b6b; font-size: 14px;">Container not ready</div>';
        return;
    }
        
    // Create simplified WaveSurfer instance
    console.log('WaveformControls: Creating WaveSurfer instance with height:', waveformHeight);
    
    try {
        expandedWaveformInstance = WaveSurfer.create({
            container: expandedWaveformDisplay,
            waveColor: 'rgb(85, 85, 85)', // Light gray same as smaller editor 
            progressColor: 'rgb(120, 120, 120)', // Darker gray same as smaller editor
            cursorColor: 'rgb(204, 204, 204)', // Light gray cursor same as smaller editor
            height: waveformHeight,
            normalize: true,
            pixelRatio: 1,
            barWidth: 2,
            barGap: 1,
            plugins: [
                WaveSurfer.Regions.create({
                    dragSelection: false // Disable drag selection but allow regions
                })
            ]
        });
        
        console.log('WaveformControls: WaveSurfer instance created, loading audio...');
        
        // Load the audio file
        if (currentAudioFilePath) {
            expandedWaveformInstance.load(currentAudioFilePath);
            console.log('WaveformControls: Audio loading initiated for:', currentAudioFilePath);
        } else {
            throw new Error('No audio file path available');
        }
        
    } catch (error) {
        console.error('WaveformControls: Error creating/loading WaveSurfer:', error);
        expandedWaveformDisplay.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ff6b6b; font-size: 14px;">Error: ' + error.message + '</div>';
        return;
    }
    // Set up event listeners for the expanded waveform
    setupExpandedWaveformEvents();
}

function setupExpandedWaveformEvents() {
    if (!expandedWaveformInstance) return;
    
    console.log('WaveformControls: Setting up expanded waveform event listeners');
    
    // Handle ready event
    expandedWaveformInstance.on('ready', () => {
        console.log('WaveformControls: Expanded waveform ready');
        
        // Debug: Check if waveform canvas exists and set up zoom
        setTimeout(() => {
            const canvas = expandedWaveformDisplay.querySelector('canvas');
            if (canvas) {
                console.log('WaveformControls: SUCCESS - Canvas found after ready event:', canvas.width, 'x', canvas.height);
                console.log('WaveformControls: Canvas is visible:', canvas.offsetWidth > 0 && canvas.offsetHeight > 0);
                
                // Set up zoom functionality for expanded waveform
                setupExpandedWaveformZoom();
            } else {
                console.error('WaveformControls: ERROR - No canvas found after ready event!');
                console.log('WaveformControls: Container HTML:', expandedWaveformDisplay.innerHTML);
                console.log('WaveformControls: Container children:', expandedWaveformDisplay.children.length);
            }
        }, 100);
        
        // Set up regions for visual trim feedback with retry logic
        setTimeout(() => {
            console.log('WaveformControls: About to setup regions after 300ms delay');
            const duration = expandedWaveformInstance.getDuration();
            console.log('WaveformControls: Duration available at 300ms:', duration);
            
            if (duration && duration > 0) {
                setupExpandedWaveformRegionsAfterReady();
            } else {
                console.log('WaveformControls: Duration not ready, retrying in 500ms');
                setTimeout(() => {
                    setupExpandedWaveformRegionsAfterReady();
                }, 500);
            }
        }, 300);
        
        // Set up time display updates
        expandedWaveformInstance.on('audioprocess', updateExpandedTimeDisplay);
        expandedWaveformInstance.on('seek', updateExpandedTimeDisplay);
        
        // Handle clicks on expanded waveform for seeking (sync both waveforms)
        expandedWaveformInstance.on('click', (relativeX) => {
            if (!expandedWaveformInstance || !wavesurferInstance) return;
            
            const expandedDuration = expandedWaveformInstance.getDuration();
            const clickTime = relativeX * expandedDuration;
            
            console.log('WaveformControls: Expanded waveform clicked at time:', clickTime);
            
            // Seek the main waveform (which controls audio)
            const mainDuration = wavesurferInstance.getDuration();
            if (mainDuration > 0) {
                const seekPosition = clickTime / mainDuration;
                wavesurferInstance.seekTo(seekPosition);
                console.log('WaveformControls: Main waveform seeked to:', clickTime);
            }
            
            // The main waveform sync will update the expanded waveform automatically
        });
        
        // Sync with main waveform
        setupWaveformSync();
        
        // Update time display initially
        updateExpandedTimeDisplay();
    });
    
    // Handle loading events
    expandedWaveformInstance.on('loading', (percent) => {
        console.log('WaveformControls: Loading progress:', percent + '%');
    });
    
    // Handle load completion
    expandedWaveformInstance.on('load', () => {
        console.log('WaveformControls: Audio loaded successfully');
    });
    
    // Handle errors
    expandedWaveformInstance.on('error', (error) => {
        console.error('WaveformControls: Expanded waveform error:', error);
        expandedWaveformDisplay.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ff6b6b; font-size: 14px;">Error: ' + (error.message || 'Unknown error') + '</div>';
    });
    
}

/**
 * Sets up regions for visual trim feedback on the expanded waveform
 */
function setupExpandedWaveformRegions() {
    if (!expandedWaveformInstance) return;
    
    console.log('WaveformControls: Setting up expanded waveform regions');
    
    // Set up regions after the waveform is ready - done in ready event handler
    console.log('WaveformControls: Regions setup will be handled in ready event');
}

/**
 * Sets up regions after the expanded waveform is ready and plugins are initialized
 */
function setupExpandedWaveformRegionsAfterReady() {
    if (!expandedWaveformInstance) {
        console.warn('WaveformControls: No expanded waveform instance for regions setup');
        return;
    }
    
    console.log('WaveformControls: Setting up expanded waveform regions after ready');
    
    // Try multiple approaches to get the regions plugin
    let expandedWsRegions = null;
    
    try {
        // Approach 1: Active plugins
        const activePlugins = expandedWaveformInstance.getActivePlugins();
        console.log('WaveformControls: Active plugins:', activePlugins.map(p => p.constructor.name));
        
        expandedWsRegions = activePlugins.find(plugin =>
            plugin.constructor.name === 'RegionsPlugin' || 
            plugin.constructor.name.includes('Region')
        );
        
        // Approach 2: Check each active plugin for region methods
        if (!expandedWsRegions) {
            expandedWsRegions = activePlugins.find(plugin => 
                plugin && (typeof plugin.add === 'function' || typeof plugin.addRegion === 'function')
            );
        }
        
        // Approach 3: Direct access
        if (!expandedWsRegions) {
            if (expandedWaveformInstance.regions) {
                expandedWsRegions = expandedWaveformInstance.regions;
            }
        }
        
        console.log('WaveformControls: Found regions plugin:', !!expandedWsRegions);
        
        if (expandedWsRegions) {
            // Store reference for later use
            window.expandedWsRegions = expandedWsRegions;
            
            // Copy trim region from main waveform if it exists
            if (wsRegions) {
                const mainRegions = wsRegions.getRegions();
                const trimRegion = Array.isArray(mainRegions) ? 
                    mainRegions.find(r => r.id === 'trimRegion') : 
                    (mainRegions ? mainRegions['trimRegion'] : null);
                
                if (trimRegion) {
                    console.log('WaveformControls: Adding cut regions to expanded waveform:', {
                        trimStart: trimRegion.start,
                        trimEnd: trimRegion.end
                    });
                    
                    try {
                        // Use add method if available, otherwise addRegion
                        const addMethod = expandedWsRegions.add || expandedWsRegions.addRegion;
                        if (addMethod) {
                            const totalDuration = expandedWaveformInstance.getDuration();
                            console.log('WaveformControls: Initial setup - Total duration:', totalDuration);
                            
                            if (!totalDuration || totalDuration <= 0) {
                                console.warn('WaveformControls: Invalid total duration during initial setup, cannot create cut regions');
                                return;
                            }
                            
                            // Add region from start to trim start (beginning cut region)
                            if (trimRegion.start > 0) {
                                addMethod.call(expandedWsRegions, {
                                    id: 'expandedCutStart',
                                    start: 0,
                                    end: trimRegion.start,
                                    color: 'rgba(85, 85, 85, 0.7)', // Dark gray with 70% opacity
                                    resize: false, 
                                    drag: false
                                });
                                console.log('WaveformControls: Added start cut region (0 to', trimRegion.start + ')');
                            }
                            
                            // Add region from trim end to total duration (ending cut region)
                            if (trimRegion.end < totalDuration) {
                                addMethod.call(expandedWsRegions, {
                                    id: 'expandedCutEnd',
                                    start: trimRegion.end,
                                    end: totalDuration,
                                    color: 'rgba(85, 85, 85, 0.7)', // Dark gray with 70% opacity
                                    resize: false, 
                                    drag: false
                                });
                                console.log('WaveformControls: Added end cut region (' + trimRegion.end + ' to', totalDuration + ')');
                            }
                            
                            console.log('WaveformControls: SUCCESS - Expanded cut regions added');
                        } else {
                            console.warn('WaveformControls: No add method found on regions plugin');
                        }
                    } catch (error) {
                        console.error('WaveformControls: Error adding expanded cut regions:', error);
                    }
                } else {
                    console.log('WaveformControls: No trim region in main waveform to copy');
                }
            } else {
                console.log('WaveformControls: No main waveform regions available');
            }
        } else {
            console.warn('WaveformControls: Could not find regions plugin in expanded waveform');
        }
        
    } catch (error) {
        console.error('WaveformControls: Error in regions setup:', error);
    }
}

/**
 * Syncs trim regions between main and expanded waveforms
 */
function syncTrimRegions() {
    if (!wsRegions || !window.expandedWsRegions || !expandedWaveformInstance || !isBottomPanelExpanded) {
        console.warn('WaveformControls: Cannot sync trim regions - missing dependencies:', {
            wsRegions: !!wsRegions,
            expandedWsRegions: !!window.expandedWsRegions,
            expandedWaveformInstance: !!expandedWaveformInstance,
            isBottomPanelExpanded: isBottomPanelExpanded
        });
        return;
    }
    
    console.log('WaveformControls: Syncing cut regions');
    
    try {
        // Clear existing expanded cut regions
        const expandedRegions = window.expandedWsRegions.getRegions();
        const oldStartRegion = expandedRegions.find(r => r.id === 'expandedCutStart');
        const oldEndRegion = expandedRegions.find(r => r.id === 'expandedCutEnd');
        
        if (oldStartRegion) {
            oldStartRegion.remove();
        }
        if (oldEndRegion) {
            oldEndRegion.remove();
        }
        
        // Get current trim region from main waveform
        const mainRegions = wsRegions.getRegions();
        const mainTrimRegion = Array.isArray(mainRegions) ? 
            mainRegions.find(r => r.id === 'trimRegion') : 
            (mainRegions ? mainRegions['trimRegion'] : null);
        
        if (mainTrimRegion) {
            const totalDuration = expandedWaveformInstance.getDuration();
            console.log('WaveformControls: Total duration for cut regions:', totalDuration);
            console.log('WaveformControls: Main trim region:', {
                start: mainTrimRegion.start,
                end: mainTrimRegion.end
            });
            
            if (!totalDuration || totalDuration <= 0) {
                console.warn('WaveformControls: Invalid total duration, cannot create cut regions');
                return;
            }
            
            // Add cut region from start to trim start (beginning cut region)
            if (mainTrimRegion.start > 0) {
                window.expandedWsRegions.add({
                    id: 'expandedCutStart',
                    start: 0,
                    end: mainTrimRegion.start,
                    color: 'rgba(85, 85, 85, 0.7)', // Dark gray with 70% opacity
                    resize: false,
                    drag: false
                });
                console.log('WaveformControls: Synced start cut region (0 to', mainTrimRegion.start + ')');
            }
            
            // Add cut region from trim end to total duration (ending cut region)
            if (mainTrimRegion.end < totalDuration) {
                window.expandedWsRegions.add({
                    id: 'expandedCutEnd',
                    start: mainTrimRegion.end,
                    end: totalDuration,
                    color: 'rgba(85, 85, 85, 0.7)', // Dark gray with 70% opacity
                    resize: false,
                    drag: false
                });
                console.log('WaveformControls: Synced end cut region (' + mainTrimRegion.end + ' to', totalDuration + ')');
            }
            
            console.log('WaveformControls: Cut regions synced to expanded waveform');
        } else {
            console.log('WaveformControls: No trim region to sync (all regions cleared)');
        }
    } catch (error) {
        console.error('WaveformControls: Error syncing cut regions:', error);
    }
}

/**
 * Syncs the visual state of the expanded waveform with the main waveform
 */
function syncExpandedWaveformVisuals() {
    if (!wavesurferInstance || !expandedWaveformInstance || !isBottomPanelExpanded) {
        return;
    }
    
    console.log('WaveformControls: Syncing expanded waveform visuals');
    
    try {
        // Sync playback position
        const mainCurrentTime = wavesurferInstance.getCurrentTime();
        const expandedDuration = expandedWaveformInstance.getDuration();
        
        if (expandedDuration > 0 && mainCurrentTime >= 0) {
            const seekPosition = mainCurrentTime / expandedDuration;
            expandedWaveformInstance.seekTo(seekPosition);
            console.log('WaveformControls: Synced playback position to', mainCurrentTime);
        }
        
        // Update time displays
        updateExpandedTimeDisplay();
        
        // Sync trim regions for visual feedback
        syncTrimRegions();
        
    } catch (error) {
        console.error('WaveformControls: Error syncing expanded waveform visuals:', error);
    }
}

/**
 * Updates the expanded waveform time display
 */
function updateExpandedTimeDisplay() {
    if (!expandedWaveformInstance || !isBottomPanelExpanded) return;
    
    const currentTime = expandedWaveformInstance.getCurrentTime();
    const duration = expandedWaveformInstance.getDuration();
    const remainingTime = duration - currentTime;
    
    if (expandedWfCurrentTime) {
        expandedWfCurrentTime.textContent = formatWaveformTime(currentTime);
    }
    if (expandedWfTotalDuration) {
        expandedWfTotalDuration.textContent = formatWaveformTime(duration);
    }
    if (expandedWfRemainingTime) {
        expandedWfRemainingTime.textContent = formatWaveformTime(remainingTime);
    }
}

/**
 * Sets up synchronization between main and expanded waveforms
 */
function setupWaveformSync() {
    if (!wavesurferInstance || !expandedWaveformInstance) return;
    
    console.log('WaveformControls: Setting up waveform sync');
    
    // Sync expanded waveform progress with main waveform
    const syncProgress = () => {
        if (!wavesurferInstance || !expandedWaveformInstance || !isBottomPanelExpanded) return;
        
        const mainCurrentTime = wavesurferInstance.getCurrentTime();
        const expandedDuration = expandedWaveformInstance.getDuration();
        
        if (expandedDuration > 0) {
            const seekPosition = mainCurrentTime / expandedDuration;
            expandedWaveformInstance.seekTo(seekPosition);
        }
        
        updateExpandedTimeDisplay();
    };
    
    // Listen to main waveform events and sync expanded waveform
    wavesurferInstance.on('audioprocess', syncProgress);
    wavesurferInstance.on('seek', syncProgress);
    wavesurferInstance.on('play', () => {
        if (expandedWaveformInstance && isBottomPanelExpanded) {
            // Don't actually play the expanded waveform audio, just sync the progress
            console.log('WaveformControls: Main waveform playing, syncing expanded waveform');
            
            // Update play/pause button icons to show pause
            const mainPlayPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
            if (mainPlayPauseImg) mainPlayPauseImg.src = '../../assets/icons/pause.png';
            
            const expandedPlayPauseImg = expandedWfPlayPauseBtn ? expandedWfPlayPauseBtn.querySelector('img') : null;
            if (expandedPlayPauseImg) expandedPlayPauseImg.src = '../../assets/icons/pause.png';
        }
    });
    wavesurferInstance.on('pause', () => {
        if (expandedWaveformInstance && isBottomPanelExpanded) {
            console.log('WaveformControls: Main waveform paused, syncing expanded waveform');
            
            // Update play/pause button icons to show play
            const mainPlayPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
            if (mainPlayPauseImg) mainPlayPauseImg.src = '../../assets/icons/play.png';
            
            const expandedPlayPauseImg = expandedWfPlayPauseBtn ? expandedWfPlayPauseBtn.querySelector('img') : null;
            if (expandedPlayPauseImg) expandedPlayPauseImg.src = '../../assets/icons/play.png';
        }
    });
    
    // Initial sync
    syncProgress();
}



/**
 * Checks if the bottom panel is currently expanded
 * @returns {boolean}
 */
function getBottomPanelState() {
    return isBottomPanelExpanded;
}

export {
    initWaveformControls as init, // Export initWaveformControls as init
    showWaveformForCue,
    hideAndDestroyWaveform,
    getCurrentTrimTimes,
    formatWaveformTime,
    expandBottomPanel,
    collapseBottomPanel,
    setBottomPanelSize,
    getBottomPanelState
};