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


    // Directly load config now
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
    if (configDefaultFadeInInput) configDefaultFadeInInput.addEventListener('change', handleAppConfigChange);
    if (configDefaultFadeOutInput) {
        console.log('AppConfigUI (DEBUG): configDefaultFadeOutInput FOUND. Adding event listener.');
        configDefaultFadeOutInput.addEventListener('change', handleAppConfigChange);
    } else {
        console.error('AppConfigUI (DEBUG): configDefaultFadeOutInput NOT FOUND when trying to bind event listener!');
    }
    if (configDefaultLoopSingleCueCheckbox) configDefaultLoopSingleCueCheckbox.addEventListener('change', handleAppConfigChange);
    if (configDefaultRetriggerBehaviorSelect) configDefaultRetriggerBehaviorSelect.addEventListener('change', handleAppConfigChange);
    if (configDefaultStopAllBehaviorSelect) {
        configDefaultStopAllBehaviorSelect.value = currentAppConfig.defaultStopAllBehavior || 'stop';
        configDefaultStopAllBehaviorSelect.addEventListener('change', handleAppConfigChange);
    }
    
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
        if (configLastOpenedWorkspacePathDiv) configLastOpenedWorkspacePathDiv.textContent = currentAppConfig.lastOpenedWorkspacePath || 'None';

        // Default Cue Settings
        if (configDefaultCueTypeSelect) configDefaultCueTypeSelect.value = currentAppConfig.defaultCueType || 'single_file';
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
            configMixerTypeSelect.value = currentAppConfig.mixerType || 'wing';
        }
        if (currentAppConfig.mixerType === 'behringer_wing') {
            if (configWingIpAddressInput) {
                configWingIpAddressInput.value = currentAppConfig.wingIpAddress || '';
            }
            if (configWingModelTypeSelect) {
                console.log('[AppConfigUI populateConfigSidebar] Accessing WING Model. Element:', configWingModelTypeSelect, 'Selected Value:', configWingModelTypeSelect ? configWingModelTypeSelect.value : 'Element N/A');
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
        handleMixerTypeChange();



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
    
    // Always hide all mixer-specific input fields when integration is disabled
    if (!isEnabled) {
        if (configWingIpAddressGroup) configWingIpAddressGroup.style.display = 'none';
        if (configWingModelTypeGroup) configWingModelTypeGroup.style.display = 'none';
    } else {
        handleMixerTypeChange();
    }
    
    console.log('AppConfigUI: Mixer Integration Enabled changed.');
}

function handleMixerTypeChange() {
    const selectedMixer = configMixerTypeSelect ? configMixerTypeSelect.value : 'none';
    console.log('AppConfigUI (handleMixerTypeChange): Selected mixer type:', selectedMixer);

    const isWingFamily = selectedMixer === 'behringer_wing' || selectedMixer === 'behringer_wing_compact';

    if (configWingIpAddressGroup) {
        configWingIpAddressGroup.style.display = isWingFamily ? 'block' : 'none';
    }
    // Show model type selector only for the generic 'behringer_wing' type,
    // as 'behringer_wing_compact' already specifies the model.
    if (configWingModelTypeGroup) {
        configWingModelTypeGroup.style.display = selectedMixer === 'behringer_wing' ? 'block' : 'none';
    }
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
    const mixerEnabled = configMixerIntegrationEnabledCheckbox ? configMixerIntegrationEnabledCheckbox.checked : false;
    let mixerType = configMixerTypeSelect ? configMixerTypeSelect.value : 'none'; // Default to 'none' if not found

    const config = {
        cuesFilePath: configCuesFilePathInput ? configCuesFilePathInput.value : '',
        autoLoadLastWorkspace: configAutoLoadLastWorkspaceCheckbox ? configAutoLoadLastWorkspaceCheckbox.checked : true,
        lastOpenedWorkspacePath: currentAppConfig.lastOpenedWorkspacePath || '', // Preserve this from loaded config, not UI
        recentWorkspaces: currentAppConfig.recentWorkspaces || [], // Preserve this from loaded config

        defaultCueType: configDefaultCueTypeSelect ? configDefaultCueTypeSelect.value : 'single_file',
        defaultFadeInTime: configDefaultFadeInInput ? parseInt(configDefaultFadeInInput.value) : 0,
        defaultFadeOutTime: configDefaultFadeOutInput ? parseInt(configDefaultFadeOutInput.value) : 0,
        defaultLoopSingleCue: configDefaultLoopSingleCueCheckbox ? configDefaultLoopSingleCueCheckbox.checked : false,
        defaultRetriggerBehavior: configDefaultRetriggerBehaviorSelect ? configDefaultRetriggerBehaviorSelect.value : 'restart',
        defaultStopAllBehavior: configDefaultStopAllBehaviorSelect ? configDefaultStopAllBehaviorSelect.value : 'stop',

        oscEnabled: configOscEnabledCheckbox ? configOscEnabledCheckbox.checked : false,
        oscPort: configOscPortInput ? parseInt(configOscPortInput.value) : 54321,
        
        audioOutputDeviceId: configAudioOutputDeviceSelect ? configAudioOutputDeviceSelect.value : 'default',

        mixerIntegrationEnabled: mixerEnabled,
        // mixerType: mixerType, // mixerType will be set based on logic below
        
        // theme setting is not directly edited here, but preserved if it exists
        theme: currentAppConfig.theme || 'system',
    };
    
    // Logic for setting mixerType and relevant IP addresses / model types
    if (mixerEnabled) {
        config.mixerType = mixerType; // Set the selected mixer type

        if (mixerType === 'behringer_wing' || mixerType === 'behringer_wing_compact') {
            config.wingIpAddress = configWingIpAddressInput ? configWingIpAddressInput.value.trim() : '';
            if (mixerType === 'behringer_wing') { // Model type is only relevant for the generic wing
                const modelSelectElement = document.getElementById('configWingModelType'); // Re-fetch the element
                console.log('[AppConfigUI gatherConfigFromUI] Accessing WING Model. Re-fetched Element:', modelSelectElement, 'Selected Value:', modelSelectElement ? modelSelectElement.value : 'Element N/A');
                config.wingModelType = modelSelectElement ? modelSelectElement.value : 'compact';
            } else { // For 'behringer_wing_compact'
                config.wingModelType = 'behringer_wing_compact'; // Explicitly set based on mixerType
            }
        } else {
            config.wingIpAddress = ''; // Clear if not a WING type
            config.wingModelType = 'compact'; // Default or clear
        }
    } else { // Mixer integration disabled
        config.mixerType = 'none';
        config.wingIpAddress = '';
        config.wingModelType = 'compact';
    }
    
    console.log('AppConfigUI (gatherConfigFromUI): Gathered config:', JSON.parse(JSON.stringify(config)));
    return config;
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