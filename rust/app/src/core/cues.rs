//! Port of `src/backend/cueDataManager.js`.
//!
//! In the original the open project's `cues` and `this.cues` are the same array object, so an
//! edit through either shows in both. Here the open project is kept without its cues: its
//! `"cues"` key is a placeholder that always reads `self.cues` (`current_workspace()`).

use std::collections::HashMap;

use serde_json::{Value, json};

use super::audio_files::AudioFileManager;
use super::cue_aliases;
use super::id_validation;
use super::jsv::{self, Obj};
use super::library;
use super::nodefs::{self as nfs, NResult};
use super::output_patch;
use super::paths::PathManager;
use crate::js;

const BACKUPS_PER_PROJECT: usize = 20;

/// `isHiddenCue(cue)`: a Spotify cue (ADR-003).
pub fn is_hidden_cue(cue: &Value) -> bool {
    jsv::truthy(cue) && cue.get("type").and_then(Value::as_str) == Some("spotify")
}

/// `normalizeCueFieldAliases(data)` (Wave A port, `rust/cue-aliases`).
pub fn normalize_aliases(data: &Value) -> Value {
    cue_aliases::normalize_cue_field_aliases(data.clone()).unwrap_or_else(|_| data.clone())
}

/// `normalizeOutputPatch(patch)` (Wave A port, `rust/output-patch`); `None` is `undefined`.
fn output_patch(patch: Option<&Value>) -> Value {
    let arg = patch.cloned().unwrap_or_else(js::undefined);
    let out = output_patch::normalize_output_patch(arg, None).unwrap_or_else(|_| vec![0.0, 1.0]);
    Value::Array(out.into_iter().map(js::number).collect())
}

fn default_layout() -> Value {
    json!({ "gridColumns": 4, "gridRows": 4, "cuePositions": {} })
}

/// A JS `Map` key for a JSON value.
fn key(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), jsv::stringify)
}

fn null_prop_error(prop: &str) -> String {
    format!("Cannot read properties of null (reading '{prop}')")
}

