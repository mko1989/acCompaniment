// acCompaniment/src/renderer/ui/configSidebar.js

// This module provides a wrapper interface for config sidebar functionality
// The actual implementation is handled by sidebars.js to avoid duplication

// --- Initialization ---
function initConfigSidebar(/* any dependencies like uiCore can be passed here if needed */) {
    // Config sidebar functionality is handled by sidebars.js
    // This is just a placeholder to maintain the existing API
    console.log('Config Sidebar Module Initialized (delegated to sidebars.js)');
}

// --- Config Sidebar Specific Functions ---
function toggleConfigSidebar() {
    // Delegate to the sidebars module if available
    // This prevents duplicate event listeners and functionality
    const sidebarsModule = window.uiModules?.sidebars;
    if (sidebarsModule && sidebarsModule.toggleConfigSidebar) {
        console.log('ConfigSidebar: Delegating toggle to sidebars module');
        sidebarsModule.toggleConfigSidebar();
    } else {
        // Fallback: direct DOM manipulation if sidebars module not available
        console.log('ConfigSidebar: Using fallback toggle - sidebars module not available');
        const configSidebar = document.getElementById('configSidebar');
        if (configSidebar) {
            configSidebar.classList.toggle('collapsed');
            console.log('ConfigSidebar: Toggled config sidebar collapsed class');
        } else {
            console.error('ConfigSidebar: configSidebar element not found');
        }
    }
}

// --- Exports ---
export {
    initConfigSidebar,
    toggleConfigSidebar
}; 