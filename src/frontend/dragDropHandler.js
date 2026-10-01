// Companion_soundboard/src/renderer/dragDropHandler.js
// Manages global drag and drop functionality.
// Adapted from Electron version to work in browser environment.

let uiRef;
let cueStoreRef; // May not be strictly needed if uiRef handles all cue data interactions
let appConfigUIRef; // For accessing app config defaults
let modalsRef; // For showing modals

function init(uiModule, cueStoreModule, appConfigUIModule, modalsModule) {
    uiRef = uiModule;
    cueStoreRef = cueStoreModule;
    appConfigUIRef = appConfigUIModule;
    modalsRef = modalsModule;
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
    // Only a drag carrying files gets the "drop audio files here" overlay -
    // dragging a cue button to reorder the grid fires dragover here too.
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
    if (types.includes('Files')) {
        document.body.classList.add('app-drag-over');
    }
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

async function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.remove('app-drag-over');

    const files = event.dataTransfer.files;
    const dropTargetElement = event.target; // The actual element the drop occurred on

    try {
        if (files.length === 1) {
            const file = files[0];
            console.log('DragDropHandler: Single file dropped:', file.name, 'on target:', dropTargetElement);
            
            // In browser, we need to upload the file first, then create a cue
            if (uiRef && typeof uiRef.handleSingleFileDrop === 'function') {
                // Pass the File object directly - UI module will handle upload
                uiRef.handleSingleFileDrop(file, dropTargetElement);
            } else {
                // Fallback: handle directly if UI module not available
                console.warn('DragDropHandler: uiRef or uiRef.handleSingleFileDrop not available. Handling directly.');
                await handleSingleFileDropDirect(file);
            }
        } else if (files.length > 1) {
            const fileArray = Array.from(files);
            console.log('DragDropHandler: Multiple files dropped:', fileArray.map(f => f.name), 'on target:', dropTargetElement);
            
            if (uiRef && typeof uiRef.handleMultipleFileDrop === 'function') {
                // Pass the FileList/Array directly - UI module will handle upload
                uiRef.handleMultipleFileDrop(files, dropTargetElement);
            } else {
                // Fallback: handle directly if UI module not available
                console.warn('DragDropHandler: uiRef or uiRef.handleMultipleFileDrop not available. Handling directly.');
                await handleMultipleFileDropDirect(fileArray);
            }
        } else {
            console.log('DragDropHandler: Drop event with no files.');
        }
    } catch (error) {
        console.error('DragDropHandler: Error handling drop event:', error);
    }
}

// Direct file handling when UI module is not available
async function handleSingleFileDropDirect(file) {
    try {
        console.log('DragDropHandler: Handling single file drop directly:', file.name);
        
        // Upload file to server
        const formData = new FormData();
        formData.append('audioFile', file);
        formData.append('name', file.name.replace(/\.[^/.]+$/, "")); // Remove extension
        
        const uploadResponse = await fetch('/api/audio/upload', {
            method: 'POST',
            body: formData
        });
        
        const uploadResult = await uploadResponse.json();
        
        if (!uploadResult.success) {
            throw new Error(uploadResult.error || 'Failed to upload audio file');
        }
        
        console.log('DragDropHandler: Audio file uploaded:', uploadResult.audioFile.id);
        
        // Get current app config for defaults
        const appConfig = appConfigUIRef && typeof appConfigUIRef.getCurrentConfig === 'function' 
            ? appConfigUIRef.getCurrentConfig() 
            : {};
        
        // Create a cue object from the uploaded file
        const cueData = {
            name: file.name.replace(/\.[^/.]+$/, ""), // Remove extension
            type: 'single_file',
            audioFileId: uploadResult.audioFile.id,
            relativePath: uploadResult.audioFile.relativePath,
            fadeInTime: appConfig.defaultFadeInTime || 0,
            fadeOutTime: appConfig.defaultFadeOutTime || 0,
            loop: appConfig.defaultLoopSingleCue || false,
            volume: appConfig.defaultVolume || 1.0,
            retriggerBehavior: appConfig.defaultRetriggerBehavior || 'restart'
        };
        
        // Create cue via cueStore
        if (cueStoreRef && typeof cueStoreRef.addOrUpdateCue === 'function') {
            const result = await cueStoreRef.addOrUpdateCue(cueData);
            if (result && result.success) {
                console.log('DragDropHandler: Single cue created successfully');
            } else {
                throw new Error(result?.error || 'Failed to create cue');
            }
        } else {
            throw new Error('cueStoreRef.addOrUpdateCue not available');
        }
        
    } catch (error) {
        console.error('DragDropHandler: Error handling single file drop:', error);
        alert(`Error creating cue from file: ${error.message}`);
    }
}

