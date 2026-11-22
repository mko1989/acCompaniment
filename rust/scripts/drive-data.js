#!/usr/bin/env node
/**
 * Drives the ORIGINAL Node data layer (B1 of rust/DECISIONS.md ADR-015) through an op script,
 * printing each op's result and the data dir after it. `drive-data` (rust/app) is the same for
 * the Rust core; rust/scripts/diff-data.js runs both and compares.
 *
 * Usage: node rust/scripts/drive-data.js <dataDir> <ops.json> <outDir> <fixturesDir>
 * Ops: [{ "op": "<name>", "args": [...] }]; see OPS below.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Saved before cm.init replaces the timer functions with the fake clock (B3).
const realSetTimeout = setTimeout;
const { installClock, makeSettle, makeRng, makeFakeWs, makeFakeEngine } = require('./cue-engine-fakes');

const REPO = path.join(__dirname, '..', '..');
const B = path.join(REPO, 'src', 'backend');
const PathManager = require(path.join(B, 'pathManager'));
const AppConfigManager = require(path.join(B, 'appConfigManager'));
const AudioFileManager = require(path.join(B, 'audioFileManager'));
const CueDataManager = require(path.join(B, 'cueDataManager'));
const mediaLibrary = require(path.join(B, 'mediaLibrary'));
const { writeBundle, readBundle } = require(path.join(B, 'projectBundle'));

const [dataDir, opsFile, outDir, fixturesDir] = process.argv.slice(2);
const ops = JSON.parse(fs.readFileSync(opsFile, 'utf8'));
// Keep the managers quiet: only results go to stdout.
for (const k of ['log', 'warn', 'error']) console[k] = () => {};

let pm, config, afm, cdm;
// B3: the original cue manager, run against fakes (cue-engine-fakes.js).
let cm, engine, ws, clock, rng, settle;
let seenEngine = 0;
let seenWs = 0;
let uploadN = 0;

function dump() {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'dump-data.js'), dataDir], { encoding: 'utf8' });
    return r.stdout;
}

/** Copies a fixture to temp/uploads under a predictable name, as multer would store it. */
function stage(from, name) {
    uploadN += 1;
    const dir = path.join(dataDir, 'temp', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `upload-${uploadN}${path.extname(name || from).toLowerCase()}`);
    fs.copyFileSync(path.join(fixturesDir, from), target);
    return target;
}

