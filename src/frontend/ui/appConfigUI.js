// Companion_soundboard/src/renderer/ui/appConfigUI.js
// Manages the App Configuration Sidebar UI, state, and interactions.
// Adapted from Electron version to work in browser environment.

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
let configDuckingFadeTimeInput;

// OSC Settings removed

// Audio Settings
let configAudioOutputDeviceSelect;
let configAudioOutputChannelCountSelect;
let serverOutputDevices = [];
let devicesLoaded = false;

// UI Settings
// let configShowQuickControlsCheckbox; // REMOVED

// HTTP Remote Control Elements
let configHttpRemotePortGroup;
let configHttpRemotePortInput;
let configHttpRemoteLinksGroup;
let configHttpRemoteLinksDiv;

// Mixer Integration Elements
// Mixer Integration removed

// --- App Configuration State (local cache) ---
let currentAppConfig = {};
let isPopulatingSidebar = false;
let isLoadingDevices = false;
// What the sidebar showed after it was last populated or saved. A save sends
// only the fields that differ from it - the ones the user changed - so a
// value the form can't represent (a device that isn't connected, a channel
// count below the list's minimum) is never overwritten by an unrelated
// save (WO-001).
let savedUiConfig = null;
let configUIInitialized = false;
let websocketBindingsModule = null; // Changed from ipcRendererBindingsModule

