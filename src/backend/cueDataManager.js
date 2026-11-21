const fs = require('fs-extra');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { writeJsonAtomic } = require('./utils/atomicWrite');
const { rewriteCueReferences } = require('./mediaLibrary');

const BACKUPS_PER_PROJECT = 20;
const { validateUuidOrError } = require('./utils/idValidation');
const { normalizeOutputPatch } = require('./utils/outputPatch');

// Older spellings of cue fields -> the names the playback engine reads. The
// legacy Electron app (and its saved workspaces) and older browser UI code
// used `shuffle` / `repeatOne`; left as-is they were stored but ignored.
const CUE_FIELD_ALIASES = {
    shuffle: 'shufflePlaylist',
    repeatOne: 'repeatOnePlaylistItem',
};

// Turning a single-file cue into a playlist keeps its file, as the
// playlist's first item (unless the playlist already has it). The
// properties sidebar stages the same item itself, so it's already there
// when the sidebar saves.
function keepOwnFileWhenBecomingPlaylist(previous, cue) {
    if (cue.type !== 'playlist' || previous.type === 'playlist' || !previous.audioFileId) return cue;
    const items = Array.isArray(cue.playlistItems) ? cue.playlistItems : [];
    if (items.some((item) => item && item.audioFileId === previous.audioFileId)) return cue;
    const ownFile = {
        id: uuidv4(),
        name: previous.name,
        path: previous.relativePath,
        relativePath: previous.relativePath,
        audioFileId: previous.audioFileId,
        volume: 1,
        fadeInTime: 0,
        fadeOutTime: 0,
        trimStartTime: previous.trimStartTime || 0,
        trimEndTime: previous.trimEndTime || 0,
        knownDuration: previous.knownDuration || 0,
    };
    return { ...cue, playlistItems: [ownFile, ...items] };
}

// Trim belongs to a file. Becoming a playlist, the cue's trim has gone onto
// its first item (above), so the cue keeps none; becoming a single-file cue
// again, it takes back the trim of the item whose file it now plays - unless
// the update sets a trim itself (WO-003).
function moveTrimOnTypeChange(previous, cue, updates) {
    if (cue.type === 'playlist' && previous.type !== 'playlist') {
        return { ...cue, trimStartTime: 0, trimEndTime: null };
    }
    if (cue.type !== 'playlist' && previous.type === 'playlist'
        && !('trimStartTime' in updates) && !('trimEndTime' in updates)) {
        const item = (previous.playlistItems || []).find((i) => i && i.audioFileId === cue.audioFileId);
        if (item) {
            return { ...cue, trimStartTime: item.trimStartTime || 0, trimEndTime: item.trimEndTime || null };
        }
    }
    return cue;
}

// Spotify was removed (ADR-003 in rust/DECISIONS.md). Spotify cues in saved
// projects are kept in the file exactly as they were, but the app never
// loads them: they're held aside per project (hiddenCues) and written back
// in their place among the project's other cues.
function isHiddenCue(cue) {
    return Boolean(cue) && cue.type === 'spotify';
}

function normalizeCueFieldAliases(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }
    const out = { ...data };
    for (const [alias, canonical] of Object.entries(CUE_FIELD_ALIASES)) {
        if (alias in out) {
            if (!(canonical in out)) {
                out[canonical] = Boolean(out[alias]);
            }
            delete out[alias];
        }
    }
    return out;
}

class CueDataManager {
    constructor(pathManager) {
        this.pathManager = pathManager;
        this.workspacesDir = path.join(pathManager.cuesDir, 'workspaces');
        this.backupsDir = path.join(pathManager.cuesDir, 'backups');
        this.templatesDir = path.join(pathManager.cuesDir, 'templates');
        
        this.currentWorkspace = null;
        this.cues = [];
        this.hiddenCues = new Map(); // project id -> its Spotify cues, as read
        this._saveQueue = Promise.resolve();
        
        this.ensureDirectories();
    }
    
