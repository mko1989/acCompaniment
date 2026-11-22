//! Port of `src/backend/projectBundle.js` (yazl / yauzl -> the `zip` crate).
//!
//! Differences that remain (research/files-and-metadata.md 2.3): entry names that are valid
//! UTF-8 are read as UTF-8 even without the UTF-8 flag (yauzl reads CP437), and CRC-32 is
//! verified (yauzl doesn't), so a damaged bundle Node accepts is refused.

use std::fs::File;
use std::io::{self, Write};

use serde_json::{Value, json};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::jsv::{self, Obj};
use super::library;
use super::nodefs::{self as nfs, NResult};
use crate::js;

pub const BUNDLE_FORMAT: &str = "accompaniment-project";
pub const BUNDLE_VERSION: i64 = 1;
const MAX_ENTRIES: usize = 5000;
const MAX_PROJECT_JSON_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// `audioReferences(cues)`: every reference the project's cues use.
pub fn audio_references(cues: Option<&Value>) -> Vec<Obj> {
    let mut refs = Vec::new();
    let Some(Value::Array(cues)) = cues else {
        return refs;
    };
    for cue in cues {
        match cue.get("type").and_then(Value::as_str) {
            Some("playlist") => {
                if let Some(Value::Array(items)) = cue.get("playlistItems") {
                    refs.extend(items.iter().filter_map(|i| i.as_object().cloned()));
                }
            }
            Some("spotify") => {}
            _ => {
                if jsv::truthy_opt(cue.get("audioFileId"))
                    || jsv::truthy_opt(cue.get("relativePath"))
                {
                    refs.extend(cue.as_object().cloned());
                }
            }
        }
    }
    refs
}

/// `writeBundle(project, output, resolveAudio)` into `output_path`: `{ files, missing }`.
pub fn write_bundle(
    project: &Obj,
    output_path: &str,
    resolve_audio: &mut dyn FnMut(&Obj) -> Option<Obj>,
) -> NResult<Value> {
    let file = File::create(output_path).map_err(|e| nfs::err(&e, "open", output_path))?;
    let mut zip = ZipWriter::new(file);
    let mut added: Vec<String> = Vec::new();
    let mut missing: Vec<Value> = Vec::new();
    let zerr = |e: zip::result::ZipError| nfs::plain(e.to_string());
    for r in audio_references(project.get("cues")) {
        let record = resolve_audio(&r);
        let path = record
            .as_ref()
            .and_then(|rec| rec.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some((rec, path)) = record.zip(path).filter(|(_, p)| nfs::path_exists(p)) else {
            missing.push(jsv::or(
                r.get("relativePath"),
                r.get("audioFileId").cloned().unwrap_or_else(js::undefined),
            ));
            continue;
        };
        let rel = rec
            .get("relativePath")
            .map(jsv::to_js_string)
            .unwrap_or_default();
        let entry = format!("audio/{}", nfs::basename(&rel, None));
        if added.contains(&entry) {
            continue;
        }
        added.push(entry.clone());
        let bytes = nfs::read_file(&path)?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(bytes.len() as u64 >= 0xFFFF_FFFF);
        zip.start_file(entry, options).map_err(zerr)?;
        zip.write_all(&bytes)
            .map_err(|e| nfs::err(&e, "write", output_path))?;
    }
    let mut proj = Obj::new();
    proj.insert(
        "name".into(),
        project.get("name").cloned().unwrap_or_else(js::undefined),
    );
    proj.insert(
        "description".into(),
        jsv::or(project.get("description"), json!("")),
    );
    proj.insert(
        "layout".into(),
        project.get("layout").cloned().unwrap_or_else(js::undefined),
    );
    proj.insert(
        "createdAt".into(),
        project
            .get("createdAt")
            .cloned()
            .unwrap_or_else(js::undefined),
    );
    proj.insert(
        "cues".into(),
        project.get("cues").cloned().unwrap_or_else(js::undefined),
    );
    let manifest = json!({
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "exportedAt": jsv::iso_now(),
        "missingAudio": missing,
        "project": proj,
    });
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    zip.start_file("project.json", options).map_err(zerr)?;
    zip.write_all(jsv::stringify_pretty(&manifest).as_bytes())
        .map_err(|e| nfs::err(&e, "write", output_path))?;
    zip.finish().map_err(zerr)?;
    Ok(json!({ "files": added.len(), "missing": manifest["missingAudio"] }))
}

/// yauzl's `validateFileName`.
fn validate_file_name(name: &str) -> Result<(), String> {
    let b = name.as_bytes();
    if name.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') {
        return Err(format!("absolute path: {name}"));
    }
    if name.split('/').any(|part| part == "..") {
        return Err(format!("invalid relative path: {name}"));
    }
    Ok(())
}

/// `readBundle(zipPath, extractDir)`: `{ project, audio: [{ name, path }], missingAudio }`.
pub fn read_bundle(zip_path: &str, extract_dir: &str) -> Result<Value, String> {
    let file = File::open(zip_path).map_err(|e| {
        format!(
            "Not a project bundle (not a zip file): {}",
            nfs::err(&e, "open", zip_path)
        )
    })?;
    let mut archive = ZipArchive::new(file).map_err(|e| {
        let m = match e {
            zip::result::ZipError::InvalidArchive(_) => {
                "End of central directory record signature not found. Either not a zip file, or file is truncated.".to_string()
            }
            other => other.to_string(),
        };
        format!("Not a project bundle (not a zip file): {m}")
    })?;
    nfs::ensure_dir(extract_dir)?;
    let mut manifest: Option<Value> = None;
    let mut audio: Vec<Value> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.replace('\\', "/");
        validate_file_name(&name)?;
        total = total.saturating_add(entry.size());
        if i + 1 > MAX_ENTRIES || total > MAX_TOTAL_BYTES {
            return Err("Bundle is too large".into());
        }
        if name.ends_with('/') {
            continue;
        }
        if name == "project.json" {
            if entry.size() > MAX_PROJECT_JSON_BYTES {
                return Err("project.json is too large".into());
            }
            let mut buf = Vec::new();
            io::copy(&mut entry, &mut buf).map_err(|e| e.to_string())?;
            manifest = Some(jsv::parse(&buf)?);
        } else if let Some(original) = name
            .strip_prefix("audio/")
            .filter(|rest| !rest.contains('/'))
        {
            let safe = library::sanitize_filename(original);
            if !library::is_supported_audio(&safe) {
                return Err(format!("Unsupported audio file in bundle: {original}"));
            }
            let target = nfs::join2(extract_dir, &format!("{}-{safe}", audio.len()));
            let mut out =
                File::create(&target).map_err(|e| nfs::err(&e, "open", &target).message)?;
            io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            audio.push(json!({ "name": original, "path": target }));
        }
    }
    let valid = manifest.as_ref().is_some_and(|m| {
        m.get("format").and_then(Value::as_str) == Some(BUNDLE_FORMAT)
            && jsv::truthy_opt(m.get("project"))
            && matches!(
                m.get("project").and_then(|p| p.get("cues")),
                Some(Value::Array(_))
            )
    });
    let Some(m) = manifest.filter(|_| valid) else {
        return Err("Not a project bundle (no valid project.json)".into());
    };
    if jsv::gt(m.get("version"), BUNDLE_VERSION as f64) {
        let v = m.get("version").map(jsv::to_js_string).unwrap_or_default();
        return Err(format!(
            "This bundle was made by a newer version of acCompaniment (format {v})"
        ));
    }
    Ok(json!({
        "project": m["project"],
        "audio": audio,
        "missingAudio": jsv::or(m.get("missingAudio"), json!([])),
    }))
}
