//! JS bindings for `rust/shims/playlist-logic/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

/// `shuffledOrder`.
#[napi(js_name = "shuffledOrder")]
pub fn shuffled_order(item_count: f64, rng_values: Vec<f64>) -> napi::Result<String> {
    run(move || {
        let out = port::shuffled_order(item_count, rng_values)?;
        crate::js::to_json(&out)
    })
}

/// `isValidOrder`.
#[napi(js_name = "isValidOrder")]
pub fn is_valid_order(order: String, item_count: f64) -> napi::Result<bool> {
    run(move || {
        let order = crate::js::from_json(&order)?;
        let out = port::is_valid_order(order, item_count)?;
        Ok(out)
    })
}

/// `effectiveOrder`.
#[napi(js_name = "effectiveOrder")]
pub fn effective_order(item_count: f64, shuffle: bool, order: String) -> napi::Result<Vec<f64>> {
    run(move || {
        let order = crate::js::from_json(&order)?;
        let out = port::effective_order(item_count, shuffle, order)?;
        Ok(out)
    })
}

/// `decideItemEnd`.
#[napi(js_name = "decideItemEnd")]
pub fn decide_item_end(
    item_count: f64,
    current_index: f64,
    mode: String,
    repeat_one: bool,
    r#loop: bool,
    shuffle: bool,
    order: String,
    rng_values: Vec<f64>,
) -> napi::Result<String> {
    run(move || {
        let order = crate::js::from_json(&order)?;
        let out = port::decide_item_end(
            item_count,
            current_index,
            mode,
            repeat_one,
            r#loop,
            shuffle,
            order,
            rng_values,
        )?;
        crate::js::to_json(&out)
    })
}

/// `stepIndex`.
#[napi(js_name = "stepIndex")]
pub fn step_index(
    item_count: f64,
    current_index: f64,
    direction: String,
    shuffle: bool,
    order: String,
) -> napi::Result<String> {
    run(move || {
        let order = crate::js::from_json(&order)?;
        let out = port::step_index(item_count, current_index, direction, shuffle, order)?;
        crate::js::to_json(&out)
    })
}

/// `peekNextIndex`.
#[napi(js_name = "peekNextIndex")]
pub fn peek_next_index(
    item_count: f64,
    current_index: f64,
    shuffle: bool,
    order: String,
    r#loop: bool,
) -> napi::Result<String> {
    run(move || {
        let order = crate::js::from_json(&order)?;
        let out = port::peek_next_index(item_count, current_index, shuffle, order, r#loop)?;
        crate::js::to_json(&out)
    })
}

// ---- the binary wire ------------------------------------------------------------------------

type WireBuffers = (
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint32Array,
);

thread_local! {
    static WIRE: std::cell::RefCell<Option<WireBuffers>> = const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    static SCRATCH: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument, result and argument-length buffers `index.cjs` uses.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(
    input: napi::bindgen_prelude::Uint8Array,
    output: napi::bindgen_prelude::Uint8Array,
    len: napi::bindgen_prelude::Uint32Array,
) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output, len)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output, _)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads the argument bytes (`wLen[0]` of them), runs `f`, and writes its result; a negative
/// return is the size of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(
    f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>,
) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output, len)) = guard.as_mut() else {
            return Err(napi::Error::from_reason(
                "rust-anything: the wire buffers are not registered",
            ));
        };
        let len = (len.first().copied().unwrap_or(0) as usize).min(input.len());
        let mut w = wire::Writer(SCRATCH.with(|s| std::mem::take(&mut *s.borrow_mut())));
        w.0.clear();
        let result = run(|| f(&mut wire::Reader::new(&input[..len]), &mut w));
        let keep = |w: wire::Writer| SCRATCH.with(|s| *s.borrow_mut() = w.0);
        match result {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => {
                keep(w);
                return Ok(f64::NAN);
            }
            Err(e) => {
                keep(w);
                let mut m = wire::Writer::default();
                m.string16(&e.reason);
                // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
                let out = unsafe { output.as_mut() };
                if m.0.len() > out.len() {
                    return Err(e);
                }
                out[..m.0.len()].copy_from_slice(&m.0);
                return Ok(f64::INFINITY);
            }
            Ok(()) => {}
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        keep(w);
        Ok(n as f64)
    })
}

