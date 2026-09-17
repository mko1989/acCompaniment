/**
 * Waveform Controls Component for Browser Interface
 * 
 * Manages waveform display and editing controls.
 * Based on the original acCompaniment Electron version.
 */

class WaveformControls {
    constructor(audioController) {
        this.audioController = audioController;
        this.websocketBindings = null; // Will be set from module-level websocketBindingsModule
        this.cueStore = null; // Optional: for optimistic local trim updates
        this.waveform = null;
        this.expandedWaveform = null;
        this.isInitialized = false;
        this.currentCue = null;
        this.trimStartTime = 0;
        this.trimEndTime = 0;
        this.zoomLevel = 0;
        this.maxZoom = 1000;
        this.minZoom = 0;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupKeyboardControls();
        console.log('WaveformControls initialized');
    }
    
    setupKeyboardControls() {
        // Add keyboard controls for timeline movement
        document.addEventListener('keydown', (e) => {
            if (!this.waveform) return;
            
            // Only handle if we're focused on waveform or no specific element is focused
            const activeElement = document.activeElement;
            const isInputFocused = activeElement && (
                activeElement.tagName === 'INPUT' || 
                activeElement.tagName === 'TEXTAREA' || 
                activeElement.contentEditable === 'true'
            );
            
            if (isInputFocused) return;
            
            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    this.seekBackward();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.seekForward();
                    break;
                case ' ':
                    e.preventDefault();
                    this.togglePlayPause();
                    break;
                case 'Home':
                    e.preventDefault();
                    this.seekToStart();
                    break;
                case 'End':
                    e.preventDefault();
                    this.seekToEnd();
                    break;
            }
        });
    }
    
    seekBackward() {
        if (this.waveform) {
            try {
                const currentTime = this.waveform.getCurrentTime();
                const duration = this.waveform.getDuration();
                const newTime = Math.max(0, currentTime - 1); // 1 second back
                this.waveform.seekTo(newTime / duration);
                console.log(`Seeked backward to ${newTime}s`);
            } catch (error) {
                console.warn('Error seeking backward:', error);
            }
        } else {
            console.warn('Cannot seek backward: waveform not initialized');
        }
    }
    
    seekForward() {
        if (this.waveform) {
            try {
                const currentTime = this.waveform.getCurrentTime();
                const duration = this.waveform.getDuration();
                const newTime = Math.min(duration, currentTime + 1); // 1 second forward
                this.waveform.seekTo(newTime / duration);
                console.log(`Seeked forward to ${newTime}s`);
            } catch (error) {
                console.warn('Error seeking forward:', error);
            }
        } else {
            console.warn('Cannot seek forward: waveform not initialized');
        }
    }
    
    seekToStart() {
        if (this.waveform) {
            this.waveform.seekTo(0);
        }
    }
    
    seekToEnd() {
        if (this.waveform) {
            this.waveform.seekTo(1);
        }
    }
    
    setupEventListeners() {
        // Waveform control buttons
        const controls = [
            'wfSetStartBtn', 'wfSetEndBtn', 'wfClearTrimBtn',
            'wfPlayPauseBtn', 'wfStopBtn', 'expandWaveformBtn'
        ];
        
        controls.forEach(controlId => {
            const element = document.getElementById(controlId);
            if (element) {
                element.addEventListener('click', () => {
                    this.handleControlClick(controlId);
                });
            } else {
                console.warn(`WaveformControls: Control button not found: ${controlId}`);
            }
        });
        
        // Expanded waveform controls
        const expandedControls = [
            'expandedWfSetStartBtn', 'expandedWfSetEndBtn', 'expandedWfClearTrimBtn',
            'expandedWfPlayPauseBtn', 'expandedWfStopBtn'
        ];
        
        expandedControls.forEach(controlId => {
            const element = document.getElementById(controlId);
            if (element) {
                element.addEventListener('click', () => {
                    this.handleExpandedControlClick(controlId);
                });
            } else {
                console.warn(`WaveformControls: Expanded control button not found: ${controlId}`);
            }
        });
        
        // Add collapse button listener
        const collapseBtn = document.getElementById('collapseBottomPanelBtn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', () => {
                this.collapseExpandedWaveform();
            });
        } else {
            console.warn('WaveformControls: Collapse button not found');
        }
    }
    
    handleControlClick(controlId) {
        switch (controlId) {
            case 'wfSetStartBtn':
                this.setStartPoint();
                break;
            case 'wfSetEndBtn':
                this.setEndPoint();
                break;
            case 'wfClearTrimBtn':
                this.clearTrimPoints();
                break;
            case 'wfPlayPauseBtn':
                this.togglePlayPause();
                break;
            case 'wfStopBtn':
                this.stopPlayback();
                break;
            case 'expandWaveformBtn':
                this.expandWaveform();
                break;
        }
    }
    
    handleExpandedControlClick(controlId) {
        switch (controlId) {
            case 'expandedWfSetStartBtn':
                this.setStartPoint();
                break;
            case 'expandedWfSetEndBtn':
                this.setEndPoint();
                break;
            case 'expandedWfClearTrimBtn':
                this.clearTrimPoints();
                break;
            case 'expandedWfPlayPauseBtn':
                this.togglePlayPause();
                break;
            case 'expandedWfStopBtn':
                this.stopPlayback();
                break;
        }
    }
    
    setStartPoint() {
        if (this.waveform) {
            try {
                const currentTime = this.waveform.getCurrentTime();
                const duration = this.waveform.getDuration();
                
                if (duration > 0) {
                    console.log(`Set start point: ${currentTime}s`);
                    
                    // Update trim start time
                    this.trimStartTime = currentTime;
                    
                    // Ensure end time is after start time
                    if (this.trimEndTime <= this.trimStartTime) {
                        this.trimEndTime = duration;
                    }
                    
                    // Update or create trim region
                    this.updateTrimRegion();
                    
                    // Update cue property
                    this.updateCueTrimTimes();
                } else {
                    console.warn('Cannot set start point: waveform duration is 0');
                }
            } catch (error) {
                console.error('Error setting start point:', error);
            }
        } else {
            console.warn('Cannot set start point: waveform not initialized');
        }
    }
    
    setEndPoint() {
        if (this.waveform) {
            try {
                const currentTime = this.waveform.getCurrentTime();
                const duration = this.waveform.getDuration();
                
                if (duration > 0) {
                    console.log(`Set end point: ${currentTime}s`);
                    
                    // Update trim end time
                    this.trimEndTime = currentTime;
                    
                    // Ensure start time is before end time
                    if (this.trimStartTime >= this.trimEndTime) {
                        this.trimStartTime = 0;
                    }
                    
                    // Update or create trim region
                    this.updateTrimRegion();
                    
                    // Update cue property
                    this.updateCueTrimTimes();
                } else {
                    console.warn('Cannot set end point: waveform duration is 0');
                }
            } catch (error) {
                console.error('Error setting end point:', error);
            }
        } else {
            console.warn('Cannot set end point: waveform not initialized');
        }
    }
    
    updateTrimRegion() {
        if (!this.waveform) return;
        
        const duration = this.waveform.getDuration();
        if (!duration) return;
        
        // Get the regions plugin instance
        const regionsPlugin = this.waveform.plugins[0];
        if (!regionsPlugin) {
            console.warn('WaveformControls: No regions plugin found');
            return;
        }
        
        // Clear existing regions
        this.clearAllRegions(regionsPlugin);
        
        // Create trim region
        if (this.trimStartTime > 0 || this.trimEndTime < duration) {
            regionsPlugin.addRegion({
                id: 'trimRegion',
                start: this.trimStartTime,
                end: this.trimEndTime,
                color: 'rgba(0, 255, 0, 0.3)',
                drag: true,
                resize: true
            });
            
            // Create cut overlays
            if (this.trimStartTime > 0.01) {
                regionsPlugin.addRegion({
                    id: 'cutOverlay-before',
                    start: 0,
                    end: Math.max(0, this.trimStartTime - 0.01),
                    color: 'rgba(255, 0, 0, 0.4)',
                    drag: false,
                    resize: false
                });
            }
            
            if (this.trimEndTime < duration - 0.01) {
                regionsPlugin.addRegion({
                    id: 'cutOverlay-after',
                    start: Math.min(duration, this.trimEndTime + 0.01),
                    end: duration,
                    color: 'rgba(255, 0, 0, 0.4)',
                    drag: false,
                    resize: false
                });
            }
        }
    }
    
    clearTrimPoints() {
        console.log('Clear trim points');
        
        this.trimStartTime = 0;
        this.trimEndTime = 0;
        
        // Clear regions
        if (this.waveform) {
            const regionsPlugin = this.waveform.plugins[0];
            if (regionsPlugin) {
                this.clearAllRegions(regionsPlugin);
            }
        }
        
        // Update cue property
        this.updateCueTrimTimes();
    }
    
    clearAllRegions(regionsPlugin) {
        if (!regionsPlugin) return;
        
        try {
            // Get all regions and remove them
            const regions = regionsPlugin.getRegions();
            if (Array.isArray(regions)) {
                const regionsCopy = [...regions];
                regionsCopy.forEach(region => {
                    if (region && typeof region.remove === 'function') {
                        try {
                            region.remove();
                        } catch (e) {
                            console.warn('WaveformControls: Error removing region:', e);
                        }
                    }
                });
            }
            
            // Force clear using clearRegions if available
            if (regionsPlugin.clearRegions && typeof regionsPlugin.clearRegions === 'function') {
                regionsPlugin.clearRegions();
            }
        } catch (error) {
            console.error('WaveformControls: Error clearing regions:', error);
        }
    }
    
    togglePlayPause() {
        if (this.waveform) {
            if (this.waveform.isPlaying()) {
                this.waveform.pause();
                this.updatePlayPauseButton(false);
            } else {
                this.waveform.play();
                this.updatePlayPauseButton(true);
            }
        }
    }
    
    stopPlayback() {
        if (this.waveform) {
            this.waveform.stop();
            this.updatePlayPauseButton(false);
        }
    }
    
    expandWaveform() {
        console.log('WaveformControls: Expanding waveform');
        
        // Show bottom panel
        const bottomPanel = document.getElementById('bottomWaveformPanel');
        if (bottomPanel) {
            bottomPanel.classList.add('expanded');
            bottomPanel.style.display = 'block';
            console.log('WaveformControls: Bottom panel expanded');
        } else {
            console.error('WaveformControls: Bottom panel element not found');
        }
        
        // Initialize expanded waveform
        this.initializeExpandedWaveform();
    }
    
    collapseExpandedWaveform() {
        console.log('WaveformControls: Collapsing expanded waveform');
        
        // Destroy expanded waveform
        if (this.expandedWaveform) {
            this.expandedWaveform.destroy();
            this.expandedWaveform = null;
        }
        
        // Clear expanded waveform display
        const expandedDisplay = document.getElementById('expandedWaveformDisplay');
        if (expandedDisplay) {
            expandedDisplay.innerHTML = '';
        }
        
        // Hide bottom panel
        const bottomPanel = document.getElementById('bottomWaveformPanel');
        if (bottomPanel) {
            bottomPanel.classList.remove('expanded');
        }
    }
    
    initializeExpandedWaveform() {
        const expandedDisplay = document.getElementById('expandedWaveformDisplay');
        if (!expandedDisplay) return;
        
        // Clear existing expanded waveform
        if (this.expandedWaveform) {
            try {
                this.expandedWaveform.destroy();
            } catch (error) {
                console.warn('WaveformControls: Error destroying expanded waveform:', error);
            }
        }
        
        // Clear the display container
        expandedDisplay.innerHTML = '';
        
        // Create expanded waveform instance with regions (matching original app configuration)
        if (window.WaveSurfer) {
            try {
                this.expandedWaveform = WaveSurfer.create({
                    container: expandedDisplay,
                    waveColor: '#4F46E5',
                    progressColor: '#7C3AED',
                    cursorColor: '#EF4444',
                    barWidth: 2,
                    barRadius: 3,
                    responsive: true,
                    height: 300,
                    normalize: true,
                    backend: 'WebAudio',
                    mediaControls: false,
                    interact: true,
                    plugins: [
                        WaveSurfer.Regions.create()
                    ]
                });
                
                // Set up zoom for expanded waveform
                this.setupExpandedZoom();
                
                // Load audio for expanded waveform if we have a current cue
                if (this.currentCue) {
                    // Determine the correct audio file ID
                    let audioFileId = this.currentCue.audioFileId;
                    if (!audioFileId) {
                        audioFileId = this.currentCue.id;
                    }
                    
                    const audioUrl = `/api/audio/serve/${audioFileId}`;
                    console.log(`Expanded waveform loading from URL: ${audioUrl}`);
                    
                    this.expandedWaveform.load(audioUrl);
                    
                    // Set up event listeners
                    this.expandedWaveform.on('ready', () => {
                        console.log('Expanded waveform ready');
                        
                        // Copy current playback position from main waveform if available
                        if (this.waveform) {
                            const currentTime = this.waveform.getCurrentTime();
                            const duration = this.expandedWaveform.getDuration();
                            if (duration > 0 && currentTime > 0) {
                                this.expandedWaveform.seekTo(currentTime / duration);
                            }
                        }
                        
                        // Load trim regions
                        this.loadExpandedTrimRegions();
                    });
                    
                    // Handle loading errors
                    this.expandedWaveform.on('error', (error) => {
                        console.error('Expanded waveform loading error:', error);
                        expandedDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #ff6b6b;">Error loading expanded waveform</div>';
                    });
                    
                    // Set up click to seek functionality for expanded waveform
                    this.expandedWaveform.on('click', (relativeX) => {
                        console.log('Expanded waveform clicked at relative position:', relativeX);
                        this.expandedWaveform.seekTo(relativeX);
                        // Also update the main waveform if it exists
                        if (this.waveform) {
                            this.waveform.seekTo(relativeX);
                        }
                    });
                    
                    this.expandedWaveform.on('region-updated', (region) => {
                        console.log('Expanded region updated:', region);
                        this.updateExpandedTrimTimes();
                    });
                } else {
                    console.warn('No current cue available for expanded waveform');
                    expandedDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">No cue selected</div>';
                }
            } catch (error) {
                console.error('WaveformControls: Error creating expanded waveform:', error);
                expandedDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #ff6b6b;">Error creating expanded waveform</div>';
            }
        }
    }
    
    setupExpandedZoom() {
        const expandedDisplay = document.getElementById('expandedWaveformDisplay');
        if (!expandedDisplay) return;
        
        let expandedZoomLevel = 0;
        
        // Mouse wheel zoom
        expandedDisplay.addEventListener('wheel', (e) => {
            if (!this.expandedWaveform) return;
            
            e.preventDefault();
            e.stopPropagation();
            
            const direction = e.deltaY < 0 ? 1 : -1;
            let zoomStep;
            
            if (expandedZoomLevel < 10) {
                zoomStep = 1 * direction;
            } else {
                zoomStep = 5 * direction;
            }
            
            expandedZoomLevel += zoomStep;
            expandedZoomLevel = Math.min(Math.max(expandedZoomLevel, this.minZoom), this.maxZoom);
            
            console.log(`Expanded zoom level: ${expandedZoomLevel}`);
            
            try {
                this.expandedWaveform.zoom(expandedZoomLevel);
            } catch (error) {
                console.warn('WaveformControls: Error setting expanded zoom:', error);
                expandedZoomLevel = 0;
            }
            
            if (expandedZoomLevel <= this.minZoom) {
                expandedZoomLevel = 0;
                try {
                    this.expandedWaveform.zoom(0);
                } catch (error) {
                    console.warn('WaveformControls: Error resetting expanded zoom:', error);
                }
            }
        });
        
        // Double-click to reset zoom
        expandedDisplay.addEventListener('dblclick', (e) => {
            if (this.expandedWaveform) {
                expandedZoomLevel = 0;
                try {
                    this.expandedWaveform.zoom(0);
                } catch (error) {
                    console.warn('WaveformControls: Error resetting expanded zoom:', error);
                }
            }
        });
    }
    
    loadExpandedTrimRegions() {
        if (!this.expandedWaveform || !this.currentCue) return;
        
        const duration = this.expandedWaveform.getDuration();
        if (!duration) return;
        
        const trimStart = this.currentCue.trimStartTime || 0;
        const trimEnd = this.currentCue.trimEndTime || duration;
        
        // Get the regions plugin instance
        const regionsPlugin = this.expandedWaveform.plugins[0];
        if (!regionsPlugin) {
            console.warn('WaveformControls: No regions plugin found for expanded waveform');
            return;
        }
        
        // Clear existing regions
        this.clearAllRegions(regionsPlugin);
        
        // Create trim region
        if (trimStart > 0 || trimEnd < duration) {
            regionsPlugin.addRegion({
                id: 'trimRegion',
                start: trimStart,
                end: trimEnd,
                color: 'rgba(0, 255, 0, 0.3)',
                drag: true,
                resize: true
            });
            
            // Create cut overlays
            if (trimStart > 0.01) {
                regionsPlugin.addRegion({
                    id: 'cutOverlay-before',
                    start: 0,
                    end: Math.max(0, trimStart - 0.01),
                    color: 'rgba(255, 0, 0, 0.4)',
                    drag: false,
                    resize: false
                });
            }
            
            if (trimEnd < duration - 0.01) {
                regionsPlugin.addRegion({
                    id: 'cutOverlay-after',
                    start: Math.min(duration, trimEnd + 0.01),
                    end: duration,
                    color: 'rgba(255, 0, 0, 0.4)',
                    drag: false,
                    resize: false
                });
            }
        }
    }
    
    updateExpandedTrimTimes() {
        if (!this.expandedWaveform) return;
        
        const regionsPlugin = this.expandedWaveform.plugins[0];
        if (!regionsPlugin) return;
        
        const regions = regionsPlugin.getRegions();
        const trimRegion = Array.isArray(regions) ? 
            regions.find(r => r && r.id === 'trimRegion') : 
            (regions ? regions['trimRegion'] : null);
        
        if (trimRegion) {
            this.trimStartTime = trimRegion.start;
            this.trimEndTime = trimRegion.end;
            
            // Update cue properties
            this.updateCueTrimTimes();
            
            // Sync back to main waveform
            this.updateTrimRegion();
        }
    }
    
    updateTrimProperty(property, value) {
        const wsBindings = this.websocketBindings || websocketBindingsModule;
        const sendFn = (wsBindings && typeof wsBindings.send === 'function') ? wsBindings.send : null;
        const acSend = (this.audioController != null && typeof this.audioController.sendWebSocketMessage === 'function')
            ? this.audioController.sendWebSocketMessage.bind(this.audioController)
            : null;
        
        try {
            if (sendFn) {
                sendFn('update_cue', {
                    cueId: this.currentCue?.id,
                    updates: { [property]: value }
                });
            } else if (acSend) {
                acSend({
                    type: 'update_cue_property',
                    payload: { property, value }
                });
            } else {
                console.warn('WaveformControls: No WebSocket bindings available to send property update');
            }
        } catch (err) {
            console.error('WaveformControls: Error sending property update:', err);
        }
    }
    
    updatePlayPauseButton(isPlaying) {
        const playPauseBtn = document.getElementById('wfPlayPauseBtn');
        const expandedPlayPauseBtn = document.getElementById('expandedWfPlayPauseBtn');
        
        const icon = isPlaying ? '/assets/icons/pause.png' : '/assets/icons/play.png';
        
        if (playPauseBtn) {
            playPauseBtn.querySelector('img').src = icon;
        }
        
        if (expandedPlayPauseBtn) {
            expandedPlayPauseBtn.querySelector('img').src = icon;
        }
    }
    
    loadWaveform(audioUrl) {
        const waveformDisplay = document.getElementById('waveformDisplay');
        if (!waveformDisplay) {
            console.error('WaveformControls: waveformDisplay element not found');
            return;
        }
        
        if (!window.WaveSurfer) {
            console.error('WaveformControls: WaveSurfer library not loaded');
            waveformDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">WaveSurfer library not loaded</div>';
            return;
        }
        
        // Always destroy existing waveform and create a new one (like the original app)
        this.destroyWaveform();
        
        // Clear the display container
        waveformDisplay.innerHTML = '';
        
        try {
            // Create waveform instance with regions plugin (matching original app configuration)
            this.waveform = WaveSurfer.create({
                container: waveformDisplay,
                waveColor: '#4F46E5',
                progressColor: '#7C3AED',
                cursorColor: '#EF4444',
                barWidth: 2,
                barRadius: 3,
                responsive: true,
                height: 128,
                normalize: true,
                backend: 'WebAudio',
                mediaControls: false,
                interact: true,
                plugins: [
                    WaveSurfer.Regions.create()
                ]
            });
            
            // Set up zoom functionality
            this.setupZoom();
            
            // Load audio
            this.waveform.load(audioUrl);
            
            // Set up event listeners
            this.waveform.on('ready', () => {
                console.log('Waveform ready');
                this.updateTimeDisplay();
                this.loadTrimRegions();
            });
            
            this.waveform.on('audioprocess', () => {
                this.updateTimeDisplay();
            });
            
            this.waveform.on('seek', () => {
                this.updateTimeDisplay();
            });
            
            this.waveform.on('finish', () => {
                this.updatePlayPauseButton(false);
            });
            
            // Set up click to seek functionality
            this.waveform.on('click', (relativeX) => {
                console.log('Waveform clicked at relative position:', relativeX);
                this.waveform.seekTo(relativeX);
            });
            
            // Set up region events
            this.waveform.on('region-created', (region) => {
                console.log('Region created:', region);
            });
            
            this.waveform.on('region-updated', (region) => {
                console.log('Region updated:', region);
                this.updateTrimTimes();
            });
            
            this.waveform.on('region-clicked', (region, e) => {
                e.stopPropagation();
                this.waveform.seekTo(region.start / this.waveform.getDuration());
            });
            
            // Handle loading errors
            this.waveform.on('error', (error) => {
                console.error('Waveform loading error:', error);
                waveformDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #ff6b6b;">Error loading waveform</div>';
            });
            
        } catch (error) {
            console.error('WaveformControls: Error creating waveform:', error);
            waveformDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #ff6b6b;">Error creating waveform</div>';
        }
    }
    
    destroyWaveform() {
        if (this.waveform) {
            try {
                this.waveform.destroy();
            } catch (error) {
                console.warn('WaveformControls: Error destroying waveform:', error);
            }
            this.waveform = null;
        }
        
        if (this.expandedWaveform) {
            try {
                this.expandedWaveform.destroy();
            } catch (error) {
                console.warn('WaveformControls: Error destroying expanded waveform:', error);
            }
            this.expandedWaveform = null;
        }
        
        // Reset zoom level
        this.zoomLevel = 0;
    }
    
    setupZoom() {
        const waveformDisplay = document.getElementById('waveformDisplay');
        if (!waveformDisplay) return;
        
        // Mouse wheel zoom
        waveformDisplay.addEventListener('wheel', (e) => {
            if (!this.waveform) {
                console.warn('Cannot zoom: waveform not initialized');
                return;
            }
            
            e.preventDefault();
            e.stopPropagation();
            
            const direction = e.deltaY < 0 ? 1 : -1; // 1 = zoom in, -1 = zoom out
            let zoomStep;
            
            if (this.zoomLevel < 10) {
                zoomStep = 1 * direction;
            } else {
                zoomStep = 5 * direction;
            }
            
            this.zoomLevel += zoomStep;
            this.zoomLevel = Math.min(Math.max(this.zoomLevel, this.minZoom), this.maxZoom);
            
            console.log(`Setting zoom to level ${this.zoomLevel}`);
            
            try {
                this.waveform.zoom(this.zoomLevel);
            } catch (error) {
                console.warn('WaveformControls: Error setting zoom:', error);
                // Reset zoom level if there was an error
                this.zoomLevel = 0;
            }
            
            // Reset to default if zoomed all the way to minimum
            if (this.zoomLevel <= this.minZoom) {
                this.resetZoom();
            }
        });
        
        // Double-click to reset zoom
        waveformDisplay.addEventListener('dblclick', (e) => {
            if (this.waveform) {
                this.resetZoom();
            }
        });
    }
    
    resetZoom() {
        this.zoomLevel = 0;
        if (this.waveform) {
            this.waveform.zoom(0);
        }
    }
    
    loadTrimRegions() {
        if (!this.waveform || !this.currentCue) return;
        
        const duration = this.waveform.getDuration();
        if (!duration) return;
        
        const trimStart = this.currentCue.trimStartTime || 0;
        const trimEnd = this.currentCue.trimEndTime || duration;
        
        // Get the regions plugin instance
        const regionsPlugin = this.waveform.plugins[0];
        if (!regionsPlugin) {
            console.warn('WaveformControls: No regions plugin found for loading trim regions');
            return;
        }
        
        // Clear existing regions
        this.clearAllRegions(regionsPlugin);
        
        // Create trim region
        if (trimStart > 0 || trimEnd < duration) {
            regionsPlugin.addRegion({
                id: 'trimRegion',
                start: trimStart,
                end: trimEnd,
                color: 'rgba(0, 255, 0, 0.3)',
                drag: true,
                resize: true
            });
            
            // Create cut overlays
            if (trimStart > 0.01) {
                regionsPlugin.addRegion({
                    id: 'cutOverlay-before',
                    start: 0,
                    end: Math.max(0, trimStart - 0.01),
                    color: 'rgba(255, 0, 0, 0.4)',
                    drag: false,
                    resize: false
                });
            }
            
            if (trimEnd < duration - 0.01) {
                regionsPlugin.addRegion({
                    id: 'cutOverlay-after',
                    start: Math.min(duration, trimEnd + 0.01),
                    end: duration,
                    color: 'rgba(255, 0, 0, 0.4)',
                    drag: false,
                    resize: false
                });
            }
        }
    }
    
    updateTrimTimes() {
        if (!this.waveform) return;
        
        const regionsPlugin = this.waveform.plugins[0];
        if (!regionsPlugin) return;
        
        const regions = regionsPlugin.getRegions();
        const trimRegion = Array.isArray(regions) ? 
            regions.find(r => r && r.id === 'trimRegion') : 
            (regions ? regions['trimRegion'] : null);
        
        if (trimRegion) {
            this.trimStartTime = trimRegion.start;
            this.trimEndTime = trimRegion.end;
            
            // Update cue properties
            this.updateCueTrimTimes();
        }
    }
    
    updateCueTrimTimes() {
        if (!this.currentCue) return;
        
        // Use websocketBindings if available, otherwise try audioController (with null-safe fallback)
        const wsBindings = this.websocketBindings || websocketBindingsModule;
        const sendFn = (wsBindings && typeof wsBindings.send === 'function') ? wsBindings.send : null;
        const acSend = (this.audioController != null && typeof this.audioController.sendWebSocketMessage === 'function')
            ? this.audioController.sendWebSocketMessage.bind(this.audioController)
            : null;
        
        try {
            if (sendFn) {
                sendFn('update_cue', {
                    cueId: this.currentCue.id,
                    updates: {
                        trimStartTime: this.trimStartTime,
                        trimEndTime: this.trimEndTime
                    }
                });
            } else if (acSend) {
                acSend({
                    type: 'update_cue',
                    payload: {
                        cueId: this.currentCue.id,
                        updates: {
                            trimStartTime: this.trimStartTime,
                            trimEndTime: this.trimEndTime
                        }
                    }
                });
            } else {
                console.warn('WaveformControls: No WebSocket bindings available to send trim time update');
            }
            // Optimistic local update so playback sees new trim immediately (no wait for server round-trip)
            if (this.cueStore && typeof this.cueStore.applyLocalCueUpdates === 'function') {
                const updates = { trimStartTime: this.trimStartTime };
                if (this.trimEndTime > 0) updates.trimEndTime = this.trimEndTime;
                this.cueStore.applyLocalCueUpdates(this.currentCue.id, updates);
            }
            // Notify sidebar with (trimStart, trimEnd) so it can update form state and save immediately.
            if (onTrimChangeCallback && typeof onTrimChangeCallback === 'function') {
                onTrimChangeCallback(this.trimStartTime, this.trimEndTime);
            }
        } catch (err) {
            console.error('WaveformControls: Error sending trim time update:', err);
        }
    }
    
    updateTimeDisplay() {
        if (!this.waveform) return;
        
        const currentTime = this.waveform.getCurrentTime();
        const duration = this.waveform.getDuration();
        const remaining = duration - currentTime;
        
        // Update main waveform time display
        this.updateTimeElement('wfCurrentTime', currentTime);
        this.updateTimeElement('wfTotalDuration', duration);
        this.updateTimeElement('wfRemainingTime', remaining);
        
        // Update expanded waveform time display
        this.updateTimeElement('expandedWfCurrentTime', currentTime);
        this.updateTimeElement('expandedWfTotalDuration', duration);
        this.updateTimeElement('expandedWfRemainingTime', remaining);
    }
    
    updateTimeElement(elementId, time) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = this.formatTime(time);
        }
    }
    
    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00.000';
        
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        const milliseconds = Math.floor((remainingSeconds % 1) * 1000);
        
        return `${minutes}:${remainingSeconds.toFixed(3).padStart(6, '0')}`;
    }
    
    // Show waveform for a specific cue
    showWaveformForCue(cue) {
        if (!cue) {
            console.warn('WaveformControls: No cue provided');
            this.hideAndDestroyWaveform();
            return;
        }
        
        console.log('WaveformControls: Showing waveform for cue:', cue.name || 'Unknown', cue);
        
        // Store current cue
        this.currentCue = cue;
        this.trimStartTime = cue.trimStartTime || 0;
        this.trimEndTime = cue.trimEndTime || 0;
        
        // Determine the correct audio file ID
        let audioFileId = cue.audioFileId;
        
        // If no audioFileId, try to use the cue ID (for backward compatibility)
        if (!audioFileId) {
            audioFileId = cue.id;
            console.log(`WaveformControls: No audioFileId found, using cue ID: ${audioFileId}`);
        }
        
        // Create audio URL for the file
        const audioUrl = `/api/audio/serve/${audioFileId}`;
        
        console.log(`WaveformControls: Loading waveform from URL: ${audioUrl}`);
        
        // Load and display the waveform
        this.loadWaveform(audioUrl);
    }
    
    // Hide and destroy waveform
    hideAndDestroyWaveform() {
        console.log('WaveformControls: Hiding waveform');
        
        // Use the centralized destroy method
        this.destroyWaveform();
        
        // Clear current cue
        this.currentCue = null;
        this.trimStartTime = 0;
        this.trimEndTime = 0;
        
        // Clear the waveform display container
        const waveformDisplay = document.getElementById('waveformDisplay');
        if (waveformDisplay) {
            waveformDisplay.innerHTML = '<p>This is where waveform will show</p>';
        }
        
        // Clear expanded waveform display
        const expandedDisplay = document.getElementById('expandedWaveformDisplay');
        if (expandedDisplay) {
            expandedDisplay.innerHTML = '';
        }
        
        // Hide expanded waveform bottom panel if open
        const bottomPanel = document.getElementById('bottomWaveformPanel');
        if (bottomPanel) {
            bottomPanel.classList.remove('expanded');
        }
    }
}

