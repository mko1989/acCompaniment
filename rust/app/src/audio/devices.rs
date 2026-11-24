//! Output devices as the original reports them (RtAudio's `getDevices()`, ADR-018).
//!
//! RtAudio numbers devices from 129 in probe order and keeps a device's number while it stays
//! connected (`RtApiCore::probeDevices`); a device it fails to probe gets no number. On macOS the
//! name is `"<manufacturer>: <name>"`. This module probes CoreAudio the same way (macOS) and gives
//! each device the cpal id to open it with. Elsewhere it lists cpal's devices with RtAudio-style
//! numbers (WASAPI's friendly names and PulseAudio's descriptions are RtAudio's names there).

use serde_json::{Value, json};

/// `RtAudio::DeviceInfo`, the fields the app uses, plus how to open the device with cpal.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceInfo {
    pub id: u32,
    pub name: String,
    pub output_channels: u32,
    pub input_channels: u32,
    pub is_default_output: bool,
    pub preferred_sample_rate: u32,
    pub sample_rates: Vec<u32>,
    /// cpal's `DeviceId` string (CoreAudio: the device UID).
    pub cpal_id: String,
    /// The platform's own handle, to recognise the same device on the next probe.
    key: String,
}

impl DeviceInfo {
    /// `formatOutputDevices`' entry.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "outputChannels": self.output_channels,
            "isDefaultOutput": self.is_default_output,
            "preferredSampleRate": self.preferred_sample_rate,
            "sampleRates": self.sample_rates,
        })
    }

    /// ALSA's `null` PCM: it takes the sound and throws it away.
    fn discards(&self) -> bool {
        self.cpal_id == "alsa:null"
    }

    /// The name without RtAudio's `"Manufacturer: "` prefix (cpal's name on macOS).
    pub fn plain_name(&self) -> &str {
        self.name.split_once(": ").map_or(&self.name, |(_, n)| n)
    }
}

/// The default output, else the first output that plays somewhere: never ALSA's `null` device,
/// which discards the sound (and doesn't keep time), WO-042.
fn pick_default_output(devices: &[DeviceInfo]) -> Option<&DeviceInfo> {
    let output = |d: &&DeviceInfo| d.output_channels > 0 && !d.discards();
    devices
        .iter()
        .filter(output)
        .find(|d| d.is_default_output)
        .or_else(|| devices.iter().find(output))
}

const SAMPLE_RATES: [u32; 14] = [
    4000, 5512, 8000, 9600, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
];

/// RtAudio's preferred rate rule: the first rate, then any higher one up to 48000.
fn prefer(preferred: &mut u32, rate: u32) {
    if *preferred == 0 || (rate <= 48000 && rate > *preferred) {
        *preferred = rate;
    }
}

/// The device list, with RtAudio's numbering kept across probes (`deviceIds_`, `currentDeviceId_`).
#[derive(Debug, Default)]
pub struct Registry {
    devices: Vec<DeviceInfo>,
    next_id: u32,
}

impl Registry {
    pub fn new() -> Self {
        Registry {
            devices: Vec::new(),
            next_id: 129,
        }
    }

    /// `getDevices()`: probe again, number new devices, drop disconnected ones.
    pub fn devices(&mut self) -> Vec<DeviceInfo> {
        let found = probe();
        let mut kept: Vec<DeviceInfo> = Vec::new();
        for mut d in found.iter().cloned() {
            if let Some(old) = self.devices.iter().find(|o| o.key == d.key) {
                d.id = old.id;
            } else {
                d.id = self.next_id;
                self.next_id += 1;
            }
            kept.push(d);
        }
        // RtAudio keeps its list in first-probe order.
        kept.sort_by_key(|d| d.id);
        self.devices = kept;
        self.devices.clone()
    }

    /// `rt.getDefaultOutputDevice()`: the default output's number, else the first output's.
    pub fn default_output(&mut self) -> Option<u32> {
        pick_default_output(&self.devices()).map(|d| d.id)
    }

