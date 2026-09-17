// Companion_soundboard/src/renderer/ui/waveformControls.js

// Import the extracted modules
import * as WaveformCore from './waveformCore.js';
import * as WaveformZoom from './waveformZoom.js';
import * as WaveformRegions from './waveformRegions.js';
import * as WaveformTrimControls from './waveformTrimControls.js';
import * as WaveformBottomPanel from './waveformBottomPanel.js';
import * as WaveformExpanded from './waveformExpanded.js';

// Dependencies from other modules (will be set in init)
let ipcRendererBindingsModule;
let onTrimChangeCallback = null; // Callback for trim changes

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

    console.log('WaveformControls (DEBUG init): typeof dependencies.onTrimChange:', typeof dependencies.onTrimChange);
    if (dependencies.onTrimChange) {
        console.log('WaveformControls (DEBUG init): dependencies.onTrimChange.toString():', dependencies.onTrimChange.toString());
    }

    if (typeof dependencies.onTrimChange === 'function') { 
        onTrimChangeCallback = dependencies.onTrimChange;
        console.log('WaveformControls (DEBUG init): onTrimChangeCallback ASSIGNED.');
    } else {
        console.error('WaveformControls (DEBUG init): onTrimChange callback was not provided or not a function! dependencies.onTrimChange:', dependencies.onTrimChange);
        onTrimChangeCallback = null;
    }

    // Initialize the core module first
    initializeCoreModule();
    
    // Initialize the extracted modules
    initializeModules();
    
    console.log('WaveformControls: Initialized.');
}

/**
 * Initialize the core module
 */
function initializeCoreModule() {
    console.log('WaveformControls: Initializing core module...');
    
    // Initialize core module
    WaveformCore.initWaveformCore({
        wavesurferInstance: null, // Will be set when waveform is created
        waveformDisplayDiv: document.getElementById('waveformDisplay'),
        wfPlayPauseBtn: document.getElementById('wfPlayPauseBtn'),
        wfStopBtn: document.getElementById('wfStopBtn'),
        wfSoloBtn: document.getElementById('wfSoloBtn'),
        wfCurrentTime: document.getElementById('wfCurrentTime'),
        wfTotalDuration: document.getElementById('wfTotalDuration'),
        wfRemainingTime: document.getElementById('wfRemainingTime'),
        ipcRendererBindings: ipcRendererBindingsModule,
        onTrimChange: onTrimChangeCallback
    });
    
    console.log('WaveformControls: Core module initialized');
}

/**
 * Initialize all the extracted modules
 */
function initializeModules() {
    console.log('WaveformControls: Initializing extracted modules...');
    
    // Initialize zoom module
    WaveformZoom.initZoomModule({
        expandedWaveformDisplay: document.getElementById('expandedWaveformDisplay'),
        expandedWaveformInstance: null // Will be set when expanded waveform is created
    });
    
    // Initialize regions module
    WaveformRegions.initRegionModule({
        onTrimChange: onTrimChangeCallback
    });
    
    // Initialize trim controls module
    WaveformTrimControls.initTrimControls({
        wavesurferInstance: null, // Will be set when waveform is created
        wsRegions: null, // Will be set when waveform is created
        onTrimChange: onTrimChangeCallback,
        wfSetStartBtn: document.getElementById('wfSetStartBtn'),
        wfSetEndBtn: document.getElementById('wfSetEndBtn'),
        wfClearTrimBtn: document.getElementById('wfClearTrimBtn')
    });
    
    // Initialize bottom panel module
    WaveformBottomPanel.initBottomPanel({
        bottomWaveformPanel: document.getElementById('bottomWaveformPanel'),
        bottomPanelCueName: document.getElementById('bottomPanelCueName'),
        normalSizeBtn: null, // Removed from UI
        largeSizeBtn: null, // Removed from UI
        collapseBottomPanelBtn: document.getElementById('collapseBottomPanelBtn'),
        expandWaveformBtn: document.getElementById('expandWaveformBtn')
    });
    
    // Initialize expanded waveform module
    WaveformExpanded.initExpandedWaveform({
        expandedWaveformDisplay: document.getElementById('expandedWaveformDisplay'),
        expandedWaveformControls: document.getElementById('expandedWaveformControls'),
        expandedWfSetStartBtn: document.getElementById('expandedWfSetStartBtn'),
        expandedWfSetEndBtn: document.getElementById('expandedWfSetEndBtn'),
        expandedWfPlayPauseBtn: document.getElementById('expandedWfPlayPauseBtn'),
        expandedWfStopBtn: document.getElementById('expandedWfStopBtn'),
        expandedWfClearTrimBtn: document.getElementById('expandedWfClearTrimBtn'),
        expandedWfCurrentTime: document.getElementById('expandedWfCurrentTime'),
        expandedWfTotalDuration: document.getElementById('expandedWfTotalDuration'),
        expandedWfRemainingTime: document.getElementById('expandedWfRemainingTime'),
        wavesurferInstance: null, // Will be set when waveform is created
        wsRegions: null, // Will be set when waveform is created
        currentAudioFilePath: null, // Will be set when waveform is created
        onTrimChange: onTrimChangeCallback
    });
    
    // Bind events for modules that need them
    WaveformBottomPanel.bindBottomPanelEvents();
    WaveformTrimControls.bindTrimControlEvents();
    
    // Bind core waveform events
    WaveformCore.bindCoreWaveformEvents(() => WaveformRegions.getCurrentTrimTimes());
    
    // Expose expandBottomPanel and collapseBottomPanel functions to global scope for bottom panel access
    window.waveformControlsExpandBottomPanel = expandBottomPanel;
    window.waveformControlsCollapseBottomPanel = collapseBottomPanel;
    
    // Expose WaveformCore to window for trim controls to access current instance
    window.WaveformCore = WaveformCore;
    
    console.log('WaveformControls: All modules initialized');
}

