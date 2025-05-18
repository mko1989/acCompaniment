// Companion_soundboard/src/renderer/ui/appConfigUI.js
// Manages the App Configuration Sidebar UI, state, and interactions.

import * as ipcRendererBindingsModule from '../ipcRendererBindings.js'; // Import the module

// let ipcRendererBindings; // REMOVE: This will now refer to the imported module alias

// --- Debounce Utility ---
let debounceTimer;
function debounce(func, delay) {
    return function(...args) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => func.apply(this, args), delay);
    };
}
// --- End Debounce Utility ---

// --- App Configuration DOM Elements ---
let configSidebar;
let saveAppConfigButton;
let closeConfigSidebarButton;

// General
let configCuesFilePathInput;
let configAutoLoadLastWorkspaceCheckbox;
let configLastOpenedWorkspacePathDiv;

// Default Cue Settings
let configDefaultCueTypeSelect;
let configDefaultVolumeInput;
let configDefaultVolumeValue;
let configDefaultFadeInInput; // in seconds in UI, converted to ms for config
let configDefaultFadeOutInput; // in seconds in UI, converted to ms for config
let configDefaultLoopSingleCueCheckbox;
let configDefaultRetriggerBehaviorSelect;
let configDefaultStopAllBehaviorSelect;

// OSC Settings
let configOscEnabledCheckbox;
let configOscPortGroup;
let configOscPortInput;

// Audio Settings
let configAudioOutputDeviceSelect;

// UI Settings
// let configShowQuickControlsCheckbox; // REMOVED

// Mixer Integration Elements
let configMixerIntegrationEnabledCheckbox;
let configMixerTypeGroup;
let configMixerTypeSelect;
let configWingIpAddressGroup;
let configWingIpAddressInput;
let configWingModelTypeSelect; // New WING Model select
let configWingModelTypeGroup; // New group for WING Model select

// --- App Configuration State (local cache) ---
let currentAppConfig = {};
let isPopulatingSidebar = false;

function init(electronAPI) { // Renamed parameter to avoid confusion
    console.log('AppConfigUI: Initializing...');
    // ipcRendererBindings is already available as ipcRendererBindingsModule via import
    // No need to store electronAPI here if all IPC calls go through the module.
    cacheDOMElements();
    bindEventListeners();
    // Initial load is important for dependent modules, ensure it happens.
    forceLoadAndApplyAppConfiguration().then(() => {
        console.log('AppConfigUI: Initial config loaded and populated after init.');
    }).catch(error => {
        console.error('AppConfigUI: Error during initial config load in init:', error);
    });
}

function cacheDOMElements() {
    configSidebar = document.getElementById('configSidebar');
    saveAppConfigButton = document.getElementById('saveAppConfigButton'); 
    closeConfigSidebarButton = document.getElementById('closeConfigSidebarButton'); 

    // General
    configCuesFilePathInput = document.getElementById('configCuesFilePath');
    configAutoLoadLastWorkspaceCheckbox = document.getElementById('configAutoLoadLastWorkspace');
    configLastOpenedWorkspacePathDiv = document.getElementById('configLastOpenedWorkspacePath');

    // Default Cue Settings
    configDefaultCueTypeSelect = document.getElementById('configDefaultCueType');
    configDefaultVolumeInput = document.getElementById('configDefaultVolume');
    configDefaultVolumeValue = document.getElementById('configDefaultVolumeValue');
    configDefaultFadeInInput = document.getElementById('defaultFadeIn');
    configDefaultFadeOutInput = document.getElementById('defaultFadeOut');
    configDefaultLoopSingleCueCheckbox = document.getElementById('defaultLoop');
    configDefaultRetriggerBehaviorSelect = document.getElementById('retriggerBehavior');
    configDefaultStopAllBehaviorSelect = document.getElementById('defaultStopAllBehavior');
    
    // OSC Settings
    configOscEnabledCheckbox = document.getElementById('configOscEnabled');
    configOscPortGroup = document.getElementById('oscPortGroup');
    configOscPortInput = document.getElementById('configOscPort');

    // Audio Settings
    configAudioOutputDeviceSelect = document.getElementById('configAudioOutputDevice');

    // Mixer Integration Elements
    configMixerIntegrationEnabledCheckbox = document.getElementById('configMixerIntegrationEnabled');
    configMixerTypeGroup = document.getElementById('mixerTypeGroup');
    configMixerTypeSelect = document.getElementById('configMixerType');
    configWingIpAddressGroup = document.getElementById('wingIpAddressGroup');
    configWingIpAddressInput = document.getElementById('configWingIpAddress');
    configWingModelTypeSelect = document.getElementById('configWingModelType');
    configWingModelTypeGroup = document.getElementById('wingModelTypeGroup'); 

    if (configWingIpAddressInput) {
        console.log('AppConfigUI (cacheDOMElements): Found configWingIpAddressInput. ID:', configWingIpAddressInput.id, 'TagName:', configWingIpAddressInput.tagName, 'Type:', configWingIpAddressInput.type, 'Initial Value:', configWingIpAddressInput.value);
    } else {
        console.error('AppConfigUI (cacheDOMElements): configWingIpAddressInput NOT FOUND by ID \'configWingIpAddress\'!');
    }

    console.log('AppConfigUI: DOM elements cached.');
}

