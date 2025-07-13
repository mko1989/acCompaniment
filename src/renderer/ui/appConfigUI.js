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
let configDefaultStopAllFadeOutInput;
let configDefaultStopAllFadeOutGroup;

// OSC Settings
let configOscEnabledCheckbox;
let configOscPortGroup;
let configOscPortInput;

// Audio Settings
let configAudioOutputDeviceSelect;

// UI Settings
// let configShowQuickControlsCheckbox; // REMOVED

// HTTP Remote Control Elements
let configHttpRemoteEnabledCheckbox;
let configHttpRemotePortGroup;
let configHttpRemotePortInput;
let configHttpRemoteLinksGroup;
let configHttpRemoteLinksDiv;

// Mixer Integration Elements
let configMixerIntegrationEnabledCheckbox;
let configMixerTypeGroup;
let configMixerTypeSelect;
let configWingIpAddressGroup;
let configWingIpAddressInput;



// --- App Configuration State (local cache) ---
let currentAppConfig = {};
let isPopulatingSidebar = false;
let audioControllerRef = null; // Reference to audioController for applying device changes

async function init(electronAPI) { // Renamed parameter to avoid confusion
    console.log('AppConfigUI: Initializing...');
    // ipcRendererBindings is already available as ipcRendererBindingsModule via import
    // No need to store electronAPI here if all IPC calls go through the module.
    cacheDOMElements();
    bindEventListeners();

    // Set up device change listener
    setupDeviceChangeListener();

    try {
        await forceLoadAndApplyAppConfiguration();
        console.log('AppConfigUI: Initial config loaded and populated after init. Returning config.');
        return currentAppConfig; // Return the loaded config
    } catch (error) {
        console.error('AppConfigUI: Error during initial config load in init:', error);
        return {}; // Return empty object or handle error as appropriate
    }
}

// Function to set up device change listener
function setupDeviceChangeListener() {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            console.log('AppConfigUI: Audio devices changed, refreshing device list...');
            // Debounce the device list refresh to avoid excessive updates
            setTimeout(() => {
                loadAudioOutputDevices();
            }, 500);
        });
        console.log('AppConfigUI: Device change listener set up.');
    } else {
        console.warn('AppConfigUI: navigator.mediaDevices.addEventListener not available, device changes won\'t be detected.');
    }
}

// Function to set the audioController reference
function setAudioControllerRef(audioController) {
    audioControllerRef = audioController;
    console.log('AppConfigUI: AudioController reference set');
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
    configDefaultStopAllFadeOutInput = document.getElementById('defaultStopAllFadeOut');
    configDefaultStopAllFadeOutGroup = document.getElementById('defaultStopAllFadeOutGroup');
    
    // OSC Settings
    configOscEnabledCheckbox = document.getElementById('configOscEnabled');
    configOscPortGroup = document.getElementById('oscPortGroup');
    configOscPortInput = document.getElementById('configOscPort');

    // Audio Settings
    configAudioOutputDeviceSelect = document.getElementById('configAudioOutputDevice');

    // HTTP Remote Control Elements
    configHttpRemoteEnabledCheckbox = document.getElementById('configHttpRemoteEnabled');
    configHttpRemotePortGroup = document.getElementById('httpRemotePortGroup');
    configHttpRemotePortInput = document.getElementById('configHttpRemotePort');
    configHttpRemoteLinksGroup = document.getElementById('httpRemoteLinksGroup');
    configHttpRemoteLinksDiv = document.getElementById('httpRemoteLinks');

    // Mixer Integration Elements
    configMixerIntegrationEnabledCheckbox = document.getElementById('configMixerIntegrationEnabled');
    configMixerTypeGroup = document.getElementById('mixerTypeGroup');
    configMixerTypeSelect = document.getElementById('configMixerType');
    configWingIpAddressGroup = document.getElementById('wingIpAddressGroup');
    configWingIpAddressInput = document.getElementById('configWingIpAddress');



    if (configWingIpAddressInput) {
        console.log('AppConfigUI (cacheDOMElements): Found configWingIpAddressInput. ID:', configWingIpAddressInput.id, 'TagName:', configWingIpAddressInput.tagName, 'Type:', configWingIpAddressInput.type, 'Initial Value:', configWingIpAddressInput.value);
    } else {
        console.error('AppConfigUI (cacheDOMElements): configWingIpAddressInput NOT FOUND by ID \'configWingIpAddress\'!');
    }

    // ALPHA BUILD: Hide mixer integration elements via JavaScript
    hideMixerIntegrationElements();

    console.log('AppConfigUI: DOM elements cached.');
}

