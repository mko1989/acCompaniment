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

// DOM Elements
let waveformDisplayDiv;
let wfPlayPauseBtn, wfStopBtn, wfSetStartBtn, wfSetEndBtn, wfSoloBtn;
let wfCurrentTime, wfTotalDuration, wfRemainingTime;

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
    wfCurrentTime = document.getElementById('wfCurrentTime');
    wfTotalDuration = document.getElementById('wfTotalDuration');
    wfRemainingTime = document.getElementById('wfRemainingTime');
    
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
                    // If paused, decide where to play from
                    if (currentTime < trimRegion.start || currentTime >= trimRegion.end) {
                        console.log('WaveformControls: Playhead outside trim region or at/after end. Seeking to region start.');
                        if (duration > 0) wavesurferInstance.seekTo(trimRegion.start / duration);
                        wavesurferInstance.play();
                    } else {
                        // Playhead is within the trim region, play from current position
                        wavesurferInstance.play(); 
                    }
                }
            } else {
                // No trim region, just play/pause normally
                wavesurferInstance.playPause();
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
            wavesurferInstance.pause();
            const trimRegion = wsRegions ? wsRegions.getRegions().find(r => r.id === 'trimRegion') : null;
            const duration = wavesurferInstance.getDuration();
            let seekToTime = 0; 
            if (trimRegion) {
                seekToTime = trimRegion.start;
            }
            if (duration > 0) {
                wavesurferInstance.seekTo(seekToTime / duration);
            }
            const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
            if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';

            waveformIsStoppedAtTrimStart = (trimRegion && Math.abs(seekToTime - trimRegion.start) < 0.01);
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
            color: 'rgba(100, 149, 237, 0.3)', 
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
        color: 'rgba(100, 149, 237, 0.3)', 
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
        color: 'rgba(100, 149, 237, 0.3)', 
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
        
        // Update the trimRegion color to make it more visible (no darkening effect)
        trimRegion.color = 'rgba(100, 149, 237, 0.3)';
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

export {
    initWaveformControls as init, // Export initWaveformControls as init
    showWaveformForCue,
    hideAndDestroyWaveform,
    getCurrentTrimTimes,
    formatWaveformTime
};