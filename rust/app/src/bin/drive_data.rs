//! Drives the Rust core's data layer through an op script, as `rust/scripts/drive-data.js`
//! drives the original; `rust/scripts/diff-data.js` runs both and compares (ADR-015, B1).
//!
//! Usage: drive-data <dataDir> <ops.json> <outDir> <fixturesDir>

use std::path::Path;
use std::process::Command;

use accompaniment::core::audio_files::AudioFileManager;
use accompaniment::core::bundle;
use accompaniment::core::config::AppConfigManager;
use accompaniment::core::cues::CueDataManager;
use accompaniment::core::jsv::{self, Obj};
use accompaniment::core::library;
use accompaniment::core::nodefs as nfs;
use accompaniment::core::paths::PathManager;
use accompaniment::js;
use serde_json::{Value, json};

struct Drive {
    data: String,
    out: String,
    fixtures: String,
    pm: Option<PathManager>,
    config: Option<AppConfigManager>,
    afm: Option<AudioFileManager>,
    cdm: Option<CueDataManager>,
    upload_n: u32,
}

/// A missing argument is JS `undefined`.
fn arg(args: &[Value], i: usize) -> Option<&Value> {
    args.get(i)
}

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .map(jsv::to_js_string)
        .unwrap_or_else(|| "undefined".into())
}

fn obj_or_null(o: Option<Obj>) -> Value {
    o.map_or(Value::Null, Value::Object)
}

fn err(e: impl std::fmt::Display) -> Value {
    json!({ "$error": e.to_string() })
}

impl Drive {
    fn stage(&mut self, from: &str, name: Option<&str>) -> String {
        self.upload_n += 1;
        let dir = nfs::join(&[&self.data, "temp", "uploads"]);
        let _ = nfs::ensure_dir(&dir);
        let ext = nfs::extname(name.unwrap_or(from)).to_lowercase();
        let target = nfs::join2(&dir, &format!("upload-{}{ext}", self.upload_n));
        let _ = std::fs::copy(Path::new(&self.fixtures).join(from), &target);
        target
    }

