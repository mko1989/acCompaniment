import * as waveformControls from './waveformControls.js';
import { formatWaveformTime } from './waveformControls.js'; // Assuming this is also used here or in waveformControls
import { debounce } from './utils.js';

let cueStore;
let audioController;
let ipcRendererBindingsModule;
let uiCore; // For isEditMode, getCurrentAppConfig

// --- DOM Elements for Properties Sidebar ---
let propertiesSidebar;
let closePropertiesSidebarBtn;
let propCueIdInput, propCueNameInput, propCueTypeSelect, propSingleFileConfigDiv,
    propFilePathInput, propPlaylistConfigDiv, propPlaylistItemsUl,
    propPlaylistFilePathDisplay, propFadeInTimeInput, propFadeOutTimeInput,
    propLoopCheckbox, propTrimStartTimeInput, propTrimEndTimeInput, propTrimConfig,
    propVolumeRangeInput, propVolumeValueSpan, saveCuePropertiesButton, deleteCuePropertiesButton;
let propShufflePlaylistCheckbox, propRepeatOnePlaylistItemCheckbox, propRetriggerBehaviorSelect;
let propPlaylistPlayModeSelect;
let propVolumeSlider, propVolumeValueDisplay;
let propEnableDuckingCheckbox, propDuckingLevelInput, propDuckingLevelValueSpan, propIsDuckingTriggerCheckbox;
let propWingTriggerEnabled;
let wingTriggerSettingsContainer;
let wingFullSizeConfigDiv, propWingFullLayer, propWingFullButton, propWingFullRow;
let wingCompactConfigDiv, propWingCompactLayer, propWingCompactButton;
let wingUserButtonSubGroupLegacy, propWingUserButtonLegacy;

// --- State for Properties Sidebar ---
let activePropertiesCueId = null;
let stagedPlaylistItems = [];
// let draggedPlaylistItemIndex = null; // Not used in the current version
// let currentEditCueId = null; // Replaced by activePropertiesCueId
let currentWaveformTrimStart = 0;
let currentWaveformTrimEnd = 0;
let debouncedSaveCueProperties;

// --- Helper Functions (Specific to Properties or shared & simple enough to keep) ---
function getEffectiveWingType(appConfig) {
    console.log('[PropertiesSidebar getEffectiveWingType] appConfig received:', JSON.parse(JSON.stringify(appConfig || {})));
    if (!appConfig || !appConfig.mixerIntegrationEnabled) {
        console.log('[PropertiesSidebar getEffectiveWingType] Mixer integration not enabled or no appConfig. Returning null.');
        return null;
    }
    const globalMixerType = appConfig.mixerType;
    const wingModel = appConfig.wingModelType;
    console.log(`[PropertiesSidebar getEffectiveWingType] globalMixerType: ${globalMixerType}, wingModel: ${wingModel}`);

    if (globalMixerType === 'behringer_wing_compact') {
        console.log('[PropertiesSidebar getEffectiveWingType] Detected behringer_wing_compact directly.');
        return 'behringer_wing_compact';
    }
    // This was an early exit that might be problematic. Let the next block handle generic 'behringer_wing'.
    // if (globalMixerType === 'behringer_wing_full') return 'behringer_wing_full'; 

    if (globalMixerType === 'behringer_wing') {
        if (wingModel === 'compact') {
            console.log('[PropertiesSidebar getEffectiveWingType] Detected behringer_wing with model compact.');
            return 'behringer_wing_compact';
        }
        if (wingModel === 'full') {
            console.log('[PropertiesSidebar getEffectiveWingType] Detected behringer_wing with model full.');
            return 'behringer_wing_full';
        }
        console.log('[PropertiesSidebar getEffectiveWingType] Defaulting behringer_wing to full (model was:', wingModel, ')');
        return 'behringer_wing_full'; // Default for "behringer_wing" if model is unspecified or unexpected
    }
    console.log('[PropertiesSidebar getEffectiveWingType] No specific WING type matched. Returning null. globalMixerType:', globalMixerType);
    return null;
}

function populateGenericDropdown(selectElement, start, end, prefix = '', currentValStr, placeholderText = "-- Select --") {
    if (!selectElement) return;
    const preservedValue = selectElement.value;
    selectElement.innerHTML = '';

    if (placeholderText) {
        const placeholderOption = document.createElement('option');
        placeholderOption.value = ""; // Empty value for placeholder
        placeholderOption.textContent = placeholderText;
        selectElement.appendChild(placeholderOption);
    }

    for (let i = start; i <= end; i++) {
        const option = document.createElement('option');
        const val = `${prefix}${i}`;
        option.value = val;
        option.textContent = i;
        selectElement.appendChild(option);
    }

    if (currentValStr && Array.from(selectElement.options).some(opt => opt.value === currentValStr)) {
        selectElement.value = currentValStr;
    } else if (placeholderText) {
        selectElement.value = ""; // Default to placeholder if no currentValStr or preservedValue matches
    } else if (preservedValue && Array.from(selectElement.options).some(opt => opt.value === preservedValue)) {
        selectElement.value = preservedValue;
    } else if (selectElement.options.length > 0) {
        selectElement.selectedIndex = 0; // Fallback to the first option if no other condition met
    }
}

