const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer to Main (one-way)
  send: (channel, data) => {
    ipcRenderer.send(channel, data);
  },
  // Renderer to Main (two-way)
  invoke: (channel, data) => {
    return ipcRenderer.invoke(channel, data);
  },
  // Main to Renderer
  on: (channel, func) => {
    const subscription = (event, ...args) => func(...args);
    ipcRenderer.on(channel, subscription);
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },
  // Drag and Drop specific - THIS IS LIKELY OBSOLETE OR NEEDS REVISITING
  // getDroppedFilePaths: (callback) => ipcRenderer.on('dropped-files', (event, filePaths) => callback(filePaths)),
  // UUID Generation
  generateUUID: () => ipcRenderer.invoke('generate-uuid')
});

// REMOVE THE FOLLOWING DOMContentLoaded LISTENER AND ITS CONTENTS
/*
document.addEventListener('DOMContentLoaded', () => {
  const dragArea = document.body; // Or a more specific element

  dragArea.addEventListener('dragover', (event) => {
    event.preventDefault(); // Necessary to allow drop
    event.stopPropagation();
    // Add visual cues if desired
  });

  dragArea.addEventListener('dragleave', (event) => {
    // Remove visual cues if desired
  });

  dragArea.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const files = event.dataTransfer.files;
    if (files.length > 0) {
      const filePaths = Array.from(files).map(file => file.path);
      console.log('Files dropped in preload (will be sent to main - THIS LOGIC IS BEING REMOVED):', filePaths);
      // Send file paths to the main process to then be relayed to renderer
      // This is a more secure way than directly accessing fs in renderer
      // ipcRenderer.send('files-dropped-in-preload', filePaths); // THIS LINE IS REMOVED
    }
  });
});
*/

console.log('Preload script loaded (Drag/drop listeners removed from preload)'); 