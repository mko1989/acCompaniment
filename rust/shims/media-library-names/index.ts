// Typed ES-module face of the pure naming helpers in src/backend/mediaLibrary.js (CommonJS), so
// rust-anything can bridge and record them (rust/DECISIONS.md ADR-014). Every call goes to the
// original. hashFile, findExistingName, rewriteCueReferences (callback) and migrateLibrary do
// I/O or take callbacks: they move with the data layer (Wave B1).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/mediaLibrary.js');

// `unknown`: slice(0, 200) can cut a surrogate pair and return a lone surrogate, which only a
// structured value carries across the bridge exactly.
export function sanitizeFilename(name: string): unknown {
    return original.sanitizeFilename(name);
}

export function withCopyNumber(name: string, n: number): string {
    return original.withCopyNumber(name, n);
}

export function cleanLegacyName(name: string): string {
    return original.cleanLegacyName(name);
}

export function isSupportedAudio(name: string): boolean {
    return original.isSupportedAudio(name);
}
