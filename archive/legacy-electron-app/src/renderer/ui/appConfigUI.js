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
let configCrossfadeTimeInput;

// OSC Settings removed

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
// Mixer Integration removed



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
    configCrossfadeTimeInput = document.getElementById('crossfadeTime');
    
    // OSC UI removed

    // Audio Settings
    configAudioOutputDeviceSelect = document.getElementById('configAudioOutputDevice');

    // HTTP Remote Control Elements
    configHttpRemoteEnabledCheckbox = document.getElementById('configHttpRemoteEnabled');
    configHttpRemotePortGroup = document.getElementById('httpRemotePortGroup');
    configHttpRemotePortInput = document.getElementById('configHttpRemotePort');
    configHttpRemoteLinksGroup = document.getElementById('httpRemoteLinksGroup');
    configHttpRemoteLinksDiv = document.getElementById('httpRemoteLinksDiv');

    // Mixer Integration removed

    console.log('AppConfigUI: DOM elements cached.');
}

// Mixer integration elements removed

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
    
    // Generic OSC UI removed

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
    
    // Mixer event listeners removed

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
        if (configCrossfadeTimeInput) configCrossfadeTimeInput.value = currentAppConfig.crossfadeTime || 2000;
        
        // OSC Settings not shown in UI
        
        // HTTP Remote Control Settings
        if (configHttpRemoteEnabledCheckbox) configHttpRemoteEnabledCheckbox.checked = currentAppConfig.httpRemoteEnabled !== false; // Default to true
        if (configHttpRemotePortInput) configHttpRemotePortInput.value = currentAppConfig.httpRemotePort || 3000;
        
        if (configAudioOutputDeviceSelect && currentAppConfig.audioOutputDeviceId) {
            configAudioOutputDeviceSelect.value = currentAppConfig.audioOutputDeviceId;
        } else if (configAudioOutputDeviceSelect) {
            configAudioOutputDeviceSelect.value = 'default';
        }

        // Mixer config population removed
        
        handleHttpRemoteEnabledChange();
        handleStopAllBehaviorChange();



        console.log('AppConfigUI: Sidebar populated (end of try block).');
    } finally {
        isPopulatingSidebar = false; 
    }
    console.log('AppConfigUI: DOM elements updated.');
}

// Generic OSC handling removed

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
                    <button class="remote-link-copy" data-url="${iface.url}">Copy</button>
                </div>
            `;
        });
        
        configHttpRemoteLinksDiv.innerHTML = linksHTML;
        
        // Add event listeners to all copy buttons (event delegation)
        configHttpRemoteLinksDiv.querySelectorAll('.remote-link-copy').forEach(button => {
            button.addEventListener('click', function() {
                const url = this.getAttribute('data-url');
                if (url) {
                    window.copyToClipboard(url, this);
                }
            });
        });
    } catch (error) {
        console.error('AppConfigUI: Error loading HTTP remote info:', error);
        configHttpRemoteLinksDiv.innerHTML = '<p class="small-text">Error loading remote info.</p>';
    }
}

// Global function for copy to clipboard
window.copyToClipboard = async function(text, button) {
    const setBtn = (label, clsAdd, clsRemove) => {
        if (!button) return;
        const original = button.getAttribute('data-original-label') || button.textContent;
        if (!button.getAttribute('data-original-label')) button.setAttribute('data-original-label', original);
        button.textContent = label;
        if (clsAdd) button.classList.add(clsAdd);
        if (clsRemove) button.classList.remove(clsRemove);
        setTimeout(() => {
            button.textContent = original;
            if (clsAdd) button.classList.remove(clsAdd);
        }, 2000);
    };
    
    // Use Electron's clipboard API (most reliable for Electron apps)
    try {
        if (window.electronAPI && typeof window.electronAPI.writeToClipboard === 'function') {
            const result = await window.electronAPI.writeToClipboard(text);
            if (result && result.success) {
                setBtn('Copied!', 'copied');
                return;
            } else {
                console.error('Electron clipboard API failed:', result?.error);
            }
        }
    } catch (error) {
        console.error('Error using Electron clipboard API:', error);
    }
    
    // Fallback: Try browser clipboard API
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            setBtn('Copied!', 'copied');
            return;
        }
    } catch (error) {
        console.warn('Browser clipboard API failed, trying execCommand fallback:', error);
    }

    // Last resort: use textarea + execCommand
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        
        if (ok) {
            setBtn('Copied!', 'copied');
        } else {
            setBtn('Failed');
            console.error('All clipboard methods failed');
        }
    } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        setBtn('Failed');
    }
};

// Mixer handlers removed

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
        console.log('AppConfigUI: Loading audio output devices...');
        
        // Clear existing options
        configAudioOutputDeviceSelect.innerHTML = '';

        // Add default option first
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'System Default';
        configAudioOutputDeviceSelect.appendChild(defaultOption);

        // Try to enumerate audio devices
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                console.log('AppConfigUI: Enumerated devices:', devices);
                
                // Filter to only audio output devices
                const audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
                console.log('AppConfigUI: Audio output devices found:', audioOutputDevices.length);
                
                audioOutputDevices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.textContent = device.label || `Audio Output Device ${device.deviceId.substring(0, 8)}...`;
                    configAudioOutputDeviceSelect.appendChild(option);
                });
                
                if (audioOutputDevices.length > 0) {
                    console.log('AppConfigUI: Added', audioOutputDevices.length, 'audio output devices to selection');
                } else {
                    console.log('AppConfigUI: No additional audio output devices found, using system default only');
                }
            } catch (deviceError) {
                console.warn('AppConfigUI: Error enumerating devices:', deviceError);
                console.log('AppConfigUI: Falling back to system default only');
                
                // Add a user-friendly message option
                const fallbackOption = document.createElement('option');
                fallbackOption.value = 'default';
                fallbackOption.textContent = 'System Default (Device list unavailable)';
                configAudioOutputDeviceSelect.appendChild(fallbackOption);
            }
        } else {
            console.warn('AppConfigUI: navigator.mediaDevices.enumerateDevices not available');
        }

        // Set the selected value based on current config
        if (currentAppConfig && currentAppConfig.audioOutputDeviceId) {
            configAudioOutputDeviceSelect.value = currentAppConfig.audioOutputDeviceId;
        } else {
            configAudioOutputDeviceSelect.value = 'default';
        }

        console.log('AppConfigUI: Audio output device selection completed. Selected:', configAudioOutputDeviceSelect.value);

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
        crossfadeTime: configCrossfadeTimeInput ? parseInt(configCrossfadeTimeInput.value) : 2000,

        // Generic OSC removed from saved config
        
        httpRemoteEnabled: configHttpRemoteEnabledCheckbox ? configHttpRemoteEnabledCheckbox.checked : true,
        httpRemotePort: configHttpRemotePortInput ? parseInt(configHttpRemotePortInput.value) : 3000,
        
        audioOutputDeviceId: configAudioOutputDeviceSelect ? configAudioOutputDeviceSelect.value : 'default',
        
        // theme setting is not directly edited here, but preserved if it exists
        theme: currentAppConfig.theme || 'system',
    };
    
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
                    
                    // Show user-friendly error notification
                    const errorMsg = `Failed to switch audio output device. ${error.message || 'Unknown error occurred.'}`;
                    
                    // Try to show a more visible error notification
                    if (typeof window !== 'undefined' && window.alert) {
                        // Simple alert as fallback - in a real app you'd want a better notification system
                        console.error('Audio device change failed:', errorMsg);
                        // Note: Using console.error instead of alert to avoid blocking the UI
                    }
                    
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