// A dismissible banner across the top of the app, for problems the server
// reports that the operator must see (audio device gone, Spotify refusing
// to play, ...).

function showErrorBanner(message) {
    let banner = document.getElementById('errorBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'errorBanner';
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
            'background:#8c3c00', 'color:#fff', 'padding:10px 16px',
            'font-size:14px', 'display:flex', 'justify-content:space-between',
            'align-items:center', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)'
        ].join(';');
        const text = document.createElement('span');
        text.id = 'errorBannerText';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Dismiss';
        closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:16px;cursor:pointer;margin-left:12px;';
        closeBtn.addEventListener('click', () => banner.remove());
        banner.appendChild(text);
        banner.appendChild(closeBtn);
        document.body.appendChild(banner);
    }
    document.getElementById('errorBannerText').textContent = message;
}

export { showErrorBanner };
