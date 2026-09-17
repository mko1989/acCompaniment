// Companion_soundboard/src/renderer/dragDropHandler.js
// Manages global drag and drop functionality.

let uiRef;
let cueStoreRef; // May not be strictly needed if uiRef handles all cue data interactions

function init(uiModule, cueStoreModule) {
    uiRef = uiModule;
    cueStoreRef = cueStoreModule;
    setupGlobalDragDropListeners();
    console.log('DragDropHandler Initialized');
}

function setupGlobalDragDropListeners() {
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
}

function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    // Optionally, provide visual feedback on the current element being hovered over
    // e.g., event.target.classList.add('drag-over-active');
    // However, ui.js might handle more specific drop-target highlighting.
    // General indication that a drag is in progress on the window can be useful.
    document.body.classList.add('app-drag-over'); 
}

function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    // Optionally, remove visual feedback
    // e.g., event.target.classList.remove('drag-over-active');
    // Check if the leave event is not just moving to a child element
    // More robust check: if relatedTarget is null or not within the document body
    if (event.relatedTarget === null || 
        !document.body.contains(event.relatedTarget) || 
        event.relatedTarget === document.documentElement) {
        document.body.classList.remove('app-drag-over');
    }
}

function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.remove('app-drag-over');

    const files = event.dataTransfer.files;
    const dropTargetElement = event.target; // The actual element the drop occurred on

    try {
        if (files.length === 1) {
            const filePath = files[0].path || files[0].name; // Fallback to name if path not available
            console.log('DragDropHandler: Single file dropped:', filePath, 'on target:', dropTargetElement);
            if (uiRef && typeof uiRef.handleSingleFileDrop === 'function') {
                uiRef.handleSingleFileDrop(filePath, dropTargetElement);
            } else {
                console.warn('DragDropHandler: uiRef or uiRef.handleSingleFileDrop not available.');
            }
        } else if (files.length > 1) {
            const filePaths = Array.from(files).map(f => f.path || f.name); // Fallback to name if path not available
            console.log('DragDropHandler: Multiple files dropped:', filePaths, 'on target:', dropTargetElement);
            if (uiRef && typeof uiRef.handleMultipleFileDrop === 'function') {
                // Pass the FileList object directly, not just paths, as we might need file names too
                uiRef.handleMultipleFileDrop(files, dropTargetElement);
            } else {
                console.warn('DragDropHandler: uiRef or uiRef.handleMultipleFileDrop not available.');
            }
        } else {
            console.log('DragDropHandler: Drop event with no files.');
        }
    } catch (error) {
        console.error('DragDropHandler: Error handling drop event:', error);
    }
}

// Cleanup function if ever needed to remove listeners
function destroy() {
    window.removeEventListener('dragover', handleDragOver);
    window.removeEventListener('dragleave', handleDragLeave);
    window.removeEventListener('drop', handleDrop);
    document.body.classList.remove('app-drag-over');
    console.log('DragDropHandler Destroyed');
}

export { init, destroy }; 