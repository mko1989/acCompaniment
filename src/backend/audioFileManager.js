const fs = require('fs-extra');
const path = require('path');
const musicMetadata = require('music-metadata');
const { randomUUID: uuidv4 } = require('crypto');
const { validateUuidOrError } = require('./utils/idValidation');
const { writeJsonAtomic } = require('./utils/atomicWrite');
const { warmPcmCache } = require('./pcmCache');
const {
    hashFile, sanitizeFilename, withCopyNumber, findExistingName, isSupportedAudio,
} = require('./mediaLibrary');

const UPDATABLE_METADATA_FIELDS = new Set([
    'name', 'tags', 'title', 'artist', 'album'
]);

class AudioFileManager {
    constructor(pathManager) {
        this.pathManager = pathManager;
        this.supportedFormats = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
        this.maxFileSize = 100 * 1024 * 1024;
        this._metadataIndex = null;
        this.pcmSampleRate = 48000;
    }

    setPcmSampleRate(sampleRate) {
        if (typeof sampleRate === 'number' && sampleRate > 0) {
            this.pcmSampleRate = sampleRate;
        }
    }

    setMaxFileSize(bytes) {
        if (typeof bytes === 'number' && bytes > 0) {
            this.maxFileSize = bytes;
        }
    }

    get metadataDir() {
        return path.join(this.pathManager.audioDir, 'metadata');
    }

    invalidateMetadataIndex() {
        this._metadataIndex = null;
    }

    async ensureMetadataIndex() {
        if (!this._metadataIndex) {
            await this._rebuildMetadataIndex();
        }
        return this._metadataIndex;
    }

    async _rebuildMetadataIndex() {
        const byId = new Map();
        const byRelativePath = new Map();
        const byAbsolutePath = new Map();

        await fs.ensureDir(this.metadataDir);
        const files = await fs.readdir(this.metadataDir).catch(() => []);

        for (const file of files) {
            if (!file.endsWith('.json')) {
                continue;
            }

            try {
                const metadataPath = path.join(this.metadataDir, file);
                const data = await fs.readFile(metadataPath, 'utf-8');
                const audioFile = JSON.parse(data);

                if (!audioFile.id) {
                    continue;
                }

                if (audioFile.path) {
                    const safePath = this.pathManager.resolveWithinAudioDir(audioFile.path);
                    if (safePath) {
                        audioFile.path = safePath;
                        byAbsolutePath.set(safePath, audioFile);
                    }
                }

                if (audioFile.relativePath) {
                    byRelativePath.set(audioFile.relativePath, audioFile);
                }

                byId.set(audioFile.id, audioFile);
            } catch (error) {
                console.warn(`AudioFileManager: Skipping corrupt metadata file ${file}: ${error.message}`);
            }
        }

        this._metadataIndex = { byId, byRelativePath, byAbsolutePath };
        return this._metadataIndex;
    }

    _indexAdd(audioFile) {
        if (!this._metadataIndex || !audioFile?.id) {
            return;
        }
        this._metadataIndex.byId.set(audioFile.id, audioFile);
        if (audioFile.relativePath) {
            this._metadataIndex.byRelativePath.set(audioFile.relativePath, audioFile);
        }
        if (audioFile.path) {
            this._metadataIndex.byAbsolutePath.set(audioFile.path, audioFile);
        }
    }

    _indexRemove(audioFileId, audioFile = null) {
        if (!this._metadataIndex) {
            return;
        }
        const existing = audioFile || this._metadataIndex.byId.get(audioFileId);
        this._metadataIndex.byId.delete(audioFileId);
        if (existing?.relativePath) {
            this._metadataIndex.byRelativePath.delete(existing.relativePath);
        }
        if (existing?.path) {
            this._metadataIndex.byAbsolutePath.delete(existing.path);
        }
    }
    
