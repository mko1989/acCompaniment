// Companion_soundboard/src/renderer/ui/waveformControls.js

// Module-level variables for WaveSurfer instance, regions, and related state
let wavesurferInstance = null;
let wsRegions = null; // Regions plugin instance
let currentLiveTrimRegion = null; // ADDED: To store the live trimRegion object
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
    ipcRendererBindingsModule = dependencies.ipcRendererBindings;

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
    console.log('WaveformControls: DOM elements cached.');
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
    if (wfPlayPauseBtn) wfPlayPauseBtn.addEventListener('click', () => {
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
    if (wfStopBtn) wfStopBtn.addEventListener('click', () => {
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
    if (wfSetStartBtn) wfSetStartBtn.addEventListener('click', () => handleSetTrimStart()); // Call internal handler
    if (wfSetEndBtn) wfSetEndBtn.addEventListener('click', () => handleSetTrimEnd());     // Call internal handler
    
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

async function initializeWaveformInternal(cue) {
    if (!waveformDisplayDiv || !cue || !cue.filePath) { // Simplified check, type check done by caller
        _destroyWaveformInternal(); // Use internal destroy
        return;
    }

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

        // Create wavesurfer instance with direct audio loading (the "fallback" method is now primary)
        wavesurferInstance = WaveSurfer.create({
            container: waveformDisplayDiv,
            waveColor: 'rgb(85, 85, 85)',
            progressColor: 'rgb(120, 120, 120)', // Changed to lighter gray to make it visible but not too dark
            cursorColor: 'rgb(204, 204, 204)',
            height: 128,
            partialRender: true, 
            autoCenter: false,
            url: audioUrl,
            plugins: [ WaveSurfer.Regions.create({ dragSelection: false, regionClass: 'wavesurfer-region' }) ]
        });

        // Initialize wsRegions reference
        if (wavesurferInstance.plugins && wavesurferInstance.plugins.length > 0) {
            wsRegions = wavesurferInstance.plugins[0]; 
        } else { 
            console.error('WaveformControls: Could not get Regions plugin!'); 
        }

        // Reset zoom level to default
        zoomLevel = 0;

        // Attach event listeners
        if (wavesurferInstance) {
            console.log('WaveformControls: Attaching WaveSurfer event listeners.');
            
            wavesurferInstance.on('ready', () => {
                console.log('WaveformControls: WaveSurfer instance READY.');
                const totalDuration = wavesurferInstance.getDuration();
                
                // Set initial time displays
                if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(0);
                if (wfRemainingTime && totalDuration) wfRemainingTime.textContent = formatWaveformTime(totalDuration);

                // Load any existing regions from the cue data
                loadRegionsFromCueInternal(cue); 

                // Check if trimRegion exists
                const allRegions = wsRegions ? wsRegions.getRegions() : {}; 
                const currentTrimRegionForCheck = allRegions['trimRegion'];

                if (!currentTrimRegionForCheck && wfTotalDuration && totalDuration) {
                    wfTotalDuration.textContent = formatWaveformTime(totalDuration);
                    console.log(`WaveformControls (Ready): No trim region, wfTotalDuration set to full: ${formatWaveformTime(totalDuration)}`);
                } else if (currentTrimRegionForCheck && wfTotalDuration) {
                    console.log(`WaveformControls (Ready): Trim region exists. wfTotalDuration should be: ${wfTotalDuration.textContent}`);
                }

                const playPauseImgOnReady = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
                if (playPauseImgOnReady) playPauseImgOnReady.src = '../../assets/icons/play.png';
                
                // Reset zoom to ensure entire track is visible
                resetZoom();
            });
            
            wavesurferInstance.on('audioprocess', (currentTime) => {
                if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(currentTime);
                const totalDur = wavesurferInstance.getDuration();
                if (wfRemainingTime) wfRemainingTime.textContent = formatWaveformTime(currentTime - totalDur); // Negative for remaining

                // Check if playback has reached the end of a trim region
                const allRegionsForAudioProcess = wsRegions ? wsRegions.getRegions() : {};
                const trimRegionForAudioProcess = allRegionsForAudioProcess['trimRegion'];

                if (trimRegionForAudioProcess && wavesurferInstance.isPlaying()) {
                    const tolerance = 0.05; 
                    if (currentTime >= (trimRegionForAudioProcess.end - tolerance)) {
                        console.log(`WaveformControls: Audioprocess - Current time ${currentTime} reached/passed trimRegion.end ${trimRegionForAudioProcess.end}. Handling end.`);
                        _handlePlaybackEndReached();
                    }
                }
                
                // This function call updates any other UI that needs to stay in sync with the current playback time
                syncPlaybackTimeWithUI(currentTime);
            });
            
            wavesurferInstance.on('seek', () => {
                const currentTime = wavesurferInstance.getCurrentTime();
                if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(currentTime);
                const totalDur = wavesurferInstance.getDuration();
                if (wfRemainingTime) wfRemainingTime.textContent = formatWaveformTime(currentTime - totalDur); // Negative for remaining
                
                // Also sync UI when user seeks
                syncPlaybackTimeWithUI(currentTime);
            });
            
            wavesurferInstance.on('play', () => { 
                const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
                if (playPauseImg) playPauseImg.src = '../../assets/icons/pause.png';
                waveformIsStoppedAtTrimStart = false;
            });
            
            wavesurferInstance.on('pause', () => { 
                const playPauseImg = wfPlayPauseBtn ? wfPlayPauseBtn.querySelector('img') : null;
                if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';
            });
            
            wavesurferInstance.on('finish', () => { 
                _handlePlaybackEndReached();
            });
            
            wavesurferInstance.on('region-out', (region) => {
                console.log(`WaveformControls: 'region-out' event fired for region ID: ${region.id}, Start: ${region.start}, End: ${region.end}`);
                if (region.id === 'trimRegion') {
                    console.log(`  'region-out' is for trimRegion. Is playing? ${wavesurferInstance.isPlaying()}`);
                    if (wavesurferInstance.isPlaying()) {
                        console.log('  Pausing playback due to trimRegion-out.');
                        wavesurferInstance.pause();
                    }
                }
            });
            
            wavesurferInstance.on('region-created', (region) => {
                console.log('WaveformControls: Region created:', region.id, 'Start:', region.start.toFixed(3), 'End:', region.end.toFixed(3));
                if (region.id === 'trimRegion') {
                    updateTrimInputsFromRegionInternal(region); // Update sidebar inputs
                }
                // Style the regions after creation
                setTimeout(() => {
                    styleRegionsInternal();
                }, 0);
            });
            
            wavesurferInstance.on('region-updated', (region) => {
                console.log('WaveformControls: Region updated:', region.id, 'Start:', region.start.toFixed(3), 'End:', region.end.toFixed(3)); // Log with toFixed
                if (region.id === 'trimRegion') {
                    updateTrimInputsFromRegionInternal(region); // Notify sidebar & trigger save
                }
                // Style the regions after update
                setTimeout(() => {
                    styleRegionsInternal();
                }, 0);
            });
            
            // Re-add the region-removed event handler
            wavesurferInstance.on('region-removed', (region) => {
                console.log('WaveformControls: Region removed:', region.id);
                // Style the regions after removal
                setTimeout(() => {
                    styleRegionsInternal();
                }, 0);
            });
        } else {
             console.error('WaveformControls: wavesurferInstance is null after creation logic. Cannot attach event listeners.');
             if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">Failed to initialize waveform logic.</p>';
        }
    } catch (error) {
        console.error('Error initializing waveform:', error);
        if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">Critical error.</p>';
    }
}

// Function to sync playback time with other UI elements
function syncPlaybackTimeWithUI(currentTime) {
    // Update the current time display
    if (wfCurrentTime) {
        wfCurrentTime.textContent = formatWaveformTime(currentTime);
    }
    
    // Update the remaining time display
    if (wfRemainingTime && wavesurferInstance) {
        const totalDuration = wavesurferInstance.getDuration();
        wfRemainingTime.textContent = formatWaveformTime(currentTime - totalDuration);
    }
    
    // If we need to sync with another part of the UI in the future, 
    // add that code here
}

function _destroyWaveformInternal() {
    if (wavesurferInstance) {
        try { wavesurferInstance.destroy(); } catch (e) { console.warn("WaveformControls: Error destroying wavesurfer:", e); }
        wavesurferInstance = null; wsRegions = null;
        currentLiveTrimRegion = null; // ADDED: Reset live region
    }
    if (waveformDisplayDiv) { waveformDisplayDiv.innerHTML = ''; /* Keep display style managed by caller */ }
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
    if (!wavesurferInstance || !wsRegions) return;
    const currentTime = wavesurferInstance.getCurrentTime();
    console.log('WaveformControls: handleSetTrimStart - FORCING REMOVE/ADD. Current time:', currentTime);

    // Attempt to remove existing region with id 'trimRegion'
    const regions = wsRegions.getRegions(); 
    const oldRegionInstance = Array.isArray(regions) ? regions.find(r => r.id === 'trimRegion') : (regions ? regions['trimRegion'] : null);
    if (oldRegionInstance && typeof oldRegionInstance.remove === 'function') {
        try { oldRegionInstance.remove(); console.log('Force-removed old trimRegion (start)'); } 
        catch (e) { console.warn('Error force-removing old trimRegion (start):', e); }
    } else if (oldRegionInstance) {
        console.warn('Old trimRegion found but no remove method (start)');
        // Potentially try wsRegions.clearRegions() if desperate, but that clears all regions.
    } else {
        console.log('No old trimRegion found to remove (start).');
    }
    currentLiveTrimRegion = null; 

    // Define new region boundaries
    const totalDur = wavesurferInstance.getDuration();
    let newStart = currentTime;
    let newEnd = totalDur; // Default to full duration if an old end isn't available or makes sense
    
    // If we had an old region, try to use its end time, otherwise full duration or a small increment.
    if (oldRegionInstance && oldRegionInstance.end !== undefined) {
        newEnd = oldRegionInstance.end;
    } else {
        newEnd = totalDur > 0 ? totalDur : currentTime + 0.1;
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
    currentLiveTrimRegion = wsRegions.addRegion({
        id: 'trimRegion',
        start: newStart,
        end: newEnd,
        color: 'rgba(100, 149, 237, 0.3)', 
        drag: true,
        resize: true,
    });
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
    if (onTrimChangeCallback) { // ADDED: Use the callback
        console.log('WaveformControls (notifyCuePropertiesPanelOfTrimChange): Calling onTrimChangeCallback (sidebars.handleCuePropertyChangeFromWaveform)');
        onTrimChangeCallback(trimStart, trimEnd); // This updates sidebar inputs & triggers save
    } else {
        console.warn('WaveformControls (notifyCuePropertiesPanelOfTrimChange): onTrimChangeCallback is not defined. Cannot update sidebar inputs or trigger save.');
    }

    // Update the total duration display within the waveform panel itself
    if (wfTotalDuration) {
        const trimmedDuration = trimEnd - trimStart;
        const formattedTrimmedDuration = formatWaveformTime(trimmedDuration);
        // console.log(`WaveformControls (notifyCuePropertiesPanelOfTrimChange): wfTotalDuration is valid. Calculated trimmedDuration: ${trimmedDuration}, Formatted: ${formattedTrimmedDuration}`); // Log before setting
        if (trimmedDuration >= 0) {
            wfTotalDuration.textContent = formattedTrimmedDuration;
            console.log(`WaveformControls (notifyCuePropertiesPanelOfTrimChange): Updated wfTotalDuration to trimmed duration: ${formattedTrimmedDuration}`);
        } else {
            wfTotalDuration.textContent = formatWaveformTime(0);
            console.log(`WaveformControls (notifyCuePropertiesPanelOfTrimChange): Updated wfTotalDuration to 0 (negative trim duration).`);
        }
    } else {
        console.error('WaveformControls (notifyCuePropertiesPanelOfTrimChange): wfTotalDuration DOM element is NULL or UNDEFINED!');
    }
    // wfCurrentTime and wfRemainingTime are updated by 'audioprocess' or 'seek'
}

function updateTrimInputsFromRegionInternal(region) {
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
    if (!waveformDisplayDiv) { console.error("WaveformControls: DOM not cached."); return; }
    if (!cue || !cue.filePath || (cue.type && cue.type === 'playlist')) {
        _destroyWaveformInternal(); 
        if(waveformDisplayDiv) waveformDisplayDiv.style.display = 'none';
        return;
    }
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

export {
    initWaveformControls as init, // Export initWaveformControls as init
    showWaveformForCue,
    hideAndDestroyWaveform,
    getCurrentTrimTimes,
    formatWaveformTime
};