/**
 * Form Data Management for Properties Sidebar
 * Handles form data collection, validation, and save/delete operations
 */

import { formatWaveformTime } from './waveformControls.js';
import { 
    normalizeTrimValues, 
    validateCueName, 
    validateVolume, 
    validateDuckingLevel, 
    validateFadeTime 
} from './propertiesSidebarUtils.js';

let cueStore;
let audioController;
let uiCore;
let currentWaveformTrimStart = 0;
let currentWaveformTrimEnd = 0;

/**
 * Initialize form manager
 * @param {Object} csModule - Cue store module
 * @param {Object} acModule - Audio controller module
 * @param {Object} uiCoreInterfaceRef - UI core interface
 */
// Mirrors src/backend/utils/outputPatch.js. Channel 0 is a real channel, so
// `|| fallback` can't be used to detect a missing entry - it turned a swapped
// patch like [1, 0] into [1, 1].
function channelOr(value, fallback) {
    const n = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeOutputPatch(patch, channelCount = 2) {
    const maxIndex = Math.max(0, (channelCount || 2) - 1);
    const left = Math.max(0, Math.min(maxIndex, channelOr(Array.isArray(patch) ? patch[0] : 0, 0)));
    const right = Math.max(0, Math.min(maxIndex, channelOr(Array.isArray(patch) ? (patch[1] ?? patch[0]) : 1, left)));
    return [left, right];
}

function outputChannelLabel(index) {
    if (index === 0) return '1 (Left / Mono)';
    if (index === 1) return '2 (Right)';
    return `${index + 1}`;
}

function populateOutputPatchSelects(domElements, channelCount) {
    const count = Math.max(2, channelCount || 2);
    [domElements.propOutputPatchLeft, domElements.propOutputPatchRight].forEach((select) => {
        if (!select) return;
        select.innerHTML = '';
        for (let i = 0; i < count; i += 1) {
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = outputChannelLabel(i);
            select.appendChild(option);
        }
    });
}

function updateOutputPatchVisibility(domElements, appConfig) {
    const channelCount = appConfig?.audioOutputChannelCount || 2;
    const show = channelCount > 2;
    if (domElements.propOutputPatchGroup) {
        domElements.propOutputPatchGroup.style.display = show ? 'block' : 'none';
    }
    if (show) {
        populateOutputPatchSelects(domElements, channelCount);
    }
}

function readOutputPatchFromForm(domElements, appConfig, existingCue) {
    const channelCount = appConfig?.audioOutputChannelCount || 2;
    const fallback = existingCue?.outputPatch || [0, 1];
    if (!domElements.propOutputPatchLeft || !domElements.propOutputPatchRight) {
        return normalizeOutputPatch(fallback, channelCount);
    }
    return normalizeOutputPatch([
        parseInt(domElements.propOutputPatchLeft.value, 10),
        parseInt(domElements.propOutputPatchRight.value, 10),
    ], channelCount);
}

function initFormManager(csModule, acModule, uiCoreInterfaceRef) {
    cueStore = csModule;
    audioController = acModule;
    uiCore = uiCoreInterfaceRef;
}

/**
 * Set current waveform trim values
 * @param {number} trimStart - Start time
 * @param {number} trimEnd - End time
 */
function setCurrentWaveformTrim(trimStart, trimEnd) {
    currentWaveformTrimStart = trimStart;
    currentWaveformTrimEnd = trimEnd;
}

/**
 * Get current waveform trim values
 * @returns {Object} Current trim values
 */
function getCurrentWaveformTrim() {
    return { currentWaveformTrimStart, currentWaveformTrimEnd };
}

/**
 * Collect form data from the properties sidebar
 * @param {string} activePropertiesCueId - Currently active cue ID
 * @param {Object} domElements - DOM elements object
 * @param {Array} stagedPlaylistItems - Current staged playlist items
 * @returns {Object} Collected form data
 */
function collectFormData(activePropertiesCueId, domElements, stagedPlaylistItems) {
    const existingCue = cueStore.getCueById(activePropertiesCueId);
    if (!existingCue) {
        console.error('[PropertiesSidebar] collectFormData: Could not find cue with ID:', activePropertiesCueId);
        return null;
    }

    const appConfig = uiCore.getCurrentAppConfig();

    // Normalize trim values before saving
    const { normalizedTrimStart, normalizedTrimEnd } = normalizeTrimValues(
        currentWaveformTrimStart, 
        currentWaveformTrimEnd
    );

    // Validate and sanitize cue name
    const cueName = validateCueName(
        domElements.propCueNameInput ? domElements.propCueNameInput.value : existingCue.name,
        activePropertiesCueId
    );

    const formData = {
        id: activePropertiesCueId,
        name: cueName,
        type: domElements.propCueTypeSelect ? domElements.propCueTypeSelect.value : existingCue.type,
        // The file field only displays the file's name; which file a cue
        // plays is set by dropping a new one (setFilePathInProperties).
        filePath: existingCue.filePath,
        playlistItems: (domElements.propCueTypeSelect && domElements.propCueTypeSelect.value === 'playlist') 
            ? stagedPlaylistItems 
            : existingCue.playlistItems,
        fadeInTime: validateFadeTime(
            domElements.propFadeInTimeInput ? parseFloat(domElements.propFadeInTimeInput.value) : existingCue.fadeInTime
        ),
        fadeOutTime: validateFadeTime(
            domElements.propFadeOutTimeInput ? parseFloat(domElements.propFadeOutTimeInput.value) : existingCue.fadeOutTime
        ),
        loop: domElements.propLoopCheckbox ? domElements.propLoopCheckbox.checked : existingCue.loop,
        volume: validateVolume(
            domElements.propVolumeSlider ? parseFloat(domElements.propVolumeSlider.value) : existingCue.volume
        ),
        retriggerBehavior: domElements.propRetriggerBehaviorSelect 
            ? domElements.propRetriggerBehaviorSelect.value 
            : existingCue.retriggerBehavior,
        // The server's names for these - `shuffle` / `repeatOne` were saved
        // but never read by the playback engine.
        shufflePlaylist: (domElements.propCueTypeSelect && domElements.propCueTypeSelect.value === 'playlist' && domElements.propShufflePlaylistCheckbox) 
            ? domElements.propShufflePlaylistCheckbox.checked 
            : existingCue.shufflePlaylist,
        repeatOnePlaylistItem: (domElements.propCueTypeSelect && domElements.propCueTypeSelect.value === 'playlist' && domElements.propRepeatOnePlaylistItemCheckbox) 
            ? domElements.propRepeatOnePlaylistItemCheckbox.checked 
            : existingCue.repeatOnePlaylistItem,
        playlistPlayMode: (domElements.propCueTypeSelect && domElements.propCueTypeSelect.value === 'playlist' && domElements.propPlaylistPlayModeSelect) 
            ? domElements.propPlaylistPlayModeSelect.value 
            : existingCue.playlistPlayMode,
        trimStartTime: normalizedTrimStart,
        trimEndTime: normalizedTrimEnd,
        enableDucking: domElements.propEnableDuckingCheckbox 
            ? domElements.propEnableDuckingCheckbox.checked 
            : existingCue.enableDucking,
        duckingLevel: validateDuckingLevel(
            domElements.propDuckingLevelInput ? parseInt(domElements.propDuckingLevelInput.value, 10) : existingCue.duckingLevel
        ),
        isDuckingTrigger: domElements.propIsDuckingTriggerCheckbox 
            ? domElements.propIsDuckingTriggerCheckbox.checked 
            : existingCue.isDuckingTrigger,
        outputPatch: readOutputPatchFromForm(domElements, appConfig, existingCue),
    };

    return formData;
}

/**
 * Save cue properties
 * @param {string} activePropertiesCueId - Currently active cue ID
 * @param {Object} domElements - DOM elements object
 * @param {Array} stagedPlaylistItems - Current staged playlist items
 * @returns {Promise<boolean>} Success status
 */
async function saveCueProperties(activePropertiesCueId, domElements, stagedPlaylistItems) {
    console.log('[PropertiesSidebar] saveCueProperties CALLED. Active Cue ID:', activePropertiesCueId);
    if (!activePropertiesCueId) {
        console.warn('[PropertiesSidebar] saveCueProperties: No active cue ID');
        return false;
    }

    const formData = collectFormData(activePropertiesCueId, domElements, stagedPlaylistItems);
    if (!formData) {
        return false;
    }

    try {
        const result = await cueStore.addOrUpdateCue(formData);
        if (!result || !result.success) {
            console.error('PropertiesSidebar: Failed to save cue:', result ? result.error : 'Unknown error');
            return false;
        } else {
            console.log('[PropertiesSidebar] Successfully saved cue:', activePropertiesCueId);
            return true;
        }
    } catch (error) {
        console.error('PropertiesSidebar: Error saving cue:', error);
        return false;
    }
}

/**
 * Delete cue properties
 * @param {string} activePropertiesCueId - Currently active cue ID
 * @returns {Promise<boolean>} Success status
 */
async function deleteCueProperties(activePropertiesCueId) {
    if (!activePropertiesCueId || !cueStore || !audioController) return false;
    
    if (confirm('Are you sure you want to delete this cue?')) {
        if (audioController.default && audioController.default.isPlaying && audioController.default.isPlaying(activePropertiesCueId)) {
            // Stop the cue if it's playing
            if (audioController.default.toggle) {
                audioController.default.toggle(activePropertiesCueId, false, 'stop');
            }
        }
        await cueStore.deleteCue(activePropertiesCueId);
        return true;
    }
    return false;
}

/**
 * Populate form fields with cue data
 * @param {Object} cue - Cue object
 * @param {Object} domElements - DOM elements object
 * @param {Function} setStagedPlaylistItems - Function to set staged playlist items
 * @param {Function} renderPlaylistInProperties - Function to render playlist
 * @param {Function} showWaveformForCue - Function to show waveform
 * @param {Function} hideAndDestroyWaveform - Function to hide waveform
 * @param {Function} updateDuckingControlsVisibility - Function to update ducking controls
 */
function populateFormWithCueData(cue, domElements, setStagedPlaylistItems, renderPlaylistInProperties, showWaveformForCue, hideAndDestroyWaveform, updateDuckingControlsVisibility) {
    const appConfig = uiCore.getCurrentAppConfig();

    hideAndDestroyWaveform();

    if(domElements.propCueIdInput) domElements.propCueIdInput.value = cue.id;
    if(domElements.propCueNameInput) domElements.propCueNameInput.value = cue.name || '';
    if(domElements.propCueTypeSelect) domElements.propCueTypeSelect.value = cue.type || 'single';
    
    const isPlaylist = cue.type === 'playlist';
    if(domElements.propPlaylistConfigDiv) domElements.propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
    if(domElements.propSingleFileConfigDiv) domElements.propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
    const playlistSpecificControls = document.getElementById('playlistSpecificControls');
    if (playlistSpecificControls) playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
    const waveformDisplayContainer = document.getElementById('waveformDisplay');
    if (waveformDisplayContainer) waveformDisplayContainer.style.display = isPlaylist ? 'none' : 'block';

    if (isPlaylist) {
        if(domElements.propFilePathInput) domElements.propFilePathInput.value = '';
        setStagedPlaylistItems(cue.playlistItems);
        renderPlaylistInProperties(domElements.propPlaylistItemsUl, domElements.propPlaylistFilePathDisplay);
        if(domElements.propPlaylistFilePathDisplay) domElements.propPlaylistFilePathDisplay.textContent = '';
        if(domElements.propShufflePlaylistCheckbox) domElements.propShufflePlaylistCheckbox.checked = Boolean(cue.shufflePlaylist ?? cue.shuffle);
        if(domElements.propRepeatOnePlaylistItemCheckbox) domElements.propRepeatOnePlaylistItemCheckbox.checked = Boolean(cue.repeatOnePlaylistItem ?? cue.repeatOne);
        if(domElements.propPlaylistPlayModeSelect) domElements.propPlaylistPlayModeSelect.value = cue.playlistPlayMode || 'continue';
    } else {
        if(domElements.propFilePathInput) domElements.propFilePathInput.value = cue.relativePath || cue.filePath || '';
        if(domElements.propPlaylistItemsUl) domElements.propPlaylistItemsUl.innerHTML = '';
        setStagedPlaylistItems([]);
        currentWaveformTrimStart = cue.trimStartTime || 0;
        // Keep undefined/null if not explicitly set so waveform shows full length
        currentWaveformTrimEnd = (cue.trimEndTime !== undefined && cue.trimEndTime !== null) ? cue.trimEndTime : undefined;
        if (cue.filePath) {
            showWaveformForCue(cue);
        }
    }

    // Set fade times with validation
    const fadeInTime = cue.fadeInTime !== undefined ? Math.max(0, cue.fadeInTime) : (appConfig.defaultFadeInTime || 0);
    const fadeOutTime = cue.fadeOutTime !== undefined ? Math.max(0, cue.fadeOutTime) : (appConfig.defaultFadeOutTime || 0);
    if(domElements.propFadeInTimeInput) domElements.propFadeInTimeInput.value = fadeInTime;
    if(domElements.propFadeOutTimeInput) domElements.propFadeOutTimeInput.value = fadeOutTime;
    
    // Set loop with fallback
    if(domElements.propLoopCheckbox) domElements.propLoopCheckbox.checked = cue.loop !== undefined ? cue.loop : (appConfig.defaultLoopSingleCue || false);
    
    // Set volume with validation (0-1 range)
    const volume = validateVolume(cue.volume !== undefined ? cue.volume : appConfig.defaultVolume);
    if(domElements.propVolumeRangeInput) domElements.propVolumeRangeInput.value = volume;
    if(domElements.propVolumeValueSpan) domElements.propVolumeValueSpan.textContent = parseFloat(volume).toFixed(2);
    if(domElements.propVolumeSlider) domElements.propVolumeSlider.value = volume;
    if(domElements.propVolumeValueDisplay) domElements.propVolumeValueDisplay.textContent = parseFloat(volume).toFixed(2);
    
    // Set retrigger behavior with fallback
    if(domElements.propRetriggerBehaviorSelect) domElements.propRetriggerBehaviorSelect.value = cue.retriggerBehavior !== undefined ? cue.retriggerBehavior : (appConfig.defaultRetriggerBehavior || 'restart');

    // Set ducking controls with validation
    if (domElements.propEnableDuckingCheckbox) domElements.propEnableDuckingCheckbox.checked = !!cue.enableDucking;
    const duckingLevel = validateDuckingLevel(cue.duckingLevel);
    if (domElements.propDuckingLevelInput) domElements.propDuckingLevelInput.value = duckingLevel;
    if (domElements.propDuckingLevelValueSpan) domElements.propDuckingLevelValueSpan.textContent = duckingLevel;
    if (domElements.propIsDuckingTriggerCheckbox) {
        domElements.propIsDuckingTriggerCheckbox.checked = !!cue.isDuckingTrigger;
        updateDuckingControlsVisibility(domElements.propIsDuckingTriggerCheckbox.checked);
    }

    if (domElements.propTrimConfig && !isPlaylist) {
        domElements.propTrimConfig.style.display = 'block';
        if (domElements.propTrimStartTimeInput) domElements.propTrimStartTimeInput.value = formatWaveformTime(cue.trimStartTime || 0);
        if (domElements.propTrimEndTimeInput) domElements.propTrimEndTimeInput.value = (cue.trimEndTime !== undefined && cue.trimEndTime !== null) ? formatWaveformTime(cue.trimEndTime) : 'End';
    } else if (domElements.propTrimConfig) {
        domElements.propTrimConfig.style.display = 'none';
    }

    updateOutputPatchVisibility(domElements, appConfig);
    const patch = normalizeOutputPatch(cue.outputPatch, appConfig.audioOutputChannelCount || 2);
    if (domElements.propOutputPatchLeft) domElements.propOutputPatchLeft.value = String(patch[0]);
    if (domElements.propOutputPatchRight) domElements.propOutputPatchRight.value = String(patch[1]);
}

export {
    initFormManager,
    setCurrentWaveformTrim,
    getCurrentWaveformTrim,
    collectFormData,
    saveCueProperties,
    deleteCueProperties,
    populateFormWithCueData,
    updateOutputPatchVisibility,
};
