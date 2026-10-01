/**
 * Project bundles: a single .zip holding a project and every audio file it
 * uses, for moving a show to another machine.
 *
 *   project.json      { format, version, exportedAt, project: {...} }
 *   audio/<filename>  each library file the project's cues use
 *
 * Reading treats the zip as untrusted: only those entries are accepted,
 * names can't escape the extraction folder, and sizes are capped.
 */

const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { sanitizeFilename, isSupportedAudio } = require('./mediaLibrary');

const BUNDLE_FORMAT = 'accompaniment-project';
const BUNDLE_VERSION = 1;
const MAX_ENTRIES = 5000;
const MAX_PROJECT_JSON_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024; // 20GB of audio

/** Every { audioFileId, relativePath } the project's cues use. */
function audioReferences(cues) {
    const refs = [];
    for (const cue of cues || []) {
        if (cue.type === 'playlist') {
            for (const item of cue.playlistItems || []) refs.push(item);
        } else if (cue.audioFileId || cue.relativePath) {
            refs.push(cue);
        }
    }
    return refs;
}

/**
 * Streams a bundle for `project` into `output` (e.g. an HTTP response).
 * `resolveAudio(ref)` returns the library record ({ path, relativePath }) for
 * a reference, or null. Resolves with { files, missing } once written.
 */
async function writeBundle(project, output, resolveAudio) {
    const zip = new yazl.ZipFile();
    const added = new Map(); // bundle path -> library path
    const missing = [];

    for (const ref of audioReferences(project.cues)) {
        const record = await resolveAudio(ref);
        if (!record || !(await fs.pathExists(record.path))) {
            missing.push(ref.relativePath || ref.audioFileId);
            continue;
        }
        const entryName = `audio/${path.basename(record.relativePath)}`;
        if (!added.has(entryName)) {
            added.set(entryName, record.path);
            // Audio is already compressed - storing it is as small and much faster.
            zip.addFile(record.path, entryName, { compress: false });
        }
    }

    const manifest = {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        missingAudio: missing,
        project: {
            name: project.name,
            description: project.description || '',
            layout: project.layout,
            createdAt: project.createdAt,
            cues: project.cues,
        },
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'project.json');
    zip.end();

    return new Promise((resolve, reject) => {
        zip.outputStream.on('error', reject);
        output.on('error', reject);
        output.on('finish', () => resolve({ files: added.size, missing }));
        zip.outputStream.pipe(output);
    });
}

function openZip(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => (err ? reject(err) : resolve(zipfile)));
    });
}

function readEntry(zipfile, entry) {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
}

/**
 * Unpacks a bundle into `extractDir`. Returns
 * { project, audio: [{ name, path }] } - `name` is the file's name in the
 * bundle (what the project's cues refer to), `path` where it was extracted.
 * Throws a readable Error for anything that isn't a valid bundle.
 */
async function readBundle(zipPath, extractDir) {
    let zipfile;
    try {
        zipfile = await openZip(zipPath);
    } catch (error) {
        throw new Error(`Not a project bundle (not a zip file): ${error.message}`);
    }
    await fs.ensureDir(extractDir);

    let manifest = null;
    const audio = [];
    let entries = 0;
    let totalBytes = 0;

    try {
        await new Promise((resolve, reject) => {
            zipfile.on('error', reject);
            zipfile.on('end', resolve);
            zipfile.on('entry', async (entry) => {
                try {
                    entries += 1;
                    totalBytes += entry.uncompressedSize;
                    if (entries > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
                        throw new Error('Bundle is too large');
                    }
                    const name = entry.fileName;
                    if (name.endsWith('/')) {
                        zipfile.readEntry();
                        return;
                    }
                    if (name === 'project.json') {
                        if (entry.uncompressedSize > MAX_PROJECT_JSON_BYTES) throw new Error('project.json is too large');
                        const chunks = [];
                        const stream = await readEntry(zipfile, entry);
                        for await (const chunk of stream) chunks.push(chunk);
                        manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    } else if (name.startsWith('audio/') && !name.slice(6).includes('/')) {
                        const original = name.slice(6);
                        const safe = sanitizeFilename(original);
                        if (!isSupportedAudio(safe)) throw new Error(`Unsupported audio file in bundle: ${original}`);
                        const target = path.join(extractDir, `${audio.length}-${safe}`);
                        const stream = await readEntry(zipfile, entry);
                        await new Promise((res, rej) => {
                            const out = fs.createWriteStream(target);
                            stream.on('error', rej);
                            out.on('error', rej);
                            out.on('finish', res);
                            stream.pipe(out);
                        });
                        audio.push({ name: original, path: target });
                    }
                    // Anything else (e.g. __MACOSX/ from re-zipping on a Mac) is ignored.
                    zipfile.readEntry();
                } catch (error) {
                    reject(error);
                }
            });
            zipfile.readEntry();
        });
    } finally {
        zipfile.close();
    }

    if (!manifest || manifest.format !== BUNDLE_FORMAT || !manifest.project || !Array.isArray(manifest.project.cues)) {
        throw new Error('Not a project bundle (no valid project.json)');
    }
    if (manifest.version > BUNDLE_VERSION) {
        throw new Error(`This bundle was made by a newer version of acCompaniment (format ${manifest.version})`);
    }
    return { project: manifest.project, audio, missingAudio: manifest.missingAudio || [] };
}

module.exports = {
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    audioReferences,
    writeBundle,
    readBundle,
};