    async validateAudioFile(filePath) {
        try {
            const fileInfo = await this.pathManager.getFileInfo(filePath);
            if (!fileInfo) {
                return { valid: false, error: 'File not found' };
            }
            
            if (!this.supportedFormats.includes(fileInfo.extension)) {
                return { 
                    valid: false, 
                    error: `Unsupported format: ${fileInfo.extension}. Supported: ${this.supportedFormats.join(', ')}` 
                };
            }
            
            if (fileInfo.size > this.maxFileSize) {
                return { 
                    valid: false, 
                    error: `File too large: ${Math.round(fileInfo.size / 1024 / 1024)}MB. Max: ${Math.round(this.maxFileSize / 1024 / 1024)}MB` 
                };
            }
            
            try {
                const metadata = await musicMetadata.parseFile(fileInfo.path);
                return {
                    valid: true,
                    fileInfo: fileInfo,
                    metadata: {
                        duration: metadata.format.duration,
                        bitrate: metadata.format.bitrate,
                        sampleRate: metadata.format.sampleRate,
                        channels: metadata.format.numberOfChannels,
                        codec: metadata.format.codecName,
                        title: metadata.common.title,
                        artist: metadata.common.artist,
                        album: metadata.common.album
                    }
                };
            } catch (metadataError) {
                return {
                    valid: false,
                    error: `Invalid audio file: ${metadataError.message}`
                };
            }
            
        } catch (error) {
            return {
                valid: false,
                error: `Validation error: ${error.message}`
            };
        }
    }
    