    async ensureDirectories() {
        await fs.ensureDir(this.workspacesDir);
        await fs.ensureDir(this.backupsDir);
        await fs.ensureDir(this.templatesDir);
    }
    
    _enqueueSave(saveFn) {
        const run = this._saveQueue.then(() => saveFn());
        this._saveQueue = run.catch(() => {});
        return run;
    }
    
    // Create a new cue
    createCue(cueData) {
        cueData = normalizeCueFieldAliases(cueData);
        const cue = {
            id: cueData.id || uuidv4(),
            name: cueData.name || 'New Cue',
            type: cueData.type || 'single_file',
            status: 'stopped',
            currentTime: 0,
            totalTime: 0,
            volume: cueData.volume || 1.0,
            fadeInTime: cueData.fadeInTime || 0,
            fadeOutTime: cueData.fadeOutTime || 0,
            loop: cueData.loop || false,
            retriggerBehavior: cueData.retriggerBehavior || 'restart',
            trimStartTime: cueData.trimStartTime || 0,
            trimEndTime: cueData.trimEndTime || null,
            isDuckingTrigger: cueData.isDuckingTrigger || false,
            enableDucking: cueData.enableDucking || false,
            duckingLevel: cueData.duckingLevel || 80,
            outputPatch: normalizeOutputPatch(cueData.outputPatch),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...cueData
        };
        
        // Add type-specific properties
        if (cue.type === 'single_file') {
            cue.filePath = cueData.filePath || '';
            cue.relativePath = cueData.relativePath || '';
            cue.knownDuration = cueData.knownDuration || 0;
        } else if (cue.type === 'playlist') {
            cue.playlistItems = cueData.playlistItems || [];
            cue.currentPlaylistIndex = 0;
            cue.shufflePlaylist = cueData.shufflePlaylist || false;
            cue.repeatOnePlaylistItem = cueData.repeatOnePlaylistItem || false;
            cue.playlistPlayMode = cueData.playlistPlayMode || 'continue';
        }
        
        return cue;
    }
    
    // Add cue to current workspace
    addCue(cue) {
        this.cues.push(cue);
        console.log(`CueDataManager: Added cue: ${cue.name} (${cue.id})`);
        return cue;
    }
    
    // Update cue
    updateCue(cueId, updates) {
        const cueIndex = this.cues.findIndex(cue => cue.id === cueId);
        if (cueIndex === -1) {
            return { success: false, error: 'Cue not found' };
        }
        
        const previous = this.cues[cueIndex];
        const normalized = normalizeCueFieldAliases(updates);
        this.cues[cueIndex] = moveTrimOnTypeChange(previous, keepOwnFileWhenBecomingPlaylist(previous, {
            ...previous,
            ...normalized,
            updatedAt: new Date().toISOString()
        }), normalized);
        
        console.log(`📝 CueDataManager: Updated cue: ${this.cues[cueIndex].name} (${cueId})`);
        return { success: true, cue: this.cues[cueIndex] };
    }
    
    // Reorder cues. `orderedIds` lists cue ids in their new order; cues it
    // doesn't mention keep their relative order, after the listed ones.
    reorderCues(orderedIds) {
        if (!Array.isArray(orderedIds)) {
            return { success: false, error: 'cueIds must be an array' };
        }
        const byId = new Map(this.cues.map((cue) => [cue.id, cue]));
        const seen = new Set();
        const reordered = [];
        for (const id of orderedIds) {
            if (byId.has(id) && !seen.has(id)) {
                reordered.push(byId.get(id));
                seen.add(id);
            }
        }
        for (const cue of this.cues) {
            if (!seen.has(cue.id)) reordered.push(cue);
        }
        this.cues.splice(0, this.cues.length, ...reordered);
        return { success: true, order: reordered.map((cue) => cue.id) };
    }