const OPS = {
    init: async () => {
        pm = new PathManager(dataDir);
        await pm.ensureDirectories();
        config = new AppConfigManager(pm);
        await config.loadConfig();
        afm = new AudioFileManager(pm);
        cdm = new CueDataManager(pm);
        await cdm.ensureDirectories();
        return config.getConfig();
    },
    'paths.validateFile': (p) => pm.validateFile(p),
    'paths.getAudioFiles': () => pm.getAudioFiles(),
    'paths.getFileInfo': (p) => pm.getFileInfo(p),
    'config.get': () => config.getConfig(),
    'config.load': () => config.loadConfig(),
    'config.update': (u) => config.updateConfig(u),
    'config.reset': () => config.resetToDefaults(),
    'config.addRecent': (p) => config.addRecentWorkspace(p),
    'config.removeRecent': (p) => config.removeRecentWorkspace(p),
    'config.validate': (c) => config.validateConfig(c),
    'config.listeningPort': () => config.getListeningPort(),
    'library.migrate': () => mediaLibrary.migrateLibrary({
        audioDir: pm.audioDir,
        metadataDir: path.join(pm.audioDir, 'metadata'),
        workspacesDir: path.join(pm.cuesDir, 'workspaces'),
        backupsDir: path.join(pm.cuesDir, 'backups'),
        pcmCacheDir: pm.pcmCacheDir,
        log: { log() {} },
    }),
    'library.hashFile': (p) => mediaLibrary.hashFile(path.join(dataDir, p)),
    'library.findExistingName': (n) => mediaLibrary.findExistingName(pm.audioDir, n),
    'cues.create': (d) => cdm.createCue(d),
    'cues.add': (d) => cdm.addCue(cdm.createCue(d)),
    'cues.update': (id, u) => cdm.updateCue(id, u),
    'cues.delete': (id) => cdm.deleteCue(id),
    'cues.reorder': (ids) => cdm.reorderCues(ids),
    'cues.get': (id) => cdm.getCue(id) ?? null,
    'cues.getAll': () => cdm.getCues(),
    'cues.current': () => cdm.getCurrentWorkspace(),
    'cues.createWorkspace': (name, desc, options) => cdm.createWorkspace(name, desc, options),
    'cues.save': (name, desc) => cdm.saveWorkspace(name, desc),
    'cues.read': (id) => cdm.readWorkspace(id),
    'cues.updateById': (id, u) => cdm.updateWorkspaceById(id, u),
    'cues.load': (id) => cdm.loadWorkspace(id),
    'cues.list': (includeCues) => cdm.getAllWorkspaces({ includeCues }),
    'cues.deleteWorkspace': (id) => cdm.deleteWorkspace(id),
    'cues.export': (id, file, include) => cdm.exportWorkspace(id, path.join(pm.cuesDir, file), include, afm),
    'cues.import': (p) => cdm.importWorkspace(p),
    'cues.cleanupOrphans': () => cdm.cleanupOrphanWorkspaceFiles(),
    'cues.rewriteRefs': (byId) => cdm.rewriteAudioReferences((ref) => byId[ref.audioFileId] || null),
    'audio.upload': (from, name, options) => afm.addFile(stage(from, name), name, options || {}),
    'audio.import': (p, options) => afm.importAudioFile(p, options || {}),
    'audio.replace': (id, from, name) => afm.replaceFile(id, stage(from, name), name),
    'audio.validate': (p) => afm.validateAudioFile(p),
    'audio.getAll': () => afm.getAllAudioFiles(),
    'audio.byPath': (p) => afm.getAudioFileByPath(p),
    'audio.load': (id) => afm.loadAudioFileMetadata(id),
    'audio.delete': (id) => afm.deleteAudioFile(id),
    'audio.update': (id, u) => afm.updateAudioFileMetadata(id, u),
    'audio.search': (q) => afm.searchAudioFiles(q),
    'audio.stats': () => afm.getAudioFileStats(),
    'audio.invalidateIndex': () => afm.invalidateMetadataIndex(),
    'bundle.write': async (id, out) => {
        const wid = id === 'current' ? cdm.getCurrentWorkspace()?.id : id;
        const read = await cdm.readWorkspace(wid);
        if (!read.success) return read;
        const stream = fs.createWriteStream(path.join(outDir, out));
        return writeBundle(cdm.withHiddenCues(read.workspace), stream, async (ref) =>
            (ref.audioFileId && await afm.loadAudioFileMetadata(ref.audioFileId))
            || (ref.relativePath && await afm.getAudioFileByPath(ref.relativePath))
            || null);
    },
    'bundle.read': (zip, dir) => readBundle(path.join(outDir, zip), path.join(dataDir, 'temp', 'imports', dir)),
    probe: async (p, duration) => {
        const { parseFile } = require('music-metadata');
        const m = await parseFile(path.join(fixturesDir, p), { duration: Boolean(duration) });
        const f = m.format;
        return { duration: f.duration, bitrate: f.bitrate, sampleRate: f.sampleRate, numberOfChannels: f.numberOfChannels, title: m.common.title, artist: m.common.artist, album: m.common.album };
    },
    // --- B3: the cue engine (cueManager.js) ----------------------------------------------------
    'cm.init': async (rngValues) => {
        clock = installClock();
        engine = makeFakeEngine();
        ws = makeFakeWs();
        rng = makeRng(rngValues || [0.42, 0.13, 0.87, 0.55, 0.07, 0.99, 0.31, 0.66, 0.2, 0.75]);
        settle = makeSettle(() => `${engine.log.length}/${ws.log.length}`);
        const CueManager = require(path.join(B, 'cueManager'));
        cm = new CueManager(afm, cdm, ws);
        cm.audioPlaybackManager = engine;
        cm._rng = rng;
        cm.setConfig(config.getConfig());
        await cm.initialize();
    },
    'cm.rng': (values) => { rng.reset(values); return true; },
    'cm.trigger': (id, options) => cm.triggerCue(id, options || {}),
    'cm.toggle': (id, options) => cm.toggleCue(id, options || {}),
    'cm.play': (id, options) => cm.playCue(id, options || {}),
    'cm.doublePress': async (id, options) => Promise.all([cm.triggerCue(id, options || {}), cm.triggerCue(id, options || {})]),
    'cm.stop': (id, fadeOut) => cm.stopCue(id, fadeOut),
    'cm.stopAll': (behavior) => cm.stopAllCues(behavior),
    'cm.togglePause': (id) => cm.togglePauseCue(id),
    'cm.navigate': (id, direction) => cm.navigatePlaylist(id, direction),
    'cm.jump': (id, index) => cm.jumpToPlaylistItem(id, index),
    'cm.create': (data) => cm.createCue(data),
    'cm.update': (id, updates) => cm.updateCue(id, updates),
    'cm.delete': (id) => cm.deleteCue(id),
    'cm.reorder': (order) => cm.reorderCues(order),
    'cm.crossfade': (enabled) => cm.setCrossfadeMode(enabled),
    'cm.masterVolume': (v) => cm.setMasterVolume(v),
    'cm.applyConfig': async (updates) => {
        const prev = cm.getConfig();
        const r = await config.updateConfig(updates);
        if (!r.success) return r;
        return cm.applyConfig(prev, config.getConfig());
    },
    'cm.newProject': (name) => cm.newProject(name),
    'cm.openProject': (id) => cm.openProject(id),
    'cm.renameProject': (name) => cm.renameProject(name),
    'cm.deleteProject': (id) => cm.deleteProject(id),
    'cm.listProjects': () => cm.listProjects(),
    'cm.currentProject': () => cm.getCurrentProject(),
    'cm.getCues': () => cm.getCues(),
    'cm.getCue': (id) => cm.getCue(id) ?? null,
    'cm.status': () => cm.getPlaybackStatus(),
    'cm.flush': () => cm.flushPersistWorkspace(),
    'cm.cleanup': () => cm.cleanup(),
    'cm.audioReplace': async (id, from, name) => {
        const r = await afm.replaceFile(id, stage(from, name), name);
        if (!r.success) return r;
        return cm.handleAudioFileReplaced(r.audioFile, r.previous);
    },
    'cm.importProject': (project, files) => cm.importProject({
        project,
        audio: (files || []).map(([from, name]) => ({ path: stage(from, name), name })),
    }),
    'engine.script': (method, result) => { engine.script.push({ method, result }); return true; },
    'engine.end': (id, reason) => { engine.end(id, reason); },
    'engine.advance': (id, token) => { engine.advance(id, token); },
    'engine.error': (payload) => { engine.error(payload); },
    'clock.advance': (ms) => clock.advance(ms, settle),
    'fs.zipOut': (p, entries) => spawnSync(process.execPath, [path.join(__dirname, 'make-zip.js'), path.join(outDir, p), JSON.stringify(entries)]).status === 0,
    'fs.writeOut': (p, text) => { fs.writeFileSync(path.join(outDir, p), text); return true; },
    'fs.write': (p, text) => { fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true }); fs.writeFileSync(path.join(dataDir, p), text); return true; },
};

