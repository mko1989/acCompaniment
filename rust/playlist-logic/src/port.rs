//! The Rust port of `src/backend/playlistLogic.js` (through `rust/shims/playlist-logic/`).
//!
//! Numbers stay `f64` as in JS: indexes come from stored cue data and are compared with `===`
//! (`indexOf`), and lengths follow `Array.from({ length })` (truncated, never below 0, and
//! `RangeError: Invalid array length` from 2^32 up).
//!
//! Randomness: the original takes `rng` (cueManager passes `Math.random`). The exported functions
//! take `rng_values`, a sequence `rng()` returns in turn (cycling, each value reduced to its
//! fraction, empty = 0), exactly as the shim feeds the original; [`Rng`] is that sequence, and
//! the `*_with` functions take any `FnMut() -> f64` for the core's real random source.
//!
//! A shuffle order is `Vec<Option<f64>>`: `None` is a JS `undefined` element. The app's `rng`
//! (`Math.random`) never makes one; a NaN from `rng()` does (the swap reads `order[NaN]`).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// A JS array of numbers that may hold `undefined` (`None`).
pub type Order = Vec<Option<f64>>;

const INVALID_LENGTH: &str = "RangeError: Invalid array length";
/// Largest JS array length, 2^32 - 1.
const MAX_ARRAY_LENGTH: f64 = 4_294_967_295.0;

/// `rng()` over a recorded sequence: cycling, each value reduced to `x - floor(x)`, empty = 0.
pub struct Rng {
    values: Vec<f64>,
    next: usize,
}

impl Rng {
    pub fn new(values: Vec<f64>) -> Self {
        Rng { values, next: 0 }
    }

    pub fn next_value(&mut self) -> f64 {
        if self.values.is_empty() {
            return 0.0;
        }
        let x = self.values[self.next % self.values.len()];
        self.next += 1;
        x - x.floor()
    }
}

/// `Array.from({ length: n }, (_, i) => i)`: NaN and negatives are empty, fractions truncate.
fn list_order(n: f64) -> Result<Vec<f64>, String> {
    if n.is_nan() || n <= 0.0 {
        return Ok(Vec::new());
    }
    let len = n.trunc();
    if len > MAX_ARRAY_LENGTH {
        return Err(INVALID_LENGTH.to_string());
    }
    // INFALLIBLE: `len` is a whole number in [1, 2^32 - 1].
    Ok((0..len as u64).map(|i| i as f64).collect())
}

/// JS `Array.prototype.indexOf` over numbers: strict equality (`-0 === 0`, NaN never found).
fn index_of(sequence: &[Option<f64>], value: f64) -> Option<usize> {
    sequence.iter().position(|&x| x == Some(value))
}

/// `order` as callers pass it: an array of numbers, or `null` / `undefined` (`Map.get` of a cue
/// with no shuffle order yet). Anything else is not an array, so it is never a valid order.
fn order_arg(order: &Value) -> Option<Vec<f64>> {
    let items = order.as_array()?;
    items.iter().map(js::as_number).collect()
}

fn numbers(order: &[Option<f64>]) -> Value {
    Value::Array(
        order
            .iter()
            .map(|x| x.map_or_else(js::undefined, js::number))
            .collect(),
    )
}

fn maybe_number(x: Option<f64>) -> Value {
    x.map_or_else(js::undefined, js::number)
}

/// Fisher-Yates shuffle of `[0..itemCount-1]` (`playlistLogic.js:13`), JS array semantics
/// included: `j = floor(rng() * (i + 1))` may be NaN, and `order[NaN]` is then the array's
/// `"NaN"` property (`undefined` until the swap writes to it, the last value written after), or
/// `i + 1` (`rng()` of exactly 1: writes one past the end).
pub fn shuffled_order_with(
    item_count: f64,
    rng: &mut impl FnMut() -> f64,
) -> Result<Order, String> {
    let mut order: Order = list_order(item_count.max(0.0))?
        .into_iter()
        .map(Some)
        .collect();
    // The array's `"NaN"` property.
    let mut nan_property: Option<f64> = None;
    let start_len = order.len();
    for i in (1..start_len).rev() {
        let j = (rng() * (i + 1) as f64).floor();
        let at_i = order[i];
        if j.is_nan() {
            order[i] = nan_property;
            nan_property = at_i;
            continue;
        }
        // `rng()` is in [0, 1], so `j` is a whole number in [0, i + 1].
        let j = j as usize;
        order[i] = order.get(j).copied().flatten();
        if j < order.len() {
            order[j] = at_i;
        } else {
            order.push(at_i);
        }
    }
    Ok(order)
}

