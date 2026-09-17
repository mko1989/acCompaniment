// acCompaniment/src/frontend/ui/configSidebar.js
// Config sidebar open/close state. (There is no separate sidebars.js here -
// that legacy module was superseded by this file plus propertiesSidebar*.js.)

// --- Initialization ---
function initConfigSidebar(/* any dependencies like uiCore can be passed here if needed */) {
    console.log('Config Sidebar Module Initialized');
}

// --- Config Sidebar Specific Functions ---
function toggleConfigSidebar() {
    const el = document.getElementById('configSidebar');
    if (el) {
        const isCollapsed = el.classList.contains('collapsed');
        setConfigSidebarOpen(isCollapsed);
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
