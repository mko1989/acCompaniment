const express = require('express');
const router = express.Router();

// Spotify account connection and lookups (see src/backend/spotify/).

function sendError(res, error, status = 400) {
    res.status(error.status === 401 ? 401 : status).json({ success: false, error: error.message });
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// What the browser tab Spotify sends back to shows once the login is done.
function callbackPage(title, message) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1e1e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.4rem}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

router.get('/status', (req, res) => {
    const { spotifyClient } = req.app.locals.managers;
    res.json({ success: true, status: spotifyClient.getStatus() });
});

// { clientId?, deviceId?, deviceName? }
router.put('/settings', async (req, res) => {
    try {
        const { spotifyClient } = req.app.locals.managers;
        const status = await spotifyClient.updateSettings(req.body || {});
        res.json({ success: true, status });
    } catch (error) {
        sendError(res, error);
    }
});

// Opened in the browser: on to Spotify's consent page.
router.get('/login', (req, res) => {
    try {
        const { spotifyClient } = req.app.locals.managers;
        res.redirect(spotifyClient.beginLogin());
    } catch (error) {
        res.status(400).send(callbackPage('Spotify not connected', error.message));
    }
});

// Spotify's redirect back after the consent page.
router.get('/callback', async (req, res) => {
    const { spotifyClient } = req.app.locals.managers;
    try {
        const status = await spotifyClient.completeLogin({
            code: req.query.code,
            state: req.query.state,
            error: req.query.error,
        });
        const who = status.user?.displayName ? ` as ${status.user.displayName}` : '';
        const premiumNote = status.user?.product && status.user.product !== 'premium'
            ? ' Note: playing from acCompaniment needs Spotify Premium.'
            : '';
        res.send(callbackPage('Spotify connected', `acCompaniment is connected to Spotify${who}. You can close this tab.${premiumNote}`));
    } catch (error) {
        res.status(400).send(callbackPage('Spotify not connected', error.message));
    }
});

router.post('/logout', async (req, res) => {
    try {
        const { spotifyClient } = req.app.locals.managers;
        res.json({ success: true, status: await spotifyClient.logout() });
    } catch (error) {
        sendError(res, error, 500);
    }
});

router.get('/devices', async (req, res) => {
    try {
        const { spotifyClient } = req.app.locals.managers;
        res.json({ success: true, devices: await spotifyClient.getDevices() });
    } catch (error) {
        sendError(res, error, 502);
    }
});

// ?link=<Spotify link or URI>: what it is, for naming a cue after it.
router.get('/resolve', async (req, res) => {
    try {
        const { spotifyClient } = req.app.locals.managers;
        res.json({ success: true, item: await spotifyClient.describe(req.query.link) });
    } catch (error) {
        sendError(res, error);
    }
});

module.exports = router;