// Direct multiple file handling when UI module is not available
async function handleMultipleFileDropDirect(files) {
    try {
        console.log('DragDropHandler: Handling multiple file drop directly:', files.length, 'files');
        
        // Show modal to ask user if they want separate cues or a playlist
        if (modalsRef && typeof modalsRef.showMultipleFilesDropModal === 'function') {
            // Use modal to get user choice
            modalsRef.showMultipleFilesDropModal(files, async (choice) => {
                if (choice === 'separate') {
                    // Create individual cues for each file
                    for (const file of files) {
                        await handleSingleFileDropDirect(file);
                    }
                } else if (choice === 'playlist') {
                    // Upload all files first
                    const uploadedFiles = [];
                    for (const file of files) {
                        const formData = new FormData();
                        formData.append('audioFile', file);
                        formData.append('name', file.name.replace(/\.[^/.]+$/, ""));
                        
                        const uploadResponse = await fetch('/api/audio/upload', {
                            method: 'POST',
                            body: formData
                        });
                        
                        const uploadResult = await uploadResponse.json();
                        
                        if (uploadResult.success) {
                            uploadedFiles.push(uploadResult.audioFile);
                        } else {
                            console.error(`DragDropHandler: Failed to upload ${file.name}:`, uploadResult.error);
                        }
                    }
                    
                    // Get current app config for defaults
                    const appConfig = appConfigUIRef && typeof appConfigUIRef.getCurrentConfig === 'function' 
                        ? appConfigUIRef.getCurrentConfig() 
                        : {};
                    
                    // Create a single playlist cue
                    const playlistData = {
                        name: `Playlist (${uploadedFiles.length} files)`,
                        type: 'playlist',
                        playlistItems: uploadedFiles.map(audioFile => ({
                            name: audioFile.name,
                            relativePath: audioFile.relativePath,
                            audioFileId: audioFile.id
                        })),
                        fadeInTime: appConfig.defaultFadeInTime || 0,
                        fadeOutTime: appConfig.defaultFadeOutTime || 0,
                        loop: appConfig.defaultLoopSingleCue || false,
                        volume: appConfig.defaultVolume || 1.0,
                        retriggerBehavior: appConfig.defaultRetriggerBehavior || 'restart',
                        shufflePlaylist: false,
                        repeatOnePlaylistItem: false,
                        playlistPlayMode: 'continue'
                    };
                    
                    // Create playlist cue via cueStore
                    if (cueStoreRef && typeof cueStoreRef.addOrUpdateCue === 'function') {
                        const result = await cueStoreRef.addOrUpdateCue(playlistData);
                        if (result && result.success) {
                            console.log('DragDropHandler: Playlist cue created successfully');
                        } else {
                            throw new Error(result?.error || 'Failed to create playlist cue');
                        }
                    } else {
                        throw new Error('cueStoreRef.addOrUpdateCue not available');
                    }
                }
            });
        } else {
            // Fallback: create separate cues if modal not available
            console.warn('DragDropHandler: Modal not available, creating separate cues for all files');
            for (const file of files) {
                await handleSingleFileDropDirect(file);
            }
        }
        
    } catch (error) {
        console.error('DragDropHandler: Error handling multiple file drop:', error);
        alert(`Error creating cues from files: ${error.message}`);
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

