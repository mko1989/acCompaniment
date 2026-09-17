// Companion_soundboard/src/renderer/ui/waveformTrimControls.js

/**
 * Waveform Trim Controls Module
 * Handles trim start/end setting and clearing functionality
 */

// Dependencies
let wavesurferInstance = null;
let wsRegions = null;
let onTrimChangeCallback = null;

// DOM elements
let wfSetStartBtn = null;
let wfSetEndBtn = null;
let wfClearTrimBtn = null;

/**
 * Initialize the trim controls module
 * @param {object} dependencies - Object containing required modules and DOM elements
 */
function initTrimControls(dependencies) {
    wavesurferInstance = dependencies.wavesurferInstance;
    wsRegions = dependencies.wsRegions;
    onTrimChangeCallback = dependencies.onTrimChange;
    wfSetStartBtn = dependencies.wfSetStartBtn;
    wfSetEndBtn = dependencies.wfSetEndBtn;
    wfClearTrimBtn = dependencies.wfClearTrimBtn;
    
    console.log('WaveformTrimControls: Initialized with dependencies:', {
        wavesurferInstance: !!wavesurferInstance,
        wsRegions: !!wsRegions,
        onTrimChange: !!onTrimChangeCallback,
        setStartBtn: !!wfSetStartBtn,
        setEndBtn: !!wfSetEndBtn,
        clearBtn: !!wfClearTrimBtn
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
    if (dependencies.wsRegions !== undefined) {
        wsRegions = dependencies.wsRegions;
    }
    if (dependencies.onTrimChange !== undefined) {
        onTrimChangeCallback = dependencies.onTrimChange;
    }
}

/**
 * Handle setting trim start
 */
function handleSetTrimStart() {
    console.log('WaveformTrimControls: handleSetTrimStart called');
    
    // Always get the current instance dynamically to handle waveform recreation
    const currentWavesurfer = wavesurferInstance || (window.WaveformCore ? window.WaveformCore.getWavesurferInstance() : null);
    const currentRegions = wsRegions || (currentWavesurfer && currentWavesurfer.plugins ? currentWavesurfer.plugins[0] : null);
    
    if (!currentWavesurfer || !currentRegions) {
        console.error('WaveformTrimControls: Cannot set trim start - missing dependencies', {
            wavesurfer: !!currentWavesurfer,
            regions: !!currentRegions
        });
        return;
    }
    
    const duration = currentWavesurfer.getDuration();
    
    // Verify WaveSurfer is fully initialized by checking if duration is available
    if (!duration || duration <= 0) {
        console.error('WaveformTrimControls: WaveSurfer is not fully initialized (no duration available)');
        return;
    }
    
    const currentTime = currentWavesurfer.getCurrentTime();
    
    if (currentTime < 0 || currentTime >= duration) {
        console.warn('WaveformTrimControls: Invalid current time for trim start:', currentTime);
        return;
    }
    
    console.log('WaveformTrimControls: Setting trim start at:', currentTime);
    
    try {
        // Get existing regions
        const regions = currentRegions.getRegions();
        let existingTrimRegion = null;
        
        if (Array.isArray(regions)) {
            existingTrimRegion = regions.find(r => r && r.id === 'trimRegion');
        } else if (regions && typeof regions === 'object') {
            existingTrimRegion = regions['trimRegion'];
        }
        
        // Clear all existing regions first
        clearAllRegionsWithInstance(currentRegions);
        
        // Create new trim region with proper cut point behavior
        let trimEnd = duration; // Default to end of file
        
        if (existingTrimRegion) {
            // If we had an existing trim region, preserve its end time if it's after current position
            trimEnd = Math.max(currentTime + 0.01, existingTrimRegion.end);
        }
        
        // Create the main trim region (what will be kept)
        const trimRegion = currentRegions.addRegion({
            id: 'trimRegion',
            start: currentTime,
            end: trimEnd,
            color: 'rgba(0, 255, 0, 0.3)', // Green for what we keep
            drag: true,
            resize: true
        });
        
        // Create cut overlay for the beginning (what will be cut)
        if (currentTime > 0.01) {
            currentRegions.addRegion({
                id: 'cutOverlay-start',
                start: 0,
                end: Math.max(0, currentTime - 0.01),
                color: 'rgba(255, 0, 0, 0.4)', // Red overlay for what will be cut
                drag: false,
                resize: false
            });
        }
        
        console.log('WaveformTrimControls: Created trim region with cut points');
        
        // Notify callback
        if (typeof onTrimChangeCallback === 'function') {
            onTrimChangeCallback(currentTime, trimEnd);
        }
        
    } catch (error) {
        console.error('WaveformTrimControls: Error setting trim start:', error);
    }
}

/**
 * Handle setting trim end
 */
function handleSetTrimEnd() {
    console.log('WaveformTrimControls: handleSetTrimEnd called');
    
    // Always get the current instance dynamically to handle waveform recreation
    const currentWavesurfer = wavesurferInstance || (window.WaveformCore ? window.WaveformCore.getWavesurferInstance() : null);
    const currentRegions = wsRegions || (currentWavesurfer && currentWavesurfer.plugins ? currentWavesurfer.plugins[0] : null);
    
    if (!currentWavesurfer || !currentRegions) {
        console.error('WaveformTrimControls: Cannot set trim end - missing dependencies', {
            wavesurfer: !!currentWavesurfer,
            regions: !!currentRegions
        });
        return;
    }
    
    const duration = currentWavesurfer.getDuration();
    
    // Verify WaveSurfer is fully initialized by checking if duration is available
    if (!duration || duration <= 0) {
        console.error('WaveformTrimControls: WaveSurfer is not fully initialized (no duration available)');
        return;
    }
    
    const currentTime = currentWavesurfer.getCurrentTime();
    
    if (currentTime < 0 || currentTime >= duration) {
        console.warn('WaveformTrimControls: Invalid current time for trim end:', currentTime);
        return;
    }
    
    console.log('WaveformTrimControls: Setting trim end at:', currentTime);
    
    try {
        // Get existing regions
        const regions = currentRegions.getRegions();
        let existingTrimRegion = null;
        
        if (Array.isArray(regions)) {
            existingTrimRegion = regions.find(r => r && r.id === 'trimRegion');
        } else if (regions && typeof regions === 'object') {
            existingTrimRegion = regions['trimRegion'];
        }
        
        // Clear all existing regions first
        clearAllRegionsWithInstance(currentRegions);
        
        // Create new trim region with proper cut point behavior
        let trimStart = 0; // Default to start of file
        
        if (existingTrimRegion) {
            // If we had an existing trim region, preserve its start time if it's before current position
            trimStart = Math.min(currentTime - 0.01, existingTrimRegion.start);
        }
        
        // Create the main trim region (what will be kept)
        const trimRegion = currentRegions.addRegion({
            id: 'trimRegion',
            start: trimStart,
            end: currentTime,
            color: 'rgba(0, 255, 0, 0.3)', // Green for what we keep
            drag: true,
            resize: true
        });
        
        // Create cut overlay for the end (what will be cut)
        if (currentTime < duration - 0.01) {
            currentRegions.addRegion({
                id: 'cutOverlay-end',
                start: Math.min(duration, currentTime + 0.01),
                end: duration,
                color: 'rgba(255, 0, 0, 0.4)', // Red overlay for what will be cut
                drag: false,
                resize: false
            });
        }
        
        console.log('WaveformTrimControls: Created trim region with cut points');
        
        // Notify callback
        if (typeof onTrimChangeCallback === 'function') {
            onTrimChangeCallback(trimStart, currentTime);
        }
        
    } catch (error) {
        console.error('WaveformTrimControls: Error setting trim end:', error);
    }
}

/**
 * Clear all regions from a specific regions instance
 * @param {object} regionsInstance - The regions plugin instance to clear
 */
function clearAllRegionsWithInstance(regionsInstance) {
    if (!regionsInstance) {
        console.warn('WaveformTrimControls: Cannot clear regions - regionsInstance not available');
        return;
    }
    
    console.log('WaveformTrimControls: Clearing all regions including cut overlays');
    
    try {
        // Get all regions and remove them - need to iterate multiple times to catch all
        // This is because removing regions can change the array during iteration
        let regionsCleared = 0;
        let maxIterations = 10; // Safety limit
        let iteration = 0;
        
        while (iteration < maxIterations) {
            const regions = regionsInstance.getRegions();
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
                            // Log which region we're removing for debugging
                            console.log(`WaveformTrimControls: Removing region: ${region.id || 'unnamed'}`);
                            region.remove();
                            clearedThisIteration++;
                        } catch (e) {
                            console.warn('WaveformTrimControls: Error removing region:', region.id, e);
                        }
                    }
                });
            }
            
            regionsCleared += clearedThisIteration;
            
            if (clearedThisIteration === 0) {
                break; // No regions cleared this iteration, we're done
            }
            
            iteration++;
        }
        
        console.log(`WaveformTrimControls: Cleared ${regionsCleared} regions in ${iteration} iterations`);
        
        // Force clear the regions list as a fallback
        if (regionsInstance.clearRegions && typeof regionsInstance.clearRegions === 'function') {
            regionsInstance.clearRegions();
            console.log('WaveformTrimControls: Called clearRegions() on regions instance as fallback');
        }
        
    } catch (error) {
        console.error('WaveformTrimControls: Error clearing regions:', error);
    }
}