function bindEventListeners() {
    console.log('AppConfigUI (DEBUG): bindEventListeners CALLED.');
    if (saveAppConfigButton) saveAppConfigButton.addEventListener('click', handleSaveButtonClick);
    if (closeConfigSidebarButton) closeConfigSidebarButton.addEventListener('click', () => uiAPI.toggleSidebar('configSidebar', false));

    if (configCuesFilePathInput) configCuesFilePathInput.addEventListener('change', handleAppConfigChange);
    if (configAutoLoadLastWorkspaceCheckbox) configAutoLoadLastWorkspaceCheckbox.addEventListener('change', handleAppConfigChange);

    if (configDefaultCueTypeSelect) configDefaultCueTypeSelect.addEventListener('change', handleAppConfigChange);
    if (configDefaultVolumeInput) {
        configDefaultVolumeInput.addEventListener('input', () => {
            if (configDefaultVolumeValue) configDefaultVolumeValue.textContent = parseFloat(configDefaultVolumeInput.value).toFixed(2);
            handleAppConfigChange(); 
        });
    }
    if (configDefaultFadeInInput) configDefaultFadeInInput.addEventListener('change', handleAppConfigChange);
    if (configDefaultFadeOutInput) {
        console.log('AppConfigUI (DEBUG): configDefaultFadeOutInput FOUND. Adding event listener.');
        configDefaultFadeOutInput.addEventListener('change', handleAppConfigChange);
    } else {
        console.error('AppConfigUI (DEBUG): configDefaultFadeOutInput NOT FOUND when trying to bind event listener!');
    }
    if (configDefaultLoopSingleCueCheckbox) configDefaultLoopSingleCueCheckbox.addEventListener('change', handleAppConfigChange);
    if (configDefaultRetriggerBehaviorSelect) configDefaultRetriggerBehaviorSelect.addEventListener('change', handleAppConfigChange);
    if (configDefaultStopAllBehaviorSelect) configDefaultStopAllBehaviorSelect.addEventListener('change', handleAppConfigChange);
    
    if (configOscEnabledCheckbox) {
        configOscEnabledCheckbox.addEventListener('change', () => {
            handleOscEnabledChange();
            handleAppConfigChange(); 
        });
    }
    if (configOscPortInput) configOscPortInput.addEventListener('change', handleAppConfigChange);
    if (configOscPortInput) configOscPortInput.addEventListener('blur', handleAppConfigChange); 

    if (configAudioOutputDeviceSelect) configAudioOutputDeviceSelect.addEventListener('change', handleAppConfigChange);
    
    if (configMixerIntegrationEnabledCheckbox) {
        configMixerIntegrationEnabledCheckbox.addEventListener('change', () => {
            handleMixerIntegrationEnabledChange();
            handleAppConfigChange(); 
        });
    }
    if (configMixerTypeSelect) {
        configMixerTypeSelect.addEventListener('change', () => {
            handleMixerTypeChange();
            handleAppConfigChange(); 
        });
    }
    if (configWingIpAddressInput) {
        configWingIpAddressInput.addEventListener('blur', (event) => {
            console.log('AppConfigUI (DEBUG): WING IP input BLUR event fired! Value:', event.target.value);
            handleAppConfigChange(); 
        });
        configWingIpAddressInput.addEventListener('input', (event) => { 
            console.log('AppConfigUI (DEBUG): WING IP input INPUT event fired! Value:', event.target.value);
            handleAppConfigChange(); 
        });
    }
    if (configWingModelTypeSelect) configWingModelTypeSelect.addEventListener('change', handleAppConfigChange);

    console.log('AppConfigUI: Event listeners bound.');
}

