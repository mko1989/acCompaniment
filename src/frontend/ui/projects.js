// Projects in the settings sidebar: the open project's name (saved as you
// type), and New / Load / Download Bundle / Import Bundle. Everything a
// project contains is saved automatically on the server; switching projects
// there is announced to every open page (renderer.js -> handleWorkspaceUpdated).

let currentProjectId = null;
let nameInput;
let statusEl;
let saveTimer = null;

const NAME_SAVE_DELAY_MS = 400;

function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
        throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
}

function showName(name) {
    // Never overwrite what the user is typing.
    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = name || '';
    }
}

async function saveName() {
    saveTimer = null;
    const name = nameInput.value.trim();
    if (!name) return; // restored on blur instead
    try {
        await requestJson('/api/projects/current', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    } catch (error) {
        setStatus(`Could not rename: ${error.message}`);
    }
}

function scheduleNameSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveName, NAME_SAVE_DELAY_MS);
}

async function flushNameSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        await saveName();
    }
}

async function refreshCurrent() {
    try {
        const { project } = await requestJson('/api/projects/current');
        currentProjectId = project.id;
        showName(project.name);
    } catch (error) {
        console.warn('Projects: could not load the current project:', error);
    }
}

/**
 * Called for every `workspace-updated` broadcast. Returns true if the open
 * project changed (the caller then reloads cues etc.); a rename of the same
 * project only updates the name here.
 */
function handleWorkspaceUpdated(workspace) {
    if (!workspace?.id) return false;
    const switched = currentProjectId !== null && workspace.id !== currentProjectId;
    currentProjectId = workspace.id;
    showName(workspace.name);
    return switched;
}

async function newProject() {
    await flushNameSave();
    setStatus('');
    try {
        await requestJson('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        // Ready to be named straight away.
        if (nameInput) {
            nameInput.value = 'Untitled Project';
            nameInput.focus();
            nameInput.select();
        }
    } catch (error) {
        setStatus(`Could not start a new project: ${error.message}`);
    }
}

function formatDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '';
}

async function renderProjectList() {
    const list = document.getElementById('projectList');
    list.innerHTML = '';
    let projects;
    try {
        ({ projects } = await requestJson('/api/projects'));
    } catch (error) {
        list.innerHTML = `<li class="project-empty">Could not load projects: ${error.message}</li>`;
        return;
    }
    for (const project of projects) {
        const li = document.createElement('li');
        li.dataset.projectId = project.id;
        li.classList.toggle('current', project.isCurrent);

        const info = document.createElement('div');
        info.className = 'project-info';
        const name = document.createElement('div');
        name.className = 'project-name';
        name.textContent = project.name;
        const meta = document.createElement('div');
        meta.className = 'project-meta';
        const cues = `${project.cueCount} cue${project.cueCount === 1 ? '' : 's'}`;
        meta.textContent = project.isCurrent ? `${cues} · open now` : `${cues} · changed ${formatDate(project.updatedAt)}`;
        info.append(name, meta);

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'project-open-btn';
        open.textContent = 'Open';
        open.disabled = project.isCurrent;
        open.addEventListener('click', async () => {
            try {
                await requestJson(`/api/projects/${project.id}/open`, { method: 'POST' });
                hideLoadDialog();
            } catch (error) {
                setStatus(`Could not open "${project.name}": ${error.message}`);
            }
        });

        li.append(info, open);
        if (!project.isCurrent) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'project-delete-btn';
            del.textContent = 'Delete';
            del.addEventListener('click', async () => {
                if (!confirm(`Delete the project "${project.name}"?\n\nIts audio files stay in the library.`)) return;
                try {
                    await requestJson(`/api/projects/${project.id}`, { method: 'DELETE' });
                    await renderProjectList();
                } catch (error) {
                    setStatus(`Could not delete "${project.name}": ${error.message}`);
                }
            });
            li.append(del);
        }
        list.append(li);
    }
}

function hideLoadDialog() {
    const modal = document.getElementById('loadProjectModal');
    if (modal) modal.style.display = 'none';
}

async function showLoadDialog() {
    await flushNameSave();
    const modal = document.getElementById('loadProjectModal');
    await renderProjectList();
    modal.style.display = 'flex';
}

async function downloadBundle() {
    await flushNameSave();
    // The server answers with Content-Disposition: attachment, so this
    // downloads the .zip without leaving the page.
    const link = document.createElement('a');
    link.href = '/api/projects/current/bundle';
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
}

async function importBundle(file) {
    const button = document.getElementById('importBundleButton');
    setStatus(`Importing ${file.name}...`);
    if (button) button.disabled = true;
    try {
        const form = new FormData();
        form.append('bundle', file);
        const result = await requestJson('/api/projects/import', { method: 'POST', body: form });
        const { added, reused, failed } = result.audio;
        const parts = [`${added} audio file${added === 1 ? '' : 's'} added`];
        if (reused) parts.push(`${reused} already here`);
        if (failed.length) parts.push(`${failed.length} could not be added`);
        if (result.missingAudio?.length) parts.push(`${result.missingAudio.length} missing from the bundle`);
        setStatus(`Imported "${result.project.name}" (${parts.join(', ')}).`);
    } catch (error) {
        setStatus(`Import failed: ${error.message}`);
    } finally {
        if (button) button.disabled = false;
    }
}

function init() {
    nameInput = document.getElementById('projectNameInput');
    statusEl = document.getElementById('projectStatus');

    if (nameInput) {
        nameInput.addEventListener('input', scheduleNameSave);
        nameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') nameInput.blur();
        });
        nameInput.addEventListener('blur', async () => {
            await flushNameSave();
            if (!nameInput.value.trim()) await refreshCurrent(); // put the saved name back
        });
    }
    document.getElementById('newProjectButton')?.addEventListener('click', newProject);
    document.getElementById('loadProjectButton')?.addEventListener('click', showLoadDialog);
    document.getElementById('downloadBundleButton')?.addEventListener('click', downloadBundle);

    const importInput = document.getElementById('importBundleInput');
    document.getElementById('importBundleButton')?.addEventListener('click', () => {
        importInput.value = '';
        importInput.click();
    });
    importInput?.addEventListener('change', () => {
        const file = importInput.files && importInput.files[0];
        if (file) importBundle(file);
    });

    const modal = document.getElementById('loadProjectModal');
    document.getElementById('closeLoadProjectModal')?.addEventListener('click', hideLoadDialog);
    modal?.addEventListener('click', (event) => {
        if (event.target === modal) hideLoadDialog();
    });

    return refreshCurrent();
}

export { init, handleWorkspaceUpdated, refreshCurrent };
