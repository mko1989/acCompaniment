//! `pcmCache.js`: decoded PCM kept on disk, so a file decodes once per engine rate.
//!
//! Same layout as the original (`<key>.f32` raw little-endian interleaved stereo, `<key>.json`
//! `{sourcePath, sampleRate, channels, durationSec, frameCount, cachedAt}`), but the key includes
//! `decoder-3`, so nothing the ffmpeg decoder cached is reused (ADR-006 lets the format change).

use std::path::{Path, PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::decode::{DECODER_VERSION, Decoded, decode_to_float32};

/// `cacheKeyForFile`: the path, its modification time and size, and the decoder version.
pub fn cache_key(file_path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(file_path).map_err(|e| e.to_string())?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let mut h = Sha256::new();
    h.update(file_path.as_bytes());
    h.update(mtime_ns.to_string().as_bytes());
    h.update(meta.len().to_string().as_bytes());
    h.update(format!("decoder-{DECODER_VERSION}").as_bytes());
    Ok(hex::encode(h.finalize()))
}

fn paths(dir: &str, key: &str) -> (PathBuf, PathBuf) {
    let d = Path::new(dir);
    (d.join(format!("{key}.f32")), d.join(format!("{key}.json")))
}

/// `getCachedDecoded`: `None` when not cached, or cached at another rate.
pub fn get_cached(file_path: &str, dir: &str, sample_rate: u32) -> Option<Decoded> {
    let key = cache_key(file_path).ok()?;
    let (f32_path, meta_path) = paths(dir, &key);
    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path).ok()?).ok()?;
    if meta.get("sampleRate")?.as_f64()? != f64::from(sample_rate) {
        return None;
    }
    let bytes = std::fs::read(&f32_path).ok()?;
    let samples: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    let channels = meta.get("channels")?.as_u64()? as usize;
    let duration_sec = meta.get("durationSec")?.as_f64()?;
    Some(Decoded {
        samples,
        channels,
        sample_rate,
        duration_sec,
        via: "cache",
    })
}

/// `storeDecodedCache`.
pub fn store(file_path: &str, dir: &str, decoded: &Decoded) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let key = cache_key(file_path)?;
    let (f32_path, meta_path) = paths(dir, &key);
    let mut body = Vec::with_capacity(decoded.samples.len() * 4);
    for s in &decoded.samples {
        body.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(&f32_path, body).map_err(|e| e.to_string())?;
    let meta = json!({
        "sourcePath": file_path,
        "sampleRate": decoded.sample_rate,
        "channels": decoded.channels,
        "durationSec": decoded.duration_sec,
        "frameCount": decoded.samples.len() / decoded.channels.max(1),
        "cachedAt": crate::core::jsv::iso_now(),
    });
    let text = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    // Written last and atomically: a reader that finds the JSON finds the samples too.
    let tmp = meta_path.with_extension(format!("json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &meta_path).map_err(|e| e.to_string())?;
    Ok(key)
}

/// `warmPcmCache`: decode once and keep it.
pub fn warm(file_path: &str, dir: &str, sample_rate: u32) -> Result<(), String> {
    if get_cached(file_path, dir, sample_rate).is_some() {
        return Ok(());
    }
    let decoded = decode_to_float32(file_path, sample_rate)?;
    store(file_path, dir, &decoded).map(|_| ())
}
