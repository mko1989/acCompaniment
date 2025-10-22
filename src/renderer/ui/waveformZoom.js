// Companion_soundboard/src/renderer/ui/waveformZoom.js

/**
 * Waveform Zoom Management Module
 * Handles zoom functionality for both main and expanded waveforms
 */

// Zoom state variables
let zoomLevel = 0; // Start at minimum zoom (0-100 scale, higher = more zoomed in)
let maxZoom = 1000; // Maximum zoom level (increased for better zoom range) 
let minZoom = 0; // Minimum zoom level
let expandedZoomLevel = 0; // Zoom level for expanded waveform

// DOM elements for expanded waveform zoom
let expandedWaveformDisplay = null;
let expandedWaveformInstance = null;

/**
 * Initialize the zoom module with required dependencies
 * @param {object} dependencies - Object containing expanded waveform elements
 */
function initZoomModule(dependencies) {
    expandedWaveformDisplay = dependencies.expandedWaveformDisplay;
    expandedWaveformInstance = dependencies.expandedWaveformInstance;
}

/**
 * Reset zoom to show the entire track
 * @param {object} wavesurferInstance - The main WaveSurfer instance
 */
function resetZoom(wavesurferInstance) {
    if (wavesurferInstance) {
        zoomLevel = 0; // Reset to minimum zoom level
        wavesurferInstance.zoom(1); // Minimum effective zoom for wavesurfer (0 would be invalid)
        console.log('WaveformZoom: Zoom reset to default level (level 0)');
    }
}

/**
 * Reset expanded waveform zoom
 */
function resetExpandedZoom() {
    if (expandedWaveformInstance) {
        expandedZoomLevel = 0; // Reset to minimum zoom level
        expandedWaveformInstance.zoom(1); // Minimum effective zoom for wavesurfer (0 would be invalid)
        console.log('WaveformZoom: Expanded zoom reset to default level (level 0)');
    }
}

/**
 * Set up zoom functionality for expanded waveform
 */
