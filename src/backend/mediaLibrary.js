/**
 * The media library: one file per unique piece of audio, stored flat in the
 * audio directory under its own filename. The filename is its identity -
 * the same file is shared by every cue and project that uses it.
 *
 * This module holds the naming rules, content hashing, reference rewriting
 * helpers and the one-time migration of libraries created before this
 * (every upload used to be stored again as `name_<timestamp>.ext`, often in
 * two folders).
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { writeJsonAtomic } = require('./utils/atomicWrite');

const LIBRARY_VERSION = 2;
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];

/** sha256 of a file's bytes, streamed. */
function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * A safe library filename from whatever a browser or bundle supplied: no
 * directories, no control or path characters, not hidden, not empty.
 */
function sanitizeFilename(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    let clean = base
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[/:*?"<>|]/g, '_')
        .trim();
    if (/^\.[^.]+$/.test(clean)) {
        clean = `audio${clean}`; // just an extension, e.g. ".mp3"
    }
    clean = clean.replace(/^\.+/, '');
    if (!clean || clean === path.extname(clean)) {
        clean = `audio${path.extname(clean) || ''}`;
    }
    return clean.slice(0, 200);
}

/** "Song.mp3" -> "Song (2).mp3" */
function withCopyNumber(name, n) {
    if (n <= 1) return name;
    const ext = path.extname(name);
    return `${path.basename(name, ext)} (${n})${ext}`;
}

/** Strips the `_<13-digit timestamp>` old uploads added: "Song_1761152917380.mp3" -> "Song.mp3". */
function cleanLegacyName(name) {
    const ext = path.extname(name);
    const base = path.basename(name, ext).replace(/_\d{13}$/, '');
    return `${base}${ext}`;
}

/**
 * The on-disk name in `dir` matching `name` regardless of case (macOS
 * filesystems treat "Song.mp3" and "song.mp3" as the same file), or null.
 */
async function findExistingName(dir, name) {
    const entries = await fs.readdir(dir).catch(() => []);
    const wanted = name.toLowerCase();
    return entries.find((entry) => entry.toLowerCase() === wanted) || null;
}

function isSupportedAudio(name) {
    return SUPPORTED_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

/**
 * Applies `mapRef(ref)` to every audio reference in a list of cues - each
 * single-file cue and each playlist item. `mapRef` gets
 * { audioFileId, relativePath } and returns the fields to change (or null
 * to leave it). Returns how many references changed.
 */
function rewriteCueReferences(cues, mapRef) {
    let changed = 0;
    const apply = (ref) => {
        const update = mapRef({ audioFileId: ref.audioFileId, relativePath: ref.relativePath });
        if (!update) return;
        Object.assign(ref, update);
        // Browser URLs are derived from the id when cues are sent out;
        // a stored one would point at the old file.
        delete ref.filePath;
        changed += 1;
    };
    for (const cue of cues || []) {
        if (cue.type === 'playlist') {
            for (const item of cue.playlistItems || []) apply(item);
        } else if (cue.audioFileId || cue.relativePath) {
            apply(cue);
        }
    }
    return changed;
}

async function readJsonFiles(dir) {
    const out = [];
    for (const file of await fs.readdir(dir).catch(() => [])) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(dir, file);
        try {
            out.push({ file: full, data: JSON.parse(await fs.readFile(full, 'utf-8')) });
        } catch {
            // unreadable - left alone
        }
    }
    return out;
}

async function removeEmptyDirs(dir, keep) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || keep.includes(entry.name)) continue;
        const sub = path.join(dir, entry.name);
        await removeEmptyDirs(sub, []);
        const remaining = (await fs.readdir(sub)).filter((f) => f !== '.DS_Store');
        if (remaining.length === 0) {
            await fs.remove(sub);
        }
    }
}

/**
 * One-time migration of a pre-library audio directory:
 *   - one copy kept per unique content (by sha256), under its clean name
 *     (timestamp suffix removed; " (2)" etc. if two different files would
 *     share a name); byte-identical copies deleted
 *   - one metadata record per file; every project's cue references (id and
 *     path) rewritten to it
 *   - project files and metadata backed up first, with a mapping log
 * Safe to call on every start: does nothing once the library is current.
 */
