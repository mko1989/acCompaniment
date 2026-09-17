/**
 * Simple LRU cache with entry count and approximate byte limits.
 */
class LruCache {
    constructor({ maxEntries = 50, maxBytes = 512 * 1024 * 1024 } = {}) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.cache = new Map();
        this.totalBytes = 0;
    }

    get(key) {
        if (!this.cache.has(key)) {
            return undefined;
        }
        const entry = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key, value, byteSize = 0) {
        if (this.cache.has(key)) {
            const existing = this.cache.get(key);
            this.totalBytes -= existing.byteSize;
            this.cache.delete(key);
        }

        this.cache.set(key, { value, byteSize });
        this.totalBytes += byteSize;
        this._evict();
    }

    delete(key) {
        if (!this.cache.has(key)) {
            return;
        }
        const entry = this.cache.get(key);
        this.totalBytes -= entry.byteSize;
        this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
        this.totalBytes = 0;
    }

    get size() {
        return this.cache.size;
    }

    _evict() {
        while (
            (this.maxEntries > 0 && this.cache.size > this.maxEntries)
            || (this.maxBytes > 0 && this.totalBytes > this.maxBytes)
        ) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.delete(oldestKey);
        }
    }
}

function estimateAudioBufferBytes(audioBuffer) {
    if (!audioBuffer) {
        return 0;
    }
    return audioBuffer.length * audioBuffer.numberOfChannels * 4;
}

module.exports = { LruCache, estimateAudioBufferBytes };