    /// `resolveDeviceId(spec)`: `'default'`/null/`''` -> the default output; a number -> that
    /// number; a name -> the device with that name, in RtAudio's form or the plain form (ADR-018);
    /// anything else -> the default output.
    pub fn resolve(&mut self, spec: &Value) -> Value {
        let default = || json!(Value::Null);
        match spec {
            Value::Null => self.default_output().map_or_else(default, |id| json!(id)),
            Value::String(s) if s == "default" || s.is_empty() => {
                self.default_output().map_or_else(default, |id| json!(id))
            }
            _ => {
                let n = crate::core::jsv::to_number(spec);
                if !n.is_nan() {
                    return crate::core::jsv::num(n);
                }
                let name = spec.as_str().unwrap_or_default();
                let devices = self.devices();
                devices
                    .iter()
                    .find(|d| d.name == name)
                    .or_else(|| devices.iter().find(|d| d.plain_name() == name))
                    .map_or_else(
                        || self.default_output().map_or_else(default, |id| json!(id)),
                        |d| json!(d.id),
                    )
            }
        }
    }

    /// The device with this number, from the last probe (probing again if it isn't known).
    pub fn by_id(&mut self, id: &Value) -> Option<DeviceInfo> {
        let want = id.as_f64()?;
        let find = |list: &[DeviceInfo]| list.iter().find(|d| f64::from(d.id) == want).cloned();
        find(&self.devices).or_else(|| find(&self.devices()))
    }
}

#[cfg(target_os = "macos")]
fn probe() -> Vec<DeviceInfo> {
    coreaudio::probe()
}

#[cfg(not(target_os = "macos"))]
fn probe() -> Vec<DeviceInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let default_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|i| i.to_string());
    let Ok(list) = host.devices() else {
        return Vec::new();
    };
    // ALSA's "default" is not always among the hints cpal lists; the app must still find it,
    // or it falls back to whatever is listed first (WO-042).
    let mut list: Vec<cpal::Device> = list.collect();
    if let Some(default) = host.default_output_device() {
        let listed = default_id.is_some()
            && list
                .iter()
                .any(|d| d.id().ok().map(|i| i.to_string()) == default_id);
        if !listed {
            list.insert(0, default);
        }
    }
    let mut out = Vec::new();
    for d in list {
        let Ok(id) = d.id() else { continue };
        let id = id.to_string();
        let name = d
            .description()
            .map(|desc| desc.name().to_string())
            .unwrap_or_else(|_| id.clone());
        let mut output_channels = 0;
        let mut preferred = 0;
        let mut rates = Vec::new();
        if let Ok(configs) = d.supported_output_configs() {
            for c in configs {
                output_channels = output_channels.max(u32::from(c.channels()));
                for r in SAMPLE_RATES {
                    if r >= c.min_sample_rate() && r <= c.max_sample_rate() {
                        rates.push(r);
                        prefer(&mut preferred, r);
                    }
                }
            }
        }
        let input_channels = d
            .supported_input_configs()
            .map(|cs| cs.map(|c| u32::from(c.channels())).max().unwrap_or(0))
            .unwrap_or(0);
        rates.sort_unstable();
        rates.dedup();
        if rates.is_empty() {
            continue;
        }
        out.push(DeviceInfo {
            id: 0,
            is_default_output: default_id.as_deref() == Some(id.as_str()),
            name,
            output_channels,
            input_channels,
            preferred_sample_rate: preferred,
            sample_rates: rates,
            cpal_id: id.clone(),
            key: id,
        });
    }
    out
}