// Core functionality is now handled by WaveformCore module

/**
 * Public interface to show waveform for a cue
 * @param {object} cue - The cue object
 */
function showWaveformForCue(cue) {
    console.log('WaveformControls: showWaveformForCue called with cue:', cue ? cue.id : 'null');
    
    // Use the core module to show waveform
    return WaveformCore.showWaveformForCue(cue, 
        (cue, regionsPlugin) => {
            // Setup events callback
            WaveformCore.setupCoreWaveformEvents(
                cue, 
                regionsPlugin,
                () => WaveformRegions.setupRegionEventHandlers(WaveformCore.getWavesurferInstance()),
                (cue) => WaveformRegions.loadRegionsFromCue(cue, WaveformCore.getWavesurferInstance()),
                () => WaveformCore.handlePlaybackEndReached(() => WaveformRegions.getCurrentTrimTimes())
            );
        },
        (regionsPlugin) => {
            // Set regions callback
            WaveformRegions.setRegionsInstance(regionsPlugin);
            
            // Update modules with new instances
            WaveformTrimControls.updateDependencies({
                wavesurferInstance: WaveformCore.getWavesurferInstance(),
                wsRegions: regionsPlugin
            });
            
            WaveformExpanded.updateDependencies({
                wavesurferInstance: WaveformCore.getWavesurferInstance(),
                wsRegions: regionsPlugin,
                currentAudioFilePath: WaveformCore.getCurrentAudioFilePath(),
                onTrimChange: onTrimChangeCallback
            });
        }
    );
}

/**
 * Public interface to destroy the waveform.
 */
function hideAndDestroyWaveform() {
    WaveformCore.hideAndDestroyWaveform();
}

/**
 * Gets the current trim start and end times from the waveform region.
 * Returns null if no wavesurfer instance or no trimRegion exists.
 * @returns {{trimStartTime: number, trimEndTime: number} | null}
 */
function getCurrentTrimTimes() {
    return WaveformRegions.getCurrentTrimTimes();
}

// --- Public API / Exports ---

// Test function for debugging - can be called from console: window.waveformTest()
window.waveformTest = function() {
    console.log('=== WAVEFORM TEST ===');
    const wavesurferInstance = WaveformCore.getWavesurferInstance();
    console.log('wavesurferInstance exists:', !!wavesurferInstance);
    console.log('onTrimChangeCallback exists:', !!onTrimChangeCallback);
    
    if (wavesurferInstance) {
        console.log('Waveform duration:', wavesurferInstance.getDuration());
        console.log('Waveform current time:', wavesurferInstance.getCurrentTime());
        
        const trimTimes = WaveformRegions.getCurrentTrimTimes();
        console.log('Current trim times:', trimTimes);
    }
    
    // Test DOM elements
    console.log('DOM Elements:');
    console.log('  wfCurrentTime:', !!document.getElementById('wfCurrentTime'));
    console.log('  wfTotalDuration:', !!document.getElementById('wfTotalDuration'));
    console.log('  wfRemainingTime:', !!document.getElementById('wfRemainingTime'));
};

