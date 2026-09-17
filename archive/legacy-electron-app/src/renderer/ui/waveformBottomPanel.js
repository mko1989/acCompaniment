// Companion_soundboard/src/renderer/ui/waveformBottomPanel.js

/**
 * Waveform Bottom Panel Module
 * Handles bottom panel expansion, sizing, and basic UI controls
 */

// Bottom panel state
let isBottomPanelExpanded = false;
let bottomPanelSize = 'normal'; // 'normal' or 'large'

// DOM elements for bottom panel
let bottomWaveformPanel = null;
let bottomPanelCueName = null;
let normalSizeBtn = null;
let largeSizeBtn = null;
let collapseBottomPanelBtn = null;
let expandWaveformBtn = null;

/**
 * Initialize the bottom panel module
 * @param {object} dependencies - Object containing DOM elements
 */
function initBottomPanel(dependencies) {
    bottomWaveformPanel = dependencies.bottomWaveformPanel;
    bottomPanelCueName = dependencies.bottomPanelCueName;
    normalSizeBtn = dependencies.normalSizeBtn;
    largeSizeBtn = dependencies.largeSizeBtn;
    collapseBottomPanelBtn = dependencies.collapseBottomPanelBtn;
    expandWaveformBtn = dependencies.expandWaveformBtn;
    
    console.log('WaveformBottomPanel: Initialized with DOM elements:', {
        panel: !!bottomWaveformPanel,
        cueName: !!bottomPanelCueName,
        normalBtn: !!normalSizeBtn,
        largeBtn: !!largeSizeBtn,
        collapseBtn: !!collapseBottomPanelBtn,
        expandBtn: !!expandWaveformBtn
    });
}

/**
 * Expand the bottom waveform panel for enhanced editing
 * @param {function} createExpandedWaveformCallback - Callback to create expanded waveform
 */
function expandBottomPanel(createExpandedWaveformCallback) {
    console.log('WaveformBottomPanel: expandBottomPanel called');
    
    if (!bottomWaveformPanel) {
        console.error('WaveformBottomPanel: bottomWaveformPanel not found');
        return;
    }
    
    // Update panel state
    isBottomPanelExpanded = true;
    
    // Update UI
    const panelHeight = bottomPanelSize === 'large' ? 450 : 400;
    bottomWaveformPanel.style.height = panelHeight + 'px';
    bottomWaveformPanel.style.display = 'flex';
    bottomWaveformPanel.classList.add('expanded');
    
    // Update panel title
    if (bottomPanelCueName) {
        bottomPanelCueName.textContent = 'Waveform Editor';
    }
    
    // Update size buttons
    updateSizeButtons();
    
    // Create expanded waveform if callback provided
    if (typeof createExpandedWaveformCallback === 'function') {
        console.log('WaveformBottomPanel: Calling createExpandedWaveform callback');
        createExpandedWaveformCallback();
    }
    
    console.log('WaveformBottomPanel: Bottom panel expanded successfully');
}

/**
 * Collapse the bottom waveform panel
 * @param {function} cleanupCallback - Callback to clean up expanded waveform
 */
function collapseBottomPanel(cleanupCallback) {
    console.log('WaveformBottomPanel: Collapsing bottom panel');
    
    // Update panel state
    isBottomPanelExpanded = false;
    
    // Clean up expanded waveform if callback provided
    if (typeof cleanupCallback === 'function') {
        cleanupCallback();
    }
    
    // Update UI
    if (bottomWaveformPanel) {
        bottomWaveformPanel.style.display = 'none';
        bottomWaveformPanel.classList.remove('expanded');
    }
    
    console.log('WaveformBottomPanel: Bottom panel collapsed');
}

/**
 * Set the bottom panel size
 * @param {string} size - 'normal' or 'large'
 */
function setBottomPanelSize(size) {
    if (size !== 'normal' && size !== 'large') {
        console.warn('WaveformBottomPanel: Invalid size, must be "normal" or "large"');
        return;
    }
    
    console.log('WaveformBottomPanel: Setting panel size to:', size);
    
    bottomPanelSize = size;
    
    // Update panel height if expanded
    if (isBottomPanelExpanded && bottomWaveformPanel) {
        const panelHeight = size === 'large' ? 450 : 400;
        bottomWaveformPanel.style.height = panelHeight + 'px';
    }
    
    // Update size buttons
    updateSizeButtons();
    
    console.log('WaveformBottomPanel: Panel size updated to:', size);
}

