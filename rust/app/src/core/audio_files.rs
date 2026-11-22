//! Port of `src/backend/audioFileManager.js` (PCM-cache warming is a no-op hook until B4).
//!
//! Records are JSON objects, as the original keeps them. A probe field that was `undefined`
//! keeps its key (as the JS `undefined` marker) so a later update lands in the same place;
//! it is left out when written. The metadata index holds each record once, by id; the path
//! indexes point at ids.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::id_validation;
use super::jsv::{self, Obj};
use super::library;
use super::nodefs as nfs;
use super::paths::{FileInfo, PathManager};
use super::probe;
use crate::js;

const SUPPORTED: [&str; 6] = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
const UPDATABLE: [&str; 5] = ["name", "tags", "title", "artist", "album"];

#[derive(Default)]
struct Index {
    by_id: HashMap<String, Obj>,
    by_relative: HashMap<String, String>,
    by_absolute: HashMap<String, String>,
}

/// What `_probeAudio` found.
pub struct ProbeResult {
    pub size: u64,
    pub format: String,
    pub probe: probe::Probe,
}

fn key(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), jsv::stringify)
}

/// A probe value as the record holds it: a number, or the `undefined` marker.
fn opt_num(v: Option<f64>) -> Value {
    v.map_or_else(js::undefined, js::number)
}

fn opt_str(v: &Option<String>) -> Value {
    v.as_ref().map_or_else(js::undefined, |s| json!(s))
}

/// `Math.round(bytes / 1024 / 1024)`.
fn mb(bytes: f64) -> String {
    js::number_to_string(js::math_round(bytes / 1024.0 / 1024.0))
}

pub struct AudioFileManager {
    pm: PathManager,
    pub max_file_size: f64,
    pub pcm_sample_rate: f64,
    index: Option<Index>,
}

impl AudioFileManager {
    pub fn new(pm: &PathManager) -> Self {
        AudioFileManager {
            pm: pm.clone(),
            max_file_size: 104_857_600.0,
            pcm_sample_rate: 48000.0,
            index: None,
        }
    }

    pub fn set_pcm_sample_rate(&mut self, v: &Value) {
        if let Some(n) = v.as_f64().filter(|n| *n > 0.0) {
            self.pcm_sample_rate = n;
        }
    }

    pub fn set_max_file_size(&mut self, v: &Value) {
        if let Some(n) = v.as_f64().filter(|n| *n > 0.0) {
            self.max_file_size = n;
        }
    }

    pub fn metadata_dir(&self) -> String {
        self.pm.metadata_dir()
    }

    pub fn invalidate_metadata_index(&mut self) {
        self.index = None;
    }

    /// `_resolveRecordPath(record)` (WO-015): `relativePath` inside the audio dir first.
    fn resolve_record_path(&self, rec: &Obj) -> Result<Option<String>, ()> {
        let as_path =
            |v: &Value| -> Result<String, ()> { v.as_str().map(str::to_string).ok_or(()) };
        if let Some(rel) = rec.get("relativePath").filter(|v| jsv::truthy(v)) {
            return Ok(self.pm.resolve_within_audio_dir(&as_path(rel)?));
        }
        match rec.get("path").filter(|v| jsv::truthy(v)) {
            Some(p) => Ok(self.pm.resolve_within_audio_dir(&as_path(p)?)),
            None => Ok(None),
        }
    }

    fn ensure_index(&mut self) {
        if self.index.is_none() {
            self.rebuild_index();
        }
    }

    fn rebuild_index(&mut self) {
        let mut idx = Index::default();
        let dir = self.metadata_dir();
        let _ = nfs::ensure_dir(&dir);
        for file in nfs::readdir(&dir).unwrap_or_default() {
            if !file.ends_with(".json") {
                continue;
            }
            let Ok(Value::Object(mut rec)) = nfs::read_json(&nfs::join2(&dir, &file)) else {
                continue;
            };
            if !jsv::truthy_opt(rec.get("id")) {
                continue;
            }
            let id = key(rec.get("id"));
            if jsv::truthy_opt(rec.get("path")) || jsv::truthy_opt(rec.get("relativePath")) {
                // A path that isn't a string throws in the original: the record is skipped.
                let Ok(safe) = self.resolve_record_path(&rec) else {
                    continue;
                };
                if let Some(safe) = safe {
                    rec.insert("path".into(), json!(safe));
                    idx.by_absolute.insert(safe, id.clone());
                }
            }
            if let Some(rel) = rec.get("relativePath").filter(|v| jsv::truthy(v)) {
                idx.by_relative.insert(jsv::to_js_string(rel), id.clone());
            }
            idx.by_id.insert(id, rec);
        }
        self.index = Some(idx);
    }

