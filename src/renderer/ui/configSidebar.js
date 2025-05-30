// acCompaniment/src/renderer/ui/configSidebar.js

// --- DOM Elements for Config Sidebar ---
let configSidebar;
let configToggleBtn;

// --- Initialization ---
function initConfigSidebar(/* any dependencies like uiCore can be passed here if needed */) {
    cacheConfigSidebarDOMElements();
    bindConfigSidebarEventListeners();
    console.log('Config Sidebar Module Initialized');
}

function cacheConfigSidebarDOMElements() {
    configSidebar = document.getElementById('configSidebar');
    configToggleBtn = document.getElementById('configToggleBtn');
}

function bindConfigSidebarEventListeners() {
    if (configToggleBtn) {
        configToggleBtn.addEventListener('click', toggleConfigSidebar);
    }
}

// --- Config Sidebar Specific Functions ---
function toggleConfigSidebar() {
    if (configSidebar) {
        configSidebar.classList.toggle('collapsed');
    }
}

// --- Exports ---
export {
    initConfigSidebar,
    toggleConfigSidebar
}; 