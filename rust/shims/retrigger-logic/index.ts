// Typed ES-module face of src/backend/retriggerLogic.js (CommonJS), so rust-anything can
// bridge and record it (rust/DECISIONS.md ADR-014). Every call goes to the original.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/retriggerLogic.js');

// RETRIGGER_BEHAVIORS is not wrapped: nothing outside the module uses it, normalizeRetriggerBehavior
// round-trips every member, and a zero-argument function trips a rust-anything codegen bug.

// `behavior` is a cue's stored retriggerBehavior (or a trigger option): any JSON value.
export function normalizeRetriggerBehavior(behavior: unknown): unknown {
    return original.normalizeRetriggerBehavior(behavior);
}

export function resolveRetrigger(behavior: unknown, state: string, isPlaylist?: boolean): string {
    return original.resolveRetrigger(behavior, state, isPlaylist);
}
