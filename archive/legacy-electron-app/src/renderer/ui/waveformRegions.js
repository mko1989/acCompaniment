// Companion_soundboard/src/renderer/ui/waveformRegions.js

/**
 * Waveform Region Management Module
 * Handles region creation, styling, and management for waveforms
 */

// Region state variables
let wsRegions = null; // Regions plugin instance
let currentLiveTrimRegion = null; // To store the live trimRegion object
let isDestroyingWaveform = false; // Flag to prevent callback loops during destruction

// Dependencies
let onTrimChangeCallback = null; // Callback for trim changes

// Constants
const MIN_REGION_DURATION = 0.01; // seconds, to avoid issues with zero-width regions

/**
 * Initialize the region management module
 * @param {object} dependencies - Object containing required modules and callbacks
 */
function initRegionModule(dependencies) {
    onTrimChangeCallback = dependencies.onTrimChange;
    console.log('WaveformRegions: Initialized with onTrimChange callback:', !!onTrimChangeCallback);
}

/**
 * Set the regions plugin instance
 * @param {object} regionsInstance - The WaveSurfer regions plugin instance
 */
function setRegionsInstance(regionsInstance) {
    wsRegions = regionsInstance;
    console.log('WaveformRegions: Regions instance set:', !!wsRegions);
}

/**
 * Get the regions plugin instance
 * @returns {object|null} The WaveSurfer regions plugin instance
 */
function getRegionsInstance() {
    return wsRegions;
}

/**
 * Set the destruction flag
 * @param {boolean} isDestroying - Whether waveform is being destroyed
 */
function setDestroyingFlag(isDestroying) {
    isDestroyingWaveform = isDestroying;
}

/**
 * Load regions from cue data
 * @param {object} cue - The cue object containing trim data
 * @param {object} wavesurferInstance - The WaveSurfer instance
 */
function loadRegionsFromCue(cue, wavesurferInstance) {
    if (!wsRegions || !wavesurferInstance || !cue) {
        console.warn('WaveformRegions: Cannot load regions - missing dependencies');
        return;
    }

    console.log('WaveformRegions: Loading regions from cue:', cue.id);
    
    // Clear existing regions first
    clearAllRegionsHard();
    
    // Check if cue has trim data
    if (cue.trimStartTime !== undefined && cue.trimEndTime !== undefined) {
        const duration = wavesurferInstance.getDuration();
        
        if (duration > 0 && cue.trimStartTime >= 0 && cue.trimEndTime <= duration) {
            console.log('WaveformRegions: Creating trim region:', {
                start: cue.trimStartTime,
                end: cue.trimEndTime,
                duration: duration
            });
            
            try {
                // Create the trim region
                const trimRegion = wsRegions.addRegion({
                    id: 'trimRegion',
                    start: cue.trimStartTime,
                    end: cue.trimEndTime,
                    color: 'rgba(0, 255, 0, 0.3)',
                    drag: true,
                    resize: true
                });
                
                currentLiveTrimRegion = trimRegion;
                console.log('WaveformRegions: Trim region created successfully');
                
                // Apply styling after a short delay to ensure region is rendered
                setTimeout(() => {
                    styleRegions(wavesurferInstance);
                }, 100);
                
            } catch (error) {
                console.error('WaveformRegions: Error creating trim region:', error);
            }
        } else {
            console.log('WaveformRegions: Invalid trim times for duration:', {
                trimStart: cue.trimStartTime,
                trimEnd: cue.trimEndTime,
                duration: duration
            });
        }
    } else {
        console.log('WaveformRegions: No trim data in cue, showing full duration');
    }
}

/**
 * Clear all regions from the waveform
 */
function clearAllRegionsHard() {
    if (!wsRegions) {
        console.warn('WaveformRegions: Cannot clear regions - wsRegions not available');
        return;
    }
    
    console.log('WaveformRegions: Clearing all regions');
    
    try {
        // Get all regions and remove them - iterate multiple times to catch all
        let totalCleared = 0;
        let maxIterations = 10;
        let iteration = 0;
        
        while (iteration < maxIterations) {
            const regions = wsRegions.getRegions();
            if (!regions || (Array.isArray(regions) && regions.length === 0)) {
                break; // No more regions to clear
            }
            
            let clearedThisIteration = 0;
            if (Array.isArray(regions)) {
                // Create a copy to avoid issues with array modification during iteration
                const regionsCopy = [...regions];
                regionsCopy.forEach(region => {
                    if (region && typeof region.remove === 'function') {
                        try {
                            region.remove();
                            clearedThisIteration++;
                        } catch (e) {
                            console.warn('WaveformRegions: Error removing region:', e);
                        }
                    }
                });
            }
            
            totalCleared += clearedThisIteration;
            
            if (clearedThisIteration === 0) {
                break; // No regions cleared this iteration, we're done
            }
            
            iteration++;
        }
        
        console.log(`WaveformRegions: Cleared ${totalCleared} regions in ${iteration} iterations`);
        
        // Clear cut overlays
        clearAllCutOverlaysImmediate();
        
        currentLiveTrimRegion = null;
        console.log('WaveformRegions: All regions cleared');
        
    } catch (error) {
        console.error('WaveformRegions: Error clearing regions:', error);
    }
}