function setupExpandedWaveformZoom() {
    if (!expandedWaveformInstance || !expandedWaveformDisplay) {
        console.warn('WaveformZoom: Cannot setup zoom - missing expandedWaveformInstance or expandedWaveformDisplay');
        return;
    }
    
    console.log('WaveformZoom: Setting up SIMPLIFIED expanded waveform zoom functionality');
    
    // Check if event listeners are already attached to prevent duplicates
    if (expandedWaveformDisplay.hasAttribute('data-zoom-setup')) {
        console.log('WaveformZoom: Zoom already set up for this element');
        return;
    }
    
    // Clear any existing zoom event listeners first
    cleanupExpandedZoomHandlers();
    
    // Add zoom functionality with mouse wheel - simplified and working version
    const wheelHandler = (e) => {
        console.log('WaveformZoom: ZOOM WHEEL EVENT TRIGGERED!', {
            deltaY: e.deltaY,
            target: e.target.tagName,
            currentZoomLevel: expandedZoomLevel
        });
        
        e.preventDefault();
        e.stopPropagation();
        
        // Ensure the expanded waveform instance is still valid
        if (!expandedWaveformInstance || !expandedWaveformInstance.zoom) {
            console.warn('WaveformZoom: Expanded waveform instance invalid during zoom');
            return;
        }
        
        // Calculate new zoom level based on wheel direction
        const direction = e.deltaY < 0 ? 1 : -1; // 1 = zoom in, -1 = zoom out
        console.log('WaveformZoom: Zoom direction:', direction === 1 ? 'IN' : 'OUT');
        
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
        const oldZoomLevel = expandedZoomLevel;
        expandedZoomLevel += zoomStep;
        
        // Constrain zoom level between min and max values
        expandedZoomLevel = Math.min(Math.max(expandedZoomLevel, minZoom), maxZoom);
        
        console.log(`WaveformZoom: Zoom level change: ${oldZoomLevel} -> ${expandedZoomLevel} (step: ${zoomStep})`);
        
        // Apply the zoom - simplified approach
        try {
            if (expandedZoomLevel <= minZoom || expandedZoomLevel === 0) {
                // Reset to default zoom
                expandedWaveformInstance.zoom(1);
                expandedZoomLevel = 0;
                console.log('WaveformZoom: Expanded zoom reset to default level');
            } else {
                // Simple zoom calculation that actually works
                const actualZoomValue = Math.max(1, expandedZoomLevel);
                expandedWaveformInstance.zoom(actualZoomValue);
                console.log(`WaveformZoom: Expanded zoom applied: ${expandedZoomLevel} -> ${actualZoomValue}`);
            }
        } catch (zoomError) {
            console.error('WaveformZoom: Error applying expanded zoom:', zoomError);
        }
    };
    
    const dblClickHandler = (e) => {
        console.log('WaveformZoom: ZOOM DOUBLE-CLICK EVENT TRIGGERED!', {
            target: e.target.tagName,
            currentZoomLevel: expandedZoomLevel
        });
        
        e.preventDefault();
        e.stopPropagation();
        
        // Ensure the expanded waveform instance is still valid
        if (!expandedWaveformInstance || !expandedWaveformInstance.zoom) {
            console.warn('WaveformZoom: Expanded waveform instance invalid during double-click reset');
            return;
        }
        
        try {
            resetExpandedZoom();
            console.log('WaveformZoom: Expanded zoom reset via double-click');
        } catch (resetError) {
            console.error('WaveformZoom: Error resetting expanded zoom:', resetError);
        }
    };
    
    // Store handlers on the element for potential cleanup
    expandedWaveformDisplay._wheelHandler = wheelHandler;
    expandedWaveformDisplay._dblClickHandler = dblClickHandler;
    
    // Add the event listeners with passive: false to allow preventDefault
    expandedWaveformDisplay.addEventListener('wheel', wheelHandler, { passive: false });
    expandedWaveformDisplay.addEventListener('dblclick', dblClickHandler);
    
    // Mark as set up to prevent duplicate listeners
    expandedWaveformDisplay.setAttribute('data-zoom-setup', 'true');
    
    console.log('WaveformZoom: Expanded zoom event listeners added to container');
}

/**
 * Helper function to clean up expanded zoom handlers
 */
function cleanupExpandedZoomHandlers() {
    if (expandedWaveformDisplay) {
        // Remove main handlers
        if (expandedWaveformDisplay._wheelHandler) {
            expandedWaveformDisplay.removeEventListener('wheel', expandedWaveformDisplay._wheelHandler);
            delete expandedWaveformDisplay._wheelHandler;
        }
        if (expandedWaveformDisplay._dblClickHandler) {
            expandedWaveformDisplay.removeEventListener('dblclick', expandedWaveformDisplay._dblClickHandler);
            delete expandedWaveformDisplay._dblClickHandler;
        }
        
        // Clean up canvas handlers
        const canvasElements = expandedWaveformDisplay.querySelectorAll('canvas[data-zoom-setup]');
        canvasElements.forEach(canvas => {
            canvas.removeAttribute('data-zoom-setup');
        });
        
        // Clean up wrapper handlers
        const wrapper = expandedWaveformDisplay.querySelector('.wavesurfer[data-zoom-setup]');
        if (wrapper) {
            wrapper.removeAttribute('data-zoom-setup');
        }
        
        expandedWaveformDisplay.removeAttribute('data-zoom-setup');
        console.log('WaveformZoom: Cleaned up existing zoom handlers');
    }
}

/**
 * Simplified setup function for zoom after waveform is ready
 */