    fn index_add(&mut self, rec: &Obj) {
        let Some(idx) = self.index.as_mut() else {
            return;
        };
        if !jsv::truthy_opt(rec.get("id")) {
            return;
        }
        let id = key(rec.get("id"));
        if let Some(rel) = rec.get("relativePath").filter(|v| jsv::truthy(v)) {
            idx.by_relative.insert(jsv::to_js_string(rel), id.clone());
        }
        if let Some(p) = rec.get("path").filter(|v| jsv::truthy(v)) {
            idx.by_absolute.insert(jsv::to_js_string(p), id.clone());
        }
        idx.by_id.insert(id, rec.clone());
    }

    fn index_remove(&mut self, id: &Value, rec: Option<&Obj>) {
        let Some(idx) = self.index.as_mut() else {
            return;
        };
        let k = key(Some(id));
        let existing = rec.cloned().or_else(|| idx.by_id.get(&k).cloned());
        idx.by_id.remove(&k);
        if let Some(e) = existing {
            if let Some(rel) = e.get("relativePath").filter(|v| jsv::truthy(v)) {
                idx.by_relative.remove(&jsv::to_js_string(rel));
            }
            if let Some(p) = e.get("path").filter(|v| jsv::truthy(v)) {
                idx.by_absolute.remove(&jsv::to_js_string(p));
            }
        }
    }

    fn by_relative(&self, rel: &str) -> Option<&Obj> {
        let idx = self.index.as_ref()?;
        idx.by_id.get(idx.by_relative.get(rel)?)
    }

    fn by_absolute(&self, abs: &str) -> Option<&Obj> {
        let idx = self.index.as_ref()?;
        idx.by_id.get(idx.by_absolute.get(abs)?)
    }

    fn file_info_json(fi: &FileInfo) -> Value {
        json!({
            "path": fi.path,
            "relativePath": fi.relative_path,
            "name": fi.name,
            "size": fi.size,
            "created": nfs::date_json(fi.created_ms),
            "modified": nfs::date_json(fi.modified_ms),
            "extension": fi.extension,
        })
    }

    fn metadata_json(p: &probe::Probe) -> Obj {
        let mut m = Obj::new();
        m.insert("duration".into(), opt_num(p.duration));
        m.insert("bitrate".into(), opt_num(p.bitrate));
        m.insert("sampleRate".into(), opt_num(p.sample_rate));
        m.insert("channels".into(), opt_num(p.channels));
        m.insert("codec".into(), js::undefined());
        m.insert("title".into(), opt_str(&p.title));
        m.insert("artist".into(), opt_str(&p.artist));
        m.insert("album".into(), opt_str(&p.album));
        m
    }

    fn unsupported(ext: &str) -> String {
        format!(
            "Unsupported format: {ext}. Supported: {}",
            SUPPORTED.join(", ")
        )
    }

    /// `validateAudioFile(filePath)`: a path inside the library.
    pub fn validate_audio_file(&self, file_path: &str) -> Value {
        let Some(fi) = self.pm.get_file_info(file_path) else {
            return json!({ "valid": false, "error": "File not found" });
        };
        if !SUPPORTED.contains(&fi.extension.as_str()) {
            return json!({ "valid": false, "error": Self::unsupported(&fi.extension) });
        }
        if fi.size as f64 > self.max_file_size {
            return json!({
                "valid": false,
                "error": format!("File too large: {}MB. Max: {}MB", mb(fi.size as f64), mb(self.max_file_size)),
            });
        }
        match probe::parse_file(&fi.path, false) {
            Ok(p) => json!({
                "valid": true,
                "fileInfo": Self::file_info_json(&fi),
                "metadata": Value::Object(Self::metadata_json(&p)),
            }),
            Err(e) => json!({ "valid": false, "error": format!("Invalid audio file: {e}") }),
        }
    }