function handleSaveButtonClick() {
    console.log('AppConfigUI: Save button clicked.');
    saveAppConfiguration();
}

const debouncedSaveAppConfiguration = debounce(saveAppConfiguration, 500);

function handleAppConfigChange() {
    console.log('AppConfigUI (DEBUG): handleAppConfigChange CALLED.');
    if (isPopulatingSidebar) {
        console.log('AppConfigUI: App config field change detected during population, save suppressed.');
        return;
    }
    console.log('AppConfigUI: App config field changed, attempting to save (debounced).');
    debouncedSaveAppConfiguration();
}

function populateConfigSidebar(config) {
    isPopulatingSidebar = true;
    try {
        currentAppConfig = config || {}; 
        console.log('AppConfigUI: Populating sidebar with config:', currentAppConfig);

        // General
        if (configCuesFilePathInput) configCuesFilePathInput.value = currentAppConfig.cuesFilePath || '';
        if (configAutoLoadLastWorkspaceCheckbox) configAutoLoadLastWorkspaceCheckbox.checked = currentAppConfig.autoLoadLastWorkspace === undefined ? true : currentAppConfig.autoLoadLastWorkspace;
        if (configLastOpenedWorkspacePathDiv) configLastOpenedWorkspacePathDiv.textContent = currentAppConfig.lastOpenedWorkspacePath || 'N/A';

        // Default Cue Settings
        if (configDefaultCueTypeSelect) configDefaultCueTypeSelect.value = currentAppConfig.defaultCueType || 'single_file';
        if (configDefaultVolumeInput) {
            const vol = currentAppConfig.defaultVolume !== undefined ? currentAppConfig.defaultVolume : 1.0;
            configDefaultVolumeInput.value = vol;
            if (configDefaultVolumeValue) configDefaultVolumeValue.textContent = parseFloat(vol).toFixed(2);
        }
        if (configDefaultFadeInInput) configDefaultFadeInInput.value = currentAppConfig.defaultFadeInTime !== undefined ? currentAppConfig.defaultFadeInTime : 0;
        if (configDefaultFadeOutInput) configDefaultFadeOutInput.value = currentAppConfig.defaultFadeOutTime !== undefined ? currentAppConfig.defaultFadeOutTime : 0;
        
        if (configDefaultLoopSingleCueCheckbox) configDefaultLoopSingleCueCheckbox.checked = currentAppConfig.defaultLoopSingleCue || false;
        if (configDefaultRetriggerBehaviorSelect) configDefaultRetriggerBehaviorSelect.value = currentAppConfig.defaultRetriggerBehavior || 'restart';
        if (configDefaultStopAllBehaviorSelect) configDefaultStopAllBehaviorSelect.value = currentAppConfig.defaultStopAllBehavior || 'stop';
        
        // OSC Settings
        if (configOscEnabledCheckbox) configOscEnabledCheckbox.checked = currentAppConfig.oscEnabled || false;
        if (configOscPortInput) configOscPortInput.value = currentAppConfig.oscPort || 54321;
        
        if (configAudioOutputDeviceSelect && currentAppConfig.audioOutputDeviceId) {
            configAudioOutputDeviceSelect.value = currentAppConfig.audioOutputDeviceId;
        } else if (configAudioOutputDeviceSelect) {
            configAudioOutputDeviceSelect.value = 'default';
        }

        if (configMixerIntegrationEnabledCheckbox) {
            configMixerIntegrationEnabledCheckbox.checked = currentAppConfig.mixerIntegrationEnabled || false;
        }
        if (configMixerTypeSelect) {
            configMixerTypeSelect.value = currentAppConfig.mixerType || 'none';
        }
        if (currentAppConfig.mixerType === 'behringer_wing') {
            if (configWingIpAddressInput) {
                configWingIpAddressInput.value = currentAppConfig.wingIpAddress || '';
            }
            if (configWingModelTypeSelect) {
                configWingModelTypeSelect.value = currentAppConfig.wingModelType || 'compact';
            }
        } else {
            if (configWingIpAddressInput) {
                configWingIpAddressInput.value = '';
            }
            if (configWingModelTypeSelect) {
                configWingModelTypeSelect.value = 'compact'; 
            }
        }
        
        handleOscEnabledChange(); 
        handleMixerIntegrationEnabledChange(); 

        console.log('AppConfigUI: Sidebar populated (end of try block).');
    } finally {
        isPopulatingSidebar = false; 
    }
    console.log('AppConfigUI: DOM elements updated.');
}

