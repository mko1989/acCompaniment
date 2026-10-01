const path = require('path');
const AudioPlaybackManager = require('./audioPlaybackManager');
const { rewriteCueReferences } = require('./mediaLibrary');
const { resolveRetrigger } = require('./retriggerLogic');
const {
    shuffledOrder, isValidOrder, decideItemEnd, stepIndex, peekNextIndex,
} = require('./playlistLogic');

// How long ducking takes to lower / restore affected cues (legacy app: 1s).
const DEFAULT_DUCK_FADE_MS = 1000;

class CueManager {
    constructor(audioFileManager, cueDataManager, websocketManager) {
        this.audioFileManager = audioFileManager;
        this.cueDataManager = cueDataManager;
        this.websocketManager = websocketManager;
        
        this.playingCues = new Map(); // cueId -> playback info
        this.cueStates = new Map(); // cueId -> state info
        this.audioPlaybackManager = new AudioPlaybackManager();
        
        this.config = null;
        this.crossfadeMode = false;
        this.shuffleOrders = new Map(); // playlist cueId -> shuffled play order
        this._duckState = new Map(); // playing cueId -> duck multiplier applied
        this._rng = Math.random; // replaceable for deterministic tests
        this._cueQueues = new Map(); // cueId -> tail of that cue's operation queue
        this._saveDebounceTimer = null;
        this._saveDebounceMs = 300;
    }
    
    async initialize() {
        console.log('CueManager: Initializing...');
        
        await this.cueDataManager.cleanupOrphanWorkspaceFiles();
        
        // Reopen the project that was open last; failing that (first run
        // after upgrading, or it was deleted) the most recently changed one.
        const workspaces = await this.cueDataManager.getAllWorkspaces();
        const lastOpenedId = this.config?.lastOpenedProjectId;
        const toOpen = workspaces.find((w) => w.id === lastOpenedId) || workspaces[0];
        if (toOpen) {
            await this.cueDataManager.loadWorkspace(toOpen.id);
            console.log(`CueManager: Loaded workspace: ${toOpen.name}`);
        } else {
            await this.cueDataManager.createWorkspace('Default Workspace');
            console.log('CueManager: Created default workspace');
        }

        await this.audioPlaybackManager.init(this._audioEngineConfig());
        
        // Set up playback end callback
        this.audioPlaybackManager.setPlaybackEndCallback((cueId, reason) => {
            this.handlePlaybackEnd(cueId, reason);
        });

        // Surface native audio-engine errors (e.g. output device removed
        // mid-show) to connected clients instead of playback silently
        // stopping with nothing visible in the UI.
        this.audioPlaybackManager.setEngineErrorCallback((error) => {
            this.websocketManager?.broadcast({
                type: 'audio-engine-error',
                payload: error,
            });
        });

        this._startPlaybackTimeBroadcast();
        
        console.log('CueManager: Initialized successfully');
    }

    _audioEngineConfig() {
        const config = this.config || {};
        return {
            audioOutputDeviceId: config.audioOutputDeviceId ?? 'default',
            audioOutputChannelCount: config.audioOutputChannelCount ?? 2,
            audioSampleRate: config.audioSampleRate ?? 48000,
            audioBufferSize: config.audioBufferSize ?? 512,
            pcmCacheDir: this.cueDataManager?.pathManager?.pcmCacheDir ?? null,
        };
    }

