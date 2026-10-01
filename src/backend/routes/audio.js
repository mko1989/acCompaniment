const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { randomUUID } = require('crypto');
const router = express.Router();
const { requireUuid } = require('../middleware/validateUuid');

const SUPPORTED_FORMATS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];

const MIME_BY_EXT = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac'
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function getMaxUploadBytes(req) {
    const { appConfigManager } = req.app.locals.managers;
    return appConfigManager?.getConfig()?.maxAudioFileSize || 100 * 1024 * 1024;
}

// Uploads land in a temp folder under a random name; the library then
// decides where (and whether) the file is stored - see
// AudioFileManager.addFile / replaceFile.
function createUpload(req) {
    const { pathManager } = req.app.locals.managers;
    const maxFileSize = getMaxUploadBytes(req);
    const uploadDir = path.join(pathManager.tempDir, 'uploads');

    return multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                fs.ensureDir(uploadDir)
                    .then(() => cb(null, uploadDir))
                    .catch((err) => cb(err));
            },
            filename: (req, file, cb) => {
                cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
            }
        }),
        limits: { fileSize: maxFileSize },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (SUPPORTED_FORMATS.includes(ext)) {
                cb(null, true);
            } else {
                cb(new Error(`Unsupported file format: ${ext}`), false);
            }
        }
    });
}

// Browsers send filenames as latin1 in multipart headers; multer hands
// them over as-is, which mangles anything non-ASCII ("Żywiec.mp3").
function originalNameOf(file) {
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return decoded.includes('\ufffd') ? file.originalname : decoded;
}

function handleMulterError(err, req, res, next) {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            success: false,
            error: `File too large. Maximum size is ${getMaxUploadBytes(req)} bytes`
        });
    }

    if (err.message && err.message.startsWith('Unsupported file format')) {
        return res.status(400).json({ success: false, error: err.message });
    }

    return res.status(400).json({
        success: false,
        error: err.message || 'Upload failed'
    });
}

function parseTags(rawTags) {
    if (!rawTags) return [];
    if (Array.isArray(rawTags)) return rawTags;
    try {
        const parsed = JSON.parse(rawTags);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        throw new Error('Invalid tags: must be a JSON array');
    }
}

function parsePagination(query) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 0, 0), 500);
    const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
    return { limit, offset };
}

// --- Static / multi-segment routes first (before /:id) ---

