//! The Rust port of `src/backend/utils/outputPatch.js` (through `rust/shims/output-patch/`).
//!
//! A cue's stored `outputPatch` can be any JSON value, so entries go through JS `Number()`
//! exactly: strings are trimmed and parsed as JS literals (hex, `Infinity`, not Rust's `inf`),
//! arrays become `String(array)` first (`[5]` is 5, `[1,2]` is NaN), `true` is 1, `null` is 0.

#![forbid(unsafe_code)]

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js;

/// Port of `normalizeOutputPatch` (`src/backend/utils/outputPatch.js:12`).
pub fn normalize_output_patch(patch: Value, max_channels: Option<f64>) -> Result<Vec<f64>, String> {
    // `Math.max(1, maxChannels || 2)`: undefined, 0 and NaN are falsy.
    let channels = match max_channels {
        Some(m) if m != 0.0 && !m.is_nan() => m.max(1.0),
        _ => 2.0,
    };
    let (raw_left, raw_right) = match &patch {
        Value::Array(items) => {
            let first = items.first().cloned().unwrap_or_else(js::undefined);
            // `patch[1] ?? patch[0]`
            match items.get(1) {
                Some(v) if !is_nullish(v) => (first, v.clone()),
                _ => (first.clone(), first),
            }
        }
        _ => (Value::from(0), Value::from(1)),
    };
    // `Math.max(0, Math.min(channels - 1, n))`; `+ 0.0` turns -0 into 0, as JS's max(0, -0) does.
    let clamp = |n: f64| n.min(channels - 1.0).max(0.0) + 0.0;
    let left = clamp(channel_or(&raw_left, 0.0));
    let right = clamp(channel_or(&raw_right, left));
    Ok(vec![left, right])
}

fn is_nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn channel_or(value: &Value, fallback: f64) -> f64 {
    let empty_string = js::string_units(value).is_some_and(|u| u.is_empty());
    let n = to_number(value);
    if is_nullish(value) || empty_string || !n.is_finite() {
        fallback
    } else {
        n.floor()
    }
}

/// JS `Number(value)`.
fn to_number(value: &Value) -> f64 {
    match (js::as_number(value), value) {
        (Some(n), _) => n,
        (_, Value::Null) => 0.0,
        (_, Value::Bool(b)) => f64::from(u8::from(*b)),
        _ if js::is_undefined(value) => f64::NAN,
        _ => string_to_number(&to_js_string(value)),
    }
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
                if is_nullish(v) {
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

static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: a constant, valid pattern.
    Regex::new(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$").expect("valid regex")
});

/// JS `StringToNumber`: trimmed of JS whitespace (Rust's, minus U+0085, plus U+FEFF); empty is 0.
fn string_to_number(s: &str) -> f64 {
    let s = s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}');
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .into_iter()
    .find_map(|(p, r)| s.strip_prefix(p).map(|digits| (digits, r)));
    match (s, radix) {
        ("", _) => 0.0,
        ("Infinity" | "+Infinity", _) => f64::INFINITY,
        ("-Infinity", _) => f64::NEG_INFINITY,
        (_, Some(("", _))) => f64::NAN,
        (_, Some((digits, r))) => digits
            .chars()
            .try_fold(0.0, |acc, c| {
                c.to_digit(r).map(|d| acc * f64::from(r) + f64::from(d))
            })
            .unwrap_or(f64::NAN),
        _ if DECIMAL.is_match(s) => s.parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patches() {
        let p = |v: Value| normalize_output_patch(v, None).unwrap();
        assert_eq!(
            p(json!([1, 0])),
            vec![1.0, 0.0],
            "channel 0 is a real channel"
        );
        assert_eq!(p(json!([1, null])), vec![1.0, 1.0]);
        assert_eq!(p(json!(["0x1", [1, 2]])), vec![1.0, 1.0]);
        assert_eq!(string_to_number("\u{FEFF} .5e1 "), 5.0);
        assert!(string_to_number("inf").is_nan() && string_to_number("\u{85}1").is_nan());
    }
}