function handleOscEnabledChange() {
    if (!configOscEnabledCheckbox || !configOscPortGroup) return;
    const isEnabled = configOscEnabledCheckbox.checked;
    configOscPortGroup.style.display = isEnabled ? 'block' : 'none';
    console.log('AppConfigUI: OSC Enabled changed.');
}

function handleMixerIntegrationEnabledChange() {
    const isEnabled = configMixerIntegrationEnabledCheckbox ? configMixerIntegrationEnabledCheckbox.checked : false;
    console.log(`AppConfigUI: handleMixerIntegrationEnabledChange - Checkbox is checked: ${isEnabled}. Element:`, configMixerIntegrationEnabledCheckbox);
    if (configMixerTypeGroup) {
        configMixerTypeGroup.style.display = isEnabled ? 'block' : 'none';
    }
    if (!isEnabled) {
        if (configWingIpAddressGroup) configWingIpAddressGroup.style.display = 'none';
        if (configWingModelTypeGroup) configWingModelTypeGroup.style.display = 'none';
    } else {
        handleMixerTypeChange(); 
    }
    console.log('AppConfigUI: Mixer Integration Enabled changed.');
}

function handleMixerTypeChange() {
    if (!configMixerTypeSelect) return;
    
    const selectedType = configMixerTypeSelect.value;
    const integrationEnabled = configMixerIntegrationEnabledCheckbox && configMixerIntegrationEnabledCheckbox.checked;
    console.log(`AppConfigUI: handleMixerTypeChange - Selected type: ${selectedType}, Integration enabled: ${integrationEnabled}. TypeSelect Element:`, configMixerTypeSelect);

    if (configWingIpAddressGroup) {
        configWingIpAddressGroup.style.display = (integrationEnabled && selectedType === 'behringer_wing') ? 'block' : 'none';
    }
    if (configWingModelTypeGroup) {
        configWingModelTypeGroup.style.display = (integrationEnabled && selectedType === 'behringer_wing') ? 'block' : 'none';
    }
    console.log('AppConfigUI: Mixer Type changed.');
}