// --- Bottom Panel Functions ---

/**
 * Move waveform from small view to expanded view
 * @param {string} audioFilePath - Path to the audio file
 * @param {number} currentTime - Current playback time to restore
 * @param {boolean} wasPlaying - Whether it was playing
 * @param {object} trimTimes - Trim times to restore
 */
function moveWaveformToExpandedView(audioFilePath, currentTime, wasPlaying, trimTimes) {
    console.log('WaveformControls: Moving waveform to expanded view');
    
    // Get the expanded waveform display container
    const expandedWaveformDisplay = document.getElementById('expandedWaveformDisplay');
    if (!expandedWaveformDisplay) {
        console.error('WaveformControls: expandedWaveformDisplay not found');
        return;
    }
    
    // Clear the expanded container
    expandedWaveformDisplay.innerHTML = '';
    
    // Create a container div for the waveform
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '250px';
    container.style.border = '1px solid #555';
    container.style.borderRadius = '4px';
    container.style.overflow = 'hidden';
    container.id = 'expanded-waveform-container';
    expandedWaveformDisplay.appendChild(container);
    
    // Pause the current waveform if playing
    const currentInstance = WaveformCore.getWavesurferInstance();
    if (currentInstance) {
        currentInstance.pause();
        currentInstance.destroy();
    }
    
    // Create new WaveSurfer instance in the expanded container with larger height
    const expandedInstance = WaveSurfer.create({
        container: container,
        waveColor: '#4F46E5',       // Same as main waveform
        progressColor: '#7C3AED',    // Same as main waveform
        cursorColor: '#EF4444',      // Same as main waveform
        barWidth: 2,
        barRadius: 3,
        responsive: true,
        height: 250,  // Larger height for expanded view
        normalize: true,
        backend: 'WebAudio',
        mediaControls: false,
        interact: true,
        plugins: [
            WaveSurfer.Regions.create()
        ]
    });
    
    // Store the instance as the main instance
    WaveformCore.updateDependencies({ wavesurferInstance: expandedInstance });
    WaveformRegions.setRegionsInstance(expandedInstance.plugins[0]);
    
    // Set up events for the waveform
    expandedInstance.on('ready', () => {
        console.log('WaveformControls: Expanded waveform ready');
        
        // Restore playback position
        if (currentTime > 0) {
            const duration = expandedInstance.getDuration();
            if (duration > 0) {
                expandedInstance.seekTo(currentTime / duration);
            }
        }
        
        // Restore trim regions if they exist
        if (trimTimes) {
            console.log('WaveformControls: Restoring trim regions:', trimTimes);
            const duration = expandedInstance.getDuration();
            if (duration > 0) {
                const regions = expandedInstance.plugins[0];
                
                // Create trim region
                regions.addRegion({
                    id: 'trimRegion',
                    start: trimTimes.trimStartTime,
                    end: trimTimes.trimEndTime,
                    color: 'rgba(0, 255, 0, 0.3)',
                    drag: true,
                    resize: true
                });
                
                // Create cut overlays
                if (trimTimes.trimStartTime > 0.01) {
                    regions.addRegion({
                        id: 'cutOverlay-before',
                        start: 0,
                        end: Math.max(0, trimTimes.trimStartTime - 0.01),
                        color: 'rgba(255, 0, 0, 0.4)',
                        drag: false,
                        resize: false
                    });
                }
                
                if (trimTimes.trimEndTime < duration - 0.01) {
                    regions.addRegion({
                        id: 'cutOverlay-after',
                        start: Math.min(duration, trimTimes.trimEndTime + 0.01),
                        end: duration,
                        color: 'rgba(255, 0, 0, 0.4)',
                        drag: false,
                        resize: false
                    });
                }
            }
        }
        
        // Setup region event handlers
        WaveformRegions.setupRegionEventHandlers(expandedInstance);
        
        // Resume playback if it was playing
        if (wasPlaying) {
            expandedInstance.play();
        }
        
        // Update time displays
        WaveformCore.syncPlaybackTimeWithUI(currentTime);
    });
    
    // Set up core waveform events
    WaveformCore.setupCoreWaveformEvents(
        { id: 'current', filePath: audioFilePath },
        expandedInstance.plugins[0],
        () => WaveformRegions.setupRegionEventHandlers(expandedInstance),
        (cue) => {}, // Skip loading regions from cue since we restore them manually
        () => WaveformCore.handlePlaybackEndReached(() => WaveformRegions.getCurrentTrimTimes())
    );
    
    // Load the audio file
    expandedInstance.load(audioFilePath);
    
    // Set up expanded waveform control buttons
    setupExpandedWaveformControls(expandedInstance);
    
    // Set up zoom for expanded waveform
    setupExpandedZoom(expandedInstance, container);
    
    console.log('WaveformControls: Waveform moved to expanded view');
}

