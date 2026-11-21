// Typed ES-module face of normalizeCueFieldAliases in src/backend/cueDataManager.js (CommonJS),
// so rust-anything can bridge and record it (rust/DECISIONS.md ADR-014). Every call goes to the
// original. Callers pass a cue or a cue update (an object), from requests or project files.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/cueDataManager.js');

export function normalizeCueFieldAliases(data: unknown): unknown {
    return original.normalizeCueFieldAliases(data);
}