async function loadAudioOutputDevices() {
    if (!ipcRendererBindingsModule || !ipcRendererBindingsModule.getAudioOutputDevices) {
        console.error('AppConfigUI: ipcRendererBindingsModule or getAudioOutputDevices not available.');
        return;
    }
    if (!configAudioOutputDeviceSelect) {
        console.warn('AppConfigUI: configAudioOutputDeviceSelect element not found.');
        return;
    }

    try {
        const devices = await ipcRendererBindingsModule.getAudioOutputDevices();
        console.log('AppConfigUI: Received audio output devices:', devices);
        
        configAudioOutputDeviceSelect.innerHTML = ''; 

        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'System Default';
        configAudioOutputDeviceSelect.appendChild(defaultOption);
        
        devices.forEach(device => {
            if (device.deviceId && device.label) { 
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Device ${device.deviceId.substring(0,10)}...`;
                configAudioOutputDeviceSelect.appendChild(option);
            }
        });

        if (currentAppConfig && currentAppConfig.audioOutputDeviceId) {
            configAudioOutputDeviceSelect.value = currentAppConfig.audioOutputDeviceId;
        } else {
            configAudioOutputDeviceSelect.value = 'default'; 
        }
        console.log('AppConfigUI: Audio output devices populated. Selected:', configAudioOutputDeviceSelect.value);

    } catch (error) {
        console.error('AppConfigUI: Error loading audio output devices:', error);
        configAudioOutputDeviceSelect.innerHTML = '';
        const errorOption = document.createElement('option');
        errorOption.value = 'error';
        errorOption.textContent = 'Error loading devices';
        errorOption.disabled = true;
        configAudioOutputDeviceSelect.appendChild(errorOption);
        configAudioOutputDeviceSelect.value = 'error';
    }
}

let uiAPI = {}; 

function setUiApi(api) {
    uiAPI = api;
}
 
function gatherConfigFromUI() {
    const newConfig = {};

    if (configCuesFilePathInput) newConfig.cuesFilePath = configCuesFilePathInput.value;
    if (configAutoLoadLastWorkspaceCheckbox) newConfig.autoLoadLastWorkspace = configAutoLoadLastWorkspaceCheckbox.checked;

    if (configDefaultCueTypeSelect) newConfig.defaultCueType = configDefaultCueTypeSelect.value;
    if (configDefaultVolumeInput) newConfig.defaultVolume = parseFloat(configDefaultVolumeInput.value);
    if (configDefaultFadeInInput) newConfig.defaultFadeInTime = parseInt(configDefaultFadeInInput.value, 10) || 0;
    if (configDefaultFadeOutInput) newConfig.defaultFadeOutTime = parseInt(configDefaultFadeOutInput.value, 10) || 0;
    if (configDefaultLoopSingleCueCheckbox) newConfig.defaultLoopSingleCue = configDefaultLoopSingleCueCheckbox.checked;
    if (configDefaultRetriggerBehaviorSelect) newConfig.defaultRetriggerBehavior = configDefaultRetriggerBehaviorSelect.value;
    if (configDefaultStopAllBehaviorSelect) newConfig.defaultStopAllBehavior = configDefaultStopAllBehaviorSelect.value;

    if (configOscEnabledCheckbox) newConfig.oscEnabled = configOscEnabledCheckbox.checked;
    if (configOscPortInput) newConfig.oscPort = parseInt(configOscPortInput.value, 10) || 0;

    if (configAudioOutputDeviceSelect) newConfig.audioOutputDeviceId = configAudioOutputDeviceSelect.value;

    if (configMixerIntegrationEnabledCheckbox) newConfig.mixerIntegrationEnabled = configMixerIntegrationEnabledCheckbox.checked;
    if (configMixerTypeSelect) newConfig.mixerType = configMixerTypeSelect.value;
    if (configWingIpAddressInput) newConfig.wingIpAddress = configWingIpAddressInput.value.trim();
    if (configWingModelTypeSelect) newConfig.wingModelType = configWingModelTypeSelect.value;

    console.log('AppConfigUI: Gathered config from UI:', newConfig);
    return newConfig;
}

async function saveAppConfiguration() {
    console.log('AppConfigUI (DEBUG): saveAppConfiguration CALLED.');
    try {
        const configToSave = gatherConfigFromUI();
        console.log('AppConfigUI (DEBUG): gatherConfigFromUI completed, configToSave:', JSON.stringify(configToSave));

        if (!configToSave) {
            console.error('AppConfigUI: No config data gathered from UI. Aborting save.');
            return;
        }

        console.log('AppConfigUI (DEBUG): Attempting to call ipcRendererBindingsModule.saveAppConfig...');
        const result = await ipcRendererBindingsModule.saveAppConfig(configToSave);
        console.log('AppConfigUI (DEBUG): ipcRendererBindingsModule.saveAppConfig call completed, result:', result);

        if (result && result.success) {
            console.log('AppConfigUI: App configuration successfully saved via main process.');
            currentAppConfig = { ...currentAppConfig, ...configToSave };
        } else {
            console.error('AppConfigUI: Failed to save app configuration via main process:', result ? result.error : 'Unknown error');
        }
    } catch (error) {
        console.error('AppConfigUI: Error during saveAppConfiguration:', error);
    }
}

async function forceLoadAndApplyAppConfiguration() {
    console.log('AppConfigUI: Forcing load and apply of app configuration...');
    if (!ipcRendererBindingsModule) {
        console.error('AppConfigUI: ipcRendererBindingsModule not available. Cannot force load config.');
        return Promise.reject('ipcRendererBindingsModule not available');
    }
    try {
        const loadedConfig = await ipcRendererBindingsModule.getAppConfig();
        console.log('AppConfigUI: Successfully loaded config from main:', loadedConfig);
        populateConfigSidebar(loadedConfig);
        await loadAudioOutputDevices();
        return loadedConfig; 
    } catch (error) {
        console.error('AppConfigUI: Error loading app configuration from main:', error);
        populateConfigSidebar({ ...currentAppConfig });
        await loadAudioOutputDevices();
        return Promise.reject(error);
    }
}

function getCurrentAppConfig() {
    return { ...currentAppConfig };
}

export { 
    init,
    populateConfigSidebar,
    saveAppConfiguration,
    forceLoadAndApplyAppConfiguration,
    getCurrentAppConfig,
    loadAudioOutputDevices,
    setUiApi
}; 