// ALPHA BUILD: Function to hide mixer integration elements
function hideMixerIntegrationElements() {
    console.log('AppConfigUI: Hiding mixer integration elements for alpha build...');
    
    // Hide mixer integration elements and their parent containers
    const elementsToHide = [
        'configMixerIntegrationEnabled',
        'mixerTypeGroup', 
        'wingIpAddressGroup',
        'configMixerType',
        'configWingIpAddress'
    ];
    
    elementsToHide.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.style.display = 'none';
            console.log(`AppConfigUI: Hidden element with ID: ${id}`);
            
            // Also hide parent form-group if it exists
            const parentFormGroup = element.closest('.form-group');
            if (parentFormGroup) {
                parentFormGroup.style.display = 'none';
                console.log(`AppConfigUI: Hidden parent form-group for: ${id}`);
            }
            
            // Hide checkbox label if it exists
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) {
                label.style.display = 'none';
                console.log(`AppConfigUI: Hidden label for: ${id}`);
            }
        }
    });
    
    // Hide the "Mixer Integration" heading
    const headings = document.querySelectorAll('#configSidebar h3');
    headings.forEach(heading => {
        if (heading.textContent && heading.textContent.includes('Mixer Integration')) {
            heading.style.display = 'none';
            console.log('AppConfigUI: Hidden "Mixer Integration" heading');
            
            // Hide the HR element before it
            const prevHr = heading.previousElementSibling;
            if (prevHr && prevHr.tagName === 'HR') {
                prevHr.style.display = 'none';
                console.log('AppConfigUI: Hidden HR before mixer heading');
            }
        }
    });
    
    console.log('AppConfigUI: Mixer integration elements hidden for alpha build');
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
        configDefaultStopAllBehaviorSelect.addEventListener('change', () => {
            handleStopAllBehaviorChange();
            handleAppConfigChange();
        });
    }
    if (configDefaultStopAllFadeOutInput) {
        configDefaultStopAllFadeOutInput.addEventListener('change', handleAppConfigChange);
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
    
    // HTTP Remote Control event listeners
    if (configHttpRemoteEnabledCheckbox) {
        configHttpRemoteEnabledCheckbox.addEventListener('change', () => {
            handleHttpRemoteEnabledChange();
            handleAppConfigChange(); 
        });
    }
    if (configHttpRemotePortInput) configHttpRemotePortInput.addEventListener('change', handleAppConfigChange);
    if (configHttpRemotePortInput) configHttpRemotePortInput.addEventListener('blur', handleAppConfigChange);
    
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
        if (configDefaultStopAllFadeOutInput) configDefaultStopAllFadeOutInput.value = currentAppConfig.defaultStopAllFadeOutTime || 1500;
        
        // OSC Settings
        if (configOscEnabledCheckbox) configOscEnabledCheckbox.checked = currentAppConfig.oscEnabled || false;
        if (configOscPortInput) configOscPortInput.value = currentAppConfig.oscPort || 54321;
        
        // HTTP Remote Control Settings
        if (configHttpRemoteEnabledCheckbox) configHttpRemoteEnabledCheckbox.checked = currentAppConfig.httpRemoteEnabled !== false; // Default to true
        if (configHttpRemotePortInput) configHttpRemotePortInput.value = currentAppConfig.httpRemotePort || 3000;
        
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
        // Set IP address for any Wing mixer type
        if (currentAppConfig.mixerType === 'behringer_wing_compact' || currentAppConfig.mixerType === 'behringer_wing_full') {
            if (configWingIpAddressInput) {
                configWingIpAddressInput.value = currentAppConfig.wingIpAddress || '';
            }
        } else {
            if (configWingIpAddressInput) {
                configWingIpAddressInput.value = '';
            }
        }
        
        handleOscEnabledChange(); 
        handleHttpRemoteEnabledChange();
        handleMixerIntegrationEnabledChange(); 
        handleMixerTypeChange();
        handleStopAllBehaviorChange();



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

function handleHttpRemoteEnabledChange() {
    const isEnabled = configHttpRemoteEnabledCheckbox && configHttpRemoteEnabledCheckbox.checked;
    if (configHttpRemotePortGroup) {
        configHttpRemotePortGroup.style.display = isEnabled ? 'block' : 'none';
    }
    if (configHttpRemoteLinksGroup) {
        configHttpRemoteLinksGroup.style.display = isEnabled ? 'block' : 'none';
    }
    
    // Load remote info when enabled
    if (isEnabled) {
        loadHttpRemoteInfo();
    }
}

async function loadHttpRemoteInfo() {
    if (!ipcRendererBindingsModule || !configHttpRemoteLinksDiv) return;
    
    try {
        const remoteInfo = await ipcRendererBindingsModule.getHttpRemoteInfo();
        console.log('AppConfigUI: Received HTTP remote info:', remoteInfo);
        
        if (!remoteInfo.enabled) {
            configHttpRemoteLinksDiv.innerHTML = '<p class="small-text">HTTP remote is disabled.</p>';
            return;
        }
        
        if (!remoteInfo.interfaces || remoteInfo.interfaces.length === 0) {
            configHttpRemoteLinksDiv.innerHTML = '<p class="small-text">No network interfaces found.</p>';
            return;
        }
        
        let linksHTML = '';
        remoteInfo.interfaces.forEach(iface => {
            linksHTML += `
                <div class="remote-link-item">
                    <div class="remote-link-info">
                        <div class="remote-link-interface">${iface.interface}</div>
                        <div class="remote-link-url">${iface.url}</div>
                    </div>
                    <button class="remote-link-copy" onclick="copyToClipboard('${iface.url}', this)">Copy</button>
                </div>
            `;
        });
        
        configHttpRemoteLinksDiv.innerHTML = linksHTML;
    } catch (error) {
        console.error('AppConfigUI: Error loading HTTP remote info:', error);
        configHttpRemoteLinksDiv.innerHTML = '<p class="small-text">Error loading remote info.</p>';
    }
}

// Global function for copy to clipboard
window.copyToClipboard = async function(text, button) {
    try {
        await navigator.clipboard.writeText(text);
        const originalText = button.textContent;
        button.textContent = 'Copied!';
        button.classList.add('copied');
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        button.textContent = 'Failed';
        setTimeout(() => {
            button.textContent = 'Copy';
        }, 2000);
    }
};

function handleMixerIntegrationEnabledChange() {
    const isEnabled = configMixerIntegrationEnabledCheckbox ? configMixerIntegrationEnabledCheckbox.checked : false;
    console.log(`AppConfigUI: handleMixerIntegrationEnabledChange - Checkbox is checked: ${isEnabled}. Element:`, configMixerIntegrationEnabledCheckbox);
    
    if (configMixerTypeGroup) {
        configMixerTypeGroup.style.display = isEnabled ? 'block' : 'none';
    }
    
    // Always hide all mixer-specific input fields when integration is disabled
    if (!isEnabled) {
        if (configWingIpAddressGroup) configWingIpAddressGroup.style.display = 'none';
    } else {
        handleMixerTypeChange();
    }
    
    console.log('AppConfigUI: Mixer Integration Enabled changed.');
}

function handleMixerTypeChange() {
    const selectedMixer = configMixerTypeSelect ? configMixerTypeSelect.value : 'none';
    console.log('AppConfigUI (handleMixerTypeChange): Selected mixer type:', selectedMixer);

    const isWingFamily = selectedMixer === 'behringer_wing_compact' || selectedMixer === 'behringer_wing_full';

    if (configWingIpAddressGroup) {
        configWingIpAddressGroup.style.display = isWingFamily ? 'block' : 'none';
    }
}

function handleStopAllBehaviorChange() {
    const behavior = configDefaultStopAllBehaviorSelect ? configDefaultStopAllBehaviorSelect.value : 'stop';
    const showFadeOutTime = behavior === 'fade_out_and_stop';
    
    if (configDefaultStopAllFadeOutGroup) {
        configDefaultStopAllFadeOutGroup.style.display = showFadeOutTime ? 'block' : 'none';
    }
    
    console.log('AppConfigUI: Stop All behavior changed to:', behavior, 'Show fade out time:', showFadeOutTime);
}


async function loadAudioOutputDevices() {
    if (!configAudioOutputDeviceSelect) {
        console.warn('AppConfigUI: configAudioOutputDeviceSelect element not found.');
        return;
    }

    try {
        console.log('AppConfigUI: Loading audio output devices using Web Audio API...');
        
        // Clear existing options
        configAudioOutputDeviceSelect.innerHTML = '';

        // Add default option first
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'System Default';
        configAudioOutputDeviceSelect.appendChild(defaultOption);

        // Check if navigator.mediaDevices is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            console.warn('AppConfigUI: navigator.mediaDevices.enumerateDevices not available. Using default only.');
            return;
        }

        // Enumerate devices without requesting permissions
        const devices = await navigator.mediaDevices.enumerateDevices();
        console.log('AppConfigUI: Enumerated devices:', devices);

        // Filter for audio output devices
        const audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
        console.log('AppConfigUI: Found audio output devices:', audioOutputDevices);

        // Add each audio output device to the select
        audioOutputDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            
            // Use device label if available, otherwise create a generic label
            if (device.label) {
                option.textContent = device.label;
            } else {
                // If no label (due to permissions), create a generic name
                option.textContent = `Audio Output Device ${index + 1}`;
            }
            
            configAudioOutputDeviceSelect.appendChild(option);
        });

        // Set the selected value based on current config
        if (currentAppConfig && currentAppConfig.audioOutputDeviceId) {
            const optionExists = Array.from(configAudioOutputDeviceSelect.options).some(
                option => option.value === currentAppConfig.audioOutputDeviceId
            );
            if (optionExists) {
                configAudioOutputDeviceSelect.value = currentAppConfig.audioOutputDeviceId;
            } else {
                console.warn('AppConfigUI: Configured audio device not found, falling back to default');
                configAudioOutputDeviceSelect.value = 'default';
            }
        } else {
            configAudioOutputDeviceSelect.value = 'default';
        }

        console.log('AppConfigUI: Audio output devices loaded. Selected:', configAudioOutputDeviceSelect.value);
        console.log('AppConfigUI: Available options:', Array.from(configAudioOutputDeviceSelect.options).map(opt => ({ value: opt.value, text: opt.textContent })));

    } catch (error) {
        console.error('AppConfigUI: Error loading audio output devices:', error);
        
        // Clear and add error option
        configAudioOutputDeviceSelect.innerHTML = '';
        const errorOption = document.createElement('option');
        errorOption.value = 'default';
        errorOption.textContent = 'System Default (Error loading devices)';
        configAudioOutputDeviceSelect.appendChild(errorOption);
        configAudioOutputDeviceSelect.value = 'default';
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
        defaultStopAllFadeOutTime: configDefaultStopAllFadeOutInput ? parseInt(configDefaultStopAllFadeOutInput.value) : 1500,

        oscEnabled: configOscEnabledCheckbox ? configOscEnabledCheckbox.checked : false,
        oscPort: configOscPortInput ? parseInt(configOscPortInput.value) : 54321,
        
        httpRemoteEnabled: configHttpRemoteEnabledCheckbox ? configHttpRemoteEnabledCheckbox.checked : true,
        httpRemotePort: configHttpRemotePortInput ? parseInt(configHttpRemotePortInput.value) : 3000,
        
        audioOutputDeviceId: configAudioOutputDeviceSelect ? configAudioOutputDeviceSelect.value : 'default',

        mixerIntegrationEnabled: mixerEnabled,
        // mixerType: mixerType, // mixerType will be set based on logic below
        
        // theme setting is not directly edited here, but preserved if it exists
        theme: currentAppConfig.theme || 'system',
    };
    
    // Logic for setting mixerType and relevant IP addresses
    if (mixerEnabled) {
        config.mixerType = mixerType; // Set the selected mixer type

        if (mixerType === 'behringer_wing_compact' || mixerType === 'behringer_wing_full') {
            config.wingIpAddress = configWingIpAddressInput ? configWingIpAddressInput.value.trim() : '';
        } else {
            config.wingIpAddress = ''; // Clear if not a WING type
        }
    } else { // Mixer integration disabled
        config.mixerType = 'none';
        config.wingIpAddress = '';
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
            
            // Apply audio output device change if audioControllerRef is available
            if (audioControllerRef && configToSave.audioOutputDeviceId !== currentAppConfig.audioOutputDeviceId) {
                console.log('AppConfigUI: Audio output device changed from', currentAppConfig.audioOutputDeviceId, 'to', configToSave.audioOutputDeviceId);
                console.log('AppConfigUI: Applying audio output device change to audio system...');
                try {
                    await audioControllerRef.setAudioOutputDevice(configToSave.audioOutputDeviceId);
                    console.log('AppConfigUI: Audio output device successfully changed.');
                    
                    // Get device name for user feedback
                    const deviceSelect = document.getElementById('configAudioOutputDevice');
                    const selectedOption = deviceSelect ? deviceSelect.options[deviceSelect.selectedIndex] : null;
                    const deviceName = selectedOption ? selectedOption.textContent : 'Selected Device';
                    
                    // Show success feedback (you can replace this with a proper notification system)
                    console.info(`✅ Audio output switched to: ${deviceName}`);
                    
                } catch (error) {
                    console.error('AppConfigUI: Error changing audio output device:', error);
                    
                    // Show error feedback to user
                    console.error(`❌ Failed to switch audio output: ${error.message}`);
                    
                    // Optionally, you could show a toast notification or alert here
                    // For now, we'll just log it prominently
                    
                    // Revert the UI selection to the previous device
                    if (configAudioOutputDeviceSelect) {
                        configAudioOutputDeviceSelect.value = currentAppConfig.audioOutputDeviceId || 'default';
                        console.log('AppConfigUI: Reverted device selection to previous value');
                    }
                }
            }
            
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
    setUiApi,
    setAudioControllerRef
}; 