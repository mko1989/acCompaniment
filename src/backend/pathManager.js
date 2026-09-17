const path = require('path');
const fs = require('fs-extra');

class PathManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.audioDir = path.join(dataDir, 'audio');
        this.cuesDir = path.join(dataDir, 'cues');
        this.configDir = path.join(dataDir, 'config');
        this.tempDir = path.join(dataDir, 'temp');
        this.waveformsDir = path.join(dataDir, 'temp', 'waveforms');
        this.pcmCacheDir = path.join(dataDir, 'pcm-cache');
        
        this.ensureDirectories();
    }
    
    async ensureDirectories() {
        const dirs = [
            this.dataDir,
            this.audioDir,
            path.join(this.audioDir, 'imported'),
            path.join(this.audioDir, 'user'),
            this.cuesDir,
            path.join(this.cuesDir, 'workspaces'),
            path.join(this.cuesDir, 'backups'),
            path.join(this.cuesDir, 'templates'),
            this.configDir,
            this.tempDir,
            this.waveformsDir,
            this.pcmCacheDir
        ];
        
        for (const dir of dirs) {
            await fs.ensureDir(dir);
        }
        
        console.log(`📁 PathManager: Ensured all directories exist in ${this.dataDir}`);
    }

    isPathWithin(resolvedPath, resolvedBase) {
        const normalizedPath = path.resolve(resolvedPath);
        const normalizedBase = path.resolve(resolvedBase);
        return normalizedPath === normalizedBase
            || normalizedPath.startsWith(normalizedBase + path.sep);
    }
    
    // Convert absolute paths to relative paths for portability
    toRelativePath(absolutePath, basePath = this.audioDir) {
        if (!absolutePath) return null;
        
        try {
            const resolvedPath = path.resolve(absolutePath);
            const resolvedBase = path.resolve(basePath);
            
            if (this.isPathWithin(resolvedPath, resolvedBase)) {
                return path.relative(resolvedBase, resolvedPath);
            }
            
            return null;
        } catch (error) {
            console.warn(`PathManager: Error converting to relative path: ${error.message}`);
            return null;
        }
    }
    
    // Resolve relative paths to absolute paths, confined to basePath
    resolvePath(relativePath, basePath = this.audioDir) {
        if (!relativePath) return null;
        
        try {
            const resolvedBase = path.resolve(basePath);
            const resolvedPath = path.isAbsolute(relativePath)
                ? path.resolve(relativePath)
                : path.resolve(basePath, relativePath);

            if (!this.isPathWithin(resolvedPath, resolvedBase)) {
                console.warn(`PathManager: Path escapes base directory: ${relativePath}`);
                return null;
            }

            return resolvedPath;
        } catch (error) {
            console.warn(`PathManager: Error resolving path: ${error.message}`);
            return null;
        }
    }

    resolveWithinDataDir(inputPath) {
        return this.resolvePath(inputPath, this.dataDir);
    }

    resolveWithinAudioDir(inputPath) {
        return this.resolvePath(inputPath, this.audioDir);
    }
    
    // Validate that a file exists and is accessible
    async validateFile(filePath) {
        try {
            if (!filePath) return { valid: false, error: 'No file path provided' };
            
            const resolvedPath = this.resolvePath(filePath);
            if (!resolvedPath) {
                return { valid: false, error: 'Could not resolve file path' };
            }
            
            const stats = await fs.stat(resolvedPath);
            
            if (!stats.isFile()) {
                return { valid: false, error: 'Path is not a file' };
            }
            
            return { 
                valid: true, 
                path: resolvedPath,
                size: stats.size,
                modified: stats.mtime
            };
        } catch (error) {
            return { 
                valid: false, 
                error: error.message,
                path: filePath
            };
        }
    }
    
    // Get all audio files in a directory
    async getAudioFiles(directory = this.audioDir) {
        try {
            const files = await fs.readdir(directory, { withFileTypes: true });
            const audioFiles = [];
            
            for (const file of files) {
                if (file.isFile()) {
                    const ext = path.extname(file.name).toLowerCase();
                    if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) {
                        const fullPath = path.join(directory, file.name);
                        const stats = await fs.stat(fullPath);
                        
                        audioFiles.push({
                            name: file.name,
                            path: fullPath,
                            relativePath: this.toRelativePath(fullPath),
                            size: stats.size,
                            modified: stats.mtime,
                            extension: ext
                        });
                    }
                } else if (file.isDirectory()) {
                    // Recursively search subdirectories
                    const subFiles = await this.getAudioFiles(path.join(directory, file.name));
                    audioFiles.push(...subFiles);
                }
            }
            
            return audioFiles;
        } catch (error) {
            console.error(`PathManager: Error getting audio files: ${error.message}`);
            return [];
        }
    }
    
    // Create a unique filename to avoid conflicts
    async getUniqueFilename(directory, filename) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        let counter = 1;
        let newFilename = filename;
        
        while (await fs.pathExists(path.join(directory, newFilename))) {
            newFilename = `${base}_${counter}${ext}`;
            counter++;
        }
        
        return newFilename;
    }
    
    // Get file info for a path
    async getFileInfo(filePath) {
        try {
            const resolvedPath = this.resolvePath(filePath);
            if (!resolvedPath) return null;
            
            const stats = await fs.stat(resolvedPath);
            return {
                path: resolvedPath,
                relativePath: this.toRelativePath(resolvedPath),
                name: path.basename(resolvedPath),
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                extension: path.extname(resolvedPath).toLowerCase()
            };
        } catch (error) {
            console.error(`PathManager: Error getting file info: ${error.message}`);
            return null;
        }
    }
    
    // Copy file to audio directory
    async copyToAudioDirectory(sourcePath, subdirectory = 'imported') {
        try {
            const resolvedSource = this.resolveWithinDataDir(sourcePath);
            if (!resolvedSource) {
                return {
                    success: false,
                    error: 'Source path must be within the application data directory',
                    originalPath: sourcePath
                };
            }

            const safeSubdir = path.basename(subdirectory);
            const targetDir = path.join(this.audioDir, safeSubdir);
            await fs.ensureDir(targetDir);
            
            const filename = path.basename(resolvedSource);
            const uniqueFilename = await this.getUniqueFilename(targetDir, filename);
            const targetPath = path.join(targetDir, uniqueFilename);
            
            await fs.copy(resolvedSource, targetPath);
            
            return {
                success: true,
                originalPath: sourcePath,
                newPath: targetPath,
                relativePath: this.toRelativePath(targetPath),
                filename: uniqueFilename
            };
        } catch (error) {
            console.error(`PathManager: Error copying file: ${error.message}`);
            return {
                success: false,
                error: error.message,
                originalPath: sourcePath
            };
        }
    }
    
    // Get directory structure info
    getDirectoryStructure() {
        return {
            dataDir: this.dataDir,
            audioDir: this.audioDir,
            cuesDir: this.cuesDir,
            configDir: this.configDir,
            tempDir: this.tempDir,
            waveformsDir: this.waveformsDir,
            audioSubdirs: {
                imported: path.join(this.audioDir, 'imported'),
                user: path.join(this.audioDir, 'user')
            },
            cuesSubdirs: {
                workspaces: path.join(this.cuesDir, 'workspaces'),
                backups: path.join(this.cuesDir, 'backups'),
                templates: path.join(this.cuesDir, 'templates')
            }
        };
    }
}

module.exports = PathManager;
