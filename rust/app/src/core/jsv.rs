//! JavaScript value semantics the original relies on, over `serde_json::Value`.
//!
//! The core keeps every document as a `Value` (insertion-ordered, `preserve_order`), because the
//! original spreads and merges unknown keys everywhere. In the core a JS `undefined` is an absent
//! key, never a value. This module is the one place JS coercion lives (MAP.md, "Rules for later
//! stages").

use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{Map, Value};

use crate::js;

pub type Obj = Map<String, Value>;

/// JS truthiness of a JSON value (`||`, `!`, `Boolean()`); the `undefined` marker is falsy.
pub fn truthy(v: &Value) -> bool {
    if js::is_undefined(v) {
        return false;
    }
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Truthiness of an optional value: an absent key is `undefined`, which is falsy.
pub fn truthy_opt(v: Option<&Value>) -> bool {
    v.is_some_and(truthy)
}

/// `a || b` on optional values: `a` if truthy, else `b`.
pub fn or(a: Option<&Value>, b: Value) -> Value {
    match a {
        Some(v) if truthy(v) => v.clone(),
        _ => b,
    }
}

pub fn is_number(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(_)))
}

pub fn num(v: f64) -> Value {
    js::number(v)
}

/// JS `String(value)` for JSON values.
pub fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|i| {
                if i.is_null() {
                    String::new()
                } else {
                    to_js_string(i)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS `Number(value)` for JSON values (`undefined` is handled by callers: it is NaN).
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => string_to_number(&to_js_string(v)),
    }
}

static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: a constant, valid pattern.
    Regex::new(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$").expect("valid regex")
});

/// JS whitespace and line terminators, as `String.prototype.trim` strips them.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// JS `StringToNumber`.
pub fn string_to_number(s: &str) -> f64 {
    let s = s.trim_matches(is_js_space);
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

/// JS `value < n` for a value read from a JSON document and a number (`undefined < n` is false).
pub fn lt(v: Option<&Value>, n: f64) -> bool {
    v.is_some_and(|v| to_number(v) < n)
}

/// JS `value > n`.
pub fn gt(v: Option<&Value>, n: f64) -> bool {
    v.is_some_and(|v| to_number(v) > n)
}

/// Whether a key is an array index, which JS objects list first, in ascending order.
fn array_index(k: &str) -> Option<u32> {
    if k == "0" {
        return Some(0);
    }
    if k.is_empty() || k.starts_with('0') || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

/// Puts an object's keys in JS property order: array indexes ascending, then the rest as inserted.
pub fn js_order(o: &mut Obj) {
    if !o.keys().any(|k| array_index(k).is_some()) {
        return;
    }
    let mut entries: Vec<(String, Value)> = std::mem::take(o).into_iter().collect();
    let mut idx: Vec<(u32, (String, Value))> = Vec::new();
    let mut rest = Vec::new();
    for e in entries.drain(..) {
        match array_index(&e.0) {
            Some(n) => idx.push((n, e)),
            None => rest.push(e),
        }
    }
    idx.sort_by_key(|(n, _)| *n);
    for (_, (k, v)) in idx {
        o.insert(k, v);
    }
    for (k, v) in rest {
        o.insert(k, v);
    }
}

fn js_order_deep(v: &mut Value) {
    match v {
        Value::Object(o) => {
            js_order(o);
            for (_, item) in o.iter_mut() {
                js_order_deep(item);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(js_order_deep),
        _ => {}
    }
}

/// Object spread `{ ...target, ...src }`: existing keys keep their place, new keys are appended.
/// Arrays spread their indexes, strings their UTF-16 code units; other values add nothing.
pub fn spread(target: &mut Obj, src: &Value) {
    match src {
        Value::Object(o) => {
            for (k, v) in o {
                target.insert(k.clone(), v.clone());
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                target.insert(i.to_string(), v.clone());
            }
        }
        Value::String(s) => {
            for (i, u) in s.encode_utf16().enumerate() {
                target.insert(i.to_string(), Value::String(String::from_utf16_lossy(&[u])));
            }
        }
        _ => {}
    }
    js_order(target);
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v, Some(2), 0);
    out
}

/// `JSON.stringify(value)`.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v, None, 0);
    out
}

fn write_value(out: &mut String, v: &Value, indent: Option<usize>, depth: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                out.push_str(&js::number_to_string(f));
            } else {
                out.push_str("null");
            }
        }
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                if js::is_undefined(item) {
                    out.push_str("null");
                } else {
                    write_value(out, item, indent, depth + 1);
                }
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(o) => {
            // Keys holding `undefined` are left out, as JSON.stringify does.
            let entries: Vec<(&String, &Value)> =
                o.iter().filter(|(_, v)| !js::is_undefined(v)).collect();
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_string(out, k);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(n) = indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', n * depth));
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.parse` of a file read with `readFile(path, 'utf-8')` (invalid UTF-8 becomes U+FFFD).
pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    parse_str(&text)
}

pub fn parse_str(text: &str) -> Result<Value, String> {
    let mut de = serde_json::Deserializer::from_str(text);
    de.disable_recursion_limit();
    let mut v = <Value as serde::Deserialize>::deserialize(&mut de).map_err(json_error)?;
    de.end().map_err(json_error)?;
    js_order_deep(&mut v);
    Ok(v)
}

/// V8's JSON.parse messages are not reproduced (ADR-005: error wording may differ); this keeps
/// the kind of failure readable.
fn json_error(e: serde_json::Error) -> String {
    if e.is_eof() {
        "Unexpected end of JSON input".into()
    } else {
        format!(
            "Unexpected token in JSON at line {} column {}",
            e.line(),
            e.column()
        )
    }
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    iso_from_ms(now_ms())
}

/// `new Date(ms).toISOString()` (ms since the Unix epoch, truncated to whole milliseconds).
pub fn iso_from_ms(ms: f64) -> String {
    let ms = ms.floor() as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// Milliseconds since the epoch of a file time, as Node's `stats.mtime` keeps them.
pub fn system_time_ms(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64() * 1000.0,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    }
}

// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `crypto.randomUUID()`.
pub fn random_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// JS `toLowerCase()` (full Unicode, as Rust's `to_lowercase`).
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

pub fn get_str<'a>(o: &'a Obj, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringify_matches_js() {
        let v = json!({"a": 1.0, "b": [], "c": {}, "d": "x\u{1}\"", "e": [1, 2.5]});
        assert_eq!(
            stringify_pretty(&v),
            "{\n  \"a\": 1,\n  \"b\": [],\n  \"c\": {},\n  \"d\": \"x\\u0001\\\"\",\n  \"e\": [\n    1,\n    2.5\n  ]\n}"
        );
        assert_eq!(stringify(&json!(1e21)), "1e+21");
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_763_723_387_132.0), "2025-11-21T11:09:47.132Z");
    }

    #[test]
    fn coercion() {
        assert!(lt(Some(&json!("50")), 100.0));
        assert!(!lt(None, 100.0));
        assert!(!lt(Some(&json!({})), 100.0));
        assert_eq!(to_number(&json!([5])), 5.0);
    }
}
