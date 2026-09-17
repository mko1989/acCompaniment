const express = require('express');
const router = express.Router();
const { requireUuid } = require('../middleware/validateUuid');

function notFoundStatus(error) {
    return error === 'Cue not found' ? 404 : 400;
}

// Get all cues
router.get('/', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const cues = cueManager.getCues();
        
        res.json({
            success: true,
            cues: cues
        });
    } catch (error) {
        console.error('❌ Get cues error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Stop all cues (before /:id routes)
router.post('/stop-all', async (req, res) => {
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
        console.error('Stop all cues error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get playback status (before /:id routes)
router.get('/status/playback', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const status = cueManager.getPlaybackStatus();
        
        res.json({
            success: true,
            status: status
        });
    } catch (error) {
        console.error('Get playback status error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get cue by ID
router.get('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const cue = cueManager.getCue(req.params.id);
        
        if (!cue) {
            return res.status(404).json({
                success: false,
                error: 'Cue not found'
            });
        }
        
        res.json({
            success: true,
            cue: cue
        });
    } catch (error) {
        console.error('❌ Get cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create new cue
router.post('/', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const cueData = req.body;
        
        const result = await cueManager.createCue(cueData);
        
        if (result.success) {
            res.status(201).json({
                success: true,
                cue: result.cue
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Create cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update cue
router.put('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const updates = req.body;
        
        const result = await cueManager.updateCue(req.params.id, updates);
        
        if (result.success) {
            res.json({
                success: true,
                cue: result.cue
            });
        } else {
            res.status(notFoundStatus(result.error)).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Update cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete cue
router.delete('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.deleteCue(req.params.id);
        
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(notFoundStatus(result.error)).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Delete cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Trigger cue (play/restart)
router.post('/:id/trigger', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const options = req.body;
        
        const result = await cueManager.triggerCue(req.params.id, options);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Cue triggered successfully'
            });
        } else {
            res.status(notFoundStatus(result.error)).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Trigger cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Stop cue
router.post('/:id/stop', requireUuid('id'), async (req, res) => {
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
            res.status(notFoundStatus(result.error)).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Stop cue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Toggle pause/resume cue
router.post('/:id/toggle-pause', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.togglePauseCue(req.params.id);
        
        if (result.success) {
            res.json({
                success: true,
                status: result.status,
                message: `Cue ${result.status}`
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Toggle pause error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Navigate playlist
router.post('/:id/playlist/navigate', requireUuid('id'), async (req, res) => {
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
            res.status(notFoundStatus(result.error)).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Navigate playlist error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