function populateWingDropdowns(targetMixerType, currentButtonIdString = null, forcePlaceholder = false) {
    let layerVal = null, buttonVal = null, rowVal = null;
    const placeholder = "-- Select --"; // Or "None", "Not Assigned"

    if (currentButtonIdString && !forcePlaceholder) {
        const parts = currentButtonIdString.split('_');
        if (parts.length >= 1) layerVal = parts[0];
        if (parts.length >= 2) buttonVal = parts[1];
        if (parts.length === 3 && targetMixerType === 'behringer_wing_full') rowVal = parts[2];
    }

    if (targetMixerType === 'behringer_wing_compact') {
        populateGenericDropdown(propWingCompactLayer, 1, 4, 'layer', layerVal, placeholder);
        populateGenericDropdown(propWingCompactButton, 1, 4, 'button', buttonVal, placeholder);
    } else if (targetMixerType === 'behringer_wing_full') {
        populateGenericDropdown(propWingFullLayer, 1, 16, 'layer', layerVal, placeholder);
        populateGenericDropdown(propWingFullButton, 1, 4, 'button', buttonVal, placeholder);
        if (propWingFullRow) {
            const preservedRowValue = propWingFullRow.value;
            propWingFullRow.innerHTML = ''; // Clear existing options
            const rowPlaceholder = document.createElement('option');
            rowPlaceholder.value = "";
            rowPlaceholder.textContent = placeholder;
            propWingFullRow.appendChild(rowPlaceholder);

            const buOption = document.createElement('option');
            buOption.value = 'bu';
            buOption.textContent = 'Upper Row (bu)';
            propWingFullRow.appendChild(buOption);

            const bdOption = document.createElement('option');
            bdOption.value = 'bd';
            bdOption.textContent = 'Lower Row (bd)';
            propWingFullRow.appendChild(bdOption);

            if (rowVal && (rowVal === 'bu' || rowVal === 'bd') && !forcePlaceholder) {
                propWingFullRow.value = rowVal;
            } else {
                propWingFullRow.value = ""; // Default to placeholder
            }
        }
    }
}

function updateDuckingControlsVisibility(isTrigger) {
    const duckingLevelGroup = document.getElementById('duckingLevelGroup');
    const enableDuckingGroup = document.getElementById('enableDuckingGroup');
    if (isTrigger) {
        if (duckingLevelGroup) duckingLevelGroup.style.display = 'block';
        if (enableDuckingGroup) enableDuckingGroup.style.display = 'none';
    } else {
        if (duckingLevelGroup) duckingLevelGroup.style.display = 'none';
        if (enableDuckingGroup) enableDuckingGroup.style.display = 'block';
    }
}

function handleWingTriggerEnabledChange() {
    const appConfig = uiCore ? uiCore.getCurrentAppConfig() : {};
    console.log('[PropertiesSidebar handleWingTriggerEnabledChange] appConfig from uiCore:', JSON.parse(JSON.stringify(appConfig || {})));
    const wingEnabled = propWingTriggerEnabled ? propWingTriggerEnabled.checked : false;
    const effectiveWingType = getEffectiveWingType(appConfig);
    console.log(`[PropertiesSidebar handleWingTriggerEnabledChange] wingEnabled: ${wingEnabled}, effectiveWingType: ${effectiveWingType}`);

    if (wingTriggerSettingsContainer) {
        const showContainer = appConfig.mixerIntegrationEnabled && effectiveWingType;
        wingTriggerSettingsContainer.style.display = showContainer ? 'block' : 'none';
    }

    if(wingCompactConfigDiv) wingCompactConfigDiv.style.display = 'none';
    if(wingFullSizeConfigDiv) wingFullSizeConfigDiv.style.display = 'none';
    if(wingUserButtonSubGroupLegacy) wingUserButtonSubGroupLegacy.style.display = 'none';

    if (wingEnabled && appConfig.mixerIntegrationEnabled && effectiveWingType) {
        if (effectiveWingType === 'behringer_wing_compact' && wingCompactConfigDiv) {
            wingCompactConfigDiv.style.display = 'block';
            const cue = activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null;
            const shouldForcePlaceholder = !cue || !cue.wingTrigger || !cue.wingTrigger.enabled || !cue.wingTrigger.wingLayer;
            populateWingDropdowns('behringer_wing_compact', cue?.wingTrigger?.userButton, shouldForcePlaceholder);
        } else if (effectiveWingType === 'behringer_wing_full' && wingFullSizeConfigDiv) {
            wingFullSizeConfigDiv.style.display = 'block';
            const cue = activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null;
            let userButtonString = null;
            if (cue?.wingTrigger?.enabled && cue.wingTrigger.wingLayer && cue.wingTrigger.wingButton && cue.wingTrigger.wingRow) {
                 userButtonString = `${cue.wingTrigger.wingLayer}_${cue.wingTrigger.wingButton}_${cue.wingTrigger.wingRow}`;
            }
            const shouldForcePlaceholder = !userButtonString;
            populateWingDropdowns('behringer_wing_full', userButtonString, shouldForcePlaceholder);
        }
    } else {
        if (effectiveWingType === 'behringer_wing_compact') populateWingDropdowns('behringer_wing_compact', null, true);
        if (effectiveWingType === 'behringer_wing_full') populateWingDropdowns('behringer_wing_full', null, true);
    }
}

// --- Initialization ---
function initPropertiesSidebar(csModule, acModule, ipcAPI, uiCoreInterfaceRef) {
    cueStore = csModule;
    audioController = acModule;
    ipcRendererBindingsModule = ipcAPI;
    uiCore = uiCoreInterfaceRef;

    cachePropertiesSidebarDOMElements();
    // Log cached elements to verify they are found
    console.log('[PropertiesSidebarInit] Cached DOM elements after cachePropertiesSidebarDOMElements:');
    console.log('  propCueNameInput:', propCueNameInput ? 'Found' : 'NOT FOUND');
    console.log('  propWingTriggerEnabled:', propWingTriggerEnabled ? 'Found' : 'NOT FOUND');
    console.log('  propWingFullLayer:', propWingFullLayer ? 'Found' : 'NOT FOUND');
    console.log('  propLoopCheckbox:', propLoopCheckbox ? 'Found' : 'NOT FOUND');

    debouncedSaveCueProperties = debounce(handleSaveCueProperties, 500);
    console.log('[PropertiesSidebarInit] debouncedSaveCueProperties initialized:', typeof debouncedSaveCueProperties);

    bindPropertiesSidebarEventListeners();
    // Populate with placeholders initially
    populateWingDropdowns('behringer_wing_compact', null, true);
    populateWingDropdowns('behringer_wing_full', null, true);
    console.log('Properties Sidebar Module Initialized');
}

