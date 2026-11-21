// Typed ES-module face of src/backend/utils/lruCache.js (CommonJS), so rust-anything can
// bridge and record it (rust/DECISIONS.md ADR-014). Every call goes to the original.
// LruCache is stateful: runCache builds one and applies `ops` in order, returning after each op
// what is observable: the op's result, size, totalBytes and the keys oldest first.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/utils/lruCache.js');

export type CacheOp = { op: string; key: string; value?: number; bytes?: number };

export function runCache(maxEntries: number, maxBytes: number, ops: CacheOp[]): unknown[] {
    const cache = new original.LruCache({ maxEntries, maxBytes });
    return ops.map(({ op, key, value, bytes }) => {
        let result: unknown = null;
        if (op === 'get') {
            const got = cache.get(key);
            result = got === undefined ? null : got;
        } else if (op === 'set') {
            if (bytes === undefined) cache.set(key, value);
            else cache.set(key, value, bytes);
        } else if (op === 'delete') {
            cache.delete(key);
        } else if (op === 'clear') {
            cache.clear();
        }
        return { result, size: cache.size, totalBytes: cache.totalBytes, keys: [...cache.cache.keys()] };
    });
}

export function estimateAudioBufferBytes(length: number, numberOfChannels: number, present: boolean): number {
    return original.estimateAudioBufferBytes(present ? { length, numberOfChannels } : null);
}