/**
 * Set up control buttons for the expanded waveform
 * @param {object} wavesurferInstance - The WaveSurfer instance
 */
function setupExpandedWaveformControls(wavesurferInstance) {
    const expandedWfPlayPauseBtn = document.getElementById('expandedWfPlayPauseBtn');
    const expandedWfStopBtn = document.getElementById('expandedWfStopBtn');
    const expandedWfSetStartBtn = document.getElementById('expandedWfSetStartBtn');
    const expandedWfSetEndBtn = document.getElementById('expandedWfSetEndBtn');
    const expandedWfClearTrimBtn = document.getElementById('expandedWfClearTrimBtn');
    
    // Set up time display elements
    const expandedWfCurrentTime = document.getElementById('expandedWfCurrentTime');
    const expandedWfTotalDuration = document.getElementById('expandedWfTotalDuration');
    const expandedWfRemainingTime = document.getElementById('expandedWfRemainingTime');
    
    // Update time displays
    wavesurferInstance.on('audioprocess', (currentTime) => {
        updateExpandedTimeDisplays(expandedWfCurrentTime, expandedWfTotalDuration, expandedWfRemainingTime, currentTime, wavesurferInstance.getDuration());
    });
    
    wavesurferInstance.on('seek', (seekProgress) => {
        const currentTime = seekProgress * wavesurferInstance.getDuration();
        updateExpandedTimeDisplays(expandedWfCurrentTime, expandedWfTotalDuration, expandedWfRemainingTime, currentTime, wavesurferInstance.getDuration());
    });
    
    wavesurferInstance.on('timeupdate', (currentTime) => {
        updateExpandedTimeDisplays(expandedWfCurrentTime, expandedWfTotalDuration, expandedWfRemainingTime, currentTime, wavesurferInstance.getDuration());
    });
    
    // Play/Pause button
    if (expandedWfPlayPauseBtn) {
        // Remove any existing listeners
        const newPlayPauseBtn = expandedWfPlayPauseBtn.cloneNode(true);
        expandedWfPlayPauseBtn.parentNode.replaceChild(newPlayPauseBtn, expandedWfPlayPauseBtn);
        
        newPlayPauseBtn.addEventListener('click', () => {
            if (wavesurferInstance.isPlaying()) {
                wavesurferInstance.pause();
            } else {
                wavesurferInstance.play();
            }
        });
        
        console.log('WaveformControls: Expanded play/pause button wired up');
    }
    
    // Stop button
    if (expandedWfStopBtn) {
        const newStopBtn = expandedWfStopBtn.cloneNode(true);
        expandedWfStopBtn.parentNode.replaceChild(newStopBtn, expandedWfStopBtn);
        
        newStopBtn.addEventListener('click', () => {
            wavesurferInstance.pause();
            wavesurferInstance.seekTo(0);
        });
        
        console.log('WaveformControls: Expanded stop button wired up');
    }
    
    // The trim control buttons are already wired up via waveformTrimControls module
    // They will work automatically since they now get the current instance dynamically
    
    console.log('WaveformControls: Expanded waveform controls setup completed');
}

/**
 * Update expanded waveform time displays
 * @param {HTMLElement} currentTimeEl - Current time display element
 * @param {HTMLElement} totalDurationEl - Total duration display element
 * @param {HTMLElement} remainingTimeEl - Remaining time display element
 * @param {number} currentTime - Current playback time
 * @param {number} duration - Total duration
 */
function updateExpandedTimeDisplays(currentTimeEl, totalDurationEl, remainingTimeEl, currentTime, duration) {
    if (currentTimeEl) {
        currentTimeEl.textContent = WaveformCore.formatWaveformTime(currentTime);
    }
    if (totalDurationEl) {
        totalDurationEl.textContent = WaveformCore.formatWaveformTime(duration);
    }
    if (remainingTimeEl) {
        const remaining = duration - currentTime;
        remainingTimeEl.textContent = WaveformCore.formatWaveformTime(remaining);
    }
}