    /// `_probeAudio(filePath, displayName)`.
    pub fn probe_audio(&self, file_path: &str, display_name: &str) -> Result<ProbeResult, String> {
        let name = if display_name.is_empty() {
            file_path
        } else {
            display_name
        };
        let ext = nfs::extname(name).to_lowercase();
        if !SUPPORTED.contains(&ext.as_str()) {
            return Err(Self::unsupported(if ext.is_empty() {
                "(none)"
            } else {
                &ext
            }));
        }
        let st = match nfs::stat(file_path) {
            Ok(s) if s.is_file => s,
            _ => return Err("File not found".into()),
        };
        if st.size as f64 > self.max_file_size {
            return Err(format!(
                "File too large: {}MB. Max: {}MB",
                mb(st.size as f64),
                mb(self.max_file_size)
            ));
        }
        match probe::parse_file(file_path, true) {
            Ok(p) if p.duration.is_some_and(|d| d > 0.0) => Ok(ProbeResult {
                size: st.size,
                format: ext,
                probe: p,
            }),
            Ok(_) => Err("Invalid audio file: no playable audio found".into()),
            Err(e) => Err(format!("Invalid audio file: {e}")),
        }
    }

    fn record_fields(r: &ProbeResult) -> Obj {
        let mut o = Obj::new();
        o.insert("size".into(), json!(r.size));
        o.insert("format".into(), json!(r.format));
        for (k, v) in Self::metadata_json(&r.probe) {
            o.insert(k, v);
        }
        o
    }

    /// `_recordForLibraryFile(actualName)`.
    fn record_for_library_file(&mut self, actual_name: &str) -> Result<Option<Obj>, String> {
        let file_path = nfs::join2(&self.pm.audio_dir, actual_name);
        self.ensure_index();
        let mut record = self
            .by_absolute(&file_path)
            .or_else(|| self.by_relative(actual_name))
            .cloned();
        if record.is_none() {
            let st = nfs::stat(&file_path).map_err(String::from)?;
            record = self.ensure_metadata_for_discovered_file(
                &file_path,
                actual_name,
                st.size,
                st.mtime_ms,
                &nfs::extname(actual_name).to_lowercase(),
            );
        }
        let Some(mut rec) = record else {
            return Err("Cannot read properties of null (reading 'hash')".into());
        };
        if !jsv::truthy_opt(rec.get("hash")) {
            rec.insert(
                "hash".into(),
                json!(library::hash_file(&file_path).map_err(String::from)?),
            );
            self.save_audio_file_metadata(&rec);
        }
        Ok(Some(rec))
    }

    /// `addFile(sourcePath, originalName, { copy, name, tags })`.
    pub fn add_file(
        &mut self,
        source_path: &str,
        original_name: Option<&str>,
        options: &Value,
    ) -> Value {
        let copy = jsv::truthy_opt(options.get("copy"));
        let name = library::sanitize_filename(
            original_name
                .filter(|n| !n.is_empty())
                .unwrap_or(&nfs::basename(source_path, None)),
        );
        let discard = |p: &str| {
            if !copy {
                let _ = nfs::remove(p);
            }
        };
        let result = (|| -> Result<Value, String> {
            if !library::is_supported_audio(&name) {
                discard(source_path);
                let ext = nfs::extname(&name);
                return Ok(json!({
                    "success": false,
                    "error": format!("Unsupported file format: {}", if ext.is_empty() { "(none)".into() } else { ext }),
                }));
            }
            let probe = match self.probe_audio(source_path, &name) {
                Ok(p) => p,
                Err(e) => {
                    discard(source_path);
                    return Ok(json!({ "success": false, "error": e }));
                }
            };
            let hash = library::hash_file(source_path).map_err(String::from)?;
            let audio_dir = self.pm.audio_dir.clone();
            nfs::ensure_dir(&audio_dir).map_err(String::from)?;
            for n in 1.. {
                let candidate = library::with_copy_number(&name, n);
                match library::find_existing_name(&audio_dir, &candidate) {
                    None => {
                        let target = nfs::join2(&audio_dir, &candidate);
                        if copy {
                            nfs::copy(source_path, &target).map_err(String::from)?;
                        } else {
                            nfs::move_path(source_path, &target, false).map_err(String::from)?;
                        }
                        let mut rec = Obj::new();
                        rec.insert("id".into(), json!(jsv::random_uuid()));
                        rec.insert("path".into(), json!(target));
                        rec.insert("relativePath".into(), json!(candidate));
                        rec.insert("filename".into(), json!(candidate));
                        let base = nfs::basename(&candidate, Some(&nfs::extname(&candidate)));
                        rec.insert("name".into(), jsv::or(options.get("name"), json!(base)));
                        for (k, v) in Self::record_fields(&probe) {
                            rec.insert(k, v);
                        }
                        rec.insert("hash".into(), json!(hash));
                        rec.insert("importedAt".into(), json!(jsv::iso_now()));
                        rec.insert("tags".into(), jsv::or(options.get("tags"), json!([])));
                        self.save_audio_file_metadata(&rec);
                        return Ok(
                            json!({ "success": true, "audioFile": rec, "reused": false, "renamed": n > 1 }),
                        );
                    }
                    Some(existing_name) => {
                        let existing = self
                            .record_for_library_file(&existing_name)?
                            .unwrap_or_default();
                        if existing.get("hash") == Some(&json!(hash)) {
                            discard(source_path);
                            return Ok(
                                json!({ "success": true, "audioFile": existing, "reused": true, "renamed": false }),
                            );
                        }
                    }
                }
            }
            Ok(Value::Null)
        })();
        match result {
            Ok(v) => v,
            Err(e) => {
                discard(source_path);
                json!({ "success": false, "error": e })
            }
        }
    }

