// Spotify links dropped or pasted into the app become Spotify cues (they
// play through Spotify Connect - see src/backend/spotify/). What a link
// points at is looked up on the server, to name the cue after it.

import { showErrorBanner } from './ui/errorBanner.js';

const LINK_PATTERN = /(https?:\/\/(?:open|play)\.spotify\.com\/\S+|spotify:[A-Za-z]+(?::[A-Za-z0-9._-]+)+)/g;
const MAX_LINKS = 50;

/** Every Spotify link in a piece of text (a drop's uri-list, a paste). */
function findSpotifyLinks(text) {
    const links = String(text || '').match(LINK_PATTERN) || [];
    return Array.from(new Set(links)).slice(0, MAX_LINKS);
}

/** The text a drag or paste carries, if it has any Spotify links. */
function spotifyLinksFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];
    const text = [dataTransfer.getData('text/uri-list'), dataTransfer.getData('text/plain')].join('\n');
    return findSpotifyLinks(text);
}

async function describe(link) {
    try {
        const response = await fetch(`/api/spotify/resolve?link=${encodeURIComponent(link)}`);
        const result = await response.json();
        return result.success ? { item: result.item } : { error: result.error };
    } catch (error) {
        return { error: error.message };
    }
}

/** The cue fields that come from what the link points at. */
function cueFieldsFor(link, item) {
    return {
        spotifyUri: item?.uri || link,
        spotifyName: item?.name || null,
        spotifySubtitle: item?.subtitle || null,
        spotifyTrackCount: item?.trackCount ?? null,
        knownDuration: item?.durationSec || 0,
    };
}

function defaultName(link) {
    const type = (link.match(/(track|episode|playlist|album|artist|show)/) || [])[1];
    return type ? `Spotify ${type}` : 'Spotify';
}

/**
 * Creates one Spotify cue per link. A link that can't be looked up (Spotify
 * not connected yet) still becomes a cue - it just isn't named after its
 * track until then.
 */
async function createSpotifyCues(links, cueStore, appConfig = {}) {
    let lookupError = null;
    for (const link of links) {
        const { item, error } = await describe(link);
        if (error && /not a spotify link/i.test(error)) continue;
        if (error && !lookupError) lookupError = error;
        await cueStore.addOrUpdateCue({
            name: item?.name || defaultName(link),
            type: 'spotify',
            ...cueFieldsFor(link, item),
            volume: appConfig.defaultVolume || 1.0,
            fadeInTime: appConfig.defaultFadeInTime || 0,
            fadeOutTime: appConfig.defaultFadeOutTime || 0,
            loop: appConfig.defaultLoopSingleCue || false,
            retriggerBehavior: appConfig.defaultRetriggerBehavior || 'restart',
        });
    }
    if (lookupError) {
        showErrorBanner(`Spotify cue added, but its track couldn't be looked up: ${lookupError}`);
    }
}

export { findSpotifyLinks, spotifyLinksFromDataTransfer, createSpotifyCues, describe, cueFieldsFor };
