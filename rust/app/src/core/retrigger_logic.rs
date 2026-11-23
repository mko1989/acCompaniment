//! The Rust port of `src/backend/retriggerLogic.js` (through `rust/shims/retrigger-logic/`).
//!
//! `BEHAVIOR_ALIASES[behavior]` looks a property up by `String(behavior)`, so `["pause"]` finds
//! the `pause` alias too. A non-string that is no alias then fails `includes` (strict equality)
//! and becomes `restart`. Prototype keys (`constructor`, `toString`) are truthy there but never a
//! behavior, so they also end at `restart`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// `RETRIGGER_BEHAVIORS` (`src/backend/retriggerLogic.js:20`).
pub const RETRIGGER_BEHAVIORS: [&str; 8] = [
    "restart",
    "toggle_pause_play",
    "stop",
    "fade_out_and_stop",
    "do_nothing",
    "play_new_instance",
    "replay_current_item",
    "play_next_item",
];

/// Port of `normalizeRetriggerBehavior` (`src/backend/retriggerLogic.js:31`).
pub fn normalize_retrigger_behavior(behavior: Value) -> Result<Value, String> {
    Ok(Value::from(normalize(&behavior)))
}

/// Port of `resolveRetrigger` (`src/backend/retriggerLogic.js:42`): the action for triggering a
/// cue that is `playing` (any state but `paused`) or `paused`.
pub fn resolve_retrigger(
    behavior: Value,
    state: String,
    is_playlist: Option<bool>,
) -> Result<String, String> {
    let playlist = is_playlist.unwrap_or(false);
    let action = match (state == "paused", normalize(&behavior)) {
        (true, "restart" | "replay_current_item" | "play_new_instance") => "restart",
        (true, "stop" | "fade_out_and_stop") => "stop",
        (true, "do_nothing") | (false, "do_nothing") => "nothing",
        (true, "play_next_item") if playlist => "next_item",
        (true, _) => "resume",
        (false, "toggle_pause_play") => "pause",
        (false, "stop") => "stop",
        (false, "fade_out_and_stop") => "fade_stop",
        (false, "play_new_instance") => "new_instance",
        (false, "play_next_item") if playlist => "next_item",
        (false, _) => "restart",
    };
    Ok(action.to_string())
}

fn normalize(behavior: &Value) -> &'static str {
    let alias = match to_js_string(behavior).as_str() {
        "pause_resume" | "pause" => Some("toggle_pause_play"),
        "do_nothing_if_playing" => Some("do_nothing"),
        _ => None,
    };
    let own = behavior
        .as_str()
        .and_then(|b| RETRIGGER_BEHAVIORS.iter().copied().find(|k| *k == b));
    alias.or(own).unwrap_or("restart")
}

/// JS `String(value)`; inside arrays (`join`), null and undefined become "".
fn to_js_string(value: &Value) -> String {
    if let Some(n) = js::as_number(value) {
        return js::number_to_string(n);
    }
    if let Some(units) = js::string_units(value) {
        return String::from_utf16_lossy(&units);
    }
    match value {
        _ if js::is_undefined(value) => "undefined".into(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() || js::is_undefined(v) {
                    String::new()
                } else {
                    to_js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aliases_and_unknowns() {
        let n = |v: Value| normalize_retrigger_behavior(v).unwrap();
        assert_eq!(n(json!("pause")), json!("toggle_pause_play"));
        assert_eq!(n(json!(["pause"])), json!("toggle_pause_play"));
        assert_eq!(n(json!(["stop"])), json!("restart"));
        assert_eq!(n(json!("constructor")), json!("restart"));
    }

    #[test]
    fn next_item_only_for_playlists() {
        let r = |s: &str, p| resolve_retrigger(json!("play_next_item"), s.into(), p).unwrap();
        assert_eq!(r("playing", Some(true)), "next_item");
        assert_eq!(r("playing", None), "restart");
        assert_eq!(r("paused", Some(false)), "resume");
    }
}
