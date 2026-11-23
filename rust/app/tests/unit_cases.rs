//! The Wave A units' recorded cases (`tests/unit-cases/*.jsonl`, one `{fn, args, ok|error}` per line,
//! recorded from the original by rust-anything), run against the ports in `src/core` (ADR-020).
//!
//! Values use the recording's encoding: `{"$num": "NaN" | "-0" | "Infinity" | "-Infinity"}` and
//! `{"$undefined": true}`. A case whose arguments don't fit the Rust parameter types (a number
//! where a string goes, say) exercised the JS binding's coercion, which went with the binding: it
//! is counted as skipped, and each file must still run nearly all of its cases.

use accompaniment::core::{
    cue_aliases, id_validation, lru_cache, media_names, nodepath_win32, output_patch,
    playlist_logic, retrigger_logic, soundboard_mixer,
};
use accompaniment::js;
use serde_json::Value;

/// A case's arguments, converted to the Rust parameter types; `None` when they don't fit.
struct Args<'a>(&'a [Value]);

impl Args<'_> {
    fn get(&self, i: usize) -> Option<&Value> {
        self.0.get(i)
    }
    fn num(&self, i: usize) -> Option<f64> {
        js::as_number(self.get(i)?)
    }
    fn string(&self, i: usize) -> Option<String> {
        self.get(i)?.as_str().map(str::to_string)
    }
    fn boolean(&self, i: usize) -> Option<bool> {
        self.get(i)?.as_bool()
    }
    /// `Option<bool>`: missing, undefined or null is None.
    fn opt_bool(&self, i: usize) -> Option<Option<bool>> {
        match self.get(i) {
            None | Some(Value::Null) => Some(None),
            Some(v) if js::is_undefined(v) => Some(None),
            Some(Value::Bool(b)) => Some(Some(*b)),
            Some(_) => None,
        }
    }
    /// `Option<f64>`: missing, undefined or null is None.
    fn opt_num(&self, i: usize) -> Option<Option<f64>> {
        match self.get(i) {
            None | Some(Value::Null) => Some(None),
            Some(v) if js::is_undefined(v) => Some(None),
            Some(v) => js::as_number(v).map(Some),
        }
    }
    fn value(&self, i: usize) -> Value {
        self.get(i).cloned().unwrap_or_else(js::undefined)
    }
    fn nums(&self, i: usize) -> Option<Vec<f64>> {
        self.get(i)?.as_array()?.iter().map(js::as_number).collect()
    }
    fn values(&self, i: usize) -> Option<Vec<Value>> {
        self.get(i)?.as_array().cloned()
    }
}

fn nums_json(v: Vec<f64>) -> Value {
    Value::Array(v.into_iter().map(js::number).collect())
}

/// Runs one recorded call; `None` when its arguments don't fit the port's types.
fn call(name: &str, a: &Args) -> Option<Result<Value, String>> {
    Some(match name {
        "normalizeCueFieldAliases" => cue_aliases::normalize_cue_field_aliases(a.value(0)),
        "isValidUuid" => id_validation::is_valid_uuid(a.string(0)?).map(Value::Bool),
        "validateUuidOrError" => id_validation::validate_uuid_or_error(a.string(0)?, a.string(1)?),
        "estimateAudioBufferBytes" => {
            lru_cache::estimate_audio_buffer_bytes(a.num(0)?, a.num(1)?, a.boolean(2)?)
                .map(js::number)
        }
        "runCache" => lru_cache::run_cache(a.num(0)?, a.num(1)?, a.value(2)).map(Value::Array),
        "sanitizeFilename" => media_names::sanitize_filename(a.string(0)?),
        "withCopyNumber" => {
            media_names::with_copy_number(a.string(0)?, a.num(1)?).map(Value::String)
        }
        "cleanLegacyName" => media_names::clean_legacy_name(a.string(0)?).map(Value::String),
        "isSupportedAudio" => media_names::is_supported_audio(a.string(0)?).map(Value::Bool),
        "normalizeOutputPatch" => {
            output_patch::normalize_output_patch(a.value(0), a.opt_num(1)?).map(nums_json)
        }
        "shuffledOrder" => playlist_logic::shuffled_order(a.num(0)?, a.nums(1)?),
        "isValidOrder" => playlist_logic::is_valid_order(a.value(0), a.num(1)?).map(Value::Bool),
        "effectiveOrder" => {
            playlist_logic::effective_order(a.num(0)?, a.boolean(1)?, a.value(2)).map(nums_json)
        }
        "decideItemEnd" => playlist_logic::decide_item_end(
            a.num(0)?,
            a.num(1)?,
            a.string(2)?,
            a.boolean(3)?,
            a.boolean(4)?,
            a.boolean(5)?,
            a.value(6),
            a.nums(7)?,
        ),
        "stepIndex" => playlist_logic::step_index(
            a.num(0)?,
            a.num(1)?,
            a.string(2)?,
            a.boolean(3)?,
            a.value(4),
        ),
        "peekNextIndex" => playlist_logic::peek_next_index(
            a.num(0)?,
            a.num(1)?,
            a.boolean(2)?,
            a.value(3),
            a.boolean(4)?,
        ),
        "normalizeRetriggerBehavior" => retrigger_logic::normalize_retrigger_behavior(a.value(0)),
        "resolveRetrigger" => {
            retrigger_logic::resolve_retrigger(a.value(0), a.string(1)?, a.opt_bool(2)?)
                .map(Value::String)
        }
        "runMixer" => soundboard_mixer::run_mixer(
            a.num(0)?,
            a.num(1)?,
            a.values(2)?,
            a.values(3)?,
            a.num(4)?,
            a.num(5)?,
        ),
        other => panic!("no runner for `{other}`"),
    })
}