/// Port of `shuffledOrder` (`src/backend/playlistLogic.js:13`).
pub fn shuffled_order(item_count: f64, rng_values: Vec<f64>) -> Result<Value, String> {
    let mut rng = Rng::new(rng_values);
    Ok(numbers(&shuffled_order_with(item_count, &mut || {
        rng.next_value()
    })?))
}

/// Whether `order` is a permutation of `[0..itemCount-1]` (`playlistLogic.js:23`).
pub(crate) fn is_valid(order: Option<&[f64]>, item_count: f64) -> bool {
    let Some(order) = order else {
        return false;
    };
    if order.len() as f64 != item_count {
        return false;
    }
    // `new Set(order).size`: SameValueZero, so +0 and -0 are one value and NaN equals NaN.
    let mut distinct: Vec<f64> = Vec::with_capacity(order.len());
    for &x in order {
        if !distinct
            .iter()
            .any(|&d| d == x || (d.is_nan() && x.is_nan()))
        {
            distinct.push(x);
        }
    }
    distinct.len() as f64 == item_count
        && order
            .iter()
            .all(|&i| i.is_finite() && i.fract() == 0.0 && i >= 0.0 && i < item_count)
}

/// Port of `isValidOrder` (`src/backend/playlistLogic.js:23`).
pub fn is_valid_order(order: Value, item_count: f64) -> Result<bool, String> {
    Ok(is_valid(order_arg(&order).as_deref(), item_count))
}

fn effective(item_count: f64, shuffle: bool, order: Option<Vec<f64>>) -> Result<Vec<f64>, String> {
    match order {
        Some(order) if shuffle && is_valid(Some(&order), item_count) => Ok(order),
        _ => list_order(item_count),
    }
}

/// Port of `effectiveOrder` (`src/backend/playlistLogic.js:32`).
pub fn effective_order(item_count: f64, shuffle: bool, order: Value) -> Result<Vec<f64>, String> {
    effective(item_count, shuffle, order_arg(&order))
}

/// What `decideItemEnd` decides: the action, the item to go to (`None` = JS `undefined`), and the
/// shuffle order to keep.
pub struct ItemEnd {
    pub action: &'static str,
    pub next_index: Option<f64>,
    pub order: Option<Order>,
}

/// What happens when the current item ends (`playlistLogic.js:52`).
pub fn decide_item_end_with(
    item_count: f64,
    current_index: f64,
    mode: &str,
    repeat_one: bool,
    r#loop: bool,
    shuffle: bool,
    order: Option<Vec<f64>>,
    rng: &mut impl FnMut() -> f64,
) -> Result<ItemEnd, String> {
    let end = |action, next_index, order| ItemEnd {
        action,
        next_index,
        order,
    };
    // `itemCount <= 0`; NaN compares false and goes on, as in JS.
    if item_count <= 0.0 {
        return Ok(end("finish", Some(0.0), None));
    }
    let active_order: Option<Order> = if shuffle {
        Some(match order {
            Some(order) if is_valid(Some(&order), item_count) => {
                order.into_iter().map(Some).collect()
            }
            _ => shuffled_order_with(item_count, rng)?,
        })
    } else {
        None
    };
    let cue_action = if repeat_one || mode == "stop_and_cue_next" {
        "cue"
    } else {
        "play"
    };
    if repeat_one {
        return Ok(end("cue", Some(current_index), active_order));
    }
    let sequence: Order = match &active_order {
        Some(order) => order.clone(),
        None => list_order(item_count)?.into_iter().map(Some).collect(),
    };
    let position = index_of(&sequence, current_index).unwrap_or(0);
    if position + 1 < sequence.len() {
        return Ok(end(cue_action, sequence[position + 1], active_order));
    }
    if !r#loop {
        return Ok(end("finish", Some(0.0), None));
    }
    if shuffle {
        let reshuffled = shuffled_order_with(item_count, rng)?;
        let first = reshuffled.first().copied().flatten();
        return Ok(end(cue_action, first, Some(reshuffled)));
    }
    Ok(end(cue_action, Some(0.0), None))
}