// Module-level instance for compatibility with modular initialization
let waveformControlsInstance = null;
let onTrimChangeCallback = null;
let websocketBindingsModule = null;

/**
 * Initialize waveform controls module (compatible with original modular structure)
 * @param {object} dependencies - Object containing websocketBindings and onTrimChange callback
 */
function init(dependencies) {
    console.log('WaveformControls: Initializing module...');
    console.log('WaveformControls: Dependencies received:', dependencies);
    
    websocketBindingsModule = dependencies.websocketBindings;
    onTrimChangeCallback = dependencies.onTrimChange;
    if (dependencies.cueStore) {
        if (waveformControlsInstance) waveformControlsInstance.cueStore = dependencies.cueStore;
    }
    
    // Create instance if it doesn't exist
    if (!waveformControlsInstance) {
        // Note: audioController is not available here, so we'll create a minimal instance
        // The instance will be properly initialized when needed
        waveformControlsInstance = new WaveformControls(null);
    }
    
    // Store websocketBindings and cueStore on the instance
    if (waveformControlsInstance) {
        if (websocketBindingsModule) waveformControlsInstance.websocketBindings = websocketBindingsModule;
        if (dependencies.cueStore) waveformControlsInstance.cueStore = dependencies.cueStore;
    }
    
    // Store the callback for trim changes
    if (typeof onTrimChangeCallback === 'function') {
        console.log('WaveformControls: onTrimChange callback registered');
    } else {
        console.warn('WaveformControls: onTrimChange callback not provided or not a function');
    }
    
    console.log('WaveformControls: Module initialized');
}