/**
 * Set up zoom for the expanded waveform
 * @param {object} wavesurferInstance - The WaveSurfer instance
 * @param {HTMLElement} container - The waveform container
 */
function setupExpandedZoom(wavesurferInstance, container) {
    let zoomLevel = 0; // Start at minimum zoom
    const maxZoom = 1000;
    const minZoom = 0;
    
    // Mouse wheel zoom
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const direction = e.deltaY < 0 ? 1 : -1;
        let zoomStep;
        
        if (zoomLevel < 10) {
            zoomStep = 1 * direction;
        } else {
            zoomStep = 5 * direction;
        }
        
        zoomLevel += zoomStep;
        zoomLevel = Math.min(Math.max(zoomLevel, minZoom), maxZoom);
        
        wavesurferInstance.zoom(zoomLevel);
        
        console.log(`WaveformControls: Expanded zoom changed to ${zoomLevel}`);
        
        if (zoomLevel <= minZoom) {
            zoomLevel = 0;
            wavesurferInstance.zoom(0);
        }
    }, { passive: false });
    
    // Double-click to reset zoom
    container.addEventListener('dblclick', () => {
        zoomLevel = 0;
        wavesurferInstance.zoom(0);
        console.log('WaveformControls: Expanded zoom reset to default');
    });
    
    console.log('WaveformControls: Expanded zoom setup completed');
}

/**
 * Move waveform from expanded view back to small view
 * @param {string} audioFilePath - Path to the audio file
 * @param {number} currentTime - Current playback time to restore
 * @param {boolean} wasPlaying - Whether it was playing
 * @param {object} trimTimes - Trim times to restore
 */
function moveWaveformToSmallView(audioFilePath, currentTime, wasPlaying, trimTimes) {
    console.log('WaveformControls: Moving waveform back to small view');
    
    // Get the small waveform display container
    const waveformDisplayDiv = document.getElementById('waveformDisplay');
    if (!waveformDisplayDiv) {
        console.error('WaveformControls: waveformDisplay not found');
        return;
    }
    
    // Show and clear the small container
    waveformDisplayDiv.style.display = 'block';
    waveformDisplayDiv.innerHTML = '';
    
    // Pause and destroy the current waveform if it exists
    const currentInstance = WaveformCore.getWavesurferInstance();
    if (currentInstance) {
        currentInstance.pause();
        currentInstance.destroy();
    }
    
    // Create new WaveSurfer instance in the small container
    const smallInstance = WaveSurfer.create({
        container: waveformDisplayDiv,
        waveColor: '#4F46E5',       // Same colors
        progressColor: '#7C3AED',
        cursorColor: '#EF4444',
        barWidth: 2,
        barRadius: 3,
        responsive: true,
        height: 128,  // Small height for main view
        normalize: true,
        backend: 'WebAudio',
        mediaControls: false,
        interact: true,
        plugins: [
            WaveSurfer.Regions.create()
        ]
    });
    
    // Store the instance as the main instance
    WaveformCore.updateDependencies({ wavesurferInstance: smallInstance });
    WaveformRegions.setRegionsInstance(smallInstance.plugins[0]);
    
    // Set up events for the waveform
    smallInstance.on('ready', () => {
        console.log('WaveformControls: Small waveform ready');
        
        // Restore playback position
        if (currentTime > 0) {
            const duration = smallInstance.getDuration();
            if (duration > 0) {
                smallInstance.seekTo(currentTime / duration);
            }
        }
        
        // Restore trim regions if they exist
        if (trimTimes) {
            console.log('WaveformControls: Restoring trim regions:', trimTimes);
            const duration = smallInstance.getDuration();
            if (duration > 0) {
                const regions = smallInstance.plugins[0];
                
                // Create trim region
                regions.addRegion({
                    id: 'trimRegion',
                    start: trimTimes.trimStartTime,
                    end: trimTimes.trimEndTime,
                    color: 'rgba(0, 255, 0, 0.3)',
                    drag: true,
                    resize: true
                });
                
                // Create cut overlays
                if (trimTimes.trimStartTime > 0.01) {
                    regions.addRegion({
                        id: 'cutOverlay-before',
                        start: 0,
                        end: Math.max(0, trimTimes.trimStartTime - 0.01),
                        color: 'rgba(255, 0, 0, 0.4)',
                        drag: false,
                        resize: false
                    });
                }
                
                if (trimTimes.trimEndTime < duration - 0.01) {
                    regions.addRegion({
                        id: 'cutOverlay-after',
                        start: Math.min(duration, trimTimes.trimEndTime + 0.01),
                        end: duration,
                        color: 'rgba(255, 0, 0, 0.4)',
                        drag: false,
                        resize: false
                    });
                }
            }
        }
        
        // Setup region event handlers
        WaveformRegions.setupRegionEventHandlers(smallInstance);
        
        // Resume playback if it was playing
        if (wasPlaying) {
            smallInstance.play();
        }
        
        // Update time displays
        WaveformCore.syncPlaybackTimeWithUI(currentTime);
    });
    
    // Set up core waveform events
    WaveformCore.setupCoreWaveformEvents(
        { id: 'current', filePath: audioFilePath },
        smallInstance.plugins[0],
        () => WaveformRegions.setupRegionEventHandlers(smallInstance),
        (cue) => {}, // Skip loading regions from cue since we restore them manually
        () => WaveformCore.handlePlaybackEndReached(() => WaveformRegions.getCurrentTrimTimes())
    );
    
    // Load the audio file
    smallInstance.load(audioFilePath);
    
    console.log('WaveformControls: Waveform moved back to small view');
}