/// Port of `decideItemEnd` (`src/backend/playlistLogic.js:52`).
pub fn decide_item_end(
    item_count: f64,
    current_index: f64,
    mode: String,
    repeat_one: bool,
    r#loop: bool,
    shuffle: bool,
    order: Value,
    rng_values: Vec<f64>,
) -> Result<Value, String> {
    let mut rng = Rng::new(rng_values);
    let decision = decide_item_end_with(
        item_count,
        current_index,
        &mode,
        repeat_one,
        r#loop,
        shuffle,
        order_arg(&order),
        &mut || rng.next_value(),
    )?;
    Ok(json!({
        "action": decision.action,
        "nextIndex": maybe_number(decision.next_index),
        "order": decision.order.as_deref().map_or(Value::Null, numbers),
    }))
}

/// Port of `stepIndex` (`src/backend/playlistLogic.js:91`): manual ◀ ▶, clamped at both ends.
pub fn step_index(
    item_count: f64,
    current_index: f64,
    direction: String,
    shuffle: bool,
    order: Value,
) -> Result<Value, String> {
    if item_count <= 0.0 {
        return Ok(js::number(0.0));
    }
    let sequence = effective(item_count, shuffle, order_arg(&order))?;
    let position = sequence
        .iter()
        .position(|&x| x == current_index)
        .unwrap_or(0) as f64;
    let delta = if direction == "previous" { -1.0 } else { 1.0 };
    let next = ((position + delta).max(0.0)).min(sequence.len() as f64 - 1.0);
    // `sequence[-1]` (an empty sequence) is `undefined`.
    Ok(if next < 0.0 {
        js::undefined()
    } else {
        maybe_number(sequence.get(next as usize).copied())
    })
}

/// Port of `peekNextIndex` (`src/backend/playlistLogic.js:104`).
pub fn peek_next_index(
    item_count: f64,
    current_index: f64,
    shuffle: bool,
    order: Value,
    r#loop: bool,
) -> Result<Value, String> {
    if item_count <= 0.0 {
        return Ok(Value::Null);
    }
    let sequence = effective(item_count, shuffle, order_arg(&order))?;
    if let Some(position) = sequence.iter().position(|&x| x == current_index)
        && position + 1 < sequence.len()
    {
        return Ok(js::number(sequence[position + 1]));
    }
    Ok(if r#loop {
        maybe_number(sequence.first().copied())
    } else {
        Value::Null
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shuffle_follows_the_sequence() {
        // i=2: floor(0.5*3)=1 -> [0,2,1]; i=1: floor(0.5*2)=1 -> unchanged.
        assert_eq!(
            shuffled_order_with(3.0, &mut || 0.5).unwrap(),
            vec![Some(0.0), Some(2.0), Some(1.0)]
        );
        assert_eq!(shuffled_order_with(-1.0, &mut || 0.5).unwrap(), vec![]);
    }

    #[test]
    fn nan_from_rng_leaves_undefined() {
        // i=2: order[2] = order.NaN (undefined), order.NaN = 2; i=1: order[1] = 2.
        let order = shuffled_order_with(3.0, &mut || f64::NAN).unwrap();
        assert_eq!(order, vec![Some(0.0), Some(2.0), None]);
    }

    #[test]
    fn huge_lengths_are_range_errors() {
        assert_eq!(list_order(4_294_967_296.0), Err(INVALID_LENGTH.to_string()));
        assert_eq!(list_order(f64::INFINITY), Err(INVALID_LENGTH.to_string()));
    }

    #[test]
    fn valid_orders() {
        assert!(is_valid(Some(&[2.0, 0.0, 1.0]), 3.0));
        assert!(!is_valid(Some(&[0.0, 0.0, 1.0]), 3.0));
        assert!(!is_valid(Some(&[0.0, 1.5]), 2.0));
        assert!(!is_valid(None, 0.0));
    }

    #[test]
    fn step_clamps() {
        assert_eq!(
            step_index(3.0, 0.0, "previous".into(), false, Value::Null),
            Ok(json!(0))
        );
        assert_eq!(
            step_index(3.0, 2.0, "next".into(), false, Value::Null),
            Ok(json!(2))
        );
    }
}
