/**
 * Utility Functions for Properties Sidebar
 * Contains helper functions and utility methods
 */

/**
 * Populate a generic dropdown with numeric options
 * @param {HTMLSelectElement} selectElement - The select element to populate
 * @param {number} start - Starting number
 * @param {number} end - Ending number
 * @param {string} prefix - Prefix for values (default: '')
 * @param {string} currentValStr - Current value to select
 * @param {string} placeholderText - Placeholder text (default: "-- Select --")
 */
function populateGenericDropdown(selectElement, start, end, prefix = '', currentValStr, placeholderText = "-- Select --") {
    console.log('[PropertiesSidebar populateGenericDropdown] Called with:', {
        selectElement: selectElement ? selectElement.id : 'NULL',
        start,
        end,
        prefix,
        currentValStr,
        placeholderText
    });
    
    if (!selectElement) {
        console.log('[PropertiesSidebar populateGenericDropdown] selectElement is null, returning');
        return;
    }
    
    const preservedValue = selectElement.value;
    console.log('[PropertiesSidebar populateGenericDropdown] preservedValue:', preservedValue);
    
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

    console.log('[PropertiesSidebar populateGenericDropdown] Options created:', 
        Array.from(selectElement.options).map(opt => ({value: opt.value, text: opt.textContent})));

    if (currentValStr && Array.from(selectElement.options).some(opt => opt.value === currentValStr)) {
        console.log('[PropertiesSidebar populateGenericDropdown] Setting value to currentValStr:', currentValStr);
        selectElement.value = currentValStr;
    } else if (placeholderText) {
        console.log('[PropertiesSidebar populateGenericDropdown] Setting value to placeholder (empty)');
        selectElement.value = ""; // Default to placeholder if no currentValStr or preservedValue matches
    } else if (preservedValue && Array.from(selectElement.options).some(opt => opt.value === preservedValue)) {
        console.log('[PropertiesSidebar populateGenericDropdown] Setting value to preservedValue:', preservedValue);
        selectElement.value = preservedValue;
    } else if (selectElement.options.length > 0) {
        console.log('[PropertiesSidebar populateGenericDropdown] Setting value to first option');
        selectElement.selectedIndex = 0; // Fallback to the first option if no other condition met
    }
    
    console.log('[PropertiesSidebar populateGenericDropdown] Final value:', selectElement.value);
}

/**
 * Get the element that should come after a dragged element based on mouse position
 * @param {HTMLElement} container - The container element
 * @param {number} y - Mouse Y position
 * @returns {HTMLElement|null} The element to insert after, or null for end
 */
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('li.playlist-item:not(.dragging-playlist-item)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
        else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/**
 * Validate and normalize trim values
 * @param {number} trimStart - Start time
 * @param {number} trimEnd - End time
 * @returns {Object} Normalized trim values
 */
function normalizeTrimValues(trimStart, trimEnd) {
    let normalizedTrimStart = Math.max(0, trimStart || 0); // Ensure non-negative
    let normalizedTrimEnd = (trimEnd !== undefined && trimEnd !== null) ? trimEnd : undefined;
    
    // Validate trim values
    if (normalizedTrimEnd !== undefined) {
        if (normalizedTrimEnd <= normalizedTrimStart || normalizedTrimEnd < 0) {
            // Invalid or zero-length; treat as "no end trim"
            console.warn(`[PropertiesSidebar] Invalid trim end time (${normalizedTrimEnd}), removing end trim`);
            normalizedTrimEnd = undefined;
        }
    }
    
    return { normalizedTrimStart, normalizedTrimEnd };
}

/**
 * Validate and sanitize cue name
 * @param {string} cueName - Raw cue name
 * @param {string} fallbackId - Fallback ID if name is empty
 * @returns {string} Validated cue name
 */
function validateCueName(cueName, fallbackId) {
    const trimmedName = cueName ? cueName.trim() : '';
    if (!trimmedName) {
        console.warn('[PropertiesSidebar] Cue name is empty, using default');
        return `Cue ${fallbackId}`;
    }
    return trimmedName;
}

/**
 * Validate volume value to ensure it's within 0-1 range
 * @param {number} volume - Volume value to validate
 * @returns {number} Validated volume value
 */
function validateVolume(volume) {
    return Math.max(0, Math.min(1, volume || 1));
}

/**
 * Validate ducking level to ensure it's within 0-100 range
 * @param {number} level - Ducking level to validate
 * @returns {number} Validated ducking level
 */
function validateDuckingLevel(level) {
    return Math.max(0, Math.min(100, level || 80));
}

/**
 * Validate fade time to ensure it's non-negative
 * @param {number} time - Fade time to validate
 * @returns {number} Validated fade time
 */
function validateFadeTime(time) {
    return Math.max(0, time || 0);
}

export {
    populateGenericDropdown,
    getDragAfterElement,
    normalizeTrimValues,
    validateCueName,
    validateVolume,
    validateDuckingLevel,
    validateFadeTime
};