function setupExpandedZoomAfterReady() {
    if (!expandedWaveformInstance || !expandedWaveformDisplay) {
        console.warn('WaveformZoom: Cannot setup zoom - missing expandedWaveformInstance or expandedWaveformDisplay');
        return;
    }
    
    console.log('WaveformZoom: Setting up zoom after ready event');
    
    // The main container already has zoom handlers attached via setupExpandedWaveformZoom
    // We just need to verify the canvas elements exist and optionally attach to them
    
    let setupAttempts = 0;
    const maxAttempts = 5;
    
    const setupCanvasZoom = () => {
        setupAttempts++;
        console.log(`WaveformZoom: Canvas zoom verification attempt ${setupAttempts}/${maxAttempts}`);
        
        const canvasElements = expandedWaveformDisplay.querySelectorAll('canvas');
        const waveSurferWrapper = expandedWaveformDisplay.querySelector('.wavesurfer');
        
        console.log(`WaveformZoom: Found ${canvasElements.length} canvas elements, waveSurferWrapper: ${!!waveSurferWrapper}`);
        
        if (canvasElements.length > 0 || waveSurferWrapper) {
            // Get handlers from the container
            const wheelHandler = expandedWaveformDisplay._wheelHandler;
            const dblClickHandler = expandedWaveformDisplay._dblClickHandler;
            
            if (wheelHandler && dblClickHandler) {
                // Add listeners to canvas elements for better zoom responsiveness
                canvasElements.forEach((canvas, index) => {
                    if (!canvas.hasAttribute('data-zoom-setup')) {
                        canvas.addEventListener('wheel', wheelHandler, { passive: false });
                        canvas.addEventListener('dblclick', dblClickHandler);
                        canvas.setAttribute('data-zoom-setup', 'true');
                        console.log('WaveformZoom: Added zoom handlers to canvas', index);
                    }
                });
                
                // Add to WaveSurfer wrapper for better coverage
                if (waveSurferWrapper && !waveSurferWrapper.hasAttribute('data-zoom-setup')) {
                    waveSurferWrapper.addEventListener('wheel', wheelHandler, { passive: false });
                    waveSurferWrapper.addEventListener('dblclick', dblClickHandler);
                    waveSurferWrapper.setAttribute('data-zoom-setup', 'true');
                    console.log('WaveformZoom: Added zoom handlers to WaveSurfer wrapper');
                }
                
                console.log('WaveformZoom: Zoom setup complete for all elements');
            } else {
                // Handlers not ready yet, retry if we haven't exceeded attempts
                if (setupAttempts < maxAttempts) {
                    setTimeout(setupCanvasZoom, 200);
                }
            }
        } else if (setupAttempts < maxAttempts) {
            // Canvas not rendered yet, retry with progressive delay
            const delay = 100 * setupAttempts;
            setTimeout(setupCanvasZoom, delay);
        } else {
            // Max attempts reached - this is OK, zoom still works on container
            console.log('WaveformZoom: Canvas elements not found after', maxAttempts, 'attempts');
            console.log('WaveformZoom: Zoom functionality is still available on the container element');
        }
    };
    
    // Start canvas setup with initial delay to ensure DOM is rendered
    setTimeout(setupCanvasZoom, 150);
}

/**
 * Update expanded waveform instance reference
 * @param {object} instance - The expanded WaveSurfer instance
 */
function updateExpandedWaveformInstance(instance) {
    expandedWaveformInstance = instance;
}

/**
 * Get current zoom level
 * @returns {number} Current zoom level
 */
function getZoomLevel() {
    return zoomLevel;
}

/**
 * Get current expanded zoom level
 * @returns {number} Current expanded zoom level
 */
function getExpandedZoomLevel() {
    return expandedZoomLevel;
}

export {
    initZoomModule,
    resetZoom,
    resetExpandedZoom,
    setupExpandedWaveformZoom,
    cleanupExpandedZoomHandlers,
    setupExpandedZoomAfterReady,
    updateExpandedWaveformInstance,
    getZoomLevel,
    getExpandedZoomLevel
};
