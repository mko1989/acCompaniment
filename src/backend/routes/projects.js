/**
 * Projects: the open project (name, autosaved), starting a new one,
 * opening/deleting saved ones, and bundles - a .zip with a project and its
 * audio, for moving it to another machine.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { randomUUID } = require('crypto');
const { requireUuid } = require('../middleware/validateUuid');
const { writeBundle, readBundle } = require('../projectBundle');

const router = express.Router();

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024 * 1024;

function uploadBundle(req) {
    const { pathManager } = req.app.locals.managers;
    const uploadDir = path.join(pathManager.tempDir, 'uploads');
    return multer({
        storage: multer.diskStorage({
            destination: (r, file, cb) => fs.ensureDir(uploadDir).then(() => cb(null, uploadDir)).catch(cb),
            filename: (r, file, cb) => cb(null, `${randomUUID()}.zip`),
        }),
        limits: { fileSize: MAX_BUNDLE_BYTES },
    }).single('bundle');
}

// "My Show: Act 1" -> safe-ish ASCII fallback plus the real name (RFC 5987).
function contentDisposition(projectName) {
    const base = (String(projectName || 'Project').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim() || 'Project');
    const ascii = base.replace(/[^\x20-\x7e]/g, '_');
    return `attachment; filename="${ascii}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`;
}

router.get('/', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        res.json({ success: true, projects: await cueManager.listProjects() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/current', (req, res) => {
    const { cueManager } = req.app.locals.managers;
    const project = cueManager.getCurrentProject();
    if (!project) return res.status(404).json({ success: false, error: 'No project is open' });
    res.json({ success: true, project });
});

// Rename the open project. Body: { name }
router.put('/current', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.renameProject(req.body?.name);
        res.status(result.success ? 200 : 400).json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start a new, empty project and open it. Body: { name? }
router.post('/', async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.newProject(req.body?.name);
        if (!result.success) return res.status(400).json(result);
        res.status(201).json({ success: true, project: cueManager.getCurrentProject() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Import a bundle (multipart field "bundle") as a new project, and open it.
router.post('/import', (req, res, next) => {
    uploadBundle(req)(req, res, (err) => {
        if (err) {
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({ success: false, error: err.message });
        }
        next();
    });
}, async (req, res) => {
    const { pathManager, cueManager } = req.app.locals.managers;
    const extractDir = path.join(pathManager.tempDir, 'imports', randomUUID());
    // Temp files are removed *before* answering, so when a client gets the
    // response the server has nothing left in flight for this import.
    const cleanUp = async () => {
        if (req.file) await fs.remove(req.file.path).catch(() => {});
        await fs.remove(extractDir).catch(() => {});
    };
    let status;
    let body;
    try {
        if (!req.file) {
            [status, body] = [400, { success: false, error: 'No bundle uploaded' }];
        } else {
            let bundle = null;
            try {
                bundle = await readBundle(req.file.path, extractDir);
            } catch (error) {
                [status, body] = [400, { success: false, error: error.message }];
            }
            if (bundle) {
                const result = await cueManager.importProject(bundle);
                [status, body] = result.success
                    ? [201, { success: true, project: result.project, audio: result.audio, missingAudio: bundle.missingAudio }]
                    : [400, result];
            }
        }
    } catch (error) {
        console.error('Import project error:', error);
        [status, body] = [500, { success: false, error: error.message }];
    }
    await cleanUp();
    res.status(status).json(body);
});

// Download a project as a bundle. `current` or a project id.
router.get('/:id/bundle', async (req, res) => {
    try {
        const { cueManager, cueDataManager, audioFileManager } = req.app.locals.managers;
        await cueManager.flushPersistWorkspace();
        const id = req.params.id === 'current' ? cueManager.getCurrentWorkspace()?.id : req.params.id;
        const read = id ? await cueDataManager.readWorkspace(id) : { success: false, error: 'No project is open' };
        if (!read.success) {
            return res.status(404).json({ success: false, error: read.error || 'Project not found' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', contentDisposition(read.workspace.name));
        await writeBundle(read.workspace, res, async (ref) => {
            return (ref.audioFileId && await audioFileManager.loadAudioFileMetadata(ref.audioFileId))
                || (ref.relativePath && await audioFileManager.getAudioFileByPath(ref.relativePath))
                || null;
        });
    } catch (error) {
        console.error('Bundle project error:', error);
        if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
        else res.destroy(error);
    }
});

// Open a saved project.
router.post('/:id/open', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.openProject(req.params.id);
        if (!result.success) {
            const status = /not found/i.test(result.error || '') ? 404 : 400;
            return res.status(status).json(result);
        }
        res.json({ success: true, project: cueManager.getCurrentProject() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const result = await cueManager.deleteProject(req.params.id);
        if (!result.success) {
            const status = /not found/i.test(result.error || '') ? 404 : 409;
            return res.status(status).json(result);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