    _formatTimeMMSS(seconds) {
        const sec = Math.max(0, Math.floor(seconds || 0));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    _startPlaybackTimeBroadcast() {
        if (this._playbackTimeInterval) {
            clearInterval(this._playbackTimeInterval);
        }

        this._playbackTimeInterval = setInterval(() => {
            if (!this.audioPlaybackManager?.isInitialized) {
                return;
            }

            const status = this.audioPlaybackManager.getPlaybackStatus();
            const playing = status.mixer?.playing || [];
            const peakLevels = this.audioPlaybackManager.drainPeakLevels();

            // One update per cue. With layered "new instance" voices, the
            // newest one (last in start order) drives the display.
            const newestVoice = new Map();
            const voiceCounts = new Map();
            for (const entry of playing) {
                newestVoice.set(entry.cueId, entry);
                voiceCounts.set(entry.cueId, (voiceCounts.get(entry.cueId) || 0) + 1);
            }

            for (const entry of newestVoice.values()) {
                const cue = this.getCue(entry.cueId);
                const totalTime = entry.trimEndSec - entry.trimStartSec;
                const currentTime = Math.max(0, entry.positionSec - entry.trimStartSec);
                const remaining = Math.max(0, totalTime - currentTime);
                const playbackStatus = entry.isPaused ? 'paused' : 'playing';

                this.websocketManager.broadcast({
                    type: 'playback-time-update',
                    payload: {
                        cueId: entry.cueId,
                        cueName: cue?.name || '',
                        currentTimeSec: currentTime,
                        totalDurationSec: totalTime,
                        remainingTimeSec: remaining,
                        currentTimeFormatted: this._formatTimeMMSS(currentTime),
                        totalDurationFormatted: this._formatTimeMMSS(totalTime),
                        remainingTimeFormatted: this._formatTimeMMSS(remaining),
                        status: playbackStatus,
                        peakLevel: entry.isPaused ? 0 : (peakLevels[entry.cueId] || 0),
                        isFadingIn: Boolean(entry.isFadingIn),
                        isFadingOut: Boolean(entry.isFadingOut),
                        fadeTimeRemainingMs: Math.round((entry.fadeRemainingSec || 0) * 1000),
                        isDucked: Boolean(entry.isDucked),
                        duckGain: entry.duckGain ?? 1,
                        voiceCount: voiceCounts.get(entry.cueId),
                        ...(cue ? this._playlistPosition(cue) : {}),
                    },
                });
            }
        }, 100);
    }
    
    // Get current configuration
    getConfig() {
        return this.config;
    }
    
    // Set configuration
    setConfig(config) {
        this.config = config;
    }

    async applyAudioEngineConfig() {
        if (!this.audioPlaybackManager) {
            return { success: false, error: 'Audio engine not available' };
        }

        // Reopening the output stops everything; do it here so cue states
        // and the UI are told, rather than cues silently going quiet while
        // their buttons still show "playing".
        if (this.audioPlaybackManager.playingCues.size > 0) {
            await this.stopAllCues('stop');
        }
        const result = await this.audioPlaybackManager.applyAudioConfig(this._audioEngineConfig());
        if (this.config?.audioSampleRate) {
            this.audioFileManager?.setPcmSampleRate(this.config.audioSampleRate);
        }
        return result;
    }

    _schedulePersistWorkspace() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
        }
        this._saveDebounceTimer = setTimeout(async () => {
            this._saveDebounceTimer = null;
            const result = await this.saveWorkspace();
            if (!result.success) {
                console.warn(`CueManager: Debounced workspace save failed: ${result.error}`);
            }
        }, this._saveDebounceMs);
    }

    async flushPersistWorkspace() {
        return this._flushPersistWorkspace();
    }

    async _flushPersistWorkspace() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
            this._saveDebounceTimer = null;
        }
        return await this.saveWorkspace();
    }
    
    // Get all cues
    getCues() {
        return this.cueDataManager.getCues().map((cue) => this._mergeLiveState(cue));
    }

    // Get cue by ID
    getCue(cueId) {
        const cue = this.cueDataManager.getCue(cueId);
        return cue ? this._mergeLiveState(cue) : cue;
    }

    // Playback status (playing/paused/stopped, currentTime, totalTime) is
    // tracked in the in-memory this.cueStates map, not persisted to disk
    // (it's ephemeral runtime state, not cue configuration, and shouldn't
    // survive a restart or cost a disk write on every play/pause/stop).
    // cueDataManager's stored record only ever has the status it was
    // created/last-saved with. Without this merge, every REST read
    // (GET /api/cues, /api/cues/:id, /api/remote/cues) would return a
    // permanently stale status - WebSocket broadcasts are the only thing
    // that would ever reflect live state.
    _mergeLiveState(cue) {
        const liveState = this.cueStates.get(cue.id);
        if (!liveState) {
            return cue;
        }
        return {
            ...cue,
            status: liveState.status,
            currentTime: liveState.currentTime ?? cue.currentTime,
            totalTime: liveState.totalTime ?? cue.totalTime,
        };
    }

    // Create new cue
    async createCue(cueData) {
        try {
            // If it's a single file cue with audioFileId, fetch the duration
            if (cueData.type === 'single_file' && cueData.audioFileId) {
                try {
                    const audioFile = await this.audioFileManager.loadAudioFileMetadata(cueData.audioFileId);
                    if (audioFile && audioFile.duration) {
                        cueData.knownDuration = audioFile.duration;
                        console.log(`CueManager: Set duration for cue ${cueData.name}: ${audioFile.duration}s`);
                    }
                } catch (error) {
                    console.warn(`⚠️ CueManager: Could not fetch duration for audio file ${cueData.audioFileId}: ${error.message}`);
                }
            }
            
            // If it's a playlist cue, fetch durations for all items
            if (cueData.type === 'playlist' && cueData.playlistItems) {
                for (const item of cueData.playlistItems) {
                    if (item.audioFileId) {
                        try {
                            const audioFile = await this.audioFileManager.loadAudioFileMetadata(item.audioFileId);
                            if (audioFile && audioFile.duration) {
                                item.knownDuration = audioFile.duration;
                                console.log(`CueManager: Set duration for playlist item ${item.name}: ${audioFile.duration}s`);
                            }
                        } catch (error) {
                            console.warn(`⚠️ CueManager: Could not fetch duration for playlist item ${item.audioFileId}: ${error.message}`);
                        }
                    }
                }
            }
            
            const cue = this.cueDataManager.createCue(cueData);
            this.cueDataManager.addCue(cue);
            
            // Broadcast update
            await this.websocketManager.broadcastCuesUpdate(this.getCues());
            
            console.log(`CueManager: Created cue: ${cue.name} (${cue.id})`);
            this._schedulePersistWorkspace();
            return { success: true, cue: cue };
            
        } catch (error) {
            console.error(`CueManager: Error creating cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Update cue
    async updateCue(cueId, updates) {
        try {
            const result = this.cueDataManager.updateCue(cueId, updates);

            if (result.success) {
                this._applyLiveUpdates(cueId, updates || {});

                // Broadcast update
                this.websocketManager.broadcastCueUpdate(cueId, updates);
                await this.websocketManager.broadcastCuesUpdate(this.getCues());

                console.log(`📝 CueManager: Updated cue: ${cueId}`);
                this._schedulePersistWorkspace();
            }

            return result;

        } catch (error) {
            console.error(`CueManager: Error updating cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Edits to a cue that is playing right now take effect immediately
    // where that makes sense: its volume, and anything that changes who is
    // ducking whom.
    _applyLiveUpdates(cueId, updates) {
        if (this.audioPlaybackManager.playingCues.has(cueId) && typeof updates.volume === 'number') {
            this.audioPlaybackManager.setCueVolume(cueId, updates.volume);
        }
        if ('playlistItems' in updates) {
            this.shuffleOrders.delete(cueId);
        }
        if (['isDuckingTrigger', 'enableDucking', 'duckingLevel'].some((k) => k in updates)) {
            this._updateDucking();
        }
    }

    // A library file was replaced with a new version (same id). Every cue
    // using it - in this project and all others - gets the new duration
    // (and new name, if the file type changed); cached decoded audio of the
    // old version is dropped so the next play uses the new one.
    async handleAudioFileReplaced(audioFile, previous = {}) {
        const mapRef = (ref) => {
            const matches = ref.audioFileId === audioFile.id
                || (previous.relativePath && ref.relativePath === previous.relativePath);
            return matches
                ? { audioFileId: audioFile.id, relativePath: audioFile.relativePath, knownDuration: audioFile.duration || 0 }
                : null;
        };
        const result = await this.cueDataManager.rewriteAudioReferences(mapRef);
        this.audioPlaybackManager.audioBuffers.delete(previous.path);
        this.audioPlaybackManager.audioBuffers.delete(audioFile.path);
        if (result.cuesUpdated > 0) {
            this._schedulePersistWorkspace();
        }
        await this.websocketManager.broadcastCuesUpdate(this.getCues());
        return result;
    }

    // Reorder cues (drag-and-drop in the grid). Accepts ids or cue objects.
    async reorderCues(order) {
        try {
            if (!Array.isArray(order)) {
                return { success: false, error: 'cueIds must be an array' };
            }
            const ids = order.map((entry) => (typeof entry === 'string' ? entry : entry?.id));
            const result = this.cueDataManager.reorderCues(ids);
            if (result.success) {
                await this.websocketManager.broadcastCuesUpdate(this.getCues());
                this._schedulePersistWorkspace();
            }
            return result;
        } catch (error) {
            console.error(`CueManager: Error reordering cues: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Delete cue
    async deleteCue(cueId) {
        try {
            // Stop cue if playing
            await this.stopCue(cueId);

            const result = this.cueDataManager.deleteCue(cueId);

            if (result.success) {
                // Clean up state
                this.playingCues.delete(cueId);
                this.cueStates.delete(cueId);
                this.shuffleOrders.delete(cueId);
                this._duckState.delete(cueId);
                this._updateDucking();

                // Broadcast update
                await this.websocketManager.broadcastCuesUpdate(this.getCues());

                console.log(`CueManager: Deleted cue: ${cueId}`);
                this._schedulePersistWorkspace();
            }

            return result;

        } catch (error) {
            console.error(`CueManager: Error deleting cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // --- Triggering ---------------------------------------------------------

    // Runs operations on one cue one at a time, in arrival order. Starting a
    // cue takes a moment (loading/decoding its audio), and a second press
    // arriving meanwhile used to see the cue as not yet playing and start it
    // fresh again - so a quick double press on a "play new instance" cue gave
    // one instance instead of two, and "toggle pause" never paused.
    _serialized(cueId, operation) {
        const previous = this._cueQueues.get(cueId) || Promise.resolve();
        const run = previous.catch(() => {}).then(operation);
        const tail = run.catch(() => {});
        this._cueQueues.set(cueId, tail);
        tail.then(() => {
            if (this._cueQueues.get(cueId) === tail) this._cueQueues.delete(cueId);
        });
        return run;
    }

    // The one entry point for "the operator pressed this cue" - the REST
    // trigger route, the UI's toggle, the remote page and Companion all land
    // here. A cue that is playing or paused goes through its retrigger
    // behavior (options.retriggerBehavior overrides the cue's own); anything
    // else starts fresh.
    async triggerCue(cueId, options = {}) {
        return this._serialized(cueId, () => this._triggerCueNow(cueId, options));
    }

    async _triggerCueNow(cueId, options = {}) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }

            const status = this.cueStates.get(cueId)?.status;
            if (status === 'playing' || status === 'paused') {
                const behavior = options.retriggerBehavior || cue.retriggerBehavior || 'restart';
                const action = resolveRetrigger(behavior, status, cue.type === 'playlist');
                return await this._applyRetriggerAction(cue, action, options);
            }

            return await this._startCue(cue, options);

        } catch (error) {
            console.error(`CueManager: Error triggering cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Toggle cue (the UI's click) - same semantics as triggerCue.
    async toggleCue(cueId, options = {}) {
        return this.triggerCue(cueId, options);
    }

    async _applyRetriggerAction(cue, action, options = {}) {
        switch (action) {
            case 'restart':
                await this.stopCuePlayback(cue.id, 0);
                return this._startCue(this.getCue(cue.id), { ...options, noCrossfade: true });
            case 'pause':
                return this._pauseCue(cue.id);
            case 'resume':
                return this._resumeCue(cue.id);
            case 'stop':
                return this.stopCuePlayback(cue.id, 0);
            case 'fade_stop':
                return this.stopCuePlayback(cue.id, this._fadeOutMsFor(cue));
            case 'nothing':
                return { success: true, message: 'Cue already playing' };
            case 'new_instance':
                return this._startNewInstance(cue, options);
            case 'next_item':
                return this._skipToNextItem(cue);
            default:
                return { success: false, error: `Unknown retrigger action: ${action}` };
        }
    }

    // A cue fades out over its own fade-out time; 0 means stop instantly.
    _fadeOutMsFor(cue) {
        return Math.max(0, Number(cue.fadeOutTime) || 0);
    }

    // Starts a cue that isn't playing: sets up its shuffle order, applies
    // crossfade mode, and starts it at the right duck level.
    async _startCue(cue, options = {}) {
        if (cue.type === 'playlist' && cue.playlistItems?.length) {
            cue = await this._preparePlaylistForStart(cue);
        }

        let fadeInOverrideMs = null;
        if (this.crossfadeMode && !options.noCrossfade) {
            const crossfadeMs = this.config?.crossfadeTime ?? 2000;
            const others = Array.from(this.audioPlaybackManager.playingCues.keys()).filter((id) => id !== cue.id);
            for (const otherId of others) {
                await this.stopCuePlayback(otherId, crossfadeMs);
            }
            fadeInOverrideMs = crossfadeMs;
        }

        const playbackInfo = await this.startCuePlayback(cue, { ...options, fadeInOverrideMs });

        if (playbackInfo.success) {
            this.playingCues.set(cue.id, playbackInfo);
            this.cueStates.set(cue.id, {
                status: 'playing',
                startTime: Date.now(),
                currentTime: 0,
                totalTime: cue.totalTime || 0
            });
            this.websocketManager.broadcastCueStatus(cue.id, 'playing', {
                currentTime: 0,
                totalTime: cue.totalTime || 0,
                ...this._playlistPosition(cue),
            });
            this._updateDucking();
            console.log(`CueManager: Started cue: ${cue.name} (${cue.id})`);
        }

        return playbackInfo;
    }

    // Shuffle: a fresh start (not resuming a cued item, not mid-order after
    // a manual stop) draws a new random order and starts at its first item.
    async _preparePlaylistForStart(cue) {
        const itemCount = cue.playlistItems.length;
        if (!cue.shufflePlaylist) {
            this.shuffleOrders.delete(cue.id);
            return cue;
        }
        if (isValidOrder(this.shuffleOrders.get(cue.id), itemCount)) {
            return cue;
        }
        const order = shuffledOrder(itemCount, this._rng);
        this.shuffleOrders.set(cue.id, order);
        const isCued = this.cueStates.get(cue.id)?.status === 'cued_next';
        if (!isCued && order[0] !== (cue.currentPlaylistIndex || 0)) {
            await this.updateCue(cue.id, { currentPlaylistIndex: order[0] });
            return this.getCue(cue.id);
        }
        return cue;
    }

    _playlistPosition(cue) {
        if (cue.type !== 'playlist' || !cue.playlistItems?.length) {
            return {};
        }
        const currentIndex = cue.currentPlaylistIndex || 0;
        return {
            playlistIndex: currentIndex,
            nextPlaylistIndex: peekNextIndex({
                itemCount: cue.playlistItems.length,
                currentIndex,
                shuffle: Boolean(cue.shufflePlaylist),
                order: this.shuffleOrders.get(cue.id),
                loop: Boolean(cue.loop),
            }),
        };
    }

    // "Play New Instance": another voice of the same cue on top of the ones
    // already playing. The cue counts as playing until its last voice ends.
    async _startNewInstance(cue, options = {}) {
        const result = await this.startCuePlayback(cue, { ...options, newInstance: true });
        if (result.success) {
            const voiceCount = this.audioPlaybackManager.voiceCount(cue.id);
            this.websocketManager.broadcastCueStatus(cue.id, 'playing', {
                voiceCount,
                ...this._playlistPosition(cue),
            });
            console.log(`CueManager: New instance of ${cue.name} (${voiceCount} playing)`);
        }
        return result;
    }

    // "Play Next Item": behave as if the current item had just ended in
    // 'continue' mode - next item (shuffle-aware), wrapping with loop, and
    // finishing the playlist after the last one.
    async _skipToNextItem(cue) {
        const decision = decideItemEnd({
            itemCount: cue.playlistItems.length,
            currentIndex: cue.currentPlaylistIndex || 0,
            mode: 'continue',
            loop: Boolean(cue.loop),
            shuffle: Boolean(cue.shufflePlaylist),
            order: this.shuffleOrders.get(cue.id),
            rng: this._rng,
        });
        await this.stopCuePlayback(cue.id, 0);
        this._rememberOrder(cue.id, decision.order);
        await this._setPlaylistIndex(cue, decision.nextIndex);
        if (decision.action === 'finish') {
            return { success: true, finished: true };
        }
        return this._startCue(this.getCue(cue.id), { noCrossfade: true });
    }

    _rememberOrder(cueId, order) {
        if (order) {
            this.shuffleOrders.set(cueId, order);
        } else {
            this.shuffleOrders.delete(cueId);
        }
    }

    async _setPlaylistIndex(cue, index) {
        if ((cue.currentPlaylistIndex || 0) !== index) {
            await this.updateCue(cue.id, { currentPlaylistIndex: index });
        }
    }

    // --- Stopping -----------------------------------------------------------

    // Stop cue (REST /stop). With fadeOut, fades over the cue's fade-out time.
    async stopCue(cueId, fadeOut = false) {
        return this._serialized(cueId, () => this._stopCueNow(cueId, fadeOut));
    }

    async _stopCueNow(cueId, fadeOut = false) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }
            return await this.stopCuePlayback(cueId, fadeOut ? this._fadeOutMsFor(cue) : 0);
        } catch (error) {
            console.error(`CueManager: Error stopping cue: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Stop all cues
    // behavior: 'stop' | 'fade_out_and_stop'. Omitted, it is the configured
    // Stop All behavior - so the remote page and Companion's Stop All do the
    // same as the main UI's button. Internal callers (workspace load,
    // shutdown, device change) always pass 'stop'.
    async stopAllCues(behavior) {
        try {
            const effectiveBehavior = behavior || this.config?.defaultStopAllBehavior || 'stop';
            const fadeOut = effectiveBehavior === 'fade_out_and_stop';
            // Stop All fades every cue over its own configured time
            // (defaultStopAllFadeOutTime, ms), not each cue's fadeOutTime -
            // most cues have a fadeOutTime of 0, which would make a "fade"
            // Stop All an instant cut.
            const stopAllFadeMs = this.config?.defaultStopAllFadeOutTime ?? 1500;
            const fadeOverrideSeconds = fadeOut ? Math.max(0, stopAllFadeMs) / 1000 : null;

            const result = await this.audioPlaybackManager.stopAllCues(fadeOut, fadeOverrideSeconds);

            if (result.success) {
                // Same reasoning as stopCuePlayback(): a cue whose fade has
                // only just *started* is still audibly playing, so its state
                // is left alone here - handleCuePlaybackComplete() cleans up
                // and broadcasts 'stopped' once the fade reaches silence.
                // Every cue that was stopped immediately (including a "fade"
                // with a fade time of 0) gets no such callback, so it has to
                // be cleaned up and broadcast here - skipping that left its
                // button stuck showing "playing" after the audio had stopped.
                for (const { cueId, fading } of result.results) {
                    if (fading) continue;
                    this.playingCues.delete(cueId);
                    this.cueStates.delete(cueId);
                    this.websocketManager.broadcastCueStatus(cueId, 'stopped');
                }
                // A playlist cued on its next item isn't playing, but Stop
                // All should still clear it back to idle.
                for (const [cueId, state] of Array.from(this.cueStates)) {
                    if (state.status === 'cued_next') {
                        this.cueStates.delete(cueId);
                        this.websocketManager.broadcastCueStatus(cueId, 'stopped');
                    }
                }
                if (!fadeOut) {
                    this.playingCues.clear();
                    this.cueStates.clear();
                }
                this._updateDucking();

                console.log(`CueManager: Stopped ${result.results.length} cues`);
            }

            return result;

        } catch (error) {
            console.error(`CueManager: Error stopping all cues: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Stop cue playback. fadeOutMs > 0 fades over that long (whatever the
    // cue's fade time was when it started); 0 stops immediately.
    async stopCuePlayback(cueId, fadeOutMs = 0) {
        try {
            const fadeMs = Math.max(0, Number(fadeOutMs) || 0);
            // The audio playback manager reports whether a fade really
            // started (it never fades a paused cue) - that decides whether a
            // completion callback is coming.
            const result = await this.audioPlaybackManager.stopCue(cueId, fadeMs > 0, fadeMs / 1000);
            const isFading = Boolean(result.fading);

            // A fade-out only *starts* here - the cue is still audibly
            // playing (gradually getting quieter) for the whole fade in the
            // mixer's render loop, so its state is left as-is and
            // handleCuePlaybackComplete() broadcasts 'stopped' once the fade
            // actually reaches silence. For an immediate stop nothing else
            // will ever fire that, so it's done here directly.
            if (result.success && !isFading) {
                const hadState = this.playingCues.has(cueId) || this.cueStates.has(cueId);
                this.playingCues.delete(cueId);
                this.cueStates.delete(cueId);
                if (hadState) {
                    this.websocketManager.broadcastCueStatus(cueId, 'stopped');
                    console.log(`CueManager: Stopped cue: ${cueId}`);
                }
                this._updateDucking();
            }

            return result;

        } catch (error) {
            console.error(`CueManager: Error stopping playback: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // --- Playlist navigation ------------------------------------------------

    // The grid's ◀ ▶ buttons. Follows the shuffle order, clamps at both
    // ends. A playing (or paused) playlist plays the newly selected item; a
    // cued one stays cued, on the new item.
    async navigatePlaylist(cueId, direction) {
        return this._serialized(cueId, () => this._navigatePlaylistNow(cueId, direction));
    }

    async _navigatePlaylistNow(cueId, direction) {
        try {
            const cue = this.getCue(cueId);
            if (!cue || cue.type !== 'playlist') {
                return { success: false, error: 'Cue not found or not a playlist' };
            }

            const currentIndex = cue.currentPlaylistIndex || 0;
            const newIndex = stepIndex({
                itemCount: cue.playlistItems.length,
                currentIndex,
                direction,
                shuffle: Boolean(cue.shufflePlaylist),
                order: this.shuffleOrders.get(cueId),
            });

            if (newIndex !== currentIndex) {
                await this.updateCue(cueId, { currentPlaylistIndex: newIndex });

                const status = this.cueStates.get(cueId)?.status;
                if (status === 'playing' || status === 'paused') {
                    await this.stopCuePlayback(cueId, 0);
                    await this._startCue(this.getCue(cueId), { noCrossfade: true });
                } else if (status === 'cued_next') {
                    this.websocketManager.broadcastCueStatus(cueId, 'cued_next', {
                        nextItem: cue.playlistItems[newIndex]?.name || null,
                        playlistIndex: newIndex,
                    });
                }

                console.log(`CueManager: Navigated playlist ${direction}: ${cue.name} (${cueId})`);
            }

            return { success: true, newIndex: newIndex };

        } catch (error) {
            console.error(`CueManager: Error navigating playlist: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Jump a playlist to a specific item (0-based). A playing or paused
    // playlist plays it; a cued one stays cued, on that item; an idle one
    // will start there.
    async jumpToPlaylistItem(cueId, index) {
        return this._serialized(cueId, async () => {
            const cue = this.getCue(cueId);
            if (!cue || cue.type !== 'playlist') {
                return { success: false, error: 'Cue not found or not a playlist' };
            }
            const target = Number(index);
            const itemCount = cue.playlistItems?.length || 0;
            if (!Number.isInteger(target) || target < 0 || target >= itemCount) {
                return { success: false, error: `Item index must be 0-${Math.max(0, itemCount - 1)}` };
            }
            await this.updateCue(cueId, { currentPlaylistIndex: target });
            const status = this.cueStates.get(cueId)?.status;
            if (status === 'playing' || status === 'paused') {
                await this.stopCuePlayback(cueId, 0);
                await this._startCue(this.getCue(cueId), { noCrossfade: true });
            } else if (status === 'cued_next') {
                this.websocketManager.broadcastCueStatus(cueId, 'cued_next', {
                    nextItem: cue.playlistItems[target]?.name || null,
                    playlistIndex: target,
                });
            }
            return { success: true, newIndex: target };
        });
    }

    // --- Pause / resume -----------------------------------------------------

    async _pauseCue(cueId) {
        const state = this.cueStates.get(cueId);
        const result = await this.audioPlaybackManager.pauseCue(cueId);
        if (!result.success || !state) {
            return result.success ? { success: false, error: 'Cue not playing' } : result;
        }
        state.status = 'paused';
        state.pausedAt = Date.now();
        this.websocketManager.broadcastCueStatus(cueId, 'paused');
        this._updateDucking();
        console.log(`CueManager: Paused cue: ${cueId}`);
        return { success: true, status: 'paused' };
    }

    async _resumeCue(cueId) {
        const state = this.cueStates.get(cueId);
        const result = await this.audioPlaybackManager.resumeCue(cueId);
        if (!result.success || !state) {
            return result.success ? { success: false, error: 'Cue not paused' } : result;
        }
        state.status = 'playing';
        state.resumedAt = Date.now();
        this.websocketManager.broadcastCueStatus(cueId, 'playing');
        this._updateDucking();
        console.log(`CueManager: Resumed cue: ${cueId}`);
        return { success: true, status: 'playing' };
    }

    // Toggle pause/resume cue (REST /toggle-pause)
    async togglePauseCue(cueId) {
        return this._serialized(cueId, () => this._togglePauseCueNow(cueId));
    }

    async _togglePauseCueNow(cueId) {
        try {
            const cue = this.getCue(cueId);
            if (!cue) {
                return { success: false, error: 'Cue not found' };
            }
            const status = this.cueStates.get(cueId)?.status;
            if (status === 'playing') return this._pauseCue(cueId);
            if (status === 'paused') return this._resumeCue(cueId);
            return { success: false, error: 'Cue not playing' };
        } catch (error) {
            console.error(`CueManager: Error toggling pause: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // --- Ducking ------------------------------------------------------------

    // The duck multiplier a cue should have right now: lowered by the
    // strongest ducking trigger that is audibly playing (other than itself),
    // if the cue has ducking enabled; 1 otherwise. A paused trigger isn't
    // making sound, so it doesn't duck anything.
    _duckMultiplierFor(cueId) {
        const cue = this.cueDataManager.getCue(cueId);
        if (!cue?.enableDucking) {
            return 1;
        }
        let strongest = null;
        for (const [otherId, state] of this.cueStates) {
            if (otherId === cueId || state.status !== 'playing') continue;
            if (!this.audioPlaybackManager.playingCues.has(otherId)) continue;
            const other = this.cueDataManager.getCue(otherId);
            if (!other?.isDuckingTrigger) continue;
            const level = Math.min(100, Math.max(0, Number(other.duckingLevel ?? 80)));
            strongest = strongest === null ? level : Math.max(strongest, level);
        }
        return strongest === null ? 1 : 1 - strongest / 100;
    }

    // Recomputes every playing cue's duck level and ramps the ones that
    // changed. Called whenever anything starts, stops, pauses, resumes or
    // has its ducking settings edited - simpler and harder to get wrong
    // than tracking which trigger ducked which cue.
    _updateDucking() {
        const playing = new Set(this.audioPlaybackManager.playingCues.keys());
        for (const cueId of Array.from(this._duckState.keys())) {
            if (!playing.has(cueId)) this._duckState.delete(cueId);
        }
        for (const cueId of playing) {
            const target = this._duckMultiplierFor(cueId);
            const current = this._duckState.get(cueId) ?? 1;
            if (Math.abs(target - current) > 1e-9) {
                this.audioPlaybackManager.setCueDuck(cueId, target, this._duckFadeSeconds());
                this._duckState.set(cueId, target);
            }
        }
    }

    _duckFadeSeconds() {
        const ms = this.config?.duckingFadeTime ?? DEFAULT_DUCK_FADE_MS;
        return Math.max(0, ms) / 1000;
    }

    // --- Crossfade mode -----------------------------------------------------

    // While on, starting a cue fades every other playing cue out and the new
    // one in, both over the configured crossfadeTime. Live session state
    // (like the legacy app's XFADE button), not a saved preference.
    setCrossfadeMode(enabled) {
        this.crossfadeMode = Boolean(enabled);
        this.websocketManager?.broadcast({
            type: 'crossfade-mode-updated',
            payload: { enabled: this.crossfadeMode },
        });
        console.log(`CueManager: Crossfade mode ${this.crossfadeMode ? 'on' : 'off'}`);
        return { success: true, enabled: this.crossfadeMode };
    }

    getCrossfadeMode() {
        return this.crossfadeMode;
    }

    // Start cue playback
    async startCuePlayback(cue, options = {}) {
        try {
            let filePath = null;
            let audioFile = null;

            // For single file cues, we need to get the audio file info
            if (cue.type === 'single_file' && cue.relativePath) {
                // Find the audio file in the audio manager
                audioFile = await this.audioFileManager.getAudioFileByPath(cue.relativePath);
                if (audioFile) {
                    filePath = audioFile.path;
                }
            }

            // For playlist cues, handle the current item
            if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                const currentItem = cue.playlistItems[cue.currentPlaylistIndex || 0];
                if (currentItem) {
                    audioFile = await this.audioFileManager.getAudioFileByPath(currentItem.relativePath);
                    if (audioFile) {
                        filePath = audioFile.path;
                    }
                }
            }

            if (!filePath) {
                return { success: false, error: 'Audio file not found' };
            }

            const volume = typeof cue.volume === 'number' ? cue.volume : 1.0;
            const fadeInMs = options.fadeInOverrideMs ?? cue.fadeInTime ?? 0;
            const duckGain = this._duckMultiplierFor(cue.id);

            // Prepare playback options
            const playbackOptions = {
                volume,
                fadeInTime: Math.max(0, fadeInMs) / 1000, // Convert to seconds
                fadeOutTime: (cue.fadeOutTime || 0) / 1000, // Convert to seconds
                trimStartTime: cue.trimStartTime || 0,
                trimEndTime: cue.trimEndTime || null,
                // A playlist's loop repeats the whole list (see
                // _handlePlaylistItemEnd), not the item that's playing.
                loop: cue.type === 'playlist' ? false : Boolean(cue.loop),
                outputPatch: cue.outputPatch,
                // Start already ducked if a trigger is playing, rather than
                // blasting in at full level and then ducking.
                duckGain,
                newInstance: Boolean(options.newInstance),
            };

            // Use the audio playback manager to actually play the audio
            const result = await this.audioPlaybackManager.playCue(cue.id, filePath, playbackOptions);

            if (result.success) {
                this._duckState.set(cue.id, duckGain);
                const playbackInfo = {
                    cueId: cue.id,
                    startTime: Date.now(),
                    duration: audioFile?.duration || 0,
                    volume,
                    fadeInTime: fadeInMs,
                    fadeOutTime: cue.fadeOutTime || 0,
                    source: options.source || 'unknown',
                    audioFileId: audioFile?.id,
                    filePath: filePath
                };

                return { success: true, playbackInfo: playbackInfo };
            } else {
                return result;
            }

        } catch (error) {
            console.error(`CueManager: Error starting playback: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Handle cue playback ending in the mixer - either it reached the
    // natural end of the file (reason 'completed') or a deliberate
    // fade-out-and-stop just reached silence (reason 'stopped'). Both arrive
    // here because they're the same mechanism in the mixer's render loop
    // (a cue being removed from the active set); which one it was matters
    // for the broadcast status a client sees and for whether a playlist
    // should treat this as "track ended, advance to the next item" - a
    // deliberate stop should never auto-advance a playlist.
    async handleCuePlaybackComplete(cueId, reason = 'completed') {
        try {
            const cue = this.getCue(cueId);
            if (!cue) return;

            this.playingCues.delete(cueId);

            // A playlist item reaching its natural end decides what the
            // playlist does next - a deliberate fade-out stop never does.
            if (reason === 'completed' && cue.type === 'playlist' && cue.playlistItems?.length) {
                await this._handlePlaylistItemEnd(cue);
                return;
            }

            this.cueStates.set(cueId, {
                status: reason,
                currentTime: cue.totalTime || 0,
                totalTime: cue.totalTime || 0,
                completedAt: Date.now()
            });

            this.websocketManager.broadcastCueStatus(cueId, reason);
            this._updateDucking();

            console.log(`CueManager: Cue ${reason}: ${cue.name} (${cueId})`);

        } catch (error) {
            console.error(`CueManager: Error handling completion: ${error.message}`);
        }
    }

    // What a playlist does when its current item plays to the end - see
    // playlistLogic.decideItemEnd for the rules (continue / cue next /
    // repeat one, loop, shuffle).
    async _handlePlaylistItemEnd(cue) {
        const cueId = cue.id;
        const decision = decideItemEnd({
            itemCount: cue.playlistItems.length,
            currentIndex: cue.currentPlaylistIndex || 0,
            mode: cue.playlistPlayMode || 'continue',
            repeatOne: Boolean(cue.repeatOnePlaylistItem),
            loop: Boolean(cue.loop),
            shuffle: Boolean(cue.shufflePlaylist),
            order: this.shuffleOrders.get(cueId),
            rng: this._rng,
        });

        this._rememberOrder(cueId, decision.order);
        await this._setPlaylistIndex(cue, decision.nextIndex);

        if (decision.action === 'finish') {
            this.cueStates.delete(cueId);
            this.websocketManager.broadcastCueStatus(cueId, 'completed');
            this._updateDucking();
            console.log(`CueManager: Playlist finished: ${cue.name} (${cueId})`);
            return;
        }

        if (decision.action === 'cue') {
            const nextItem = cue.playlistItems[decision.nextIndex];
            this.cueStates.set(cueId, { status: 'cued_next', currentTime: 0, totalTime: 0 });
            this.websocketManager.broadcastCueStatus(cueId, 'cued_next', {
                nextItem: nextItem?.name || null,
                playlistIndex: decision.nextIndex,
            });
            this._updateDucking();
            console.log(`CueManager: Playlist ${cue.name} cued item ${decision.nextIndex + 1}/${cue.playlistItems.length}`);
            return;
        }

        this.cueStates.delete(cueId);
        const result = await this._startCue(this.getCue(cueId), { source: 'playlist_advance', noCrossfade: true });
        if (!result.success) {
            this.websocketManager.broadcastCueStatus(cueId, 'stopped');
            this._updateDucking();
            console.error(`CueManager: Playlist ${cue.name} could not play item ${decision.nextIndex + 1}: ${result.error}`);
        }
    }

    // Get current workspace
    getCurrentWorkspace() {
        return this.cueDataManager.getCurrentWorkspace();
    }
    
    // Save current workspace
    async saveWorkspace(name = null, description = null) {
        return await this.cueDataManager.saveWorkspace(name, description);
    }
    
    // --- Projects -------------------------------------------------------------
    // A project is a saved workspace: its cues and layout. Everything is
    // saved automatically; switching projects never loses an edit.

    setProjectOpenedListener(listener) {
        this._onProjectOpened = listener;
    }

    // Every way of changing the open project goes through here: save what's
    // pending for the current one (an edit made just before switching was
    // lost otherwise - the debounced save then wrote into the *new* project),
    // stop playback, switch, then tell every open page.
    async _switchProject(activate) {
        await this._flushPersistWorkspace();
        await this.stopAllCues('stop');
        this.cueStates.clear();
        this.shuffleOrders.clear();
        this.playingCues.clear();

        const result = await activate();
        if (result?.success) {
            const workspace = this.getCurrentWorkspace();
            this.websocketManager.broadcastWorkspaceUpdate(workspace);
            await this.websocketManager.broadcastCuesUpdate(this.getCues());
            if (this._onProjectOpened) {
                await Promise.resolve(this._onProjectOpened(workspace.id)).catch(() => {});
            }
        }
        return result;
    }

    async newProject(name) {
        const projectName = String(name || '').trim() || 'Untitled Project';
        return this._switchProject(async () => ({
            success: true,
            workspace: await this.cueDataManager.createWorkspace(projectName),
        }));
    }

    async openProject(projectId) {
        return this._switchProject(() => this.cueDataManager.loadWorkspace(projectId));
    }

    // Kept for the older workspace API.
    async loadWorkspace(workspaceId) {
        return this.openProject(workspaceId);
    }

    async renameProject(name) {
        const projectName = String(name ?? '').trim();
        if (!projectName) {
            return { success: false, error: 'Project name cannot be empty' };
        }
        const workspace = this.getCurrentWorkspace();
        if (!workspace) {
            return { success: false, error: 'No project is open' };
        }
        workspace.name = projectName.slice(0, 200);
        const saved = await this._flushPersistWorkspace();
        this.websocketManager.broadcastWorkspaceUpdate(this.getCurrentWorkspace());
        return saved.success ? { success: true, project: this._projectSummary(this.getCurrentWorkspace()) } : saved;
    }

    async deleteProject(projectId) {
        if (projectId === this.getCurrentWorkspace()?.id) {
            return { success: false, error: 'The open project cannot be deleted - open another one first' };
        }
        return this.cueDataManager.deleteWorkspace(projectId);
    }

    _projectSummary(workspace) {
        return {
            id: workspace.id,
            name: workspace.name,
            cueCount: Array.isArray(workspace.cues) ? workspace.cues.length : (workspace.cueCount ?? 0),
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt || workspace.lastModified,
        };
    }

    async listProjects() {
        await this._flushPersistWorkspace();
        const currentId = this.getCurrentWorkspace()?.id;
        const workspaces = await this.cueDataManager.getAllWorkspaces();
        return workspaces.map((w) => ({ ...this._projectSummary(w), isCurrent: w.id === currentId }));
    }

    getCurrentProject() {
        const workspace = this.getCurrentWorkspace();
        return workspace ? this._projectSummary({ ...workspace, cues: this.cueDataManager.getCues() }) : null;
    }

    /**
     * Creates and opens a project from an unpacked bundle: its audio joins
     * the library (reusing files already there, see AudioFileManager.addFile)
     * and its cues are pointed at the resulting library files.
     */
    async importProject({ project, audio }) {
        const byBundleName = new Map();
        const audioResults = { added: 0, reused: 0, renamed: 0, failed: [] };
        for (const file of audio) {
            const result = await this.audioFileManager.addFile(file.path, file.name);
            if (!result.success) {
                audioResults.failed.push({ name: file.name, error: result.error });
                continue;
            }
            byBundleName.set(file.name.toLowerCase(), result.audioFile);
            if (result.reused) audioResults.reused += 1;
            else audioResults.added += 1;
            if (result.renamed) audioResults.renamed += 1;
        }

        const cues = JSON.parse(JSON.stringify(project.cues || []));
        rewriteCueReferences(cues, (ref) => {
            const record = ref.relativePath && byBundleName.get(path.basename(ref.relativePath).toLowerCase());
            return record ? { audioFileId: record.id, relativePath: record.relativePath } : null;
        });

        const name = String(project.name || '').trim() || 'Imported Project';
        const result = await this._switchProject(async () => ({
            success: true,
            workspace: await this.cueDataManager.createWorkspace(name, project.description || '', {
                cues,
                layout: project.layout,
            }),
        }));
        return { ...result, project: this.getCurrentProject(), audio: audioResults };
    }
    
    // Handle playback end (called by AudioPlaybackManager)
    handlePlaybackEnd(cueId, reason = 'completed') {
        // Queued with the cue's other operations, so e.g. a playlist moving
        // to its next item can't interleave with a press on that playlist.
        this._serialized(cueId, () => this.handleCuePlaybackComplete(cueId, reason)).catch((error) => {
            console.error(`CueManager: Error handling playback end for cue ${cueId}:`, error);
        });
    }
    
    // Get playback status
    getPlaybackStatus() {
        const status = {
            playingCues: Array.from(this.playingCues.keys()),
            totalPlaying: this.playingCues.size,
            cueStates: Object.fromEntries(this.cueStates),
            masterVolume: this.audioPlaybackManager?.getMasterVolume() ?? 1.0,
            crossfadeMode: this.crossfadeMode,
            // What the audio engine is actually doing, voice by voice.
            voices: (this.audioPlaybackManager?.mixer?.getStatus().playing || []).map((v) => ({
                cueId: v.cueId,
                voiceId: v.voiceId,
                isPaused: v.isPaused,
                isFadingIn: v.isFadingIn,
                isFadingOut: v.isFadingOut,
                isDucked: v.isDucked,
                duckGain: v.duckGain,
                gain: v.currentGain,
                volume: v.volume,
                positionSec: v.positionSec,
                trimStartSec: v.trimStartSec,
                trimEndSec: v.trimEndSec,
                outputPatch: v.outputPatch,
            })),
        };

        return status;
    }

    // Master volume (0-2, applied as a gain multiplier over every cue's own
    // volume in the mixer). Not persisted - like a physical fader, it's
    // live session state, not a saved preference.
    setMasterVolume(volume) {
        if (typeof volume !== 'number' || Number.isNaN(volume)) {
            return { success: false, error: 'volume must be a number' };
        }
        this.audioPlaybackManager.setMasterVolume(volume);
        const applied = this.audioPlaybackManager.getMasterVolume();
        this.websocketManager?.broadcast({
            type: 'master-volume-updated',
            payload: { volume: applied }
        });
        return { success: true, volume: applied };
    }

    getMasterVolume() {
        return this.audioPlaybackManager?.getMasterVolume() ?? 1.0;
    }
    
    // Cleanup
    async cleanup() {
        try {
            // Stop all playing cues
            await this.stopAllCues('stop');

            if (this.audioPlaybackManager) {
                await this.audioPlaybackManager.cleanup();
            }

            if (this._playbackTimeInterval) {
                clearInterval(this._playbackTimeInterval);
                this._playbackTimeInterval = null;
            }
            
            // Save current workspace (flush any pending debounced save)
            await this._flushPersistWorkspace();
            
            console.log('CueManager: Cleanup completed');
            
        } catch (error) {
            console.error(`CueManager: Error during cleanup: ${error.message}`);
        }
    }
}

module.exports = CueManager;