    /**
     * Applies `mapRef` (see mediaLibrary.rewriteCueReferences) to the audio
     * references of the open project (in memory - the caller saves it) and
     * of every other saved project (written straight to its file).
     * Returns { cuesUpdated, projectsUpdated }.
     */
    async rewriteAudioReferences(mapRef) {
        const currentId = this.currentWorkspace?.id;
        const cuesUpdated = rewriteCueReferences(this.cues, mapRef);
        let projectsUpdated = cuesUpdated > 0 ? 1 : 0;
        for (const file of await fs.readdir(this.workspacesDir).catch(() => [])) {
            if (!file.endsWith('.json') || file === `${currentId}.json`) continue;
            const filePath = path.join(this.workspacesDir, file);
            try {
                const workspace = JSON.parse(await fs.readFile(filePath, 'utf-8'));
                if (rewriteCueReferences(workspace.cues, mapRef) > 0) {
                    await writeJsonAtomic(filePath, workspace);
                    projectsUpdated += 1;
                }
            } catch (error) {
                console.warn(`CueDataManager: Could not update audio references in ${file}: ${error.message}`);
            }
        }
        return { cuesUpdated, projectsUpdated };
    }

    // Delete cue
    deleteCue(cueId) {
        const cueIndex = this.cues.findIndex(cue => cue.id === cueId);
        if (cueIndex === -1) {
            return { success: false, error: 'Cue not found' };
        }
        
        const deletedCue = this.cues.splice(cueIndex, 1)[0];
        console.log(`CueDataManager: Deleted cue: ${deletedCue.name} (${cueId})`);
        return { success: true, cue: deletedCue };
    }
    
    // Get cue by ID
    getCue(cueId) {
        return this.cues.find(cue => cue.id === cueId);
    }
    
    // Get all cues
    getCues() {
        return [...this.cues];
    }

    // Splits a project's cues as read from its file: the Spotify ones are
    // held aside, unchanged, for when the project is written again - each
    // with the ids of the visible cues before it in the file, nearest first,
    // so it can go back in the same place.
    _takeHiddenCues(workspaceId, cues) {
        const list = Array.isArray(cues) ? cues : [];
        const hidden = [];
        const visible = [];
        for (const cue of list) {
            if (isHiddenCue(cue)) {
                hidden.push({ cue, after: visible.map((c) => c.id).reverse() });
            } else {
                visible.push(cue);
            }
        }
        if (hidden.length > 0) this.hiddenCues.set(workspaceId, hidden);
        else this.hiddenCues.delete(workspaceId);
        return visible;
    }

    // The project as it is written to disk or into a bundle: its cues with
    // the Spotify cues it had when read put back - each right after the
    // nearest cue that preceded it in the file and still exists, or first
    // if none does.
    withHiddenCues(workspace) {
        const hidden = this.hiddenCues.get(workspace.id);
        if (!hidden) return workspace;
        const visible = workspace.cues || [];
        const ids = new Set(visible.map((cue) => cue.id));
        const byAnchor = new Map(); // visible cue id (null: first) -> hidden cues after it
        for (const { cue, after } of hidden) {
            const anchor = after.find((id) => ids.has(id)) ?? null;
            if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
            byAnchor.get(anchor).push(cue);
        }
        const cues = [...(byAnchor.get(null) || [])];
        for (const cue of visible) {
            cues.push(cue, ...(byAnchor.get(cue.id) || []));
        }
        return { ...workspace, cues };
    }
    