function cachePropertiesSidebarDOMElements() {
    propertiesSidebar = document.getElementById('propertiesSidebar');
    closePropertiesSidebarBtn = document.getElementById('closePropertiesSidebarBtn');
    propCueIdInput = document.getElementById('propCueId');
    propCueNameInput = document.getElementById('propCueName');
    propCueTypeSelect = document.getElementById('propCueType');
    propSingleFileConfigDiv = document.getElementById('propSingleFileConfig');
    propFilePathInput = document.getElementById('propFilePath');
    propPlaylistConfigDiv = document.getElementById('propPlaylistConfig');
    propPlaylistItemsUl = document.getElementById('propPlaylistItems');
    propPlaylistFilePathDisplay = document.getElementById('propPlaylistFilePathDisplay');
    propFadeInTimeInput = document.getElementById('propFadeInTime');
    propFadeOutTimeInput = document.getElementById('propFadeOutTime');
    propLoopCheckbox = document.getElementById('propLoop');
    propTrimStartTimeInput = document.getElementById('propTrimStartTime');
    propTrimEndTimeInput = document.getElementById('propTrimEndTime');
    propTrimConfig = document.getElementById('propTrimConfig');
    propVolumeRangeInput = document.getElementById('propVolume');
    propVolumeValueSpan = document.getElementById('propVolumeValue');
    saveCuePropertiesButton = document.getElementById('saveCuePropertiesButton');
    deleteCuePropertiesButton = document.getElementById('deleteCuePropertiesButton');
    propShufflePlaylistCheckbox = document.getElementById('propShufflePlaylist');
    propRepeatOnePlaylistItemCheckbox = document.getElementById('propRepeatOnePlaylistItemCheckbox');
    propRetriggerBehaviorSelect = document.getElementById('propRetriggerBehavior');
    propPlaylistPlayModeSelect = document.getElementById('propPlaylistPlayModeSelect');
    propVolumeSlider = document.getElementById('propVolume');
    propVolumeValueDisplay = document.getElementById('propVolumeValue');
    propEnableDuckingCheckbox = document.getElementById('propEnableDucking');
    propDuckingLevelInput = document.getElementById('propDuckingLevel');
    propDuckingLevelValueSpan = document.getElementById('propDuckingLevelValue');
    propIsDuckingTriggerCheckbox = document.getElementById('propIsDuckingTrigger');
    propWingTriggerEnabled = document.getElementById('propWingTriggerEnabled');
    wingTriggerSettingsContainer = document.getElementById('wingTriggerSettingsContainer');
    wingFullSizeConfigDiv = document.getElementById('wingFullSizeConfig');
    propWingFullLayer = document.getElementById('propWingFullLayer');
    propWingFullButton = document.getElementById('propWingFullButton');
    propWingFullRow = document.getElementById('propWingFullRow');
    wingCompactConfigDiv = document.getElementById('wingCompactConfig');
    propWingCompactLayer = document.getElementById('propWingCompactLayer');
    propWingCompactButton = document.getElementById('propWingCompactButton');
    wingUserButtonSubGroupLegacy = document.getElementById('wingUserButtonSubGroup_Legacy');
    propWingUserButtonLegacy = document.getElementById('propWingUserButton_Legacy');

    if (propVolumeSlider && propVolumeValueDisplay) {
        propVolumeSlider.addEventListener('input', (e) => {
            propVolumeValueDisplay.textContent = parseFloat(e.target.value).toFixed(2);
        });
    }
}

