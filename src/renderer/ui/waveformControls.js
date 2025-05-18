// Companion_soundboard/src/renderer/ui/waveformControls.js

// Module-level variables for WaveSurfer instance, regions, and related state
let wavesurferInstance = null;
let wsRegions = null; // Regions plugin instance
let waveformIsStoppedAtTrimStart = false;

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
            if (wfPlayPauseBtn) wfPlayPauseBtn.innerHTML = '▶️';
            waveformIsStoppedAtTrimStart = (trimRegion && Math.abs(seekToTime - trimRegion.start) < 0.01);
        }
    });
    if (wfSetStartBtn) wfSetStartBtn.addEventListener('click', () => handleSetTrimStart()); // Call internal handler
    if (wfSetEndBtn) wfSetEndBtn.addEventListener('click', () => handleSetTrimEnd());     // Call internal handler
    // Solo button listener can be added here later
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
    if (wfPlayPauseBtn) wfPlayPauseBtn.innerHTML = '▶️'; 

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
        if (!ipcRendererBindingsModule || typeof ipcRendererBindingsModule.getOrGenerateWaveformPeaks !== 'function') {
            console.error('WaveformControls: ipcRendererBindingsModule or getOrGenerateWaveformPeaks is not available!');
            if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">IPC Error (cannot fetch peaks).</p>';
            return;
        }

        console.log(`WaveformControls: Requesting peaks for ${cue.filePath}`);
        if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:gray; text-align:center; padding-top: 40px;">Fetching/Generating peaks data...</p>';
        const waveformData = await ipcRendererBindingsModule.getOrGenerateWaveformPeaks(cue.filePath);

        if (waveformData && waveformData.decodeError === true) {
            console.warn(`WaveformControls: Peak generation failed (decodeError): ${waveformData.errorMessage}. Attempting direct load.`);
            if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:orange; text-align:center; padding-top: 20px;">Could not pre-generate waveform.<br>Attempting direct audio load...</p>';
            
            let audioUrl = cue.filePath;
            if (!audioUrl.startsWith('file://')) {
                let normalizedPath = cue.filePath.replace(/\\/g, '/');
                audioUrl = normalizedPath.startsWith('/') ? 'file://' + normalizedPath : 'file:///' + normalizedPath;
            }

            // Clear the container right before creating WaveSurfer instance in fallback path
            if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = ''; 

            wavesurferInstance = WaveSurfer.create({
                container: waveformDisplayDiv,
                waveColor: 'rgb(85, 85, 85)',
                progressColor: 'rgb(50, 50, 50)',
                cursorColor: 'rgb(204, 204, 204)',
                height: 128,
                partialRender: true, 
                autoCenter: false,
                url: audioUrl, // NO peaks, NO duration
                plugins: [ WaveSurfer.Regions.create({ dragSelection: false, regionClass: 'wavesurfer-region' }) ]
            });

            // Initialize wsRegions in the fallback path as well
            if (wavesurferInstance.plugins && wavesurferInstance.plugins.length > 0) {
                wsRegions = wavesurferInstance.plugins[0]; 
            } else { 
                console.error('WaveformControls: Could not get Regions plugin in fallback path!'); 
            }

            // Event listeners will be attached below, 'ready' event is crucial here

        } else if (waveformData && waveformData.peaks && waveformData.duration) {
            if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = ''; 
            let audioUrl = cue.filePath;
            if (!audioUrl.startsWith('file://')) {
                let normalizedPath = cue.filePath.replace(/\\/g, '/');
                audioUrl = normalizedPath.startsWith('/') ? 'file://' + normalizedPath : 'file:///' + normalizedPath;
            }
            
            wavesurferInstance = WaveSurfer.create({
                container: waveformDisplayDiv,
                waveColor: 'rgb(85, 85, 85)',
                progressColor: 'rgb(50, 50, 50)',
                cursorColor: 'rgb(204, 204, 204)',
                height: 128,
                partialRender: true, autoCenter: false,
                url: audioUrl, peaks: waveformData.peaks, duration: waveformData.duration,
                plugins: [ WaveSurfer.Regions.create({ dragSelection: false, regionClass: 'wavesurfer-region' }) ]
            });
            console.log('WaveformControls: WaveSurfer instance CREATED with pre-generated peaks.');

            if (wavesurferInstance.plugins && wavesurferInstance.plugins.length > 0) {
                wsRegions = wavesurferInstance.plugins[0]; 
            } else { console.error('WaveformControls: Could not get Regions plugin with peaks!'); }

            // REMOVE EVENT LISTENERS FROM HERE
            // // Common WaveSurfer Event Listeners (moved here)
            // if (wavesurferInstance) {
            //     console.log('WaveformControls: Attaching common WaveSurfer event listeners.');
            //     wavesurferInstance.on('ready', () => { ... });
            //     // ... all other listeners ...
            //     wavesurferInstance.on('region-removed', (region) => { ... });
            // } else {
            //      console.error('WaveformControls: wavesurferInstance is null after creation logic. Cannot attach event listeners.');
            //      if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">Failed to initialize waveform logic.</p>';
            // }
        } else {
            console.error('WaveformControls: Invalid peaks data or unexpected response from getOrGenerateWaveformPeaks.', waveformData);
            if (waveformDisplayDiv) waveformDisplayDiv.innerHTML = '<p style="color:red; text-align:center; padding-top: 40px;">Failed to get waveform data.</p>';
            if (wavesurferInstance) { try { wavesurferInstance.destroy(); } catch(e){} } // Defensive destroy
            wavesurferInstance = null; // Ensure it's null if no path succeeded
            wsRegions = null;
        }

        // ADD COMMON EVENT LISTENERS HERE, AFTER THE IF/ELSE IF/ELSE BLOCK
        if (wavesurferInstance) {
            console.log('WaveformControls: Attaching common WaveSurfer event listeners.');
            wavesurferInstance.on('ready', () => {
                console.log('WaveformControls: WaveSurfer instance READY.');
                const totalDuration = wavesurferInstance.getDuration();
                
                // Set initial time displays
                if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(0);
                // wfTotalDuration will be set by loadRegionsFromCueInternal or below
                if (wfRemainingTime && totalDuration) wfRemainingTime.textContent = formatWaveformTime(totalDuration);

                // Load any existing regions from the cue data
                // This might create a 'trimRegion' and call updateTrimInputsFromRegionInternal
                loadRegionsFromCueInternal(cue); 

                const existingTrimRegion = wsRegions ? wsRegions.getRegions().find(r => r.id === 'trimRegion') : null;
                if (!existingTrimRegion && wfTotalDuration && totalDuration) {
                    // If no trim region was loaded (e.g., new cue or untrimmed existing cue),
                    // set wfTotalDuration to the full audio duration.
                    wfTotalDuration.textContent = formatWaveformTime(totalDuration);
                    console.log(`WaveformControls (Ready): No trim region, wfTotalDuration set to full: ${formatWaveformTime(totalDuration)}`);
                } else if (existingTrimRegion && wfTotalDuration) {
                    // If a trim region WAS loaded, updateTrimInputsFromRegionInternal (called by loadRegionsFromCueInternal)
                    // should have already set wfTotalDuration to the trimmed duration.
                    // We can re-log it here for confirmation if needed.
                    console.log(`WaveformControls (Ready): Trim region exists. wfTotalDuration should be: ${wfTotalDuration.textContent}`);
                }

                if (wfPlayPauseBtn) wfPlayPauseBtn.innerHTML = '▶️';
                // const totalDur = wavesurferInstance.getDuration();
                // if (wfTotalDuration) wfTotalDuration.textContent = formatWaveformTime(totalDur);
                // if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(0);
                // if (wfRemainingTime) wfRemainingTime.textContent = formatWaveformTime(totalDur * -1); // Negative for remaining
                // loadRegionsFromCueInternal(cue); // This will add trimRegion, triggering 'region-created'
            });
            wavesurferInstance.on('audioprocess', (currentTime) => {
                if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(currentTime);
                const totalDur = wavesurferInstance.getDuration();
                if (wfRemainingTime) wfRemainingTime.textContent = formatWaveformTime(currentTime - totalDur); // Negative for remaining

                const trimRegion = wsRegions ? wsRegions.getRegions().find(r => r.id === 'trimRegion') : null;
                if (trimRegion && wavesurferInstance.isPlaying()) {
                    const tolerance = 0.05; 
                    if (currentTime >= (trimRegion.end - tolerance)) {
                        console.log(`WaveformControls: Audioprocess - Current time ${currentTime} reached/passed trimRegion.end ${trimRegion.end}. Handling end.`);
                        _handlePlaybackEndReached();
                    }
                }
            });
            wavesurferInstance.on('seek', () => {
                const currentTime = wavesurferInstance.getCurrentTime();
                if (wfCurrentTime) wfCurrentTime.textContent = formatWaveformTime(currentTime);
                const totalDur = wavesurferInstance.getDuration();
                if (wfRemainingTime) wfRemainingTime.textContent = formatWaveformTime(currentTime - totalDur); // Negative for remaining
            });
            wavesurferInstance.on('play', () => { 
                if (wfPlayPauseBtn) wfPlayPauseBtn.innerHTML = '⏸️'; 
                waveformIsStoppedAtTrimStart = false;
            });
            wavesurferInstance.on('pause', () => { if (wfPlayPauseBtn) wfPlayPauseBtn.innerHTML = '▶️'; });
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
                        // Optional: Ensure playhead is exactly at region.end if it overshot slightly
                        // const duration = wavesurferInstance.getDuration();
                        // if (duration > 0) {
                        //    wavesurferInstance.seekTo(region.end / duration);
                        // }
                    }
                }
            });
            wavesurferInstance.on('region-created', (region) => {
                console.log('WaveformControls: Region created:', region.id, 'Start:', region.start.toFixed(3), 'End:', region.end.toFixed(3));
                if (region.id === 'trimRegion') {
                    updateTrimInputsFromRegionInternal(region); // Update sidebar inputs
                    setTimeout(() => {
                        styleRegionsInternal(); // Restyle waveform (dimming regions etc.)
                    }, 0);
                } else if (wsRegions && wsRegions.getRegions().find(r => r.id === 'trimRegion')) {
                    // This case is mostly for when styleRegionsInternal adds pre/post dim regions,
                    // but it's good to ensure styling is consistent if other regions were ever added.
                    setTimeout(() => {
                        styleRegionsInternal();
                    }, 0);
                }
            });
            wavesurferInstance.on('region-updated', (region) => {
                console.log('WaveformControls: Region updated:', region.id, 'Start:', region.start.toFixed(3), 'End:', region.end.toFixed(3)); // Log with toFixed
                if (region.id === 'trimRegion') {
                    updateTrimInputsFromRegionInternal(region); // Notify sidebar & trigger save
                }
                setTimeout(() => {
                    styleRegionsInternal(); 
                }, 0);
            });
            wavesurferInstance.on('region-removed', (region) => {
                console.log('WaveformControls: Region removed:', region.id, 'Start:', region.start, 'End:', region.end);
                if (region.id === 'trimRegion' || (wsRegions && wsRegions.getRegions().find(r => r.id === 'trimRegion'))) {
                    styleRegionsInternal();
                } else if (!wsRegions || wsRegions.getRegions().length === 0) {
                    styleRegionsInternal(); 
                }
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

function _destroyWaveformInternal() {
    if (wavesurferInstance) {
        try { wavesurferInstance.destroy(); } catch (e) { console.warn("WaveformControls: Error destroying wavesurfer:", e); }
        wavesurferInstance = null; wsRegions = null;
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
        wsRegions.addRegion({ 
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
    let existingTrimRegion = wsRegions.getRegions().find(r => r.id === 'trimRegion');

    console.log('WaveformControls: handleSetTrimStart called. Current time:', currentTime, 'Existing region found:', existingTrimRegion ? existingTrimRegion.id : undefined);

    if (existingTrimRegion) {
        let newStart = currentTime;
        let newEnd = existingTrimRegion.end;
        const regionOptions = {
            id: existingTrimRegion.id,
            color: existingTrimRegion.color,
            drag: existingTrimRegion.drag,
            resize: existingTrimRegion.resize,
            attributes: existingTrimRegion.attributes
        };

        if (newEnd <= newStart) {
            const totalDur = wavesurferInstance.getDuration();
            newEnd = Math.min(newStart + 0.1, totalDur);
            if (newStart >= newEnd && totalDur > 0) {
                 newStart = Math.max(0, newEnd - 0.1);
            } else if (newStart >= newEnd) {
                 newStart = 0; 
                 newEnd = Math.min(0.1, totalDur > 0 ? totalDur : 0.1);
            }
        }
        
        console.log(`WaveformControls: Recreating trimRegion. New start: ${newStart.toFixed(3)}, End: ${newEnd.toFixed(3)}`);
        
        existingTrimRegion.remove();
        const newRegion = wsRegions.addRegion({
            ...regionOptions,
            start: newStart,
            end: newEnd
        });
        // Explicitly call update and style functions for programmatic change
        if (newRegion) {
            updateTrimInputsFromRegionInternal(newRegion);
            setTimeout(() => styleRegionsInternal(), 0); // Keep styling async
        }

    } else {
        // Create new region if none exists
        const totalDur = wavesurferInstance.getDuration();
        let newStart = currentTime;
        let newEnd = totalDur > 0 ? totalDur : currentTime + 0.1; 

        if (newStart >= newEnd) { 
            if (totalDur > 0 && newStart >= totalDur) { 
                newStart = Math.max(0, totalDur - 0.1);
                newEnd = totalDur;
            } else { 
                newStart = currentTime;
                newEnd = currentTime + 0.1;
            }
             if (newStart < 0) newStart = 0;
        }

        console.log('WaveformControls: No existing trimRegion. Adding new one. Start:', newStart.toFixed(3), ', end:', newEnd.toFixed(3));
        const newRegion = wsRegions.addRegion({
            id: 'trimRegion',
            start: newStart,
            end: newEnd,
            color: 'rgba(100, 149, 237, 0.3)', 
            drag: true,
            resize: true,
        });
        // Explicitly call update and style functions for programmatic change
        if (newRegion) {
            updateTrimInputsFromRegionInternal(newRegion);
            setTimeout(() => styleRegionsInternal(), 0); // Keep styling async
        }
    }
}

function handleSetTrimEnd() {
    if (!wavesurferInstance || !wsRegions) return;
    const currentTime = wavesurferInstance.getCurrentTime();
    let existingTrimRegion = wsRegions.getRegions().find(r => r.id === 'trimRegion');

    console.log('WaveformControls: handleSetTrimEnd called. Current time:', currentTime, 'Existing region found:', existingTrimRegion ? existingTrimRegion.id : undefined);

    if (existingTrimRegion) {
        let newStart = existingTrimRegion.start;
        let newEnd = currentTime;
        const regionOptions = {
            id: existingTrimRegion.id,
            color: existingTrimRegion.color,
            drag: existingTrimRegion.drag,
            resize: existingTrimRegion.resize,
            attributes: existingTrimRegion.attributes
        };

        if (newStart >= newEnd) {
            newStart = Math.max(0, newEnd - 0.1);
            if (newStart >= newEnd && newEnd > 0) {
                 newEnd = Math.min(wavesurferInstance.getDuration(), newStart + 0.1);
            } else if (newStart >= newEnd) {
                newStart = 0;
                newEnd = Math.min(0.1, wavesurferInstance.getDuration() > 0 ? wavesurferInstance.getDuration() : 0.1);
            }
        }

        console.log(`WaveformControls: Recreating trimRegion. Start: ${newStart.toFixed(3)}, New End: ${newEnd.toFixed(3)}`);

        existingTrimRegion.remove();
        const newRegion = wsRegions.addRegion({
            ...regionOptions,
            start: newStart,
            end: newEnd
        });
        // Explicitly call update and style functions for programmatic change
        if (newRegion) {
            updateTrimInputsFromRegionInternal(newRegion);
            setTimeout(() => styleRegionsInternal(), 0); // Keep styling async
        }

    } else {
        // Create new region if none exists
        const totalDur = wavesurferInstance.getDuration();
        let newStart = 0;
        let newEnd = currentTime;

        if (newEnd <= newStart) { 
            newEnd = Math.min(totalDur > 0 ? totalDur : newStart + 0.1, newStart + 0.1);
            if (newEnd <= newStart && totalDur > 0) { 
                 newEnd = Math.min(0.1, totalDur);
            } else if (newEnd <= newStart) {
                 newEnd = newStart + 0.1;
            }
        }
        if (newEnd > totalDur && totalDur > 0) newEnd = totalDur;


        console.log('WaveformControls: No existing trimRegion in handleSetTrimEnd. Adding new one. Start:', newStart.toFixed(3), 'End:', newEnd.toFixed(3));
        const newRegion = wsRegions.addRegion({
            id: 'trimRegion',
            start: newStart,
            end: newEnd,
            color: 'rgba(100, 149, 237, 0.3)', 
            drag: true,
            resize: true,
        });
        // Explicitly call update and style functions for programmatic change
        if (newRegion) {
            updateTrimInputsFromRegionInternal(newRegion);
            setTimeout(() => styleRegionsInternal(), 0); // Keep styling async
        }
    }
}

// Added function to notify sidebars module
function notifyCuePropertiesPanelOfTrimChange(trimStart, trimEnd) {
    console.log(`WaveformControls (DEBUG): notifyCuePropertiesPanelOfTrimChange CALLED. Start: ${trimStart}, End: ${trimEnd}`);
    if (onTrimChangeCallback) { // ADDED: Use the callback
        console.log('WaveformControls: Calling onTrimChangeCallback (sidebars.handleCuePropertyChangeFromWaveform)');
        onTrimChangeCallback(trimStart, trimEnd); // This updates sidebar inputs & triggers save
    } else {
        console.warn('WaveformControls: onTrimChangeCallback is not defined. Cannot update sidebar inputs or trigger save.');
    }

    // Update the total duration display within the waveform panel itself
    if (wfTotalDuration) {
        const trimmedDuration = trimEnd - trimStart;
        const formattedTrimmedDuration = formatWaveformTime(trimmedDuration);
        console.log(`WaveformControls (notifyCuePropertiesPanelOfTrimChange): wfTotalDuration is valid. Calculated trimmedDuration: ${trimmedDuration}, Formatted: ${formattedTrimmedDuration}`); // Log before setting
        if (trimmedDuration >= 0) {
            wfTotalDuration.textContent = formattedTrimmedDuration;
            console.log(`WaveformControls: Updated wfTotalDuration to trimmed duration: ${formattedTrimmedDuration}`);
        } else {
            wfTotalDuration.textContent = formatWaveformTime(0);
            console.log(`WaveformControls: Updated wfTotalDuration to 0 (negative trim duration).`);
        }
    } else {
        console.error('WaveformControls (notifyCuePropertiesPanelOfTrimChange): wfTotalDuration DOM element is NULL or UNDEFINED!');
    }
    // wfCurrentTime and wfRemainingTime are updated by 'audioprocess' or 'seek'
}

function updateTrimInputsFromRegionInternal(region) {
    if (region && region.id === 'trimRegion') {
        console.log('WaveformControls (DEBUG): updateTrimInputsFromRegionInternal CALLED for trimRegion. Start:', region.start.toFixed(3), 'End:', region.end.toFixed(3));
        notifyCuePropertiesPanelOfTrimChange(region.start, region.end);
    } else if (!region && wsRegions && !(wsRegions.getRegions().find(r => r.id === 'trimRegion'))) {
        console.log('WaveformControls (DEBUG): updateTrimInputsFromRegionInternal - trimRegion removed. Effective trim is full duration.');
        // If region is removed, trims should be full duration (0 to totalDuration)
        // However, audioController expects undefined or actual values. 
        // For now, let sidebars handle this with potentially null/undefined or default values.
        // This might need adjustment based on how sidebars.handleCuePropertyChangeFromWaveform is implemented.
        const totalDuration = wavesurferInstance ? wavesurferInstance.getDuration() : 0;
        notifyCuePropertiesPanelOfTrimChange(0, totalDuration); // Or pass null, null depending on handler
    } else {
        console.log('WaveformControls (DEBUG): updateTrimInputsFromRegionInternal called with non-trimRegion or no region change relevant to trim inputs.', region ? region.id : 'no region');
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

    allCurrentRegions.forEach(reg => {
        if (reg.id !== 'trimRegion') {
            console.log(`WaveformControls: Removing old dimming region: ${reg.id}`);
            try { reg.remove(); } catch (e) { console.warn(`WaveformControls: Minor error removing ${reg.id}`, e); }
        }
    });
    
    const trimRegion = wsRegions.getRegions().find(r => r.id === 'trimRegion');
    const totalDuration = wavesurferInstance.getDuration();

    console.log("WaveformControls: Regions after clearing non-trimRegion:", wsRegions.getRegions().map(r => r.id));

    if (trimRegion) {
        console.log(`WaveformControls: Styling with trimRegion. Start: ${trimRegion.start}, End: ${trimRegion.end}, Total Duration: ${totalDuration}`);
        if (trimRegion.element) trimRegion.element.style.zIndex = '3';

        if (trimRegion.start > MIN_REGION_DURATION) {
            console.log(`WaveformControls: Adding preTrimDim. Start: 0, End: ${trimRegion.start}`);
            const preDim = wsRegions.addRegion({ 
                id: 'preTrimDim', 
                start: 0, 
                end: trimRegion.start, 
                color: 'rgba(0,0,0,0.5)', 
                drag: false, 
                resize: false, 
                interact: false 
            });
            if (preDim && preDim.element) preDim.element.style.zIndex = '2';
        }

        if (trimRegion.end < (totalDuration - MIN_REGION_DURATION)) {
            console.log(`WaveformControls: Adding postTrimDim. Start: ${trimRegion.end}, End: ${totalDuration}`);
            const postDim = wsRegions.addRegion({ 
                id: 'postTrimDim', 
                start: trimRegion.end, 
                end: totalDuration, 
                color: 'rgba(0,0,0,0.5)', 
                drag: false, 
                resize: false, 
                interact: false 
            });
            if (postDim && postDim.element) postDim.element.style.zIndex = '2';
        }
    } else {
        console.log("WaveformControls: No trimRegion exists. Ensuring no dimming regions are present.");
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