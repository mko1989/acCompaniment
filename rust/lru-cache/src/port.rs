//! The Rust port of `src/backend/utils/lruCache.js` (through `rust/shims/lru-cache/`).
//!
//! `LruCache` is the cache itself, for the core (`audioPlaybackManager` keeps decoded audio in
//! one). `run_cache` is the shim's op runner: it drives an `LruCache` with JS values as keys and
//! reports what the original reports after each op.
//!
//! The original is a JS `Map`, which keeps insertion order: `get` moves a key to the end (delete
//! and re-insert), and eviction drops the oldest first. Byte counts are JS numbers (f64): NaN and
//! Infinity propagate, and a limit of 0 or less (or NaN) means "no limit".

#![forbid(unsafe_code)]

use std::hash::Hash;

use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::js;

/// One cached value and the bytes it counts for.
#[derive(Debug, Clone)]
struct Entry<V> {
    value: V,
    byte_size: f64,
}

/// An LRU cache bounded by entry count and by approximate bytes (`lruCache.js:4`).
#[derive(Debug, Clone)]
pub struct LruCache<K, V> {
    max_entries: f64,
    max_bytes: f64,
    cache: IndexMap<K, Entry<V>>,
    total_bytes: f64,
}

impl<K: Hash + Eq + Clone, V> LruCache<K, V> {
    /// `new LruCache({ maxEntries, maxBytes })`; the original's defaults are 50 and 512 MiB.
    pub fn new(max_entries: f64, max_bytes: f64) -> Self {
        LruCache {
            max_entries,
            max_bytes,
            cache: IndexMap::new(),
            total_bytes: 0.0,
        }
    }

    /// The value, now the most recently used; `None` when absent.
    pub fn get(&mut self, key: &K) -> Option<&V> {
        let (k, entry) = self.cache.shift_remove_entry(key)?;
        self.cache.insert(k, entry);
        self.cache.last().map(|(_, entry)| &entry.value)
    }

    /// Insert or replace (moving the key to the end), then evict.
    pub fn set(&mut self, key: K, value: V, byte_size: f64) {
        self.insert(key, value, byte_size);
        self.evict();
    }

    /// Remove a key, if present.
    pub fn delete(&mut self, key: &K) {
        if let Some(entry) = self.cache.shift_remove(key) {
            self.total_bytes -= entry.byte_size;
        }
    }

    pub fn clear(&mut self) {
        self.cache.clear();
        self.total_bytes = 0.0;
    }

    pub fn len(&self) -> usize {
        self.cache.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }

    pub fn total_bytes(&self) -> f64 {
        self.total_bytes
    }

    /// Keys, least recently used first.
    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.cache.keys()
    }

    fn insert(&mut self, key: K, value: V, byte_size: f64) {
        if let Some(existing) = self.cache.shift_remove(&key) {
            self.total_bytes -= existing.byte_size;
        }
        self.cache.insert(key, Entry { value, byte_size });
        self.total_bytes += byte_size;
    }

    fn over_limit(&self) -> bool {
        // `len as f64` is exact for any length a cache can reach.
        (self.max_entries > 0.0 && self.cache.len() as f64 > self.max_entries)
            || (self.max_bytes > 0.0 && self.total_bytes > self.max_bytes)
    }

    fn evict(&mut self) {
        self.evict_until(|_| false);
    }

    /// `_evict` (`lruCache.js:53`). The original stops when the oldest key reads as `undefined`
    /// (its "map is empty" check), which a key that *is* `undefined` also triggers: `stop` says
    /// which keys those are (none, for real callers).
    fn evict_until(&mut self, stop: impl Fn(&K) -> bool) {
        while self.over_limit() {
            let Some((oldest, _)) = self.cache.first() else {
                break;
            };
            if stop(oldest) {
                break;
            }
            let oldest = oldest.clone();
            self.delete(&oldest);
        }
    }
}

/// Port of `estimateAudioBufferBytes` (`lruCache.js:66`), through the shim:
/// `length * numberOfChannels * 4`, or 0 for no buffer.
pub fn estimate_audio_buffer_bytes(
    length: f64,
    number_of_channels: f64,
    present: bool,
) -> Result<f64, String> {
    Ok(if present {
        length * number_of_channels * 4.0
    } else {
        0.0
    })
}