/**
 * Clear all regions from the waveform (uses current instance)
 */
function clearAllRegions() {
    const currentWavesurfer = wavesurferInstance || (window.WaveformCore ? window.WaveformCore.getWavesurferInstance() : null);
    const currentRegions = wsRegions || (currentWavesurfer && currentWavesurfer.plugins ? currentWavesurfer.plugins[0] : null);
    
    if (!currentRegions) {
        console.warn('WaveformTrimControls: Cannot clear regions - no regions instance available');
        return;
    }
    
    clearAllRegionsWithInstance(currentRegions);
}

/**
 * Handle clearing trim
 */
function handleClearTrim() {
    console.log('WaveformTrimControls: handleClearTrim called');
    
    // Always get the current instance dynamically
    const currentWavesurfer = wavesurferInstance || (window.WaveformCore ? window.WaveformCore.getWavesurferInstance() : null);
    const currentRegions = wsRegions || (currentWavesurfer && currentWavesurfer.plugins ? currentWavesurfer.plugins[0] : null);
    
    if (!currentRegions) {
        console.error('WaveformTrimControls: Cannot clear trim - no regions instance available');
        return;
    }
    
    try {
        // Clear all regions including trim region and cut overlays from main waveform
        clearAllRegionsWithInstance(currentRegions);
        
        // Force immediate visual refresh by clearing any remaining DOM elements
        if (currentWavesurfer && currentWavesurfer.container) {
            // First pass - immediate cleanup
            const regionElements = currentWavesurfer.container.querySelectorAll('.wavesurfer-region');
            regionElements.forEach(el => {
                try {
                    el.remove();
                } catch (e) {
                    console.warn('WaveformTrimControls: Error removing region element:', e);
                }
            });
            console.log(`WaveformTrimControls: Removed ${regionElements.length} region DOM elements (immediate)`);
        }
        
        // Second pass after a delay to catch any late-rendering elements
        setTimeout(() => {
            if (currentWavesurfer && currentWavesurfer.container) {
                const remainingElements = currentWavesurfer.container.querySelectorAll('.wavesurfer-region');
                if (remainingElements.length > 0) {
                    remainingElements.forEach(el => {
                        try {
                            el.remove();
                        } catch (e) {
                            console.warn('WaveformTrimControls: Error removing remaining region element:', e);
                        }
                    });
                    console.log(`WaveformTrimControls: Removed ${remainingElements.length} remaining region DOM elements (delayed cleanup)`);
                }
            }
        }, 100);
        
        // Notify callback with null values to indicate full duration (no trim)
        if (typeof onTrimChangeCallback === 'function') {
            onTrimChangeCallback(null, null);
        }
        
        console.log('WaveformTrimControls: Trim cleared successfully - both in and out points removed');
        
    } catch (error) {
        console.error('WaveformTrimControls: Error clearing trim:', error);
    }
}