static S_SHUFFLED_ORDER_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Num);

/// `shuffledOrder` over the binary wire.
#[napi(js_name = "shuffledOrderWire")]
pub fn shuffled_order_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let item_count: f64 = r.f64()?;
        let rng_values: Vec<f64> = r.list(|r| r.f64())?;
        let out = &port::shuffled_order(item_count, rng_values)?;
        wire::write_value(w, out, &S_SHUFFLED_ORDER_OUT)?;
        Ok(())
    })
}

static S_IS_VALID_ORDER_0: wire::Schema = wire::Schema::Dyn;

/// `isValidOrder` over the binary wire.
#[napi(js_name = "isValidOrderWire")]
pub fn is_valid_order_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let order: Value = wire::read_value(r, &S_IS_VALID_ORDER_0)?;
        let item_count: f64 = r.f64()?;
        let out = &port::is_valid_order(order, item_count)?;
        w.bool(*out);
        Ok(())
    })
}

static S_EFFECTIVE_ORDER_2: wire::Schema = wire::Schema::Dyn;

/// `effectiveOrder` over the binary wire.
#[napi(js_name = "effectiveOrderWire")]
pub fn effective_order_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let item_count: f64 = r.f64()?;
        let shuffle: bool = r.bool()?;
        let order: Value = wire::read_value(r, &S_EFFECTIVE_ORDER_2)?;
        let out = &port::effective_order(item_count, shuffle, order)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.f64(*x0);
        }
        Ok(())
    })
}

static S_DECIDE_ITEM_END_6: wire::Schema = wire::Schema::Dyn;
static S_DECIDE_ITEM_END_OUT: wire::Schema = wire::Schema::Obj(&[
    ("action", wire::Schema::Str16),
    ("nextIndex", wire::Schema::Num),
    (
        "order",
        wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Num)),
    ),
]);

/// `decideItemEnd` over the binary wire.
#[napi(js_name = "decideItemEndWire")]
pub fn decide_item_end_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let item_count: f64 = r.f64()?;
        let current_index: f64 = r.f64()?;
        let mode: String = r.string16()?;
        let repeat_one: bool = r.bool()?;
        let r#loop: bool = r.bool()?;
        let shuffle: bool = r.bool()?;
        let order: Value = wire::read_value(r, &S_DECIDE_ITEM_END_6)?;
        let rng_values: Vec<f64> = r.list(|r| r.f64())?;
        let out = &port::decide_item_end(
            item_count,
            current_index,
            mode,
            repeat_one,
            r#loop,
            shuffle,
            order,
            rng_values,
        )?;
        wire::write_value(w, out, &S_DECIDE_ITEM_END_OUT)?;
        Ok(())
    })
}

static S_STEP_INDEX_4: wire::Schema = wire::Schema::Dyn;
static S_STEP_INDEX_OUT: wire::Schema = wire::Schema::Num;

/// `stepIndex` over the binary wire.
#[napi(js_name = "stepIndexWire")]
pub fn step_index_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let item_count: f64 = r.f64()?;
        let current_index: f64 = r.f64()?;
        let direction: String = r.string16()?;
        let shuffle: bool = r.bool()?;
        let order: Value = wire::read_value(r, &S_STEP_INDEX_4)?;
        let out = &port::step_index(item_count, current_index, direction, shuffle, order)?;
        wire::write_value(w, out, &S_STEP_INDEX_OUT)?;
        Ok(())
    })
}

static S_PEEK_NEXT_INDEX_3: wire::Schema = wire::Schema::Dyn;
static S_PEEK_NEXT_INDEX_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Num);

/// `peekNextIndex` over the binary wire.
#[napi(js_name = "peekNextIndexWire")]
pub fn peek_next_index_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let item_count: f64 = r.f64()?;
        let current_index: f64 = r.f64()?;
        let shuffle: bool = r.bool()?;
        let order: Value = wire::read_value(r, &S_PEEK_NEXT_INDEX_3)?;
        let r#loop: bool = r.bool()?;
        let out = &port::peek_next_index(item_count, current_index, shuffle, order, r#loop)?;
        wire::write_value(w, out, &S_PEEK_NEXT_INDEX_OUT)?;
        Ok(())
    })
}