/**
 * Show waveform for a cue (module-level wrapper)
 * @param {object} cue - The cue object
 */
function showWaveformForCue(cue) {
    if (waveformControlsInstance) {
        // Ensure websocketBindings is set on the instance
        if (websocketBindingsModule && !waveformControlsInstance.websocketBindings) {
            waveformControlsInstance.websocketBindings = websocketBindingsModule;
        }
        waveformControlsInstance.showWaveformForCue(cue);
    } else {
        console.warn('WaveformControls: Instance not initialized, creating new instance');
        waveformControlsInstance = new WaveformControls(null);
        if (websocketBindingsModule) {
            waveformControlsInstance.websocketBindings = websocketBindingsModule;
        }
        waveformControlsInstance.showWaveformForCue(cue);
    }
}

/**
 * Hide and destroy waveform (module-level wrapper)
 */
function hideAndDestroyWaveform() {
    if (waveformControlsInstance) {
        waveformControlsInstance.hideAndDestroyWaveform();
    }
}

/**
 * Format time for waveform display (module-level wrapper)
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
function formatWaveformTime(seconds) {
    if (waveformControlsInstance) {
        return waveformControlsInstance.formatTime(seconds);
    }
    // Fallback formatting if instance not available
    if (!seconds || isNaN(seconds)) return '0:00.000';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const milliseconds = Math.floor((remainingSeconds % 1) * 1000);
    return `${minutes}:${remainingSeconds.toFixed(3).padStart(6, '0')}`;
}

// Export both the class and module-level functions for compatibility
export {
    init,
    showWaveformForCue,
    hideAndDestroyWaveform,
    formatWaveformTime
};

// Also export as default for compatibility
export default {
    init,
    showWaveformForCue,
    hideAndDestroyWaveform,
    formatWaveformTime,
    // Also export the class for direct instantiation if needed
    WaveformControls
};