/**
 * Update the size button states
 * Note: Size buttons were removed from UI, keeping function for compatibility
 */
function updateSizeButtons() {
    // Size buttons were removed - this function is now a no-op
    // Keeping it to avoid breaking any existing code that calls it
    return;
}

/**
 * Bind event listeners for bottom panel controls
 */
function bindBottomPanelEvents() {
    console.log('WaveformBottomPanel: Binding bottom panel events');
    
    if (normalSizeBtn) {
        normalSizeBtn.addEventListener('click', () => {
            console.log('WaveformBottomPanel: Normal size button clicked');
            setBottomPanelSize('normal');
        });
        console.log('WaveformBottomPanel: Normal size button listener bound');
    }
    // Note: normalSizeBtn and largeSizeBtn have been removed from UI, so no warning needed
    
    if (largeSizeBtn) {
        largeSizeBtn.addEventListener('click', () => {
            console.log('WaveformBottomPanel: Large size button clicked');
            setBottomPanelSize('large');
        });
        console.log('WaveformBottomPanel: Large size button listener bound');
    }
    
    if (collapseBottomPanelBtn) {
        collapseBottomPanelBtn.addEventListener('click', () => {
            console.log('WaveformBottomPanel: Collapse button clicked');
            // Call the waveform controls collapse function which handles cleanup
            if (typeof window.waveformControlsCollapseBottomPanel === 'function') {
                window.waveformControlsCollapseBottomPanel();
            } else {
                console.warn('WaveformBottomPanel: waveformControlsCollapseBottomPanel not available');
                collapseBottomPanel(); // Fallback to basic collapse
            }
        });
        console.log('WaveformBottomPanel: Collapse button listener bound');
    } else {
        console.warn('WaveformBottomPanel: collapseBottomPanelBtn not found');
    }
    
    if (expandWaveformBtn) {
        expandWaveformBtn.addEventListener('click', () => {
            console.log('WaveformBottomPanel: Expand button clicked');
            // Call the waveform controls expand function which handles waveform creation
            if (typeof window.waveformControlsExpandBottomPanel === 'function') {
                window.waveformControlsExpandBottomPanel();
            } else {
                console.warn('WaveformBottomPanel: waveformControlsExpandBottomPanel not available');
                expandBottomPanel(); // Fallback to basic expansion
            }
        });
        console.log('WaveformBottomPanel: Expand button listener bound');
    } else {
        console.warn('WaveformBottomPanel: expandWaveformBtn not found');
    }
}

/**
 * Unbind event listeners for bottom panel controls
 */
function unbindBottomPanelEvents() {
    console.log('WaveformBottomPanel: Unbinding bottom panel events');
    
    if (normalSizeBtn) {
        normalSizeBtn.removeEventListener('click', () => setBottomPanelSize('normal'));
    }
    
    if (largeSizeBtn) {
        largeSizeBtn.removeEventListener('click', () => setBottomPanelSize('large'));
    }
    
    if (collapseBottomPanelBtn) {
        collapseBottomPanelBtn.removeEventListener('click', collapseBottomPanel);
    }
    
    if (expandWaveformBtn) {
        expandWaveformBtn.removeEventListener('click', expandBottomPanel);
    }
}

/**
 * Get the current bottom panel state
 * @returns {boolean} Whether the panel is expanded
 */
function getBottomPanelState() {
    return isBottomPanelExpanded;
}

/**
 * Get the current bottom panel size
 * @returns {string} Current panel size ('normal' or 'large')
 */
function getBottomPanelSize() {
    return bottomPanelSize;
}

/**
 * Check if the bottom panel is expanded
 * @returns {boolean} True if expanded
 */
function isExpanded() {
    return isBottomPanelExpanded;
}

export {
    initBottomPanel,
    expandBottomPanel,
    collapseBottomPanel,
    setBottomPanelSize,
    updateSizeButtons,
    bindBottomPanelEvents,
    unbindBottomPanelEvents,
    getBottomPanelState,
    getBottomPanelSize,
    isExpanded
};