/**
 * Expands the bottom waveform panel for enhanced editing
 * Uses the waveformExpanded module for proper expanded waveform handling
 */
function expandBottomPanel() {
    console.log('WaveformControls: expandBottomPanel called');
    
    const wavesurferInstance = WaveformCore.getWavesurferInstance();
    const currentAudioFilePath = WaveformCore.getCurrentAudioFilePath();
    
    if (!wavesurferInstance) {
        console.error('WaveformControls: No waveform instance available, cannot expand bottom panel');
        return;
    }
    
    if (!currentAudioFilePath) {
        console.error('WaveformControls: No audio file loaded, cannot expand bottom panel');
        return;
    }
    
    console.log('WaveformControls: ✅ Expanding bottom panel - prerequisites met');
    
    // Capture current state before expanding
    const currentTime = wavesurferInstance.getCurrentTime();
    const isPlaying = wavesurferInstance.isPlaying();
    const trimTimes = WaveformRegions.getCurrentTrimTimes();
    
    console.log('WaveformControls: Captured state:', { currentTime, isPlaying, trimTimes });
    
    // Hide the small waveform container
    const waveformDisplayDiv = document.getElementById('waveformDisplay');
    if (waveformDisplayDiv) {
        waveformDisplayDiv.style.display = 'none';
    }
    
    // Pause the main waveform
    if (isPlaying) {
        wavesurferInstance.pause();
    }
    
    // Update expanded waveform dependencies with current file path
    WaveformExpanded.updateDependencies({
        currentAudioFilePath: currentAudioFilePath,
        wavesurferInstance: wavesurferInstance,
        wsRegions: WaveformRegions.getRegionsInstance ? WaveformRegions.getRegionsInstance() : null
    });
    
    // Use the bottom panel module to expand
    WaveformBottomPanel.expandBottomPanel(() => {
        // Create the expanded waveform using the waveformExpanded module
        WaveformExpanded.createExpandedWaveform(
            // Setup zoom callback
            () => {
                console.log('WaveformControls: Expanded zoom setup callback');
                const expandedInstance = WaveformExpanded.getExpandedWaveformInstance();
                const expandedDisplay = document.getElementById('expandedWaveformDisplay');
                
                if (expandedInstance && expandedDisplay) {
                    // Update zoom module with expanded waveform references
                    WaveformZoom.updateExpandedWaveformInstance(expandedInstance);
                    
                    // Re-initialize zoom module with updated dependencies
                    WaveformZoom.initZoomModule({
                        expandedWaveformDisplay: expandedDisplay,
                        expandedWaveformInstance: expandedInstance
                    });
                    
                    // Set up zoom for expanded waveform
                    WaveformZoom.setupExpandedWaveformZoom();
                }
            },
            // Setup regions callback
            () => {
                console.log('WaveformControls: Expanded regions setup callback');
                // Regions are handled by waveformExpanded module
            }
        );
        
        // After creation, restore playback state
        setTimeout(() => {
            const expandedInstance = WaveformExpanded.getExpandedWaveformInstance();
            if (expandedInstance) {
                // Restore playback position
                const duration = expandedInstance.getDuration();
                if (duration > 0 && currentTime > 0) {
                    expandedInstance.seekTo(currentTime / duration);
                }
                
                // Resume playback if it was playing
                if (isPlaying) {
                    expandedInstance.play();
                }
            }
        }, 500);
    });
}