function bindPropertiesSidebarEventListeners() {
    console.log('[PropertiesSidebarEventListeners] BINDING LISTENERS START');
    console.log('  propCueNameInput (at bind start):', propCueNameInput ? 'Exists' : 'NULL');
    console.log('  propWingTriggerEnabled (at bind start):', propWingTriggerEnabled ? 'Exists' : 'NULL');
    console.log('  debouncedSaveCueProperties (at bind start):', typeof debouncedSaveCueProperties);

    if (closePropertiesSidebarBtn) closePropertiesSidebarBtn.addEventListener('click', hidePropertiesSidebar);
    if (saveCuePropertiesButton) saveCuePropertiesButton.style.display = 'none';
    if (deleteCuePropertiesButton) deleteCuePropertiesButton.addEventListener('click', handleDeleteCueProperties);

    if (propCueTypeSelect) propCueTypeSelect.addEventListener('change', (e) => {
        const isPlaylist = e.target.value === 'playlist';
        if(propPlaylistConfigDiv) propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
        if(propSingleFileConfigDiv) propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
        const playlistSpecificControls = document.getElementById('playlistSpecificControls');
        if (playlistSpecificControls) playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
        const propTrimConfigDiv = document.getElementById('propTrimConfig');
        if (propTrimConfigDiv) propTrimConfigDiv.style.display = isPlaylist ? 'none' : 'block';
        const waveformDisplayContainer = document.getElementById('waveformDisplay');
        if (waveformDisplayContainer) waveformDisplayContainer.style.display = isPlaylist ? 'none' : 'block';
        if (isPlaylist) {
            waveformControls.hideAndDestroyWaveform();
        } else {
            const cue = activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null;
            const currentFilePath = propFilePathInput ? propFilePathInput.value : null;
            if (cue && cue.filePath) {
                waveformControls.showWaveformForCue(cue);
            } else if (currentFilePath) {
                waveformControls.showWaveformForCue({filePath: currentFilePath });
            } else {
                waveformControls.hideAndDestroyWaveform();
            }
        }
    });

    if (propVolumeRangeInput && propVolumeValueSpan) propVolumeRangeInput.addEventListener('input', (e) => {
        propVolumeValueSpan.textContent = parseFloat(e.target.value).toFixed(2);
    });

    if (propDuckingLevelInput && propDuckingLevelValueSpan) {
        propDuckingLevelInput.addEventListener('input', (e) => {
            propDuckingLevelValueSpan.textContent = e.target.value;
            console.log(`[PropertiesSidebarEventListeners] INPUT event on propDuckingLevelInput. Value: ${e.target.value}`);
            debouncedSaveCueProperties();
        });
    }

    if (propWingTriggerEnabled) {
        propWingTriggerEnabled.addEventListener('change', () => {
            console.log("[PropertiesSidebarEventListeners] propWingTriggerEnabled CHANGED. Checked:", propWingTriggerEnabled.checked);
            handleWingTriggerEnabledChange();
            console.log("[PropertiesSidebarEventListeners] propWingTriggerEnabled calling debouncedSaveCueProperties.");
            debouncedSaveCueProperties();
        });
    }

    const wingDropdownsToAutoSave = [
        propWingFullLayer, propWingFullButton, propWingFullRow,
        propWingCompactLayer, propWingCompactButton,
        propWingUserButtonLegacy
    ];
    wingDropdownsToAutoSave.forEach(dropdown => {
        if (dropdown) dropdown.addEventListener('change', debouncedSaveCueProperties);
    });

    const inputsToAutoSave = [
        propCueNameInput, propFilePathInput, propFadeInTimeInput, propFadeOutTimeInput,
        propVolumeRangeInput, propRetriggerBehaviorSelect, propPlaylistPlayModeSelect,
    ];
    inputsToAutoSave.forEach(input => {
        if (input) {
            input.addEventListener('input', () => {
                console.log(`[PropertiesSidebarEventListeners] INPUT event on: ${input.id || 'anonymous input'}. Value: ${input.value}`);
                debouncedSaveCueProperties();
            });
            if (input.tagName === 'SELECT') {
                input.removeEventListener('input', debouncedSaveCueProperties);
                input.addEventListener('change', () => {
                    console.log(`[PropertiesSidebarEventListeners] CHANGE event on SELECT: ${input.id || 'anonymous select'}. Value: ${input.value}`);
                    debouncedSaveCueProperties();
                });
            }
        }
    });

    const checkboxesToAutoSave = [
        propLoopCheckbox, propShufflePlaylistCheckbox, propRepeatOnePlaylistItemCheckbox,
        // propWingTriggerEnabled is handled above with specific logic
    ];
    checkboxesToAutoSave.forEach(checkbox => {
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                console.log(`[PropertiesSidebarEventListeners] CHANGE event on CHECKBOX: ${checkbox.id || 'anonymous checkbox'}. Checked: ${checkbox.checked}`);
                debouncedSaveCueProperties();
            });
        }
    });

    if (propIsDuckingTriggerCheckbox) {
        if (!propIsDuckingTriggerCheckbox.hasAttribute('data-ducking-listener-attached')) {
            propIsDuckingTriggerCheckbox.addEventListener('change', () => {
                updateDuckingControlsVisibility(propIsDuckingTriggerCheckbox.checked);
                debouncedSaveCueProperties();
            });
            propIsDuckingTriggerCheckbox.setAttribute('data-ducking-listener-attached', 'true');
        }
    }
    if (propEnableDuckingCheckbox) {
        if (!propEnableDuckingCheckbox.hasAttribute('data-enable-ducking-listener-attached')) {
            propEnableDuckingCheckbox.addEventListener('change', debouncedSaveCueProperties);
            propEnableDuckingCheckbox.setAttribute('data-enable-ducking-listener-attached', 'true');
        }
    }
    // Ensure playlist drag/drop listeners are bound if propPlaylistItemsUl exists
    bindPlaylistDragAndRemoveListenersIfNeeded();
}

