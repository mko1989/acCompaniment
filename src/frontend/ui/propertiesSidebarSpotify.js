/**
 * The Spotify part of the properties sidebar: which track or playlist a
 * Spotify cue plays. Like a single-file cue's file, it's saved when it
 * changes (a pasted or dropped link), not with the form's other fields.
 */

import { describe, cueFieldsFor } from '../spotifyCues.js';

const CONTEXT_TYPES = ['playlist', 'album', 'artist', 'show'];

let cueStore;
let getActiveCueId;
let saveCueProperties;
let els = {};

function initSpotifyFields(csModule, getActiveCueIdFn, saveFn) {
    cueStore = csModule;
    getActiveCueId = getActiveCueIdFn;
    saveCueProperties = saveFn;
    els = {
        config: document.getElementById('propSpotifyConfig'),
        link: document.getElementById('propSpotifyLink'),
        info: document.getElementById('propSpotifyInfo'),
        shuffleGroup: document.getElementById('propSpotifyShuffleGroup'),
        shuffle: document.getElementById('propSpotifyShuffle'),
        name: document.getElementById('propCueName'),
        preview: document.getElementById('previewCueButton'),
        replaceFile: document.getElementById('replaceCueFileButton'),
    };
    els.link?.addEventListener('change', () => { void applySpotifyLink(els.link.value); });
    els.shuffle?.addEventListener('change', () => saveCueProperties());
}

function isContextType(type) {
    return CONTEXT_TYPES.includes(type);
}

function formatDuration(seconds) {
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function describeCue(cue) {
    if (!cue?.spotifyUri) return 'No track or playlist yet - paste or drop a Spotify link.';
    const parts = [cue.spotifyName || cue.spotifyUri];
    if (cue.spotifySubtitle) parts.push(cue.spotifySubtitle);
    if (!isContextType(cue.spotifyType) && cue.knownDuration > 0) parts.push(formatDuration(cue.knownDuration));
    if (cue.spotifyTrackCount) parts.push(`${cue.spotifyTrackCount} tracks`);
    return parts.join(' · ');
}

/** Shows the Spotify fields for a Spotify cue (and hides what doesn't apply to one). */
function setSpotifyFieldsVisible(isSpotify) {
    if (els.config) els.config.style.display = isSpotify ? 'block' : 'none';
    // The local preview plays the cue's audio file; a Spotify cue has none
    // (and nothing to replace).
    if (els.preview) els.preview.style.display = isSpotify ? 'none' : '';
    if (els.replaceFile && isSpotify) els.replaceFile.style.display = 'none';
}

function populateSpotifyFields(cue) {
    if (els.link) els.link.value = cue?.spotifyUri || '';
    if (els.info) els.info.textContent = describeCue(cue);
    if (els.shuffleGroup) els.shuffleGroup.style.display = isContextType(cue?.spotifyType) ? 'block' : 'none';
    if (els.shuffle) els.shuffle.checked = Boolean(cue?.shufflePlaylist);
}

/** The form fields saved with the rest of the cue's properties. */
function readSpotifyFields() {
    return { shufflePlaylist: Boolean(els.shuffle?.checked) };
}

/** Points the open cue at a Spotify link. Resolves false if it isn't one. */
async function applySpotifyLink(link) {
    const cue = cueStore?.getCueById(getActiveCueId());
    if (!cue) return false;
    const text = String(link || '').trim();
    if (!text) {
        populateSpotifyFields(cue);
        return false;
    }
    if (els.info) els.info.textContent = 'Looking it up...';
    const { item, error } = await describe(text);
    if (error && /not a spotify link/i.test(error)) {
        if (els.info) els.info.textContent = error;
        return false;
    }

    const updates = { id: cue.id, type: 'spotify', ...cueFieldsFor(text, item) };
    // Named after its track - unless the operator named it themselves.
    const autoNamed = !cue.name || cue.name === 'New Cue' || cue.name === cue.spotifyName || /^Spotify( [a-z]+)?$/.test(cue.name);
    if (item?.name && autoNamed) {
        updates.name = item.name;
        if (els.name) els.name.value = item.name;
    }
    const result = await cueStore.addOrUpdateCue(updates);
    if (!result?.success) {
        if (els.info) els.info.textContent = `Could not save: ${result?.error || 'unknown error'}`;
        return false;
    }
    populateSpotifyFields(result.cue || { ...cue, ...updates, spotifyType: item?.type });
    if (error && els.info) {
        els.info.textContent = `Saved, but it couldn't be looked up: ${error}`;
    }
    return true;
}

export {
    initSpotifyFields,
    setSpotifyFieldsVisible,
    populateSpotifyFields,
    readSpotifyFields,
    applySpotifyLink,
};