/**
 * Collapses the bottom waveform panel
 */
function collapseBottomPanel() {
    console.log('WaveformControls: Collapsing bottom panel');
    
    // Get expanded waveform instance if it exists
    const expandedInstance = WaveformExpanded.getExpandedWaveformInstance();
    const currentAudioFilePath = WaveformCore.getCurrentAudioFilePath();
    
    if (!expandedInstance && !currentAudioFilePath) {
        console.warn('WaveformControls: No waveform to collapse');
        WaveformBottomPanel.collapseBottomPanel();
        return;
    }
    
    // Capture current state before collapsing
    let currentTime = 0;
    let isPlaying = false;
    
    if (expandedInstance) {
        currentTime = expandedInstance.getCurrentTime();
        isPlaying = expandedInstance.isPlaying();
        
        // Pause if playing
        if (isPlaying) {
            expandedInstance.pause();
        }
    }
    
    console.log('WaveformControls: Captured state for collapse:', { currentTime, isPlaying });
    
    // Sync regions from expanded back to main waveform before cleanup
    if (expandedInstance) {
        const expandedRegions = expandedInstance.plugins && expandedInstance.plugins[0];
        const mainRegions = WaveformRegions.getRegionsInstance();
        
        if (expandedRegions && mainRegions) {
            try {
                // Get all regions from expanded waveform
                const expandedRegionsList = expandedRegions.getRegions();
                
                // Clear main waveform regions first
                const mainRegionsList = mainRegions.getRegions();
                if (Array.isArray(mainRegionsList)) {
                    const mainRegionsCopy = [...mainRegionsList];
                    mainRegionsCopy.forEach(region => {
                        if (region && typeof region.remove === 'function') {
                            try {
                                region.remove();
                            } catch (e) {
                                console.warn('WaveformControls: Error removing main region:', e);
                            }
                        }
                    });
                }
                
                // Copy all regions from expanded to main
                if (Array.isArray(expandedRegionsList)) {
                    expandedRegionsList.forEach(region => {
                        if (region) {
                            try {
                                mainRegions.addRegion({
                                    id: region.id,
                                    start: region.start,
                                    end: region.end,
                                    color: region.color,
                                    drag: region.drag !== false,
                                    resize: region.resize !== false
                                });
                                console.log(`WaveformControls: Synced region ${region.id} from expanded to main`);
                            } catch (e) {
                                console.warn('WaveformControls: Error syncing region to main:', e);
                            }
                        }
                    });
                }
            } catch (error) {
                console.error('WaveformControls: Error syncing regions back to main:', error);
            }
        }
    }
    
    // Clean up expanded waveform
    WaveformExpanded.cleanupExpandedWaveform();
    
    // Use the bottom panel module to collapse
    WaveformBottomPanel.collapseBottomPanel(() => {
        // Show the main waveform container again
        const waveformDisplayDiv = document.getElementById('waveformDisplay');
        if (waveformDisplayDiv) {
            waveformDisplayDiv.style.display = 'block';
        }
        
        // Restore playback state on main waveform
        const mainInstance = WaveformCore.getWavesurferInstance();
        if (mainInstance && currentTime > 0) {
            const duration = mainInstance.getDuration();
            if (duration > 0) {
                mainInstance.seekTo(currentTime / duration);
            }
            
            if (isPlaying) {
                mainInstance.play();
            }
        }
    });
}

/**
 * Set the bottom panel size
 * @param {string} size - 'normal' or 'large'
 */
function setBottomPanelSize(size) {
    WaveformBottomPanel.setBottomPanelSize(size);
}

/**
 * Checks if the bottom panel is currently expanded
 * @returns {boolean}
 */
function getBottomPanelState() {
    return WaveformBottomPanel.getBottomPanelState();
}

/**
 * Format time for display with millisecond precision
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
function formatWaveformTime(seconds) {
    return WaveformCore.formatWaveformTime(seconds);
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