/// A JS value used as a `Map` key: equal exactly when JS's SameValueZero says so.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum MapKey {
    Undefined,
    Null,
    Bool(bool),
    /// The number's bits, with `-0` folded into `0` and every NaN into one.
    Number(u64),
    String(String),
    /// Objects and arrays are keys by identity: no two are ever the same key.
    Object(usize),
}

impl MapKey {
    fn of(value: &Value, next_object: &mut usize) -> Self {
        if js::is_undefined(value) {
            return MapKey::Undefined;
        }
        if let Some(n) = js::as_number(value) {
            let n = if n.is_nan() {
                f64::NAN
            } else if n == 0.0 {
                0.0
            } else {
                n
            };
            return MapKey::Number(n.to_bits());
        }
        match value {
            Value::Null => MapKey::Null,
            Value::Bool(b) => MapKey::Bool(*b),
            Value::String(s) => MapKey::String(s.clone()),
            _ => {
                *next_object += 1;
                MapKey::Object(*next_object)
            }
        }
    }
}

/// Port of the shim's `runCache` (`rust/shims/lru-cache/index.ts:12`).
pub fn run_cache(max_entries: f64, max_bytes: f64, ops: Value) -> Result<Vec<Value>, String> {
    let Value::Array(ops) = ops else {
        return Err("TypeError: ops.map is not a function".into());
    };
    // Keys as the Map holds them: identity, and the value `keys()` returns (`-0` reads as `0`).
    let mut cache: LruCache<MapKey, Value> = LruCache::new(max_entries, max_bytes);
    let mut shown: IndexMap<MapKey, Value> = IndexMap::new();
    let mut next_object = 0;
    let field = |op: &Value, name: &str| op.get(name).cloned().unwrap_or_else(js::undefined);

    let mut out = Vec::with_capacity(ops.len());
    for op in &ops {
        let key_value = field(op, "key");
        let key = MapKey::of(&key_value, &mut next_object);
        let mut result = Value::Null;
        match op.get("op").and_then(Value::as_str) {
            Some("get") => {
                if let Some(v) = cache.get(&key)
                    && !js::is_undefined(v)
                {
                    result = v.clone();
                }
            }
            Some("set") => {
                let bytes = field(op, "bytes");
                let byte_size = if js::is_undefined(&bytes) {
                    0.0
                } else {
                    js::as_number(&bytes).unwrap_or(f64::NAN)
                };
                let shown_key = match key {
                    MapKey::Number(bits) => js::number(f64::from_bits(bits)),
                    _ => key_value,
                };
                shown.insert(key.clone(), shown_key);
                cache.insert(key, field(op, "value"), byte_size);
                cache.evict_until(|k| *k == MapKey::Undefined);
            }
            Some("delete") => cache.delete(&key),
            Some("clear") => cache.clear(),
            _ => {}
        }
        let keys: Vec<Value> = cache
            .keys()
            .map(|k| shown.get(k).cloned().unwrap_or(Value::Null))
            .collect();
        out.push(json!({
            "result": result,
            "size": cache.len(),
            "totalBytes": js::number(cache.total_bytes()),
            "keys": keys,
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_by_bytes_and_get_refreshes() {
        let mut c: LruCache<&str, i32> = LruCache::new(50.0, 100.0);
        c.set("a", 1, 40.0);
        c.set("b", 2, 40.0);
        assert_eq!(c.get(&"a"), Some(&1));
        c.set("c", 3, 40.0);
        assert_eq!(c.keys().copied().collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(c.total_bytes(), 80.0);
    }

    #[test]
    fn evicts_by_count_and_no_limit_at_zero() {
        let mut c: LruCache<i32, ()> = LruCache::new(2.0, 0.0);
        for k in 0..3 {
            c.set(k, (), 1e12);
        }
        assert_eq!(c.keys().copied().collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn an_item_bigger_than_the_limit_evicts_itself() {
        let mut c: LruCache<&str, ()> = LruCache::new(50.0, 100.0);
        c.set("a", (), 10.0);
        c.set("big", (), 500.0);
        assert!(c.is_empty());
        assert_eq!(c.total_bytes(), 0.0);
    }

    #[test]
    fn non_array_ops_throw_like_the_original() {
        assert_eq!(
            run_cache(1.0, 1.0, json!("x")).unwrap_err(),
            "TypeError: ops.map is not a function"
        );
    }
}