/// Equal as the recording means it: numbers by value (`3` and `3.0`, and the `$num` forms),
/// objects by their entries.
fn same(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (num_of(a), num_of(b)) {
        return (x.is_nan() && y.is_nan())
            || (x == y && x.is_sign_negative() == y.is_sign_negative());
    }
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(_) => v.as_f64(),
        Value::Object(o) if o.len() == 1 && o.contains_key("$num") => js::as_number(v),
        _ => None,
    }
}

/// The port's `Err("TypeError: message")` against the recorded message.
fn same_error(ours: &str, recorded: &str) -> bool {
    ours == recorded || ours.split_once(": ").is_some_and(|(_, m)| m == recorded)
}

fn run_file(file: &str) {
    let path = format!(
        "{}/tests/unit-cases/{file}.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let (mut ran, mut skipped) = (0, 0);
    let mut failures = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let case: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("{path}:{n}: {e}"));
        let name = case["fn"].as_str().unwrap_or_default();
        let args = case["args"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let Some(result) = call(name, &Args(args)) else {
            skipped += 1;
            continue;
        };
        ran += 1;
        let ok = match (
            &result,
            case.get("ok"),
            case.get("error").and_then(Value::as_str),
        ) {
            (Ok(v), Some(want), _) => same(v, want),
            (Err(e), None, Some(want)) => same_error(e, want),
            _ => false,
        };
        if !ok && failures.len() < 10 {
            failures.push(format!(
                "line {}: {name} -> {result:?}\n  recorded {line}",
                n + 1
            ));
        }
    }
    eprintln!("{file}: {ran} cases ran, {skipped} skipped (JS-only argument types)");
    assert!(
        failures.is_empty(),
        "{file}: mismatches:\n{}",
        failures.join("\n")
    );
    assert!(
        ran * 10 >= (ran + skipped) * 9,
        "{file}: only {ran} of {} cases ran",
        ran + skipped
    );
}

#[test]
fn cue_aliases_cases() {
    run_file("cue-aliases");
}
#[test]
fn id_validation_cases() {
    run_file("id-validation");
}
#[test]
fn lru_cache_cases() {
    run_file("lru-cache");
}
#[test]
fn media_library_names_cases() {
    run_file("media-library-names");
}
#[test]
fn output_patch_cases() {
    run_file("output-patch");
}
#[test]
fn playlist_logic_cases() {
    run_file("playlist-logic");
}
#[test]
fn retrigger_logic_cases() {
    run_file("retrigger-logic");
}
#[test]
fn soundboard_mixer_cases() {
    run_file("soundboard-mixer");
}

/// Node's `path.win32` (WO-038), recorded by `rust/scripts/record-path-win32.js` with the working
/// directory and per-drive working directories pinned in each case.
#[test]
fn path_win32_cases() {
    let path = format!(
        "{}/tests/unit-cases/path-win32.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut failures = Vec::new();
    let mut ran = 0;
    for (n, line) in text.lines().enumerate() {
        let case: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("{path}:{n}: {e}"));
        let args: Vec<&str> = case["args"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let cwd = case["cwd"].as_str().unwrap_or_default().to_string();
        let drives = case["driveCwd"].clone();
        let drive_cwd = |d: &str| drives.get(d).and_then(Value::as_str).map(str::to_string);
        let a = |i: usize| args.get(i).copied().unwrap_or_default();
        let got = match case["fn"].as_str().unwrap_or_default() {
            "normalize" => Value::from(nodepath_win32::normalize(a(0))),
            "isAbsolute" => Value::from(nodepath_win32::is_absolute(a(0))),
            "dirname" => Value::from(nodepath_win32::dirname(a(0))),
            "basename" => Value::from(nodepath_win32::basename(a(0), args.get(1).copied())),
            "extname" => Value::from(nodepath_win32::extname(a(0))),
            "join" => Value::from(nodepath_win32::join(&args)),
            "resolve" => Value::from(nodepath_win32::resolve_with(&args, &cwd, &drive_cwd)),
            "relative" => Value::from(nodepath_win32::relative_with(a(0), a(1), &cwd, &drive_cwd)),
            other => panic!("no runner for `{other}`"),
        };
        ran += 1;
        if Some(&got) != case.get("ok") && failures.len() < 15 {
            failures.push(format!(
                "line {}: {} -> {got}\n  recorded {line}",
                n + 1,
                case["fn"]
            ));
        }
    }
    eprintln!("path-win32: {ran} cases ran");
    assert!(
        failures.is_empty(),
        "path-win32 mismatches:\n{}",
        failures.join("\n")
    );
}
