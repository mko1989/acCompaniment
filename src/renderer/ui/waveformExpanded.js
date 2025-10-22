// Companion_soundboard/src/renderer/ui/waveformExpanded.js

/**
 * Waveform Expanded Module
 * Handles the expanded waveform functionality in the bottom panel
 */

// Expanded waveform state
let expandedWaveformCanvas = null;
let expandedWaveformInstance = null; // Expanded waveform WaveSurfer instance
let expandedAnimationId = null;
let currentExpandedCue = null;

// DOM elements for expanded waveform
let expandedWaveformDisplay = null;
let expandedWaveformControls = null;
let expandedWfSetStartBtn = null;
let expandedWfSetEndBtn = null;
let expandedWfPlayPauseBtn = null;
let expandedWfStopBtn = null;
let expandedWfClearTrimBtn = null;
let expandedWfCurrentTime = null;
let expandedWfTotalDuration = null;
let expandedWfRemainingTime = null;

// Dependencies
let wavesurferInstance = null;
let wsRegions = null;
let currentAudioFilePath = null;
let onTrimChangeCallback = null;

/**
 * Initialize the expanded waveform module
 * @param {object} dependencies - Object containing required modules and DOM elements
 */
function initExpandedWaveform(dependencies) {
    expandedWaveformDisplay = dependencies.expandedWaveformDisplay;
    expandedWaveformControls = dependencies.expandedWaveformControls;
    expandedWfSetStartBtn = dependencies.expandedWfSetStartBtn;
    expandedWfSetEndBtn = dependencies.expandedWfSetEndBtn;
    expandedWfPlayPauseBtn = dependencies.expandedWfPlayPauseBtn;
    expandedWfStopBtn = dependencies.expandedWfStopBtn;
    expandedWfClearTrimBtn = dependencies.expandedWfClearTrimBtn;
    expandedWfCurrentTime = dependencies.expandedWfCurrentTime;
    expandedWfTotalDuration = dependencies.expandedWfTotalDuration;
    expandedWfRemainingTime = dependencies.expandedWfRemainingTime;
    
    wavesurferInstance = dependencies.wavesurferInstance;
    wsRegions = dependencies.wsRegions;
    currentAudioFilePath = dependencies.currentAudioFilePath;
    onTrimChangeCallback = dependencies.onTrimChange;
    
    console.log('WaveformExpanded: Initialized with dependencies:', {
        display: !!expandedWaveformDisplay,
        controls: !!expandedWaveformControls,
        setStartBtn: !!expandedWfSetStartBtn,
        setEndBtn: !!expandedWfSetEndBtn,
        playPauseBtn: !!expandedWfPlayPauseBtn,
        stopBtn: !!expandedWfStopBtn,
        clearBtn: !!expandedWfClearTrimBtn,
        currentTime: !!expandedWfCurrentTime,
        totalDuration: !!expandedWfTotalDuration,
        remainingTime: !!expandedWfRemainingTime,
        wavesurferInstance: !!wavesurferInstance,
        wsRegions: !!wsRegions,
        audioFilePath: !!currentAudioFilePath,
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
    if (dependencies.wsRegions !== undefined) {
        wsRegions = dependencies.wsRegions;
    }
    if (dependencies.currentAudioFilePath !== undefined) {
        currentAudioFilePath = dependencies.currentAudioFilePath;
    }
    if (dependencies.onTrimChange !== undefined) {
        onTrimChangeCallback = dependencies.onTrimChange;
    }
}

/**
 * Create the expanded waveform
 * @param {function} setupZoomCallback - Callback to setup zoom functionality
 * @param {function} setupRegionsCallback - Callback to setup regions
 */
function createExpandedWaveform(setupZoomCallback, setupRegionsCallback) {
    console.log('WaveformExpanded: Creating expanded waveform');
    console.log('WaveformExpanded: expandedWaveformDisplay:', !!expandedWaveformDisplay);
    console.log('WaveformExpanded: currentAudioFilePath:', currentAudioFilePath);
    
    if (!expandedWaveformDisplay) {
        console.error('WaveformExpanded: Cannot create expanded waveform - expandedWaveformDisplay not found');
        return;
    }
    
    if (!currentAudioFilePath) {
        console.error('WaveformExpanded: Cannot create expanded waveform - currentAudioFilePath is null/undefined');
        console.error('WaveformExpanded: Make sure to call updateDependencies with currentAudioFilePath before creating expanded waveform');
        return;
    }
    
    // Clean up any existing expanded waveform first
    if (expandedWaveformInstance) {
        try {
            expandedWaveformInstance.destroy();
        } catch (error) {
            console.warn('WaveformExpanded: Error destroying previous expanded waveform:', error);
        }
        expandedWaveformInstance = null;
    }
    
    // Clear the display
    expandedWaveformDisplay.innerHTML = '';
    
    // Get the container height dynamically
    const containerHeight = expandedWaveformDisplay.clientHeight || 300;
    console.log('WaveformExpanded: Container height:', containerHeight);
    
    // Create the expanded waveform with a delay to ensure proper rendering
    createExpandedWaveformDelayed(containerHeight, setupZoomCallback, setupRegionsCallback);
}

/**
 * Create expanded waveform with delay
 * @param {number} waveformHeight - Height of the waveform
 * @param {function} setupZoomCallback - Callback to setup zoom functionality
 * @param {function} setupRegionsCallback - Callback to setup regions
 */
function createExpandedWaveformDelayed(waveformHeight, setupZoomCallback, setupRegionsCallback) {
    console.log('WaveformExpanded: Creating expanded waveform with delay');
    
    // Create a container for the expanded waveform
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = waveformHeight + 'px';
    container.style.border = '1px solid #ccc';
    container.style.borderRadius = '4px';
    container.style.overflow = 'hidden';
    
    expandedWaveformDisplay.appendChild(container);
    
    // Initialize WaveSurfer for expanded waveform
    try {
        console.log('WaveformExpanded: About to create WaveSurfer instance');
        console.log('WaveformExpanded: WaveSurfer available:', typeof WaveSurfer !== 'undefined');
        console.log('WaveformExpanded: Container element:', container);
        console.log('WaveformExpanded: Audio file path:', currentAudioFilePath);
        
        // Wait for WaveSurfer to be available
        if (typeof WaveSurfer === 'undefined') {
            console.error('WaveformExpanded: WaveSurfer is not available');
            return;
        }
        
        // Create WaveSurfer with settings matching main waveform for visual consistency
        expandedWaveformInstance = WaveSurfer.create({
            container: container,
            waveColor: '#4F46E5',
            progressColor: '#7C3AED',
            cursorColor: '#EF4444',
            barWidth: 2,
            barRadius: 3,
            responsive: true,
            height: waveformHeight,
            normalize: true,
            backend: 'WebAudio',
            mediaControls: false,
            interact: true, // Ensure interaction is enabled
            plugins: [
                WaveSurfer.Regions.create()
            ]
        });
        
        console.log('WaveformExpanded: Expanded WaveSurfer instance created successfully:', !!expandedWaveformInstance);
        
        // Load the audio file
        expandedWaveformInstance.load(currentAudioFilePath);
        
        // Set up events after the waveform is ready
        expandedWaveformInstance.on('ready', () => {
            console.log('WaveformExpanded: Expanded waveform ready');
            
            try {
                // Setup zoom functionality
                if (typeof setupZoomCallback === 'function') {
                    console.log('WaveformExpanded: Calling setupZoomCallback');
                    setupZoomCallback();
                }
            } catch (error) {
                console.error('WaveformExpanded: Error in setupZoomCallback:', error);
            }
            
            try {
                // Setup regions
                if (typeof setupRegionsCallback === 'function') {
                    console.log('WaveformExpanded: Calling setupRegionsCallback');
                    setupRegionsCallback();
                }
            } catch (error) {
                console.error('WaveformExpanded: Error in setupRegionsCallback:', error);
            }
            
            try {
                // Setup expanded waveform events
                setupExpandedWaveformEvents();
            } catch (error) {
                console.error('WaveformExpanded: Error in setupExpandedWaveformEvents:', error);
            }
            
            try {
                // Initial time display update
                updateExpandedTimeDisplay();
            } catch (error) {
                console.error('WaveformExpanded: Error updating time display:', error);
            }
            
            try {
                // Sync regions from main waveform if they exist
                syncRegionsFromMain();
            } catch (error) {
                console.error('WaveformExpanded: Error syncing regions from main:', error);
            }
            
            try {
                // Set up bidirectional synchronization
                setupBidirectionalSync();
            } catch (error) {
                console.error('WaveformExpanded: Error setting up bidirectional sync:', error);
            }
            
            // Initial sync to ensure both waveforms are in sync
            setTimeout(() => {
                try {
                    if (wavesurferInstance && expandedWaveformInstance) {
                        const mainCurrentTime = wavesurferInstance.getCurrentTime();
                        const expandedDuration = expandedWaveformInstance.getDuration();
                        if (expandedDuration > 0) {
                            expandedWaveformInstance.seekTo(mainCurrentTime / expandedDuration);
                        }
                    }
                } catch (error) {
                    console.error('WaveformExpanded: Error in initial sync:', error);
                }
            }, 100);
        });
        
        // Handle errors
        expandedWaveformInstance.on('error', (error) => {
            console.error('WaveformExpanded: Error loading expanded waveform:', error);
        });
        
    } catch (error) {
        console.error('WaveformExpanded: Error creating expanded waveform:', error);
    }
}

/**
 * Set up expanded waveform event handlers
 */
function setupExpandedWaveformEvents() {
    if (!expandedWaveformInstance) {
        console.warn('WaveformExpanded: Cannot setup events - no expanded waveform instance');
        return;
    }
    
    console.log('WaveformExpanded: Setting up expanded waveform events');
    
    // Time update events
    expandedWaveformInstance.on('audioprocess', (currentTime) => {
        updateExpandedTimeDisplay();
    });
    
    expandedWaveformInstance.on('seek', (seekProgress) => {
        updateExpandedTimeDisplay();
    });
    
    expandedWaveformInstance.on('timeupdate', (currentTime) => {
        updateExpandedTimeDisplay();
    });
    
    // Playback state events
    expandedWaveformInstance.on('play', () => {
        const playPauseImg = expandedWfPlayPauseBtn ? expandedWfPlayPauseBtn.querySelector('img') : null;
        if (playPauseImg) playPauseImg.src = '../../assets/icons/pause.png';
    });
    
    expandedWaveformInstance.on('pause', () => {
        const playPauseImg = expandedWfPlayPauseBtn ? expandedWfPlayPauseBtn.querySelector('img') : null;
        if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';
    });
    
    expandedWaveformInstance.on('finish', () => {
        const playPauseImg = expandedWfPlayPauseBtn ? expandedWfPlayPauseBtn.querySelector('img') : null;
        if (playPauseImg) playPauseImg.src = '../../assets/icons/play.png';
    });
    
    // Set up button event handlers
    setupExpandedWaveformButtonEvents();
    
    // Set up keyboard controls for precise editing
    setupExpandedKeyboardControls();
    
    console.log('WaveformExpanded: Expanded waveform events setup completed');
}

/**
 * Thoroughly clear all regions from expanded waveform with DOM cleanup
 * @param {object} regionsInstance - The regions plugin instance
 */
function clearExpandedRegionsThoroughly(regionsInstance) {
    if (!regionsInstance) {
        console.warn('WaveformExpanded: Cannot clear regions - no regions instance');
        return;
    }
    
    console.log('WaveformExpanded: Thoroughly clearing all regions');
    
    try {
        // First, use the regions API to remove all regions
        const regions = regionsInstance.getRegions();
        if (Array.isArray(regions)) {
            const regionsCopy = [...regions];
            regionsCopy.forEach(region => {
                if (region && typeof region.remove === 'function') {
                    try {
                        console.log(`WaveformExpanded: Removing region: ${region.id || 'unnamed'}`);
                        region.remove();
                    } catch (e) {
                        console.warn('WaveformExpanded: Error removing region:', e);
                    }
                }
            });
        }
        
        // Force clear using clearRegions if available
        if (regionsInstance.clearRegions && typeof regionsInstance.clearRegions === 'function') {
            regionsInstance.clearRegions();
        }
        
        // Then, do a DOM cleanup to remove any stray elements
        if (expandedWaveformInstance && expandedWaveformInstance.container) {
            // Immediate cleanup
            const regionElements = expandedWaveformInstance.container.querySelectorAll('.wavesurfer-region');
            regionElements.forEach(el => {
                try {
                    el.remove();
                } catch (e) {
                    console.warn('WaveformExpanded: Error removing region DOM element:', e);
                }
            });
            console.log(`WaveformExpanded: Removed ${regionElements.length} region DOM elements`);
            
            // Delayed cleanup to catch late-rendering elements
            setTimeout(() => {
                const remainingElements = expandedWaveformInstance.container.querySelectorAll('.wavesurfer-region');
                if (remainingElements.length > 0) {
                    remainingElements.forEach(el => {
                        try {
                            el.remove();
                        } catch (e) {
                            console.warn('WaveformExpanded: Error removing remaining region element:', e);
                        }
                    });
                    console.log(`WaveformExpanded: Removed ${remainingElements.length} remaining region DOM elements (delayed)`);
                }
            }, 50);
        }
    } catch (error) {
        console.error('WaveformExpanded: Error clearing regions:', error);
    }
}

/**
 * Set up expanded waveform button event handlers
 */
function setupExpandedWaveformButtonEvents() {
    console.log('WaveformExpanded: Setting up expanded waveform button events');
    
    // Play/Pause button
    if (expandedWfPlayPauseBtn) {
        expandedWfPlayPauseBtn.addEventListener('click', () => {
            console.log('WaveformExpanded: Play/Pause button clicked');
            if (expandedWaveformInstance) {
                if (expandedWaveformInstance.isPlaying()) {
                    expandedWaveformInstance.pause();
                } else {
                    expandedWaveformInstance.play();
                }
            }
        });
        console.log('WaveformExpanded: Play/Pause button event bound');
    } else {
        console.warn('WaveformExpanded: expandedWfPlayPauseBtn not found');
    }
    
    // Stop button
    if (expandedWfStopBtn) {
        expandedWfStopBtn.addEventListener('click', () => {
            console.log('WaveformExpanded: Stop button clicked');
            if (expandedWaveformInstance) {
                expandedWaveformInstance.pause();
                expandedWaveformInstance.seekTo(0);
            }
        });
        console.log('WaveformExpanded: Stop button event bound');
    } else {
        console.warn('WaveformExpanded: expandedWfStopBtn not found');
    }
    
    // Set Start button
    if (expandedWfSetStartBtn) {
        expandedWfSetStartBtn.addEventListener('click', () => {
            console.log('WaveformExpanded: Set Start button clicked');
            if (expandedWaveformInstance) {
                const currentTime = expandedWaveformInstance.getCurrentTime();
                const duration = expandedWaveformInstance.getDuration();
                
                if (currentTime >= 0 && currentTime < duration) {
                    // Use expanded waveform's own regions plugin
                    const expandedRegions = expandedWaveformInstance.plugins[0];
                    if (!expandedRegions) {
                        console.error('WaveformExpanded: No regions plugin available');
                        return;
                    }
                    
                    // Get existing regions to preserve trim end if it exists
                    const regions = expandedRegions.getRegions();
                    let existingTrimRegion = null;
                    
                    if (Array.isArray(regions)) {
                        existingTrimRegion = regions.find(r => r && r.id === 'trimRegion');
                    }
                    
                    // Clear all existing regions thoroughly with DOM cleanup
                    clearExpandedRegionsThoroughly(expandedRegions);
                    
                    // Determine trim end (preserve existing if possible)
                    let trimEnd = duration;
                    if (existingTrimRegion) {
                        trimEnd = Math.max(currentTime + 0.01, existingTrimRegion.end);
                    }
                    
                    // Create trim region in expanded waveform
                    expandedRegions.addRegion({
                        id: 'trimRegion',
                        start: currentTime,
                        end: trimEnd,
                        color: 'rgba(0, 255, 0, 0.3)',
                        drag: true,
                        resize: true
                    });
                    
                    // Create cut overlay for the beginning (what will be cut - red)
                    if (currentTime > 0.01) {
                        expandedRegions.addRegion({
                            id: 'cutOverlay-before',
                            start: 0,
                            end: Math.max(0, currentTime - 0.01),
                            color: 'rgba(255, 0, 0, 0.4)',
                            drag: false,
                            resize: false
                        });
                    }
                    
                    // Create cut overlay for the end if trimEnd is less than duration
                    if (trimEnd < duration - 0.01) {
                        expandedRegions.addRegion({
                            id: 'cutOverlay-after',
                            start: Math.min(duration, trimEnd + 0.01),
                            end: duration,
                            color: 'rgba(255, 0, 0, 0.4)',
                            drag: false,
                            resize: false
                        });
                    }
                    
                    // Sync to main waveform if it exists
                    if (wsRegions) {
                        try {
                            // Clear main waveform regions
                            const mainRegions = wsRegions.getRegions();
                            if (Array.isArray(mainRegions)) {
                                const mainRegionsCopy = [...mainRegions];
                                mainRegionsCopy.forEach(region => {
                                    if (region && typeof region.remove === 'function') {
                                        try {
                                            region.remove();
                                        } catch (e) {
                                            console.warn('WaveformExpanded: Error removing main region:', e);
                                        }
                                    }
                                });
                            }
                            
                            // Create trim region in main waveform
                            wsRegions.addRegion({
                                id: 'trimRegion',
                                start: currentTime,
                                end: trimEnd,
                                color: 'rgba(0, 255, 0, 0.3)',
                                drag: true,
                                resize: true
                            });
                            
                            // Create cut overlay in main waveform
                            if (currentTime > 0.01) {
                                wsRegions.addRegion({
                                    id: 'cutOverlay-before',
                                    start: 0,
                                    end: Math.max(0, currentTime - 0.01),
                                    color: 'rgba(255, 0, 0, 0.4)',
                                    drag: false,
                                    resize: false
                                });
                            }
                        } catch (error) {
                            console.warn('WaveformExpanded: Error syncing to main waveform:', error);
                        }
                    }
                    
                    // Notify callback
                    if (typeof onTrimChangeCallback === 'function') {
                        onTrimChangeCallback(currentTime, trimEnd);
                    }
                }
            }
        });
        console.log('WaveformExpanded: Set Start button event bound');
    } else {
        console.warn('WaveformExpanded: expandedWfSetStartBtn not found');
    }
    
    // Set End button
    if (expandedWfSetEndBtn) {
        expandedWfSetEndBtn.addEventListener('click', () => {
            console.log('WaveformExpanded: Set End button clicked');
            if (expandedWaveformInstance) {
                const currentTime = expandedWaveformInstance.getCurrentTime();
                const duration = expandedWaveformInstance.getDuration();
                
                if (currentTime >= 0 && currentTime < duration) {
                    // Use expanded waveform's own regions plugin
                    const expandedRegions = expandedWaveformInstance.plugins[0];
                    if (!expandedRegions) {
                        console.error('WaveformExpanded: No regions plugin available');
                        return;
                    }
                    
                    // Get existing regions to preserve trim start if it exists
                    const regions = expandedRegions.getRegions();
                    let existingTrimRegion = null;
                    
                    if (Array.isArray(regions)) {
                        existingTrimRegion = regions.find(r => r && r.id === 'trimRegion');
                    }
                    
                    // Clear all existing regions thoroughly with DOM cleanup
                    clearExpandedRegionsThoroughly(expandedRegions);
                    
                    // Determine trim start (preserve existing if possible)
                    let trimStart = 0;
                    if (existingTrimRegion) {
                        trimStart = Math.min(currentTime - 0.01, existingTrimRegion.start);
                    }
                    
                    // Create trim region in expanded waveform
                    expandedRegions.addRegion({
                        id: 'trimRegion',
                        start: trimStart,
                        end: currentTime,
                        color: 'rgba(0, 255, 0, 0.3)',
                        drag: true,
                        resize: true
                    });
                    
                    // Create cut overlay for the beginning if trimStart is greater than 0
                    if (trimStart > 0.01) {
                        expandedRegions.addRegion({
                            id: 'cutOverlay-before',
                            start: 0,
                            end: Math.max(0, trimStart - 0.01),
                            color: 'rgba(255, 0, 0, 0.4)',
                            drag: false,
                            resize: false
                        });
                    }
                    
                    // Create cut overlay for the end (what will be cut - red)
                    if (currentTime < duration - 0.01) {
                        expandedRegions.addRegion({
                            id: 'cutOverlay-after',
                            start: Math.min(duration, currentTime + 0.01),
                            end: duration,
                            color: 'rgba(255, 0, 0, 0.4)',
                            drag: false,
                            resize: false
                        });
                    }
                    
                    // Sync to main waveform if it exists
                    if (wsRegions) {
                        try {
                            // Clear main waveform regions
                            const mainRegions = wsRegions.getRegions();
                            if (Array.isArray(mainRegions)) {
                                const mainRegionsCopy = [...mainRegions];
                                mainRegionsCopy.forEach(region => {
                                    if (region && typeof region.remove === 'function') {
                                        try {
                                            region.remove();
                                        } catch (e) {
                                            console.warn('WaveformExpanded: Error removing main region:', e);
                                        }
                                    }
                                });
                            }
                            
                            // Create trim region in main waveform
                            wsRegions.addRegion({
                                id: 'trimRegion',
                                start: trimStart,
                                end: currentTime,
                                color: 'rgba(0, 255, 0, 0.3)',
                                drag: true,
                                resize: true
                            });
                            
                            // Create cut overlay in main waveform
                            if (currentTime < duration - 0.01) {
                                wsRegions.addRegion({
                                    id: 'cutOverlay-after',
                                    start: Math.min(duration, currentTime + 0.01),
                                    end: duration,
                                    color: 'rgba(255, 0, 0, 0.4)',
                                    drag: false,
                                    resize: false
                                });
                            }
                        } catch (error) {
                            console.warn('WaveformExpanded: Error syncing to main waveform:', error);
                        }
                    }
                    
                    // Notify callback
                    if (typeof onTrimChangeCallback === 'function') {
                        onTrimChangeCallback(trimStart, currentTime);
                    }
                }
            }
        });
        console.log('WaveformExpanded: Set End button event bound');
    } else {
        console.warn('WaveformExpanded: expandedWfSetEndBtn not found');
    }
    
    // Clear Trim button
    if (expandedWfClearTrimBtn) {
        expandedWfClearTrimBtn.addEventListener('click', () => {
            console.log('WaveformExpanded: Clear Trim button clicked');
            
            // Clear regions from expanded waveform first with thorough cleanup
            if (expandedWaveformInstance && expandedWaveformInstance.plugins[0]) {
                clearExpandedRegionsThoroughly(expandedWaveformInstance.plugins[0]);
            }
            
            // Clear regions from main waveform
            if (wsRegions) {
                // Clear all regions including trim region and cut overlays
                // Need to iterate multiple times to catch all regions
                let regionsCleared = 0;
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
                                    console.warn('WaveformExpanded: Error removing main waveform region:', e);
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
                
                console.log(`WaveformExpanded: Cleared ${regionsCleared} regions from main waveform in ${iteration} iterations`);
            }
            
            // Clear regions from expanded waveform
            if (expandedWaveformInstance && expandedWaveformInstance.plugins[0]) {
                const expandedRegions = expandedWaveformInstance.plugins[0];
                let regionsCleared = 0;
                let maxIterations = 10;
                let iteration = 0;
                
                while (iteration < maxIterations) {
                    const regions = expandedRegions.getRegions();
                    if (!regions || (Array.isArray(regions) && regions.length === 0)) {
                        break;
                    }
                    
                    let clearedThisIteration = 0;
                    if (Array.isArray(regions)) {
                        const regionsCopy = [...regions];
                        regionsCopy.forEach(region => {
                            if (region && typeof region.remove === 'function') {
                                try {
                                    region.remove();
                                    clearedThisIteration++;
                                } catch (e) {
                                    console.warn('WaveformExpanded: Error removing expanded waveform region:', e);
                                }
                            }
                        });
                    }
                    
                    regionsCleared += clearedThisIteration;
                    
                    if (clearedThisIteration === 0) {
                        break;
                    }
                    
                    iteration++;
                }
                
                console.log(`WaveformExpanded: Cleared ${regionsCleared} regions from expanded waveform in ${iteration} iterations`);
            }
            
            // Force visual refresh by removing any stray DOM elements from both waveforms
            setTimeout(() => {
                // Clear from main waveform
                if (wavesurferInstance && wavesurferInstance.container) {
                    const mainRegionElements = wavesurferInstance.container.querySelectorAll('.wavesurfer-region');
                    mainRegionElements.forEach(el => {
                        try {
                            el.remove();
                        } catch (e) {
                            console.warn('WaveformExpanded: Error removing main waveform region element:', e);
                        }
                    });
                    console.log(`WaveformExpanded: Removed ${mainRegionElements.length} stray region DOM elements from main waveform`);
                }
                
                // Clear from expanded waveform
                if (expandedWaveformInstance && expandedWaveformInstance.container) {
                    const expandedRegionElements = expandedWaveformInstance.container.querySelectorAll('.wavesurfer-region');
                    expandedRegionElements.forEach(el => {
                        try {
                            el.remove();
                        } catch (e) {
                            console.warn('WaveformExpanded: Error removing expanded waveform region element:', e);
                        }
                    });
                    console.log(`WaveformExpanded: Removed ${expandedRegionElements.length} stray region DOM elements from expanded waveform`);
                }
            }, 50);
            
            // Notify callback with null to indicate no trim (full duration)
            if (typeof onTrimChangeCallback === 'function') {
                onTrimChangeCallback(null, null);
            }
            
            console.log('WaveformExpanded: All trim regions cleared successfully from both waveforms');
        });
        console.log('WaveformExpanded: Clear Trim button event bound');
    } else {
        console.warn('WaveformExpanded: expandedWfClearTrimBtn not found');
    }
    
    console.log('WaveformExpanded: All expanded waveform button events setup completed');
}

/**
 * Set up expanded waveform regions
 * @param {function} resolveRegionsCallback - Callback to resolve regions plugin
 */
function setupExpandedWaveformRegions(resolveRegionsCallback) {
    if (!expandedWaveformInstance) {
        console.warn('WaveformExpanded: Cannot setup regions - no expanded waveform instance');
        return;
    }
    
    console.log('WaveformExpanded: Setting up expanded waveform regions');
    
    // Since this is typically called from the 'ready' event handler,
    // we can directly proceed to setup. If called early, we'll wait for ready event.
    const duration = expandedWaveformInstance.getDuration ? expandedWaveformInstance.getDuration() : 0;
    
    if (duration > 0) {
        // Waveform is ready, setup regions immediately
        setupExpandedWaveformRegionsAfterReady(resolveRegionsCallback);
    } else {
        // Waveform not ready yet, wait for ready event
        console.log('WaveformExpanded: Waveform not ready yet (duration is 0), waiting for ready event');
        expandedWaveformInstance.once('ready', () => {
            console.log('WaveformExpanded: Waveform ready event fired, setting up regions');
            setupExpandedWaveformRegionsAfterReady(resolveRegionsCallback);
        });
    }
}

/**
 * Set up expanded waveform regions after ready
 * @param {function} resolveRegionsCallback - Callback to resolve regions plugin
 */
function setupExpandedWaveformRegionsAfterReady(resolveRegionsCallback) {
    console.log('WaveformExpanded: Setting up expanded waveform regions after ready');
    
    if (!expandedWaveformInstance) {
        console.error('WaveformExpanded: Cannot setup regions - expandedWaveformInstance is null');
        return;
    }
    
    // Verify the waveform is actually ready
    const duration = expandedWaveformInstance.getDuration ? expandedWaveformInstance.getDuration() : 0;
    if (duration <= 0) {
        console.warn('WaveformExpanded: Waveform duration is not available yet, cannot setup regions');
        return;
    }
    
    try {
        // Get the regions plugin for expanded waveform
        const expandedRegions = resolveRegionsCallback ? resolveRegionsCallback() : null;
        
        if (expandedRegions) {
            console.log('WaveformExpanded: Expanded regions plugin resolved');
            
            // Copy regions from main waveform if they exist
            if (wsRegions) {
                const mainRegions = wsRegions.getRegions();
                if (Array.isArray(mainRegions)) {
                    const trimRegion = mainRegions.find(r => r && r.id === 'trimRegion');
                    if (trimRegion) {
                        // Create corresponding region in expanded waveform
                        expandedRegions.addRegion({
                            id: 'trimRegion',
                            start: trimRegion.start,
                            end: trimRegion.end,
                            color: 'rgba(0, 255, 0, 0.3)',
                            drag: true,
                            resize: true
                        });
                        console.log('WaveformExpanded: Copied trim region to expanded waveform');
                    }
                }
            }
        } else {
            console.warn('WaveformExpanded: Could not resolve expanded regions plugin');
        }
        
    } catch (error) {
        console.error('WaveformExpanded: Error setting up expanded waveform regions:', error);
        console.error('Stack trace:', error.stack);
    }
}

/**
 * Sync regions from main waveform to expanded waveform
 */
function syncRegionsFromMain() {
    if (!expandedWaveformInstance || !wsRegions) {
        console.warn('WaveformExpanded: Cannot sync regions - missing dependencies');
        return;
    }
    
    console.log('WaveformExpanded: Syncing regions from main waveform');
    
    try {
        const mainRegions = wsRegions.getRegions();
        const expandedRegions = expandedWaveformInstance.plugins[0];
        
        if (!expandedRegions) {
            console.warn('WaveformExpanded: No expanded regions plugin available');
            return;
        }
        
        // Clear existing regions in expanded waveform
        const existingRegions = expandedRegions.getRegions();
        if (Array.isArray(existingRegions)) {
            existingRegions.forEach(region => {
                if (region && typeof region.remove === 'function') {
                    region.remove();
                }
            });
        }
        
        // Copy regions from main waveform
        if (Array.isArray(mainRegions)) {
            mainRegions.forEach(region => {
                if (region && region.id === 'trimRegion') {
                    try {
                        expandedRegions.addRegion({
                            id: 'trimRegion',
                            start: region.start,
                            end: region.end,
                            color: 'rgba(0, 255, 0, 0.3)',
                            drag: true,
                            resize: true
                        });
                        console.log('WaveformExpanded: Copied trim region to expanded waveform');
                        
                        // Set up region event handlers for expanded waveform
                        const expandedRegion = expandedRegions.getRegions().find(r => r.id === 'trimRegion');
                        if (expandedRegion) {
                            expandedRegion.on('update-end', () => {
                                // Sync region changes back to main waveform
                                syncRegionToMain(expandedRegion);
                            });
                        }
                    } catch (error) {
                        console.warn('WaveformExpanded: Error copying region:', error);
                    }
                }
            });
        }
        
        // Also sync any cut overlay regions
        if (Array.isArray(mainRegions)) {
            mainRegions.forEach(region => {
                if (region && (region.id === 'cutOverlay-start' || region.id === 'cutOverlay-end')) {
                    try {
                        expandedRegions.addRegion({
                            id: region.id,
                            start: region.start,
                            end: region.end,
                            color: region.color || 'rgba(255, 0, 0, 0.4)',
                            drag: false,
                            resize: false
                        });
                        console.log('WaveformExpanded: Copied cut overlay region to expanded waveform');
                    } catch (error) {
                        console.warn('WaveformExpanded: Error copying cut overlay region:', error);
                    }
                }
            });
        }
    } catch (error) {
        console.error('WaveformExpanded: Error syncing regions from main:', error);
    }
}

/**
 * Sync region changes from expanded waveform back to main waveform
 * @param {object} expandedRegion - The region from expanded waveform
 */
function syncRegionToMain(expandedRegion) {
    if (!wsRegions || !expandedRegion) return;
    
    try {
        const mainRegions = wsRegions.getRegions();
        const mainRegion = mainRegions.find(r => r && r.id === 'trimRegion');
        
        if (mainRegion) {
            // Update main region to match expanded region
            mainRegion.update({
                start: expandedRegion.start,
                end: expandedRegion.end
            });
            console.log('WaveformExpanded: Synced region changes to main waveform');
        }
    } catch (error) {
        console.warn('WaveformExpanded: Error syncing region to main:', error);
    }
}

/**
 * Sync trim regions between main and expanded waveforms
 * @param {function} syncCallback - Callback to sync regions
 */
function syncTrimRegions(syncCallback) {
    if (!expandedWaveformInstance || !wsRegions) {
        console.warn('WaveformExpanded: Cannot sync regions - missing dependencies');
        return;
    }
    
    console.log('WaveformExpanded: Syncing trim regions');
    
    // Sync regions from main to expanded
    syncRegionsFromMain();
    
    if (typeof syncCallback === 'function') {
        syncCallback();
    }
}

/**
 * Sync expanded waveform visuals with main waveform
 * @param {function} syncCallback - Callback to sync visuals
 */
function syncExpandedWaveformVisuals(syncCallback) {
    if (!expandedWaveformInstance || !wavesurferInstance) {
        console.warn('WaveformExpanded: Cannot sync visuals - missing dependencies');
        return;
    }
    
    console.log('WaveformExpanded: Syncing expanded waveform visuals');
    
    if (typeof syncCallback === 'function') {
        syncCallback();
    }
}

/**
 * Update the expanded waveform time display
 */
function updateExpandedTimeDisplay() {
    if (!expandedWaveformInstance) {
        // Don't log warning - this is expected before waveform is created
        return;
    }
    
    try {
        const currentTime = expandedWaveformInstance.getCurrentTime();
        const duration = expandedWaveformInstance.getDuration();
        
        // Only update if we have valid duration (waveform is loaded)
        if (isNaN(currentTime) || isNaN(duration) || duration <= 0) {
            // This is expected during initialization - don't log warning
            return;
        }
        
        const remainingTime = duration - currentTime;
        
        console.log('WaveformExpanded: Updating time display:', { currentTime, duration, remainingTime });
        
        if (expandedWfCurrentTime) {
            expandedWfCurrentTime.textContent = formatWaveformTime(currentTime);
        }
        if (expandedWfTotalDuration) {
            expandedWfTotalDuration.textContent = formatWaveformTime(duration);
        }
        if (expandedWfRemainingTime) {
            expandedWfRemainingTime.textContent = formatWaveformTime(remainingTime);
        }
    } catch (error) {
        console.error('WaveformExpanded: Error updating time display:', error);
    }
}

/**
 * Set up synchronization between main and expanded waveforms
 * @param {function} syncCallback - Callback to setup sync
 */
function setupWaveformSync(syncCallback) {
    if (!wavesurferInstance || !expandedWaveformInstance) {
        console.warn('WaveformExpanded: Cannot setup sync - missing dependencies');
        return;
    }
    
    console.log('WaveformExpanded: Setting up waveform sync');
    
    // Set up bidirectional sync between main and expanded waveforms
    setupBidirectionalSync();
    
    if (typeof syncCallback === 'function') {
        syncCallback();
    }
}

/**
 * Set up keyboard controls for precise playhead movement in expanded waveform
 */
function setupExpandedKeyboardControls() {
    if (!expandedWaveformInstance || !expandedWaveformDisplay) {
        console.warn('WaveformExpanded: Cannot setup keyboard controls - missing dependencies');
        return;
    }
    
    console.log('WaveformExpanded: Setting up keyboard controls for precise editing');
    
    // Make expanded waveform container focusable
    expandedWaveformDisplay.setAttribute('tabindex', '0');
    expandedWaveformDisplay.style.outline = 'none';
    
    // Add keyboard event listener
    const keydownHandler = (e) => {
        if (!expandedWaveformInstance) return;
        
        const duration = expandedWaveformInstance.getDuration();
        if (!duration || duration <= 0) return;
        
        let seekOffset = 0;
        let handled = true;
        
        // Determine seek offset based on key combination
        if (e.shiftKey) {
            // Fine adjustment (0.01 seconds = 10ms) - most precise
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
                expandedWaveformInstance.seekTo(0);
                updateExpandedTimeDisplay();
                e.preventDefault();
                console.log('WaveformExpanded: Jumped to start');
                return;
            case 'End':
                // Seek to end
                expandedWaveformInstance.seekTo(1);
                updateExpandedTimeDisplay();
                e.preventDefault();
                console.log('WaveformExpanded: Jumped to end');
                return;
            default:
                handled = false;
        }
        
        if (handled && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            
            const currentTime = expandedWaveformInstance.getCurrentTime();
            const newTime = Math.max(0, Math.min(duration, currentTime + seekOffset));
            
            // Seek to new position
            const seekProgress = newTime / duration;
            expandedWaveformInstance.seekTo(seekProgress);
            updateExpandedTimeDisplay();
            
            console.log(`WaveformExpanded: Precise seek by ${seekOffset.toFixed(3)}s to ${newTime.toFixed(3)}s`);
        }
    };
    
    // Add event listener to the expanded display container
    expandedWaveformDisplay.addEventListener('keydown', keydownHandler);
    
    // Also add to document for when expanded waveform has focus
    const documentKeyHandler = (e) => {
        // Check if expanded waveform is visible
        const bottomPanel = document.getElementById('bottomWaveformPanel');
        if (bottomPanel && !bottomPanel.classList.contains('collapsed')) {
            keydownHandler(e);
        }
    };
    document.addEventListener('keydown', documentKeyHandler);
    
    // Store handler reference for cleanup
    expandedWaveformDisplay._keydownHandler = keydownHandler;
    document._expandedKeydownHandler = documentKeyHandler;
    
    console.log('WaveformExpanded: Keyboard controls setup completed');
    console.log('WaveformExpanded: Use Arrow Left/Right to move playhead');
    console.log('WaveformExpanded: - Hold Shift for fine adjustment (10ms)');
    console.log('WaveformExpanded: - Hold Ctrl/Cmd for medium adjustment (100ms)');
    console.log('WaveformExpanded: - No modifier for coarse adjustment (1s)');
    console.log('WaveformExpanded: - Home/End to jump to start/end');
}

/**
 * Set up bidirectional synchronization between main and expanded waveforms
 */
function setupBidirectionalSync() {
    if (!wavesurferInstance || !expandedWaveformInstance) {
        console.warn('WaveformExpanded: Cannot setup bidirectional sync - missing dependencies');
        return;
    }
    
    console.log('WaveformExpanded: Setting up bidirectional sync');
    
    // Sync from main to expanded on seek/timeupdate
    wavesurferInstance.on('seek', (seekProgress) => {
        if (!expandedWaveformInstance) return;
        
        const expandedDuration = expandedWaveformInstance.getDuration();
        if (expandedDuration > 0) {
            const expandedCurrentTime = expandedWaveformInstance.getCurrentTime();
            const mainCurrentTime = wavesurferInstance.getCurrentTime();
            
            // Only sync if there's a significant difference to avoid feedback loops
            if (Math.abs(expandedCurrentTime - mainCurrentTime) > 0.1) {
                expandedWaveformInstance.seekTo(seekProgress);
            }
        }
    });
    
    wavesurferInstance.on('timeupdate', (currentTime) => {
        if (!expandedWaveformInstance) return;
        
        const expandedDuration = expandedWaveformInstance.getDuration();
        if (expandedDuration > 0) {
            const expandedCurrentTime = expandedWaveformInstance.getCurrentTime();
            
            // Only sync if there's a significant difference to avoid feedback loops
            if (Math.abs(expandedCurrentTime - currentTime) > 0.1) {
                expandedWaveformInstance.seekTo(currentTime / expandedDuration);
            }
        }
    });
    
    // Sync from expanded to main on seek/timeupdate
    expandedWaveformInstance.on('seek', (seekProgress) => {
        if (!wavesurferInstance) return;
        
        const mainDuration = wavesurferInstance.getDuration();
        if (mainDuration > 0) {
            const mainCurrentTime = wavesurferInstance.getCurrentTime();
            const expandedCurrentTime = expandedWaveformInstance.getCurrentTime();
            
            // Only sync if there's a significant difference to avoid feedback loops
            if (Math.abs(mainCurrentTime - expandedCurrentTime) > 0.1) {
                wavesurferInstance.seekTo(seekProgress);
            }
        }
    });
    
    expandedWaveformInstance.on('timeupdate', (currentTime) => {
        if (!wavesurferInstance) return;
        
        const mainDuration = wavesurferInstance.getDuration();
        if (mainDuration > 0) {
            const mainCurrentTime = wavesurferInstance.getCurrentTime();
            
            // Only sync if there's a significant difference to avoid feedback loops
            if (Math.abs(mainCurrentTime - currentTime) > 0.1) {
                wavesurferInstance.seekTo(currentTime / mainDuration);
            }
        }
    });
    
    // Sync playback state changes
    wavesurferInstance.on('play', () => {
        if (expandedWaveformInstance && !expandedWaveformInstance.isPlaying()) {
            expandedWaveformInstance.play();
        }
    });
    
    wavesurferInstance.on('pause', () => {
        if (expandedWaveformInstance && expandedWaveformInstance.isPlaying()) {
            expandedWaveformInstance.pause();
        }
    });
    
    expandedWaveformInstance.on('play', () => {
        if (wavesurferInstance && !wavesurferInstance.isPlaying()) {
            wavesurferInstance.play();
        }
    });
    
    expandedWaveformInstance.on('pause', () => {
        if (wavesurferInstance && wavesurferInstance.isPlaying()) {
            wavesurferInstance.pause();
        }
    });
    
    console.log('WaveformExpanded: Bidirectional sync setup completed');
}

/**
 * Clean up expanded waveform
 */
function cleanupExpandedWaveform() {
    console.log('WaveformExpanded: Cleaning up expanded waveform');
    
    // Clear animation
    if (expandedAnimationId) {
        cancelAnimationFrame(expandedAnimationId);
        expandedAnimationId = null;
    }
    
    // Remove keyboard event listeners
    if (expandedWaveformDisplay && expandedWaveformDisplay._keydownHandler) {
        expandedWaveformDisplay.removeEventListener('keydown', expandedWaveformDisplay._keydownHandler);
        delete expandedWaveformDisplay._keydownHandler;
    }
    
    if (document._expandedKeydownHandler) {
        document.removeEventListener('keydown', document._expandedKeydownHandler);
        delete document._expandedKeydownHandler;
    }
    
    // Remove event listeners from main waveform to prevent memory leaks
    if (wavesurferInstance && expandedWaveformInstance) {
        try {
            // Remove all event listeners that were added for sync
            wavesurferInstance.un('seek');
            wavesurferInstance.un('timeupdate');
        } catch (error) {
            console.warn('WaveformExpanded: Error removing event listeners:', error);
        }
    }
    
    // Destroy expanded waveform instance
    if (expandedWaveformInstance) {
        try {
            expandedWaveformInstance.destroy();
        } catch (error) {
            console.warn('WaveformExpanded: Error destroying expanded waveform:', error);
        }
        expandedWaveformInstance = null;
    }
    
    // Clear display
    if (expandedWaveformDisplay) {
        expandedWaveformDisplay.innerHTML = '';
    }
    
    // Reset state
    currentExpandedCue = null;
    expandedWaveformCanvas = null;
    
    console.log('WaveformExpanded: Expanded waveform cleanup completed');
}

/**
 * Get the expanded waveform instance
 * @returns {object|null} The expanded WaveSurfer instance
 */
function getExpandedWaveformInstance() {
    return expandedWaveformInstance;
}

/**
 * Check if expanded waveform exists
 * @returns {boolean} True if expanded waveform exists
 */
function hasExpandedWaveform() {
    return !!expandedWaveformInstance;
}

/**
 * Format time for display with millisecond precision (helper function)
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

export {
    initExpandedWaveform,
    updateDependencies,
    createExpandedWaveform,
    createExpandedWaveformDelayed,
    setupExpandedWaveformEvents,
    setupExpandedWaveformButtonEvents,
    setupExpandedKeyboardControls,
    clearExpandedRegionsThoroughly,
    setupExpandedWaveformRegions,
    setupExpandedWaveformRegionsAfterReady,
    syncRegionsFromMain,
    syncRegionToMain,
    syncTrimRegions,
    syncExpandedWaveformVisuals,
    updateExpandedTimeDisplay,
    setupWaveformSync,
    setupBidirectionalSync,
    cleanupExpandedWaveform,
    getExpandedWaveformInstance,
    hasExpandedWaveform,
    formatWaveformTime
};
