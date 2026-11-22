//! Drives the Rust core's data layer through an op script, as `rust/scripts/drive-data.js`
//! drives the original; `rust/scripts/diff-data.js` runs both and compares (ADR-015, B1).
//!
//! Usage: drive-data <dataDir> <ops.json> <outDir> <fixturesDir>

use std::path::Path;
use std::process::Command;

use accompaniment::core::audio_files::AudioFileManager;
use accompaniment::core::bundle;
use accompaniment::core::clock::Clock;
use accompaniment::core::config::AppConfigManager;
use accompaniment::core::cue_engine::CueManager;
use accompaniment::core::cue_fakes::{FakeEngine, FakeWs, Log};
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
    /// B3: the cue engine on fakes (`cue_fakes`), as `drive-data.js` runs the original.
    cm: Option<CueManager>,
    engine_log: Log,
    ws_log: Log,
    script: std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>,
    rng_values: std::sync::Arc<std::sync::Mutex<(Vec<f64>, usize)>>,
    seen_engine: usize,
    seen_ws: usize,
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

    fn fake_engine(&mut self) -> Option<&mut FakeEngine> {
        self.cm
            .as_mut()?
            .engine
            .as_any_mut()
            .downcast_mut::<FakeEngine>()
    }

    /// B3 ops: the cue engine, its fake engine and the fake clock.
    fn run_cue_engine(&mut self, op: &str, a: &[Value]) -> Option<Option<Value>> {
        let id = |i: usize| s(a, i);
        let opt = |i: usize| arg(a, i).cloned().unwrap_or_else(|| json!({}));
        if op == "cm.init" {
            let clock = Clock::fake(1_700_000_000_000.0);
            let shared = clock.shared()?;
            let engine = FakeEngine::new(
                self.engine_log.clone(),
                self.script.clone(),
                Box::new(move || shared.lock().map_or(f64::NAN, |t| *t)),
            );
            let ws = FakeWs {
                log: self.ws_log.clone(),
            };
            let pm = self.pm.clone()?;
            let mut cm = CueManager::new(
                self.afm.take()?,
                self.cdm.take()?,
                Box::new(ws),
                Box::new(engine),
                &pm.pcm_cache_dir,
                clock,
            );
            let values: Vec<f64> = match arg(a, 0) {
                Some(Value::Array(v)) => v.iter().filter_map(Value::as_f64).collect(),
                _ => vec![0.42, 0.13, 0.87, 0.55, 0.07, 0.99, 0.31, 0.66, 0.2, 0.75],
            };
            if let Ok(mut r) = self.rng_values.lock() {
                *r = (values, 0);
            }
            let rng = self.rng_values.clone();
            cm.rng = Box::new(move || {
                let Ok(mut r) = rng.lock() else { return 0.0 };
                if r.0.is_empty() {
                    return 0.0;
                }
                let v = r.0[r.1 % r.0.len()];
                r.1 += 1;
                v
            });
            cm.set_config(Value::Object(self.config.as_ref()?.get_config()));
            let r = cm.initialize();
            self.cm = Some(cm);
            return Some(match r {
                Ok(()) => None,
                Err(e) => Some(err(e)),
            });
        }
        if !(op.starts_with("cm.") || op.starts_with("engine.") || op.starts_with("clock.")) {
            return None;
        }
        if op == "engine.script" {
            if let Ok(mut sc) = self.script.lock() {
                sc.push((s(a, 0), arg(a, 1).cloned().unwrap_or(Value::Null)));
            }
            return Some(Some(json!(true)));
        }
        if op == "cm.rng" {
            let values: Vec<f64> = arg(a, 0)
                .and_then(Value::as_array)
                .map(|v| v.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            if let Ok(mut r) = self.rng_values.lock() {
                *r = (values, 0);
            }
            return Some(Some(json!(true)));
        }
        match op {
            "engine.end" => {
                let reason = arg(a, 1).cloned().unwrap_or_else(js::undefined);
                self.fake_engine()?.end(&id(0), &reason);
                self.cm.as_mut()?.pump_engine_events();
                return Some(None);
            }
            "engine.advance" => {
                let token = arg(a, 1).cloned();
                self.fake_engine()?.advance(&id(0), token.as_ref());
                self.cm.as_mut()?.pump_engine_events();
                return Some(None);
            }
            "engine.error" => {
                let payload = arg(a, 0).cloned().unwrap_or(Value::Null);
                self.fake_engine()?.error(payload);
                self.cm.as_mut()?.pump_engine_events();
                return Some(None);
            }
            _ => {}
        }
        // Staged uploads need `self` before the cue manager is borrowed.
        let staged: Vec<(String, String)> = match op {
            "cm.audioReplace" => {
                let name = s(a, 2);
                vec![(self.stage(&s(a, 1), Some(&name)), name)]
            }
            "cm.importProject" => arg(a, 1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|pair| {
                    let from = pair.get(0).map(jsv::to_js_string).unwrap_or_default();
                    let name = pair.get(1).map(jsv::to_js_string).unwrap_or_default();
                    (self.stage(&from, Some(&name)), name)
                })
                .collect(),
            _ => Vec::new(),
        };
        let config = self.config.as_mut()?;
        let cm = self.cm.as_mut()?;
        let v = match op {
            "cm.trigger" => cm.trigger_cue(&id(0), &opt(1)),
            "cm.toggle" => cm.toggle_cue(&id(0), &opt(1)),
            "cm.play" => cm.play_cue(&id(0), &opt(1)),
            "cm.doublePress" => {
                let first = cm.trigger_cue(&id(0), &opt(1));
                let second = cm.trigger_cue(&id(0), &opt(1));
                json!([first, second])
            }
            "cm.stop" => cm.stop_cue(&id(0), jsv::truthy_opt(arg(a, 1))),
            "cm.stopAll" => cm.stop_all(arg(a, 0).filter(|v| !js::is_undefined(v))),
            "cm.togglePause" => cm.toggle_pause_cue(&id(0)),
            "cm.navigate" => cm.navigate_playlist(&id(0), arg(a, 1).unwrap_or(&js::undefined())),
            "cm.jump" => cm.jump_to_playlist_item(&id(0), arg(a, 1).unwrap_or(&js::undefined())),
            "cm.create" => cm.create_cue(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.update" => cm.update_cue(&id(0), arg(a, 1).unwrap_or(&js::undefined())),
            "cm.delete" => cm.delete_cue(&id(0)),
            "cm.reorder" => cm.reorder_cues(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.crossfade" => cm.set_crossfade_mode(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.masterVolume" => cm.set_master_volume(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.applyConfig" => {
                let prev = cm.get_config().clone();
                let r = config.update_config(arg(a, 0).unwrap_or(&js::undefined()));
                if r.get("success") != Some(&json!(true)) {
                    r
                } else {
                    let r = cm.apply_config(&prev, Value::Object(config.get_config()));
                    cm.run_deferred();
                    r
                }
            }
            "cm.newProject" => cm.new_project(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.openProject" => cm.open_project(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.renameProject" => cm.rename_project(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.deleteProject" => cm.delete_project(arg(a, 0).unwrap_or(&js::undefined())),
            "cm.listProjects" => cm.list_projects(),
            "cm.currentProject" => cm.get_current_project(),
            "cm.getCues" => Value::Array(cm.get_cues()),
            "cm.getCue" => cm.get_cue(&id(0)).unwrap_or(Value::Null),
            "cm.status" => cm.get_playback_status(),
            "cm.flush" => cm.flush_persist_workspace(),
            "cm.cleanup" => {
                cm.cleanup();
                return Some(None);
            }
            "cm.audioReplace" => {
                let (path, name) = staged.first()?.clone();
                let r =
                    cm.afm
                        .replace_file(arg(a, 0).unwrap_or(&js::undefined()), &path, Some(&name));
                if r.get("success") != Some(&json!(true)) {
                    r
                } else {
                    let af = r.get("audioFile").cloned().unwrap_or(Value::Null);
                    let prev = r.get("previous").cloned().unwrap_or_else(|| json!({}));
                    cm.handle_audio_file_replaced(&af, &prev)
                }
            }
            "cm.importProject" => cm.import_project(arg(a, 0).unwrap_or(&json!({})), &staged),
            "clock.advance" => {
                cm.advance_clock(arg(a, 0).and_then(Value::as_f64).unwrap_or(0.0));
                return Some(None);
            }
            _ => err(format!("unknown op {op}")),
        };
        Some(Some(v))
    }

    /// What the cue manager did and holds after an op (B3).
    fn cue_engine_state(&mut self) -> String {
        let Some(cm) = self.cm.as_ref() else {
            return String::new();
        };
        let mut out = String::from("--- engine\n");
        if let Ok(l) = self.engine_log.lock() {
            for e in &l[self.seen_engine..] {
                out.push_str(&jsv::stringify(e));
                out.push('\n');
            }
            self.seen_engine = l.len();
        }
        out.push_str("--- ws\n");
        if let Ok(l) = self.ws_log.lock() {
            for e in &l[self.seen_ws..] {
                out.push_str(&jsv::stringify(e));
                out.push('\n');
            }
            self.seen_ws = l.len();
        }
        out.push_str("--- state\n");
        out.push_str(&jsv::stringify(&cm.debug_state()));
        out.push('\n');
        out
    }

    fn run(&mut self, op: &str, a: &[Value]) -> Option<Value> {
        if let Some(r) = self.run_cue_engine(op, a) {
            return r;
        }
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
        cm: None,
        engine_log: Log::default(),
        ws_log: Log::default(),
        script: Default::default(),
        rng_values: Default::default(),
        seen_engine: 0,
        seen_ws: 0,
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
        let state = d.cue_engine_state();
        print!("### {i} {name}\n{text}\n{state}{}", dump(&d.data));
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
}
