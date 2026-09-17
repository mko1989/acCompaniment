/**
 * Sidebars Component for Browser Interface
 * 
 * Manages the configuration and properties sidebars.
 */

class Sidebars {
    constructor(audioController) {
        this.audioController = audioController;
        this.configSidebar = document.getElementById('configSidebar');
        this.propertiesSidebar = document.getElementById('propertiesSidebar');
        this.currentCueId = null;
        
        // Log element finding for debugging
        console.log('Sidebars: configSidebar found:', !!this.configSidebar);
        console.log('Sidebars: propertiesSidebar found:', !!this.propertiesSidebar);
        
        if (!this.configSidebar) {
            console.error('Sidebars: configSidebar element not found in DOM');
        }
        if (!this.propertiesSidebar) {
            console.error('Sidebars: propertiesSidebar element not found in DOM');
        }
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        console.log('Sidebars initialized');
    }
    
    setupEventListeners() {
        // Properties sidebar close
        document.getElementById('closePropertiesSidebarBtn').addEventListener('click', () => {
            this.hidePropertiesSidebar();
        });
        
        // Configuration form changes
        this.setupConfigFormListeners();
        
        // Properties form changes
        this.setupPropertiesFormListeners();
    }
    
    setupConfigFormListeners() {
        // Audio output device
        const audioDeviceSelect = document.getElementById('configAudioOutputDevice');
        audioDeviceSelect.addEventListener('change', () => {
            this.updateConfig({ audioOutputDeviceId: audioDeviceSelect.value });
        });
        
        // Default cue properties
        const defaultFields = [
            'defaultFadeIn', 'defaultFadeOut', 'defaultLoop', 'retriggerBehavior',
            'defaultStopAllBehavior', 'defaultStopAllFadeOut', 'crossfadeTime',
            'configHttpRemoteEnabled', 'configHttpRemotePort',
            'configWebSocketEnabled', 'configWebSocketPort'
        ];
        
        defaultFields.forEach(fieldId => {
            const element = document.getElementById(fieldId);
            if (element) {
                element.addEventListener('change', () => {
                    this.updateConfigField(fieldId, element);
                });
            }
        });
    }
    
    setupPropertiesFormListeners() {
        // Cue properties
        const propertyFields = [
            'propCueName', 'propCueType', 'propFadeInTime', 'propFadeOutTime',
            'propLoop', 'propRetriggerBehavior', 'propVolume', 'propTrimStartTime',
            'propTrimEndTime', 'propIsDuckingTrigger', 'propEnableDucking', 'propDuckingLevel'
        ];
        
        propertyFields.forEach(fieldId => {
            const element = document.getElementById(fieldId);
            if (element) {
                element.addEventListener('change', () => {
                    this.updateCueProperty(fieldId, element);
                });
            }
        });
        
        // Volume slider
        const volumeSlider = document.getElementById('propVolume');
        const volumeValue = document.getElementById('propVolumeValue');
        if (volumeSlider && volumeValue) {
            volumeSlider.addEventListener('input', () => {
                volumeValue.textContent = volumeSlider.value + '%';
            });
        }
        
        // Ducking level slider
        const duckingSlider = document.getElementById('propDuckingLevel');
        const duckingValue = document.getElementById('propDuckingLevelValue');
        if (duckingSlider && duckingValue) {
            duckingSlider.addEventListener('input', () => {
                duckingValue.textContent = duckingSlider.value + '%';
            });
        }
        
        // Ducking trigger checkbox
        const duckingTrigger = document.getElementById('propIsDuckingTrigger');
        const duckingConfigGroup = document.getElementById('duckingConfigGroup');
        const duckingLevelGroup = document.getElementById('duckingLevelGroup');
        
        if (duckingTrigger) {
            duckingTrigger.addEventListener('change', () => {
                if (duckingTrigger.checked) {
                    duckingConfigGroup.style.display = 'block';
                    duckingLevelGroup.style.display = 'block';
                } else {
                    duckingConfigGroup.style.display = 'none';
                    duckingLevelGroup.style.display = 'none';
                }
            });
        }
    }
    