/**
 * Clear all cut overlays immediately
 */
function clearAllCutOverlaysImmediate() {
    if (!wsRegions) return;
    
    try {
        const regions = wsRegions.getRegions();
        if (Array.isArray(regions)) {
            regions.forEach(region => {
                if (region && region.id && region.id.startsWith('cutOverlay')) {
                    if (typeof region.remove === 'function') {
                        region.remove();
                    }
                }
            });
        }
    } catch (error) {
        console.error('WaveformRegions: Error clearing cut overlays:', error);
    }
}

/**
 * Style regions with cut overlays
 * @param {object} wavesurferInstance - The WaveSurfer instance
 */
function styleRegions(wavesurferInstance) {
    if (!wsRegions || !wavesurferInstance) {
        console.warn('WaveformRegions: Cannot style regions - missing dependencies');
        return;
    }
    
    console.log('WaveformRegions: Styling regions with cut overlays');
    
    try {
        const regions = wsRegions.getRegions();
        const trimRegion = Array.isArray(regions) ? 
            regions.find(r => r && r.id === 'trimRegion') : 
            (regions ? regions['trimRegion'] : null);
        
        if (!trimRegion) {
            console.log('WaveformRegions: No trim region found for styling');
            return;
        }
        
        const duration = wavesurferInstance.getDuration();
        if (!duration || duration <= 0) {
            console.warn('WaveformRegions: Invalid duration for styling:', duration);
            return;
        }
        
        // Clear existing cut overlays first (but preserve the main trim region)
        clearAllCutOverlaysImmediate();
        
        // Create cut overlays for areas outside the trim region
        const cutOverlays = [];
        
        // Cut overlay before trim start
        if (trimRegion.start > 0.01) {
            const beforeCut = wsRegions.addRegion({
                id: 'cutOverlay-before',
                start: 0,
                end: Math.max(0, trimRegion.start - MIN_REGION_DURATION),
                color: 'rgba(255, 0, 0, 0.4)', // Red overlay for what will be cut
                drag: false,
                resize: false
            });
            cutOverlays.push(beforeCut);
        }
        
        // Cut overlay after trim end
        if (trimRegion.end < duration - 0.01) {
            const afterCut = wsRegions.addRegion({
                id: 'cutOverlay-after',
                start: Math.min(duration, trimRegion.end + MIN_REGION_DURATION),
                end: duration,
                color: 'rgba(255, 0, 0, 0.4)', // Red overlay for what will be cut
                drag: false,
                resize: false
            });
            cutOverlays.push(afterCut);
        }
        
        console.log('WaveformRegions: Created cut overlays:', cutOverlays.length);
        
    } catch (error) {
        console.error('WaveformRegions: Error styling regions:', error);
    }
}

/**
 * Update trim inputs from region data
 * @param {object} region - The region object
 */
function updateTrimInputsFromRegion(region) {
    if (!region || region.id !== 'trimRegion') {
        console.log('WaveformRegions: No trim region to update inputs from');
        return;
    }
    
    console.log('WaveformRegions: Updating trim inputs from region:', {
        start: region.start,
        end: region.end
    });
    
    // Notify callback of trim change
    if (typeof onTrimChangeCallback === 'function') {
        try {
            onTrimChangeCallback(region.start, region.end);
        } catch (error) {
            console.error('WaveformRegions: Error in onTrimChange callback:', error);
        }
    }
}

/**
 * Get current trim times from regions
 * @returns {{trimStartTime: number, trimEndTime: number} | null}
 */
