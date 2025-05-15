// Companion_soundboard/src/renderer/ui/appConfigUI.js
// Manages the App Configuration Sidebar UI, state, and interactions.

let ipcRendererBindingsModule;
let audioController; // To update audio settings like device, default retrigger

// --- DOM Elements for App Config Sidebar ---
let audioOutputSelect, 
    defaultFadeInInput, 
    defaultFadeOutInput, 
    defaultLoopCheckbox,
    defaultVolumeInput, 
    defaultVolumeValueDisplay, 
    retriggerBehaviorSelect, 
    defaultStopAllBehaviorSelect;

// --- App Configuration State (local cache) ---
let currentAppConfig = {
    defaultFadeInTime: 0,
    defaultFadeOutTime: 0,
    defaultLoop: false,
    defaultVolume: 1,
    defaultRetriggerBehavior: 'restart',
    defaultStopAllBehavior: 'stop',
    audioOutputDevice: 'default'
};

async function initAppConfigUI(ipc, ac) {
    ipcRendererBindingsModule = ipc;
    audioController = ac;

    cacheAppConfigDOMElements();
    bindAppConfigEventListeners();
    
    await loadAndApplyAppConfiguration(); // Load initial config
    console.log('AppConfigUI Module Initialized');
}

function cacheAppConfigDOMElements() {
    audioOutputSelect = document.getElementById('audioOutput');
    defaultFadeInInput = document.getElementById('defaultFadeIn');
    defaultFadeOutInput = document.getElementById('defaultFadeOut');
    defaultLoopCheckbox = document.getElementById('defaultLoop');
    retriggerBehaviorSelect = document.getElementById('retriggerBehavior');
    defaultStopAllBehaviorSelect = document.getElementById('defaultStopAllBehavior');
    defaultVolumeInput = document.getElementById('defaultVolume');
    defaultVolumeValueDisplay = document.getElementById('defaultVolumeValueDisplay');
}

function bindAppConfigEventListeners() {
    if (defaultFadeInInput) defaultFadeInInput.addEventListener('change', handleAppConfigChange);
    if (defaultFadeOutInput) defaultFadeOutInput.addEventListener('change', handleAppConfigChange);
    if (defaultLoopCheckbox) defaultLoopCheckbox.addEventListener('change', handleAppConfigChange);
    if (retriggerBehaviorSelect) retriggerBehaviorSelect.addEventListener('change', handleAppConfigChange);
    if (audioOutputSelect) audioOutputSelect.addEventListener('change', handleAppConfigChange);
    if (defaultStopAllBehaviorSelect) defaultStopAllBehaviorSelect.addEventListener('change', handleAppConfigChange);
    if (defaultVolumeInput) {
        defaultVolumeInput.addEventListener('change', handleAppConfigChange); // Save on change
        defaultVolumeInput.addEventListener('input', () => { // Update display on input
            if(defaultVolumeValueDisplay) defaultVolumeValueDisplay.textContent = parseFloat(defaultVolumeInput.value).toFixed(2);
        });
    }
}

async function loadAndApplyAppConfiguration() {
    if (!ipcRendererBindingsModule) return;
    console.log('AppConfigUI: Loading app configuration...');
    try {
        const loadedConfig = await ipcRendererBindingsModule.getAppConfig();
        if (loadedConfig && typeof loadedConfig === 'object') {
            currentAppConfig = { ...currentAppConfig, ...loadedConfig };
            console.log('AppConfigUI: App configuration loaded:', currentAppConfig);
        } else {
            console.log('AppConfigUI: No existing config found or invalid format, using defaults.');
        }
    } catch (error) {
        console.error('AppConfigUI: Error loading app configuration:', error);
        // Keep defaults if error
    }
    populateConfigSidebar(); // Reflect loaded (or default) config in UI
    await populateAudioOutputDevicesDropdown(); // Populate and set device
    
    // Notify audioController of the loaded/default config
    if (audioController && typeof audioController.updateAppConfig === 'function') {
        audioController.updateAppConfig(currentAppConfig);
    }
    if (audioController && typeof audioController.setAudioOutputDevice === 'function') {
        audioController.setAudioOutputDevice(currentAppConfig.audioOutputDevice || 'default');
    }
}

function populateConfigSidebar() {
    if (!defaultFadeInInput) { // Check if DOM elements are cached
        console.warn("AppConfigUI: Config sidebar DOM elements not found for populating.");
        return;
    }
    defaultFadeInInput.value = currentAppConfig.defaultFadeInTime;
    defaultFadeOutInput.value = currentAppConfig.defaultFadeOutTime;
    defaultLoopCheckbox.checked = currentAppConfig.defaultLoop;
    defaultVolumeInput.value = currentAppConfig.defaultVolume;
    if(defaultVolumeValueDisplay) defaultVolumeValueDisplay.textContent = parseFloat(currentAppConfig.defaultVolume).toFixed(2);
    retriggerBehaviorSelect.value = currentAppConfig.defaultRetriggerBehavior;
    defaultStopAllBehaviorSelect.value = currentAppConfig.defaultStopAllBehavior;
    // audioOutputSelect.value is handled by populateAudioOutputDevicesDropdown
}

