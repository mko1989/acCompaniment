//! The server's `<dataDir>/config/appConfig.json`, as far as the tray touches it: the port
//! (`httpRemotePort`). Writes merge into the file and keep its other keys in place, written as
//! the launcher wrote it (`JSON.stringify(config, null, 2)`).

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// `ACCOMPANIMENT_DATA_DIR`, or `~/.accompaniment`: the server's own default.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ACCOMPANIMENT_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".accompaniment")
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config").join("appConfig.json")
}

/// The whole config; `{}` when it is missing or unreadable.
pub fn read(data_dir: &Path) -> Map<String, Value> {
    std::fs::read_to_string(config_path(data_dir))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| match v {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// `httpRemotePort`, when it is a usable port.
pub fn configured_port(data_dir: &Path) -> Option<u16> {
    read(data_dir)
        .get("httpRemotePort")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
}

/// Merges `changes` into the file (`Object.assign`), creating it and its folder if needed.
pub fn merge_write(data_dir: &Path, changes: Map<String, Value>) -> Result<(), String> {
    let path = config_path(data_dir);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let mut config = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => map,
            _ => return Err(format!("{} is not a JSON object", path.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    config.extend(changes);
    let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("accompaniment-tray-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_merge_keeps_the_other_keys_and_their_order() {
        let dir = temp_dir("merge");
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(
            config_path(&dir),
            r#"{"zeta":1,"httpRemotePort":3333,"alpha":{"x":true}}"#,
        )
        .unwrap();
        let changes = json!({"httpRemotePort": 4000});
        merge_write(&dir, changes.as_object().unwrap().clone()).unwrap();
        assert_eq!(
            std::fs::read_to_string(config_path(&dir)).unwrap(),
            "{\n  \"zeta\": 1,\n  \"httpRemotePort\": 4000,\n  \"alpha\": {\n    \"x\": true\n  }\n}"
        );
        assert_eq!(configured_port(&dir), Some(4000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_odd_port_is_none() {
        let dir = temp_dir("port");
        assert_eq!(configured_port(&dir), None);
        for bad in ["0", "70000", "\"3333\"", "-1"] {
            std::fs::create_dir_all(dir.join("config")).unwrap();
            std::fs::write(config_path(&dir), format!("{{\"httpRemotePort\":{bad}}}")).unwrap();
            assert_eq!(configured_port(&dir), None, "{bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