    /**
     * Remove provably-empty workspace files (0 bytes, whitespace-only, or missing id).
     */
    async cleanupOrphanWorkspaceFiles() {
        try {
            const files = await fs.readdir(this.workspacesDir);
            let removed = 0;

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                const workspacePath = path.join(this.workspacesDir, file);
                let shouldRemove = false;

                try {
                    const stat = await fs.stat(workspacePath);
                    if (stat.size === 0) {
                        shouldRemove = true;
                    } else {
                        const workspaceData = await fs.readFile(workspacePath, 'utf-8');
                        if (!workspaceData.trim()) {
                            shouldRemove = true;
                        } else {
                            const parsed = JSON.parse(workspaceData);
                            if (!parsed || !parsed.id) {
                                shouldRemove = true;
                            }
                        }
                    }
                } catch {
                    // Corrupted JSON — leave for manual/backup handling
                    continue;
                }

                if (shouldRemove) {
                    await fs.remove(workspacePath);
                    removed++;
                    console.log(`CueDataManager: Removed orphan workspace file: ${file}`);
                }
            }

            if (removed > 0) {
                console.log(`CueDataManager: Cleaned up ${removed} orphan workspace file(s)`);
            }

            return { removed };
        } catch (error) {
            console.error(`CueDataManager: Error cleaning orphan workspaces: ${error.message}`);
            return { removed: 0, error: error.message };
        }
    }
    
    // Create new workspace and activate it
    async createWorkspace(name, description = '', options = {}) {
        const { setAsCurrent = true } = options;
        const workspace = {
            id: uuidv4(),
            name: name || 'New Workspace',
            description: description,
            cues: [],
            layout: options.layout || {
                gridColumns: 4,
                gridRows: 4,
                cuePositions: {}
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        workspace.cues = this._takeHiddenCues(workspace.id, options.cues).map((cue) => this.validateCue(cue));
        
        const workspacePath = path.join(this.workspacesDir, `${workspace.id}.json`);
        await writeJsonAtomic(workspacePath, this.withHiddenCues(workspace));
        
        if (setAsCurrent) {
            this.currentWorkspace = workspace;
            this.cues = workspace.cues;
        }
        
        console.log(`📁 CueDataManager: Created workspace: ${workspace.name} (${workspace.id})`);
        return workspace;
    }
    
    async _writeWorkspaceToDisk(workspace) {
        const workspacePath = path.join(this.workspacesDir, `${workspace.id}.json`);

        if (await fs.pathExists(workspacePath)) {
            await this.createBackup(workspacePath);
        }

        await writeJsonAtomic(workspacePath, this.withHiddenCues(workspace));
        return workspacePath;
    }
    
    async _doSaveWorkspace(workspaceName = null, workspaceDescription = null) {
        if (!this.currentWorkspace?.id) {
            return { success: false, error: 'No active workspace to save' };
        }

        const workspace = {
            id: this.currentWorkspace.id,
            name: workspaceName || this.currentWorkspace.name || 'Current Workspace',
            description: workspaceDescription ?? this.currentWorkspace.description ?? '',
            cues: this.cues,
            layout: this.currentWorkspace.layout || {
                gridColumns: 4,
                gridRows: 4,
                cuePositions: {}
            },
            createdAt: this.currentWorkspace.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await this._writeWorkspaceToDisk(workspace);
        this.currentWorkspace = workspace;

        console.log(`💾 CueDataManager: Saved workspace: ${workspace.name} (${workspace.id})`);
        return { success: true, workspace };
    }
    
    // Save current workspace (serialized, atomic)
    async saveWorkspace(workspaceName = null, workspaceDescription = null) {
        return this._enqueueSave(() => this._doSaveWorkspace(workspaceName, workspaceDescription))
            .catch((error) => {
                console.error(`❌ CueDataManager: Error saving workspace: ${error.message}`);
                return { success: false, error: error.message };
            });
    }
    
    /**
     * Read workspace from disk without changing active workspace or in-memory cues.
     */
    async readWorkspace(workspaceId) {
        try {
            const idCheck = validateUuidOrError(workspaceId, 'workspaceId');
            if (!idCheck.valid) {
                return { success: false, error: idCheck.error };
            }

            const workspacePath = path.join(this.workspacesDir, `${workspaceId}.json`);

            if (!await fs.pathExists(workspacePath)) {
                return { success: false, error: 'Workspace not found' };
            }

            const workspaceData = await fs.readFile(workspacePath, 'utf-8');
            if (!workspaceData.trim()) {
                return { success: false, error: 'Workspace file is empty' };
            }

            const workspace = JSON.parse(workspaceData);
            workspace.cues = this._takeHiddenCues(workspaceId, workspace.cues).map(cue => this.validateCue(cue));

            return { success: true, workspace };
        } catch (error) {
            console.error(`CueDataManager: Error reading workspace: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update a workspace on disk by id without loading it as the active workspace.
     * Syncs in-memory state only when updating the currently active workspace.
     */
    async updateWorkspaceById(workspaceId, updates) {
        const readResult = await this.readWorkspace(workspaceId);
        if (!readResult.success) {
            return readResult;
        }

        const workspace = {
            ...readResult.workspace,
            ...updates,
            id: workspaceId,
            updatedAt: new Date().toISOString()
        };

        if (updates.cues) {
            // Spotify cues can't be added this way (ADR-003).
            workspace.cues = updates.cues.filter((cue) => !isHiddenCue(cue)).map(cue => this.validateCue(cue));
        }

        await this._writeWorkspaceToDisk(workspace);

        if (this.currentWorkspace?.id === workspaceId) {
            this.currentWorkspace = workspace;
            this.cues = workspace.cues || [];
        }

        console.log(`CueDataManager: Updated workspace on disk: ${workspace.name} (${workspaceId})`);
        return { success: true, workspace };
    }
    
    // Load workspace as the active workspace
    async loadWorkspace(workspaceId) {
        try {
            const readResult = await this.readWorkspace(workspaceId);
            if (!readResult.success) {
                return readResult;
            }

            const workspace = readResult.workspace;
            this.cues = workspace.cues;
            this.currentWorkspace = workspace;

            console.log(`📂 CueDataManager: Loaded workspace: ${workspace.name} (${workspace.id})`);
            return { success: true, workspace };
        } catch (error) {
            console.error(`CueDataManager: Error loading workspace: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Get all workspaces
    async getAllWorkspaces(options = {}) {
        const { includeCues = false } = options;
        try {
            const files = await fs.readdir(this.workspacesDir);
            const workspaces = [];
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const workspacePath = path.join(this.workspacesDir, file);
                        const workspaceData = await fs.readFile(workspacePath, 'utf-8');
                        
                        if (!workspaceData.trim()) {
                            continue;
                        }
                        
                        const workspace = JSON.parse(workspaceData);
                        if (!workspace.id) {
                            continue;
                        }

                        const cues = Array.isArray(workspace.cues) ? workspace.cues.filter((cue) => !isHiddenCue(cue)) : [];
                        if (includeCues) {
                            workspace.cues = cues;
                        } else {
                            workspace.cueCount = cues.length;
                            delete workspace.cues;
                        }
                        
                        const stats = await fs.stat(workspacePath);
                        workspace.filePath = workspacePath;
                        workspace.fileSize = stats.size;
                        workspace.lastModified = stats.mtime;
                        
                        workspaces.push(workspace);
                    } catch (error) {
                        console.warn(`CueDataManager: Skipping corrupted workspace file: ${file} - ${error.message}`);
                        try {
                            const corruptedPath = path.join(this.workspacesDir, file);
                            const backupPath = path.join(this.backupsDir, `corrupted_${Date.now()}_${file}`);
                            await fs.copy(corruptedPath, backupPath);
                            console.log(`CueDataManager: Backed up corrupted file: ${backupPath}`);
                        } catch (backupError) {
                            console.error(`CueDataManager: Failed to backup corrupted file: ${backupError.message}`);
                        }
                    }
                }
            }
            
            workspaces.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
            return workspaces;
            
        } catch (error) {
            console.error(`CueDataManager: Error getting workspaces: ${error.message}`);
            return [];
        }
    }
    
    // Delete workspace
    async deleteWorkspace(workspaceId) {
        try {
            const idCheck = validateUuidOrError(workspaceId, 'workspaceId');
            if (!idCheck.valid) {
                return { success: false, error: idCheck.error };
            }

            const workspacePath = path.join(this.workspacesDir, `${workspaceId}.json`);
            
            if (!await fs.pathExists(workspacePath)) {
                return { success: false, error: 'Workspace not found' };
            }
            
            await this.createBackup(workspacePath);
            await fs.remove(workspacePath);
            this.hiddenCues.delete(workspaceId);
            
            if (this.currentWorkspace?.id === workspaceId) {
                this.currentWorkspace = null;
                this.cues = [];
            }
            
            console.log(`CueDataManager: Deleted workspace: ${workspaceId}`);
            return { success: true };
            
        } catch (error) {
            console.error(`CueDataManager: Error deleting workspace: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Create backup
    async createBackup(filePath) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = path.basename(filePath);
            const backupPath = path.join(this.backupsDir, `${timestamp}_${fileName}`);
            
            await fs.copy(filePath, backupPath);
            await this._pruneBackups(fileName);
            
        } catch (error) {
            console.error(`CueDataManager: Error creating backup: ${error.message}`);
        }
    }
    
    // Every save backs the previous version up, and saves happen on every
    // edit - keep the newest BACKUPS_PER_PROJECT per project, not all of them.
    async _pruneBackups(fileName) {
        const suffix = `_${fileName}`;
        const backups = (await fs.readdir(this.backupsDir).catch(() => []))
            .filter((f) => f.endsWith(suffix))
            .sort(); // ISO timestamp prefix: oldest first
        for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_PER_PROJECT))) {
            await fs.remove(path.join(this.backupsDir, old)).catch(() => {});
        }
    }

    // Validate cue data
    validateCue(cue) {
        cue = normalizeCueFieldAliases(cue);
        const validatedCue = {
            id: cue.id || uuidv4(),
            name: cue.name || 'Unnamed Cue',
            type: cue.type || 'single_file',
            status: cue.status || 'stopped',
            currentTime: cue.currentTime || 0,
            totalTime: cue.totalTime || 0,
            volume: typeof cue.volume === 'number' ? cue.volume : 1.0,
            fadeInTime: typeof cue.fadeInTime === 'number' ? cue.fadeInTime : 0,
            fadeOutTime: typeof cue.fadeOutTime === 'number' ? cue.fadeOutTime : 0,
            loop: Boolean(cue.loop),
            retriggerBehavior: cue.retriggerBehavior || 'restart',
            trimStartTime: typeof cue.trimStartTime === 'number' ? cue.trimStartTime : 0,
            trimEndTime: cue.trimEndTime || null,
            isDuckingTrigger: Boolean(cue.isDuckingTrigger),
            enableDucking: Boolean(cue.enableDucking),
            duckingLevel: typeof cue.duckingLevel === 'number' ? cue.duckingLevel : 80,
            outputPatch: normalizeOutputPatch(cue.outputPatch),
            createdAt: cue.createdAt || new Date().toISOString(),
            updatedAt: cue.updatedAt || new Date().toISOString(),
            ...cue
        };
        
        if (validatedCue.type === 'single_file') {
            validatedCue.filePath = validatedCue.filePath || '';
            validatedCue.relativePath = validatedCue.relativePath || '';
            validatedCue.knownDuration = typeof validatedCue.knownDuration === 'number' ? validatedCue.knownDuration : 0;
        } else if (validatedCue.type === 'playlist') {
            validatedCue.playlistItems = Array.isArray(validatedCue.playlistItems) ? validatedCue.playlistItems : [];
            validatedCue.currentPlaylistIndex = typeof validatedCue.currentPlaylistIndex === 'number' ? validatedCue.currentPlaylistIndex : 0;
            validatedCue.shufflePlaylist = Boolean(validatedCue.shufflePlaylist);
            validatedCue.repeatOnePlaylistItem = Boolean(validatedCue.repeatOnePlaylistItem);
            validatedCue.playlistPlayMode = validatedCue.playlistPlayMode || 'continue';
        }
        
        return validatedCue;
    }
    
    getCurrentWorkspace() {
        return this.currentWorkspace;
    }
    
    setCurrentWorkspace(workspace) {
        this.currentWorkspace = workspace;
        this.cues = workspace?.cues || [];
    }
    
    clearCurrentWorkspace() {
        this.currentWorkspace = null;
        this.cues = [];
    }
    
    async exportWorkspace(workspaceId, exportPath, includeAudioFiles = false, audioFileManager = null) {
        try {
            const readResult = await this.readWorkspace(workspaceId);
            if (!readResult.success) {
                return readResult;
            }

            const exportData = {
                ...this.withHiddenCues(readResult.workspace),
                exportedAt: new Date().toISOString(),
                includeAudioFiles: includeAudioFiles
            };

            let audioFilesCopied = 0;
            if (includeAudioFiles) {
                if (!audioFileManager) {
                    console.warn('CueDataManager: includeAudioFiles requested but no audioFileManager available - skipping audio export');
                } else {
                    // Collect every referenced audio file (single-file cues
                    // and each playlist item), resolved the same way
                    // playback does (relativePath -> audioFileManager
                    // lookup -> absolute path), and copy them into a
                    // sibling folder next to the exported JSON, preserving
                    // their relativePath layout so the export stays
                    // self-describing / portable.
                    const relativePaths = new Set();
                    for (const cue of exportData.cues || []) {
                        if (cue.type === 'single_file' && cue.relativePath) {
                            relativePaths.add(cue.relativePath);
                        } else if (cue.type === 'playlist' && Array.isArray(cue.playlistItems)) {
                            for (const item of cue.playlistItems) {
                                if (item.relativePath) {
                                    relativePaths.add(item.relativePath);
                                }
                            }
                        }
                    }

                    const audioExportDir = path.join(
                        path.dirname(exportPath),
                        `${path.basename(exportPath, '.json')}_audio`
                    );

                    for (const relativePath of relativePaths) {
                        try {
                            const audioFile = await audioFileManager.getAudioFileByPath(relativePath);
                            if (!audioFile || !(await fs.pathExists(audioFile.path))) {
                                continue;
                            }
                            const destPath = path.join(audioExportDir, relativePath);
                            await fs.ensureDir(path.dirname(destPath));
                            await fs.copy(audioFile.path, destPath);
                            audioFilesCopied++;
                        } catch (copyError) {
                            console.warn(`CueDataManager: Failed to export audio file ${relativePath}: ${copyError.message}`);
                        }
                    }

                    if (audioFilesCopied > 0) {
                        exportData.audioFilesDir = audioExportDir;
                    }
                    console.log(`CueDataManager: Exported ${audioFilesCopied} audio file(s) alongside workspace`);
                }
            }

            await writeJsonAtomic(exportPath, exportData);

            console.log(`CueDataManager: Exported workspace to: ${exportPath}`);
            return { success: true, exportPath, audioFilesCopied: includeAudioFiles ? audioFilesCopied : undefined };

        } catch (error) {
            console.error(`CueDataManager: Error exporting workspace: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    async importWorkspace(importPath) {
        try {
            const resolvedImport = this.pathManager.resolveWithinDataDir(importPath);
            if (!resolvedImport) {
                return { success: false, error: 'Import path must be within application data directory' };
            }

            const importData = await fs.readFile(resolvedImport, 'utf-8');
            const workspace = JSON.parse(importData);
            
            if (!workspace.name || !Array.isArray(workspace.cues)) {
                return { success: false, error: 'Invalid workspace format' };
            }
            
            workspace.id = uuidv4();
            workspace.importedAt = new Date().toISOString();
            workspace.cues = this._takeHiddenCues(workspace.id, workspace.cues).map(cue => this.validateCue(cue));
            
            const workspacePath = path.join(this.workspacesDir, `${workspace.id}.json`);
            await writeJsonAtomic(workspacePath, this.withHiddenCues(workspace));
            
            console.log(`CueDataManager: Imported workspace: ${workspace.name} (${workspace.id})`);
            return { success: true, workspace };
            
        } catch (error) {
            console.error(`CueDataManager: Error importing workspace: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

module.exports = CueDataManager;
module.exports.normalizeCueFieldAliases = normalizeCueFieldAliases;