    toggleConfigSidebar() {
        console.log('Sidebars: toggleConfigSidebar called');
        console.log('Sidebars: configSidebar element:', this.configSidebar);
        
        if (!this.configSidebar) {
            console.error('Sidebars: configSidebar element not found');
            return;
        }
        
        if (this.configSidebar.classList.contains('collapsed')) {
            console.log('Sidebars: Expanding config sidebar');
            this.configSidebar.classList.remove('collapsed');
            this.configSidebar.classList.add('expanded');
        } else {
            console.log('Sidebars: Collapsing config sidebar');
            this.configSidebar.classList.remove('expanded');
            this.configSidebar.classList.add('collapsed');
        }
    }
    
    showPropertiesSidebar(cueId) {
        console.log('Sidebars: showPropertiesSidebar called with cueId:', cueId);
        console.log('Sidebars: propertiesSidebar element:', this.propertiesSidebar);
        
        if (!this.propertiesSidebar) {
            console.error('Sidebars: propertiesSidebar element not found');
            return;
        }
        
        this.currentCueId = cueId;
        this.propertiesSidebar.classList.remove('hidden');
        
        // Ensure the sidebar is visible
        this.propertiesSidebar.style.display = 'flex';
        
        this.loadCueProperties(cueId);
    }
    
    hidePropertiesSidebar() {
        this.propertiesSidebar.classList.add('hidden');
        this.propertiesSidebar.style.display = 'none';
        this.currentCueId = null;
    }
    
    loadCueProperties(cueId) {
        console.log('Sidebars: loadCueProperties called with cueId:', cueId);
        console.log('Sidebars: audioController:', !!this.audioController);
        
        const cue = this.audioController.getCue(cueId);
        if (!cue) {
            console.error('Sidebars: Cue not found:', cueId);
            console.log('Sidebars: Available cues:', this.audioController.getCues().map(c => ({ id: c.id, name: c.name })));
            return;
        }
        
        console.log('Sidebars: Loading properties for cue:', cue.name);
        
        // Helper function to safely set element value
        const setElementValue = (id, value, isChecked = false) => {
            const element = document.getElementById(id);
            if (element) {
                if (isChecked) {
                    element.checked = value;
                } else {
                    element.value = value;
                }
            } else {
                console.warn(`Sidebars: Element not found: ${id}`);
            }
        };
        
        const setElementText = (id, text) => {
            const element = document.getElementById(id);
            if (element) {
                element.textContent = text;
            } else {
                console.warn(`Sidebars: Element not found: ${id}`);
            }
        };
        
        // Populate form fields
        setElementValue('propCueId', cue.id);
        setElementValue('propCueName', cue.name || '');
        setElementValue('propCueType', cue.type || 'single_file');
        setElementValue('propFadeInTime', cue.fadeInTime || 0);
        setElementValue('propFadeOutTime', cue.fadeOutTime || 0);
        setElementValue('propLoop', cue.loop || false, true);
        setElementValue('propRetriggerBehavior', cue.retriggerBehavior || 'restart');
        setElementValue('propVolume', (cue.volume || 1.0) * 100);
        setElementText('propVolumeValue', Math.round((cue.volume || 1.0) * 100) + '%');
        setElementValue('trimStartTime', cue.trimStartTime || 0);
        setElementValue('trimEndTime', cue.trimEndTime || 0);
        setElementValue('propIsDuckingTrigger', cue.isDuckingTrigger || false, true);
        setElementValue('propEnableDucking', cue.enableDucking || false, true);
        setElementValue('propDuckingLevel', cue.duckingLevel || 80);
        setElementText('propDuckingLevelValue', (cue.duckingLevel || 80) + '%');
        
        // Update file path display
        const filePathInput = document.getElementById('propFilePath');
        if (filePathInput) {
            if (cue.filePath) {
                filePathInput.value = cue.filePath;
            } else {
                filePathInput.value = '';
                filePathInput.placeholder = 'Drag & drop file';
            }
        }
        
        // Show/hide appropriate config sections
        this.updatePropertiesSections(cue.type);
        
        // Load waveform if it's a single file cue
        if (cue.type === 'single_file' && cue.filePath) {
            this.loadWaveform(cue);
        }
    }
    