async function migrateLibrary({ audioDir, metadataDir, workspacesDir, backupsDir, pcmCacheDir, log = console }) {
    const markerPath = path.join(audioDir, 'library.json');
    const marker = await fs.readJson(markerPath).catch(() => null);
    if (marker && marker.version >= LIBRARY_VERSION) {
        return { migrated: false };
    }

    await fs.ensureDir(audioDir);
    await fs.ensureDir(metadataDir);

    // Every audio file anywhere under the library, except metadata.
    const files = [];
    const walk = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== metadataDir) await walk(full);
            } else if (entry.isFile() && isSupportedAudio(entry.name)) {
                const stat = await fs.stat(full);
                files.push({ path: full, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
            }
        }
    };
    await walk(audioDir);

    if (files.length === 0) {
        await writeJsonAtomic(markerPath, { version: LIBRARY_VERSION, migratedAt: new Date().toISOString(), files: 0 });
        return { migrated: true, files: 0, unique: 0, removed: 0 };
    }

    // Back up project files and metadata before changing anything.
    const backupDir = path.join(backupsDir, `library-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fs.ensureDir(backupDir);
    await fs.copy(metadataDir, path.join(backupDir, 'metadata')).catch(() => {});
    await fs.copy(workspacesDir, path.join(backupDir, 'workspaces')).catch(() => {});

    for (const file of files) {
        file.hash = await hashFile(file.path);
    }

    // Group identical content; oldest copy first, so the original upload
    // gets the plain name if two different files compete for it.
    const groups = new Map();
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (!groups.has(file.hash)) groups.set(file.hash, []);
        groups.get(file.hash).push(file);
    }

    const records = await readJsonFiles(metadataDir);
    const recordsByPath = new Map();
    for (const { data } of records) {
        if (!data?.id) continue;
        // The relative path first: absolute ones break when the data
        // folder has been moved or copied (they still name the old place).
        const rel = data.relativePath ? path.normalize(data.relativePath) : null;
        const abs = rel ? path.resolve(audioDir, rel) : (data.path ? path.resolve(data.path) : null);
        if (abs) {
            if (!recordsByPath.has(abs)) recordsByPath.set(abs, []);
            recordsByPath.get(abs).push(data);
        }
    }

    // Stage canonical files in a scratch folder, so no rename can collide
    // with a file that is itself about to move.
    const stagingDir = path.join(audioDir, '.migrating');
    await fs.ensureDir(stagingDir);

    const takenNames = new Set();
    const idMap = new Map(); // old record id -> new id
    const pathMap = new Map(); // old relative path -> new relative path
    const newRecords = [];
    const mapping = [];
    let removed = 0;

    for (const [hash, group] of groups) {
        let name = cleanLegacyName(sanitizeFilename(group[0].name));
        for (let n = 2; takenNames.has(name.toLowerCase()); n++) {
            name = withCopyNumber(cleanLegacyName(sanitizeFilename(group[0].name)), n);
        }
        takenNames.add(name.toLowerCase());

        const groupRecords = group.flatMap((f) => recordsByPath.get(path.resolve(f.path)) || []);
        const base = groupRecords.find((r) => r.duration) || groupRecords[0] || {};
        const id = base.id || randomUUID();

        await fs.move(group[0].path, path.join(stagingDir, name));
        for (const dup of group.slice(1)) {
            await fs.remove(dup.path);
            removed += 1;
        }

        for (const record of groupRecords) idMap.set(record.id, id);
        for (const f of group) pathMap.set(path.relative(audioDir, f.path), name);

        newRecords.push({
            ...base,
            id,
            path: path.join(audioDir, name),
            relativePath: name,
            filename: name,
            name: path.basename(name, path.extname(name)),
            size: group[0].size,
            hash,
        });
        mapping.push({ file: name, hash, id, from: group.map((f) => path.relative(audioDir, f.path)), mergedIds: groupRecords.map((r) => r.id) });
    }

    for (const name of await fs.readdir(stagingDir)) {
        await fs.move(path.join(stagingDir, name), path.join(audioDir, name), { overwrite: true });
    }
    await fs.remove(stagingDir);

    // Metadata: exactly one record per library file. Records that pointed
    // at no existing file are kept untouched (their cues show as missing,
    // as before).
    const mergedIds = new Set(idMap.keys());
    for (const { file, data } of records) {
        if (data?.id && mergedIds.has(data.id)) await fs.remove(file);
    }
    for (const record of newRecords) {
        await writeJsonAtomic(path.join(metadataDir, `${record.id}.json`), record);
    }

    // Every project's references.
    let referencesUpdated = 0;
    for (const { file, data } of await readJsonFiles(workspacesDir)) {
        const count = rewriteCueReferences(data.cues, (ref) => {
            const byId = ref.audioFileId && idMap.get(ref.audioFileId);
            const rel = ref.relativePath && pathMap.get(path.normalize(ref.relativePath));
            if (!byId && !rel) return null;
            const record = newRecords.find((r) => r.id === byId) || newRecords.find((r) => r.relativePath === rel);
            return record ? { audioFileId: record.id, relativePath: record.relativePath } : null;
        });
        if (count > 0) {
            await writeJsonAtomic(file, data);
            referencesUpdated += count;
        }
    }

    await removeEmptyDirs(audioDir, [path.basename(metadataDir)]);
    // Decoded-audio cache entries are keyed by the old paths - rebuilt on demand.
    if (pcmCacheDir) await fs.emptyDir(pcmCacheDir).catch(() => {});

    const summary = {
        version: LIBRARY_VERSION,
        migratedAt: new Date().toISOString(),
        files: files.length,
        unique: groups.size,
        removed,
        referencesUpdated,
        backupDir,
    };
    await writeJsonAtomic(path.join(backupDir, 'migration-log.json'), { ...summary, mapping });
    await writeJsonAtomic(markerPath, summary);
    log.log(`MediaLibrary: Migrated ${files.length} files to ${groups.size} unique (${removed} duplicates removed, ${referencesUpdated} cue references updated). Backup: ${backupDir}`);
    return { migrated: true, ...summary };
}

module.exports = {
    LIBRARY_VERSION,
    SUPPORTED_EXTENSIONS,
    hashFile,
    sanitizeFilename,
    withCopyNumber,
    cleanLegacyName,
    findExistingName,
    isSupportedAudio,
    rewriteCueReferences,
    migrateLibrary,
};
