const fs = require('fs-extra');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Write JSON to disk atomically: temp file → fsync → rename.
 * Prevents 0-byte or partial files if the process crashes mid-write.
 */
async function writeJsonAtomic(filePath, data, options = {}) {
    const { indent = 2 } = options;
    const content = JSON.stringify(data, null, indent);
    const dir = path.dirname(filePath);
    await fs.ensureDir(dir);

    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const fd = await fsp.open(tmpPath, 'w');

    try {
        await fd.writeFile(content, 'utf-8');
        await fd.sync();
    } finally {
        await fd.close();
    }

    await fsp.rename(tmpPath, filePath);
}

module.exports = { writeJsonAtomic };