/** What the cue manager did and holds after an op (B3): engine calls, broadcasts, live state. */
function cueEngineState() {
    const lines = ['--- engine'];
    for (const e of engine.log.slice(seenEngine)) lines.push(JSON.stringify(e));
    seenEngine = engine.log.length;
    lines.push('--- ws');
    for (const e of ws.log.slice(seenWs)) lines.push(JSON.stringify(e));
    seenWs = ws.log.length;
    lines.push('--- state');
    lines.push(JSON.stringify({
        status: cm.getPlaybackStatus(),
        playingCues: Object.fromEntries(cm.playingCues),
        shuffleOrders: Object.fromEntries(cm.shuffleOrders),
        queuedNext: Object.fromEntries(cm._queuedNext),
        queueToken: cm._queueToken,
        duckState: Object.fromEntries(cm._duckState),
        crossfadeMode: cm.crossfadeMode,
        config: cm.config,
        timers: clock.pending(),
        now: clock.now,
    }));
    return `${lines.join('\n')}\n`;
}

(async () => {
    for (const [i, { op, args = [] }] of ops.entries()) {
        let result;
        try {
            if (!OPS[op]) throw new Error(`unknown op ${op}`);
            result = await OPS[op](...args);
        } catch (error) {
            result = { $error: error.message };
        }
        if (settle) await settle();
        const text = result === undefined ? 'undefined' : JSON.stringify(result);
        process.stdout.write(`### ${i} ${op}\n${text}\n${cm ? cueEngineState() : ''}${dump()}`);
        // Distinct timestamps per op, on both sides, so backups never share a name.
        await new Promise((r) => realSetTimeout(r, 3));
    }
})();