    fn run(&mut self, op: &str, a: &[Value]) -> Option<Value> {
        if op == "init" {
            let pm = PathManager::new(&self.data);
            let mut config = AppConfigManager::new(&pm);
            let cfg = config.load_config();
            self.afm = Some(AudioFileManager::new(&pm));
            self.cdm = Some(CueDataManager::new(&pm));
            self.config = Some(config);
            self.pm = Some(pm);
            return Some(Value::Object(cfg));
        }
        let early = match op {
            "probe" => Some({
                let p = Path::new(&self.fixtures).join(s(a, 0));
                match accompaniment::core::probe::parse_file(
                    &p.to_string_lossy(),
                    jsv::truthy_opt(arg(a, 1)),
                ) {
                    Ok(r) => {
                        let mut o = Obj::new();
                        let mut num = |k: &str, v: Option<f64>| {
                            if let Some(v) = v {
                                o.insert(k.into(), js::number(v));
                            }
                        };
                        num("duration", r.duration);
                        num("bitrate", r.bitrate);
                        num("sampleRate", r.sample_rate);
                        num("numberOfChannels", r.channels);
                        for (k, v) in [("title", r.title), ("artist", r.artist), ("album", r.album)]
                        {
                            if let Some(v) = v {
                                o.insert(k.into(), json!(v));
                            }
                        }
                        Value::Object(o)
                    }
                    Err(e) => err(e),
                }
            }),
            "fs.zipOut" => Some({
                let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/make-zip.js");
                let entries = arg(a, 1).map(jsv::stringify).unwrap_or_default();
                let ok = Command::new("node")
                    .arg(script)
                    .arg(nfs::join2(&self.out, &s(a, 0)))
                    .arg(entries)
                    .status()
                    .is_ok_and(|st| st.success());
                json!(ok)
            }),
            "fs.writeOut" => Some({
                let _ = std::fs::write(nfs::join2(&self.out, &s(a, 0)), s(a, 1));
                json!(true)
            }),
            "fs.write" => Some({
                let p = nfs::join2(&self.data, &s(a, 0));
                let _ = nfs::ensure_dir(&nfs::dirname(&p));
                let _ = std::fs::write(&p, s(a, 1));
                json!(true)
            }),
            _ => None,
        };
        if let Some(v) = early {
            return Some(v);
        }
        let (Some(pm), Some(config), Some(afm), Some(cdm)) = (
            self.pm.clone(),
            self.config.as_mut(),
            self.afm.as_mut(),
            self.cdm.as_mut(),
        ) else {
            return Some(err("Cannot read properties of undefined"));
        };
        let v = match op {
            "paths.validateFile" => pm.validate_file(&s(a, 0)),
            "paths.getAudioFiles" => Value::Array(
                pm.get_audio_files(&pm.audio_dir)
                    .into_iter()
                    .map(|f| {
                        json!({
                            "name": f.name, "path": f.path, "relativePath": f.relative_path,
                            "size": f.size, "modified": nfs::date_json(f.modified_ms), "extension": f.extension,
                        })
                    })
                    .collect(),
            ),
            "paths.getFileInfo" => match pm.get_file_info(&s(a, 0)) {
                Some(fi) => json!({
                    "path": fi.path, "relativePath": fi.relative_path, "name": fi.name, "size": fi.size,
                    "created": nfs::date_json(fi.created_ms), "modified": nfs::date_json(fi.modified_ms),
                    "extension": fi.extension,
                }),
                None => Value::Null,
            },
            "config.get" => Value::Object(config.get_config()),
            "config.load" => Value::Object(config.load_config()),
            "config.update" => config.update_config(arg(a, 0).unwrap_or(&Value::Null)),
            "config.reset" => Value::Object(config.reset_to_defaults()),
            "config.addRecent" => json!(config.add_recent_workspace(arg(a, 0).unwrap_or(&Value::Null))),
            "config.removeRecent" => json!(config.remove_recent_workspace(arg(a, 0).unwrap_or(&Value::Null))),
            "config.validate" => {
                let c = arg(a, 0).and_then(Value::as_object).cloned().unwrap_or_default();
                let errors = AppConfigManager::validate_config(&c);
                json!({ "valid": errors.is_empty(), "errors": errors })
            }
            "config.listeningPort" => config.get_listening_port(),
            "library.migrate" => {
                let metadata = pm.metadata_dir();
                let workspaces = nfs::join2(&pm.cues_dir, "workspaces");
                let backups = nfs::join2(&pm.cues_dir, "backups");
                let dirs = library::MigrateDirs {
                    audio_dir: &pm.audio_dir,
                    metadata_dir: &metadata,
                    workspaces_dir: &workspaces,
                    backups_dir: &backups,
                    pcm_cache_dir: Some(&pm.pcm_cache_dir),
                };
                library::migrate_library(&dirs).unwrap_or_else(err)
            }
            "library.hashFile" => library::hash_file(&nfs::join2(&self.data, &s(a, 0))).map_or_else(err, |h| json!(h)),
            "library.findExistingName" => json!(library::find_existing_name(&pm.audio_dir, &s(a, 0))),
            "cues.create" => cdm.create_cue(arg(a, 0).unwrap_or(&js::undefined())).unwrap_or_else(err),
            "cues.add" => match cdm.create_cue(arg(a, 0).unwrap_or(&js::undefined())) {
                Ok(c) => cdm.add_cue(c),
                Err(e) => err(e),
            },
            "cues.update" => cdm
                .update_cue(arg(a, 0).unwrap_or(&Value::Null), arg(a, 1).unwrap_or(&js::undefined()))
                .unwrap_or_else(err),
            "cues.delete" => cdm.delete_cue(arg(a, 0).unwrap_or(&Value::Null)),
            "cues.reorder" => cdm.reorder_cues(arg(a, 0).unwrap_or(&Value::Null)),
            "cues.get" => cdm.get_cue(arg(a, 0).unwrap_or(&Value::Null)).cloned().unwrap_or(Value::Null),
            "cues.getAll" => Value::Array(cdm.get_cues()),
            "cues.current" => cdm.current_workspace().unwrap_or(Value::Null),
            "cues.createWorkspace" => cdm
                .create_workspace(arg(a, 0), arg(a, 1), arg(a, 2).unwrap_or(&json!({})))
                .unwrap_or_else(err),
            "cues.save" => cdm.save_workspace(arg(a, 0), arg(a, 1)),
            "cues.read" => cdm.read_workspace(arg(a, 0).unwrap_or(&js::undefined())),
            "cues.updateById" => cdm
                .update_workspace_by_id(arg(a, 0).unwrap_or(&js::undefined()), arg(a, 1).unwrap_or(&json!({})))
                .unwrap_or_else(err),
            "cues.load" => cdm.load_workspace(arg(a, 0).unwrap_or(&js::undefined())),
            "cues.list" => Value::Array(cdm.get_all_workspaces(jsv::truthy_opt(arg(a, 0)))),
            "cues.deleteWorkspace" => cdm.delete_workspace(arg(a, 0).unwrap_or(&js::undefined())),
            "cues.export" => {
                let file = nfs::join2(&pm.cues_dir, &s(a, 1));
                cdm.export_workspace(arg(a, 0).unwrap_or(&js::undefined()), &file, arg(a, 2).unwrap_or(&js::undefined()), Some(afm))
            }
            "cues.import" => cdm.import_workspace(&s(a, 0)),
            "cues.cleanupOrphans" => cdm.cleanup_orphan_workspace_files(),
            "cues.rewriteRefs" => {
                let by_id = arg(a, 0).and_then(Value::as_object).cloned().unwrap_or_default();
                cdm.rewrite_audio_references(&mut |aid, _rel| {
                    let k = aid.map(jsv::to_js_string).unwrap_or_else(|| "undefined".into());
                    by_id.get(&k).filter(|v| jsv::truthy(v)).and_then(Value::as_object).cloned()
                })
            }
            "audio.upload" => {
                let name = arg(a, 1).and_then(Value::as_str).map(str::to_string);
                let staged = self.stage(&s(a, 0), name.as_deref());
                let afm = self.afm.as_mut()?;
                afm.add_file(&staged, name.as_deref(), arg(a, 2).unwrap_or(&json!({})))
            }
            "audio.import" => afm.import_audio_file(&s(a, 0), arg(a, 1).unwrap_or(&json!({}))),
            "audio.replace" => {
                let name = arg(a, 2).and_then(Value::as_str).map(str::to_string);
                let staged = self.stage(&s(a, 1), name.as_deref());
                let afm = self.afm.as_mut()?;
                afm.replace_file(arg(a, 0).unwrap_or(&js::undefined()), &staged, name.as_deref())
            }
            "audio.validate" => afm.validate_audio_file(&s(a, 0)),
            "audio.getAll" => Value::Array(afm.get_all_audio_files().into_iter().map(Value::Object).collect()),
            "audio.byPath" => obj_or_null(afm.get_audio_file_by_path(&s(a, 0))),
            "audio.load" => obj_or_null(afm.load_audio_file_metadata(arg(a, 0).unwrap_or(&js::undefined()))),
            "audio.delete" => afm.delete_audio_file(arg(a, 0).unwrap_or(&js::undefined())),
            "audio.update" => afm.update_audio_file_metadata(arg(a, 0).unwrap_or(&js::undefined()), arg(a, 1).unwrap_or(&js::undefined())),
            "audio.search" => Value::Array(afm.search_audio_files(arg(a, 0).unwrap_or(&js::undefined())).into_iter().map(Value::Object).collect()),
            "audio.stats" => afm.get_audio_file_stats(),
            "audio.invalidateIndex" => {
                afm.invalidate_metadata_index();
                return None;
            }
            "bundle.write" => {
                let wid = if s(a, 0) == "current" { cdm.current_id() } else { arg(a, 0).cloned() };
                let read = cdm.read_workspace(&wid.unwrap_or_else(js::undefined));
                if read.get("success") != Some(&json!(true)) {
                    return Some(read);
                }
                let ws = read.get("workspace").and_then(Value::as_object).cloned().unwrap_or_default();
                let project = cdm.with_hidden_cues(&ws);
                let out = nfs::join2(&self.out, &s(a, 1));
                bundle::write_bundle(&project, &out, &mut |r| {
                    let by_id = r
                        .get("audioFileId")
                        .filter(|v| jsv::truthy(v))
                        .and_then(|id| afm.load_audio_file_metadata(id));
                    by_id.or_else(|| {
                        r.get("relativePath")
                            .filter(|v| jsv::truthy(v))
                            .and_then(|p| afm.get_audio_file_by_path(&jsv::to_js_string(p)))
                    })
                })
                .unwrap_or_else(err)
            }
            "bundle.read" => {
                let dir = nfs::join(&[&self.data, "temp", "imports", &s(a, 1)]);
                bundle::read_bundle(&nfs::join2(&self.out, &s(a, 0)), &dir).unwrap_or_else(err)
            }
            _ => err(format!("unknown op {op}")),
        };
        Some(v)
    }
}

fn dump(data: &str) -> String {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/dump-data.js");
    Command::new("node")
        .arg(script)
        .arg(data)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let [data, ops_file, out, fixtures] = &argv[..] else {
        eprintln!("usage: drive-data <dataDir> <ops.json> <outDir> <fixturesDir>");
        std::process::exit(2);
    };
    let ops = std::fs::read(ops_file)
        .ok()
        .and_then(|b| jsv::parse(&b).ok())
        .unwrap_or(Value::Null);
    let mut d = Drive {
        data: data.clone(),
        out: out.clone(),
        fixtures: fixtures.clone(),
        pm: None,
        config: None,
        afm: None,
        cdm: None,
        upload_n: 0,
    };
    let Value::Array(ops) = ops else {
        eprintln!("ops must be a JSON array");
        std::process::exit(2);
    };
    for (i, op) in ops.iter().enumerate() {
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        let args: Vec<Value> = op
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let text = match d.run(name, &args) {
            Some(v) => jsv::stringify(&v),
            None => "undefined".into(),
        };
        print!("### {i} {name}\n{text}\n{}", dump(&d.data));
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
}