/**
 * Bind event listeners for trim control buttons
 */
function bindTrimControlEvents() {
    console.log('WaveformTrimControls: Binding trim control events');
    
    if (wfSetStartBtn) {
        wfSetStartBtn.addEventListener('click', handleSetTrimStart);
        console.log('WaveformTrimControls: Set start button listener bound');
    } else {
        console.warn('WaveformTrimControls: wfSetStartBtn not found');
    }
    
    if (wfSetEndBtn) {
        wfSetEndBtn.addEventListener('click', handleSetTrimEnd);
        console.log('WaveformTrimControls: Set end button listener bound');
    } else {
        console.warn('WaveformTrimControls: wfSetEndBtn not found');
    }
    
    if (wfClearTrimBtn) {
        wfClearTrimBtn.addEventListener('click', handleClearTrim);
        console.log('WaveformTrimControls: Clear trim button listener bound');
    } else {
        console.warn('WaveformTrimControls: wfClearTrimBtn not found');
    }
}

/**
 * Unbind event listeners for trim control buttons
 */
function unbindTrimControlEvents() {
    console.log('WaveformTrimControls: Unbinding trim control events');
    
    if (wfSetStartBtn) {
        wfSetStartBtn.removeEventListener('click', handleSetTrimStart);
    }
    
    if (wfSetEndBtn) {
        wfSetEndBtn.removeEventListener('click', handleSetTrimEnd);
    }
    
    if (wfClearTrimBtn) {
        wfClearTrimBtn.removeEventListener('click', handleClearTrim);
    }
}

export {
    initTrimControls,
    updateDependencies,
    handleSetTrimStart,
    handleSetTrimEnd,
    handleClearTrim,
    bindTrimControlEvents,
    unbindTrimControlEvents
};