// --- Properties Sidebar Specific Functions ---
function openPropertiesSidebar(cue) {
    if (!cue || !propertiesSidebar || !uiCore) return;
    activePropertiesCueId = cue.id;
    // currentEditCueId = cue.id; // No longer used
    const appConfig = uiCore.getCurrentAppConfig();

    waveformControls.hideAndDestroyWaveform();

    if(propCueIdInput) propCueIdInput.value = cue.id;
    if(propCueNameInput) propCueNameInput.value = cue.name || '';
    if(propCueTypeSelect) propCueTypeSelect.value = cue.type || 'single';
    
    const isPlaylist = cue.type === 'playlist';
    if(propPlaylistConfigDiv) propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
    if(propSingleFileConfigDiv) propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
    const playlistSpecificControls = document.getElementById('playlistSpecificControls');
    if (playlistSpecificControls) playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
    const waveformDisplayContainer = document.getElementById('waveformDisplay');
    if (waveformDisplayContainer) waveformDisplayContainer.style.display = isPlaylist ? 'none' : 'block';

    if (isPlaylist) {
        if(propFilePathInput) propFilePathInput.value = '';
        stagedPlaylistItems = cue.playlistItems ? JSON.parse(JSON.stringify(cue.playlistItems)) : [];
        renderPlaylistInProperties();
        if(propPlaylistFilePathDisplay) propPlaylistFilePathDisplay.textContent = '';
        if(propShufflePlaylistCheckbox) propShufflePlaylistCheckbox.checked = cue.shuffle || false;
        if(propRepeatOnePlaylistItemCheckbox) propRepeatOnePlaylistItemCheckbox.checked = cue.repeatOne || false;
        if(propPlaylistPlayModeSelect) propPlaylistPlayModeSelect.value = cue.playlistPlayMode || 'continue';
    } else {
        if(propFilePathInput) propFilePathInput.value = cue.filePath || '';
        if(propPlaylistItemsUl) propPlaylistItemsUl.innerHTML = '';
        stagedPlaylistItems = [];
        currentWaveformTrimStart = cue.trimStartTime || 0;
        currentWaveformTrimEnd = cue.trimEndTime || 0;
        if (cue.filePath) {
            waveformControls.showWaveformForCue(cue);
        }
    }

    if(propFadeInTimeInput) propFadeInTimeInput.value = cue.fadeInTime !== undefined ? cue.fadeInTime : (appConfig.defaultFadeInTime || 0);
    if(propFadeOutTimeInput) propFadeOutTimeInput.value = cue.fadeOutTime !== undefined ? cue.fadeOutTime : (appConfig.defaultFadeOutTime || 0);
    if(propLoopCheckbox) propLoopCheckbox.checked = cue.loop !== undefined ? cue.loop : (appConfig.defaultLoop || false);
    if(propVolumeRangeInput) propVolumeRangeInput.value = cue.volume !== undefined ? cue.volume : (appConfig.defaultVolume !== undefined ? appConfig.defaultVolume : 1);
    if(propVolumeValueSpan) propVolumeValueSpan.textContent = parseFloat(propVolumeRangeInput.value).toFixed(2);
    if(propVolumeSlider) propVolumeSlider.value = cue.volume !== undefined ? cue.volume : (appConfig.defaultVolume !== undefined ? appConfig.defaultVolume : 1);
    if(propVolumeValueDisplay) propVolumeValueDisplay.textContent = parseFloat(propVolumeSlider.value).toFixed(2);
    if(propRetriggerBehaviorSelect) propRetriggerBehaviorSelect.value = cue.retriggerBehavior !== undefined ? cue.retriggerBehavior : (appConfig.defaultRetriggerBehavior || 'restart');

    if (propEnableDuckingCheckbox) propEnableDuckingCheckbox.checked = !!cue.enableDucking;
    if (propDuckingLevelInput) propDuckingLevelInput.value = cue.duckingLevel !== undefined ? cue.duckingLevel : 20;
    if (propDuckingLevelValueSpan) propDuckingLevelValueSpan.textContent = cue.duckingLevel !== undefined ? cue.duckingLevel : 20;
    if (propIsDuckingTriggerCheckbox) {
        propIsDuckingTriggerCheckbox.checked = !!cue.isDuckingTrigger;
        updateDuckingControlsVisibility(propIsDuckingTriggerCheckbox.checked);
    }

    const effectiveWingType = getEffectiveWingType(appConfig);
    let currentButtonIdForDropdown = null;
    let wingTriggerEnabledForCue = false;

    if (cue.mixerButtonAssignment && cue.mixerButtonAssignment.mixerType && cue.mixerButtonAssignment.buttonId) {
        if (cue.mixerButtonAssignment.mixerType === effectiveWingType || 
            (cue.mixerButtonAssignment.mixerType === 'behringer_wing' && effectiveWingType === 'behringer_wing_full')) {
            currentButtonIdForDropdown = cue.mixerButtonAssignment.buttonId;
            wingTriggerEnabledForCue = true;
        }
    } else if (cue.wingTrigger && cue.wingTrigger.enabled && cue.wingTrigger.userButton) {
        console.warn(`PropertiesSidebar: Cue ${cue.id} using legacy wingTrigger. Attempting to adapt.`);
        const parts = cue.wingTrigger.userButton.split('_');
        let legacyMatchesCurrentType = false;
        if (effectiveWingType === 'behringer_wing_compact') {
            if (parts.length === 2 && !isNaN(parseInt(parts[0])) && !isNaN(parseInt(parts[1]))) {
                 currentButtonIdForDropdown = `layer${parts[0]}_button${parts[1]}`;
                 legacyMatchesCurrentType = true;
            } else if (parts[0].startsWith('layer') && parts[1].startsWith('button')) { 
                 currentButtonIdForDropdown = cue.wingTrigger.userButton;
                 legacyMatchesCurrentType = true;
            }
        } else if (effectiveWingType === 'behringer_wing_full') {
            if (parts.length === 3 && !isNaN(parseInt(parts[0])) && !isNaN(parseInt(parts[1])) && (parts[2] === 'bu' || parts[2] === 'bd')) {
                currentButtonIdForDropdown = `layer${parts[0]}_button${parts[1]}_${parts[2]}`;
                legacyMatchesCurrentType = true;
            } else if (parts[0].startsWith('layer') && parts[1].startsWith('button') && (parts[2] === 'bu' || parts[2] === 'bd')) { 
                currentButtonIdForDropdown = cue.wingTrigger.userButton;
                legacyMatchesCurrentType = true;
            }
        }
        if(legacyMatchesCurrentType){
            wingTriggerEnabledForCue = true;
        } else {
             console.warn(`PropertiesSidebar: Legacy wingTrigger.userButton '${cue.wingTrigger.userButton}' does not match effectiveWingType '${effectiveWingType}'.`);
        }
    }

    if (propWingTriggerEnabled) {
        propWingTriggerEnabled.checked = wingTriggerEnabledForCue;
    }
    handleWingTriggerEnabledChange(); 
    if (wingTriggerEnabledForCue && effectiveWingType && currentButtonIdForDropdown) {
        populateWingDropdowns(effectiveWingType, currentButtonIdForDropdown, false);
    } else if (effectiveWingType) {
        populateWingDropdowns(effectiveWingType, null, true);
    }

    if (propTrimConfig && !isPlaylist) {
        propTrimConfig.style.display = 'block';
        if (propTrimStartTimeInput) propTrimStartTimeInput.value = formatWaveformTime(cue.trimStartTime || 0);
        if (propTrimEndTimeInput) propTrimEndTimeInput.value = cue.trimEndTime ? formatWaveformTime(cue.trimEndTime) : 'End';
    } else if (propTrimConfig) {
        propTrimConfig.style.display = 'none';
    }

    if (propertiesSidebar) {
        propertiesSidebar.classList.remove('hidden');
        const innerScrollable = propertiesSidebar.querySelector('.sidebar-content-inner');
        if (innerScrollable) innerScrollable.scrollTop = 0;
    }
}

