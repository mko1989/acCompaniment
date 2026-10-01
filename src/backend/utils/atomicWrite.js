const fs = require('fs-extra');
const fsp = require('fs/promises');
const path = require('path');

let tmpCounter = 0;

/**
 * Write JSON to disk atomically: temp file → fsync → rename.
 * Prevents 0-byte or partial files if the process crashes mid-write.
 */
async function writeJsonAtomic(filePath, data, options = {}) {
    const { indent = 2 } = options;
    const content = JSON.stringify(data, null, indent);
    const dir = path.dirname(filePath);
    await fs.ensureDir(dir);

    // pid + time alone collides for two writes of the same file within one
    // millisecond: they'd share a temp file, interleave into it, and the
    // second rename would fail with ENOENT. The counter makes it unique.
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`;
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
