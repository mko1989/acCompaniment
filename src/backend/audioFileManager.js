const fs = require('fs-extra');
const path = require('path');
const musicMetadata = require('music-metadata');
const { v4: uuidv4 } = require('uuid');
const { validateUuidOrError } = require('./utils/idValidation');
const { writeJsonAtomic } = require('./utils/atomicWrite');
const { warmPcmCache } = require('./pcmCache');

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
    
    async importAudioFile(sourcePath, options = {}) {
        try {
            const resolvedSource = options.skipCopy
                ? this.pathManager.resolveWithinAudioDir(sourcePath)
                : this.pathManager.resolveWithinDataDir(sourcePath);

            if (!resolvedSource) {
                return {
                    success: false,
                    error: 'Import path must be within the application data directory'
                };
            }

            const validation = await this.validateAudioFile(resolvedSource);
            if (!validation.valid) {
                return {
                    success: false,
                    error: validation.error
                };
            }
            
            const { fileInfo, metadata } = validation;
            const subdirectory = options.subdirectory || 'imported';
            let copyResult;

            if (options.skipCopy) {
                copyResult = {
                    success: true,
                    originalPath: resolvedSource,
                    newPath: resolvedSource,
                    relativePath: this.pathManager.toRelativePath(resolvedSource),
                    filename: path.basename(resolvedSource)
                };
            } else {
                copyResult = await this.pathManager.copyToAudioDirectory(resolvedSource, subdirectory);
            }
            
            if (!copyResult.success) {
                return {
                    success: false,
                    error: copyResult.error
                };
            }
            
            const audioFile = {
                id: uuidv4(),
                originalPath: resolvedSource,
                path: copyResult.newPath,
                relativePath: copyResult.relativePath,
                filename: copyResult.filename,
                name: options.name || path.basename(resolvedSource, path.extname(resolvedSource)),
                size: fileInfo.size,
                format: fileInfo.extension,
                duration: metadata.duration,
                bitrate: metadata.bitrate,
                sampleRate: metadata.sampleRate,
                channels: metadata.channels,
                codec: metadata.codec,
                title: metadata.title,
                artist: metadata.artist,
                album: metadata.album,
                importedAt: new Date().toISOString(),
                tags: options.tags || []
            };
            
            await this.saveAudioFileMetadata(audioFile);

            warmPcmCache(audioFile.path, this.pathManager.pcmCacheDir, this.pcmSampleRate)
                .then(() => console.log(`AudioFileManager: PCM cache warmed for ${audioFile.name}`))
                .catch((err) => console.warn(`AudioFileManager: PCM cache warm failed for ${audioFile.name}: ${err.message}`));
            
            console.log(`AudioFileManager: Imported audio file: ${audioFile.name}`);
            
            return {
                success: true,
                audioFile: audioFile
            };
            
        } catch (error) {
            console.error(`AudioFileManager: Error importing audio file: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
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