/// The object view of a value whose properties the original reads (`undefined` for primitives).
fn props(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

struct HiddenCue {
    cue: Value,
    after: Vec<Option<Value>>,
}

pub struct CueDataManager {
    pm: PathManager,
    pub workspaces_dir: String,
    pub backups_dir: String,
    pub templates_dir: String,
    current: Option<Obj>,
    pub cues: Vec<Value>,
    hidden: HashMap<String, Vec<HiddenCue>>,
}

impl CueDataManager {
    pub fn new(pm: &PathManager) -> Self {
        let m = CueDataManager {
            pm: pm.clone(),
            workspaces_dir: nfs::join2(&pm.cues_dir, "workspaces"),
            backups_dir: nfs::join2(&pm.cues_dir, "backups"),
            templates_dir: nfs::join2(&pm.cues_dir, "templates"),
            current: None,
            cues: Vec::new(),
            hidden: HashMap::new(),
        };
        let _ = nfs::ensure_dir(&m.workspaces_dir);
        let _ = nfs::ensure_dir(&m.backups_dir);
        let _ = nfs::ensure_dir(&m.templates_dir);
        m
    }

    /// `createCue(cueData)`.
    pub fn create_cue(&self, cue_data: &Value) -> Result<Value, String> {
        let data = normalize_aliases(cue_data);
        if data.is_null() {
            return Err(null_prop_error("id"));
        }
        let d = props(&data);
        let now = jsv::iso_now();
        let mut cue = Obj::new();
        cue.insert("id".into(), jsv::or(d.get("id"), json!(jsv::random_uuid())));
        cue.insert("name".into(), jsv::or(d.get("name"), json!("New Cue")));
        cue.insert("type".into(), jsv::or(d.get("type"), json!("single_file")));
        cue.insert("status".into(), json!("stopped"));
        cue.insert("currentTime".into(), json!(0));
        cue.insert("totalTime".into(), json!(0));
        cue.insert("volume".into(), jsv::or(d.get("volume"), json!(1)));
        cue.insert("fadeInTime".into(), jsv::or(d.get("fadeInTime"), json!(0)));
        cue.insert(
            "fadeOutTime".into(),
            jsv::or(d.get("fadeOutTime"), json!(0)),
        );
        cue.insert("loop".into(), jsv::or(d.get("loop"), json!(false)));
        cue.insert(
            "retriggerBehavior".into(),
            jsv::or(d.get("retriggerBehavior"), json!("restart")),
        );
        cue.insert(
            "trimStartTime".into(),
            jsv::or(d.get("trimStartTime"), json!(0)),
        );
        cue.insert(
            "trimEndTime".into(),
            jsv::or(d.get("trimEndTime"), Value::Null),
        );
        cue.insert(
            "isDuckingTrigger".into(),
            jsv::or(d.get("isDuckingTrigger"), json!(false)),
        );
        cue.insert(
            "enableDucking".into(),
            jsv::or(d.get("enableDucking"), json!(false)),
        );
        cue.insert(
            "duckingLevel".into(),
            jsv::or(d.get("duckingLevel"), json!(80)),
        );
        cue.insert("outputPatch".into(), output_patch(d.get("outputPatch")));
        cue.insert("createdAt".into(), json!(now));
        cue.insert("updatedAt".into(), json!(now));
        jsv::spread(&mut cue, &data);
        match cue.get("type").and_then(Value::as_str) {
            Some("single_file") => {
                cue.insert("filePath".into(), jsv::or(d.get("filePath"), json!("")));
                cue.insert(
                    "relativePath".into(),
                    jsv::or(d.get("relativePath"), json!("")),
                );
                cue.insert(
                    "knownDuration".into(),
                    jsv::or(d.get("knownDuration"), json!(0)),
                );
            }
            Some("playlist") => {
                cue.insert(
                    "playlistItems".into(),
                    jsv::or(d.get("playlistItems"), json!([])),
                );
                cue.insert("currentPlaylistIndex".into(), json!(0));
                cue.insert(
                    "shufflePlaylist".into(),
                    jsv::or(d.get("shufflePlaylist"), json!(false)),
                );
                cue.insert(
                    "repeatOnePlaylistItem".into(),
                    jsv::or(d.get("repeatOnePlaylistItem"), json!(false)),
                );
                cue.insert(
                    "playlistPlayMode".into(),
                    jsv::or(d.get("playlistPlayMode"), json!("continue")),
                );
            }
            _ => {}
        }
        Ok(Value::Object(cue))
    }

    /// `addCue(cue)`.
    pub fn add_cue(&mut self, cue: Value) -> Value {
        self.cues.push(cue.clone());
        cue
    }

    fn index_of(&self, cue_id: &Value) -> Option<usize> {
        self.cues.iter().position(|c| c.get("id") == Some(cue_id))
    }

    /// `updateCue(cueId, updates)`.
    pub fn update_cue(&mut self, cue_id: &Value, updates: &Value) -> Result<Value, String> {
        let Some(i) = self.index_of(cue_id) else {
            return Ok(json!({ "success": false, "error": "Cue not found" }));
        };
        let previous = self.cues[i].clone();
        let normalized = normalize_aliases(updates);
        let mut merged = props(&previous);
        jsv::spread(&mut merged, &normalized);
        merged.insert("updatedAt".into(), json!(jsv::iso_now()));
        let cue = keep_own_file_when_becoming_playlist(&props(&previous), merged);
        let mut cue = move_trim_on_type_change(&props(&previous), cue, &normalized)?;
        keep_playlist_index_in_range(&mut cue);
        self.cues[i] = Value::Object(cue);
        Ok(json!({ "success": true, "cue": self.cues[i] }))
    }

    /// `reorderCues(orderedIds)`.
    pub fn reorder_cues(&mut self, ordered_ids: &Value) -> Value {
        let Value::Array(ids) = ordered_ids else {
            return json!({ "success": false, "error": "cueIds must be an array" });
        };
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for c in &self.cues {
            by_id.insert(key(c.get("id")), c.clone());
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut reordered = Vec::new();
        for id in ids {
            let k = key(Some(id));
            if let Some(c) = by_id.get(&k)
                && !seen.contains(&k)
            {
                reordered.push(c.clone());
                seen.insert(k);
            }
        }
        for c in &self.cues {
            if !seen.contains(&key(c.get("id"))) {
                reordered.push(c.clone());
            }
        }
        self.cues = reordered;
        let order: Vec<Value> = self
            .cues
            .iter()
            .map(|c| c.get("id").cloned().unwrap_or(Value::Null))
            .collect();
        json!({ "success": true, "order": order })
    }

    /// `rewriteAudioReferences(mapRef)`: the open project in memory, every other one on disk.
    pub fn rewrite_audio_references(&mut self, map_ref: &mut library::MapRef) -> Value {
        let current_id = self
            .current
            .as_ref()
            .and_then(|c| c.get("id"))
            .map(jsv::to_js_string);
        let mut arr = Value::Array(std::mem::take(&mut self.cues));
        let cues_updated = library::rewrite_cue_references(Some(&mut arr), map_ref);
        if let Value::Array(a) = arr {
            self.cues = a;
        }
        let mut projects_updated = usize::from(cues_updated > 0);
        let skip = format!("{}.json", current_id.unwrap_or_else(|| "undefined".into()));
        for file in nfs::readdir(&self.workspaces_dir).unwrap_or_default() {
            if !file.ends_with(".json") || file == skip {
                continue;
            }
            let fp = nfs::join2(&self.workspaces_dir, &file);
            if let Ok(mut ws) = nfs::read_json(&fp)
                && library::rewrite_cue_references(ws.get_mut("cues"), map_ref) > 0
                && nfs::write_json_atomic(&fp, &ws).is_ok()
            {
                projects_updated += 1;
            }
        }
        json!({ "cuesUpdated": cues_updated, "projectsUpdated": projects_updated })
    }

    /// `deleteCue(cueId)`.
    pub fn delete_cue(&mut self, cue_id: &Value) -> Value {
        let Some(i) = self.index_of(cue_id) else {
            return json!({ "success": false, "error": "Cue not found" });
        };
        let deleted = self.cues.remove(i);
        json!({ "success": true, "cue": deleted })
    }

    pub fn get_cue(&self, cue_id: &Value) -> Option<&Value> {
        self.cues.iter().find(|c| c.get("id") == Some(cue_id))
    }

    pub fn get_cues(&self) -> Vec<Value> {
        self.cues.clone()
    }

    /// `_takeHiddenCues(workspaceId, cues)`.
    fn take_hidden_cues(&mut self, workspace_id: &Value, cues: Option<&Value>) -> Vec<Value> {
        let list: &[Value] = match cues {
            Some(Value::Array(a)) => a,
            _ => &[],
        };
        let mut hidden = Vec::new();
        let mut visible: Vec<Value> = Vec::new();
        for cue in list {
            if is_hidden_cue(cue) {
                hidden.push(HiddenCue {
                    cue: cue.clone(),
                    after: visible.iter().rev().map(|c| c.get("id").cloned()).collect(),
                });
            } else {
                visible.push(cue.clone());
            }
        }
        let k = key(Some(workspace_id));
        if hidden.is_empty() {
            self.hidden.remove(&k);
        } else {
            self.hidden.insert(k, hidden);
        }
        visible
    }

    /// `withHiddenCues(workspace)`.
    pub fn with_hidden_cues(&self, workspace: &Obj) -> Obj {
        let Some(hidden) = self.hidden.get(&key(workspace.get("id"))) else {
            return workspace.clone();
        };
        let visible: Vec<Value> = match workspace.get("cues") {
            Some(Value::Array(a)) => a.clone(),
            Some(v) if jsv::truthy(v) => Vec::new(),
            _ => Vec::new(),
        };
        let ids: Vec<Option<Value>> = visible.iter().map(|c| c.get("id").cloned()).collect();
        let mut by_anchor: Vec<(Option<Value>, Vec<Value>)> = Vec::new();
        for h in hidden {
            // `after.find(id => ids.has(id)) ?? null`: an undefined id counts as no anchor.
            let anchor = h
                .after
                .iter()
                .find(|id| ids.contains(id))
                .cloned()
                .flatten();
            match by_anchor.iter_mut().find(|(a, _)| *a == anchor) {
                Some((_, list)) => list.push(h.cue.clone()),
                None => by_anchor.push((anchor, vec![h.cue.clone()])),
            }
        }
        let after = |id: Option<&Value>| -> Vec<Value> {
            by_anchor
                .iter()
                .find(|(a, _)| a.as_ref() == id)
                .map(|(_, l)| l.clone())
                .unwrap_or_default()
        };
        let mut cues = after(None);
        for cue in &visible {
            cues.push(cue.clone());
            if let Some(id) = cue.get("id") {
                cues.extend(after(Some(id)));
            }
        }
        let mut out = workspace.clone();
        out.insert("cues".into(), Value::Array(cues));
        out
    }

    /// `cleanupOrphanWorkspaceFiles()`.
    pub fn cleanup_orphan_workspace_files(&self) -> Value {
        let files = match nfs::readdir(&self.workspaces_dir) {
            Ok(f) => f,
            Err(e) => return json!({ "removed": 0, "error": e.message }),
        };
        let mut removed = 0;
        for file in files {
            if !file.ends_with(".json") {
                continue;
            }
            let wp = nfs::join2(&self.workspaces_dir, &file);
            let should_remove = (|| -> Result<bool, ()> {
                let st = nfs::stat(&wp).map_err(|_| ())?;
                if st.size == 0 {
                    return Ok(true);
                }
                let bytes = nfs::read_file(&wp).map_err(|_| ())?;
                let text = String::from_utf8_lossy(&bytes);
                if text.trim_matches(jsv::is_js_space).is_empty() {
                    return Ok(true);
                }
                let parsed = jsv::parse_str(&text).map_err(|_| ())?;
                Ok(!jsv::truthy(&parsed) || !jsv::truthy_opt(parsed.get("id")))
            })();
            if let Ok(true) = should_remove
                && nfs::remove(&wp).is_ok()
            {
                removed += 1;
            }
        }
        json!({ "removed": removed })
    }

    /// The open project as the original holds it (`getCurrentWorkspace()`), cues included.
    pub fn current_workspace(&self) -> Option<Value> {
        let mut ws = self.current.clone()?;
        if ws.contains_key("cues") {
            ws.insert("cues".into(), Value::Array(self.cues.clone()));
        }
        Some(Value::Object(ws))
    }

    pub fn current_id(&self) -> Option<Value> {
        self.current.as_ref().and_then(|c| c.get("id").cloned())
    }

    /// Makes `ws` the open project, its cues becoming `self.cues` (the shared array).
    fn set_current_shared(&mut self, mut ws: Obj) {
        self.cues = match ws.get("cues") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        };
        ws.insert("cues".into(), Value::Null);
        self.current = Some(ws);
    }

    /// `setCurrentWorkspace(workspace)`.
    pub fn set_current_workspace(&mut self, workspace: Option<&Value>) {
        match workspace.and_then(Value::as_object) {
            Some(ws) if ws.contains_key("cues") && jsv::truthy_opt(ws.get("cues")) => {
                self.set_current_shared(ws.clone());
            }
            Some(ws) => {
                self.current = Some(ws.clone());
                self.cues = Vec::new();
            }
            None => {
                self.current = None;
                self.cues = Vec::new();
            }
        }
    }

    /// `getCurrentWorkspace().name = name` (the cue manager's `renameProject`).
    pub fn set_current_name(&mut self, name: Value) {
        if let Some(ws) = self.current.as_mut() {
            ws.insert("name".into(), name);
        }
    }

    /// `clearCurrentWorkspace()`.
    pub fn clear_current_workspace(&mut self) {
        self.current = None;
        self.cues = Vec::new();
    }

    fn validate_all(&self, cues: Vec<Value>) -> Result<Vec<Value>, String> {
        cues.iter().map(validate_cue).collect()
    }

    /// `createWorkspace(name, description = '', options = {})`.
    pub fn create_workspace(
        &mut self,
        name: Option<&Value>,
        description: Option<&Value>,
        options: &Value,
    ) -> NResult<Value> {
        let o = props(options);
        let set_as_current = o.get("setAsCurrent").is_none_or(jsv::truthy);
        let id = json!(jsv::random_uuid());
        let now = jsv::iso_now();
        let mut ws = Obj::new();
        ws.insert("id".into(), id.clone());
        ws.insert("name".into(), jsv::or(name, json!("New Workspace")));
        if let Some(d) = description.or(Some(&json!(""))) {
            ws.insert("description".into(), d.clone());
        }
        ws.insert("cues".into(), json!([]));
        ws.insert("layout".into(), jsv::or(o.get("layout"), default_layout()));
        ws.insert("createdAt".into(), json!(now));
        ws.insert("updatedAt".into(), json!(now));
        let visible = self.take_hidden_cues(&id, o.get("cues"));
        let cues = self.validate_all(visible).map_err(nfs::plain)?;
        ws.insert("cues".into(), Value::Array(cues));
        let path = nfs::join2(
            &self.workspaces_dir,
            &format!("{}.json", jsv::to_js_string(&id)),
        );
        nfs::write_json_atomic(&path, &Value::Object(self.with_hidden_cues(&ws)))?;
        if set_as_current {
            self.set_current_shared(ws.clone());
        }
        Ok(Value::Object(ws))
    }

    fn write_workspace_to_disk(&self, ws: &Obj) -> NResult<String> {
        let id = ws
            .get("id")
            .map(jsv::to_js_string)
            .unwrap_or_else(|| "undefined".into());
        let path = nfs::join2(&self.workspaces_dir, &format!("{id}.json"));
        if nfs::path_exists(&path) {
            self.create_backup(&path);
        }
        nfs::write_json_atomic(&path, &Value::Object(self.with_hidden_cues(ws)))?;
        Ok(path)
    }

    /// `saveWorkspace(name = null, description = null)`.
    pub fn save_workspace(&mut self, name: Option<&Value>, description: Option<&Value>) -> Value {
        let Some(cur) = self
            .current
            .clone()
            .filter(|c| jsv::truthy_opt(c.get("id")))
        else {
            return json!({ "success": false, "error": "No active workspace to save" });
        };
        let now = jsv::iso_now();
        let mut ws = Obj::new();
        ws.insert("id".into(), cur.get("id").cloned().unwrap_or(Value::Null));
        let fallback = jsv::or(cur.get("name"), json!("Current Workspace"));
        ws.insert("name".into(), jsv::or(name, fallback));
        // `workspaceDescription ?? current.description ?? ''`
        let desc = description
            .filter(|v| !v.is_null())
            .or(cur.get("description").filter(|v| !v.is_null()))
            .cloned()
            .unwrap_or(json!(""));
        ws.insert("description".into(), desc);
        ws.insert("cues".into(), Value::Array(self.cues.clone()));
        ws.insert(
            "layout".into(),
            jsv::or(cur.get("layout"), default_layout()),
        );
        ws.insert(
            "createdAt".into(),
            jsv::or(cur.get("createdAt"), json!(now)),
        );
        ws.insert("updatedAt".into(), json!(now));
        match self.write_workspace_to_disk(&ws) {
            Ok(_) => {
                self.set_current_shared(ws.clone());
                json!({ "success": true, "workspace": ws })
            }
            Err(e) => json!({ "success": false, "error": e.message }),
        }
    }

    /// `readWorkspace(workspaceId)`.
    pub fn read_workspace(&mut self, workspace_id: &Value) -> Value {
        if !workspace_id.as_str().is_some_and(id_validation::is_uuid) {
            return json!({ "success": false, "error": "Invalid workspaceId: must be a UUID" });
        }
        let id = jsv::to_js_string(workspace_id);
        let path = nfs::join2(&self.workspaces_dir, &format!("{id}.json"));
        if !nfs::path_exists(&path) {
            return json!({ "success": false, "error": "Workspace not found" });
        }
        let bytes = match nfs::read_file(&path) {
            Ok(b) => b,
            Err(e) => return json!({ "success": false, "error": e.message }),
        };
        let text = String::from_utf8_lossy(&bytes);
        if text.trim_matches(jsv::is_js_space).is_empty() {
            return json!({ "success": false, "error": "Workspace file is empty" });
        }
        let mut ws = match jsv::parse_str(&text) {
            Ok(v) => v,
            Err(e) => return json!({ "success": false, "error": e }),
        };
        match &mut ws {
            Value::Null => {
                return json!({ "success": false, "error": "Cannot set properties of null (setting 'cues')" });
            }
            Value::Object(o) => {
                let visible = self.take_hidden_cues(workspace_id, o.get("cues"));
                match self.validate_all(visible) {
                    Ok(cues) => {
                        o.insert("cues".into(), Value::Array(cues));
                    }
                    Err(e) => return json!({ "success": false, "error": e }),
                }
            }
            _ => {
                // Assigning a property to a primitive is ignored (sloppy mode).
                self.take_hidden_cues(workspace_id, None);
            }
        }
        json!({ "success": true, "workspace": ws })
    }

    /// `updateWorkspaceById(workspaceId, updates)`.
    pub fn update_workspace_by_id(
        &mut self,
        workspace_id: &Value,
        updates: &Value,
    ) -> Result<Value, String> {
        let read = self.read_workspace(workspace_id);
        if read.get("success") != Some(&json!(true)) {
            return Ok(read);
        }
        let mut ws = read.get("workspace").map(props).unwrap_or_default();
        jsv::spread(&mut ws, updates);
        ws.insert("id".into(), workspace_id.clone());
        ws.insert("updatedAt".into(), json!(jsv::iso_now()));
        if let Some(c) = updates.get("cues").filter(|c| jsv::truthy(c)) {
            let Value::Array(list) = c else {
                return Err("updates.cues.filter is not a function".into());
            };
            // Spotify cues can't be added this way (ADR-003).
            let kept: Vec<Value> = list.iter().filter(|c| !is_hidden_cue(c)).cloned().collect();
            ws.insert("cues".into(), Value::Array(self.validate_all(kept)?));
        }
        self.write_workspace_to_disk(&ws).map_err(String::from)?;
        if self.current_id().as_ref() == Some(workspace_id) {
            self.set_current_shared(ws.clone());
        }
        Ok(json!({ "success": true, "workspace": ws }))
    }

    /// `loadWorkspace(workspaceId)`.
    pub fn load_workspace(&mut self, workspace_id: &Value) -> Value {
        let read = self.read_workspace(workspace_id);
        if read.get("success") != Some(&json!(true)) {
            return read;
        }
        let ws = read.get("workspace").cloned().unwrap_or(Value::Null);
        match &ws {
            Value::Object(o) => self.set_current_shared(o.clone()),
            _ => {
                self.current = None;
                self.cues = Vec::new();
            }
        }
        json!({ "success": true, "workspace": ws })
    }

    /// `getAllWorkspaces({ includeCues })`.
    pub fn get_all_workspaces(&self, include_cues: bool) -> Vec<Value> {
        let Ok(files) = nfs::readdir(&self.workspaces_dir) else {
            return Vec::new();
        };
        let mut list: Vec<(f64, Value)> = Vec::new();
        for file in files {
            if !file.ends_with(".json") {
                continue;
            }
            let wp = nfs::join2(&self.workspaces_dir, &file);
            let result = (|| -> Result<Option<(f64, Value)>, ()> {
                let bytes = nfs::read_file(&wp).map_err(|_| ())?;
                let text = String::from_utf8_lossy(&bytes);
                if text.trim_matches(jsv::is_js_space).is_empty() {
                    return Ok(None);
                }
                let parsed = jsv::parse_str(&text).map_err(|_| ())?;
                if parsed.is_null() {
                    return Err(());
                }
                if !jsv::truthy_opt(parsed.get("id")) {
                    return Ok(None);
                }
                let Value::Object(mut ws) = parsed else {
                    return Ok(None);
                };
                let cues: Vec<Value> = match ws.get("cues") {
                    Some(Value::Array(a)) => {
                        a.iter().filter(|c| !is_hidden_cue(c)).cloned().collect()
                    }
                    _ => Vec::new(),
                };
                if include_cues {
                    ws.insert("cues".into(), Value::Array(cues));
                } else {
                    ws.insert("cueCount".into(), json!(cues.len()));
                    ws.shift_remove("cues");
                }
                let st = nfs::stat(&wp).map_err(|_| ())?;
                ws.insert("filePath".into(), json!(wp));
                ws.insert("fileSize".into(), json!(st.size));
                ws.insert("lastModified".into(), nfs::date_json(st.mtime_ms));
                Ok(Some((st.mtime_ms.trunc(), Value::Object(ws))))
            })();
            match result {
                Ok(Some(entry)) => list.push(entry),
                Ok(None) => {}
                Err(()) => {
                    let backup = nfs::join2(
                        &self.backups_dir,
                        &format!("corrupted_{}_{file}", jsv::now_ms() as u64),
                    );
                    let _ = nfs::copy(&wp, &backup);
                }
            }
        }
        js::sort(&mut list, |a, b| b.0 - a.0);
        list.into_iter().map(|(_, w)| w).collect()
    }

    /// `deleteWorkspace(workspaceId)`.
    pub fn delete_workspace(&mut self, workspace_id: &Value) -> Value {
        if !workspace_id.as_str().is_some_and(id_validation::is_uuid) {
            return json!({ "success": false, "error": "Invalid workspaceId: must be a UUID" });
        }
        let id = jsv::to_js_string(workspace_id);
        let path = nfs::join2(&self.workspaces_dir, &format!("{id}.json"));
        if !nfs::path_exists(&path) {
            return json!({ "success": false, "error": "Workspace not found" });
        }
        self.create_backup(&path);
        if let Err(e) = nfs::remove(&path) {
            return json!({ "success": false, "error": e.message });
        }
        self.hidden.remove(&key(Some(workspace_id)));
        if self.current_id().as_ref() == Some(workspace_id) {
            self.clear_current_workspace();
        }
        json!({ "success": true })
    }

    /// `createBackup(filePath)`: errors are only logged.
    pub fn create_backup(&self, file_path: &str) {
        let ts = jsv::iso_now().replace([':', '.'], "-");
        let name = nfs::basename(file_path, None);
        let backup = nfs::join2(&self.backups_dir, &format!("{ts}_{name}"));
        if nfs::copy(file_path, &backup).is_ok() {
            self.prune_backups(&name);
        }
    }

    fn prune_backups(&self, file_name: &str) {
        let suffix = format!("_{file_name}");
        let mut backups: Vec<String> = nfs::readdir(&self.backups_dir)
            .unwrap_or_default()
            .into_iter()
            .filter(|f| f.ends_with(&suffix))
            .collect();
        backups.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let excess = backups.len().saturating_sub(BACKUPS_PER_PROJECT);
        for old in &backups[..excess] {
            let _ = nfs::remove(&nfs::join2(&self.backups_dir, old));
        }
    }

    /// `exportWorkspace(workspaceId, exportPath, includeAudioFiles, audioFileManager)`.
    pub fn export_workspace(
        &mut self,
        workspace_id: &Value,
        export_path: &str,
        include_audio_files: &Value,
        audio_files: Option<&mut AudioFileManager>,
    ) -> Value {
        let read = self.read_workspace(workspace_id);
        if read.get("success") != Some(&json!(true)) {
            return read;
        }
        let ws = read.get("workspace").map(props).unwrap_or_default();
        let mut data = self.with_hidden_cues(&ws);
        data.insert("exportedAt".into(), json!(jsv::iso_now()));
        data.insert("includeAudioFiles".into(), include_audio_files.clone());
        let mut copied = 0;
        let include = jsv::truthy(include_audio_files);
        if include && let Some(afm) = audio_files {
            let mut rels: Vec<String> = Vec::new();
            let mut add = |r: Option<&Value>| {
                if let Some(s) = r.filter(|v| jsv::truthy(v)).map(jsv::to_js_string)
                    && !rels.contains(&s)
                {
                    rels.push(s);
                }
            };
            if let Some(Value::Array(cues)) = data.get("cues") {
                for cue in cues {
                    match cue.get("type").and_then(Value::as_str) {
                        Some("single_file") => add(cue.get("relativePath")),
                        Some("playlist") => {
                            if let Some(Value::Array(items)) = cue.get("playlistItems") {
                                for item in items {
                                    add(item.get("relativePath"));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            let audio_dir = nfs::join2(
                &nfs::dirname(export_path),
                &format!("{}_audio", nfs::basename(export_path, Some(".json"))),
            );
            for rel in rels {
                let Some(af) = afm.get_audio_file_by_path(&rel) else {
                    continue;
                };
                let Some(src) = af.get("path").and_then(Value::as_str) else {
                    continue;
                };
                if !nfs::path_exists(src) {
                    continue;
                }
                let dest = nfs::join2(&audio_dir, &rel);
                if nfs::ensure_dir(&nfs::dirname(&dest)).is_ok() && nfs::copy(src, &dest).is_ok() {
                    copied += 1;
                }
            }
            if copied > 0 {
                data.insert("audioFilesDir".into(), json!(audio_dir));
            }
        }
        if let Err(e) = nfs::write_json_atomic(export_path, &Value::Object(data)) {
            return json!({ "success": false, "error": e.message });
        }
        let mut out = json!({ "success": true, "exportPath": export_path });
        if include {
            out["audioFilesCopied"] = json!(copied);
        }
        out
    }

    /// `importWorkspace(importPath)`.
    pub fn import_workspace(&mut self, import_path: &str) -> Value {
        let Some(resolved) = self.pm.resolve_within_data_dir(import_path) else {
            return json!({ "success": false, "error": "Import path must be within application data directory" });
        };
        let mut ws = match nfs::read_json(&resolved) {
            Ok(Value::Object(o)) => o,
            Ok(Value::Null) => {
                return json!({ "success": false, "error": "Cannot read properties of null (reading 'name')" });
            }
            Ok(_) => return json!({ "success": false, "error": "Invalid workspace format" }),
            Err(e) => return json!({ "success": false, "error": e.message }),
        };
        if !jsv::truthy_opt(ws.get("name")) || !matches!(ws.get("cues"), Some(Value::Array(_))) {
            return json!({ "success": false, "error": "Invalid workspace format" });
        }
        let id = json!(jsv::random_uuid());
        ws.insert("id".into(), id.clone());
        ws.insert("importedAt".into(), json!(jsv::iso_now()));
        let visible = self.take_hidden_cues(&id, ws.get("cues"));
        match self.validate_all(visible) {
            Ok(c) => {
                ws.insert("cues".into(), Value::Array(c));
            }
            Err(e) => return json!({ "success": false, "error": e }),
        }
        let path = nfs::join2(
            &self.workspaces_dir,
            &format!("{}.json", jsv::to_js_string(&id)),
        );
        if let Err(e) = nfs::write_json_atomic(&path, &Value::Object(self.with_hidden_cues(&ws))) {
            return json!({ "success": false, "error": e.message });
        }
        json!({ "success": true, "workspace": ws })
    }
}

/// `validateCue(cue)`.
pub fn validate_cue(cue: &Value) -> Result<Value, String> {
    let cue = normalize_aliases(cue);
    if cue.is_null() {
        return Err(null_prop_error("id"));
    }
    let c = props(&cue);
    let now = jsv::iso_now();
    let num_or = |k: &str, d: Value| match c.get(k) {
        Some(v @ Value::Number(_)) => v.clone(),
        _ => d,
    };
    let bool_of = |k: &str| json!(jsv::truthy_opt(c.get(k)));
    let mut v = Obj::new();
    v.insert("id".into(), jsv::or(c.get("id"), json!(jsv::random_uuid())));
    v.insert("name".into(), jsv::or(c.get("name"), json!("Unnamed Cue")));
    v.insert("type".into(), jsv::or(c.get("type"), json!("single_file")));
    v.insert("status".into(), jsv::or(c.get("status"), json!("stopped")));
    v.insert(
        "currentTime".into(),
        jsv::or(c.get("currentTime"), json!(0)),
    );
    v.insert("totalTime".into(), jsv::or(c.get("totalTime"), json!(0)));
    v.insert("volume".into(), num_or("volume", json!(1)));
    v.insert("fadeInTime".into(), num_or("fadeInTime", json!(0)));
    v.insert("fadeOutTime".into(), num_or("fadeOutTime", json!(0)));
    v.insert("loop".into(), bool_of("loop"));
    v.insert(
        "retriggerBehavior".into(),
        jsv::or(c.get("retriggerBehavior"), json!("restart")),
    );
    v.insert("trimStartTime".into(), num_or("trimStartTime", json!(0)));
    v.insert(
        "trimEndTime".into(),
        jsv::or(c.get("trimEndTime"), Value::Null),
    );
    v.insert("isDuckingTrigger".into(), bool_of("isDuckingTrigger"));
    v.insert("enableDucking".into(), bool_of("enableDucking"));
    v.insert("duckingLevel".into(), num_or("duckingLevel", json!(80)));
    v.insert("outputPatch".into(), output_patch(c.get("outputPatch")));
    v.insert("createdAt".into(), jsv::or(c.get("createdAt"), json!(now)));
    v.insert("updatedAt".into(), jsv::or(c.get("updatedAt"), json!(now)));
    jsv::spread(&mut v, &cue);
    match v.get("type").and_then(Value::as_str) {
        Some("single_file") => {
            let fp = jsv::or(v.get("filePath"), json!(""));
            v.insert("filePath".into(), fp);
            let rp = jsv::or(v.get("relativePath"), json!(""));
            v.insert("relativePath".into(), rp);
            let kd = match v.get("knownDuration") {
                Some(n @ Value::Number(_)) => n.clone(),
                _ => json!(0),
            };
            v.insert("knownDuration".into(), kd);
        }
        Some("playlist") => {
            let items = match v.get("playlistItems") {
                Some(a @ Value::Array(_)) => a.clone(),
                _ => json!([]),
            };
            v.insert("playlistItems".into(), items);
            let idx = match v.get("currentPlaylistIndex") {
                Some(n @ Value::Number(_)) => n.clone(),
                _ => json!(0),
            };
            v.insert("currentPlaylistIndex".into(), idx);
            keep_playlist_index_in_range(&mut v);
            let sh = json!(jsv::truthy_opt(v.get("shufflePlaylist")));
            v.insert("shufflePlaylist".into(), sh);
            let ro = json!(jsv::truthy_opt(v.get("repeatOnePlaylistItem")));
            v.insert("repeatOnePlaylistItem".into(), ro);
            let pm = jsv::or(v.get("playlistPlayMode"), json!("continue"));
            v.insert("playlistPlayMode".into(), pm);
        }
        _ => {}
    }
    Ok(Value::Object(v))
}

/// `keepPlaylistIndexInRange(cue)` (WO-022): an index outside the items starts over at 0.
fn keep_playlist_index_in_range(cue: &mut Obj) {
    if cue.get("type").and_then(Value::as_str) != Some("playlist") {
        return;
    }
    let Some(Value::Array(items)) = cue.get("playlistItems") else {
        return;
    };
    let len = items.len() as f64;
    if let Some(i) = cue.get("currentPlaylistIndex").and_then(Value::as_f64)
        && (i < 0.0 || i >= len)
    {
        cue.insert("currentPlaylistIndex".into(), json!(0));
    }
}

/// `keepOwnFileWhenBecomingPlaylist(previous, cue)`.
fn keep_own_file_when_becoming_playlist(previous: &Obj, cue: Obj) -> Obj {
    let ty = |o: &Obj| o.get("type").and_then(Value::as_str).map(str::to_string);
    if ty(&cue).as_deref() != Some("playlist")
        || ty(previous).as_deref() == Some("playlist")
        || !jsv::truthy_opt(previous.get("audioFileId"))
    {
        return cue;
    }
    let items: Vec<Value> = match cue.get("playlistItems") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let own_id = previous.get("audioFileId");
    if items
        .iter()
        .any(|i| jsv::truthy(i) && i.get("audioFileId") == own_id)
    {
        return cue;
    }
    let mut own = Obj::new();
    own.insert("id".into(), json!(jsv::random_uuid()));
    for (k, from) in [
        ("name", "name"),
        ("path", "relativePath"),
        ("relativePath", "relativePath"),
        ("audioFileId", "audioFileId"),
    ] {
        if let Some(v) = previous.get(from) {
            own.insert(k.into(), v.clone());
        }
    }
    own.insert("volume".into(), json!(1));
    own.insert("fadeInTime".into(), json!(0));
    own.insert("fadeOutTime".into(), json!(0));
    own.insert(
        "trimStartTime".into(),
        jsv::or(previous.get("trimStartTime"), json!(0)),
    );
    own.insert(
        "trimEndTime".into(),
        jsv::or(previous.get("trimEndTime"), json!(0)),
    );
    own.insert(
        "knownDuration".into(),
        jsv::or(previous.get("knownDuration"), json!(0)),
    );
    let mut out = cue;
    let mut list = vec![Value::Object(own)];
    list.extend(items);
    out.insert("playlistItems".into(), Value::Array(list));
    out
}

/// `moveTrimOnTypeChange(previous, cue, updates)` (WO-003).
fn move_trim_on_type_change(previous: &Obj, cue: Obj, updates: &Value) -> Result<Obj, String> {
    let ty = |o: &Obj| o.get("type").and_then(Value::as_str).map(str::to_string);
    let is_pl = ty(&cue).as_deref() == Some("playlist");
    let was_pl = ty(previous).as_deref() == Some("playlist");
    if is_pl && !was_pl {
        let mut out = cue;
        out.insert("trimStartTime".into(), json!(0));
        out.insert("trimEndTime".into(), Value::Null);
        return Ok(out);
    }
    if !is_pl && was_pl {
        let has = |k: &str| -> Result<bool, String> {
            match updates {
                Value::Object(o) => Ok(o.contains_key(k)),
                Value::Array(a) => Ok(k.parse::<usize>().is_ok_and(|i| i < a.len())),
                Value::String(_) | Value::Number(_) | Value::Bool(_) => Err(format!(
                    "Cannot use 'in' operator to search for '{k}' in {}",
                    jsv::to_js_string(updates)
                )),
                Value::Null => Err(format!(
                    "Cannot use 'in' operator to search for '{k}' in null"
                )),
            }
        };
        if !has("trimStartTime")? && !has("trimEndTime")? {
            let items: &[Value] = match previous.get("playlistItems") {
                Some(Value::Array(a)) => a,
                _ => &[],
            };
            let cue_file = cue.get("audioFileId");
            if let Some(item) = items
                .iter()
                .find(|i| jsv::truthy(i) && i.get("audioFileId") == cue_file)
            {
                let mut out = cue;
                out.insert(
                    "trimStartTime".into(),
                    jsv::or(item.get("trimStartTime"), json!(0)),
                );
                out.insert(
                    "trimEndTime".into(),
                    jsv::or(item.get("trimEndTime"), Value::Null),
                );
                return Ok(out);
            }
        }
    }
    Ok(cue)
}
