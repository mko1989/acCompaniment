//! Port of `src/backend/appConfigManager.js` (the network-interface listing stays with B2).

use serde_json::{Value, json};

use super::jsv::{self, Obj};
use super::nodefs as nfs;
use super::paths::PathManager;

pub type ConfigListener = Box<dyn Fn(&Obj) + Send + Sync>;

pub struct AppConfigManager {
    pub config_path: String,
    pub config: Option<Obj>,
    pub default_config: Obj,
    pub listening_port: Option<u16>,
    listeners: Vec<ConfigListener>,
}

impl AppConfigManager {
    pub fn new(pm: &PathManager) -> Self {
        let default_config = match json!({
            "audioOutputDeviceId": "default",
            "audioOutputChannelCount": 2,
            "audioSampleRate": 48000,
            "audioBufferSize": 512,
            "defaultFadeInTime": 0,
            "defaultFadeOutTime": 0,
            "defaultLoopSingleCue": false,
            "defaultRetriggerBehavior": "restart",
            "defaultStopAllBehavior": "stop",
            "defaultStopAllFadeOutTime": 1500,
            "crossfadeTime": 2000,
            "duckingFadeTime": 1000,
            "theme": "system",
            "windowWidth": 1200,
            "windowHeight": 800,
            "windowX": null,
            "windowY": null,
            "websocketEnabled": true,
            "websocketPort": 8877,
            "httpRemotePort": 3333,
            "audioDirectory": pm.audio_dir,
            "cuesDirectory": pm.cues_dir,
            "autoLoadLastWorkspace": true,
            "lastOpenedWorkspacePath": "",
            "recentWorkspaces": [],
            "maxRecentWorkspaces": 5,
            "enableDebugLogging": false,
            "maxAudioFileSize": 104_857_600,
            "supportedAudioFormats": [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"],
        }) {
            Value::Object(o) => o,
            // INFALLIBLE: the literal above is an object.
            _ => Obj::new(),
        };
        AppConfigManager {
            config_path: nfs::join2(&pm.config_dir, "appConfig.json"),
            config: None,
            default_config,
            listening_port: None,
            listeners: Vec::new(),
        }
    }

    pub fn add_change_listener(&mut self, l: ConfigListener) {
        self.listeners.push(l);
    }

    /// `loadConfig()`.
    pub fn load_config(&mut self) -> Obj {
        if nfs::path_exists(&self.config_path) {
            match nfs::read_json(&self.config_path) {
                Ok(parsed) => {
                    let mut cfg = self.default_config.clone();
                    jsv::spread(&mut cfg, &parsed);
                    if !matches!(cfg.get("recentWorkspaces"), Some(Value::Array(_))) {
                        cfg.insert("recentWorkspaces".into(), json!([]));
                    }
                    self.config = Some(cfg);
                }
                Err(_) => self.config = Some(self.default_config.clone()),
            }
        } else {
            self.config = Some(self.default_config.clone());
            self.save_config();
        }
        self.get_config()
    }

    /// `saveConfig()`.
    pub fn save_config(&mut self) -> bool {
        let Some(cfg) = &self.config else {
            return false;
        };
        if nfs::ensure_dir(&nfs::dirname(&self.config_path)).is_err() {
            return false;
        }
        if nfs::write_json_atomic(&self.config_path, &Value::Object(cfg.clone())).is_err() {
            return false;
        }
        for l in &self.listeners {
            l(cfg);
        }
        true
    }

    /// `getConfig()`: a shallow copy.
    pub fn get_config(&self) -> Obj {
        self.config
            .clone()
            .unwrap_or_else(|| self.default_config.clone())
    }

    /// `updateConfig(updates)`: `{ success, config, error }`.
    pub fn update_config(&mut self, updates: &Value) -> Value {
        if self.config.is_none() {
            self.load_config();
        }
        if matches!(
            updates,
            Value::String(_) | Value::Number(_) | Value::Bool(_)
        ) {
            // `'audioOutputDeviceId' in updates` throws on a primitive; caught.
            return json!({
                "success": false,
                "config": Value::Object(self.get_config()),
                "error": format!(
                    "Cannot use 'in' operator to search for 'audioOutputDeviceId' in {}",
                    jsv::to_js_string(updates)
                ),
            });
        }
        let mut updates = updates.clone();
        if let Value::Object(o) = &mut updates
            && let Some(d) = o.get("audioOutputDeviceId")
            && (d.is_null() || d.as_str() == Some(""))
        {
            // WO-001: '' or null is no device choice; the device stays as it is.
            o.shift_remove("audioOutputDeviceId");
        }
        let mut merged = self.get_config();
        jsv::spread(&mut merged, &updates);
        let errors = Self::validate_config(&merged);
        if !errors.is_empty() {
            return json!({
                "success": false,
                "config": Value::Object(self.get_config()),
                "error": errors.join("; "),
            });
        }
        self.config = Some(merged);
        let saved = self.save_config();
        json!({
            "success": saved,
            "config": Value::Object(self.get_config()),
            "error": if saved { Value::Null } else { json!("Failed to save config") },
        })
    }

    /// `addRecentWorkspace(path)`.
    pub fn add_recent_workspace(&mut self, workspace_path: &Value) -> bool {
        let Some(p) = workspace_path.as_str().filter(|p| !p.is_empty()) else {
            return false;
        };
        if self.config.is_none() {
            self.load_config();
        }
        let Some(cfg) = self.config.as_mut() else {
            return false;
        };
        // `recentWorkspaces.filter(...)` throws on a non-array: caught, nothing changes.
        let Some(Value::Array(a)) = cfg.get("recentWorkspaces") else {
            return false;
        };
        let mut recent: Vec<Value> = a
            .iter()
            .filter(|v| v.as_str() != Some(p))
            .cloned()
            .collect();
        recent.insert(0, json!(p));
        let max = jsv::to_number(cfg.get("maxRecentWorkspaces").unwrap_or(&Value::Null));
        // `length > max` then `slice(0, max)`; a non-number max compares as NaN (never > ).
        if (recent.len() as f64) > max {
            // Array.prototype.slice(0, max): a negative end counts from the back.
            let len = recent.len() as f64;
            let rel = max.trunc();
            let end = if rel < 0.0 {
                (len + rel).max(0.0)
            } else {
                rel.min(len)
            };
            recent.truncate(end as usize);
        }
        cfg.insert("recentWorkspaces".into(), Value::Array(recent));
        self.save_config();
        true
    }

    /// `removeRecentWorkspace(path)`.
    pub fn remove_recent_workspace(&mut self, workspace_path: &Value) -> bool {
        if self.config.is_none() {
            self.load_config();
        }
        let Some(cfg) = self.config.as_mut() else {
            return false;
        };
        let Some(Value::Array(a)) = cfg.get("recentWorkspaces") else {
            return false;
        };
        let recent: Vec<Value> = a.iter().filter(|v| *v != workspace_path).cloned().collect();
        cfg.insert("recentWorkspaces".into(), Value::Array(recent));
        self.save_config();
        true
    }

    /// `resetToDefaults()`.
    pub fn reset_to_defaults(&mut self) -> Obj {
        self.config = Some(self.default_config.clone());
        self.save_config();
        self.get_config()
    }

    pub fn set_listening_port(&mut self, port: u16) {
        self.listening_port = Some(port);
    }

    /// `getListeningPort()`.
    pub fn get_listening_port(&self) -> Value {
        if let Some(p) = self.listening_port.filter(|p| *p != 0) {
            return json!(p);
        }
        let cfg_port = self.config.as_ref().and_then(|c| c.get("httpRemotePort"));
        jsv::or(cfg_port, json!(3333))
    }

    /// `validateConfig(config)`: the error messages, empty when valid.
    pub fn validate_config(c: &Obj) -> Vec<String> {
        let mut errors = Vec::new();
        let port_bad = |k: &str| {
            jsv::truthy_opt(c.get(k)) && (jsv::lt(c.get(k), 1.0) || jsv::gt(c.get(k), 65535.0))
        };
        if port_bad("websocketPort") {
            errors.push("WebSocket port must be between 1 and 65535".to_string());
        }
        if port_bad("httpRemotePort") {
            errors.push("HTTP remote port must be between 1 and 65535".to_string());
        }
        if jsv::lt(c.get("defaultFadeInTime"), 0.0) {
            errors.push("Default fade in time cannot be negative".to_string());
        }
        if jsv::lt(c.get("defaultFadeOutTime"), 0.0) {
            errors.push("Default fade out time cannot be negative".to_string());
        }
        if let Some(v) = c.get("duckingFadeTime") {
            let ok = v.as_f64().is_some_and(|f| (0.0..=10000.0).contains(&f));
            if !ok {
                errors.push("Ducking fade time must be between 0ms and 10000ms".to_string());
            }
        }
        // WO-016: audio settings go straight to the engine.
        let is_integer = |v: &Value| {
            v.as_f64()
                .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
        };
        let positive_integer = |v: &Value| is_integer(v) && v.as_f64().is_some_and(|f| f > 0.0);
        if c.get("audioSampleRate")
            .is_some_and(|v| !positive_integer(v))
        {
            errors.push("Audio sample rate must be a positive whole number".to_string());
        }
        if c.get("audioBufferSize")
            .is_some_and(|v| !positive_integer(v))
        {
            errors.push("Audio buffer size must be a positive whole number".to_string());
        }
        if c.get("audioOutputChannelCount").is_some_and(|v| {
            !(is_integer(v) && v.as_f64().is_some_and(|f| (1.0..=64.0).contains(&f)))
        }) {
            errors.push("Output channel count must be a whole number between 1 and 64".to_string());
        }
        if jsv::lt(c.get("crossfadeTime"), 100.0) || jsv::gt(c.get("crossfadeTime"), 10000.0) {
            errors.push("Crossfade time must be between 100ms and 10000ms".to_string());
        }
        errors
    }
}
