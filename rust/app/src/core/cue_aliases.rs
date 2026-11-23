//! The Rust port of `normalizeCueFieldAliases` (`src/backend/cueDataManager.js:69`, through
//! `rust/shims/cue-aliases/`, ADR-014).
//!
//! Older cues and clients send `shuffle` / `repeatOne`; the app stores `shufflePlaylist` /
//! `repeatOnePlaylistItem`. An alias becomes its canonical field as a boolean (JS truthiness)
//! unless the canonical field is already there, and is removed either way.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const CUE_FIELD_ALIASES: [(&str, &str); 2] = [
    ("shuffle", "shufflePlaylist"),
    ("repeatOne", "repeatOnePlaylistItem"),
];

/// Port of `normalizeCueFieldAliases`. Anything but an object or array comes back as it was;
/// an array comes back as an object keyed by index, as `{ ...array }` does in JS.
pub fn normalize_cue_field_aliases(data: Value) -> Result<Value, String> {
    if js::is_undefined(&data) {
        return Ok(data);
    }
    let mut out: Map<String, Value> = match data {
        Value::Object(map) => map,
        Value::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        other => return Ok(other),
    };
    for (alias, canonical) in CUE_FIELD_ALIASES {
        if let Some(value) = out.shift_remove(alias)
            && !out.contains_key(canonical)
        {
            out.insert(canonical.to_string(), Value::Bool(truthy(&value)));
        }
    }
    Ok(Value::Object(out))
}

/// JS `Boolean(value)` for a value that crossed the bridge (`undefined`, NaN and -0 arrive as
/// markers, see `js.rs`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Object(_) if js::is_undefined(value) => false,
        Value::Object(o) => match o.get("$num").and_then(Value::as_str) {
            Some(n) if o.len() == 1 => !matches!(n, "NaN" | "-0"),
            _ => js::string_units(value).is_none_or(|units| !units.is_empty()),
        },
        Value::Array(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn alias_becomes_canonical_unless_present() {
        assert_eq!(
            normalize_cue_field_aliases(json!({"shuffle": 1, "name": "x"})).unwrap(),
            json!({"name": "x", "shufflePlaylist": true})
        );
        assert_eq!(
            normalize_cue_field_aliases(json!({"repeatOne": true, "repeatOnePlaylistItem": false}))
                .unwrap(),
            json!({"repeatOnePlaylistItem": false})
        );
    }

    #[test]
    fn truthiness_and_non_objects() {
        assert_eq!(
            normalize_cue_field_aliases(json!({"shuffle": ""})).unwrap(),
            json!({"shufflePlaylist": false})
        );
        assert_eq!(
            normalize_cue_field_aliases(json!({"shuffle": []})).unwrap(),
            json!({"shufflePlaylist": true})
        );
        assert_eq!(normalize_cue_field_aliases(json!(0)).unwrap(), json!(0));
        assert_eq!(
            normalize_cue_field_aliases(json!(["a"])).unwrap(),
            json!({"0": "a"})
        );
    }
}