    // Size and format checks plus the file's audio metadata, for any path
    // (validateAudioFile only accepts paths inside the library).
    async _probeAudio(filePath, displayName) {
        const ext = path.extname(displayName || filePath).toLowerCase();
        if (!this.supportedFormats.includes(ext)) {
            return { valid: false, error: `Unsupported format: ${ext || '(none)'}. Supported: ${this.supportedFormats.join(', ')}` };
        }
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat || !stat.isFile()) {
            return { valid: false, error: 'File not found' };
        }
        if (stat.size > this.maxFileSize) {
            return {
                valid: false,
                error: `File too large: ${Math.round(stat.size / 1024 / 1024)}MB. Max: ${Math.round(this.maxFileSize / 1024 / 1024)}MB`,
            };
        }
        try {
            // duration: true makes the parser measure it when the header
            // doesn't say. Anything that isn't really audio parses "fine"
            // but has no length - that is what rejects it.
            const metadata = await musicMetadata.parseFile(filePath, { duration: true });
            if (!(metadata.format.duration > 0)) {
                return { valid: false, error: 'Invalid audio file: no playable audio found' };
            }
            return {
                valid: true,
                size: stat.size,
                format: ext,
                metadata: {
                    duration: metadata.format.duration,
                    bitrate: metadata.format.bitrate,
                    sampleRate: metadata.format.sampleRate,
                    channels: metadata.format.numberOfChannels,
                    codec: metadata.format.codecName,
                    title: metadata.common.title,
                    artist: metadata.common.artist,
                    album: metadata.common.album,
                },
            };
        } catch (error) {
            return { valid: false, error: `Invalid audio file: ${error.message}` };
        }
    }

    _recordFields(probe) {
        return {
            size: probe.size,
            format: probe.format,
            duration: probe.metadata.duration,
            bitrate: probe.metadata.bitrate,
            sampleRate: probe.metadata.sampleRate,
            channels: probe.metadata.channels,
            codec: probe.metadata.codec,
            title: probe.metadata.title,
            artist: probe.metadata.artist,
            album: probe.metadata.album,
        };
    }

    // The metadata record for a file already in the library (by its actual
    // on-disk name), creating one if the file has none. Fills in its content
    // hash if the record predates hashing.
    async _recordForLibraryFile(actualName) {
        const filePath = path.join(this.pathManager.audioDir, actualName);
        await this.ensureMetadataIndex();
        let record = this._metadataIndex.byAbsolutePath.get(filePath)
            || this._metadataIndex.byRelativePath.get(actualName);
        if (!record) {
            const stat = await fs.stat(filePath);
            record = await this._ensureMetadataForDiscoveredFile({
                path: filePath, name: actualName, size: stat.size, modified: stat.mtime,
                extension: path.extname(actualName).toLowerCase(),
            });
        }
        if (!record.hash) {
            record.hash = await hashFile(filePath);
            await this.saveAudioFileMetadata(record);
        }
        return record;
    }

    /**
     * Adds a file to the library under its own name (the filename is its
     * identity):
     *   - no library file by that name     -> added
     *   - same name, identical content     -> the existing file is reused
     *   - same name, different content     -> added as "Name (2).ext" etc.,
     *     so adding a file never changes audio other cues already use
     * `sourcePath` is moved into the library (it's a temp upload) unless
     * options.copy is set. Returns { success, audioFile, reused, renamed }.
     */
    async addFile(sourcePath, originalName, options = {}) {
        const name = sanitizeFilename(originalName || path.basename(sourcePath));
        const discard = async () => {
            if (!options.copy) await fs.remove(sourcePath).catch(() => {});
        };
        try {
            if (!isSupportedAudio(name)) {
                await discard();
                return { success: false, error: `Unsupported file format: ${path.extname(name) || '(none)'}` };
            }
            const probe = await this._probeAudio(sourcePath, name);
            if (!probe.valid) {
                await discard();
                return { success: false, error: probe.error };
            }
            const hash = await hashFile(sourcePath);
            const audioDir = this.pathManager.audioDir;
            await fs.ensureDir(audioDir);

            for (let n = 1; ; n++) {
                const candidate = withCopyNumber(name, n);
                const existingName = await findExistingName(audioDir, candidate);
                if (!existingName) {
                    const target = path.join(audioDir, candidate);
                    if (options.copy) await fs.copy(sourcePath, target);
                    else await fs.move(sourcePath, target);
                    const audioFile = {
                        id: uuidv4(),
                        path: target,
                        relativePath: candidate,
                        filename: candidate,
                        name: options.name || path.basename(candidate, path.extname(candidate)),
                        ...this._recordFields(probe),
                        hash,
                        importedAt: new Date().toISOString(),
                        tags: options.tags || [],
                    };
                    await this.saveAudioFileMetadata(audioFile);
                    this._warm(audioFile);
                    console.log(`AudioFileManager: Added ${candidate} to the library`);
                    return { success: true, audioFile, reused: false, renamed: n > 1 };
                }
                const existing = await this._recordForLibraryFile(existingName);
                if (existing.hash === hash) {
                    await discard();
                    console.log(`AudioFileManager: ${name} is already in the library - reusing it`);
                    return { success: true, audioFile: { ...existing }, reused: true, renamed: false };
                }
            }
        } catch (error) {
            await discard();
            console.error(`AudioFileManager: Error adding ${name}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Replaces a library file's audio with a new version, in place: same
     * record id, same name - so every cue in every project using it plays
     * the new version. A different file type keeps the name with the new
     * extension. Returns { success, audioFile, previous: { path, relativePath } }.
     */
    async replaceFile(audioFileId, sourcePath, originalName) {
        const discard = () => fs.remove(sourcePath).catch(() => {});
        try {
            const record = await this.loadAudioFileMetadata(audioFileId);
            if (!record) {
                await discard();
                return { success: false, error: 'Audio file not found' };
            }
            const incomingName = sanitizeFilename(originalName || path.basename(sourcePath));
            const probe = await this._probeAudio(sourcePath, incomingName);
            if (!probe.valid) {
                await discard();
                return { success: false, error: probe.error };
            }

            const audioDir = this.pathManager.audioDir;
            const previous = { path: record.path, relativePath: record.relativePath };
            const oldExt = path.extname(record.path).toLowerCase();
            const newExt = path.extname(incomingName).toLowerCase();
            let targetName = path.basename(record.path);
            if (newExt !== oldExt) {
                const base = `${path.basename(targetName, path.extname(targetName))}${newExt}`;
                for (let n = 1; ; n++) {
                    const candidate = withCopyNumber(base, n);
                    if (!(await findExistingName(audioDir, candidate))) {
                        targetName = candidate;
                        break;
                    }
                }
            }
            const target = path.join(audioDir, targetName);
            const hash = await hashFile(sourcePath);
            await fs.move(sourcePath, target, { overwrite: true });
            if (target !== record.path) {
                await fs.remove(record.path).catch(() => {});
            }

            this._indexRemove(record.id, record);
            const updated = {
                ...record,
                path: target,
                relativePath: targetName,
                filename: targetName,
                ...this._recordFields(probe),
                hash,
                replacedAt: new Date().toISOString(),
            };
            await this.saveAudioFileMetadata(updated);
            this._warm(updated);
            console.log(`AudioFileManager: Replaced ${previous.relativePath} with a new version (${incomingName})`);
            return { success: true, audioFile: { ...updated }, previous };
        } catch (error) {
            await discard();
            console.error(`AudioFileManager: Error replacing ${audioFileId}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    _warm(audioFile) {
        warmPcmCache(audioFile.path, this.pathManager.pcmCacheDir, this.pcmSampleRate)
            .catch((err) => console.warn(`AudioFileManager: PCM cache warm failed for ${audioFile.name}: ${err.message}`));
    }

    // Adds a file that's already on the server (REST /api/audio/import) to
    // the library - copied, with the same name/dedupe rules as uploads.
    async importAudioFile(sourcePath, options = {}) {
        const resolvedSource = this.pathManager.resolveWithinDataDir(sourcePath);
        if (!resolvedSource) {
            return {
                success: false,
                error: 'Import path must be within the application data directory'
            };
        }
        return this.addFile(resolvedSource, path.basename(resolvedSource), { ...options, copy: true });
    }
    
    async saveAudioFileMetadata(audioFile) {
        try {
            const metadataPath = path.join(this.metadataDir, `${audioFile.id}.json`);
            await fs.ensureDir(this.metadataDir);
            await writeJsonAtomic(metadataPath, audioFile);
            await this.ensureMetadataIndex();
            this._indexAdd(audioFile);
        } catch (error) {
            console.error(`AudioFileManager: Error saving metadata: ${error.message}`);
        }
    }
    
    async loadAudioFileMetadata(audioFileId) {
        try {
            const idCheck = validateUuidOrError(audioFileId, 'audioFileId');
            if (!idCheck.valid) {
                return null;
            }

            await this.ensureMetadataIndex();
            const cached = this._metadataIndex.byId.get(audioFileId);
            if (cached) {
                return { ...cached };
            }

            const metadataPath = path.join(this.metadataDir, `${audioFileId}.json`);
            if (await fs.pathExists(metadataPath)) {
                const data = await fs.readFile(metadataPath, 'utf-8');
                const audioFile = JSON.parse(data);

                if (audioFile.path) {
                    const safePath = this.pathManager.resolveWithinAudioDir(audioFile.path);
                    if (!safePath) {
                        console.warn(`AudioFileManager: Metadata path escapes audio directory for ${audioFileId}`);
                        return null;
                    }
                    audioFile.path = safePath;
                }

                this._indexAdd(audioFile);
                return audioFile;
            }
            
            return null;
        } catch (error) {
            console.error(`AudioFileManager: Error loading metadata: ${error.message}`);
            return null;
        }
    }
    
    async _ensureMetadataForDiscoveredFile(file) {
        const relativePath = this.pathManager.toRelativePath(file.path);
        if (!relativePath) {
            return null;
        }

        await this.ensureMetadataIndex();
        const existing = this._metadataIndex.byRelativePath.get(relativePath)
            || this._metadataIndex.byAbsolutePath.get(file.path);
        if (existing) {
            return existing;
        }

        const audioFile = {
            id: uuidv4(),
            path: file.path,
            relativePath,
            filename: file.name,
            name: path.basename(file.name, path.extname(file.name)),
            size: file.size,
            format: file.extension,
            importedAt: file.modified.toISOString(),
            discoveredAt: new Date().toISOString()
        };

        await this.saveAudioFileMetadata(audioFile);
        return audioFile;
    }

    async getAllAudioFiles() {
        try {
            await this.ensureMetadataIndex();
            const audioFiles = [];
            const seenRelativePaths = new Set();
            const files = await this.pathManager.getAudioFiles(this.pathManager.audioDir);
            
            for (const file of files) {
                const audioFile = await this._ensureMetadataForDiscoveredFile(file);
                if (audioFile && audioFile.relativePath && !seenRelativePaths.has(audioFile.relativePath)) {
                    seenRelativePaths.add(audioFile.relativePath);
                    audioFiles.push(audioFile);
                }
            }
            
            return audioFiles;
        } catch (error) {
            console.error(`AudioFileManager: Error getting all audio files: ${error.message}`);
            return [];
        }
    }
    
    async getAudioFileByPath(filePath) {
        try {
            const resolvedPath = this.pathManager.resolvePath(filePath);
            if (!resolvedPath) {
                return null;
            }

            await this.ensureMetadataIndex();

            const relativePath = this.pathManager.toRelativePath(resolvedPath);
            if (relativePath && this._metadataIndex.byRelativePath.has(relativePath)) {
                return this._metadataIndex.byRelativePath.get(relativePath);
            }
            if (this._metadataIndex.byAbsolutePath.has(resolvedPath)) {
                return this._metadataIndex.byAbsolutePath.get(resolvedPath);
            }

            const fileInfo = await this.pathManager.getFileInfo(resolvedPath);
            if (!fileInfo) {
                return null;
            }

            return await this._ensureMetadataForDiscoveredFile({
                path: fileInfo.path,
                name: fileInfo.name,
                size: fileInfo.size,
                modified: fileInfo.modified,
                extension: fileInfo.extension
            });
        } catch (error) {
            console.error(`AudioFileManager: Error getting audio file by path: ${error.message}`);
            return null;
        }
    }
    
    async deleteAudioFile(audioFileId) {
        try {
            const audioFile = await this.loadAudioFileMetadata(audioFileId);
            if (!audioFile) {
                return { success: false, error: 'Audio file not found' };
            }
            
            if (await fs.pathExists(audioFile.path)) {
                await fs.remove(audioFile.path);
            }
            
            const metadataPath = path.join(this.metadataDir, `${audioFileId}.json`);
            if (await fs.pathExists(metadataPath)) {
                await fs.remove(metadataPath);
            }

            this._indexRemove(audioFileId, audioFile);
            
            console.log(`AudioFileManager: Deleted audio file: ${audioFile.name}`);
            
            return { success: true };
            
        } catch (error) {
            console.error(`AudioFileManager: Error deleting audio file: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    async updateAudioFileMetadata(audioFileId, updates) {
        try {
            const audioFile = await this.loadAudioFileMetadata(audioFileId);
            if (!audioFile) {
                return { success: false, error: 'Audio file not found' };
            }

            const safeUpdates = {};
            for (const [key, value] of Object.entries(updates || {})) {
                if (UPDATABLE_METADATA_FIELDS.has(key)) {
                    safeUpdates[key] = value;
                }
            }

            Object.assign(audioFile, safeUpdates);
            audioFile.updatedAt = new Date().toISOString();
            
            await this.saveAudioFileMetadata(audioFile);
            
            console.log(`AudioFileManager: Updated metadata for: ${audioFile.name}`);
            
            return {
                success: true,
                audioFile: audioFile
            };
            
        } catch (error) {
            console.error(`AudioFileManager: Error updating metadata: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    async searchAudioFiles(query, options = {}) {
        try {
            const audioFiles = await this.getAllAudioFiles();
            const searchTerm = query.toLowerCase();
            
            return audioFiles.filter(audioFile => {
                const searchFields = [
                    audioFile.name,
                    audioFile.filename,
                    audioFile.title,
                    audioFile.artist,
                    audioFile.album
                ].filter(Boolean);
                
                return searchFields.some(field => 
                    field.toLowerCase().includes(searchTerm)
                );
            });
            
        } catch (error) {
            console.error(`AudioFileManager: Error searching audio files: ${error.message}`);
            return [];
        }
    }
    
    async getAudioFileStats() {
        try {
            const audioFiles = await this.getAllAudioFiles();
            
            const stats = {
                totalFiles: audioFiles.length,
                totalSize: 0,
                totalDuration: 0,
                formats: {},
                averageDuration: 0,
                averageSize: 0
            };
            
            audioFiles.forEach(file => {
                stats.totalSize += file.size || 0;
                stats.totalDuration += file.duration || 0;
                
                const format = file.format || 'unknown';
                stats.formats[format] = (stats.formats[format] || 0) + 1;
            });
            
            if (stats.totalFiles > 0) {
                stats.averageDuration = stats.totalDuration / stats.totalFiles;
                stats.averageSize = stats.totalSize / stats.totalFiles;
            }
            
            return stats;
            
        } catch (error) {
            console.error(`AudioFileManager: Error getting stats: ${error.message}`);
            return null;
        }
    }
}

module.exports = AudioFileManager;
