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
    const sidebarsModule = window.uiModules?.sidebars;
    if (sidebarsModule && sidebarsModule.toggleConfigSidebar) {
        sidebarsModule.toggleConfigSidebar();
    } else {
        const el = document.getElementById('configSidebar');
        if (el) {
            const isCollapsed = el.classList.contains('collapsed');
            setConfigSidebarOpen(isCollapsed);
        }
    }
}

/** Set config sidebar open (true) or closed (false). Used by close button and uiAPI.toggleSidebar. */
function setConfigSidebarOpen(open) {
    const el = document.getElementById('configSidebar');
    if (!el) return;
    if (open) {
        el.classList.remove('collapsed');
        el.classList.add('expanded');
    } else {
        el.classList.add('collapsed');
        el.classList.remove('expanded');
    }
}

// --- Exports ---
export {
    initConfigSidebar,
    toggleConfigSidebar,
    setConfigSidebarOpen
}; 