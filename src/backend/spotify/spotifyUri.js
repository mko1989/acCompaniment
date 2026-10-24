/**
 * Spotify links: what a user pastes or drags in (a share link from the
 * Spotify app, an open.spotify.com URL, or a spotify: URI) turned into the
 * canonical `spotify:<type>:<id>` URI the Web API plays.
 */

// Types that play as a single item (`uris: [...]`) vs. as a context that
// Spotify steps through itself (`context_uri`).
const ITEM_TYPES = ['track', 'episode'];
const CONTEXT_TYPES = ['playlist', 'album', 'artist', 'show'];
const TYPES = [...ITEM_TYPES, ...CONTEXT_TYPES];

const ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;

/**
 * @param {string} text
 * @returns {{ type: string, id: string, uri: string, isContext: boolean } | null}
 */
function parseSpotifyLink(text) {
    const input = String(text || '').trim();
    if (!input) return null;

    let type;
    let id;
    if (/^spotify:/i.test(input)) {
        // spotify:track:ID, and the older spotify:user:NAME:playlist:ID
        const parts = input.split(':');
        const typeIndex = parts.findIndex((part, i) => i > 0 && TYPES.includes(part.toLowerCase()));
        if (typeIndex === -1) return null;
        type = parts[typeIndex].toLowerCase();
        id = parts[typeIndex + 1];
    } else {
        let url;
        try {
            url = new URL(input);
        } catch {
            return null;
        }
        if (!/(^|\.)open\.spotify\.com$/i.test(url.hostname) && !/^play\.spotify\.com$/i.test(url.hostname)) {
            return null;
        }
        // /track/ID, /intl-de/track/ID, /user/NAME/playlist/ID, /embed/track/ID
        const segments = url.pathname.split('/').filter(Boolean);
        const typeIndex = segments.findIndex((segment) => TYPES.includes(segment.toLowerCase()));
        if (typeIndex === -1) return null;
        type = segments[typeIndex].toLowerCase();
        id = segments[typeIndex + 1];
    }

    if (!id || !ID_PATTERN.test(id)) return null;
    return { type, id, uri: `spotify:${type}:${id}`, isContext: CONTEXT_TYPES.includes(type) };
}

function isContextUri(uri) {
    const parsed = parseSpotifyLink(uri);
    return Boolean(parsed?.isContext);
}

module.exports = { parseSpotifyLink, isContextUri, ITEM_TYPES, CONTEXT_TYPES };