function hidePropertiesSidebar() {
    if(propertiesSidebar) propertiesSidebar.classList.add('hidden');
    activePropertiesCueId = null;
    stagedPlaylistItems = [];
    waveformControls.hideAndDestroyWaveform();
}

function renderPlaylistInProperties() {
    if (!propPlaylistItemsUl || !ipcRendererBindingsModule) return;
    propPlaylistItemsUl.innerHTML = '';
    stagedPlaylistItems.forEach((item, index) => {
        const li = document.createElement('li');
        li.classList.add('playlist-item');
        li.dataset.index = index;
        li.dataset.path = item.path || '';
        li.dataset.itemId = item.id || '';
        const dragHandle = document.createElement('span');
        dragHandle.classList.add('playlist-item-drag-handle');
        dragHandle.innerHTML = '&#x2630;';
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', handleDragStartPlaylistItem);
        li.appendChild(dragHandle);
        const itemNameSpan = document.createElement('span');
        itemNameSpan.textContent = item.name || (item.path ? item.path.split(/[\\\/]/).pop() : 'Invalid Item');
        itemNameSpan.title = item.path;
        itemNameSpan.classList.add('playlist-item-name');
        li.appendChild(itemNameSpan);
        const itemDurationSpan = document.createElement('span');
        itemDurationSpan.classList.add('playlist-item-duration');
        const formattedDuration = item.knownDuration ? formatWaveformTime(item.knownDuration) : '--:--';
        itemDurationSpan.textContent = ` (${formattedDuration})`;
        li.appendChild(itemDurationSpan);
        const removeButton = document.createElement('button');
        removeButton.textContent = '✕';
        removeButton.title = 'Remove item';
        removeButton.classList.add('remove-playlist-item-btn');
        removeButton.dataset.index = index;
        removeButton.addEventListener('click', handleRemovePlaylistItem);
        li.appendChild(removeButton);
        propPlaylistItemsUl.appendChild(li);
    });
    if (stagedPlaylistItems.length === 0 && propPlaylistFilePathDisplay) {
        propPlaylistFilePathDisplay.textContent = 'Playlist is empty. Drag files here or click Add Files.';
    } else if (propPlaylistFilePathDisplay) {
        propPlaylistFilePathDisplay.textContent = `Playlist contains ${stagedPlaylistItems.length} item(s).`;
    }
}

function handleDragStartPlaylistItem(event) {
    const listItem = event.target.closest('li');
    if (!listItem) return;
    const itemId = listItem.dataset.itemId;
    if (!itemId) {
        event.preventDefault(); return;
    }
    event.dataTransfer.setData('application/json', JSON.stringify({ type: 'playlist-item-reorder', itemId: itemId }));
    event.dataTransfer.effectAllowed = 'move';
    listItem.classList.add('dragging-playlist-item');
}

function handleDragOverPlaylistItem(event) {
    event.preventDefault();
    const isFileDrag = Array.from(event.dataTransfer.types).includes('Files');
    if (isFileDrag) {
        event.dataTransfer.dropEffect = 'copy';
    } else {
        event.dataTransfer.dropEffect = 'move';
        const draggable = document.querySelector('.dragging-playlist-item');
        if (draggable && propPlaylistItemsUl) {
            const afterElement = getDragAfterElement(propPlaylistItemsUl, event.clientY);
            if (afterElement == null) {
                propPlaylistItemsUl.appendChild(draggable);
            } else {
                propPlaylistItemsUl.insertBefore(draggable, afterElement);
            }
        }
    }
}

async function handleDropPlaylistItem(event) {
    event.stopPropagation(); event.preventDefault();
    const ul = event.target.closest('ul#propPlaylistItems');
    if (!ul) {
        const draggingElement = document.querySelector('.dragging-playlist-item');
        if (draggingElement) draggingElement.classList.remove('dragging-playlist-item');
        return;
    }
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
        const files = Array.from(event.dataTransfer.files);
        const audioFiles = files.filter(file => file.name.toLowerCase().match(/\.(mp3|wav|aac|m4a|ogg)$/));
        if (audioFiles.length > 0) {
            for (const file of audioFiles) {
                const newItemId = await ipcRendererBindingsModule.generateUUID();
                const itemName = file.name;
                const itemPath = file.path;
                let itemDuration = 0;
                try {
                    const durationResult = await ipcRendererBindingsModule.getMediaDuration(itemPath);
                    if (durationResult && typeof durationResult === 'number' && durationResult > 0) itemDuration = durationResult;
                } catch (error) { console.error(`PropertiesSidebar: Error getting duration for ${itemPath}:`, error); }
                stagedPlaylistItems.push({
                    id: newItemId, name: itemName, path: itemPath, volume: 1, fadeInTime: 0, fadeOutTime: 0,
                    trimStartTime: 0, trimEndTime: 0, knownDuration: itemDuration
                });
            }
            renderPlaylistInProperties();
            await handleSaveCueProperties();
        }
        const draggingElementGlobal = document.querySelector('.dragging-playlist-item');
        if (draggingElementGlobal) draggingElementGlobal.classList.remove('dragging-playlist-item');
        return;
    }
    let draggedItemData;
    try { draggedItemData = JSON.parse(event.dataTransfer.getData('application/json')); }
    catch (e) { 
        const stillDragging = document.querySelector('.dragging-playlist-item');
        if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
        return; 
    }
    if (!draggedItemData || draggedItemData.type !== 'playlist-item-reorder' || !draggedItemData.itemId) {
        const stillDragging = document.querySelector('.dragging-playlist-item');
        if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
        return;
    }
    const draggedItemId = draggedItemData.itemId;
    const draggedItem = stagedPlaylistItems.find(p_item => p_item.id === draggedItemId);
    const originalIndexOfDragged = stagedPlaylistItems.findIndex(p_item => p_item.id === draggedItemId);
    if (!draggedItem || originalIndexOfDragged === -1) {
        const stillDragging = document.querySelector('.dragging-playlist-item');
        if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
        return;
    }
    stagedPlaylistItems.splice(originalIndexOfDragged, 1);
    const afterElement = getDragAfterElement(ul, event.clientY);
    if (afterElement) {
        const insertBeforeItemId = afterElement.dataset.itemId;
        const insertBeforeIndex = stagedPlaylistItems.findIndex(p_item => p_item.id === insertBeforeItemId);
        if (insertBeforeIndex !== -1) stagedPlaylistItems.splice(insertBeforeIndex, 0, draggedItem);
        else stagedPlaylistItems.push(draggedItem);
    } else {
        stagedPlaylistItems.push(draggedItem);
    }
    renderPlaylistInProperties();
    debouncedSaveCueProperties();
    const stillDragging = document.querySelector('.dragging-playlist-item');
    if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
}