    updatePropertiesSections(cueType) {
        const singleFileConfig = document.getElementById('propSingleFileConfig');
        const playlistConfig = document.getElementById('propPlaylistConfig');
        
        if (cueType === 'single_file') {
            singleFileConfig.style.display = 'block';
            playlistConfig.style.display = 'none';
        } else if (cueType === 'playlist') {
            singleFileConfig.style.display = 'none';
            playlistConfig.style.display = 'block';
        }
    }
    
    loadWaveform(cue) {
        // Load the actual waveform using the waveform controls
        if (window.accompanimentApp && window.accompanimentApp.waveformControls) {
            window.accompanimentApp.waveformControls.showWaveformForCue(cue);
        } else {
            // Fallback: show placeholder if waveform controls not available
            const waveformDisplay = document.getElementById('waveformDisplay');
            if (waveformDisplay) {
                waveformDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">Waveform will be loaded here</div>';
            }
        }
    }
    
    updateConfigField(fieldId, element) {
        let value = element.value;
        
        // Convert checkbox values
        if (element.type === 'checkbox') {
            value = element.checked;
        }
        
        // Convert number values
        if (element.type === 'number') {
            value = parseFloat(value) || 0;
        }
        
        const configUpdate = { [fieldId]: value };
        this.updateConfig(configUpdate);
    }
    
    updateConfig(configUpdate) {
        this.audioController.sendWebSocketMessage({
            type: 'update_config',
            payload: configUpdate
        });
    }
    
    updateCueProperty(fieldId, element) {
        if (!this.currentCueId) return;
        
        let value = element.value;
        
        // Convert checkbox values
        if (element.type === 'checkbox') {
            value = element.checked;
        }
        
        // Convert number values
        if (element.type === 'number') {
            value = parseFloat(value) || 0;
        }
        
        // Convert volume percentage to decimal
        if (fieldId === 'propVolume') {
            value = value / 100;
        }
        
        // Map field IDs to cue property names
        const fieldMapping = {
            'propCueName': 'name',
            'propCueType': 'type',
            'propFadeInTime': 'fadeInTime',
            'propFadeOutTime': 'fadeOutTime',
            'propLoop': 'loop',
            'propRetriggerBehavior': 'retriggerBehavior',
            'propVolume': 'volume',
            'propTrimStartTime': 'trimStartTime',
            'propTrimEndTime': 'trimEndTime',
            'propIsDuckingTrigger': 'isDuckingTrigger',
            'propEnableDucking': 'enableDucking',
            'propDuckingLevel': 'duckingLevel'
        };
        
        const propertyName = fieldMapping[fieldId];
        if (propertyName) {
            this.audioController.sendWebSocketMessage({
                type: 'update_cue',
                payload: {
                    cueId: this.currentCueId,
                    updates: { [propertyName]: value }
                }
            });
        }
    }
    
