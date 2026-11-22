#!/usr/bin/env node
/** Writes a zip from [{ name, text }] with yazl, for the bundle ops of rust/scripts/diff-data.js. */
const fs = require('node:fs');
const yazl = require('yazl');
const [out, spec] = process.argv.slice(2);
const zip = new yazl.ZipFile();
for (const { name, text } of JSON.parse(spec)) zip.addBuffer(Buffer.from(text), name, { mtime: new Date(0) });
zip.end();
zip.outputStream.pipe(fs.createWriteStream(out)).on('close', () => process.exit(0));