function getCurrentTrimTimes() {
    if (!wsRegions) {
        console.log('WaveformRegions: wsRegions not available');
        return null;
    }
    
    const regions = wsRegions.getRegions();
    let trimRegion = null;
    
    // Handle both array and object formats
    if (Array.isArray(regions)) {
        trimRegion = regions.find(r => r && r.id === 'trimRegion');
    } else if (regions && typeof regions === 'object') {
        trimRegion = regions['trimRegion'];
    }
    
    if (trimRegion) {
        console.log('WaveformRegions: Found trimRegion:', {
            start: trimRegion.start,
            end: trimRegion.end
        });
        return {
            trimStartTime: trimRegion.start,
            trimEndTime: trimRegion.end
        };
    } else {
        console.log('WaveformRegions: No trimRegion found. Available regions:', 
            Array.isArray(regions) ? regions.map(r => r.id) : Object.keys(regions || {}));
    }
    
    return null;
}

/**
 * Set up region event handlers
 * @param {object} wavesurferInstance - The WaveSurfer instance
 */
function setupRegionEventHandlers(wavesurferInstance) {
    if (!wsRegions || !wavesurferInstance) {
        console.warn('WaveformRegions: Cannot setup region events - missing dependencies');
        return;
    }
    
    console.log('WaveformRegions: Setting up region event handlers...');
    
    // Handle when regions are created
    wsRegions.on('region-created', (region) => {
        if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
        console.log('WaveformRegions: Region created event fired:', region.id);
        updateTrimInputsFromRegion(region);
        
        // Apply cut overlays when trim region is created
        if (region.id === 'trimRegion') {
            setTimeout(() => {
                console.log('WaveformRegions: Applying cut overlays after trim region created');
                styleRegions(wavesurferInstance);
            }, 100);
        }
    });
    
    // Handle when regions are updated (dragged/resized)
    wsRegions.on('region-updated', (region) => {
        if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
        console.log('WaveformRegions: Region updated event fired:', region.id);
        updateTrimInputsFromRegion(region);
        
        // Update cut overlays when trim region is updated
        if (region.id === 'trimRegion') {
            setTimeout(() => {
                console.log('WaveformRegions: Updating cut overlays after trim region updated');
                styleRegions(wavesurferInstance);
            }, 50);
        }
    });
    
    // Handle when region update ends (final position)
    wsRegions.on('region-update-end', (region) => {
        if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
        console.log('WaveformRegions: Region update ended event fired:', region.id);
        updateTrimInputsFromRegion(region);
        
        // Update cut overlays when trim region update ends
        if (region.id === 'trimRegion') {
            setTimeout(() => {
                console.log('WaveformRegions: Finalizing cut overlays after trim region update ended');
                styleRegions(wavesurferInstance);
            }, 100);
        }
    });
    
    // Handle when regions are removed
    wsRegions.on('region-removed', (region) => {
        if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
        console.log('WaveformRegions: Region removed event fired:', region.id);
        // Only treat as full-duration reset if the actual trim region was removed by the user.
        if (region && region.id === 'trimRegion') {
            updateTrimInputsFromRegion(null);
        } else {
            // Ignore removal of non-trim overlay regions to avoid clobbering trims
            console.log('WaveformRegions: Non-trim region removed; ignoring for trim inputs.');
        }
    });
    
    // Handle region click events
    wsRegions.on('region-clicked', (region, event) => {
        if (!wavesurferInstance || !wsRegions || isDestroyingWaveform) return;
        console.log('WaveformRegions: Region clicked event fired:', region.id);
        // Optionally seek to region start on click
        const duration = wavesurferInstance.getDuration();
        if (duration > 0) {
            wavesurferInstance.seekTo(region.start / duration);
        }
    });
    
    console.log('WaveformRegions: Region event handlers setup completed');
}

/**
 * Force waveform refresh by restyling regions
 * @param {object} wavesurferInstance - The WaveSurfer instance
 */
function forceWaveformRefresh(wavesurferInstance) {
    if (!wsRegions || !wavesurferInstance) {
        console.warn('WaveformRegions: Cannot refresh - missing dependencies');
        return;
    }
    
    console.log('WaveformRegions: Forcing waveform refresh');
    
    try {
        // Re-apply region styling
        setTimeout(() => {
            styleRegions(wavesurferInstance);
        }, 100);
        
    } catch (error) {
        console.error('WaveformRegions: Error during waveform refresh:', error);
    }
}

export {
    initRegionModule,
    setRegionsInstance,
    getRegionsInstance,
    setDestroyingFlag,
    loadRegionsFromCue,
    clearAllRegionsHard,
    clearAllCutOverlaysImmediate,
    styleRegions,
    updateTrimInputsFromRegion,
    getCurrentTrimTimes,
    setupRegionEventHandlers,
    forceWaveformRefresh
};