async function handleAppConfigChange() {
    if (!ipcRendererBindingsModule) return;
    
    const newConfig = {
        defaultFadeInTime: defaultFadeInInput ? parseFloat(defaultFadeInInput.value) || 0 : currentAppConfig.defaultFadeInTime,
        defaultFadeOutTime: defaultFadeOutInput ? parseFloat(defaultFadeOutInput.value) || 0 : currentAppConfig.defaultFadeOutTime,
        defaultLoop: defaultLoopCheckbox ? defaultLoopCheckbox.checked : currentAppConfig.defaultLoop,
        defaultVolume: defaultVolumeInput ? parseFloat(defaultVolumeInput.value) : currentAppConfig.defaultVolume,
        defaultRetriggerBehavior: retriggerBehaviorSelect ? retriggerBehaviorSelect.value : currentAppConfig.defaultRetriggerBehavior,
        defaultStopAllBehavior: defaultStopAllBehaviorSelect ? defaultStopAllBehaviorSelect.value : currentAppConfig.defaultStopAllBehavior,
        audioOutputDevice: audioOutputSelect ? audioOutputSelect.value : 'default'
    };
    const oldDeviceId = currentAppConfig.audioOutputDevice;
    currentAppConfig = { ...currentAppConfig, ...newConfig };
    
    console.log('AppConfigUI: Saving new app configuration:', currentAppConfig);
    await ipcRendererBindingsModule.saveAppConfig(currentAppConfig);

    // Notify audioController of changes
    if (audioController && typeof audioController.updateAppConfig === 'function') {
        audioController.updateAppConfig(currentAppConfig);
    }
    if (audioController && typeof audioController.setAudioOutputDevice === 'function') {
        if (oldDeviceId !== currentAppConfig.audioOutputDevice) {
            console.log(`AppConfigUI: Audio output device changed from ${oldDeviceId} to ${currentAppConfig.audioOutputDevice}`);
            audioController.setAudioOutputDevice(currentAppConfig.audioOutputDevice);
        }
    }
    // The specific call to audioController.setDefaultRetriggerBehavior might be redundant
    // if audioController.updateAppConfig handles all relevant properties.
    // However, keeping it if it's a distinct necessary update path.
    if (audioController && typeof audioController.setDefaultRetriggerBehavior === 'function') {
         audioController.setDefaultRetriggerBehavior(currentAppConfig.defaultRetriggerBehavior);
    }
}

async function populateAudioOutputDevicesDropdown() {
    if (!audioOutputSelect || !ipcRendererBindingsModule) return;
    const previouslySelectedDevice = currentAppConfig.audioOutputDevice || 'default';
    audioOutputSelect.innerHTML = ''; // Clear existing options
    
    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = 'System Default Device';
    audioOutputSelect.appendChild(defaultOption);

    try {
        const devices = await ipcRendererBindingsModule.getAudioOutputDevices();
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Device ${device.deviceId.substring(0,8)}`;
            audioOutputSelect.appendChild(option);
        });

        // Try to reselect the previously selected device
        const existingOption = Array.from(audioOutputSelect.options).find(opt => opt.value === previouslySelectedDevice);
        if (existingOption) {
            audioOutputSelect.value = previouslySelectedDevice;
        } else {
            console.warn(`AppConfigUI: Previously selected audio device '${previouslySelectedDevice}' not found. Falling back to default.`);
            audioOutputSelect.value = 'default'; // Fallback to default if not found
        }
        // Ensure currentAppConfig reflects the actual selection, especially if it fell back
        if (currentAppConfig.audioOutputDevice !== audioOutputSelect.value) {
             currentAppConfig.audioOutputDevice = audioOutputSelect.value;
             // No need to save here as this function is called during load or after a change that will be saved.
        }

    } catch (error) {
        console.error('AppConfigUI: Error populating audio output devices:', error);
        audioOutputSelect.value = 'default'; // Fallback on error
        if (currentAppConfig.audioOutputDevice !== 'default') {
            currentAppConfig.audioOutputDevice = 'default';
        }
    }
}

function getCurrentAppConfig() {
    return { ...currentAppConfig }; // Return a copy to prevent direct modification
}

// This function is needed if ui.js (or other modules) need to trigger a reload/refresh of config
// e.g., after workspace change.
async function forceLoadAndApplyAppConfiguration() {
    await loadAndApplyAppConfiguration();
}


export { 
    initAppConfigUI, 
    getCurrentAppConfig,
    forceLoadAndApplyAppConfiguration // Export if ui.js needs to trigger this
}; 