async function init(websocketAPI) { // Changed parameter from electronAPI to websocketAPI
    if (configUIInitialized) {
        console.log('AppConfigUI: Already initialized, skipping duplicate init.');
        return currentAppConfig;
    }

    console.log('AppConfigUI: Initializing...');
    websocketBindingsModule = websocketAPI; // Changed from ipcRendererBindingsModule
    cacheDOMElements();
    bindEventListeners();

    // Set up device change listener
    setupDeviceChangeListener();

    try {
        await forceLoadAndApplyAppConfiguration();
        configUIInitialized = true;
        console.log('AppConfigUI: Initial config loaded and populated after init. Returning config.');
        return currentAppConfig; // Return the loaded config
    } catch (error) {
        console.error('AppConfigUI: Error during initial config load in init:', error);
        configUIInitialized = true;
        return { ...currentAppConfig };
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
    configDuckingFadeTimeInput = document.getElementById('duckingFadeTime');
    
    // OSC UI removed

    // Audio Settings
    configAudioOutputDeviceSelect = document.getElementById('configAudioOutputDevice');
    configAudioOutputChannelCountSelect = document.getElementById('configAudioOutputChannelCount');

    // HTTP Remote Control Elements
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
    // Crossfade time used to have no listener at all - edits were never saved.
    if (configCrossfadeTimeInput) configCrossfadeTimeInput.addEventListener('change', handleAppConfigChange);
    if (configDuckingFadeTimeInput) configDuckingFadeTimeInput.addEventListener('change', handleAppConfigChange);
    
    // Generic OSC UI removed

    if (configAudioOutputDeviceSelect) {
        configAudioOutputDeviceSelect.addEventListener('change', () => {
            updateOutputChannelCountOptions();
            handleAppConfigChange();
        });
    }
    if (configAudioOutputChannelCountSelect) {
        configAudioOutputChannelCountSelect.addEventListener('change', handleAppConfigChange);
    }
    
    // HTTP Remote Control (always available - only its port is a setting)
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
    if (isPopulatingSidebar || isLoadingDevices) {
        console.log('AppConfigUI: App config field change suppressed during population/device load.');
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
        if (configDefaultStopAllFadeOutInput) configDefaultStopAllFadeOutInput.value = currentAppConfig.defaultStopAllFadeOutTime ?? 1500;
        if (configCrossfadeTimeInput) configCrossfadeTimeInput.value = currentAppConfig.crossfadeTime || 2000;
        if (configDuckingFadeTimeInput) configDuckingFadeTimeInput.value = currentAppConfig.duckingFadeTime ?? 1000;
        
        // OSC Settings not shown in UI
        
        // HTTP Remote Control Settings
        if (configHttpRemotePortInput) configHttpRemotePortInput.value = currentAppConfig.httpRemotePort || 3333;
        
        selectConfiguredDevice();
        updateOutputChannelCountOptions();
        if (configAudioOutputChannelCountSelect && currentAppConfig.audioOutputChannelCount) {
            configAudioOutputChannelCountSelect.value = String(currentAppConfig.audioOutputChannelCount);
        }

        // Mixer config population removed
        
        loadHttpRemoteInfo();
        handleStopAllBehaviorChange();
        savedUiConfig = gatherConfigFromUI();

        console.log('AppConfigUI: Sidebar populated (end of try block).');
    } finally {
        isPopulatingSidebar = false; 
    }
    console.log('AppConfigUI: DOM elements updated.');
}

// Generic OSC handling removed

async function loadHttpRemoteInfo() {
    if (!websocketBindingsModule || !configHttpRemoteLinksDiv) return;
    
    try {
        const remoteInfo = await websocketBindingsModule.invoke('get-http-remote-info');
        console.log('AppConfigUI: Received HTTP remote info:', remoteInfo);
        
        
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
    
    // In browser, use browser clipboard API (Electron API not available)
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

    isLoadingDevices = true;
    try {
        console.log('AppConfigUI: Loading server audio output devices...');
        configAudioOutputDeviceSelect.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'System Default';
        configAudioOutputDeviceSelect.appendChild(defaultOption);

        const response = await fetch('/api/audio/output-devices');
        const data = await response.json();
        serverOutputDevices = data.success ? (data.devices || []) : [];

        serverOutputDevices.forEach((device) => {
            const option = document.createElement('option');
            // By name: the server resolves names, and they stay the same
            // across reboots and re-plugging, which device ids don't.
            option.value = device.name;
            option.textContent = `${device.name} (${device.outputChannels} ch)`;
            option.dataset.outputChannels = String(device.outputChannels);
            if (device.isDefaultOutput) {
                option.dataset.defaultOutput = 'true';
            }
            configAudioOutputDeviceSelect.appendChild(option);
        });

        devicesLoaded = true;
        selectConfiguredDevice();
        updateOutputChannelCountOptions();
        if (configAudioOutputChannelCountSelect && currentAppConfig?.audioOutputChannelCount) {
            configAudioOutputChannelCountSelect.value = String(currentAppConfig.audioOutputChannelCount);
        }
        savedUiConfig = gatherConfigFromUI();
        console.log('AppConfigUI: Server audio devices loaded:', serverOutputDevices.length);
    } catch (error) {
        console.error('AppConfigUI: Error loading server audio output devices:', error);
        configAudioOutputDeviceSelect.innerHTML = '';
        const errorOption = document.createElement('option');
        errorOption.value = 'default';
        errorOption.textContent = 'System Default (server unavailable)';
        configAudioOutputDeviceSelect.appendChild(errorOption);
        updateOutputChannelCountOptions();
    } finally {
        isLoadingDevices = false;
    }
}

// Selects the configured output device in the dropdown. It may be stored
// by name (current), by numeric id (older configs) or not be connected right
// now; whichever, the dropdown must show it - not silently show nothing and
// then save '' (the system default) along with the next unrelated change.
function selectConfiguredDevice() {
    if (!configAudioOutputDeviceSelect) return;
    configAudioOutputDeviceSelect.querySelectorAll('option[data-configured-missing]').forEach((o) => o.remove());

    const configured = currentAppConfig?.audioOutputDeviceId;
    if (configured === undefined || configured === null || configured === '' || configured === 'default') {
        configAudioOutputDeviceSelect.value = 'default';
        return;
    }
    const value = String(configured);
    const device = serverOutputDevices.find((d) => d.name === value)
        || serverOutputDevices.find((d) => String(d.id) === value);
    if (device) {
        // An old id-style config shows as the device's name; it's only
        // rewritten if the user picks a device (savedUiConfig is taken from
        // what is shown).
        configAudioOutputDeviceSelect.value = device.name;
        return;
    }
    const option = document.createElement('option');
    option.value = value;
    option.textContent = devicesLoaded ? `${value} (not connected)` : value;
    option.dataset.configuredMissing = 'true';
    configAudioOutputDeviceSelect.appendChild(option);
    configAudioOutputDeviceSelect.value = value;
}

function getSelectedServerDevice() {
    if (!configAudioOutputDeviceSelect) {
        return null;
    }

    const selectedValue = configAudioOutputDeviceSelect.value;
    if (selectedValue === 'default') {
        return serverOutputDevices.find((device) => device.isDefaultOutput)
            || serverOutputDevices[0]
            || null;
    }

    return serverOutputDevices.find((device) => device.name === selectedValue)
        || serverOutputDevices.find((device) => String(device.id) === selectedValue)
        || null;
}

function updateOutputChannelCountOptions() {
    if (!configAudioOutputChannelCountSelect) {
        return;
    }

    const device = getSelectedServerDevice();
    const maxChannels = Math.max(2, device?.outputChannels || 2);
    const previous = Number(currentAppConfig?.audioOutputChannelCount)
        || Number(configAudioOutputChannelCountSelect.value)
        || 2;

    configAudioOutputChannelCountSelect.innerHTML = '';
    for (let count = 2; count <= maxChannels; count += 1) {
        const option = document.createElement('option');
        option.value = String(count);
        option.textContent = `${count} channels`;
        configAudioOutputChannelCountSelect.appendChild(option);
    }

    const clamped = Math.min(Math.max(previous, 2), maxChannels);
    configAudioOutputChannelCountSelect.value = String(clamped);
}

let uiAPI = {}; 

function setUiApi(api) {
    uiAPI = api;
}
 
// Reads a number input; an empty or non-numeric field keeps the current
// value instead of saving NaN.
function numberFrom(input, fallback) {
    if (!input) return fallback;
    const n = parseInt(input.value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function gatherConfigFromUI() {
    const config = {
        cuesFilePath: configCuesFilePathInput ? configCuesFilePathInput.value : '',
        autoLoadLastWorkspace: configAutoLoadLastWorkspaceCheckbox ? configAutoLoadLastWorkspaceCheckbox.checked : true,
        lastOpenedWorkspacePath: currentAppConfig.lastOpenedWorkspacePath || '', // Preserve this from loaded config, not UI
        recentWorkspaces: currentAppConfig.recentWorkspaces || [], // Preserve this from loaded config

        defaultCueType: configDefaultCueTypeSelect ? configDefaultCueTypeSelect.value : 'single_file',
        defaultFadeInTime: numberFrom(configDefaultFadeInInput, currentAppConfig.defaultFadeInTime ?? 0),
        defaultFadeOutTime: numberFrom(configDefaultFadeOutInput, currentAppConfig.defaultFadeOutTime ?? 0),
        defaultLoopSingleCue: configDefaultLoopSingleCueCheckbox ? configDefaultLoopSingleCueCheckbox.checked : false,
        defaultRetriggerBehavior: configDefaultRetriggerBehaviorSelect ? configDefaultRetriggerBehaviorSelect.value : 'restart',
        defaultStopAllBehavior: configDefaultStopAllBehaviorSelect ? configDefaultStopAllBehaviorSelect.value : 'stop',
        defaultStopAllFadeOutTime: numberFrom(configDefaultStopAllFadeOutInput, currentAppConfig.defaultStopAllFadeOutTime ?? 1500),
        crossfadeTime: numberFrom(configCrossfadeTimeInput, currentAppConfig.crossfadeTime ?? 2000),
        duckingFadeTime: numberFrom(configDuckingFadeTimeInput, currentAppConfig.duckingFadeTime ?? 1000),

        // Generic OSC removed from saved config
        
        httpRemotePort: numberFrom(configHttpRemotePortInput, currentAppConfig.httpRemotePort ?? 3333),
        
        audioOutputDeviceId: configAudioOutputDeviceSelect ? configAudioOutputDeviceSelect.value : 'default',
        audioOutputChannelCount: configAudioOutputChannelCountSelect
            ? parseInt(configAudioOutputChannelCountSelect.value, 10) || 2
            : (currentAppConfig.audioOutputChannelCount || 2),
        
        // theme setting is not directly edited here, but preserved if it exists
        theme: currentAppConfig.theme || 'system',
    };
    
    console.log('AppConfigUI (gatherConfigFromUI): Gathered config:', JSON.parse(JSON.stringify(config)));
    return config;
}

async function saveAppConfiguration() {
    console.log('AppConfigUI (DEBUG): saveAppConfiguration CALLED.');
    try {
        const gathered = gatherConfigFromUI();
        if (!gathered) {
            console.error('AppConfigUI: No config data gathered from UI. Aborting save.');
            return;
        }
        // Only what the user changed (see savedUiConfig).
        const configToSave = {};
        for (const [key, value] of Object.entries(gathered)) {
            if (!savedUiConfig || JSON.stringify(value) !== JSON.stringify(savedUiConfig[key])) {
                configToSave[key] = value;
            }
        }
        if (Object.keys(configToSave).length === 0) {
            console.log('AppConfigUI: Nothing changed - not saving.');
            return;
        }
        console.log('AppConfigUI (DEBUG): saving changed fields:', JSON.stringify(configToSave));

        console.log('AppConfigUI (DEBUG): Attempting to call websocketBindingsModule.invoke("save-app-config")...');
        const result = await websocketBindingsModule.invoke('save-app-config', configToSave);
        console.log('AppConfigUI (DEBUG): websocketBindingsModule.invoke("save-app-config") call completed, result:', result);

        if (result && result.success) {
            console.log('AppConfigUI: App configuration successfully saved via server.');
            currentAppConfig = { ...currentAppConfig, ...configToSave };
            savedUiConfig = gathered;
        } else {
            console.error('AppConfigUI: Failed to save app configuration via server:', result ? result.error : 'Unknown error');
        }
    } catch (error) {
        console.error('AppConfigUI: Error during saveAppConfiguration:', error);
    }
}

async function forceLoadAndApplyAppConfiguration() {
    console.log('AppConfigUI: Forcing load and apply of app configuration...');
    if (!websocketBindingsModule) {
        console.error('AppConfigUI: websocketBindingsModule not available. Cannot force load config.');
        return Promise.reject('websocketBindingsModule not available');
    }
    try {
        const loadedConfig = await websocketBindingsModule.invoke('get-app-config');
        console.log('AppConfigUI: Successfully loaded config from server:', loadedConfig);
        populateConfigSidebar(loadedConfig);
        await loadAudioOutputDevices();
        return loadedConfig; 
    } catch (error) {
        console.error('AppConfigUI: Error loading app configuration from server:', error);
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
