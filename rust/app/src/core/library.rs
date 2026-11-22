//! Port of the I/O half of `src/backend/mediaLibrary.js`. The naming rules are the Wave A port
//! (`rust/media-library-names`, included as `core::media_names`).

use std::collections::{HashMap, HashSet};
use std::io::Read;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::jsv::{self, Obj};
use super::media_names;
use super::nodefs::{self as nfs, NResult};
use crate::js;

pub const LIBRARY_VERSION: i64 = 2;

fn units_to_string(v: &Value) -> String {
    js::string_units(v).map_or_else(String::new, |u| String::from_utf16_lossy(&u))
}

/// `sanitizeFilename(name)` for a string name.
pub fn sanitize_filename(name: &str) -> String {
    media_names::sanitize_filename(name.to_string())
        .map_or_else(|_| String::new(), |v| units_to_string(&v))
}

/// `withCopyNumber(name, n)`.
pub fn with_copy_number(name: &str, n: u32) -> String {
    media_names::with_copy_number(name.to_string(), f64::from(n))
        .unwrap_or_else(|_| name.to_string())
}

/// `cleanLegacyName(name)`.
pub fn clean_legacy_name(name: &str) -> String {
    media_names::clean_legacy_name(name.to_string()).unwrap_or_else(|_| name.to_string())
}

/// `isSupportedAudio(name)`.
pub fn is_supported_audio(name: &str) -> bool {
    media_names::is_supported_audio(name.to_string()).unwrap_or(false)
}

/// `hashFile(path)`: sha256, lower-case hex.
pub fn hash_file(p: &str) -> NResult<String> {
    let mut f = std::fs::File::open(p).map_err(|e| nfs::err(&e, "open", p))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| nfs::err(&e, "read", p))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// `findExistingName(dir, name)`: the on-disk name matching regardless of case.
pub fn find_existing_name(dir: &str, name: &str) -> Option<String> {
    let entries = nfs::readdir(dir).unwrap_or_default();
    let wanted = jsv::lower(name);
    entries.into_iter().find(|e| jsv::lower(e) == wanted)
}

/// `mapRef({ audioFileId, relativePath })`: the fields to assign, or `None` to leave a reference.
pub type MapRef<'a> = dyn FnMut(Option<&Value>, Option<&Value>) -> Option<Obj> + 'a;

/// `rewriteCueReferences(cues, mapRef)`: `map_ref(audioFileId, relativePath)` returns the fields
/// to assign, or `None`. Returns how many references changed.
pub fn rewrite_cue_references(cues: Option<&mut Value>, map_ref: &mut MapRef) -> usize {
    let mut changed = 0;
    let mut apply = |r: &mut Obj| {
        let Some(update) = map_ref(r.get("audioFileId"), r.get("relativePath")) else {
            return;
        };
        for (k, v) in update {
            r.insert(k, v);
        }
        r.shift_remove("filePath");
        changed += 1;
    };
    let Some(Value::Array(cues)) = cues else {
        return 0;
    };
    for cue in cues.iter_mut() {
        let Value::Object(c) = cue else { continue };
        match c.get("type").and_then(Value::as_str) {
            Some("playlist") => {
                if let Some(Value::Array(items)) = c.get_mut("playlistItems") {
                    for item in items.iter_mut() {
                        if let Value::Object(i) = item {
                            apply(i);
                        }
                    }
                }
            }
            // Kept in the file unchanged, never played (ADR-003).
            Some("spotify") => {}
            _ => {
                if jsv::truthy_opt(c.get("audioFileId")) || jsv::truthy_opt(c.get("relativePath")) {
                    apply(c);
                }
            }
        }
    }
    changed
}

/// `readJsonFiles(dir)`: `{ file, data }` for every parsable `.json` file.
pub fn read_json_files(dir: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for file in nfs::readdir(dir).unwrap_or_default() {
        if !file.ends_with(".json") {
            continue;
        }
        let full = nfs::join2(dir, &file);
        if let Ok(data) = nfs::read_json(&full) {
            out.push((full, data));
        }
    }
    out
}

fn remove_empty_dirs(dir: &str, keep: &[&str]) -> NResult<()> {
    for entry in nfs::readdir_types(dir).unwrap_or_default() {
        if !entry.is_dir || keep.contains(&entry.name.as_str()) {
            continue;
        }
        let sub = nfs::join2(dir, &entry.name);
        remove_empty_dirs(&sub, &[])?;
        let remaining: Vec<String> = nfs::readdir(&sub)?
            .into_iter()
            .filter(|f| f != ".DS_Store")
            .collect();
        if remaining.is_empty() {
            nfs::remove(&sub)?;
        }
    }
    Ok(())
}

/// The key a JS `Map` would use for a JSON value (strings and numbers kept apart).
fn key(v: &Value) -> String {
    jsv::stringify(v)
}