    loadConfig(config) {
        // Populate configuration form
        if (config.audioOutputDeviceId) {
            document.getElementById('configAudioOutputDevice').value = config.audioOutputDeviceId;
        }
        
        if (config.defaultFadeInTime !== undefined) {
            document.getElementById('defaultFadeIn').value = config.defaultFadeInTime;
        }
        
        if (config.defaultFadeOutTime !== undefined) {
            document.getElementById('defaultFadeOut').value = config.defaultFadeOutTime;
        }
        
        if (config.defaultLoopSingleCue !== undefined) {
            document.getElementById('defaultLoop').checked = config.defaultLoopSingleCue;
        }
        
        if (config.defaultRetriggerBehavior) {
            document.getElementById('retriggerBehavior').value = config.defaultRetriggerBehavior;
        }
        
        if (config.defaultStopAllBehavior) {
            document.getElementById('defaultStopAllBehavior').value = config.defaultStopAllBehavior;
        }
        
        if (config.defaultStopAllFadeOutTime !== undefined) {
            document.getElementById('defaultStopAllFadeOut').value = config.defaultStopAllFadeOutTime;
        }
        
        if (config.crossfadeTime !== undefined) {
            document.getElementById('crossfadeTime').value = config.crossfadeTime;
        }
        
        if (config.httpRemoteEnabled !== undefined) {
            document.getElementById('configHttpRemoteEnabled').checked = config.httpRemoteEnabled;
        }
        
        if (config.httpRemotePort !== undefined) {
            document.getElementById('configHttpRemotePort').value = config.httpRemotePort;
        }
        
        if (config.websocketEnabled !== undefined) {
            document.getElementById('configWebSocketEnabled').checked = config.websocketEnabled;
        }
        
        if (config.websocketPort !== undefined) {
            document.getElementById('configWebSocketPort').value = config.websocketPort;
        }
        
        // Load audio device options
        this.loadAudioDevices();
        
        // Update remote links
        this.updateRemoteLinks(config);
    }
    
    async loadAudioDevices() {
        try {
            // Request available audio devices from the backend
            const response = await fetch('/api/audio/devices');
            if (response.ok) {
                const data = await response.json();
                const deviceSelect = document.getElementById('configAudioOutputDevice');
                
                if (deviceSelect && data.devices) {
                    // Clear existing options
                    deviceSelect.innerHTML = '';
                    
                    // Add default option
                    const defaultOption = document.createElement('option');
                    defaultOption.value = 'default';
                    defaultOption.textContent = 'Default Audio Device';
                    deviceSelect.appendChild(defaultOption);
                    
                    // Add available devices
                    data.devices.forEach(device => {
                        const option = document.createElement('option');
                        option.value = device.deviceId;
                        option.textContent = device.label || device.deviceId;
                        deviceSelect.appendChild(option);
                    });
                    
                    console.log(`Sidebars: Loaded ${data.devices.length} audio devices`);
                }
            } else {
                console.warn('Sidebars: Failed to load audio devices');
                // Fallback: add a default option
                const deviceSelect = document.getElementById('configAudioOutputDevice');
                if (deviceSelect) {
                    deviceSelect.innerHTML = '<option value="default">Default Audio Device</option>';
                }
            }
        } catch (error) {
            console.error('Sidebars: Error loading audio devices:', error);
            // Fallback: add a default option
            const deviceSelect = document.getElementById('configAudioOutputDevice');
            if (deviceSelect) {
                deviceSelect.innerHTML = '<option value="default">Default Audio Device</option>';
            }
        }
    }
    
    updateRemoteLinks(config) {
        const httpLinksDiv = document.getElementById('httpRemoteLinksDiv');
        const wsLinksDiv = document.getElementById('webSocketLinksDiv');
        
        if (httpLinksDiv && config.httpRemoteEnabled) {
            const port = config.httpRemotePort || 3000;
            httpLinksDiv.innerHTML = `
                <div style="font-size: 0.9em; margin-top: 5px;">
                    <div><a href="http://localhost:${port}" target="_blank">http://localhost:${port}</a></div>
                    <div><a href="http://localhost:${port}/api/remote/health" target="_blank">Health Check</a></div>
                </div>
            `;
        }
        
        if (wsLinksDiv && config.websocketEnabled) {
            const port = config.websocketPort || 8877;
            wsLinksDiv.innerHTML = `
                <div style="font-size: 0.9em; margin-top: 5px;">
                    <div>ws://localhost:${port}</div>
                    <div>Companion Integration</div>
                </div>
            `;
        }
    }
}

// Export for use in modules
export default Sidebars;