/**
 * DOM Management for Properties Sidebar
 * Handles DOM element caching, initialization, and basic DOM operations
 */

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

/**
 * Cache all DOM elements for the properties sidebar
 */
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
    // Align with HTML id
    propRepeatOnePlaylistItemCheckbox = document.getElementById('propRepeatOnePlaylistItem');
    propRetriggerBehaviorSelect = document.getElementById('propRetriggerBehavior');
    propPlaylistPlayModeSelect = document.getElementById('propPlaylistPlayModeSelect');
    propVolumeSlider = document.getElementById('propVolume');
    propVolumeValueDisplay = document.getElementById('propVolumeValue');
    propEnableDuckingCheckbox = document.getElementById('propEnableDucking');
    propDuckingLevelInput = document.getElementById('propDuckingLevel');
    propDuckingLevelValueSpan = document.getElementById('propDuckingLevelValue');
    propIsDuckingTriggerCheckbox = document.getElementById('propIsDuckingTrigger');

    // Set up volume slider display
    if (propVolumeSlider && propVolumeValueDisplay) {
        propVolumeSlider.addEventListener('input', (e) => {
            propVolumeValueDisplay.textContent = parseFloat(e.target.value).toFixed(2);
        });
    }
}

/**
 * Get DOM element by name
 */
function getDOMElement(elementName) {
    const elements = {
        propertiesSidebar,
        closePropertiesSidebarBtn,
        propCueIdInput,
        propCueNameInput,
        propCueTypeSelect,
        propSingleFileConfigDiv,
        propFilePathInput,
        propPlaylistConfigDiv,
        propPlaylistItemsUl,
        propPlaylistFilePathDisplay,
        propFadeInTimeInput,
        propFadeOutTimeInput,
        propLoopCheckbox,
        propTrimStartTimeInput,
        propTrimEndTimeInput,
        propTrimConfig,
        propVolumeRangeInput,
        propVolumeValueSpan,
        saveCuePropertiesButton,
        deleteCuePropertiesButton,
        propShufflePlaylistCheckbox,
        propRepeatOnePlaylistItemCheckbox,
        propRetriggerBehaviorSelect,
        propPlaylistPlayModeSelect,
        propVolumeSlider,
        propVolumeValueDisplay,
        propEnableDuckingCheckbox,
        propDuckingLevelInput,
        propDuckingLevelValueSpan,
        propIsDuckingTriggerCheckbox
    };
    
    return elements[elementName];
}

/**
 * Show/hide the properties sidebar
 */
function showPropertiesSidebar() {
    if (propertiesSidebar) {
        propertiesSidebar.classList.remove('hidden');
        const innerScrollable = propertiesSidebar.querySelector('.sidebar-content-inner');
        if (innerScrollable) innerScrollable.scrollTop = 0;
    }
}

function hidePropertiesSidebar() {
    if (propertiesSidebar) propertiesSidebar.classList.add('hidden');
}

/**
 * Update ducking controls visibility based on trigger state
 */
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

export {
    cachePropertiesSidebarDOMElements,
    getDOMElement,
    showPropertiesSidebar,
    hidePropertiesSidebar,
    updateDuckingControlsVisibility
};
