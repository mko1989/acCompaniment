// The Spotify section of the config sidebar: the user's Spotify app client
// ID, connecting the account, and which Spotify player cues play on. The
// login itself happens server-side (src/backend/routes/spotify.js); this
// page only opens it and shows what the server reports.

let status = null;
let elements = {};

function isLoopbackPage() {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
}

async function request(method, path, body) {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!result.success) {
        throw new Error(result.error || `Request failed (HTTP ${response.status})`);
    }
    return result;
}

function setMessage(text) {
    if (elements.status) elements.status.textContent = text;
}

function render() {
    if (!status || !elements.status) return;
    if (elements.clientId && document.activeElement !== elements.clientId) {
        elements.clientId.value = status.clientId || '';
    }
    if (elements.redirectUri) elements.redirectUri.textContent = status.redirectUri || '';

    if (status.connected) {
        const who = status.user?.displayName ? ` as ${status.user.displayName}` : '';
        const premium = status.user?.product && status.user.product !== 'premium'
            ? ' - this account isn\'t Premium, which Spotify requires for playing from here.'
            : '';
        setMessage(`Connected${who}.${premium}`);
    } else if (!status.clientId) {
        setMessage('Not connected. Enter your Spotify app\'s client ID to connect.');
    } else if (!isLoopbackPage()) {
        setMessage(`Not connected. Connect from the computer running acCompaniment (${status.redirectUri.replace(/\/api\/.*$/, '')}) - Spotify only returns the login there.`);
    } else {
        setMessage('Not connected.');
    }

    if (elements.connect) {
        elements.connect.style.display = status.connected ? 'none' : '';
        elements.connect.disabled = !status.clientId;
    }
    if (elements.disconnect) elements.disconnect.style.display = status.connected ? '' : 'none';
    if (elements.deviceGroup) elements.deviceGroup.style.display = status.connected ? '' : 'none';
}

function renderDevices(devices) {
    const select = elements.device;
    if (!select) return;
    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Whichever Spotify player is active';
    select.appendChild(auto);

    const list = [...devices];
    // Keep the chosen player selectable while it's offline.
    if (status?.deviceId && !list.some((d) => d.id === status.deviceId)) {
        list.push({ id: status.deviceId, name: `${status.deviceName || 'Chosen player'} (not available)` });
    }
    for (const device of list) {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.isActive ? `${device.name} (active)` : device.name;
        option.dataset.name = device.name;
        select.appendChild(option);
    }
    select.value = status?.deviceId || '';
}

async function loadDevices() {
    if (!status?.connected) return;
    try {
        const { devices } = await request('GET', '/api/spotify/devices');
        renderDevices(devices);
    } catch (error) {
        renderDevices([]);
        setMessage(`Connected, but the players couldn't be listed: ${error.message}`);
    }
}

async function saveSettings(updates) {
    try {
        const result = await request('PUT', '/api/spotify/settings', updates);
        applyStatus(result.status);
    } catch (error) {
        setMessage(error.message);
    }
}

/** The server's Spotify status (on load, and from 'spotify-status' broadcasts). */
function applyStatus(next) {
    const wasConnected = status?.connected;
    status = next;
    render();
    if (status?.connected && !wasConnected) {
        loadDevices();
    }
}

function isConnected() {
    return Boolean(status?.connected);
}

async function init() {
    elements = {
        clientId: document.getElementById('spotifyClientId'),
        redirectUri: document.getElementById('spotifyRedirectUri'),
        copyRedirect: document.getElementById('spotifyRedirectCopy'),
        status: document.getElementById('spotifyConnectionStatus'),
        connect: document.getElementById('spotifyConnectButton'),
        disconnect: document.getElementById('spotifyDisconnectButton'),
        deviceGroup: document.getElementById('spotifyDeviceGroup'),
        device: document.getElementById('spotifyDevice'),
        refreshDevices: document.getElementById('spotifyRefreshDevices'),
    };
    if (!elements.status) return;

    elements.clientId?.addEventListener('change', () => saveSettings({ clientId: elements.clientId.value }));
    elements.copyRedirect?.addEventListener('click', () => {
        if (status?.redirectUri) window.copyToClipboard?.(status.redirectUri, elements.copyRedirect);
    });
    elements.connect?.addEventListener('click', () => {
        // A tab of its own: Spotify's consent page, then back to the server.
        window.open('/api/spotify/login', '_blank', 'noopener');
        setMessage('Finish connecting in the Spotify tab that opened.');
    });
    elements.disconnect?.addEventListener('click', async () => {
        try {
            applyStatus((await request('POST', '/api/spotify/logout')).status);
        } catch (error) {
            setMessage(error.message);
        }
    });
    elements.device?.addEventListener('change', () => {
        const option = elements.device.selectedOptions[0];
        saveSettings({ deviceId: elements.device.value || null, deviceName: option?.dataset.name || null });
    });
    elements.refreshDevices?.addEventListener('click', loadDevices);

    try {
        applyStatus((await request('GET', '/api/spotify/status')).status);
    } catch (error) {
        setMessage(`Spotify settings unavailable: ${error.message}`);
    }
}

export { init, applyStatus, isConnected };
