// Typed ES-module face of src/backend/utils/outputPatch.js (CommonJS), so rust-anything can
// bridge and record it (rust/DECISIONS.md ADR-014). Every call goes to the original.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/utils/outputPatch.js');

// `patch` is a cue's stored outputPatch: any JSON value, or missing.
export function normalizeOutputPatch(patch: unknown, maxChannels?: number): number[] {
    return original.normalizeOutputPatch(patch, maxChannels);
}