function handleDragEndPlaylistItem() {
    const draggingElem = propPlaylistItemsUl ? propPlaylistItemsUl.querySelector('.dragging-playlist-item') : null;
    if(draggingElem) draggingElem.classList.remove('dragging-playlist-item');
    if(propPlaylistItemsUl) Array.from(propPlaylistItemsUl.children).forEach(childLi => childLi.classList.remove('drag-over-playlist-item'));
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('li.playlist-item:not(.dragging-playlist-item)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
        else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function handleRemovePlaylistItem(event) {
    const indexToRemove = parseInt(event.target.dataset.index, 10);
    if (!isNaN(indexToRemove) && indexToRemove >= 0 && indexToRemove < stagedPlaylistItems.length) {
        stagedPlaylistItems.splice(indexToRemove, 1);
        renderPlaylistInProperties();
        debouncedSaveCueProperties();
    }
}

async function handleSaveCueProperties() {
    console.log('[PropertiesSidebar] handleSaveCueProperties CALLED. Active Cue ID:', activePropertiesCueId);
    if (!activePropertiesCueId) {
        console.warn('[PropertiesSidebar] handleSaveCueProperties: No activePropertiesCueId, exiting.');
        return;
    }
    const existingCue = cueStore.getCueById(activePropertiesCueId);
    if (!existingCue) {
        console.warn('[PropertiesSidebar] handleSaveCueProperties: Existing cue not found for ID:', activePropertiesCueId, ', exiting.');
        return;
    }

    // --- WING TRIGGER LOGIC --- Get current selections
    let wingConfig = {
        enabled: propWingTriggerEnabled ? propWingTriggerEnabled.checked : false,
        assignedMidiCC: (existingCue.wingTrigger && existingCue.wingTrigger.assignedMidiCC !== undefined) ? existingCue.wingTrigger.assignedMidiCC : null,
        label: '',
        wingLayer: null,
        wingButton: null,
        wingRow: null,
        mixerType: null // Will be set if type is valid
    };

    const appConfig = uiCore.getCurrentAppConfig ? uiCore.getCurrentAppConfig() : {};
    const effectiveWingType = getEffectiveWingType(appConfig);

    if (propWingTriggerEnabled && propWingTriggerEnabled.checked && effectiveWingType && appConfig.mixerIntegrationEnabled) {
        let selectedLayer = null, selectedButton = null, selectedRow = null;

        if (effectiveWingType === 'behringer_wing_compact') {
            if (propWingCompactLayer) selectedLayer = propWingCompactLayer.value;
            if (propWingCompactButton) selectedButton = propWingCompactButton.value;
            wingConfig.mixerType = 'behringer_wing_compact';
        } else if (effectiveWingType === 'behringer_wing_full') {
            if (propWingFullLayer) selectedLayer = propWingFullLayer.value;
            if (propWingFullButton) selectedButton = propWingFullButton.value;
            if (propWingFullRow) selectedRow = propWingFullRow.value;
            wingConfig.mixerType = 'behringer_wing_full';
        }

        // Check if actual selections were made (not placeholders)
        if (selectedLayer && selectedButton && (effectiveWingType !== 'behringer_wing_full' || selectedRow)) {
            wingConfig.enabled = true; // Truly enabled only if selections are valid
            wingConfig.label = (propCueNameInput ? propCueNameInput.value : existingCue.name).substring(0, 16); // Max 16 chars for WING
            wingConfig.wingLayer = selectedLayer;
            wingConfig.wingButton = selectedButton;
            if (effectiveWingType === 'behringer_wing_full') {
                wingConfig.wingRow = selectedRow;
            }
        } else {
            wingConfig.enabled = false; // If any part is placeholder, it's not fully enabled
        }
    } else {
        wingConfig.enabled = false; // Checkbox not checked or no effective type/integration disabled
    }
    // --- END WING TRIGGER LOGIC ---

    let updatedCueData = {
        id: activePropertiesCueId,
        name: propCueNameInput ? propCueNameInput.value : existingCue.name,
        type: propCueTypeSelect ? propCueTypeSelect.value : existingCue.type,
        filePath: (propCueTypeSelect && propCueTypeSelect.value !== 'playlist' && propFilePathInput) ? propFilePathInput.value : existingCue.filePath,
        playlistItems: (propCueTypeSelect && propCueTypeSelect.value === 'playlist') ? stagedPlaylistItems : existingCue.playlistItems,
        fadeInTime: propFadeInTimeInput ? parseFloat(propFadeInTimeInput.value) : existingCue.fadeInTime,
        fadeOutTime: propFadeOutTimeInput ? parseFloat(propFadeOutTimeInput.value) : existingCue.fadeOutTime,
        loop: propLoopCheckbox ? propLoopCheckbox.checked : existingCue.loop,
        volume: propVolumeSlider ? parseFloat(propVolumeSlider.value) : existingCue.volume,
        retriggerBehavior: propRetriggerBehaviorSelect ? propRetriggerBehaviorSelect.value : existingCue.retriggerBehavior,
        shuffle: (propCueTypeSelect && propCueTypeSelect.value === 'playlist' && propShufflePlaylistCheckbox) ? propShufflePlaylistCheckbox.checked : existingCue.shuffle,
        repeatOne: (propCueTypeSelect && propCueTypeSelect.value === 'playlist' && propRepeatOnePlaylistItemCheckbox) ? propRepeatOnePlaylistItemCheckbox.checked : existingCue.repeatOne,
        playlistPlayMode: (propCueTypeSelect && propCueTypeSelect.value === 'playlist' && propPlaylistPlayModeSelect) ? propPlaylistPlayModeSelect.value : existingCue.playlistPlayMode,
        trimStartTime: currentWaveformTrimStart,
        trimEndTime: currentWaveformTrimEnd,
        enableDucking: propEnableDuckingCheckbox ? propEnableDuckingCheckbox.checked : existingCue.enableDucking,
        duckingLevel: propDuckingLevelInput ? parseInt(propDuckingLevelInput.value, 10) : existingCue.duckingLevel,
        isDuckingTrigger: propIsDuckingTriggerCheckbox ? propIsDuckingTriggerCheckbox.checked : existingCue.isDuckingTrigger,
        wingTrigger: wingConfig // Use the fully processed wingConfig
    };

    // Remove the old mixerButtonAssignment as wingTrigger is now the source of truth
    if (updatedCueData.hasOwnProperty('mixerButtonAssignment')) {
        delete updatedCueData.mixerButtonAssignment;
    }

    try {
        const result = await cueStore.addOrUpdateCue(updatedCueData);
        if (!result || !result.success) {
            console.error('PropertiesSidebar: Failed to save cue:', result ? result.error : 'Unknown error');
        }
    } catch (error) {
        console.error('PropertiesSidebar: Error saving cue:', error);
    }
}

async function handleDeleteCueProperties() {
    if (!activePropertiesCueId || !cueStore || !audioController) return;
    if (confirm('Are you sure you want to delete this cue?')) {
        if (audioController.isPlaying(activePropertiesCueId)) {
            audioController.stop(activePropertiesCueId, false);
        }
        await cueStore.deleteCue(activePropertiesCueId);
        hidePropertiesSidebar();
    }
}

function getActivePropertiesCueId() {
    return activePropertiesCueId;
}

async function setFilePathInProperties(filePath) {
    if (!activePropertiesCueId) return false;
    const activeCue = cueStore.getCueById(activePropertiesCueId);
    if (!activeCue || (activeCue.type !== 'single_file' && activeCue.type !== 'single')) return false;
    if (propFilePathInput) {
        propFilePathInput.value = filePath;
        if (activeCue.type === 'single_file' || activeCue.type === 'single') {
            waveformControls.showWaveformForCue({ ...activeCue, filePath: filePath });
        }
        return true;
    }
    return false;
}

function bindPlaylistDragAndRemoveListenersIfNeeded() {
    if (propPlaylistItemsUl) {
        propPlaylistItemsUl.addEventListener('dragover', handleDragOverPlaylistItem);
        propPlaylistItemsUl.addEventListener('drop', handleDropPlaylistItem);
        propPlaylistItemsUl.addEventListener('dragend', handleDragEndPlaylistItem);
    }
}

function handleCuePropertyChangeFromWaveform(trimStart, trimEnd) {
    if (!activePropertiesCueId) return;
    currentWaveformTrimStart = trimStart;
    currentWaveformTrimEnd = trimEnd;
    debouncedSaveCueProperties();
}

function highlightPlayingPlaylistItemInSidebar(cueId, playlistItemId) {
    if (!activePropertiesCueId || activePropertiesCueId !== cueId || !propPlaylistItemsUl) return;
    const items = propPlaylistItemsUl.querySelectorAll('li.playlist-item');
    items.forEach(itemLi => {
        itemLi.classList.remove('playlist-item-playing');
        if (itemLi.dataset.itemId === playlistItemId) {
            itemLi.classList.add('playlist-item-playing');
        }
    });
}

// New function to refresh the playlist view if it's the active cue
function refreshPlaylistPropertiesView(cueIdToRefresh) {
    if (!propertiesSidebar || propertiesSidebar.classList.contains('hidden')) {
        console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Sidebar not visible, no refresh needed for', cueIdToRefresh);
        return;
    }
    if (activePropertiesCueId && activePropertiesCueId === cueIdToRefresh) {
        console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Active cue matches cueIdToRefresh:', cueIdToRefresh, '. Re-fetching and re-rendering.');
        const latestCueData = cueStore.getCueById(activePropertiesCueId);
        if (latestCueData && latestCueData.type === 'playlist') {
            // Ensure playlistItems is an array, default to empty if not.
            // Deep copy to avoid modifying cueStore's copy directly if renderPlaylistInProperties modifies stagedPlaylistItems in the future (it shouldn't, but good practice).
            stagedPlaylistItems = latestCueData.playlistItems ? JSON.parse(JSON.stringify(latestCueData.playlistItems)) : [];
            renderPlaylistInProperties();
            console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Playlist items refreshed and re-rendered.');
        } else if (latestCueData) {
            console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Active cue is not a playlist, no playlist items to refresh.');
        } else {
            console.warn('[PropertiesSidebar refreshPlaylistPropertiesView] Could not find active cue data in store for ID:', activePropertiesCueId);
        }
    } else {
        console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Cue to refresh (', cueIdToRefresh, ') does not match active cue (', activePropertiesCueId, '). No action.');
    }
}

export {
    initPropertiesSidebar,
    openPropertiesSidebar,
    hidePropertiesSidebar,
    getActivePropertiesCueId,
    refreshPlaylistPropertiesView,
    setFilePathInProperties,
    handleCuePropertyChangeFromWaveform,
    highlightPlayingPlaylistItemInSidebar,
    handleSaveCueProperties
}; 