// Get all audio files (optional pagination: ?limit=&offset=)
router.get('/', async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const { limit, offset } = parsePagination(req.query);
        const allFiles = await audioFileManager.getAllAudioFiles();

        const slice = limit > 0
            ? allFiles.slice(offset, offset + limit)
            : allFiles;

        res.json({
            success: true,
            audioFiles: slice,
            total: allFiles.length,
            limit: limit || null,
            offset
        });
    } catch (error) {
        console.error('Get audio files error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get audio file statistics
router.get('/stats/overview', async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const stats = await audioFileManager.getAudioFileStats();

        res.json({ success: true, stats });
    } catch (error) {
        console.error('Get audio stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// List RtAudio output devices (reuse live engine — avoid second CoreAudio instance)
router.get('/output-devices', (req, res) => {
    try {
        const { cueManager } = req.app.locals.managers;
        const devices = cueManager?.audioPlaybackManager?.getOutputDevices()
            || require('../audioPlaybackManager').listOutputDevices();
        res.json({ success: true, devices });
    } catch (error) {
        console.error('List output devices error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Search audio files
router.get('/search/:query', async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const results = await audioFileManager.searchAudioFiles(req.params.query, req.query);

        res.json({
            success: true,
            results,
            query: req.params.query
        });
    } catch (error) {
        console.error('Search audio files error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve audio file (stream), with real HTTP Range support
router.get('/serve/:id', requireUuid('id'), async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const audioFile = await audioFileManager.loadAudioFileMetadata(req.params.id);

        if (!audioFile) {
            return res.status(404).json({ success: false, error: 'Audio file not found' });
        }

        if (!await fs.pathExists(audioFile.path)) {
            return res.status(404).json({ success: false, error: 'Audio file not found on disk' });
        }

        const stat = await fs.stat(audioFile.path);
        const fileSize = stat.size;

        // A library file can be replaced in place under the same URL, so the
        // browser must check back rather than reuse a cached copy.
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.setHeader('Content-Type', getMimeType(audioFile.path));
        res.setHeader('Accept-Ranges', 'bytes');

        // This was previously advertised (Accept-Ranges: bytes above) but
        // never actually honored - always returning the full file with a
        // 200. Real audio players and browsers rely on Range requests for
        // seeking and progressive loading, so a served-but-unhonored
        // Accept-Ranges header is actively misleading, not just a missed
        // optimization.
        const rangeHeader = req.headers.range;
        let stream;
        if (rangeHeader) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
            const hasStart = match && match[1] !== '';
            const hasEnd = match && match[2] !== '';
            if (!match || (!hasStart && !hasEnd)) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).json({ success: false, error: 'Invalid Range header' });
            }

            let start;
            let end;
            if (!hasStart) {
                // Suffix range, e.g. "bytes=-500" -> last 500 bytes
                const suffixLength = parseInt(match[2], 10);
                start = Math.max(0, fileSize - suffixLength);
                end = fileSize - 1;
            } else {
                start = parseInt(match[1], 10);
                end = hasEnd ? parseInt(match[2], 10) : fileSize - 1;
            }

            if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).json({ success: false, error: 'Range not satisfiable' });
            }
            end = Math.min(end, fileSize - 1);

            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', end - start + 1);
            stream = fs.createReadStream(audioFile.path, { start, end });
        } else {
            res.setHeader('Content-Length', fileSize);
            stream = fs.createReadStream(audioFile.path);
        }

        stream.on('error', (streamError) => {
            console.error('Serve audio stream error:', streamError);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Failed to read audio file' });
            } else {
                res.destroy();
            }
        });
        stream.pipe(res);
    } catch (error) {
        console.error('Serve audio file error:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
});

// --- Mutations ---

router.post('/upload', (req, res, next) => {
    createUpload(req).single('audioFile')(req, res, (err) => {
        if (err) return handleMulterError(err, req, res, next);
        next();
    });
}, async (req, res) => {
    let uploadedPath = null;

    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        uploadedPath = req.file.path;
        const { audioFileManager } = req.app.locals.managers;

        let tags;
        try {
            tags = parseTags(req.body.tags);
        } catch (tagError) {
            await fs.remove(uploadedPath).catch(() => {});
            return res.status(400).json({ success: false, error: tagError.message });
        }

        const result = await audioFileManager.addFile(req.file.path, originalNameOf(req.file), {
            name: req.body.name || undefined,
            tags,
        });

        if (result.success) {
            res.json({ success: true, audioFile: result.audioFile, reused: result.reused, renamed: result.renamed });
        } else {
            await fs.remove(uploadedPath).catch(() => {});
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        if (uploadedPath) {
            await fs.remove(uploadedPath).catch(() => {});
        }
        console.error('Upload audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Replace a library file with a new version, in place: every cue in every
// project using it plays the new version. Multipart field: audioFile.
router.post('/:id/replace', requireUuid('id'), (req, res, next) => {
    createUpload(req).single('audioFile')(req, res, (err) => {
        if (err) return handleMulterError(err, req, res, next);
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        const { audioFileManager, cueManager } = req.app.locals.managers;
        const result = await audioFileManager.replaceFile(req.params.id, req.file.path, originalNameOf(req.file));
        if (!result.success) {
            const status = result.error === 'Audio file not found' ? 404 : 400;
            return res.status(status).json({ success: false, error: result.error });
        }
        const refs = await cueManager.handleAudioFileReplaced(result.audioFile, result.previous);
        res.json({ success: true, audioFile: result.audioFile, cuesUpdated: refs.cuesUpdated, projectsUpdated: refs.projectsUpdated });
    } catch (error) {
        if (req.file) await fs.remove(req.file.path).catch(() => {});
        console.error('Replace audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/import', async (req, res) => {
    try {
        const { filePath, name, subdirectory, tags } = req.body;

        if (!filePath) {
            return res.status(400).json({ success: false, error: 'File path is required' });
        }

        const { audioFileManager } = req.app.locals.managers;
        const result = await audioFileManager.importAudioFile(filePath, { name, subdirectory, tags });

        if (result.success) {
            res.json({ success: true, audioFile: result.audioFile });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Import audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/validate', async (req, res) => {
    try {
        const { filePath } = req.body;

        if (!filePath) {
            return res.status(400).json({ success: false, error: 'File path is required' });
        }

        const { audioFileManager } = req.app.locals.managers;
        const validation = await audioFileManager.validateAudioFile(filePath);

        res.json({ success: true, validation });
    } catch (error) {
        console.error('Validate audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Parameterized routes last ---

router.get('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const audioFile = await audioFileManager.loadAudioFileMetadata(req.params.id);

        if (!audioFile) {
            return res.status(404).json({ success: false, error: 'Audio file not found' });
        }

        res.json({ success: true, audioFile });
    } catch (error) {
        console.error('Get audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const result = await audioFileManager.updateAudioFileMetadata(req.params.id, req.body);

        if (result.success) {
            res.json({ success: true, audioFile: result.audioFile });
        } else {
            const status = result.error === 'Audio file not found' ? 404 : 400;
            res.status(status).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Update audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/:id', requireUuid('id'), async (req, res) => {
    try {
        const { audioFileManager } = req.app.locals.managers;
        const result = await audioFileManager.deleteAudioFile(req.params.id);

        if (result.success) {
            res.json({ success: true });
        } else {
            const status = result.error === 'Audio file not found' ? 404 : 400;
            res.status(status).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Delete audio file error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
