const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseSpotifyLink, isContextUri } = require('../../src/backend/spotify/spotifyUri');

const ID = '4uLU6hMCjMI75M1A2tKUQC';

test('share links, localized links and URIs all give the same URI', () => {
    for (const link of [
        `https://open.spotify.com/track/${ID}`,
        `https://open.spotify.com/track/${ID}?si=0a1b2c3d4e`,
        `https://open.spotify.com/intl-pl/track/${ID}`,
        `https://open.spotify.com/embed/track/${ID}`,
        `  spotify:track:${ID}  `,
    ]) {
        assert.deepEqual(parseSpotifyLink(link), { type: 'track', id: ID, uri: `spotify:track:${ID}`, isContext: false }, link);
    }
});

test('playlists, albums, artists and shows play as contexts', () => {
    assert.equal(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}`).isContext, true);
    assert.equal(parseSpotifyLink(`https://open.spotify.com/user/someone/playlist/${ID}`).uri, `spotify:playlist:${ID}`);
    assert.equal(parseSpotifyLink(`spotify:user:someone:playlist:${ID}`).uri, `spotify:playlist:${ID}`);
    assert.equal(isContextUri(`spotify:album:${ID}`), true);
    assert.equal(isContextUri(`spotify:artist:${ID}`), true);
    assert.equal(isContextUri(`spotify:show:${ID}`), true);
    assert.equal(isContextUri(`spotify:episode:${ID}`), false);
});

test('anything else is not a Spotify link', () => {
    for (const text of [
        '',
        null,
        'hello',
        `https://example.com/track/${ID}`,
        `https://open.spotify.com/track/`,
        `https://open.spotify.com/track/bad!id`,
        'spotify:track:',
        `spotify:label:${ID}`,
    ]) {
        assert.equal(parseSpotifyLink(text), null, String(text));
    }
});
