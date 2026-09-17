const express = require('express');
const path = require('path');
const router = express.Router();
const { requireUuid } = require('../middleware/validateUuid');

// Get all workspaces (summaries by default; ?includeCues=true for full payloads)
router.get('/', async (req, res) => {
    try {
        const { cueDataManager } = req.app.locals.managers;
        const includeCues = req.query.includeCues === 'true';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const allWorkspaces = await cueDataManager.getAllWorkspaces({ includeCues });
        const workspaces = limit > 0
            ? allWorkspaces.slice(offset, offset + limit)
            : allWorkspaces;
        
        res.json({
            success: true,
            workspaces,
            total: allWorkspaces.length,
            limit: limit || null,
            offset
        });
    } catch (error) {
        console.error('❌ Get workspaces error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current workspace
router.get('/current', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const workspace = cueManager.getCurrentWorkspace();
        
        res.json({
            success: true,
            workspace: workspace
        });
    } catch (error) {
        console.error('❌ Get current workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create new workspace (activated as current)
router.post('/', async (req, res) => {
    try {
        const { cueDataManager, cueManager } = req.app.locals.managers;
        const { name, description } = req.body;

        await cueManager.flushPersistWorkspace();

        const workspace = await cueDataManager.createWorkspace(name, description);

        if (cueManager.websocketManager) {
            cueManager.websocketManager.broadcastWorkspaceUpdate(workspace);
            await cueManager.websocketManager.broadcastCuesUpdate(cueDataManager.getCues());
        }

        res.status(201).json({
            success: true,
            workspace: workspace
        });
    } catch (error) {
        console.error('❌ Create workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Load workspace
router.post('/:id/load', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.loadWorkspace(req.params.id);
        
        if (result.success) {
            res.json({
                success: true,
                workspace: result.workspace,
                message: 'Workspace loaded successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Load workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Save current workspace
router.post('/save', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const { name, description } = req.body;
        
        const result = await cueManager.saveWorkspace(name, description);
        
        if (result.success) {
            res.json({
                success: true,
                workspace: result.workspace,
                message: 'Workspace saved successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Save workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update workspace (does not switch active workspace unless it is the current one)
router.put('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueDataManager } = req.app.locals.managers;
        const updates = req.body;

        const saveResult = await cueDataManager.updateWorkspaceById(req.params.id, updates);

        if (saveResult.success) {
            res.json({
                success: true,
                workspace: saveResult.workspace,
                message: 'Workspace updated successfully'
            });
        } else {
            res.status(saveResult.error === 'Workspace not found' ? 404 : 400).json({
                success: false,
                error: saveResult.error
            });
        }
    } catch (error) {
        console.error('❌ Update workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete workspace
router.delete('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueDataManager } = req.app.locals.managers;
        const result = await cueDataManager.deleteWorkspace(req.params.id);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Workspace deleted successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Delete workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Export workspace
router.post('/:id/export', requireUuid('id'), async (req, res) => {
    try {
        const { cueDataManager, pathManager, audioFileManager } = req.app.locals.managers;
        const { includeAudioFiles = false } = req.body;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const exportPath = path.join(
            pathManager.cuesDir,
            `workspace_export_${req.params.id}_${timestamp}.json`
        );

        const result = await cueDataManager.exportWorkspace(req.params.id, exportPath, includeAudioFiles, audioFileManager);
        
        if (result.success) {
            res.json({
                success: true,
                exportPath: result.exportPath,
                message: 'Workspace exported successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Export workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Import workspace
router.post('/import', async (req, res) => {
    try {
        const { cueDataManager } = req.app.locals.managers;
        const { importPath } = req.body;
        
        if (!importPath) {
            return res.status(400).json({
                success: false,
                error: 'Import path is required'
            });
        }
        
        const result = await cueDataManager.importWorkspace(importPath);
        
        if (result.success) {
            res.json({
                success: true,
                workspace: result.workspace,
                message: 'Workspace imported successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Import workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get workspace by ID (read-only — does not change active workspace)
router.get('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueDataManager } = req.app.locals.managers;
        const result = await cueDataManager.readWorkspace(req.params.id);
        
        if (result.success) {
            res.json({
                success: true,
                workspace: result.workspace
            });
        } else {
            res.status(404).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Get workspace error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
