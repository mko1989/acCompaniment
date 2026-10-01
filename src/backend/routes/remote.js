const express = require('express');
const router = express.Router();

// Remote control endpoints for HTTP access

// Get all cues for remote control
router.get('/cues', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const cues = cueManager.getCues();
        
        // Format cues for remote control
        const remoteCues = cues.map(cue => ({
            id: cue.id,
            name: cue.name,
            type: cue.type,
            status: cue.status || 'stopped',
            currentTime: cue.currentTime || 0,
            totalTime: cue.totalTime || 0,
            volume: typeof cue.volume === 'number' ? cue.volume : 1.0,
            fadeInTime: cue.fadeInTime || 0,
            fadeOutTime: cue.fadeOutTime || 0,
            loop: cue.loop || false,
            retriggerBehavior: cue.retriggerBehavior || 'restart',
            // Playlist specific
            currentPlaylistIndex: cue.currentPlaylistIndex || 0,
            playlistItems: cue.playlistItems || [],
            shufflePlaylist: cue.shufflePlaylist || false,
            repeatOnePlaylistItem: cue.repeatOnePlaylistItem || false,
            playlistPlayMode: cue.playlistPlayMode || 'continue'
        }));
        
        res.json({
            success: true,
            cues: remoteCues
        });
    } catch (error) {
        console.error('❌ Remote get cues error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Trigger cue via remote control
router.post('/cues/:id/trigger', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const options = {
            source: 'remote_http',
            ...req.body
        };
        
        const result = await cueManager.triggerCue(req.params.id, options);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Cue triggered successfully',
                // What the press did: 'playing', 'paused', ... (see
                // retriggerLogic), when it changed the cue's state.
                status: result.status ?? cueManager.getCue(req.params.id)?.status,
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Remote trigger cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Stop cue via remote control
router.post('/cues/:id/stop', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const { fadeOut } = req.body;
        
        const result = await cueManager.stopCue(req.params.id, fadeOut);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Cue stopped successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Remote stop cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Stop all cues via remote control
router.post('/cues/stop-all', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const { behavior } = req.body;
        
        const result = await cueManager.stopAllCues(behavior);
        
        if (result.success) {
            res.json({
                success: true,
                stoppedCount: result.results.length,
                message: `Stopped ${result.results.length} cues`
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Remote stop all cues error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Navigate playlist via remote control
router.post('/cues/:id/playlist/navigate', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const { direction } = req.body;
        
        if (!direction || !['next', 'previous'].includes(direction)) {
            return res.status(400).json({
                success: false,
                error: 'Direction must be "next" or "previous"'
            });
        }
        
        const result = await cueManager.navigatePlaylist(req.params.id, direction);
        
        if (result.success) {
            res.json({
                success: true,
                newIndex: result.newIndex,
                message: `Playlist navigated ${direction}`
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Remote navigate playlist error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get/set master volume (a live gain multiplier over every cue's own
// volume, like a physical master fader - not a persisted setting)
router.get('/master-volume', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        res.json({ success: true, volume: cueManager.getMasterVolume() });
    } catch (error) {
        console.error('❌ Remote get master volume error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/master-volume', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const { volume } = req.body;
        const result = cueManager.setMasterVolume(volume);

        if (result.success) {
            res.json({ success: true, volume: result.volume });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('❌ Remote set master volume error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get/set crossfade mode (starting a cue fades the others out and the new
// one in). Live session state, like master volume.
router.get('/crossfade', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        res.json({ success: true, enabled: cueManager.getCrossfadeMode() });
    } catch (error) {
        console.error('❌ Remote get crossfade mode error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/crossfade', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'enabled must be true or false' });
        }
        res.json(cueManager.setCrossfadeMode(enabled));
    } catch (error) {
        console.error('❌ Remote set crossfade mode error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get playback status for remote control
router.get('/status', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const status = cueManager.getPlaybackStatus();
        
        res.json({
            success: true,
            status: status
        });
    } catch (error) {
        console.error('❌ Remote get status error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get server info for remote control
router.get('/info', async (req, res) => {
    try {
        const { appConfigManager } = req.app.locals.managers;
        const config = appConfigManager.getConfig();
        const networkInterfaces = appConfigManager.getNetworkInterfaces();
        
        res.json({
            success: true,
            info: {
                name: 'acCompaniment',
                version: '0.3.0',
                httpPort: appConfigManager.getListeningPort(),
                websocketPort: appConfigManager.getListeningPort(), // same server
                networkInterfaces: networkInterfaces,
                features: {
                    httpRemote: true, // always served, at /remote
                    websocket: config.websocketEnabled,
                    audioFormats: config.supportedAudioFormats
                }
            }
        });
    } catch (error) {
        console.error('❌ Remote get info error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint
router.get('/health', async (req, res) => {
    try {
        const { cueManager, websocketManager } = req.app.locals.managers;
        const playbackStatus = cueManager.getPlaybackStatus();
        const timestamp = new Date().toISOString();

        res.json({
            // Top-level status/timestamp: the original, simpler health
            // check shape (used by electron-launcher's liveness poll and
            // any external monitoring expecting a plain "status": "ok").
            status: 'ok',
            timestamp,
            // success/health: the richer shape this endpoint always
            // returned on paper, but was actually unreachable until this
            // fix - server.js used to register its own simpler handler
            // for this same path first, shadowing this one entirely.
            success: true,
            health: {
                status: 'healthy',
                timestamp,
                playback: {
                    totalPlaying: playbackStatus.totalPlaying,
                    playingCues: playbackStatus.playingCues
                },
                websocket: {
                    connectedClients: websocketManager.getConnectedClientsCount()
                }
            }
        });
    } catch (error) {
        console.error('❌ Remote health check error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