    /// `replaceFile(audioFileId, sourcePath, originalName)`.
    pub fn replace_file(
        &mut self,
        audio_file_id: &Value,
        source_path: &str,
        original_name: Option<&str>,
    ) -> Value {
        let discard = |p: &str| {
            let _ = nfs::remove(p);
        };
        let result = (|| -> Result<Value, String> {
            let Some(record) = self.load_audio_file_metadata(audio_file_id) else {
                discard(source_path);
                return Ok(json!({ "success": false, "error": "Audio file not found" }));
            };
            let incoming = library::sanitize_filename(
                original_name
                    .filter(|n| !n.is_empty())
                    .unwrap_or(&nfs::basename(source_path, None)),
            );
            let probe = match self.probe_audio(source_path, &incoming) {
                Ok(p) => p,
                Err(e) => {
                    discard(source_path);
                    return Ok(json!({ "success": false, "error": e }));
                }
            };
            let audio_dir = self.pm.audio_dir.clone();
            let Some(rec_path) = record
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return Err(
                    "The \"path\" argument must be of type string. Received undefined".into(),
                );
            };
            let mut previous = Obj::new();
            previous.insert(
                "path".into(),
                record.get("path").cloned().unwrap_or_else(js::undefined),
            );
            previous.insert(
                "relativePath".into(),
                record
                    .get("relativePath")
                    .cloned()
                    .unwrap_or_else(js::undefined),
            );
            let old_ext = nfs::extname(&rec_path).to_lowercase();
            let new_ext = nfs::extname(&incoming).to_lowercase();
            let mut target_name = nfs::basename(&rec_path, None);
            if new_ext != old_ext {
                let base = format!(
                    "{}{new_ext}",
                    nfs::basename(&target_name, Some(&nfs::extname(&target_name)))
                );
                for n in 1.. {
                    let candidate = library::with_copy_number(&base, n);
                    if library::find_existing_name(&audio_dir, &candidate).is_none() {
                        target_name = candidate;
                        break;
                    }
                }
            }
            let target = nfs::join2(&audio_dir, &target_name);
            let hash = library::hash_file(source_path).map_err(String::from)?;
            nfs::move_path(source_path, &target, true).map_err(String::from)?;
            if target != rec_path {
                let _ = nfs::remove(&rec_path);
            }
            self.index_remove(record.get("id").unwrap_or(&Value::Null), Some(&record));
            let mut updated = record.clone();
            updated.insert("path".into(), json!(target));
            updated.insert("relativePath".into(), json!(target_name));
            updated.insert("filename".into(), json!(target_name));
            for (k, v) in Self::record_fields(&probe) {
                updated.insert(k, v);
            }
            updated.insert("hash".into(), json!(hash));
            updated.insert("replacedAt".into(), json!(jsv::iso_now()));
            self.save_audio_file_metadata(&updated);
            Ok(json!({ "success": true, "audioFile": updated, "previous": previous }))
        })();
        match result {
            Ok(v) => v,
            Err(e) => {
                discard(source_path);
                json!({ "success": false, "error": e })
            }
        }
    }

    /// `importAudioFile(sourcePath, options)`: copied in, same rules as uploads.
    pub fn import_audio_file(&mut self, source_path: &str, options: &Value) -> Value {
        let Some(resolved) = self.pm.resolve_within_data_dir(source_path) else {
            return json!({ "success": false, "error": "Import path must be within the application data directory" });
        };
        let mut opts = options.as_object().cloned().unwrap_or_default();
        opts.insert("copy".into(), json!(true));
        let name = nfs::basename(&resolved, None);
        self.add_file(&resolved, Some(&name), &Value::Object(opts))
    }

    /// `saveAudioFileMetadata(audioFile)`: errors are only logged.
    pub fn save_audio_file_metadata(&mut self, rec: &Obj) {
        let id = rec
            .get("id")
            .map(jsv::to_js_string)
            .unwrap_or_else(|| "undefined".into());
        let dir = self.metadata_dir();
        if nfs::ensure_dir(&dir).is_err() {
            return;
        }
        if nfs::write_json_atomic(
            &nfs::join2(&dir, &format!("{id}.json")),
            &Value::Object(rec.clone()),
        )
        .is_err()
        {
            return;
        }
        self.ensure_index();
        self.index_add(rec);
    }

    /// `loadAudioFileMetadata(audioFileId)`: a copy of the record, or `None`.
    pub fn load_audio_file_metadata(&mut self, id: &Value) -> Option<Obj> {
        if !id.as_str().is_some_and(id_validation::is_uuid) {
            return None;
        }
        self.ensure_index();
        if let Some(r) = self
            .index
            .as_ref()
            .and_then(|i| i.by_id.get(&key(Some(id))))
        {
            return Some(r.clone());
        }
        let p = nfs::join2(
            &self.metadata_dir(),
            &format!("{}.json", jsv::to_js_string(id)),
        );
        if !nfs::path_exists(&p) {
            return None;
        }
        let Ok(Value::Object(mut rec)) = nfs::read_json(&p) else {
            return None;
        };
        if jsv::truthy_opt(rec.get("path")) || jsv::truthy_opt(rec.get("relativePath")) {
            let safe = self.resolve_record_path(&rec).ok().flatten()?;
            rec.insert("path".into(), json!(safe));
        }
        self.index_add(&rec);
        Some(rec)
    }

    /// `_ensureMetadataForDiscoveredFile(file)`.
    fn ensure_metadata_for_discovered_file(
        &mut self,
        path: &str,
        name: &str,
        size: u64,
        modified_ms: f64,
        extension: &str,
    ) -> Option<Obj> {
        let rel = self.pm.to_relative_path(path)?;
        self.ensure_index();
        if let Some(existing) = self.by_relative(&rel).or_else(|| self.by_absolute(path)) {
            return Some(existing.clone());
        }
        let mut rec = Obj::new();
        rec.insert("id".into(), json!(jsv::random_uuid()));
        rec.insert("path".into(), json!(path));
        rec.insert("relativePath".into(), json!(rel));
        rec.insert("filename".into(), json!(name));
        rec.insert(
            "name".into(),
            json!(nfs::basename(name, Some(&nfs::extname(name)))),
        );
        rec.insert("size".into(), json!(size));
        rec.insert("format".into(), json!(extension));
        rec.insert("importedAt".into(), json!(jsv::iso_from_ms(modified_ms)));
        rec.insert("discoveredAt".into(), json!(jsv::iso_now()));
        self.save_audio_file_metadata(&rec);
        Some(rec)
    }

    /// `getAllAudioFiles()`.
    pub fn get_all_audio_files(&mut self) -> Vec<Obj> {
        self.ensure_index();
        let mut out = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let audio_dir = self.pm.audio_dir.clone();
        for f in self.pm.get_audio_files(&audio_dir) {
            let Some(rec) = self.ensure_metadata_for_discovered_file(
                &f.path,
                &f.name,
                f.size,
                f.modified_ms,
                &f.extension,
            ) else {
                continue;
            };
            if let Some(rel) = rec
                .get("relativePath")
                .filter(|v| jsv::truthy(v))
                .map(jsv::to_js_string)
                && !seen.contains(&rel)
            {
                seen.push(rel);
                out.push(rec);
            }
        }
        out
    }

    /// `getAudioFileByPath(filePath)`.
    pub fn get_audio_file_by_path(&mut self, file_path: &str) -> Option<Obj> {
        let resolved = self.pm.resolve_path(file_path)?;
        self.ensure_index();
        if let Some(rel) = self.pm.to_relative_path(&resolved)
            && let Some(r) = self.by_relative(&rel)
        {
            return Some(r.clone());
        }
        if let Some(r) = self.by_absolute(&resolved) {
            return Some(r.clone());
        }
        let fi = self.pm.get_file_info(&resolved)?;
        self.ensure_metadata_for_discovered_file(
            &fi.path,
            &fi.name,
            fi.size,
            fi.modified_ms,
            &fi.extension,
        )
    }

    /// `deleteAudioFile(audioFileId)`.
    pub fn delete_audio_file(&mut self, id: &Value) -> Value {
        let Some(af) = self.load_audio_file_metadata(id) else {
            return json!({ "success": false, "error": "Audio file not found" });
        };
        if let Some(p) = af.get("path").and_then(Value::as_str)
            && nfs::path_exists(p)
            && let Err(e) = nfs::remove(p)
        {
            return json!({ "success": false, "error": e.message });
        }
        let mp = nfs::join2(
            &self.metadata_dir(),
            &format!("{}.json", jsv::to_js_string(id)),
        );
        if nfs::path_exists(&mp)
            && let Err(e) = nfs::remove(&mp)
        {
            return json!({ "success": false, "error": e.message });
        }
        self.index_remove(id, Some(&af));
        json!({ "success": true })
    }

    /// `updateAudioFileMetadata(audioFileId, updates)`.
    pub fn update_audio_file_metadata(&mut self, id: &Value, updates: &Value) -> Value {
        let Some(mut af) = self.load_audio_file_metadata(id) else {
            return json!({ "success": false, "error": "Audio file not found" });
        };
        if let Value::Object(u) = updates {
            for (k, v) in u {
                if UPDATABLE.contains(&k.as_str()) {
                    af.insert(k.clone(), v.clone());
                }
            }
        }
        af.insert("updatedAt".into(), json!(jsv::iso_now()));
        self.save_audio_file_metadata(&af);
        json!({ "success": true, "audioFile": af })
    }

    /// `searchAudioFiles(query)`.
    pub fn search_audio_files(&mut self, query: &Value) -> Vec<Obj> {
        let Some(q) = query.as_str() else {
            return Vec::new();
        };
        let term = jsv::lower(q);
        let all = self.get_all_audio_files();
        let mut out = Vec::new();
        for af in all {
            let mut hit = false;
            for f in ["name", "filename", "title", "artist", "album"] {
                let Some(v) = af.get(f).filter(|v| jsv::truthy(v)) else {
                    continue;
                };
                // A non-string field throws in the original, which then finds nothing at all.
                let Some(s) = v.as_str() else {
                    return Vec::new();
                };
                if jsv::lower(s).contains(&term) {
                    hit = true;
                    break;
                }
            }
            if hit {
                out.push(af);
            }
        }
        out
    }

    /// `getAudioFileStats()`.
    pub fn get_audio_file_stats(&mut self) -> Value {
        let all = self.get_all_audio_files();
        let mut total_size = 0.0;
        let mut total_duration = 0.0;
        let mut formats = Obj::new();
        for f in &all {
            total_size += f
                .get("size")
                .filter(|v| jsv::truthy(v))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            total_duration += f
                .get("duration")
                .filter(|v| jsv::truthy(v))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let fmt = jsv::to_js_string(&jsv::or(f.get("format"), json!("unknown")));
            let n = formats.get(&fmt).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
            formats.insert(fmt, js::number(n));
        }
        let n = all.len() as f64;
        json!({
            "totalFiles": all.len(),
            "totalSize": js::number(total_size),
            "totalDuration": js::number(total_duration),
            "formats": formats,
            "averageDuration": js::number(if n > 0.0 { total_duration / n } else { 0.0 }),
            "averageSize": js::number(if n > 0.0 { total_size / n } else { 0.0 }),
        })
    }
}
