// src/frontend/audio/audioController.js
//
// Server-primary playback control. Real cue playback (trigger/stop/playlist
// nav) always happens on the Node.js server via RtAudio + the PCM mixer
// (src/backend/soundboardMixer.js) - this module's job is just to send the
// right WebSocket messages and track the server-broadcast playback state
// for the UI to read back (isPlaying/isPaused/getPlaybackTimes).
//
// The one thing that still plays audio locally in the browser is
// previewCue() - the "Preview (local)" button in the properties sidebar,
// for auditioning a file without triggering it live. It's a tiny
// single-shot Howler player, deliberately silent over the network: it used
// to also broadcast a real playback-time-update for the cue's actual ID
// (via the now-removed audioPlaybackWebSocketEmitter.js), which the server
// rebroadcast verbatim to every connected client - so previewing a cue
// locally could make it flash "playing" on the main grid, the /remote
// page, and Companion. Local preview should never touch shared state.

let websocket;
let cueStoreRef;
let audioControllerInitialized = false;

const serverPlaybackState = new Map();

function sendServerMessage(type, payload = {}) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        console.warn(`AudioController: WebSocket not connected, cannot send ${type}`);
        return false;
    }
    websocket.send(JSON.stringify({ type, payload }));
    return true;
}

function formatTimeMMSS(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// --- Server playback state tracking -----------------------------------

function updateServerPlaybackState(payload) {
    if (!payload?.cueId) return;

    const { cueId, status } = payload;
    if (status === 'stopped' || status === 'completed') {
        serverPlaybackState.delete(cueId);
        return;
    }

    // cue_status messages carry only some fields (e.g. no times, no duck
    // state); keep what the last message said for anything not included.
    const previous = serverPlaybackState.get(cueId) || {};
    const pick = (key, fallback) => (payload[key] !== undefined ? payload[key] : (previous[key] ?? fallback));
    serverPlaybackState.set(cueId, {
        status,
        currentTimeSec: payload.currentTime ?? payload.currentTimeSec ?? 0,
        totalTimeSec: payload.totalTime ?? payload.totalTimeSec ?? 0,
        isFadingIn: Boolean(payload.isFadingIn),
        isFadingOut: Boolean(payload.isFadingOut),
        fadeTimeRemainingMs: payload.fadeTimeRemainingMs || 0,
        isDucked: status === 'playing' || status === 'paused' ? Boolean(pick('isDucked', false)) : false,
        voiceCount: pick('voiceCount', 1),
        playlistIndex: pick('playlistIndex', null),
        nextPlaylistIndex: pick('nextPlaylistIndex', null),
    });
}

function playlistItemName(cue, index) {
    if (cue?.type !== 'playlist' || index === null || index === undefined) return null;
    const item = cue.playlistItems?.[index];
    return item ? (item.name || `Item ${index + 1}`) : null;
}

function buildServerPlaybackTimes(serverState, cue) {
    const totalTime = serverState.totalTimeSec || cue?.totalTime || cue?.knownDuration || 0;
    const currentTime = serverState.currentTimeSec || 0;
    const remaining = Math.max(0, totalTime - currentTime);

    return {
        currentTime,
        duration: totalTime,
        currentTimeFormatted: formatTimeMMSS(currentTime),
        durationFormatted: formatTimeMMSS(totalTime),
        remainingTime: remaining,
        remainingTimeFormatted: formatTimeMMSS(remaining),
        isPlaying: serverState.status === 'playing',
        isPaused: serverState.status === 'paused',
        isCued: serverState.status === 'cued_next',
        isPlaylist: cue?.type === 'playlist',
        // cueGrid.updateButtonPlayingState reads these to keep the fading
        // class/countdown on the button; without them every redraw cleared it.
        isFadingIn: serverState.isFadingIn,
        isFadingOut: serverState.isFadingOut,
        fadeTimeRemainingMs: serverState.fadeTimeRemainingMs,
        isDucked: serverState.isDucked,
        voiceCount: serverState.voiceCount || 1,
        currentPlaylistItemName: serverState.status === 'cued_next'
            ? null
            : playlistItemName(cue, serverState.playlistIndex ?? cue?.currentPlaylistIndex),
        nextPlaylistItemName: serverState.status === 'cued_next'
            ? playlistItemName(cue, serverState.playlistIndex ?? cue?.currentPlaylistIndex)
            : playlistItemName(cue, serverState.nextPlaylistIndex),
    };
}

/** Static fallback (nothing playing yet / no broadcast received) derived purely from cue data - trim-aware duration, no live engine involved. */
function buildStaticPlaybackTimes(cue) {
    if (!cue) {
        return {
            currentTime: 0, duration: 0, currentTimeFormatted: '0:00', durationFormatted: '0:00',
            remainingTime: 0, remainingTimeFormatted: '0:00', isPlaying: false, isPaused: false, isPlaylist: false,
        };
    }

    const originalDuration = cue.knownDuration || 0;
    const trimStart = cue.trimStartTime || 0;
    const trimEnd = (cue.trimEndTime !== undefined && cue.trimEndTime !== null) ? cue.trimEndTime : undefined;

    let duration;
    if (originalDuration <= 0) {
        duration = 0;
    } else if (trimEnd && trimEnd > trimStart) {
        duration = trimEnd - trimStart;
    } else if (trimStart > 0) {
        duration = originalDuration - trimStart;
    } else {
        duration = originalDuration;
    }
    duration = Math.max(0, duration);

    if (cue.type === 'playlist' && cue.playlistItems?.length) {
        const withDurations = cue.playlistItems.filter((item) => item.knownDuration > 0);
        duration = withDurations.length === cue.playlistItems.length
            ? cue.playlistItems.reduce((total, item) => total + (item.knownDuration || 0), 0)
            : (cue.playlistItems[0]?.knownDuration || 0);
    }

    return {
        currentTime: 0,
        duration,
        // An idle playlist shows which item a press would play.
        nextPlaylistItemName: playlistItemName(cue, cue.currentPlaylistIndex || 0),
        currentTimeFormatted: '0:00',
        durationFormatted: formatTimeMMSS(duration),
        remainingTime: duration,
        remainingTimeFormatted: formatTimeMMSS(duration),
        isPlaying: false,
        isPaused: false,
        isPlaylist: cue.type === 'playlist',
    };
}

function getPlaybackTimes(cueId) {
    if (serverPlaybackState.has(cueId)) {
        const cue = cueStoreRef?.getCueById(cueId);
        return buildServerPlaybackTimes(serverPlaybackState.get(cueId), cue);
    }
    return buildStaticPlaybackTimes(cueStoreRef?.getCueById(cueId));
}

function isPlaying(cueId) {
    return serverPlaybackState.get(cueId)?.status === 'playing';
}

function isPaused(cueId) {
    return serverPlaybackState.get(cueId)?.status === 'paused';
}

// --- Real (server-driven) playback control ------------------------------

function toggle(cueId, fromCompanion = false, retriggerBehaviorOverride = null) {
    if (!audioControllerInitialized) {
        console.error(`AudioController: toggle called for ${cueId} before initialization.`);
        return;
    }
    sendServerMessage('toggle_cue', { cueId, fromCompanion, retriggerBehavior: retriggerBehaviorOverride });
}

// --- Crossfade mode (server state, shared by every connected UI) ---------

let crossfadeEnabled = false;
const crossfadeListeners = new Set();

function setCrossfadeModeFromServer(enabled) {
    crossfadeEnabled = Boolean(enabled);
    crossfadeListeners.forEach((listener) => listener(crossfadeEnabled));
}

function isCrossfadeEnabled() {
    return crossfadeEnabled;
}

function onCrossfadeModeChange(listener) {
    crossfadeListeners.add(listener);
    listener(crossfadeEnabled);
}

function setCrossfadeMode(enabled) {
    return sendServerMessage('set_crossfade_mode', { enabled: Boolean(enabled) });
}

function stopAll(options = { useFade: true }) {
    if (!audioControllerInitialized) {
        console.error('AudioController: stopAll called before initialization.');
        return;
    }
    sendServerMessage('stop_all_cues', {
        behavior: options.useFade === false ? 'stop' : 'fade_out_and_stop',
    });
}

function playlistNavigateNext(cueId) {
    sendServerMessage('playlist_navigate', { cueId, direction: 'next' });
}

function playlistNavigatePrevious(cueId) {
    sendServerMessage('playlist_navigate', { cueId, direction: 'previous' });
}

// --- Local preview (the only thing that still plays audio in the browser) ---

let previewHowl = null;

function stopPreview() {
    if (previewHowl) {
        try {
            previewHowl.unload();
        } catch (_error) {
            // already gone
        }
        previewHowl = null;
    }
}

function previewCue(cue) {
    if (!cue) {
        console.error('AudioController: previewCue called without a cue.');
        return;
    }
    stopPreview();

    const audioFileId = cue.type === 'playlist'
        ? cue.playlistItems?.[cue.currentPlaylistIndex || 0]?.audioFileId
        : cue.audioFileId;

    if (!audioFileId) {
        console.warn(`AudioController: previewCue - no audio file to preview for cue ${cue.id}`);
        return;
    }

    console.log(`AudioController: Preview (local) for cue ${cue.id}`);
    previewHowl = new Howl({
        src: [`/api/audio/serve/${audioFileId}`],
        html5: true,
        volume: typeof cue.volume === 'number' ? cue.volume : 1.0,
        onend: stopPreview,
        onstop: stopPreview,
        onloaderror: (_id, error) => {
            console.error('AudioController: preview load error', error);
            stopPreview();
        },
        onplayerror: (_id, error) => {
            console.error('AudioController: preview play error', error);
            stopPreview();
        },
    });
    previewHowl.play();
}

// --- Bootstrap ------------------------------------------------------------

function init(cs, websocketInstance) {
    cueStoreRef = cs;
    websocket = websocketInstance;
    audioControllerInitialized = true;
    console.log('AudioController: Initialized (server-primary playback).');
}

export default {
    init,
    previewCue,
    stopPreview,
    updateServerPlaybackState,
    toggle,
    stopAll,
    playlistNavigateNext,
    playlistNavigatePrevious,
    getPlaybackTimes,
    isPlaying,
    isPaused,
    setCrossfadeModeFromServer,
    isCrossfadeEnabled,
    onCrossfadeModeChange,
    setCrossfadeMode,
};