pub struct MigrateDirs<'a> {
    pub audio_dir: &'a str,
    pub metadata_dir: &'a str,
    pub workspaces_dir: &'a str,
    pub backups_dir: &'a str,
    pub pcm_cache_dir: Option<&'a str>,
}

struct LibFile {
    path: String,
    name: String,
    mtime_ms: f64,
    size: u64,
    hash: String,
}

/// `migrateLibrary(...)`.
pub fn migrate_library(d: &MigrateDirs) -> NResult<Value> {
    let marker_path = nfs::join2(d.audio_dir, "library.json");
    // fs.readJson strips a leading BOM.
    let marker = nfs::read_file(&marker_path).ok().and_then(|b| {
        let text = String::from_utf8_lossy(&b);
        jsv::parse_str(text.strip_prefix('\u{FEFF}').unwrap_or(&text)).ok()
    });
    if let Some(Value::Object(m)) = &marker
        && m.get("version")
            .is_some_and(|v| jsv::to_number(v) >= LIBRARY_VERSION as f64)
    {
        return Ok(json!({ "migrated": false }));
    }

    nfs::ensure_dir(d.audio_dir)?;
    nfs::ensure_dir(d.metadata_dir)?;

    let mut files: Vec<LibFile> = Vec::new();
    fn walk(dir: &str, metadata_dir: &str, files: &mut Vec<LibFile>) -> NResult<()> {
        for entry in nfs::readdir_types(dir).unwrap_or_default() {
            let full = nfs::join2(dir, &entry.name);
            if entry.is_dir {
                if full != metadata_dir {
                    walk(&full, metadata_dir, files)?;
                }
            } else if entry.is_file && is_supported_audio(&entry.name) {
                let st = nfs::stat(&full)?;
                files.push(LibFile {
                    path: full,
                    name: entry.name,
                    mtime_ms: st.mtime_ms,
                    size: st.size,
                    hash: String::new(),
                });
            }
        }
        Ok(())
    }
    walk(d.audio_dir, d.metadata_dir, &mut files)?;

    if files.is_empty() {
        nfs::write_json_atomic(
            &marker_path,
            &json!({ "version": LIBRARY_VERSION, "migratedAt": jsv::iso_now(), "files": 0 }),
        )?;
        return Ok(json!({ "migrated": true, "files": 0, "unique": 0, "removed": 0 }));
    }

    let backup_dir = nfs::join2(
        d.backups_dir,
        &format!(
            "library-migration-{}",
            jsv::iso_now().replace([':', '.'], "-")
        ),
    );
    nfs::ensure_dir(&backup_dir)?;
    let _ = nfs::copy(d.metadata_dir, &nfs::join2(&backup_dir, "metadata"));
    let _ = nfs::copy(d.workspaces_dir, &nfs::join2(&backup_dir, "workspaces"));

    for f in &mut files {
        f.hash = hash_file(&f.path)?;
    }

    js::sort(&mut files, |a, b| a.mtime_ms - b.mtime_ms);
    let mut group_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        let group = groups.entry(f.hash.clone()).or_insert_with(|| {
            group_order.push(f.hash.clone());
            Vec::new()
        });
        group.push(i);
    }

    let records = read_json_files(d.metadata_dir);
    let mut records_by_path: HashMap<String, Vec<Value>> = HashMap::new();
    for (_, data) in &records {
        if !jsv::truthy_opt(data.get("id")) {
            continue;
        }
        let rel = data
            .get("relativePath")
            .filter(|v| jsv::truthy(v))
            .map(|v| nfs::normalize(&jsv::to_js_string(v)));
        let abs = match (rel, data.get("path").filter(|v| jsv::truthy(v))) {
            (Some(rel), _) => Some(nfs::resolve(&[d.audio_dir, &rel])),
            (None, Some(p)) => Some(nfs::resolve1(&jsv::to_js_string(p))),
            _ => None,
        };
        if let Some(abs) = abs {
            records_by_path.entry(abs).or_default().push(data.clone());
        }
    }

    let staging = nfs::join2(d.audio_dir, ".migrating");
    nfs::ensure_dir(&staging)?;

    let mut taken: HashSet<String> = HashSet::new();
    let mut id_map: HashMap<String, Value> = HashMap::new();
    let mut path_map: HashMap<String, String> = HashMap::new();
    let mut new_records: Vec<Obj> = Vec::new();
    let mut mapping: Vec<Value> = Vec::new();
    let mut removed = 0;

    for hash in &group_order {
        let group = &groups[hash];
        let first = &files[group[0]];
        let clean = clean_legacy_name(&sanitize_filename(&first.name));
        let mut name = clean.clone();
        let mut n = 2;
        while taken.contains(&jsv::lower(&name)) {
            name = with_copy_number(&clean_legacy_name(&sanitize_filename(&first.name)), n);
            n += 1;
        }
        taken.insert(jsv::lower(&name));

        let group_records: Vec<Value> = group
            .iter()
            .flat_map(|&i| {
                records_by_path
                    .get(&nfs::resolve1(&files[i].path))
                    .cloned()
                    .unwrap_or_default()
            })
            .collect();
        let base: Obj = group_records
            .iter()
            .find(|r| jsv::truthy_opt(r.get("duration")))
            .or(group_records.first())
            .and_then(|r| r.as_object().cloned())
            .unwrap_or_default();
        let id = jsv::or(base.get("id"), Value::String(jsv::random_uuid()));

        nfs::move_path(&first.path, &nfs::join2(&staging, &name), false)?;
        for &i in &group[1..] {
            nfs::remove(&files[i].path)?;
            removed += 1;
        }
        for r in &group_records {
            if let Some(rid) = r.get("id") {
                id_map.insert(key(rid), id.clone());
            }
        }
        for &i in group {
            path_map.insert(nfs::relative(d.audio_dir, &files[i].path), name.clone());
        }

        let mut rec = base.clone();
        rec.insert("id".into(), id.clone());
        rec.insert("path".into(), json!(nfs::join2(d.audio_dir, &name)));
        rec.insert("relativePath".into(), json!(name));
        rec.insert("filename".into(), json!(name));
        rec.insert(
            "name".into(),
            json!(nfs::basename(&name, Some(&nfs::extname(&name)))),
        );
        rec.insert("size".into(), json!(first.size));
        rec.insert("hash".into(), json!(hash));
        new_records.push(rec);
        mapping.push(json!({
            "file": name,
            "hash": hash,
            "id": id,
            "from": group.iter().map(|&i| nfs::relative(d.audio_dir, &files[i].path)).collect::<Vec<_>>(),
            "mergedIds": group_records.iter().map(|r| r.get("id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
        }));
    }

    for name in nfs::readdir(&staging)? {
        nfs::move_path(
            &nfs::join2(&staging, &name),
            &nfs::join2(d.audio_dir, &name),
            true,
        )?;
    }
    nfs::remove(&staging)?;

    for (file, data) in &records {
        if let Some(rid) = data.get("id").filter(|v| jsv::truthy(v))
            && id_map.contains_key(&key(rid))
        {
            nfs::remove(file)?;
        }
    }
    for rec in &new_records {
        let id = rec.get("id").map(jsv::to_js_string).unwrap_or_default();
        nfs::write_json_atomic(
            &nfs::join2(d.metadata_dir, &format!("{id}.json")),
            &Value::Object(rec.clone()),
        )?;
    }

    let mut references_updated = 0;
    for (file, mut data) in read_json_files(d.workspaces_dir) {
        let count = rewrite_cue_references(data.get_mut("cues"), &mut |aid, rel| {
            let by_id = aid
                .filter(|v| jsv::truthy(v))
                .and_then(|v| id_map.get(&key(v)));
            let rel = rel
                .filter(|v| jsv::truthy(v))
                .and_then(|v| path_map.get(&nfs::normalize(&jsv::to_js_string(v))));
            if by_id.is_none() && rel.is_none() {
                return None;
            }
            let record = new_records
                .iter()
                .find(|r| by_id.is_some_and(|b| r.get("id") == Some(b)))
                .or_else(|| {
                    new_records.iter().find(|r| {
                        rel.is_some_and(|p| {
                            r.get("relativePath").and_then(Value::as_str) == Some(p)
                        })
                    })
                })?;
            let mut out = Obj::new();
            out.insert(
                "audioFileId".into(),
                record.get("id").cloned().unwrap_or(Value::Null),
            );
            out.insert(
                "relativePath".into(),
                record.get("relativePath").cloned().unwrap_or(Value::Null),
            );
            Some(out)
        });
        if count > 0 {
            nfs::write_json_atomic(&file, &data)?;
            references_updated += count;
        }
    }

    remove_empty_dirs(d.audio_dir, &[&nfs::basename(d.metadata_dir, None)])?;
    if let Some(pcm) = d.pcm_cache_dir {
        let _ = nfs::empty_dir(pcm);
    }

    let summary = json!({
        "version": LIBRARY_VERSION,
        "migratedAt": jsv::iso_now(),
        "files": files.len(),
        "unique": group_order.len(),
        "removed": removed,
        "referencesUpdated": references_updated,
        "backupDir": backup_dir,
    });
    let mut log = summary.as_object().cloned().unwrap_or_default();
    log.insert("mapping".into(), Value::Array(mapping));
    nfs::write_json_atomic(
        &nfs::join2(&backup_dir, "migration-log.json"),
        &Value::Object(log),
    )?;
    nfs::write_json_atomic(&marker_path, &summary)?;
    let mut result = Obj::new();
    result.insert("migrated".into(), json!(true));
    if let Value::Object(s) = summary {
        for (k, v) in s {
            result.insert(k, v);
        }
    }
    Ok(Value::Object(result))
}
