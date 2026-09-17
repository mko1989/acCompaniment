const WebSocket = require('ws');

class WebSocketManager {
    constructor(wss) {
        this.wss = wss;
        this.clients = new Set();
        this.cueManager = null;
        this.appConfigManager = null;
        this.audioFileManager = null;
        
        this.setupWebSocketServer();
    }
    
    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            console.log(`WebSocketManager: New client connected from ${req.socket.remoteAddress}`);
            
            this.clients.add(ws);
            
            // Send initial data
            this.sendInitialData(ws);
            
            ws.on('message', (message) => {
                this.handleMessage(ws, message);
            });
            
            ws.on('close', () => {
                console.log('WebSocketManager: Client disconnected');
                this.clients.delete(ws);
            });
            
            ws.on('error', (error) => {
                console.error('WebSocketManager: Client error:', error);
                this.clients.delete(ws);
            });
        });
        
        console.log('WebSocketManager: WebSocket server ready');
    }
    
    setCueManager(cueManager) {
        this.cueManager = cueManager;
    }
    
    setAppConfigManager(appConfigManager) {
        this.appConfigManager = appConfigManager;
    }
    
    setAudioFileManager(audioFileManager) {
        this.audioFileManager = audioFileManager;
    }
    
    async sendInitialData(ws) {
        try {
            if (!this.cueManager) return;
            
            // Send current cues with resolved file paths
            const cues = await this.resolveCueFilePaths(this.cueManager.getCues());
            this.sendToClient(ws, {
                type: 'cues-updated',
                payload: { cues: cues }
            });
            
            // Send current playing states
            const playbackStatus = this.cueManager.getPlaybackStatus();
            if (playbackStatus.playingCues && playbackStatus.playingCues.length > 0) {
                playbackStatus.playingCues.forEach(cueId => {
                    this.sendToClient(ws, {
                        type: 'cue_status',
                        payload: { 
                            cueId: cueId, 
                            status: 'playing',
                            currentTime: 0,
                            totalTime: 0
                        }
                    });
                });
            }
            
            // Send current configuration
            const config = this.appConfigManager ? this.appConfigManager.getConfig() : (this.cueManager ? this.cueManager.getConfig() : {});
            this.sendToClient(ws, {
                type: 'config-updated',
                payload: { config: config }
            });
            
            // Send current workspace info
            const workspace = this.cueManager ? this.cueManager.getCurrentWorkspace() : null;
            if (workspace) {
                this.sendToClient(ws, {
                    type: 'workspace-updated',
                    payload: { workspace: workspace }
                });
            }
            
        } catch (error) {
            console.error('WebSocketManager: Error sending initial data:', error);
        }
    }
    
    async handleMessage(ws, message) {
        try {
            const data = JSON.parse(message.toString());
            console.log('WebSocketManager: Received message:', data.type, 'requestId:', data.requestId);
            
            // Check if this is an invoke-style message (has requestId)
            const isInvoke = data.requestId !== undefined && data.requestId !== null;
            
            // Handle invoke-style messages (request/response pattern)
            if (isInvoke) {
                console.log('WebSocketManager: Handling invoke message:', data.type);
                await this.handleInvokeMessage(ws, data);
                return;
            }
            
            // Handle regular messages (event-style)
            switch (data.type) {
                case 'trigger_cue':
                    await this.handleTriggerCue(ws, data.payload);
                    break;
                    
                case 'toggle_cue':
                    await this.handleToggleCue(ws, data.payload);
                    break;
                    
                case 'play_cue':
                    await this.handlePlayCue(ws, data.payload);
                    break;
                    
                case 'stop_cue':
                    await this.handleStopCue(ws, data.payload);
                    break;
                    
                case 'stop_all_cues':
                    await this.handleStopAllCues(ws, data.payload);
                    break;
                    
                case 'playlist_navigate':
                    await this.handlePlaylistNavigate(ws, data.payload);
                    break;
                    
                case 'update_cue':
                    await this.handleUpdateCue(ws, data.payload);
                    break;
                    
                case 'delete_cue':
                    await this.handleDeleteCue(ws, data.payload);
                    break;
                    
                case 'create_cue':
                    await this.handleCreateCue(ws, data.payload);
                    break;
                    
                case 'ping':
                    this.sendToClient(ws, { type: 'pong' });
                    break;
                    
                case 'cue-status-update':
                    // Informational message from frontend - no response needed
                    // Just log it for debugging
                    if (data.payload && data.payload.cueId) {
                        console.log(`WebSocketManager: Cue status update: ${data.payload.cueId} -> ${data.payload.status}`);
                    }
                    break;
                    
                case 'playback-time-update':
                    // Broadcast playback time updates to all clients (including sender)
                    // This allows the UI to update in real-time
                    if (data.payload) {
                        this.broadcast({
                            type: 'playback-time-update',
                            payload: data.payload
                        });
                    }
                    break;
                    
                case 'cue-duration-update':
                    // Informational message from frontend - no response needed
                    // Just log it for debugging
                    if (data.payload && data.payload.cueId) {
                        console.log(`WebSocketManager: Cue duration update: ${data.payload.cueId} -> ${data.payload.duration}s`);
                    }
                    break;
                    
                default:
                    console.warn('WebSocketManager: Unknown message type:', data.type);
            }
            
        } catch (error) {
            console.error('WebSocketManager: Error handling message:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Invalid message format' }
            });
        }
    }
    
    async handleInvokeMessage(ws, data) {
        const { type, requestId, payload } = data;
        
        try {
            let result = null;
            let error = null;
            
            switch (type) {
                case 'get-app-config':
                    if (this.appConfigManager) {
                        result = this.appConfigManager.getConfig();
                    } else {
                        error = 'AppConfigManager not available';
                    }
                    break;
                    
                case 'save-app-config':
                    if (this.appConfigManager && payload) {
                        const prevConfig = this.appConfigManager.getConfig();
                        const updateResult = await this.appConfigManager.updateConfig(payload);
                        result = { success: updateResult.success };
                        if (updateResult.success) {
                            this.broadcastConfigUpdate(this.appConfigManager.getConfig());
                            if (this.cueManager) {
                                this.cueManager.setConfig(this.appConfigManager.getConfig());
                                const nextConfig = this.appConfigManager.getConfig();
                                const audioChanged = [
                                    'audioOutputDeviceId',
                                    'audioOutputChannelCount',
                                    'audioSampleRate',
                                    'audioBufferSize',
                                ].some((key) => prevConfig?.[key] !== nextConfig?.[key]);
                                if (audioChanged) {
                                    await this.cueManager.applyAudioEngineConfig();
                                }
                            }
                        }
                    } else {
                        error = 'AppConfigManager not available or invalid payload';
                    }
                    break;
                    
                case 'get-cues':
                    if (this.cueManager) {
                        // Resolve file paths before returning
                        result = await this.resolveCueFilePaths(this.cueManager.getCues());
                    } else {
                        error = 'CueManager not available';
                    }
                    break;
                    
                case 'add-or-update-cue':
                    if (this.cueManager && payload) {
                        // Check if cue has an ID - if not, it's a new cue
                        if (payload.id && payload.id !== 'new') {
                            const updateResult = await this.cueManager.updateCue(payload.id, payload);
                            result = { success: updateResult.success, cue: updateResult.cue };
                        } else {
                            const createResult = await this.cueManager.createCue(payload);
                            result = { success: createResult.success, cue: createResult.cue };
                        }
                    } else {
                        error = 'CueManager not available or invalid payload';
                    }
                    break;
                    
                case 'generate-uuid':
                    const { v4: uuidv4 } = require('uuid');
                    result = uuidv4();
                    break;
                    
                case 'get-media-duration':
                    if (this.audioFileManager && payload && payload.filePath) {
                        try {
                            // Try to get duration from audio file metadata
                            // First try with relative path
                            let audioFile = await this.audioFileManager.getAudioFileByPath(payload.filePath);
                            
                            // If not found, try with absolute path
                            if (!audioFile && payload.filePath.startsWith('/')) {
                                // Try to resolve as relative path
                                const path = require('path');
                                const pathManager = this.audioFileManager.pathManager;
                                const relativePath = pathManager.toRelativePath(payload.filePath);
                                if (relativePath) {
                                    audioFile = await this.audioFileManager.getAudioFileByPath(relativePath);
                                }
                            }
                            
                            if (audioFile && audioFile.metadata && audioFile.metadata.duration) {
                                result = audioFile.metadata.duration;
                            } else if (audioFile && audioFile.duration) {
                                // Check if duration is directly on audioFile
                                result = audioFile.duration;
                            } else {
                                // Try to load metadata directly from file path
                                const validation = await this.audioFileManager.validateAudioFile(payload.filePath);
                                if (validation.valid && validation.metadata && validation.metadata.duration) {
                                    result = validation.metadata.duration;
                                } else {
                                    error = 'Could not determine duration';
                                }
                            }
                        } catch (err) {
                            console.error('WebSocketManager: Error getting media duration:', err);
                            error = `Error getting duration: ${err.message}`;
                        }
                    } else {
                        error = 'AudioFileManager not available or invalid payload';
                    }
                    break;
                    
                case 'get-http-remote-info':
                    if (this.appConfigManager) {
                        const config = this.appConfigManager.getConfig();
                        const interfaces = this.appConfigManager.getNetworkInterfaces();
                        result = {
                            enabled: config.httpRemoteEnabled !== false,
                            port: config.httpRemotePort || 3000,
                            interfaces: interfaces.map(iface => ({
                                interface: iface.name,
                                url: iface.httpUrl
                            }))
                        };
                    } else {
                        error = 'AppConfigManager not available';
                    }
                    break;
                    
                case 'delete-cue':
                    if (this.cueManager) {
                        const cueId = typeof payload === 'string' ? payload : (payload && payload.cueId);
                        if (cueId) {
                            const deleteResult = await this.cueManager.deleteCue(cueId);
                            result = { success: deleteResult.success, error: deleteResult.error };
                        } else {
                            error = 'Cue ID required for delete';
                        }
                    } else {
                        error = 'CueManager not available';
                    }
                    break;
                    
                default:
                    error = `Unknown invoke message type: ${type}`;
            }
            
            // Send response
            if (error) {
                this.sendToClient(ws, {
                    type: `${type}_response`,
                    requestId: requestId,
                    error: error
                });
            } else {
                this.sendToClient(ws, {
                    type: `${type}_response`,
                    requestId: requestId,
                    payload: result
                });
            }
            
        } catch (err) {
            console.error(`WebSocketManager: Error handling invoke message ${type}:`, err);
            this.sendToClient(ws, {
                type: `${type}_response`,
                requestId: requestId,
                error: err.message || 'Unknown error'
            });
        }
    }
    
    async handleTriggerCue(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId) return;
            
            const result = await this.cueManager.triggerCue(payload.cueId, {
                source: 'websocket',
                clientId: ws._clientId
            });
            
            this.sendToClient(ws, {
                type: 'cue_triggered',
                payload: { 
                    cueId: payload.cueId,
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error triggering cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to trigger cue' }
            });
        }
    }
    
    async handleToggleCue(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId) return;
            
            // Use the proper toggle method that handles retrigger behavior
            const result = await this.cueManager.toggleCue(payload.cueId, {
                retriggerBehavior: payload.retriggerBehavior,
                fromCompanion: payload.fromCompanion || false,
                source: 'websocket',
                clientId: ws._clientId
            });
            
            this.sendToClient(ws, {
                type: 'cue_toggled',
                payload: { 
                    cueId: payload.cueId,
                    success: result.success,
                    status: result.status,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error toggling cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to toggle cue' }
            });
        }
    }
    
    async handlePlayCue(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId) return;
            
            const result = await this.cueManager.triggerCue(payload.cueId, {
                source: 'websocket',
                clientId: ws._clientId
            });
            
            this.sendToClient(ws, {
                type: 'cue_played',
                payload: { 
                    cueId: payload.cueId,
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error playing cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to play cue' }
            });
        }
    }
    
    async handleStopCue(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId) return;
            
            const result = await this.cueManager.stopCue(payload.cueId, payload.fadeOut);
            
            this.sendToClient(ws, {
                type: 'cue_stopped',
                payload: { 
                    cueId: payload.cueId,
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error stopping cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to stop cue' }
            });
        }
    }
    
    async handleStopAllCues(ws, payload) {
        try {
            if (!this.cueManager) return;
            
            const result = await this.cueManager.stopAllCues(payload?.behavior);
            
            this.sendToClient(ws, {
                type: 'all_cues_stopped',
                payload: { 
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error stopping all cues:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to stop all cues' }
            });
        }
    }
    
    async handlePlaylistNavigate(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId || !payload.direction) return;
            
            const result = await this.cueManager.navigatePlaylist(payload.cueId, payload.direction);
            
            this.sendToClient(ws, {
                type: 'playlist_navigated',
                payload: { 
                    cueId: payload.cueId,
                    direction: payload.direction,
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error navigating playlist:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to navigate playlist' }
            });
        }
    }
    
    async handleUpdateCue(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId || !payload.updates) return;
            
            const result = await this.cueManager.updateCue(payload.cueId, payload.updates);
            
            this.sendToClient(ws, {
                type: 'cue_updated',
                payload: { 
                    cueId: payload.cueId,
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error updating cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to update cue' }
            });
        }
    }
    
    async handleDeleteCue(ws, payload) {
        try {
            if (!this.cueManager || !payload.cueId) return;
            
            const result = await this.cueManager.deleteCue(payload.cueId);
            
            this.sendToClient(ws, {
                type: 'cue_deleted',
                payload: { 
                    cueId: payload.cueId,
                    success: result.success,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error deleting cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to delete cue' }
            });
        }
    }
    
    async handleCreateCue(ws, payload) {
        try {
            if (!this.cueManager || !payload) return;
            
            const result = await this.cueManager.createCue(payload);
            
            this.sendToClient(ws, {
                type: 'cue_created',
                payload: { 
                    success: result.success,
                    cue: result.cue,
                    error: result.error
                }
            });
            
        } catch (error) {
            console.error('WebSocketManager: Error creating cue:', error);
            this.sendToClient(ws, {
                type: 'error',
                payload: { error: 'Failed to create cue' }
            });
        }
    }
    
    sendToClient(ws, message) {
        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        } catch (error) {
            console.error('WebSocketManager: Error sending to client:', error);
        }
    }
    
    broadcast(message) {
        console.log(`WebSocketManager: Broadcasting to ${this.clients.size} clients:`, message.type);
        
        this.clients.forEach(ws => {
            this.sendToClient(ws, message);
        });
    }
    
    // Broadcast cue updates
    broadcastCueUpdate(cueId, updates) {
        this.broadcast({
            type: 'cue_update',
            payload: { cueId, updates }
        });
    }
    
    // Broadcast cue status changes
    broadcastCueStatus(cueId, status, additionalData = {}) {
        this.broadcast({
            type: 'cue_status',
            payload: { cueId, status, ...additionalData }
        });
    }
    
    // Broadcast playback time updates
    broadcastPlaybackTime(cueId, currentTime, totalTime, status) {
        this.broadcast({
            type: 'playback_time',
            payload: { cueId, currentTime, totalTime, status }
        });
    }
    
    // Broadcast cues list updates
    async broadcastCuesUpdate(cues) {
        // Resolve file paths before broadcasting
        const resolvedCues = await this.resolveCueFilePaths(cues);
        this.broadcast({
            type: 'cues-updated',
            payload: { cues: resolvedCues }
        });
    }
    
    // Resolve audioFileId/relativePath to filePath for cues
    async resolveCueFilePaths(cues) {
        if (!this.audioFileManager) {
            return cues; // Return as-is if audioFileManager not available
        }
        
        const resolvedCues = await Promise.all(cues.map(async (cue) => {
            const resolvedCue = { ...cue };
            
            // For single file cues, resolve filePath
            if (cue.type === 'single_file') {
                if (!cue.filePath && (cue.audioFileId || cue.relativePath)) {
                    try {
                        const audioFile = cue.audioFileId 
                            ? await this.audioFileManager.loadAudioFileMetadata(cue.audioFileId)
                            : await this.audioFileManager.getAudioFileByPath(cue.relativePath);
                        
                        if (audioFile) {
                            // Use the API endpoint path for browser access
                            resolvedCue.filePath = `/api/audio/serve/${audioFile.id}`;
                            if (!resolvedCue.relativePath && audioFile.relativePath) {
                                resolvedCue.relativePath = audioFile.relativePath;
                            }
                        }
                    } catch (error) {
                        console.warn(`WebSocketManager: Could not resolve filePath for cue ${cue.id}: ${error.message}`);
                    }
                }
            }
            
            // For playlist cues, resolve filePath for each item
            if (cue.type === 'playlist' && cue.playlistItems) {
                resolvedCue.playlistItems = await Promise.all(cue.playlistItems.map(async (item) => {
                    const resolvedItem = { ...item };
                    if (!resolvedItem.filePath && (resolvedItem.audioFileId || resolvedItem.relativePath)) {
                        try {
                            const audioFile = resolvedItem.audioFileId
                                ? await this.audioFileManager.loadAudioFileMetadata(resolvedItem.audioFileId)
                                : await this.audioFileManager.getAudioFileByPath(resolvedItem.relativePath);
                            
                            if (audioFile) {
                                resolvedItem.filePath = `/api/audio/serve/${audioFile.id}`;
                                if (!resolvedItem.relativePath && audioFile.relativePath) {
                                    resolvedItem.relativePath = audioFile.relativePath;
                                }
                            }
                        } catch (error) {
                            console.warn(`WebSocketManager: Could not resolve filePath for playlist item ${item.id || item.name}: ${error.message}`);
                        }
                    }
                    return resolvedItem;
                }));
            }
            
            return resolvedCue;
        }));
        
        return resolvedCues;
    }
    
    // Broadcast configuration updates
    broadcastConfigUpdate(config) {
        this.broadcast({
            type: 'config-updated',
            payload: { config }
        });
    }
    
    // Broadcast workspace updates
    broadcastWorkspaceUpdate(workspace) {
        this.broadcast({
            type: 'workspace-updated',
            payload: { workspace }
        });
    }
    
    // Get connected clients count
    getConnectedClientsCount() {
        return this.clients.size;
    }
    
    // Check if any clients are connected
    hasConnectedClients() {
        return this.clients.size > 0;
    }
}

module.exports = WebSocketManager;
