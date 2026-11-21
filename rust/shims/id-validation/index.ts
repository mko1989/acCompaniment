// Typed ES-module face of src/backend/utils/idValidation.js (CommonJS), so rust-anything can
// bridge and record it (rust/DECISIONS.md ADR-014). Every call goes to the original.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/utils/idValidation.js');

export function isValidUuid(id: string): boolean {
    return original.isValidUuid(id);
}

export function validateUuidOrError(id: string, label: string): { valid: boolean; error?: string } {
    return original.validateUuidOrError(id, label);
}