/// `RtApiCore::probeDevices` / `probeDeviceInfo`, on the CoreAudio HAL.
#[cfg(target_os = "macos")]
mod coreaudio {
    use std::ffi::c_void;

    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    use super::{DeviceInfo, SAMPLE_RATES, prefer};

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ValueRange {
        minimum: f64,
        maximum: f64,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            out_size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            io_size: *mut u32,
            out_data: *mut c_void,
        ) -> i32;
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*s)
    }
    const SYSTEM_OBJECT: u32 = 1;
    const GLOBAL: u32 = fourcc(b"glob");
    const OUTPUT: u32 = fourcc(b"outp");
    const INPUT: u32 = fourcc(b"inpt");
    const MAIN: u32 = 0;
    const DEVICES: u32 = fourcc(b"dev#");
    const DEFAULT_OUTPUT: u32 = fourcc(b"dOut");
    const MANUFACTURER: u32 = fourcc(b"lmak");
    const NAME: u32 = fourcc(b"lnam");
    const UID: u32 = fourcc(b"uid ");
    const STREAM_CONFIGURATION: u32 = fourcc(b"slay");
    const NOMINAL_RATES: u32 = fourcc(b"nsr#");

    fn size_of(object: u32, selector: u32, scope: u32) -> Option<u32> {
        let address = Address {
            selector,
            scope,
            element: MAIN,
        };
        let mut size = 0u32;
        // SAFETY: the address is a valid property address and `size` a valid out pointer; the
        // HAL only writes the size.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(object, &address, 0, std::ptr::null(), &mut size)
        };
        (status == 0).then_some(size)
    }

    /// The property's bytes (`size` from `size_of`), read into a u64-aligned buffer.
    fn data(object: u32, selector: u32, scope: u32, size: u32) -> Option<Vec<u64>> {
        let address = Address {
            selector,
            scope,
            element: MAIN,
        };
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let mut io = size;
        // SAFETY: `buf` holds at least `size` bytes, 8-aligned (enough for every struct read
        // here); the HAL writes at most `io` bytes.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut io,
                buf.as_mut_ptr().cast(),
            )
        };
        (status == 0).then_some(buf)
    }

    fn u32s(object: u32, selector: u32) -> Option<Vec<u32>> {
        let size = size_of(object, selector, GLOBAL)?;
        let buf = data(object, selector, GLOBAL, size)?;
        let bytes: Vec<u8> = buf.iter().flat_map(|w| w.to_ne_bytes()).collect();
        Some(
            bytes[..size as usize]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| u32::from_ne_bytes(*c))
                .collect(),
        )
    }

    fn string(object: u32, selector: u32) -> Option<String> {
        let address = Address {
            selector,
            scope: GLOBAL,
            element: MAIN,
        };
        let mut s: CFStringRef = std::ptr::null();
        let mut io = std::mem::size_of::<CFStringRef>() as u32;
        // SAFETY: the HAL writes one CFStringRef (create rule) into `s`; checked before use.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut io,
                (&mut s as *mut CFStringRef).cast(),
            )
        };
        if status != 0 || s.is_null() {
            return None;
        }
        // SAFETY: non-null CFString returned under the create rule: we own one reference.
        Some(unsafe { CFString::wrap_under_create_rule(s) }.to_string())
    }

    /// Total channels of an `AudioBufferList` (stream configuration) in a scope; `None` when
    /// RtAudio's probe would fail (error or empty property).
    fn channels(object: u32, scope: u32) -> Option<u32> {
        let size = size_of(object, STREAM_CONFIGURATION, scope).filter(|s| *s > 0)?;
        let buf = data(object, STREAM_CONFIGURATION, scope, size)?;
        let bytes: Vec<u8> = buf.iter().flat_map(|w| w.to_ne_bytes()).collect();
        let n = u32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        // AudioBufferList: mNumberBuffers (u32, padded to 8), then AudioBuffer {u32 channels,
        // u32 byte size, pointer} = 16 bytes each.
        let mut total = 0;
        for i in 0..n {
            let o = 8 + i * 16;
            if o + 4 > bytes.len() {
                break;
            }
            total += u32::from_ne_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        }
        Some(total)
    }

    fn rates(object: u32, scope: u32) -> Option<(Vec<u32>, u32)> {
        let size = size_of(object, NOMINAL_RATES, scope).filter(|s| *s > 0)?;
        let buf = data(object, NOMINAL_RATES, scope, size)?;
        let count = size as usize / std::mem::size_of::<ValueRange>();
        // SAFETY: `buf` holds `size` bytes of `AudioValueRange`s (two f64 each), 8-aligned.
        let ranges =
            unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<ValueRange>(), count) };
        let mut list = Vec::new();
        let mut preferred = 0;
        let (mut min, mut max) = (1.0f64, 10_000_000_000.0f64);
        let mut have_range = false;
        for r in ranges {
            if r.minimum == r.maximum {
                let sr = r.minimum as u32;
                list.push(sr);
                prefer(&mut preferred, sr);
            } else {
                have_range = true;
                min = min.max(r.minimum);
                max = max.min(r.maximum);
            }
        }
        if have_range {
            for sr in SAMPLE_RATES {
                if sr >= min as u32 && sr <= max as u32 {
                    list.push(sr);
                    prefer(&mut preferred, sr);
                }
            }
        }
        list.sort_unstable();
        list.dedup();
        (!list.is_empty()).then_some((list, preferred))
    }

    fn probe_one(id: u32, default_output: u32) -> Option<DeviceInfo> {
        let manufacturer = string(id, MANUFACTURER)?;
        let name = string(id, NAME)?;
        let output_channels = channels(id, OUTPUT)?;
        let input_channels = channels(id, INPUT)?;
        let scope = if output_channels == 0 { INPUT } else { OUTPUT };
        let (sample_rates, preferred_sample_rate) = rates(id, scope)?;
        let uid = string(id, UID).unwrap_or_default();
        Some(DeviceInfo {
            id: 0,
            name: format!("{manufacturer}: {name}"),
            output_channels,
            input_channels,
            is_default_output: id == default_output,
            preferred_sample_rate,
            sample_rates,
            cpal_id: uid,
            key: id.to_string(),
        })
    }

    pub fn probe() -> Vec<DeviceInfo> {
        let Some(ids) = u32s(SYSTEM_OBJECT, DEVICES) else {
            return Vec::new();
        };
        let default_output = u32s(SYSTEM_OBJECT, DEFAULT_OUTPUT)
            .and_then(|v| v.first().copied())
            .unwrap_or(0);
        ids.into_iter()
            .filter_map(|id| probe_one(id, default_output))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: u32, cpal_id: &str, default: bool) -> DeviceInfo {
        DeviceInfo {
            id,
            name: cpal_id.to_string(),
            output_channels: 2,
            input_channels: 0,
            is_default_output: default,
            preferred_sample_rate: 48000,
            sample_rates: vec![48000],
            cpal_id: cpal_id.to_string(),
            key: cpal_id.to_string(),
        }
    }

    #[test]
    fn the_default_output_is_never_alsas_null_device() {
        // ALSA lists "null" first; with no usable "default" the app opened it and played into
        // nothing, finishing every cue at once (WO-042).
        let devices = [
            device(129, "alsa:null", false),
            device(130, "alsa:plughw:CARD=PCH,DEV=0", false),
        ];
        assert_eq!(pick_default_output(&devices).map(|d| d.id), Some(130));
        let only_null = [device(129, "alsa:null", true)];
        assert_eq!(pick_default_output(&only_null), None);
    }

    #[test]
    fn the_default_output_is_the_marked_one_when_there_is_one() {
        let devices = [
            device(129, "alsa:null", false),
            device(130, "alsa:hw:CARD=PCH,DEV=0", false),
            device(131, "alsa:default", true),
        ];
        assert_eq!(pick_default_output(&devices).map(|d| d.id), Some(131));
    }
}
